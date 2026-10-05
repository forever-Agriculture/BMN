// MODULE: control-cli.test.ts - the bmn CLI drives a real control server with truthful output and exit codes
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as spawnPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlAuth, writeOwnerToken } from './control-auth'
import { ERROR_CODES, HANDOFF_OUTLINE } from '@bmn/protocol'
import { ControlError, ControlServer, MemoryReceiptStore, type ControlHandlers } from './control-server'

import { ownWindowsFixtureFile } from './windows-fixture-owner.test-support'
import { denyWindowsFixtureFileReads } from './windows-fixture-io.test-support'
import { windowsEnvironmentValue } from '../../bin/windows-env.mjs'
import { instrumentCliConnection } from './cli-connection-diagnostic.test-support'

// Native ACL subprocesses can exceed the default 5s; each CLI child retains its 15s bound.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })
const rawEndpoint = (root: string, name: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\bmn-control-${randomUUID().replaceAll('-', '')}` : join(root, name)

// These cases exercise the Bash route used by native Claude when Git for Windows is installed.
function fixtureShell(name: 'sh' | 'bash'): string {
  if (process.platform !== 'win32') return `/bin/${name}`
  const programFiles = windowsEnvironmentValue(process.env, 'ProgramFiles')
  if (!programFiles) throw new Error('Native shell fixture requires ProgramFiles')
  const path = join(programFiles, 'Git', 'bin', `${name}.exe`)
  if (!existsSync(path)) throw new Error('Native Claude shell fixture requires Git for Windows')
  return path
}
const shellPath = (path: string): string => process.platform === 'win32' ? path.replaceAll('\\', '/') : path
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
function fixtureSearchPath(first: readonly string[], inherited: string): string {
  if (process.platform !== 'win32') return [...first, inherited].filter(Boolean).join(':')
  // MSYS converts a Windows PATH on startup; mixed C:/drive and colon lists are ambiguous.
  const programFiles = windowsEnvironmentValue(process.env, 'ProgramFiles')
  if (!programFiles) throw new Error('Native shell fixture requires ProgramFiles')
  return [...first, join(programFiles, 'Git', 'usr', 'bin'), join(programFiles, 'Git', 'bin')].join(';')
}

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const AGENT_CONTROL_DOC = fileURLToPath(new URL('../../../../docs/agent-control.md', import.meta.url))
const createdRoots = new Set<string>()
const servers = new Set<ControlServer>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}
type CliTrace = (stage: string, metadata?: Record<string, string | number | boolean | null>) => void

/** The CLI's test-only choice of hook entry form (bin/bmn HOOK_SHELL); without it Windows writes PowerShell's. */
const HOOK_FORM_POSIX = { NODE_ENV: 'test', BMN_TEST_HOOK_SHELL: 'posix' }
const HOOK_FORM_POWERSHELL = { NODE_ENV: 'test', BMN_TEST_HOOK_SHELL: 'powershell' }

function runCli(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; input?: string | Buffer | undefined; trace?: CliTrace } = {}
): Promise<CliResult> {
  return runCommand(process.execPath, [CLI, ...args], options)
}

function runCommand(
  executable: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; input?: string | Buffer | undefined; verbatim?: boolean; trace?: CliTrace } = {}
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    // The lead's own harness pointers must not decide a hook test: base URLs and config homes are
    // set per test or absent, never inherited from whoever runs the suite.
    if (key.startsWith('BMN_') || key.startsWith('AITERM_') ||
      key === 'ANTHROPIC_BASE_URL' || key === 'OPENAI_BASE_URL' || key === 'CLAUDE_CONFIG_DIR') delete env[key]
  }
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        // Hook entries are read and written in their POSIX form on every OS unless a test asks for PowerShell's.
        env: { ...env, ...HOOK_FORM_POSIX, ...options.env, ...(process.platform === 'win32' && options.env?.HOME ? { USERPROFILE: options.env.HOME } : {}) }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: 15_000,
        ...(options.verbatim ? { windowsVerbatimArguments: true } : {})
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        options.trace?.('child-callback', { code, errorCode: error?.code ?? null,
          signal: error?.signal ?? null, killed: error?.killed ?? false })
        resolve({ code, stdout, stderr })
      }
    )
    if (options.trace) {
      child.on('spawn', () => options.trace?.('child-spawn'))
      child.on('error', error => options.trace?.('child-error', { code: (error as NodeJS.ErrnoException).code ?? null }))
      child.on('exit', (code, signal) => options.trace?.('child-exit', { code, signal }))
      child.on('close', (code, signal) => options.trace?.('child-close', { code, signal }))
      child.stdin?.on('finish', () => options.trace?.('stdin-finish'))
    }
    child.stdin?.end(options.input ?? '')
  })
}

async function cliFixture() {
  // The temporary folder may be reached through a symlink, and the CLI child reports the real path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aitcli-')))
  createdRoots.add(root)
  const socketPath = join(root, 'ctl', 'control.sock')
  const auth = new ControlAuth()
  const current = new Map([['session-1', 'incarnation-1'], ['session-2', 'incarnation-2']])
  const handlers = {
    isCurrentIncarnation: vi.fn((sessionId: string, incarnationId: string) => current.get(sessionId) === incarnationId),
    sessionExists: vi.fn((sessionId: string) => current.has(sessionId)),
    snapshot: vi.fn(async (): Promise<unknown> => ({ watermark: 12, sessions: [{}, {}], attention: [] })),
    listSessions: vi.fn(async (): Promise<unknown> => [{ sessionId: 'session-1', name: 'api', status: 'running' }]),
    publishArtifact: vi.fn(async (): Promise<unknown> => ({ artifactId: 'artifact-1' })),
    reportProgress: vi.fn<ControlHandlers['reportProgress']>(async () => ({ recorded: true })),
    openAttention: vi.fn<ControlHandlers['openAttention']>(async () => ({ opened: true })),
    prepareHandoff: vi.fn(async (): Promise<unknown> => ({ draftId: 'draft-1', requestId: 'request-1', state: 'draft' })),
    reportRefusal: vi.fn<ControlHandlers['reportRefusal']>(),
    observeConversation: vi.fn<ControlHandlers['observeConversation']>(async () => ({ accepted: true, detail: 'observed' })),
    withdrawAttention: vi.fn<ControlHandlers['withdrawAttention']>(async () => ({ withdrawn: true })),
    resolveAttention: vi.fn<ControlHandlers['resolveAttention']>(async () => ({ resolved: true })),
    observeHookEvent: vi.fn<ControlHandlers['observeHookEvent']>(async () => ({ recorded: true })),
    reportUsage: vi.fn<ControlHandlers['reportUsage']>(async () => ({ recorded: true })),
    submitInput: vi.fn<ControlHandlers['submitInput']>(async () => undefined),
    takeAnswers: vi.fn<ControlHandlers['takeAnswers']>(async () => ({ answers: [] })),
    reportResumeCommand: vi.fn<ControlHandlers['reportResumeCommand']>(async (p) =>
      ({ recorded: true, argv: [...p.argv], reportedAt: '2026-09-29T10:15:00.000Z' })),
    clearResumeCommand: vi.fn<ControlHandlers['clearResumeCommand']>(async () => ({ cleared: true }))
  } satisfies ControlHandlers
  const server = new ControlServer({ socketPath, auth, handlers, receipts: new MemoryReceiptStore() })
  await server.listen()
  servers.add(server)
  const sessionEnv = {
    BMN_CONTROL_SOCKET: socketPath,
    BMN_TOKEN: auth.sessionToken('session-1', 'incarnation-1')
  }
  return { root, socketPath, auth, current, handlers, sessionEnv }
}

describe('bmn CLI', () => {
  it('publishes a file resolved from the working directory with a fresh key per invocation', async () => {
    const fixture = await cliFixture()

    const first = await runCli(['publish', 'report.md', '--name', 'Weekly report'], {
      env: fixture.sessionEnv,
      cwd: fixture.root
    })
    const second = await runCli(['publish', 'report.md', '--name', 'Weekly report'], {
      env: fixture.sessionEnv,
      cwd: fixture.root
    })

    expect(first).toEqual({ code: 0, stdout: 'Published Weekly report as artifact-1\n', stderr: '' })
    expect(second.code).toBe(0)
    expect(fixture.handlers.publishArtifact).toHaveBeenCalledTimes(2)
    expect(fixture.handlers.publishArtifact).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      path: join(fixture.root, 'report.md'),
      name: 'Weekly report',
      source: 'agent'
    })
  })

  it('reuses an explicit key and prints raw results with --json', async () => {
    const fixture = await cliFixture()
    const args = ['publish', '/tmp/notes.md', '--key', 'publish-notes']

    const first = await runCli([...args, '--json'], { env: fixture.sessionEnv })
    const repeat = await runCli(args, { env: fixture.sessionEnv })

    expect(first.code).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({ artifactId: 'artifact-1' })
    expect(repeat).toEqual({
      code: 0,
      stdout: 'Published notes.md as artifact-1 (already done earlier; not repeated)\n',
      stderr: ''
    })
    expect(fixture.handlers.publishArtifact).toHaveBeenCalledTimes(1)
  })

  it('reports progress with source and detail', async () => {
    const fixture = await cliFixture()

    const result = await runCli(
      [
        'progress', 'blocked', 'Waiting for review', '--detail', 'PR #12', '--source', 'ci',
        '--observed', '2026-09-14T11:45:00.000Z'
      ],
      { env: fixture.sessionEnv }
    )
    await runCli(['progress', 'running', 'Building'], { env: fixture.sessionEnv })

    expect(result).toEqual({ code: 0, stdout: 'Progress reported: blocked: Waiting for review\n', stderr: '' })
    expect(fixture.handlers.reportProgress.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        source: 'ci', state: 'blocked', label: 'Waiting for review', detail: 'PR #12',
        observedAt: '2026-09-14T11:45:00.000Z'
      }),
      expect.objectContaining({ source: 'bmn', state: 'running', label: 'Building' })
    ])
  })

  it('repeats --evidence-id in the order given and sends none when it is absent', async () => {
    const fixture = await cliFixture()

    const attached = await runCli(
      ['progress', 'verified', 'Checks passed', '--evidence-id', 'art-2', '--evidence-id=art-1'],
      { env: fixture.sessionEnv }
    )
    const bare = await runCli(['progress', 'running', 'Building'], { env: fixture.sessionEnv })

    expect(attached).toEqual({
      code: 0,
      stdout: 'Progress reported: verified: Checks passed (2 evidence files attached, not checked)\n',
      stderr: ''
    })
    expect(bare.stdout).toBe('Progress reported: running: Building\n')
    expect(fixture.handlers.reportProgress.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ state: 'verified', evidenceIds: ['art-2', 'art-1'] }),
      // Omitted is an empty list, so nothing is carried over from the report before it.
      expect.objectContaining({ state: 'running', evidenceIds: [] })
    ])
  })

  it('sends text as a paste and only submits with --submit', async () => {
    const fixture = await cliFixture()

    const pasted = await runCli(['send', 'git status'], { env: fixture.sessionEnv })
    const submitted = await runCli(['send', '--submit', '--', '--version'], { env: fixture.sessionEnv })

    expect(pasted).toEqual({ code: 0, stdout: 'Input pasted\n', stderr: '' })
    expect(submitted).toEqual({ code: 0, stdout: 'Input submitted\n', stderr: '' })
    expect(fixture.handlers.submitInput.mock.calls.map(([call]) => call)).toEqual([
      { sessionId: 'session-1', text: 'git status', submit: false },
      { sessionId: 'session-1', text: '--version', submit: true }
    ])
  })

  it('prints human snapshot and session summaries', async () => {
    const fixture = await cliFixture()

    const snapshot = await runCli(['snapshot'], { env: fixture.sessionEnv })
    const list = await runCli(['list'], { env: fixture.sessionEnv })

    expect(snapshot).toEqual({ code: 0, stdout: 'watermark: 12\nsessions: 2\nattention: 0\n', stderr: '' })
    expect(list).toEqual({ code: 0, stdout: 'session-1\tapi\trunning\n', stderr: '' })
  })

  it.each([
    ['no command', []],
    ['an unknown command', ['explode']],
    ['an invalid progress state', ['progress', 'done', 'Finished']],
    ['a missing argument', ['send']],
    ['an extra argument', ['publish', 'a.md', 'b.md']],
    ['an unknown option', ['list', '--verbose']],
    ['an option for another command', ['list', '--submit']],
    ['a missing option value', ['publish', 'a.md', '--name']],
    ['an invalid attention kind', ['ask', 'q1', 'Deploy?', '--kind', 'urgent']],
    ['an empty evidence id', ['progress', 'verified', 'Done', '--evidence-id', '']],
    ['a missing evidence id value', ['progress', 'verified', 'Done', '--evidence-id']],
    ['evidence on another command', ['publish', 'a.md', '--evidence-id', 'art-1']]
  ])('exits 2 for %s without contacting the server', async (_label, args) => {
    const fixture = await cliFixture()

    const result = await runCli(args, { env: fixture.sessionEnv })

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toBe('')
    expect(fixture.handlers.isCurrentIncarnation).not.toHaveBeenCalled()
  })

  it('exits 2 when no socket or credential is configured', async () => {
    const fixture = await cliFixture()

    const noSocket = await runCli(['list'])
    const noToken = await runCli(['list'], { env: { BMN_CONTROL_SOCKET: fixture.socketPath } })

    expect(noSocket.code).toBe(2)
    expect(noSocket.stderr).toContain('BMN_CONTROL_SOCKET')
    expect(noToken.code).toBe(2)
    expect(noToken.stderr).toContain('BMN_TOKEN')
  })

  it('exits 1 with the remote code for revoked or out-of-scope requests without printing the token', async () => {
    const fixture = await cliFixture()
    fixture.current.set('session-1', 'incarnation-new')

    const revoked = await runCli(['list'], { env: fixture.sessionEnv })
    fixture.current.set('session-1', 'incarnation-1')
    const peer = await runCli(['withdraw', 'q1', '--session', 'session-2'], { env: fixture.sessionEnv })

    expect(revoked).toEqual({ code: 1, stdout: '', stderr: 'bmn: UNAUTHORIZED: Credential revoked\n' })
    expect(peer.code).toBe(1)
    expect(peer.stderr).toMatch(/^bmn: UNAUTHORIZED: /)
    for (const output of [revoked.stderr, peer.stderr]) {
      expect(output).not.toContain(fixture.sessionEnv.BMN_TOKEN)
    }
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
  })

  it('uses the owner token beside the socket with --owner', async () => {
    const fixture = await cliFixture()
    await writeOwnerToken(dirname(fixture.socketPath), fixture.auth.ownerToken)
    const env = { BMN_CONTROL_SOCKET: fixture.socketPath }

    const resolved = await runCli(['resolve', 'q1', 'approved', '--owner', '--session', 'session-2'], { env })
    const untargeted = await runCli(['resolve', 'q1', 'approved', '--owner'], { env })

    expect(resolved).toEqual({ code: 0, stdout: 'Attention request q1 resolved\n', stderr: '' })
    expect(fixture.handlers.resolveAttention).toHaveBeenCalledWith({
      sessionId: 'session-2',
      requestKey: 'q1',
      resolution: 'approved',
      origin: 'cli'
    })
    expect(untargeted.code).toBe(1)
    expect(untargeted.stderr).toMatch(/^bmn: INVALID_ARGUMENT: /)
  })

  it('exits 1 when the control socket cannot be reached', async () => {
    const fixture = await cliFixture()

    const result = await runCli(['list', '--socket', join(fixture.root, 'missing.sock')], { env: fixture.sessionEnv })

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^bmn: IO_ERROR: cannot reach control socket/)
  })

  it('prints help and exits 0', async () => {
    const result = await runCli(['help'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: bmn')
    expect(result.stderr).toBe('')
  })
})

interface ProcessStat {
  comm: string
  tty: number
  group: number
  foreground: number
}

/** A fake /proc in which the hook's shell was started by an agent that does or does not hold a terminal. */
async function procTree(root: string, agent: ProcessStat): Promise<string> {
  const proc = join(root, 'proc')
  const write = async (pid: number, comm: string, parent: number): Promise<void> => {
    await mkdir(join(proc, String(pid)), { recursive: true })
    const fields = [parent, agent.group, agent.group, agent.tty, agent.foreground, 4194304, 0]
    await writeFile(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${fields.join(' ')}\n`)
  }
  await write(process.pid, 'sh', 7001)
  await write(7001, agent.comm, 1)
  return proc
}

const HOLDS_TERMINAL: ProcessStat = { comm: 'claude', tty: 34817, group: 7001, foreground: 7001 }
const OBSERVED_REFERENCE = '01a0b657-21a8-7f00-addd-b73646828f5b'
const QUIET = { code: 0, stdout: '', stderr: '' }

async function runHook(
  fixture: Awaited<ReturnType<typeof cliFixture>>,
  agent: string,
  event: unknown,
  agentProcess: ProcessStat = HOLDS_TERMINAL,
  env: Record<string, string> = {}
): Promise<CliResult> {
  const proc = await procTree(fixture.root, agentProcess)
  return runCli(['hook', agent], {
    env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc, CLAUDE_CONFIG_DIR: join(fixture.root, 'claude'), ...env },
    input: JSON.stringify(event)
  })
}

describe('bmn handoff CLI', () => {
  it('prepares once with a required key and exact source token, then reads bounded status', async () => {
    const fixture = await cliFixture()
    const args = ['handoff', 'session-2', '--text', 'A result', '--file-id', 'output-1', '--key', 'handoff-1']
    const first = await runCli(args, { env: fixture.sessionEnv })
    const repeat = await runCli(args, { env: fixture.sessionEnv })

    expect(first).toEqual({ code: 0, stdout: 'Handoff prepared as draft draft-1; the owner must deliver it\n', stderr: '' })
    expect(repeat.stdout).toContain('already done earlier; not repeated')
    expect(fixture.handlers.prepareHandoff).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.prepareHandoff).toHaveBeenCalledWith({
      sourceSessionId: 'session-1', sourceIncarnationId: 'incarnation-1',
      destinationSessionId: 'session-2', text: 'A result', artifactIds: ['output-1']
    })

    fixture.handlers.snapshot.mockResolvedValue({ watermark: 14, sessions: [], attention: [],
      handoffs: [{ draftId: 'draft-1', destinationSessionId: 'session-2', state: 'accepted',
        updatedAt: '2026-09-22T12:00:00.000Z' }] })
    const status = await runCli(['handoff', 'status', 'draft-1'], { env: fixture.sessionEnv })
    expect(status.stdout).toBe('draft-1\tpasted (not submitted)\tsession-2\t2026-09-22T12:00:00.000Z\n')
    expect(status.stdout).not.toContain('A result')
  })

  it('takes literal text after -- and refuses missing keys, duplicate IDs and cross-session options', async () => {
    const fixture = await cliFixture()
    const literal = await runCli(['handoff', 'session-2', '--key', 'literal-1', '--', 'first', 'second'], {
      env: fixture.sessionEnv
    })
    expect(literal.code).toBe(0)
    expect(fixture.handlers.prepareHandoff).toHaveBeenCalledWith(expect.objectContaining({ text: 'first second' }))
    for (const args of [
      ['handoff', 'session-2', '--text', 'result'],
      ['handoff', 'session-2', '--text', 'result', '--key', 'k', '--file-id', 'same', '--file-id', 'same'],
      ['handoff', 'session-2', '--text', 'result', '--key', 'k', '--session', 'session-2']
    ]) {
      const refused = await runCli(args, { env: fixture.sessionEnv })
      expect(refused.code).toBe(2)
    }
    expect(fixture.handlers.prepareHandoff).toHaveBeenCalledTimes(1)
  })
})

describe('long text from standard input (Story 35.1)', () => {
  // Quotes, backticks, command substitution, tabs, blank lines and non-ASCII that shell quoting mangles.
  const AWKWARD = 'He said "don\'t" and `ls` then $(rm -rf /tmp/x) & ${HOME}\n\n\tindented — ünïcödé ✓\nlast line'

  it('reads the ask body, handoff text, send text and progress detail exactly as piped', async () => {
    const fixture = await cliFixture()
    const env = fixture.sessionEnv

    expect((await runCli(['ask', 'k1', 'Title', '--body-file', '-'], { env, input: `${AWKWARD}\n` })).code).toBe(0)
    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({ body: AWKWARD }))
    expect((await runCli(['handoff', 'session-2', '--text-file', '-', '--key', 'h1'], { env, input: AWKWARD })).code).toBe(0)
    expect(fixture.handlers.prepareHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ text: AWKWARD }))
    expect((await runCli(['send', '--text-file=-', '--submit'], { env, input: `${AWKWARD}\n` })).code).toBe(0)
    expect(fixture.handlers.submitInput).toHaveBeenLastCalledWith(expect.objectContaining({ text: AWKWARD, submit: true }))
    expect((await runCli(['progress', 'running', 'Build', '--detail-file', '-'], { env, input: AWKWARD })).code).toBe(0)
    expect(fixture.handlers.reportProgress).toHaveBeenLastCalledWith(expect.objectContaining({ detail: AWKWARD }))
  })

  it('drops exactly one trailing newline and keeps every other byte', async () => {
    const fixture = await cliFixture()
    const env = fixture.sessionEnv
    for (const [input, body] of [['one\n\n', 'one\n'], ['two\r\n', 'two\r'], ['  spaced  ', '  spaced  ']]) {
      expect((await runCli(['ask', 'k', 'Title', '--body-file', '-'], { env, input })).code).toBe(0)
      expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({ body }))
    }
    // Send text is pasted as it is, so a leading byte-order mark reaches the app too.
    const bom = '\uFEFFstarts with a byte-order mark'
    expect((await runCli(['send', '--text-file', '-'], { env, input: `${bom}\n` })).code).toBe(0)
    expect(fixture.handlers.submitInput).toHaveBeenLastCalledWith(expect.objectContaining({ text: bom }))
  })

  it.each([
    [['ask', 'k', 'T', '--body', 'inline', '--body-file', '-'], 'ask takes its body from one source: --body or --body-file -, not both'],
    [['progress', 'running', 'L', '--detail', 'inline', '--detail-file', '-'],
      'progress takes its detail from one source: --detail or --detail-file -, not both'],
    [['send', 'inline', '--text-file', '-'], 'send takes its text from one source: text or --text-file -, not both'],
    [['send', '--text-file', '-', '--', 'inline'], 'send takes its text from one source: text or --text-file -, not both'],
    [['handoff', 'session-2', '--text', 'inline', '--text-file', '-', '--key', 'k'],
      'handoff takes its text from one source: --text T or -- text or --text-file -, not both'],
    [['handoff', 'session-2', '--text-file', '-', '--key', 'k', '--', 'inline'],
      'handoff takes its text from one source: --text T or -- text or --text-file -, not both'],
    [['ask', 'k', 'T', '--body-file', 'notes.md'], '--body-file accepts only - (standard input); to send a file, cat it into bmn'],
    [['publish', 'report.md', '--body-file', '-'], 'publish does not accept --body-file'],
    [['ask', 'k', 'T', '--text-file', '-'], 'ask does not accept --text-file']
  ])('refuses %j as a usage error without reading or sending', async (args, message) => {
    const fixture = await cliFixture()
    const refused = await runCli(args, { env: fixture.sessionEnv, input: 'piped text' })
    expect(refused).toEqual({ code: 2, stdout: '', stderr: `bmn: ${message}\nRun "bmn help" for usage.\n` })
    for (const handler of [fixture.handlers.openAttention, fixture.handlers.reportProgress,
      fixture.handlers.submitInput, fixture.handlers.prepareHandoff, fixture.handlers.publishArtifact]) {
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it.each([
    [['ask', 'k', 'T', '--body-file', '-'], 'x'.repeat(8001), 'body from standard input must be at most 8000 characters'],
    [['ask', 'k', 'T', '--body-file', '-'], '✓'.repeat(20000), 'body from standard input must be at most 8000 characters'],
    [['progress', 'running', 'L', '--detail-file', '-'], 'é'.repeat(2001), 'detail from standard input must be at most 2000 characters'],
    [['send', '--text-file', '-'], 'x'.repeat(64 * 1024 + 1), 'text from standard input must be at most 65536 bytes'],
    [['send', '--text-file', '-'], `${'x'.repeat(64 * 1024 + 1)}\n`, 'text from standard input must be at most 65536 bytes'],
    [['handoff', 'session-2', '--text-file', '-', '--key', 'k'], 'x'.repeat(16 * 1024 + 1), 'text from standard input must be at most 16384 bytes'],
    [['handoff', 'session-2', '--text-file', '-', '--key', 'k'], 'é'.repeat(8193), 'text from standard input must be at most 16384 bytes'],
    [['ask', 'k', 'T', '--body-file', '-'], Buffer.from([0x6f, 0x6b, 0xff, 0xfe]), 'body from standard input is not valid UTF-8']
  ])('refuses %j over its limit or not UTF-8 before opening the socket', async (args, input, message) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aitcli-')))
    createdRoots.add(root)
    const socketPath = rawEndpoint(root, 'count.sock')
    let connections = 0
    const counter = createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => { counter.once('error', reject); counter.listen(socketPath, resolve) })
    try {
      const refused = await runCli(args, { env: { BMN_CONTROL_SOCKET: socketPath, BMN_TOKEN: 'unused' }, input })
      expect(refused).toEqual({ code: 2, stdout: '', stderr: `bmn: ${message}\nRun "bmn help" for usage.\n` })
      expect(connections).toBe(0)
    } finally {
      await new Promise((resolve) => counter.close(resolve))
    }
  })

  it('ships the CLI executable, since sessions find it on PATH (Astra recheck)', async () => {
    if (process.platform === 'win32') {
      const launcher = fileURLToPath(new URL('../../native-out/windows-cli/bmn.exe', import.meta.url))
      expect((await stat(launcher)).isFile()).toBe(true)
      expect((await runCommand(launcher, ['help'])).code).toBe(0)
    } else {
      expect((await stat(CLI)).mode & 0o111).not.toBe(0)
    }
  })

  it('accepts input exactly at the limit, counted in the app\'s own unit', async () => {
    const fixture = await cliFixture()
    const env = fixture.sessionEnv
    expect((await runCli(['ask', 'k', 'T', '--body-file', '-'], { env, input: `${'ü'.repeat(8000)}\n` })).code).toBe(0)
    expect((await runCli(['handoff', 'session-2', '--text-file', '-', '--key', 'k'], { env, input: 'é'.repeat(8192) })).code).toBe(0)
    expect(fixture.handlers.prepareHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'é'.repeat(8192) }))
    // Astra review: the heredoc's trailing newline does not count against a field exactly at its byte limit.
    expect((await runCli(['handoff', 'session-2', '--text-file', '-', '--key', 'k2'], { env, input: `${'a'.repeat(16 * 1024)}\n` })).code).toBe(0)
    expect(fixture.handlers.prepareHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'a'.repeat(16 * 1024) }))
    expect((await runCli(['send', '--text-file', '-'], { env, input: `${'s'.repeat(64 * 1024)}\n` })).code).toBe(0)
  })

  it('refuses a terminal on standard input instead of waiting for typing', async () => {
    const fixture = await cliFixture()
    // A real pseudo-terminal is the CLI's standard input: a Linux PTY, or ConPTY on Windows.
    const child = spawnPty(process.execPath, [CLI, 'ask', 'k', 'T', '--body-file', '-'], {
      name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(),
      env: Object.fromEntries(Object.entries({ ...process.env, ...fixture.sessionEnv })
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {})
    })
    let output = ''
    child.onData((part) => { output += part })
    const code = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(null) }, 15_000)
      child.onExit(({ exitCode }) => { clearTimeout(timeout); resolve(exitCode) })
    })
    // eslint-disable-next-line no-control-regex
    const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/gu, '')
    expect(code).toBe(2)
    expect(text).toContain('bmn: --body-file - needs piped input, not a terminal')
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  }, 20_000)
})

describe('bmn resume-command (Story 43.1)', () => {
  it('sends everything after -- exactly, its own options included, and says what was recorded', async () => {
    const fixture = await cliFixture()
    const reported = await runCli(['resume-command', '--', 'my-agent', '--resume', 'ses 1', '--model', 'm', ''], { env: fixture.sessionEnv })
    expect(reported).toEqual({
      code: 0,
      stdout: "Resume command recorded for this session: my-agent --resume 'ses 1' --model m ''\n",
      stderr: ''
    })
    expect(fixture.handlers.reportResumeCommand).toHaveBeenLastCalledWith({
      sessionId: 'session-1', incarnationId: 'incarnation-1', argv: ['my-agent', '--resume', 'ses 1', '--model', 'm', '']
    })
  })

  it('makes a retry with --key set the same command again, and clears with --clear', async () => {
    const fixture = await cliFixture()
    const args = ['resume-command', '--key', 'resume-1', '--', 'my-agent', '-r']
    expect((await runCli(args, { env: fixture.sessionEnv })).code).toBe(0)
    // No receipt answers it: the retry records the same command, which is where a retry should leave it.
    expect((await runCli(args, { env: fixture.sessionEnv })).stdout).toBe('Resume command recorded for this session: my-agent -r\n')
    expect(fixture.handlers.reportResumeCommand).toHaveBeenCalledTimes(2)
    expect(fixture.handlers.reportResumeCommand).toHaveBeenLastCalledWith(expect.objectContaining({ argv: ['my-agent', '-r'] }))
    expect(await runCli(['resume-command', '--clear'], { env: fixture.sessionEnv })).toEqual({
      code: 0, stdout: 'Resume command cleared\n', stderr: ''
    })
    fixture.handlers.clearResumeCommand.mockResolvedValueOnce({ cleared: false })
    expect((await runCli(['resume-command', '--clear'], { env: fixture.sessionEnv })).stdout)
      .toBe('No resume command was kept for this session\n')
  })

  it('records nothing outside BMN, says so and exits 0, so a wrapper can run it anywhere', async () => {
    expect(await runCli(['resume-command', '--', 'my-agent', '--resume', 'x'])).toEqual({
      code: 0, stdout: 'Not inside a BMN session (BMN_CONTROL_SOCKET is unset): nothing was recorded\n', stderr: ''
    })
  })

  it.each([
    [['resume-command', 'my-agent'], 'resume-command expects -- <command> [arguments...] or --clear'],
    // Without --, the command's own options would be read as bmn's.
    [['resume-command', 'my-agent', '--resume'], 'unknown option --resume'],
    [['resume-command', '--'], 'resume-command expects -- <command> [arguments...] or --clear'],
    [['resume-command', '--clear', '--', 'my-agent'], 'resume-command --clear takes no command'],
    [['resume-command', '--session', 'session-2', '--', 'my-agent'], 'resume-command does not accept --session']
  ])('refuses %j as a usage error before it reaches the app', async (args, message) => {
    const fixture = await cliFixture()
    const result = await runCli(args, { env: fixture.sessionEnv })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(fixture.handlers.reportResumeCommand).not.toHaveBeenCalled()
  })

  it('prints the rule the app named when it refuses a command', async () => {
    const fixture = await cliFixture()
    const result = await runCli(['resume-command', '--', '/opt/bin/my-agent'], { env: fixture.sessionEnv })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('INVALID_ARGUMENT: The program must be a plain command name found on PATH, not a path')
  })
})

describe('bmn help agents', () => {
  it('prints a brief an agent can read in one screen, and sends nothing to the socket', async () => {
    const brief = await runCli(['help', 'agents'], {
      env: { BMN_CONTROL_SOCKET: '/nonexistent/bmn-help-agents.sock', BMN_TOKEN: 'unused' }
    })

    expect(brief.code).toBe(0)
    expect(brief.stderr).toBe('')
    const lines = brief.stdout.split('\n').slice(0, -1)
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines.filter((line) => line.length > 100)).toEqual([])
    for (const rule of [
      'BMN_CONTROL_SOCKET',
      '`bmn help`',
      'publish <file>',
      'progress <state> <label>',
      '--evidence-id <id>',
      'it checks nothing',
      'ask <key> <title>',
      'withdraw <key>',
      'claimed-done',
      "verified is the owner's judgement",
      'Needs you is the owner',
      'your own session only',
      'send types into your own terminal',
      'Submission is not delivery',
      '--key',
      'do not resend',
      'Never run it by hand',
      // Story 35.2: what a complete handoff holds, the outline, the stdin pattern and its authority.
      'start without asking',
      '`bmn handoff --outline`',
      '--text-file -',
      'conveys context, not authority',
      // Story 43.1: when to report how to resume.
      'resume-command -- <cmd> [args]  the exact command that resumes you, once you know it.'
    ]) {
      expect(brief.stdout).toContain(rule)
    }
  })

  it('prints the handoff outline and nothing else, without a socket or token (Story 35.2)', async () => {
    const outline = await runCli(['handoff', '--outline'], {
      env: { BMN_CONTROL_SOCKET: '/nonexistent/bmn-outline.sock', BMN_TOKEN: 'unused' }
    })
    expect(outline).toEqual({ code: 0, stdout: `${HANDOFF_OUTLINE}\n`, stderr: '' })
    expect((await runCli(['handoff', '--outline'])).stdout).toBe(`${HANDOFF_OUTLINE}\n`)
    for (const args of [['handoff', '--outline', 'session-2'], ['handoff', '--outline', '--key', 'k'], ['handoff', '--outline', '--text', 'x']]) {
      expect(await runCli(args)).toEqual({ code: 2, stdout: '',
        stderr: 'bmn: handoff --outline takes no arguments or other options\nRun "bmn help" for usage.\n' })
    }
  })

  it('holds the CLI outline, the form outline and the documented one to one text (Story 35.2)', async () => {
    const [outline, documentation] = await Promise.all([runCli(['handoff', '--outline']), readFile(AGENT_CONTROL_DOC, 'utf8')])
    const fenced = /`bmn handoff --outline` prints[\s\S]*?```text\n([\s\S]*?)```/.exec(documentation.replace(/\r\n/g, '\n'))

    expect(outline.stdout).toBe(`${HANDOFF_OUTLINE}\n`)
    expect(fenced?.[1]).toBe(`${HANDOFF_OUTLINE}\n`)
    expect(HANDOFF_OUTLINE.split('\n').filter((line) => line !== '')).toEqual([
      'Goal:', 'Where it stands:', 'Done and checked (with published evidence ids):', 'Left to do:',
      'Risks and open questions:', 'How to check:'
    ])
  })

  it('keeps the printed brief and the documented one identical', async () => {
    const [brief, documentation] = await Promise.all([
      runCli(['help', 'agents']),
      readFile(AGENT_CONTROL_DOC, 'utf8')
    ])
    const fenced = /## A brief for agents[\s\S]*?```text\n([\s\S]*?)```/.exec(documentation.replace(/\r\n/g, '\n'))

    expect(fenced?.[1]).toBe(brief.stdout)
  })

  it('keeps the documented command block identical to what `bmn help` prints (Story 38.3)', async () => {
    const [usage, documentation] = await Promise.all([runCli(['help']), readFile(AGENT_CONTROL_DOC, 'utf8')])
    const block = /<!-- BEGIN `bmn help` [^\n]*-->\n```text\n([\s\S]*?)```\n<!-- END `bmn help` -->/.exec(documentation.replace(/\r\n/g, '\n'))

    expect(usage.code).toBe(0)
    expect(block?.[1], 'docs/agent-control.md differs from `bmn help`; regenerate it with `pnpm run docs:bmn-help`')
      .toBe(usage.stdout)
  })

  it('names the brief in its usage, and plain help still prints the commands', async () => {
    const usage = await runCli(['help'])

    expect(usage.code).toBe(0)
    expect(usage.stdout).toContain('help [agents|terminal]')
    expect(usage.stdout).toContain('Usage: bmn <command> [arguments] [options]')
  })
})

it('explains the graphics-shell terminfo boundary without connecting to BMN', async () => {
  const result = await runCli(['help', 'terminal'], {
    env: { BMN_CONTROL_SOCKET: '/nonexistent/bmn-help-terminal.sock', BMN_TOKEN: 'unused' }
  })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('Terminal images (Sixel)')
  expect(result.stdout).toContain('TERM=xterm-256color')
  expect(result.stdout).toContain('SSH, sudo, or a container')
})

describe('bmn hook', () => {
  it('opens a permission request for a Claude permission prompt and nothing for an idle reminder', async () => {
    const fixture = await cliFixture()

    const permission = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission\n\tto use Bash'
    })
    const idle = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input'
    })

    expect(permission).toEqual(QUIET)
    expect(idle).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
      requestKey: 'claude:permission',
      kind: 'permission',
      title: 'Claude needs your permission to use Bash'
    })
  })

  it.each([
    ['a dialog asking for input', 'elicitation_dialog'],
    ['a dialog asking for a URL', 'elicitation_url_dialog'],
    ['the agent saying it needs input', 'agent_needs_input']
  ])('opens a question for %s', async (_label, notificationType) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification',
      notification_type: notificationType,
      message: 'Which branch should I use?'
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'claude:question',
      kind: 'question',
      title: 'Which branch should I use?'
    })
  })

  it('reads a permission from the message when the harness sends no notification type', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash'
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'claude:permission',
      kind: 'permission'
    })
  })

  it('opens nothing for a Codex tool that is not asking the owner anything', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'codex', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' }
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it('opens nothing for a tool whose name merely contains the words it looks for', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'codex', {
      hook_event_name: 'PreToolUse', tool_name: 'myapp_request_user_input', tool_input: {}
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it('opens a Codex permission request with the command and closes it once the tool ran, past requests that are not open', async () => {
    const fixture = await cliFixture()
    fixture.handlers.withdrawAttention.mockRejectedValue(new ControlError(ERROR_CODES.notFound, 'No open request'))
    fixture.handlers.resolveAttention.mockRejectedValueOnce(new ControlError(ERROR_CODES.notFound, 'No open request'))

    const asked = await runHook(fixture, 'codex', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test\n  --run' }
    })
    const ran = await runHook(fixture, 'codex', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })

    expect(asked).toEqual(QUIET)
    expect(ran).toEqual(QUIET)
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'codex:permission',
      kind: 'permission',
      title: 'Codex wants to use Bash',
      body: 'pnpm test\n  --run'
    })
    expect(fixture.handlers.resolveAttention.mock.calls.map(([params]) => [params.requestKey, params.resolution])).toEqual([
      ['codex:permission', 'answered in the terminal']
    ])
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).toEqual(['codex:turn'])
  })

  it('retains a typed-only Default question identity without invented choices', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', {
      hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_use_id: 'call_typed_only',
      tool_input: { questions: [{ title: 'Describe the synthetic fixture' }] }
    })
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      prompt: { shape: 'async-choice', toolUseId: 'call_typed_only',
        questions: [{ text: 'Describe the synthetic fixture', options: [] }] }
    })
  })

  it('keeps a Codex async follow-up question open until the owner submits input', async () => {
    const fixture = await cliFixture()

    const asked = await runHook(fixture, 'codex', {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: {
        questions: [
          {
            title: 'Which routing should I use?',
            options: ['Epic Auto routing', 'Both', 'Report model']
          },
          {
            question: 'Should the report launch before billing?',
            options: [{ label: 'Build first' }, { label: 'Wait for billing' }]
          }
        ]
      }
    })
    const queued = await runHook(fixture, 'codex', {
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: {}
    })

    expect(asked).toEqual(QUIET)
    expect(queued).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalledWith(expect.objectContaining({
      requestKey: 'codex:question',
      kind: 'question',
      title: 'Codex has 2 questions: Which routing should I use?',
      body: expect.stringContaining('2. Should the report launch before billing?')
    }))

    await runHook(fixture, 'codex', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' }
    })
    expect(fixture.handlers.resolveAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'codex:permission'
    ])
    fixture.handlers.resolveAttention.mockClear()

    await runHook(fixture, 'codex', {
      hook_event_name: 'Stop',
      last_assistant_message: 'I can continue after you answer the queued questions.'
    })
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).not.toContain(
      'codex:question'
    )

    await runHook(fixture, 'codex', { hook_event_name: 'UserPromptSubmit' })
    expect(fixture.handlers.resolveAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'codex:permission',
      'codex:question'
    ])
  })

  it('reports a finished turn as a notice carrying the last message and withdraws prompts left open', async () => {
    const fixture = await cliFixture()
    const escape = String.fromCharCode(27)

    const stopped = await runHook(fixture, 'claude', {
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: `Done.\r\n${escape}[1mAll tests pass${escape}[0m`
    })

    expect(stopped).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'claude:permission',
      'claude:question'
    ])
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'claude:turn',
      kind: 'notice',
      title: 'Claude finished its turn',
      body: 'Done.\n[1mAll tests pass[0m'
    })
  })

  it('reports nothing when a turn ends with background work or a scheduled wake-up still pending', async () => {
    const fixture = await cliFixture()
    const stop = { hook_event_name: 'Stop', last_assistant_message: 'Waiting for the test run.' }

    const working = await runHook(fixture, 'claude', {
      ...stop,
      background_tasks: [{ id: 'b1', type: 'local_bash', status: 'running', description: 'pnpm test' }],
      session_crons: []
    })
    const scheduled = await runHook(fixture, 'claude', {
      ...stop,
      background_tasks: [],
      session_crons: [{ id: 'c1', schedule: 'in 20m', prompt: 'check the run' }]
    })
    const idle = await runHook(fixture, 'claude', { ...stop, background_tasks: [], session_crons: [] })

    expect([working, scheduled, idle]).toEqual([QUIET, QUIET, QUIET])
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'claude:permission', 'claude:question', 'claude:turn',
      'claude:permission', 'claude:question', 'claude:turn',
      'claude:permission', 'claude:question'
    ])
    expect(fixture.handlers.openAttention).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.openAttention.mock.calls[0]?.[0]).toMatchObject({ requestKey: 'claude:turn', kind: 'notice' })
  })

  it('marks requests from a Claude session under Remote Control as already sent to the phone', async () => {
    const fixture = await cliFixture()
    const sessions = join(fixture.root, 'claude', 'sessions')
    await mkdir(sessions, { recursive: true })
    const prompt = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' }
    const bridged = { pid: 7001, sessionId: 'claude-1', status: 'waiting', bridgeSessionId: 'session_01abc' }

    await writeFile(join(sessions, '7001.json'), JSON.stringify(bridged))
    await runHook(fixture, 'claude', { ...prompt, session_id: 'claude-1' })
    await runHook(fixture, 'claude', { ...prompt, session_id: 'claude-2' })
    await runHook(fixture, 'codex', { hook_event_name: 'Stop', session_id: 'claude-1' })
    await writeFile(join(sessions, '7001.json'), JSON.stringify({ ...bridged, bridgeSessionId: undefined }))
    await runHook(fixture, 'claude', { ...prompt, session_id: 'claude-1' })
    await writeFile(join(sessions, '7001.json'), '{"sessionId":')
    await runHook(fixture, 'claude', { ...prompt, session_id: 'claude-1' })

    expect(fixture.handlers.openAttention.mock.calls.map(([params]) => params.phoneNotified)).toEqual([
      true, undefined, undefined, undefined, undefined
    ])
  })

  it('reports a Codex finished turn without withdrawing a possibly queued question', async () => {
    const fixture = await cliFixture()

    expect(await runHook(fixture, 'codex', {
      hook_event_name: 'Stop',
      last_assistant_message: 'Review complete'
    })).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      'codex:permission'
    ])
    expect(fixture.handlers.openAttention).toHaveBeenCalledWith(expect.objectContaining({
      requestKey: 'codex:turn',
      kind: 'notice',
      title: 'Codex finished its turn',
      body: 'Review complete'
    }))
  })

  it.each([
    ['claude', 'startup', { transcript_path: '/home/owner/.claude/projects/p/abc.jsonl' }],
    ['claude', 'clear', {}],
    ['codex', 'resume', {}],
    ['codex', 'fork', {}]
  ])('reports the conversation %s is in when SessionStart says %s, without racing a new question with withdrawals', async (agent, source, extra) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, agent, {
      hook_event_name: 'SessionStart',
      source,
      session_id: OBSERVED_REFERENCE,
      ...extra
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.observeConversation).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.observeConversation.mock.calls[0]?.[0]).toEqual({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      agentCli: agent,
      conversationReference: OBSERVED_REFERENCE,
      source,
      ...('transcript_path' in extra ? { transcriptPath: extra.transcript_path } : {})
    })
  })

  it.each([
    ['compaction, which stays in the same conversation', { source: 'compact', session_id: OBSERVED_REFERENCE }],
    ['a payload with no session id', { source: 'startup' }],
    ['a session id that is not a UUID', { source: 'startup', session_id: 'rollout-2026' }],
    ['a non-string session id', { source: 'startup', session_id: 42 }],
    ['a subagent payload', { source: 'startup', session_id: OBSERVED_REFERENCE, agent_id: 'explorer' }],
    ['an unknown source', { source: 'restore', session_id: OBSERVED_REFERENCE }]
  ])('reports no conversation for %s', async (_label, event) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', { hook_event_name: 'SessionStart', ...event })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
  })

  it('does not withdraw questions when the app refuses the conversation it reported', async () => {
    const fixture = await cliFixture()
    fixture.handlers.observeConversation.mockRejectedValue(
      new ControlError(ERROR_CODES.invalidArgument, 'conversationReference must be a UUID')
    )

    const result = await runHook(fixture, 'codex', {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: OBSERVED_REFERENCE
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
  })

  it('reports nothing from a nested agent, whose conversation is not the owner\'s', async () => {
    const fixture = await cliFixture()

    const result = await runHook(
      fixture,
      'claude',
      { hook_event_name: 'SessionStart', source: 'startup', session_id: OBSERVED_REFERENCE },
      { comm: 'claude', tty: 0, group: 7001, foreground: -1 }
    )

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
  })

  it('ignores an agent that does not hold the terminal, such as claude -p run from a tool call', async () => {
    const fixture = await cliFixture()
    const stop = { hook_event_name: 'Stop', last_assistant_message: 'worker done' }

    const toolCall = await runHook(fixture, 'claude', stop, { comm: 'claude', tty: 0, group: 7001, foreground: -1 })
    const background = await runHook(fixture, 'claude', stop, { comm: 'claude', tty: 34817, group: 7001, foreground: 7100 })

    expect(toolCall).toEqual(QUIET)
    expect(background).toEqual(QUIET)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
  })

  it.each([
    ['no agent at all', []],
    ['an extra word after the agent', ['claude', 'extra']],
    ['an agent it does not know', ['gemini']]
  ])('refuses %s without sending anything, and still exits 0', async (_label, rest) => {
    // `bmn hooks check` recognises the bare `bmn hook <agent>` as an entry, and this refusal is
    // what makes the third word part of the command's identity rather than a hint.
    const fixture = await cliFixture()
    const proc = await procTree(fixture.root, HOLDS_TERMINAL)

    const result = await runCli(['hook', ...rest], {
      env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc },
      input: JSON.stringify({ hook_event_name: 'Stop' })
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('hook expects one agent')
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent).not.toHaveBeenCalled()
  })

  it('stays silent for input that parses but is not an event object', async () => {
    const fixture = await cliFixture()

    const list = await runHook(fixture, 'claude', [{ hook_event_name: 'Stop' }])
    const bare = await runHook(fixture, 'claude', 'Stop')

    expect(list).toEqual(QUIET)
    expect(bare).toEqual(QUIET)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it('gives up on a socket that accepts and never answers, rather than holding the agent up', async () => {
    // The ceiling is the whole reason a hook may talk to BMN at all: an app that has wedged must
    // cost the agent three seconds, not its turn.
    const fixture = await cliFixture()
    fixture.handlers.openAttention.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()

    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'May I?'
    })

    expect(result).toEqual(QUIET)
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 20_000)

  it('still reports when it cannot read the process tree at all, rather than falling silent', async () => {
    // Failing closed here would silently disable every hook on a system whose /proc reads
    // differently. "Cannot tell" means report: a duplicate request is visible, a missing one is not.
    const fixture = await cliFixture()
    const emptyProc = join(fixture.root, 'proc-without-entries')
    await mkdir(emptyProc, { recursive: true })

    const result = await runCli(['hook', 'claude'], {
      env: { ...fixture.sessionEnv, BMN_PROC_ROOT: emptyProc, CLAUDE_CONFIG_DIR: join(fixture.root, 'claude') },
      input: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'May I?' })
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalledTimes(1)
  })

  it('stays silent and exits 0 outside BMN, on unreadable input, and when the app cannot be reached', async () => {
    const fixture = await cliFixture()
    const proc = await procTree(fixture.root, HOLDS_TERMINAL)
    const stop = JSON.stringify({ hook_event_name: 'Stop' })

    const outside = await runCli(['hook', 'claude'], { input: stop })
    const unreadable = await runCli(['hook', 'claude'], {
      env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc },
      input: 'not json'
    })
    const unreachable = await runCli(['hook', 'codex'], {
      env: { ...fixture.sessionEnv, BMN_CONTROL_SOCKET: join(fixture.root, 'gone.sock'), BMN_PROC_ROOT: proc },
      input: stop
    })

    expect([outside, unreadable, unreachable]).toEqual([QUIET, QUIET, QUIET])
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })
})

describe('bmn hook provenance and the hook event log', () => {
  it.each([
    ['claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' },
      ['opened']],
    ['claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }, ['answered', 'withdrew']],
    ['claude', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' }, ['answered', 'withdrew']],
    ['claude', { hook_event_name: 'UserPromptSubmit' }, ['answered', 'withdrew']],
    ['claude', { hook_event_name: 'Stop', last_assistant_message: 'Done' }, ['withdrew', 'opened']],
    ['claude', { hook_event_name: 'SessionEnd' }, ['withdrew']],
    ['claude', { hook_event_name: 'Interrupt' }, ['withdrew']],
    ['codex', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }, ['opened']],
    ['codex', { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: {} }, ['opened']],
    ['codex', { hook_event_name: 'Stop' }, ['withdrew', 'opened']]
  ])('stamps every %s call with its own event and records what it changed', async (agent, event, effects) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, agent, event)

    expect(result).toEqual(QUIET)
    const origins = [
      ...fixture.handlers.openAttention.mock.calls,
      ...fixture.handlers.withdrawAttention.mock.calls,
      ...fixture.handlers.resolveAttention.mock.calls
    ].map(([params]) => (params as { origin?: string }).origin)
    expect(origins.length).toBeGreaterThan(0)
    expect(new Set(origins)).toEqual(new Set([`hook:${agent}:${event.hook_event_name}`]))
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed).toMatchObject({ sessionId: 'session-1', agent, event: event.hook_event_name })
    expect(new Set(observed?.effects)).toEqual(new Set(effects))
  })

  it('records an event that changed nothing, which is what a missing request looks like', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting'
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({
      agent: 'claude',
      event: 'Notification',
      source: null,
      toolName: null,
      effects: []
    })
  })

  it.each([
    ['claude', 'ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', 'api.z.ai'],
    ['claude', 'ANTHROPIC_BASE_URL', 'http://localhost:3000/base', 'localhost'],
    ['claude', 'ANTHROPIC_BASE_URL', 'https://user:secret@mistral.ai/v1', 'mistral.ai'],
    ['claude', 'ANTHROPIC_BASE_URL', 'unix:///run/bmn.sock', undefined],
    ['claude', 'ANTHROPIC_BASE_URL', 'not a url', undefined],
    ['claude', 'ANTHROPIC_BASE_URL', 'https://my_host.internal.example/v1', 'my_host.internal.example'],
    ['claude', 'ANTHROPIC_BASE_URL', 'http://[::1]:8080/v1', '[::1]'],
    // A fully qualified name keeps its root dot; the classifier reads it as the same host.
    ['claude', 'ANTHROPIC_BASE_URL', 'https://api.z.ai./api/anthropic', 'api.z.ai.'],
    // A host the utility would refuse is not sent, so the observation itself still arrives.
    ['claude', 'ANTHROPIC_BASE_URL', `https://${'a'.repeat(300)}.example`, undefined],
    ['claude', 'OPENAI_BASE_URL', 'https://api.openai.com/v1', undefined],
    ['codex', 'OPENAI_BASE_URL', 'https://api.openai.com/v1', 'api.openai.com'],
    ['codex', 'OPENAI_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3', 'ark.cn-beijing.volces.com'],
    ['codex', 'ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', undefined],
    ['opencode', 'ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', undefined]
  ])('forwards only the hostname of %s own base URL (%s=%s)', async (agent, variable, value, apiHost) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, agent, { hook_event_name: 'Notification' }, HOLDS_TERMINAL, {
      [variable]: value
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed).toMatchObject({ agent, event: 'Notification' })
    // Only the parsed host ever leaves the process: no scheme, path, port, credentials or raw URL.
    expect(observed?.apiHost).toBe(apiHost)
    expect(JSON.stringify(observed)).not.toContain('secret')
    expect(JSON.stringify(observed)).not.toContain('/api/anthropic')
    expect(JSON.stringify(observed)).not.toContain('/v1')
  })

  // Story 31.1: the Claude config folder rides along, resolved the way `hooks install` resolves it.
  it.each([
    ['an absolute folder', process.platform === 'win32' ? 'C:\\srv\\agents\\glm-config' : '/srv/agents/glm-config', undefined, process.platform === 'win32' ? 'C:\\srv\\agents\\glm-config' : '/srv/agents/glm-config'],
    ['a relative folder, against the working directory', 'conf/glm', 'cwd', process.platform === 'win32' ? '<cwd>\\conf/glm' : '<cwd>/conf/glm'],
    ['a folder with .. kept as written', process.platform === 'win32' ? 'C:\\srv\\agents\\..\\glm' : '/srv/agents/../glm', undefined, process.platform === 'win32' ? 'C:\\srv\\agents\\..\\glm' : '/srv/agents/../glm'],
    ['no variable, the home folder', undefined, undefined, '<home>/.claude']
  ])('sends claudeConfigDir for %s', async (_label, variable, cwd, expected) => {
    const fixture = await cliFixture()
    const home = join(fixture.root, 'home')
    const workdir = join(fixture.root, 'work')
    await mkdir(workdir, { recursive: true })
    const proc = await procTree(fixture.root, HOLDS_TERMINAL)
    const result = await runCli(['hook', 'claude'], {
      env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc, HOME: home, ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable }) },
      input: JSON.stringify({ hook_event_name: 'Notification' }),
      ...(cwd === undefined ? {} : { cwd: workdir })
    })

    expect(result).toEqual(QUIET)
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed?.claudeConfigDir).toBe(expected.replace('<cwd>', workdir).replace('<home>', home))
  })

  it('sends no claudeConfigDir from a Codex or OpenCode hook', async () => {
    for (const agent of ['codex', 'opencode']) {
      const fixture = await cliFixture()
      await runHook(fixture, agent, { hook_event_name: 'Stop' }, HOLDS_TERMINAL, { CLAUDE_CONFIG_DIR: '/srv/glm' })
      const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
      expect(observed).toMatchObject({ agent })
      expect(observed?.claudeConfigDir).toBeUndefined()
    }
  })

  it('sends no apiHost when the base URL variable is unset', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', { hook_event_name: 'Notification' })

    expect(result).toEqual(QUIET)
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed).toMatchObject({ agent: 'claude' })
    expect(observed?.apiHost).toBeUndefined()
  })

  it.each([
    ['claude', { hook_event_name: 'SessionStart', model: '  GLM-5.3  ' }, 'GLM-5.3'],
    ['claude', { hook_event_name: 'SessionStart', model: 'x'.repeat(200) }, 'x'.repeat(128)],
    // The utility refuses more than 128 UTF-16 units, and a cut never splits a surrogate pair.
    ['claude', { hook_event_name: 'SessionStart', model: 'x'.repeat(126) + '😀😀' }, 'x'.repeat(126) + '😀'],
    ['claude', { hook_event_name: 'SessionStart', model: 'x'.repeat(127) + '😀' }, 'x'.repeat(127)],
    ['claude', { hook_event_name: 'SessionStart', model: 'glm\u0007-5\u007f' }, 'glm-5'],
    ['claude', { hook_event_name: 'SessionStart', model: 42 }, undefined],
    ['claude', { hook_event_name: 'SessionStart' }, undefined],
    ['claude', { hook_event_name: 'SessionStart', model: '  \t ' }, undefined],
    [
      'opencode',
      // The shipped plugin spreads `properties`; `message.updated` carries `{ info: Message }`.
      { hook_event_name: 'message.updated', info: { role: 'assistant', providerID: 'moonshotai', modelID: 'kimi-k2' } },
      'kimi-k2'
    ],
    ['opencode', { hook_event_name: 'message.updated', info: { role: 'user' } }, undefined],
    ['opencode', { hook_event_name: 'session.started' }, undefined]
  ])('carries the model %s payloads report, trimmed and bounded', async (agent, event, model) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, agent, event)

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed).toMatchObject({ agent })
    expect(observed?.model).toBe(model)
  })

  it('records no effect for calls the host refused, which is what a missing request looks like', async () => {
    const fixture = await cliFixture()
    const missing = (): never => {
      throw new ControlError(ERROR_CODES.notFound, 'no open request with that key')
    }
    fixture.handlers.withdrawAttention.mockImplementation(missing)
    fixture.handlers.resolveAttention.mockImplementation(missing)

    // A PostToolUse resolves and withdraws; with nothing open, every call comes back not-found.
    const result = await runHook(fixture, 'claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention).toHaveBeenCalled()
    expect(fixture.handlers.resolveAttention).toHaveBeenCalled()
    // AC2: effects describe what changed, so an event that changed nothing lists nothing.
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({ event: 'PostToolUse', effects: [] })
  })

  it('records only the half of a partial batch that the host accepted', async () => {
    const fixture = await cliFixture()
    fixture.handlers.withdrawAttention.mockImplementation((): never => {
      throw new ControlError(ERROR_CODES.notFound, 'no open request with that key')
    })

    // A Claude Stop withdraws the question it answered and opens the finished-turn notice.
    const result = await runHook(fixture, 'claude', { hook_event_name: 'Stop', last_assistant_message: 'Done' })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({ effects: ['opened'] })
  })

  it.each(['Custom-Event', 'Custom Event', 'Évènement'])(
    'carries the unfamiliar event name %s, which is what the log is for',
    async (event) => {
      const fixture = await cliFixture()

      const result = await runHook(fixture, 'claude', { hook_event_name: event })

      expect(result).toEqual(QUIET)
      expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({ event, effects: [] })
    }
  )

  it('carries a tool name the RULES.source shape allows, not only an ASCII one', async () => {
    const fixture = await cliFixture()

    await runHook(fixture, 'claude', { hook_event_name: 'PostToolUse', tool_name: 'Éditeur', tool_input: {} })

    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'PostToolUse',
      toolName: 'Éditeur'
    })
  })

  it('fingerprints canonical tool calls without sending their input or result to hook.observe', async () => {
    const fixture = await cliFixture()
    const first = {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { nested: { b: 2, a: 1 }, args: [{ z: '✓', x: 1 }] },
      tool_response: { lines: ['α', 'β'], ok: true }
    }
    const reordered = {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { args: [{ x: 1, z: '✓' }], nested: { a: 1, b: 2 } },
      tool_response: { ok: true, lines: ['α', 'β'] }
    }
    await runHook(fixture, 'claude', first)
    const one = fixture.handlers.observeHookEvent.mock.lastCall?.[0]
    const expected = createHash('sha256').update('Bash\0{"args":[{"x":1,"z":"✓"}],"nested":{"a":1,"b":2}}\0{"lines":["α","β"],"ok":true}').digest('hex').slice(0, 16)
    expect(one).toMatchObject({ fingerprint: expected })
    expect(one).not.toHaveProperty('tool_input')
    expect(one).not.toHaveProperty('tool_response')
    await runHook(fixture, 'claude', reordered)
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).toMatchObject({ fingerprint: expected })
    await runHook(fixture, 'claude', { ...reordered, tool_input: { ...reordered.tool_input, args: [{ x: 1, z: 'x' }] } })
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]?.fingerprint).not.toBe(expected)
    await runHook(fixture, 'claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).not.toHaveProperty('fingerprint')
  })

  it('fingerprints the measured Claude failed-tool error when no tool response exists', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'false' }, error: 'Exit code 1'
    })
    const expected = createHash('sha256').update('Bash\0{"command":"false"}\0"Exit code 1"').digest('hex').slice(0, 16)
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).toMatchObject({ fingerprint: expected })
  })

  it('fingerprints a Claude call without its free-text description label', async () => {
    const fixture = await cliFixture()
    const expected = createHash('sha256').update('Bash\0{"command":"false"}\0"Exit code 1"').digest('hex').slice(0, 16)
    await runHook(fixture, 'claude', {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run it (first time)' }, error: 'Exit code 1'
    })
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).toMatchObject({ fingerprint: expected })
    await runHook(fixture, 'claude', {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run it again' }, error: 'Exit code 1'
    })
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).toMatchObject({ fingerprint: expected })
  })

  it('fingerprints a Codex call with its description label kept verbatim', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run it (first time)' }
    })
    const one = fixture.handlers.observeHookEvent.mock.lastCall?.[0]?.fingerprint
    await runHook(fixture, 'codex', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run it again' }
    })
    const two = fixture.handlers.observeHookEvent.mock.lastCall?.[0]?.fingerprint
    expect(one).toMatch(/^[0-9a-f]{16}$/)
    expect(two).toMatch(/^[0-9a-f]{16}$/)
    expect(two).not.toBe(one)
  })

  it('canonicalizes absent tool input and result as null', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    const absent = createHash('sha256').update('Bash\0null\0null').digest('hex').slice(0, 16)
    expect(fixture.handlers.observeHookEvent.mock.lastCall?.[0]).toMatchObject({ fingerprint: absent })
  })

  it('records an open the host says changed nothing as changing nothing', async () => {
    const fixture = await cliFixture()
    fixture.handlers.openAttention.mockImplementation(async () => ({ opened: true, changed: false }))

    // The same permission prompt twice: the second finds the request already open and identical.
    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?'
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.openAttention).toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'Notification',
      effects: []
    })
  })

  it('logs an event whose name is too long to stamp on a request, without an origin', async () => {
    const fixture = await cliFixture()
    // 60 characters fits `RULES.source` for the event, but `hook:claude:` + 60 exceeds the origin's 64.
    const event = 'E'.repeat(60)

    const result = await runHook(fixture, 'claude', {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?'
    })
    const stamped = fixture.handlers.openAttention.mock.calls.at(-1)?.[0] as { origin?: string } | undefined
    const long = await runHook(fixture, 'claude', { hook_event_name: event })

    expect(result).toEqual(QUIET)
    expect(long).toEqual(QUIET)
    expect(stamped?.origin).toBe('hook:claude:Notification')
    expect(fixture.handlers.observeHookEvent.mock.calls.at(-1)?.[0]).toMatchObject({ event, effects: [] })
  })

  it('carries the harness source and tool name when the payload has them', async () => {
    const fixture = await cliFixture()

    await runHook(fixture, 'claude', {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: OBSERVED_REFERENCE
    })

    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'SessionStart',
      source: 'resume',
      toolName: null
    })
  })

  it('records nothing for an event name the harness did not shape like an event', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', { hook_event_name: 'Stop\nForged' })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeHookEvent).not.toHaveBeenCalled()
  })
})

const DOCUMENTED_CLAUDE = '[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0'
const OLDER_CLAUDE = '[ -n "$AITERM_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0'
const CLAUDE_EVENTS = [
  'Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop',
  'SessionStart', 'SessionEnd'
]
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt']
const DOCUMENTED_CODEX = DOCUMENTED_CLAUDE.replace('bmn hook claude', 'bmn hook codex')

/** Every hook fixture lives under a fresh temporary folder, so a public clone carries no owner data. */
async function hookFileFixture(contents?: unknown, name = 'settings.json'): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aithooks-')))
  createdRoots.add(root)
  const path = join(root, name)
  if (contents !== undefined) {
    await writeFile(path, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`)
    ownWindowsFixtureFile(root, path)
  }
  return path
}

function entryGroup(command: string, timeout = 5): unknown {
  return { hooks: [{ type: 'command', command, timeout }] }
}

/**
 * A Codex file with every expected event wired, plus whatever the case under test adds: `hooks`
 * replaces an event, `beside` adds a second group to `Stop` next to the wired one, and anything
 * else is a top-level key.
 */
async function codexFixture(extra: Record<string, unknown> = {}, events: readonly string[] = CODEX_EVENTS): Promise<string> {
  const { hooks, beside, ...root } = extra as { hooks?: Record<string, unknown>; beside?: unknown }
  const wired = Object.fromEntries(events.map((each) => [each, [entryGroup(DOCUMENTED_CODEX)]]))
  if (beside !== undefined) wired.Stop = [entryGroup(DOCUMENTED_CODEX), beside]
  return hookFileFixture({ ...root, hooks: { ...wired, ...(hooks ?? {}) } }, 'hooks.json')
}

async function backupsOf(path: string): Promise<string[]> {
  const entries = await readdir(dirname(path))
  return entries.filter((entry) => entry.startsWith(`${basename(path)}.bmn-backup-`))
}

/** `hooks` is an owner command: no socket, no token, nothing on the wire. */
function runHooks(args: string[], env?: Record<string, string>): Promise<CliResult> {
  return runCli(['hooks', ...args], env === undefined ? {} : { env })
}

function ttyHooks(args: string[], pipe: 'none' | 'stdin' | 'stdout' | 'stderr' = 'none'): {
  write(text: string): void
  waitFor(text: string): Promise<void>
  finish: Promise<number>
  output(): string
} {
  const stdio = [pipe === 'stdin' ? 'pipe' : 'inherit', pipe === 'stdout' ? 'pipe' : 'inherit',
    pipe === 'stderr' ? 'pipe' : 'inherit']
  const wrapper = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: ${JSON.stringify(stdio)} });
    ${pipe === 'stdin' ? 'child.stdin.end();' : ''}
    ${pipe === 'stdout' || pipe === 'stderr'
      ? `child.${pipe}.on('data', part => process.stdout.write(part));` : ''}
    child.on('exit', code => { process.exitCode = code ?? 1 });`
  const command = pipe === 'none' ? [CLI, 'hooks', ...args] : ['-e', wrapper, CLI, 'hooks', ...args]
  const fileIndex = args.indexOf('--file')
  const fixtureHome = fileIndex >= 0 ? dirname(args[fileIndex + 1]!) : tmpdir()
  const essentials = process.platform === 'win32' ? Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec'].flatMap(key => {
      const value = windowsEnvironmentValue(process.env, key)
      return value ? [[key, value]] : []
    })
  ) : {}
  const child = spawnPty(process.execPath, command, {
    name: 'xterm-256color', cols: 100, rows: 32, cwd: process.cwd(),
    env: { ...essentials, ...HOOK_FORM_POSIX, PATH: process.env.PATH ?? '', HOME: fixtureHome,
      ...(process.platform === 'win32' ? { USERPROFILE: fixtureHome } : {}) },
    ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {})
  })
  let output = ''
  const waiting = new Set<{ text: string; resolve: () => void }>()
  child.onData((part) => {
    output += part
    for (const item of waiting) {
      if (output.includes(item.text)) { waiting.delete(item); item.resolve() }
    }
  })
  return {
    write: (text) => child.write(text),
    output: () => output,
    finish: new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode))),
    waitFor: (text) => output.includes(text) ? Promise.resolve() : new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { if (waiting.delete(item)) reject(new Error(`TTY did not show ${text}: ${output}`)) }, 5000)
      const item = { text, resolve: () => { clearTimeout(timeout); resolve() } }
      waiting.add(item)
    })
  }
}

describe('bmn hooks check', () => {
  it('reads a missing file as every event missing and exits 1 without a socket or a token', async () => {
    const path = await hookFileFixture()

    const result = await runHooks(['check', 'claude', '--file', path])

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    for (const event of CLAUDE_EVENTS) expect(result.stdout).toMatch(new RegExp(`${event}\\s+missing`))
    expect(result.stdout).toContain('the file does not exist')
  })

  it('reports a file it cannot read as unreadable, and installs nothing over it', async () => {
    const path = await hookFileFixture({ hooks: {} })
    if (process.platform === 'win32') denyWindowsFixtureFileReads(dirname(path), path, true)
    else await chmod(path, 0o000)

    try {
      await expect(readFile(path)).rejects.toThrow()
      const check = await runHooks(['check', 'claude', '--file', path])
      const install = await runHooks(['install', '--yes', 'claude', '--file', path])
      expect(check.code).toBe(1)
      expect(check.stdout).toMatch(/EACCES|EPERM/)
      expect(install.code).toBe(1)
    } finally {
      if (process.platform === 'win32') denyWindowsFixtureFileReads(dirname(path), path, false)
      else await chmod(path, 0o600)
    }
    // Somebody's configuration BMN could not read is never something to overwrite.
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ hooks: {} })
    expect(await backupsOf(path)).toEqual([])
  })

  it('reads an empty object as every event missing', async () => {
    const path = await hookFileFixture({})

    const result = await runHooks(['check', 'claude', '--file', path])

    expect(result.code).toBe(1)
    for (const event of CLAUDE_EVENTS) expect(result.stdout).toMatch(new RegExp(`${event}\\s+missing`))
  })

  it('calls the documented command wired and the older AITERM wording wired (older wording)', async () => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CLAUDE_EVENTS.slice(0, 3).map((event) => [event, [entryGroup(DOCUMENTED_CLAUDE)]])),
        ...Object.fromEntries(CLAUDE_EVENTS.slice(3).map((event) => [event, [entryGroup(OLDER_CLAUDE)]]))
      }
    })

    const result = await runHooks(['check', 'claude', '--file', path])

    expect(result.code).toBe(0)
    for (const event of CLAUDE_EVENTS.slice(0, 3)) {
      expect(result.stdout).toMatch(new RegExp(`${event}\\s+wired$`, 'm'))
    }
    for (const event of CLAUDE_EVENTS.slice(3)) {
      expect(result.stdout).toMatch(new RegExp(`${event}\\s+wired \\(older wording\\)`))
    }
    expect(result.stdout).toContain('not proof that a hook fired')
  })

  it('reports the events that are wired and the ones that are not, and exits 1 for the gap', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(DOCUMENTED_CLAUDE)] } })

    const result = await runHooks(['check', 'claude', '--file', path])

    expect(result.code).toBe(1)
    expect(result.stdout).toMatch(/Stop\s+wired$/m)
    expect(result.stdout).toMatch(/Notification\s+missing/)
  })

  it('shows Codex PermissionRequest and PostCompact as optional and does not fail the check for them', async () => {
    const codex = CODEX_EVENTS.map((event) => [event, [entryGroup(`bmn hook codex`)]])
    const path = await hookFileFixture({ hooks: Object.fromEntries(codex) }, 'hooks.json')

    const result = await runHooks(['check', 'codex', '--file', path])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/PermissionRequest\s+missing \(optional\)/)
    expect(result.stdout).toMatch(/PostCompact\s+missing \(optional\)/)
  })

  it('reports an unparsable file as such with exit 1 and claims nothing about any event', async () => {
    const path = await hookFileFixture('{ "hooks": ')

    const result = await runHooks(['check', 'claude', '--file', path])

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('not valid JSON')
    expect(result.stdout).not.toContain('wired')
  })

  it('prints the same report as one object with --json', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(OLDER_CLAUDE)] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const report = JSON.parse(result.stdout)

    expect(result.code).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.agents).toHaveLength(1)
    expect(report.agents[0]).toMatchObject({ agent: 'claude', file: path, state: 'read' })
    expect(report.agents[0].events).toContainEqual({ event: 'Stop', optional: false, state: 'wired (older wording)' })
    expect(report.agents[0].missing).toEqual(CLAUDE_EVENTS.filter((event) => event !== 'Stop'))
  })

  // The recogniser compares whole commands and never parses one, so this table has two halves: the
  // few exact strings BMN answers for, and - much longer - everything that only looks like one.
  // The second half is the point. Seven rounds of review each found a command a grammar here called
  // wired that the shell could not report from, which is the one outcome `check` exists to prevent.
  // Every row below is a command that must never be called wired again.
  it.each([
    ['the documented command', 'wired', DOCUMENTED_CLAUDE],
    ['the older AITERM wording', 'wired (older wording)', OLDER_CLAUDE],
    ['the bare call', 'wired (older wording)', 'bmn hook claude'],
    // Space, tab and newline around the command are the only whitespace bash drops, so they are
    // the only whitespace that leaves the same command. Everything else is part of a word.
    ['the documented command padded with newlines', 'wired', `\n${DOCUMENTED_CLAUDE}\n`],
    ['the bare call padded with spaces', 'wired (older wording)', '  bmn hook claude  '],
    ['the bare call padded with tabs', 'wired (older wording)', '\tbmn hook claude\t']
  ])('reads %s as %s', async (_label, state, command) => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(command)] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toMatchObject({ state })
  })

  it.each([
    // One character away from an entry BMN writes. Nothing here is "close enough".
    ['a doubled space inside the call', 'bmn  hook claude'],
    // The blocker of wave 7, found by both reviewers. JavaScript's `trim` drops these; bash does
    // not, so each stays part of the first or last word and the command never runs. Trimming them
    // would call the entry wired with no event delivered - the one outcome this command prevents.
    ['a leading non-breaking space', '\u00a0bmn hook claude'],
    ['a leading non-breaking space on the documented command', `\u00a0${DOCUMENTED_CLAUDE}`],
    ['a leading byte-order mark', '\ufeffbmn hook claude'],
    ['a leading byte-order mark on the documented command', `\ufeff${DOCUMENTED_CLAUDE}`],
    ['a leading line separator', '\u2028bmn hook claude'],
    ['a leading ideographic space', '\u3000bmn hook claude'],
    ['a leading narrow no-break space', '\u202fbmn hook claude'],
    ['a leading en quad', '\u2000bmn hook claude'],
    ['a leading vertical tab', '\vbmn hook claude'],
    ['a leading form feed', '\fbmn hook claude'],
    ['a leading carriage return', '\rbmn hook claude'],
    ['a trailing non-breaking space', 'bmn hook claude\u00a0'],
    ['a trailing carriage return', 'bmn hook claude\r'],
    ['a trailing vertical tab', 'bmn hook claude\v'],
    ['a trailing form feed', 'bmn hook claude\f'],
    ['a trailing byte-order mark', `${DOCUMENTED_CLAUDE}\ufeff`],
    ['the guard left off the documented command', 'command -v bmn >/dev/null && bmn hook claude; exit 0'],
    ['the documented command exiting non-zero', DOCUMENTED_CLAUDE.replace('exit 0', 'exit 1')],
    ['the documented command without its exit', DOCUMENTED_CLAUDE.replace('; exit 0', '')],
    ['the documented command with the test spelled out', DOCUMENTED_CLAUDE.replace('[ -n', 'test -n').replace(' ]', '')],
    ['a newline inside the documented command', DOCUMENTED_CLAUDE.replace('&& bmn', '&&\nbmn')],
    // Containing a recognised entry is not being one: whatever is wrapped around it decides what runs.
    ['the documented command with a comment after it', `${DOCUMENTED_CLAUDE} # mine`],
    ['the documented command after something else', `cat >/dev/null; ${DOCUMENTED_CLAUDE}`],
    ['the bare call inside a longer command', 'cd / && bmn hook claude'],
    ['the other agent inside a claude entry', OLDER_CLAUDE.replace('claude', 'codex')],

    // Shapes that do run the hook. `install` adds BMN's entry beside them; that duplicate is the
    // stated cost of never reading shell, and `check` names them so the duplicate is explained.
    ['a bare wrapper', 'timeout 5 bmn hook claude'],
    ['the command builtin', 'command bmn hook claude'],
    ['env carrying a variable', 'env BMN_X=1 bmn hook claude'],
    ['a leading assignment', 'BMN_X=1 bmn hook claude'],
    ['an absolute path to bmn', '"/usr/bin/bmn" hook claude'],
    ['a quoted subcommand', "bmn 'hook' claude"],
    ['a shell keyword in front', 'if true; then bmn hook claude; fi'],
    ['a nested construct', 'if true; then if true; then bmn hook claude; fi; fi'],
    ['a redirection of stderr', 'bmn hook claude 2>/dev/null'],
    ['three descriptors moved around', 'bmn hook claude 3>&1 1>&2 2>&3'],
    ['a trailing comment', 'bmn hook claude # run it'],
    ['a negated command', '! bmn hook claude'],
    ['a harmless command in front', 'cd /; bmn hook claude'],
    ['a subshell', '(bmn hook claude)'],
    ['a brace group', '{ bmn hook claude; }'],
    ['exec as a wrapper', 'exec bmn hook claude'],
    ['a shell asked to run it', "sh -c 'bmn hook claude'"],
    ['eval, which runs what it assembles', 'eval bmn hook claude'],
    ['a pipe that passes the event straight through', 'cat | bmn hook claude'],

    // Shapes that would run but could never report: the event arrives only on standard input.
    ['a backgrounded command, which is handed /dev/null', 'bmn hook claude &'],
    ['a backgrounded command under nohup', 'nohup bmn hook claude &'],
    ['a whole list put in the background', 'bmn hook claude && true &'],
    ['the right-hand side of a pipe', 'echo x | bmn hook claude'],
    ['the right-hand side of a pipe that carries stderr', 'echo x |& bmn hook claude'],
    ['standard input taken from a file', 'bmn hook claude </dev/null'],
    ['standard input closed', 'bmn hook claude <&-'],
    ['standard input duplicated from elsewhere', 'bmn hook claude 0<&1'],
    ['a group whose input is redirected', '{ bmn hook claude; } </dev/null'],
    ['exec changing descriptors first', 'exec </dev/null; bmn hook claude'],
    ['a substitution that eats the event first', 'x=$(cat); bmn hook claude'],
    ['a quoted substitution that eats it', 'echo "$(cat)" >/dev/null; bmn hook claude'],
    ['a command that reads the event first', 'read x; bmn hook claude'],
    ['another command that reads it first', 'cat >/dev/null; bmn hook claude'],
    ['the command builtin delegating to one that reads it', 'command cat >/dev/null; bmn hook claude'],
    ['a negation delegating to one that reads it', '! cat >/dev/null; bmn hook claude'],
    ['a condition that reads it', 'if read x; then :; fi; bmn hook claude'],
    ['a select loop, which reads it itself', 'select x in one; do bmn hook claude; break; done'],
    ['an extra argument after the agent', 'bmn hook claude extra'],
    ['an option after the agent', 'bmn hook claude --json'],

    // Shapes the shell rejects outright, so none of the entry runs.
    ['a redirection with no target', 'bmn hook claude >'],
    ['an operator that is not a redirection', 'bmn hook claude >>&/dev/null'],
    ['an operator with nothing in front of it', '&& bmn hook claude'],
    ['a semicolon with nothing in front of it', '; bmn hook claude'],
    ['a doubled separator', 'true;; bmn hook claude'],
    ['a trailing operator', 'bmn hook claude &&'],
    ['an unterminated quote', 'bmn hook "claude'],
    ['an if that is never closed', 'if true; then bmn hook claude'],
    ['a closer before its opener', 'fi; if true; then bmn hook claude'],
    ['the wrong continuation keyword', 'if true; do bmn hook claude; fi'],
    ['crossed nesting', 'while false; do :; fi; done; bmn hook claude'],
    ['a keyword after its construct closed', 'if true; then :; fi; then bmn hook claude'],
    ['a continuation keyword with nothing to continue', 'then bmn hook claude'],
    ['a descriptor nothing opened', 'bmn hook claude 2>&3'],
    ['a descriptor that was closed first', 'bmn hook claude 3>&- 2>&3'],
    ['stdout closed and then duplicated', 'bmn hook claude 1>&- 2>&1'],
    ['a quoted descriptor', "bmn hook claude 2>&'3'"],
    ['a descriptor that is not a number', 'bmn hook claude 2>&x'],

    // The words are there, but nothing runs them.
    ['the words echoed, not run', 'echo bmn hook claude'],
    ['the words quoted inside an echo', "echo 'example; bmn hook claude; end'"],
    ['the words after a comment', '# example; bmn hook claude'],
    ['the words after a comment that follows an operator', ':;# example; bmn hook claude'],
    ['the words in a here-document', "cat <<'EOF'\nbmn hook claude\nEOF"],
    ['the words as a here-string', 'cat <<< bmn hook claude'],
    ['the words in an array assignment', 'args=( bmn hook claude )'],
    ['a case pattern that names bmn', 'case $x in\nbmn) hook claude\nesac'],
    ['a lookup rather than a call', 'command -v bmn hook claude'],
    ['a shell parsing without running', 'bash -n -c "bmn hook claude"'],
    ['env asked only to explain itself', 'env --help bmn hook claude'],

    // Not ours at all.
    ['a program whose name ends in bmn', 'other.bmn hook claude'],
    ['a different agent argument', 'bmn hook claude.extra'],
    ['another agent', 'bmn hook codex'],
    ['words joined by a non-breaking space', 'bmn hook claude'],
    ['words joined by a carriage return', 'bmn\rhook\rclaude'],
    ['a command that has nothing to do with bmn', 'echo hello']
  ])('reads %s as missing', async (_label, command) => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(command)] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toMatchObject({ state: 'missing' })
  })

  it('names an entry that mentions the hook without being one it recognises, in both formats', async () => {
    const written = '  timeout 5 bmn hook claude   # mine  '
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(written)] } })

    const plain = await runHooks(['check', 'claude', '--file', path])
    const json = await runHooks(['check', 'claude', '--file', path, '--json'])

    // Missing, because BMN does not read it - but never silently: the owner has to be able to see
    // why `install` is about to add a second entry for an event that already mentions the hook.
    expect(plain.code).toBe(1)
    expect(plain.stdout).toMatch(/Stop\s+missing/)
    expect(plain.stdout).toContain('names bmn hook claude but is not one BMN recognises')
    // Story 38.4: printed as JSON quotes it, exactly as it is in the file.
    expect(plain.stdout).toContain(`      ${JSON.stringify(written)}\n`)
    expect(JSON.parse(json.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing', unrecognised: [written] })
  })

  it('says nothing about an unrecognised entry for an event that is already wired', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [entryGroup('timeout 5 bmn hook claude'), entryGroup(DOCUMENTED_CLAUDE)] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // Nothing is missing for this event, so there is no duplicate coming and nothing to explain.
    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'wired' })
  })

  // Only the three shapes that name no tool leave a group ungated. Everything else gates it, and
  // BMN does not read matchers, so it will not answer for an entry inside one. A whitespace-only
  // matcher is the sharp case: it is a pattern matching no tool name, not an absent matcher.
  it.each([
    ['no matcher at all', undefined, 'wired'],
    ['a matcher that is null', null, 'missing'],
    ['an empty matcher', '', 'wired'],
    ['a matcher of one space', ' ', 'missing'],
    ['a matcher of one tab', '\t', 'missing'],
    ['a matcher of a non-breaking space', '\u00a0', 'missing'],
    ['a matcher naming a tool', 'Write', 'missing'],
    ['a matcher that would match everything', '.*', 'missing'],
    ['a list of patterns', ['Write'], 'missing'],
    ['an empty list of patterns', [], 'missing']
  ])('reads an entry under %s as %s', async (_label, matcher, state) => {
    const group: Record<string, unknown> = { hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }
    if (matcher !== undefined) group.matcher = matcher
    const path = await hookFileFixture({ hooks: { PostToolUse: [group] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    const row = JSON.parse(result.stdout).agents[0].events
      .find((each: { event: string }) => each.event === 'PostToolUse')
    expect(row.state).toBe(state)
    // A gated entry is one BMN does recognise, so saying it is "not one BMN recognises" would
    // contradict itself. It gets its own line, and the duplicate is still explained.
    expect(row.gated).toEqual(state === 'wired' ? undefined : [DOCUMENTED_CLAUDE])
    expect(row.unrecognised).toBeUndefined()
  })

  it.each([
    ['a number', 42],
    ['a boolean', false],
    ['an object', {}],
    ['a list that is not all patterns', [1]]
  ])('reads a Claude file whose matcher is %s, gating only that group', async (_label, matcher) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CLAUDE_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CLAUDE)]])),
        PostToolUse: [{ matcher, hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }]
      }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const report = JSON.parse(result.stdout).agents[0]

    // Measured against the real CLI: Claude Code drops a group it cannot use and runs the rest of
    // the file, including sibling groups in the same event. Refusing the file would stop `install`
    // over one dead group, which is a worse answer than reading it.
    expect(report.state).toBe('read')
    expect(report.events.find((row: { event: string }) => row.event === 'PostToolUse').state).toBe('missing')
    expect(report.events.find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
  })

  // Story 38.4: an unrecognised command prints as JSON.stringify quotes it - unambiguous, control
  // characters escaped - and `--json` carries the command itself.
  it.each([
    ['a variation selector', 'bmn hook claude\ufe0f'],
    ['a combining grapheme joiner', 'bmn\u034fhook claude'],
    ['an astral character', 'bmn hook claude \u{1f600}'],
    ['the text of an escape', '\\u00a0bmn hook claude'],
    ['a non-breaking space', '\u00a0bmn hook claude'],
    ['carriage returns', 'bmn\rhook\rclaude'],
    ['a long entry, in full', `bmn hook claude\n${'# padding '.repeat(30)}`]
  ])('prints %s exactly as JSON quotes it', async (_label, command) => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(command)] } })

    const plain = await runHooks(['check', 'claude', '--file', path])
    const json = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(plain.stdout).toContain(`not one BMN recognises:\n      ${JSON.stringify(command)}\n`)
    expect(JSON.parse(json.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').unrecognised).toEqual([command])
  })

  it('shows the character that stopped an entry being recognised, escaped where it is a control', async () => {
    const path = await hookFileFixture({ hooks: { Notification: [entryGroup('bmn\rhook\rclaude')] } })

    const plain = await runHooks(['check', 'claude', '--file', path])

    // Folding the whitespace away would print `bmn hook claude` under a line saying that is not an
    // entry BMN recognises - true, self-contradictory, and with the cause erased.
    expect(plain.stdout).toContain('"bmn\\rhook\\rclaude"')
  })

  it('says what check recognises in its own usage text', async () => {
    const result = await runHooks(['--help'])

    // Nothing else pins this text, and it described the deleted grammar for one whole revision.
    expect(result.stdout).toContain('wired for the entry BMN writes')
    expect(result.stdout).toContain('$AITERM_CONTROL_SOCKET')
    expect(result.stdout).toContain('apart from space, tab and newline')
    expect(result.stdout).toContain('inside a matcher')
    expect(result.stdout).toContain('is not a positive number')
    expect(result.stdout).toContain('does not check that the harness will load the file')
  })

  it('names an entry whose only difference is whitespace', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup('bmn  hook\tclaude')] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // The verdict compares the command as bash would read it; the note may look past any
    // whitespace at all, because the owner needs to see the entry however it is spaced.
    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing', unrecognised: ['bmn  hook\tclaude'] })
  })

  it('says nothing about an entry that names a different agent', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup('timeout 5 bmn hook codex')] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // The agent is part of the entry's identity, so a codex entry is not a claude entry BMN
    // declined to read - it is nothing to do with claude, and there is nothing to tell the owner.
    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing' })
  })

  it.each([
    ['a group whose hooks is not a list', { hooks: 'echo hi' }],
    ['an entry that is not an object', { hooks: ['echo hi'] }],
    ['an entry whose command is not a string', { hooks: [{ type: 'command', command: 5 }] }],
    ['an entry whose timeout is a string', { hooks: [{ type: 'command', command: 'true', timeout: '5' }] }]
  ])('reads a Claude file holding %s, and still sees the rest', async (_label, group) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CLAUDE_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CLAUDE)]])),
        Stop: [entryGroup(DOCUMENTED_CLAUDE), group]
      }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const report = JSON.parse(result.stdout)

    // Measured: a malformed group does not stop a sibling group in the same event from firing, so
    // the file is read and `Stop` is wired by the group beside it.
    expect(result.code).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.agents[0].state).toBe('read')
    expect(report.agents[0].events.find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
  })


  it.each([
    ['a string', '5'],
    ['negative', -1],
    ['null', null]
  ])('does not call the documented command wired when its Claude timeout is %s', async (_label, timeout) => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'command', timeout, command: DOCUMENTED_CLAUDE }] }] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // Measured one entry at a time against a real tool call: with any of these timeouts the entry
    // does not run. An entry that cannot report must never read wired, however its command reads -
    // that is the same silent gap as an unrecognised command, arriving through a field.
    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing', unrecognised: [DOCUMENTED_CLAUDE] })
  })

  it('installs a working entry beside a dead one and leaves the dead one alone', async () => {
    const dead = { hooks: [{ type: 'command', timeout: '5', command: DOCUMENTED_CLAUDE }] }
    const path = await hookFileFixture({ hooks: { Stop: [dead] } })

    await runHooks(['install', '--yes', 'claude', '--file', path])
    const after = JSON.parse(await readFile(path, 'utf8'))
    const check = await runHooks(['check', 'claude', '--file', path, '--json'])

    // The event was missing, so `install` adds its own entry - and it removes and rewrites nothing,
    // so the entry that cannot run is still there, exactly as the owner wrote it.
    expect(after.hooks.Stop[0]).toEqual(dead)
    expect(after.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] })
    expect(JSON.parse(check.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
  })

  it('still calls the documented command wired when its Claude timeout is fractional', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 1.5, command: DOCUMENTED_CLAUDE }] }] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // Measured the same way: `1.5` runs. Refusing it would cost the owner a duplicate entry for a
    // hook that works, so the rule follows the measurement rather than tidiness.
    expect(JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
  })

  it.each([
    ['a group with no usable entry beside it', {
      Stop: [{ hooks: [{ type: 'command', command: 5 }] }]
    }],
    ['a malformed group before the one that is wired', {
      Stop: [{ hooks: 'echo hi' }, entryGroup(DOCUMENTED_CLAUDE)]
    }],
    ['a malformed entry before the one that is wired', {
      Stop: [{ hooks: [{ type: 'command', command: 5 }, { type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }]
    }]
  ])('reads a Claude file with %s without letting it decide the event', async (label, hooks) => {
    const path = await hookFileFixture({ hooks })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const report = JSON.parse(result.stdout).agents[0]
    const stop = report.events.find((row: { event: string }) => row.event === 'Stop')

    // Measured: a malformed group or entry does not stop what sits beside it from firing, in
    // either order. So the file reads, and `Stop` is wired exactly when something usable wires it
    // - not when a valid group happens to be scanned first.
    expect(report.state).toBe('read')
    expect(stop.state).toBe(label === 'a group with no usable entry beside it' ? 'missing' : 'wired')
  })

  it.each([
    ['claude', 'settings.json', CLAUDE_EVENTS, DOCUMENTED_CLAUDE, 'missing'],
    ['codex', 'hooks.json', CODEX_EVENTS, DOCUMENTED_CODEX, 'wired']
  ] as const)('reads a null matcher the way %s does', async (agent, file, events, documented, state) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(events.map((each) => [each, [entryGroup(documented)]])),
        PostToolUse: [{ matcher: null, hooks: [{ type: 'command', timeout: 5, command: documented }] }]
      }
    }, file)

    const result = await runHooks(['check', agent, '--file', path, '--json'])

    // Not the same answer for both, and not a matter of taste. Claude Code was run with a null
    // matcher against a real tool call and the hook did not fire, so it gates. Codex's matcher is
    // `Option<String>`, where null deserializes to absence, so it does not.
    expect(JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'PostToolUse').state).toBe(state)
  })

it('ends every Codex report with the limit of what it checked', async () => {
    const path = await codexFixture()

    const result = await runHooks(['check', 'codex', '--file', path])

    // `epics.md:787` already says what this command answers: configuration, not that a hook fired.
    // The limit is the same whatever the file holds, so it is printed unconditionally rather than
    // as a verdict BMN has no evidence for.
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('does not check that it will')
    expect(result.stdout).toContain('/hooks')
  })

  it.each([
    ['a top-level key of its own', { $schema: 'https://example.invalid/s.json' }],
    ['a hook type BMN knows nothing about', { beside: { hooks: [{ type: 'prompt' }] } }],
    ['an entry field BMN knows nothing about', { beside: { hooks: [{ type: 'command', command: 'true', async: true }] } }],
    ['a key no Codex event is named by', { hooks: { _comment: ['owner note'] } }],
    ['an entry with no type at all', { beside: { hooks: [{ command: 'true' }] } }]
  ])('reads a Codex file carrying %s without refusing it or doubting the entries', async (_label, extra) => {
    const path = await codexFixture(extra)

    const result = await runHooks(['check', 'codex', '--file', path, '--json'])
    const report = JSON.parse(result.stdout).agents[0]

    // BMN does not police Codex's schema. It was tried for five waves, in both directions, and
    // every rule rested on a citation no run here could check. The entries are what they are.
    expect(result.code).toBe(0)
    expect(report.state).toBe('read')
    expect(report.events.find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
  })

  it.each([
    ['wired', 'null', null],
    ['wired', 'zero', 0],
    ['wired', 'a plain number', 30],
    ['wired', 'the largest whole number a JSON number holds exactly', Number.MAX_SAFE_INTEGER],
    ['missing', 'a fraction, which u64 does not hold', 1.5],
    ['missing', 'negative', -1],
    ['missing', 'a string', '5'],
    ['missing', '2^53, past the largest exact whole number', 2 ** 53],
    ['missing', '1e30', 1e30]
  ])('reads %s for a Codex timeout of %s', async (state, _label, timeout) => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'command', timeout, command: DOCUMENTED_CODEX }] }] }
    }, 'hooks.json')

    const result = await runHooks(['check', 'codex', '--file', path, '--json'])

    // Story 38.4: `Option<u64>` seconds - null, absent, or a whole number up to
    // Number.MAX_SAFE_INTEGER; anything else keeps the entry from counting.
    expect(JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').state).toBe(state)
  })

  // Story 38.4: one plain reason, beside the verdict and as `reason` in JSON, only when one of BMN's
  // own Codex entries was kept from counting by its timeout. The 2^53 qualification is gone.
  const NOT_WHOLE_SECONDS = 'timeout is not a whole number of seconds'

  it.each([
    ['a string', '5'],
    ['2^53', 2 ** 53]
  ])('names the reason when one of BMN\'s own Codex entries has a timeout of %s', async (_label, timeout) => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'command', timeout, command: DOCUMENTED_CODEX }] }] }
    }, 'hooks.json')

    const plain = await runHooks(['check', 'codex', '--file', path])
    const json = await runHooks(['check', 'codex', '--file', path, '--json'])

    expect(plain.stdout).toContain(`  Stop               missing  ${NOT_WHOLE_SECONDS}\n`)
    const stop = JSON.parse(json.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop')
    expect(stop.reason).toBe(NOT_WHOLE_SECONDS)
    expect(stop).not.toHaveProperty('timeoutQualification')
  })

  it('prints a wired Codex verdict with nothing beside it, whatever valid timeout it has', async () => {
    for (const timeout of [undefined, null, 5, Number.MAX_SAFE_INTEGER]) {
      const entry: Record<string, unknown> = { type: 'command', command: DOCUMENTED_CODEX }
      if (timeout !== undefined) entry.timeout = timeout
      const path = await hookFileFixture({ hooks: { Stop: [{ hooks: [entry] }] } }, 'hooks.json')

      const plain = await runHooks(['check', 'codex', '--file', path])
      const json = await runHooks(['check', 'codex', '--file', path, '--json'])

      expect(plain.stdout).toContain('  Stop               wired\n')
      expect(JSON.parse(json.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
        .toEqual({ event: 'Stop', optional: false, state: 'wired' })
    }
  })

  it('a dead sibling the rule dropped does not give the wired verdict a reason', async () => {
    const path = await hookFileFixture({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', timeout: '5', command: DOCUMENTED_CODEX }] }, entryGroup(DOCUMENTED_CODEX)]
      }
    }, 'hooks.json')

    const json = await runHooks(['check', 'codex', '--file', path, '--json'])

    expect(JSON.parse(json.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'wired' })
  })

  it('keeps Claude reports free of the Codex reason', async () => {
    const path = await hookFileFixture({
      hooks: {
        Notification: [{ hooks: [{ type: 'command', timeout: 0, command: DOCUMENTED_CLAUDE }] }],
        Stop: [entryGroup(DOCUMENTED_CLAUDE)]
      }
    })

    const plain = await runHooks(['check', 'claude', '--file', path])
    const json = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(plain.stdout).not.toContain(NOT_WHOLE_SECONDS)
    for (const row of JSON.parse(json.stdout).agents[0].events) {
      expect(row.reason).toBeUndefined()
    }
  })

  it('does not call a Claude entry wired when its timeout is zero', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 0, command: DOCUMENTED_CLAUDE }] }] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // Measured against a real tool call, with a control that fired: an absent timeout ran, `1`
    // ran, `0` did not. It was carried as an assumption for two waves; now it is a measurement.
    expect(JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').state).toBe('missing')
  })

  it.each([
    ['a big integer past what a double holds', '18446744073709551615'],
    ['an integer the double holds but the writer shortens', '1000000000000000128'],
    ['the integer that passes a parsed-value comparison exactly', '1152921504606846976'],
    ['a decimal-form integer that loses its last digit', '9007199254740993.0'],
    ['an exponent past what a double holds, which the writer turns into null', '1e400'],
    ['a long decimal the writer shortens', '3.14159265358979323846']
  ])('will not install into a file holding %s', async (_label, token) => {
    const path = await hookFileFixture(`{ "keepMe": ${token}, "hooks": {} }`, 'hooks.json')
    const before = await readFile(path, 'utf8')

    const install = await runHooks(['install', '--yes', 'codex', '--file', path])

    // `install` reserializes the file, and `JSON.stringify` does not promise the digits it was
    // handed. Silently editing a number BMN was not asked to touch is worse than declining, so it
    // declines and names the number. Judging this by the shape of the token missed three of these.
    expect(install.code).toBe(1)
    expect(install.stderr).toContain(token)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it.each([
    ['a trailing zero', '1.0'],
    ['exponent form', '1e3'],
    ['the largest integer a double holds exactly', '9007199254740991'],
    ['minus zero', '-0']
  ])('installs normally into a file whose number is only respelled: %s', async (_label, token) => {
    const path = await hookFileFixture(`{ "keepMe": ${token}, "hooks": {} }`, 'hooks.json')

    const install = await runHooks(['install', '--yes', 'codex', '--file', path])
    const after = JSON.parse(await readFile(path, 'utf8'))

    // `1.0` comes back as `1` and `1e3` as `1000`: the same numbers, written differently. That is
    // not a reason to refuse an install.
    expect(install.code).toBe(0)
    // `-0` is written as `0`; `Object.is` tells them apart while JSON does not, and the number the
    // file denotes is the same either way.
    expect(after.keepMe).toBe(JSON.parse(token) === 0 ? 0 : JSON.parse(token))
    expect(after.hooks.Stop).toHaveLength(1)
  })

  it('does nothing, successfully, for a wired file holding a number it could not write back', async () => {
    const path = await hookFileFixture(
      `{ "keepMe": 1e400, "hooks": ${JSON.stringify(Object.fromEntries(
        CODEX_EVENTS.map((each) => [each, [{ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CODEX }] }]])
      ))} }`,
      'hooks.json'
    )
    const before = await readFile(path, 'utf8')

    const install = await runHooks(['install', '--yes', 'codex', '--file', path])

    // `epics.md:786` gives an already-wired file a successful no-op. The number matters only to a
    // write, and there is no write, so refusing here would fail an install that had nothing to do.
    expect(install.code).toBe(0)
    expect(install.stdout).toContain('Nothing to do')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('leaves an unrecognised entry exactly as it was when install adds its own beside it', async () => {
    const written = 'timeout 5 bmn hook claude'
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(written)] } })

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const after = JSON.parse(await readFile(path, 'utf8'))

    expect(install.code).toBe(0)
    expect(after.hooks.Stop[0].hooks[0].command).toBe(written)
    expect(after.hooks.Stop.at(-1).hooks[0].command).toBe(DOCUMENTED_CLAUDE)
    const check = JSON.parse((await runHooks(['check', 'claude', '--file', path, '--json'])).stdout)
    expect(check.agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'wired' })
  })

  it('runs the hook, in a real shell, for every command it accepts', async () => {
    // The only claim `check` makes is about the commands it recognises, so that is what is checked
    // against ground truth: each is run by a real bash with a stub `bmn` on PATH holding the real
    // binary's contract - exactly one agent argument, and the event on standard input - and must be
    // seen to report. Nothing else is ever called wired, so nothing else can be wrong in the
    // direction that matters; a command BMN declines to read costs a duplicate entry, never a gap.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const ran = join(root, 'ran')
    await writeFile(
      join(bin, 'bmn'),
      ['#!/bin/sh', '[ "$#" -eq 2 ] || exit 0', '[ "$1" = hook ] && [ "$2" = claude ] || exit 0',
        'event=$(cat)', 'case "$event" in', '  \'{\'*) ;;', '  *) exit 0 ;;', 'esac',
        `echo yes >> ${shellQuote(shellPath(ran))}`, 'exit 0', ''].join('\n'),
      { mode: 0o755 }
    )
    const EVENT = '{"hook_event_name":"Stop"}'

    const problems: string[] = []
    // Every string `check` accepts: the three commands, under every combination of the blanks bash
    // drops. Generated rather than listed, so the set cannot fall behind the rule it is checking -
    // a hand-written list is how the wave-7 blocker got past this test.
    const BLANKS = ['', ' ', '\t', '\n', ' \t\n']
    const accepted = [DOCUMENTED_CLAUDE, OLDER_CLAUDE, 'bmn hook claude'].flatMap((command) =>
      BLANKS.flatMap((before) => BLANKS.map((after) => `${before}${command}${after}`))
    )
    for (const command of accepted) {
      await rm(ran, { force: true })
      const failure = await new Promise<string | null>((resolve) => {
        const child = execFile(fixtureShell('bash'), ['-c', `${command}\nwait`], {
          env: { PATH: fixtureSearchPath([bin], process.env.PATH ?? ''), BMN_CONTROL_SOCKET: '/x', AITERM_CONTROL_SOCKET: '/x' },
          cwd: root, timeout: 10_000
        }, (error) => {
          if (error === null) return resolve(null)
          const failure = error as { killed?: boolean; code?: number | string }
          if (failure.killed === true) return resolve('the runner timed out')
          // A command exiting non-zero is ordinary; a string `code` is the runner failing to start.
          return resolve(typeof failure.code === 'string' ? `the runner failed (${failure.code})` : null)
        })
        // The harness hands the entry its event on standard input, and nowhere else.
        child.stdin?.end(EVENT)
      })
      if (failure !== null) {
        problems.push(`${failure} on: ${command}`)
        continue
      }
      if (!existsSync(ran)) problems.push(`called wired but the shell never ran it: ${command}`)

      const path = await hookFileFixture({ hooks: { Stop: [entryGroup(command)] } })
      const report = JSON.parse((await runHooks(['check', 'claude', '--file', path, '--json'])).stdout)
      const state = report.agents[0].events.find((row: { event: string }) => row.event === 'Stop').state
      if (state === 'missing') problems.push(`a command BMN answers for went unrecognised: ${command}`)
    }

    expect(problems).toEqual([])
  }, 300_000)

  it('recognises exactly what install writes, for every agent and every event', async () => {
    // The two commands have to agree about the same string, or `install` writes an entry its own
    // `check` will not accept and the pair loops forever.
    for (const [agent, file] of [['claude', 'settings.json'], ['codex', 'hooks.json']] as const) {
      const path = await hookFileFixture({}, file)

      expect((await runHooks(['install', '--yes', agent, '--file', path])).code).toBe(0)
      const check = await runHooks(['check', agent, '--file', path, '--json'])

      expect(check.code).toBe(0)
      const report = JSON.parse(check.stdout).agents[0]
      const required = report.events.filter((row: { optional: boolean }) => !row.optional)
      expect(required.length).toBeGreaterThan(0)
      expect(required.map((row: { state: string }) => row.state))
        .toEqual(required.map(() => 'wired'))
      // The optional one is never installed and never fails the check, so the pair still settles.
      expect(report.events.filter((row: { optional: boolean }) => row.optional)
        .map((row: { state: string }) => row.state).every((state: string) => state === 'missing'))
        .toBe(true)
      expect(report.missing).toEqual([])
    }
  })

  it('ignores an entry that names bmn but is not a command entry', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [{ hooks: [{ type: 'notify', command: DOCUMENTED_CLAUDE }] }] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toMatchObject({ state: 'missing' })
  })

  it('reads both harnesses at the paths they actually read, with no agent named', async () => {
    const home = await cliFixture()
    const codexHome = join(home.root, 'moved-codex')
    await mkdir(join(home.root, '.claude'), { recursive: true })
    await writeFile(
      join(home.root, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: { Stop: [entryGroup(DOCUMENTED_CLAUDE)] } }, null, 2)}\n`
    )

    const result = await runHooks(['check', '--json'], { HOME: home.root, CODEX_HOME: codexHome })

    // Both agents, each at its own default path, and the moved Codex directory is the one consulted.
    const report = JSON.parse(result.stdout)
    expect(report.agents.map((agent: { agent: string }) => agent.agent)).toEqual(['claude', 'codex', 'opencode', 'cursor'])
    expect(normalize(report.agents[0].file)).toBe(join(home.root, '.claude', 'settings.json'))
    expect(normalize(report.agents[1].file)).toBe(join(codexHome, 'hooks.json'))
    expect(report.agents[0].events.find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
    expect(report.agents[1].events.every((row: { state: string }) => row.state === 'missing')).toBe(true)
    expect(result.code).toBe(1)
  })

  it('installs into the harness own file when no --file says otherwise', async () => {
    const home = await cliFixture()
    const codexHome = join(home.root, 'moved-codex')
    const env = { HOME: home.root, CODEX_HOME: codexHome }

    const install = await runHooks(['install', '--yes', 'codex', '--json'], env)
    const check = await runHooks(['check', 'codex'], env)

    expect(install.code).toBe(0)
    expect(normalize(JSON.parse(install.stdout).file)).toBe(join(codexHome, 'hooks.json'))
    expect(Object.keys(JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8')).hooks))
      .toEqual(expect.arrayContaining(CODEX_EVENTS))
    expect(check.code).toBe(0)
    // Nothing was read or written outside the temporary home (AC5).
    expect(install.stdout).not.toContain(homedir())
  })

  it('refuses to install without an agent rather than writing two files at once', async () => {
    const home = await cliFixture()

    const install = await runHooks(['install'], { HOME: home.root })

    expect(install.code).toBe(2)
    expect(install.stderr).toContain('hooks install expects one agent')
    expect(await readdir(home.root)).not.toContain('.claude')
  })

  it('refuses an unknown agent and --file without one', async () => {
    const unknown = await runHooks(['check', 'gemini'])
    const ambiguous = await runHooks(['check', '--file', '/tmp/nothing.json'])

    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('claude|codex')
    expect(ambiguous.code).toBe(2)
    expect(ambiguous.stderr).toContain('--file needs the agent')
  })
})

describe('bmn hooks install', () => {
  it('allows piped stdout when stdin and stderr are TTYs, and rejects piped stdin or stderr', async () => {
    const path = await hookFileFixture({}, 'hooks.json')
    const accepted = ttyHooks(['install', 'codex', '--file', path], 'stdout')
    await accepted.waitFor('Install these hooks? [y/N] ')
    accepted.write('yes\r')
    expect(await accepted.finish, accepted.output()).toBe(0)
    expect((await runHooks(['check', 'codex', '--file', path])).code).toBe(0)

    const other = await hookFileFixture({}, 'hooks.json')
    const denied = ttyHooks(['install', 'codex', '--file', other], 'stderr')
    expect(await denied.finish).toBe(2)
    expect(denied.output()).toContain('CONFIRMATION_REQUIRED')
    expect(await backupsOf(other)).toEqual([])

    const third = await hookFileFixture({}, 'hooks.json')
    const deniedStdin = ttyHooks(['install', 'codex', '--file', third], 'stdin')
    expect(await deniedStdin.finish).toBe(2)
    expect(deniedStdin.output()).toContain('CONFIRMATION_REQUIRED')
    expect(await backupsOf(third)).toEqual([])
  })
  it('accepts an interactive Yes and refuses No or EOF without a backup', async () => {
    for (const answer of ['yes\r', 'n\r', '\u0004']) {
      const path = await hookFileFixture({}, 'hooks.json')
      const before = await readFile(path, 'utf8')
      const tty = ttyHooks(['install', 'codex', '--file', path])
      await tty.waitFor('Install these hooks? [y/N] ')
      expect(await readFile(path, 'utf8')).toBe(before)
      tty.write(answer)
      expect(await tty.finish, tty.output()).toBe(answer === 'yes\r' ? 0 : 1)
      if (answer === 'yes\r') {
        expect((await runHooks(['check', 'codex', '--file', path])).code).toBe(0)
        expect((await backupsOf(path)).length).toBe(1)
      } else {
        expect(await readFile(path, 'utf8')).toBe(before)
        expect(await backupsOf(path)).toEqual([])
      }
    }
  })

  it('treats Ctrl-C at the prompt as refusal without creating a backup', async () => {
    const path = await hookFileFixture({}, 'hooks.json')
    const before = await readFile(path, 'utf8')
    const tty = ttyHooks(['install', 'codex', '--file', path])
    await tty.waitFor('Install these hooks? [y/N] ')
    tty.write('\u0003')
    expect(await tty.finish).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it('rejects --json on a TTY without --yes and rejects --yes on read-only hooks commands', async () => {
    const path = await hookFileFixture({}, 'hooks.json')
    const tty = ttyHooks(['install', 'claude', '--file', path, '--json'])
    expect(await tty.finish).toBe(2)
    expect(tty.output()).toContain('CONFIRMATION_REQUIRED')
    expect(tty.output()).not.toContain('Install these hooks?')
    expect(await backupsOf(path)).toEqual([])
    for (const args of [['check', 'claude', '--file', path, '--yes'], ['print', 'opencode', '--yes']]) {
      const refused = await runHooks(args)
      expect(refused.code).toBe(2)
      expect(refused.stdout).toBe('')
    }
  })

  it('rejects changed bytes and a symlink retarget during an interactive prompt', async () => {
    const path = await hookFileFixture({}, 'hooks.json')
    const original = await readFile(path, 'utf8')
    const changing = ttyHooks(['install', 'codex', '--file', path])
    await changing.waitFor('Install these hooks? [y/N] ')
    await writeFile(path, '{"owner":"changed"}\n')
    changing.write('yes\r')
    expect(await changing.finish).toBe(1)
    expect(changing.output()).toContain('changed while bmn was reading it')
    expect(await readFile(path, 'utf8')).toBe('{"owner":"changed"}\n')
    expect(await backupsOf(path)).toEqual([])

    const first = await hookFileFixture(original, 'first.json')
    const second = join(dirname(first), 'second.json')
    const link = join(dirname(first), 'alias.json')
    await writeFile(second, original)
    await symlink(first, link)
    const retargeting = ttyHooks(['install', 'codex', '--file', link])
    await retargeting.waitFor('Install these hooks? [y/N] ')
    await rm(link)
    await symlink(second, link)
    retargeting.write('yes\r')
    expect(await retargeting.finish).toBe(1)
    expect(retargeting.output()).toContain('changed target while bmn was reading it')
    expect(await readFile(first, 'utf8')).toBe(original)
    expect(await readFile(second, 'utf8')).toBe(original)
    expect(await backupsOf(link)).toEqual([])
  })

  it('shows the full OpenCode replacement and refuses a retargeted plugin link', async () => {
    const first = await hookFileFixture('// existing plugin\n', 'first.ts')
    const second = join(dirname(first), 'second.ts')
    const link = join(dirname(first), 'bmn.ts')
    await writeFile(second, '// existing plugin\n')
    await symlink(first, link)
    const tty = ttyHooks(['install', 'opencode', '--file', link])
    await tty.waitFor('Install these hooks? [y/N] ')
    expect(tty.output()).toContain('Proposed full file:')
    expect(tty.output()).toContain('export const BMNPlugin: Plugin')
    await rm(link)
    await symlink(second, link)
    tty.write('yes\r')
    expect(await tty.finish).toBe(1)
    expect(tty.output()).toContain('REVISION_CONFLICT')
    expect(await readFile(first, 'utf8')).toBe('// existing plugin\n')
    expect(await readFile(second, 'utf8')).toBe('// existing plugin\n')
    expect(await backupsOf(link)).toEqual([])
  })
  it.each(['claude', 'codex', 'opencode', 'cursor'])('requires explicit approval before a non-interactive %s write', async (agent) => {
    const path = await hookFileFixture(agent === 'opencode' ? '// older plugin\n' : {}, agent === 'claude' ? 'settings.json' : 'hooks.json')
    const before = await readFile(path, 'utf8')
    for (const args of [['install', agent, '--file', path], ['install', agent, '--file', path, '--json']]) {
      const denied = await runHooks(args)
      expect(denied).toMatchObject({ code: 2, stdout: '' })
      expect(denied.stderr).toContain('CONFIRMATION_REQUIRED')
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(await backupsOf(path)).toEqual([])
    }
    const installed = await runHooks(['install', agent, '--file', path, '--json', '--yes'])
    expect(installed.code).toBe(0)
    expect(JSON.parse(installed.stdout).installed.length).toBeGreaterThan(0)
  })

  it('shows the proposed diff before a real terminal answer and defaults to No', async () => {
    const path = await hookFileFixture({}, 'hooks.json')
    const before = await readFile(path, 'utf8')
    const child = spawnPty(process.execPath, [CLI, 'hooks', 'install', 'codex', '--file', path], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
      env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec'].flatMap(key => {
        const value = windowsEnvironmentValue(process.env, key)
        return process.platform === 'win32' && value ? [[key, value]] : []
      })), PATH: process.env.PATH ?? '', HOME: dirname(path),
      ...(process.platform === 'win32' ? { USERPROFILE: dirname(path) } : {}) },
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {})
    })
    let output = ''
    const finished = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Hook preview timed out: ${output}`)), 5000)
      child.onData((part) => {
        output += part
        if (output.includes('Install these hooks? [y/N] ')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    expect(output).toContain(`Hook file: ${path}`)
    expect(output).toContain(`Resolved target: ${path}`)
    expect(output).toContain('Entries to add or replace:')
    expect(output).toContain('Proposed diff:')
    expect(output.indexOf('Proposed diff:')).toBeLessThan(output.indexOf('Install these hooks?'))
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
    child.write('\r')
    expect(await finished).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })
  it('adds only the missing entries, keeps foreign hooks byte for byte and leaves an older wording alone', async () => {
    const foreign = entryGroup('echo foreign', 9)
    const path = await hookFileFixture({
      theme: 'dark',
      hooks: { PostToolUse: [{ matcher: 'Write', ...(foreign as object) }], Stop: [entryGroup(OLDER_CLAUDE)] }
    })
    const before = JSON.parse(await readFile(path, 'utf8'))

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const after = JSON.parse(await readFile(path, 'utf8'))

    expect(install.code).toBe(0)
    expect(after.theme).toBe('dark')
    // The foreign entry and the older-wording entry are exactly what they were.
    expect(after.hooks.PostToolUse[0]).toEqual(before.hooks.PostToolUse[0])
    expect(after.hooks.Stop).toEqual(before.hooks.Stop)
    expect(after.hooks.PostToolUse[1]).toEqual({ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] })
    for (const event of ['Notification', 'PermissionRequest', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']) {
      expect(after.hooks[event]).toEqual([{ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }])
    }
    // PreToolUse blocks every tool until it returns, so BMN's entry is gated to the one tool it needs.
    expect(after.hooks.PreToolUse).toEqual([
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }
    ])
    expect(install.stdout).toContain(
      'Notification, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd'
    )
    expect(install.stdout.split('\n').filter((line) => /^-[^-]/.test(line))).toEqual([])
  })

  it('keeps the bytes the owner wrote: their indent, their key order and their awkward values', async () => {
    // Written by hand rather than serialized, so the assertions cannot pass by both sides using the
    // same writer. Four-space indent, keys in an order no writer would choose, and a value with a
    // tab, an escaped quote and a non-ASCII letter in it.
    const original = [
      '{',
      '    "zzz_written_last": "kept",',
      '    "hooks": {',
      '        "Stop": [',
      '            {',
      '                "note": "a\\ttab, a \\"quote\\", a caf\u00e9",',
      '                "hooks": [',
      '                    {',
      '                        "type": "command",',
      `                        "command": ${JSON.stringify(OLDER_CLAUDE)}`,
      '                    }',
      '                ]',
      '            }',
      '        ]',
      '    },',
      '    "theme": "dark"',
      '}',
      ''
    ].join('\n')
    const path = await hookFileFixture(original)

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const after = await readFile(path, 'utf8')

    expect(install.code).toBe(0)
    // Every line of the original is still there, spelling and indent included.
    for (const line of original.split('\n').filter((line) => line.trim().length > 0 && line !== '}')) {
      expect(after).toContain(line)
    }
    // The owner's indent is what the added entries are written with, not BMN's own.
    expect(after).toContain('    "Notification": [')
    // Their key order is untouched: what they wrote last is still last.
    expect(after.indexOf('"zzz_written_last"')).toBeLessThan(after.indexOf('"theme"'))
    expect(JSON.parse(after).hooks.Stop).toHaveLength(1)
  })

  it.each([
    ['a hooks value that is not an object', { hooks: 'KEEP' }, '"hooks" is not an object'],
    ['an event that is not a list', { hooks: { Stop: { foreign: 'KEEP' } } }, '"hooks.Stop" is not a list']
  ])('refuses to install into a file with %s, and leaves it untouched', async (_label, contents, reason) => {
    const path = await hookFileFixture(contents)
    const before = await readFile(path, 'utf8')

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const check = await runHooks(['check', 'claude', '--file', path])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain(reason)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
    // The check says why rather than claiming every event is simply missing.
    expect(check.code).toBe(1)
    expect(check.stdout).toContain(reason)
  })

  it('updates the file a symlink points at, keeps the link and keeps the file mode', async () => {
    const real = await hookFileFixture({ hooks: {} }, 'real-settings.json')
    const link = join(dirname(real), 'settings.json')
    await chmod(real, 0o640)
    const originalMode = (await stat(real)).mode & 0o777
    await symlink(real, link)

    const install = await runHooks(['install', '--yes', 'claude', '--file', link])

    expect(install.code).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(real, 'utf8')).hooks)).toEqual(CLAUDE_EVENTS)
    expect((await stat(real)).mode & 0o777).toBe(originalMode)
  })

  it('writes through a symlinked parent to the file the kernel would, not one of the same name', async () => {
    // alias -> real/nested, and real/nested/settings.json -> ../target.json. The kernel lands on
    // real/target.json; resolving the written path lexically would land on target.json beside alias
    // and overwrite whatever is there.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await mkdir(join(root, 'real', 'nested'), { recursive: true })
    await symlink(join('real', 'nested'), join(root, 'alias'), 'dir')
    await symlink(join('..', 'target.json'), join(root, 'real', 'nested', 'settings.json'))
    await writeFile(join(root, 'target.json'), 'SENTINEL: nothing to do with any harness\n')
    await writeFile(join(root, 'real', 'target.json'), '{"real":"target"}\n')
    ownWindowsFixtureFile(root, join(root, 'real', 'target.json'))

    let nativeDiagnostic: unknown
    if (process.platform === 'win32') {
      const probeRoot = join(root, 'native-write-probe')
      const helper = new URL('../../bin/safe-config-write.mjs', import.meta.url).href
      const ownerHelper = new URL('./windows-fixture-owner.test-support.ts', import.meta.url).href
      const script = `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {linkTarget,writeConfigSafely} from ${JSON.stringify(helper)};
import {ownWindowsFixtureFile} from ${JSON.stringify(ownerHelper)};
const root=process.argv[1],report={stage:'prepare',status:'UNVERIFIED'};
try {
 mkdirSync(join(root,'real','nested'),{recursive:true});
 symlinkSync(join('real','nested'),join(root,'alias'),'dir');
 symlinkSync(join('..','target.json'),join(root,'real','nested','settings.json'));
 writeFileSync(join(root,'target.json'),'synthetic unrelated sentinel');
 const expected='{"real":"target"}\\n',target=join(root,'real','target.json');writeFileSync(target,expected);
 const selected=join(root,'alias','settings.json');
 report.resolutionEqual=linkTarget(selected)===realpathSync.native(target);
 const ownerSource="$ErrorActionPreference='Stop';Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));$PSModuleAutoLoadingPreference='None';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$p=ConvertFrom-Json ([Console]::In.ReadToEnd());$owner=[IO.File]::GetAccessControl($p).GetOwner([Security.Principal.SecurityIdentifier]).Value;$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[Console]::Out.Write((ConvertTo-Json -Compress @{ownerMatchesUser=($owner -eq $user)}))";
 const owner=spawnSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ownerSource,'utf16le').toString('base64')],{input:JSON.stringify(target),encoding:'utf8',timeout:15000,windowsHide:true});
 assert.ok(!owner.error&&owner.status===0,'Fresh target owner query must complete');
 report.originalOwnerMatchesUser=JSON.parse(owner.stdout).ownerMatchesUser;
 if(!report.originalOwnerMatchesUser){
  report.stage='original-owner-refusal';let refusal;
  try{writeConfigSafely(selected,expected,'{"real":"target","syntheticProbe":true}\\n')}catch(error){refusal=error}
  assert.ok(refusal&&refusal.nativeOperation==='prepare:original-owner'&&refusal.created===false&&refusal.recoveryRequired===false,'Original owner guard must refuse before staging');
  assert.equal(readFileSync(target,'utf8'),expected);report.originalOwnerRefused=true;
 }else{report.originalOwnerControl='not-applicable-already-current-owner'}
 assert.equal(readFileSync(join(root,'target.json'),'utf8'),'synthetic unrelated sentinel','Original refusal cannot change sentinel');
 report.stage='fresh-target-owner-setup';ownWindowsFixtureFile(root,target);
 assert.equal(readFileSync(target,'utf8'),expected,'Ownership setup cannot change bytes');
 report.stage='write-config-safely';writeConfigSafely(selected,expected,'{"real":"target","syntheticProbe":true}\\n');
 assert.equal(JSON.parse(readFileSync(target,'utf8')).syntheticProbe,true);
 report.afterOwnershipSuccess=true;
 report.status='PASS';
} catch(error) {
 report.status='REFUSED';
 for(const key of ['code','nativeOperation','nativeErrorCode','nativeExceptionType','nativeErrorIdentifier','nativeLaunchError','recoveryRequired','created']) {
  if(['string','number','boolean'].includes(typeof error[key])) report[key]=error[key];
 }
}
report.sentinelPreserved=existsSync(join(root,'target.json'))&&readFileSync(join(root,'target.json'),'utf8')==='synthetic unrelated sentinel';
console.log(JSON.stringify(report));`
      const probe = await runCommand(process.execPath, ['--input-type=module', '-e', script, probeRoot])
      try { nativeDiagnostic = { exit: probe.code, ...JSON.parse(probe.stdout) } }
      catch { nativeDiagnostic = { exit: probe.code, malformedReceipt: true, stderrBytes: Buffer.byteLength(probe.stderr) } }
    }
    const install = await runHooks(['install', '--yes', 'claude', '--file', join(root, 'alias', 'settings.json')])

    expect(install.code, JSON.stringify({ stderr: install.stderr, nativeDiagnostic })).toBe(0)
    if (process.platform === 'win32') expect(nativeDiagnostic).toMatchObject({ exit: 0, status: 'PASS',
      resolutionEqual: true, afterOwnershipSuccess: true, sentinelPreserved: true })
    expect(await readFile(join(root, 'target.json'), 'utf8')).toBe('SENTINEL: nothing to do with any harness\n')
    const written = JSON.parse(await readFile(join(root, 'real', 'target.json'), 'utf8'))
    expect(written.real).toBe('target')
    expect(Object.keys(written.hooks)).toEqual(CLAUDE_EVENTS)
  })

  it('steps back from where a link landed, not from where it was written', async () => {
    // branch -> real/nested, and the link says branch/../target.json. The kernel resolves branch
    // first, so `..` lands in real/; collapsing it as text lands beside the link instead, on a file
    // that has nothing to do with any harness. Node's own realpathSync collapses it as text.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await mkdir(join(root, 'real', 'nested'), { recursive: true })
    await symlink(join('real', 'nested'), join(root, 'branch'), 'dir')
    await symlink('branch/../target.json', join(root, 'settings.json'))
    await writeFile(join(root, 'target.json'), 'SENTINEL: nothing to do with any harness\n')
    await writeFile(join(root, 'real', 'target.json'), '{"real":true}\n')

    const install = await runHooks(['install', '--yes', 'claude', '--file', join(root, 'settings.json')])

    if (process.platform === 'win32') {
      expect(install.code).toBe(1)
      expect(await readFile(join(root, 'target.json'), 'utf8')).toBe('SENTINEL: nothing to do with any harness\n')
      expect(await readFile(join(root, 'real', 'target.json'), 'utf8')).toBe('{"real":true}\n')
      return
    }
    expect(install.code).toBe(0)
    expect(await readFile(join(root, 'target.json'), 'utf8')).toBe('SENTINEL: nothing to do with any harness\n')
    const written = JSON.parse(await readFile(join(root, 'real', 'target.json'), 'utf8'))
    expect(written.real).toBe(true)
    expect(Object.keys(written.hooks)).toEqual(CLAUDE_EVENTS)
  })

  it('refuses a link that steps back through a directory that is not there', async () => {
    // Where `..` lands depends on what the missing component would have been, so there is no answer
    // to give and guessing one would write somewhere arbitrary.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await symlink('missing/../target.json', join(root, 'settings.json'))
    await writeFile(join(root, 'target.json'), 'SENTINEL\n')

    const install = await runHooks(['install', '--yes', 'claude', '--file', join(root, 'settings.json')])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain(process.platform === 'win32' ? 'not valid JSON' : 'which does not exist; resolve it by hand')
    expect(await readFile(join(root, 'target.json'), 'utf8')).toBe('SENTINEL\n')
    expect(await backupsOf(join(root, 'settings.json'))).toEqual([])
  })

  it('resolves a .. in the path it was given against where the link landed, not where it was written', async () => {
    // The third shape of the same defect: the earlier two were `..` inside a link's target, this is
    // `..` in the path handed to BMN. Collapsing it as text before reading the link lands beside the
    // link instead of inside what it points at, and overwrites whatever is there.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await mkdir(join(root, 'cfg', 'claude'), { recursive: true })
    await writeFile(join(root, 'cfg', 'settings.json'), '{"hooks":{}}\n')
    await writeFile(join(root, 'settings.json'), 'SENTINEL\n')
    await symlink(join(root, 'cfg', 'claude'), join(root, 'x'), 'dir')

    const install = await runHooks(['install', '--yes', 'claude', '--file', `${join(root, 'x')}/../settings.json`])

    if (process.platform === 'win32') {
      expect(install.code).toBe(1)
      expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
      expect(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).toBe('{"hooks":{}}\n')
      return
    }
    expect(install.code).toBe(0)
    // The kernel reads `x/..` as `cfg`, so the hooks belong in cfg/settings.json...
    expect(Object.keys(JSON.parse(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).hooks))
      .toEqual(CLAUDE_EVENTS)
    // ...and the unrelated file beside the link is untouched, with no backup taken of it.
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
    expect(await backupsOf(join(root, 'settings.json'))).toEqual([])
  })

  it('reads a moved config directory that steps back through a symlink the same way', async () => {
    // `--file` is a test flag; `CLAUDE_CONFIG_DIR` is the owner's own, and it can hold a `..` too.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await mkdir(join(root, 'cfg', 'claude'), { recursive: true })
    await writeFile(join(root, 'cfg', 'settings.json'), '{"hooks":{}}\n')
    await writeFile(join(root, 'settings.json'), 'SENTINEL\n')
    await symlink(join(root, 'cfg', 'claude'), join(root, 'x'), 'dir')

    const install = await runHooks(['install', '--yes', 'claude'], { CLAUDE_CONFIG_DIR: `${join(root, 'x')}/..` })

    if (process.platform === 'win32') {
      expect(install.code).toBe(1)
      expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
      expect(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).toBe('{"hooks":{}}\n')
      return
    }
    expect(install.code).toBe(0)
    expect(Object.keys(JSON.parse(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).hooks))
      .toEqual(CLAUDE_EVENTS)
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
  })

  it('refuses a .. that steps back through a component of the given path that is not there', async () => {
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await writeFile(join(root, 'settings.json'), 'SENTINEL\n')

    const install = await runHooks(['install', '--yes', 'claude', '--file', `${join(root, 'none')}/../settings.json`])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain(process.platform === 'win32' ? 'not valid JSON' : 'which does not exist; resolve it by hand')
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
  })

  it('still creates a config directory that simply does not exist yet', async () => {
    // The refusal above must not catch the fresh machine, which is what install is for.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))

    const install = await runHooks(['install', '--yes', 'codex', '--file', join(root, 'fresh', 'hooks.json')])

    expect(install.code).toBe(0)
    expect(Object.keys(JSON.parse(await readFile(join(root, 'fresh', 'hooks.json'), 'utf8')).hooks))
      .toEqual(expect.arrayContaining(CODEX_EVENTS))
  })

  it('refuses a chain of symlinks too long to resolve rather than replacing one of them', async () => {
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await writeFile(join(root, 'final.json'), '{}\n')
    let previous = join(root, 'final.json')
    for (let step = 1; step <= 12; step += 1) {
      await symlink(previous, join(root, `l${step}.json`))
      previous = join(root, `l${step}.json`)
    }

    const install = await runHooks(['install', '--yes', 'claude', '--file', join(root, 'l12.json')])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('passes through more than 10 symlinks')
    // Every link in the chain is still a link, and the file at the end is untouched.
    expect((await lstat(join(root, 'l10.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(root, 'final.json'), 'utf8')).toBe('{}\n')
  })

  it('follows a symlink whose target does not exist yet instead of replacing the link', async () => {
    // A dotfiles repository often links a settings file it has not written yet.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    const real = join(root, 'later.json')
    const link = join(root, 'settings.json')
    await symlink(real, link)

    const install = await runHooks(['install', '--yes', 'claude', '--file', link])

    expect(install.code).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(real, 'utf8')).hooks)).toEqual(CLAUDE_EVENTS)
  })

  it('refuses rather than overwriting a file another writer changed while it was reading', async () => {
    const path = await hookFileFixture({ hooks: {} })

    // A handshake, not a race: the installer says when it is between its read and its rename, the
    // other writer goes then, and only then is the installer let go.
    const gate = join(dirname(path), 'gate')
    const installing = runHooks(['install', '--yes', 'claude', '--file', path], { BMN_HOOKS_TEST_GATE: gate })
    const deadline = Date.now() + 10_000
    while (!existsSync(`${gate}.waiting`)) {
      if (Date.now() > deadline) throw new Error('the installer never reached its check')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await writeFile(path, `${JSON.stringify({ hooks: {}, other: 'ADDED BY SOMEBODY ELSE' }, null, 2)}\n`)
    await writeFile(gate, '')
    const install = await installing

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('changed while bmn was reading it')
    expect(JSON.parse(await readFile(path, 'utf8')).other).toBe('ADDED BY SOMEBODY ELSE')
    expect(await backupsOf(path)).toEqual([])
    expect((await readdir(dirname(path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('writes a backup first and prints its path with a unified diff of what it added', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(DOCUMENTED_CLAUDE)] } })
    const original = await readFile(path, 'utf8')

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const [backup, ...extra] = await backupsOf(path)

    expect(install.code).toBe(0)
    expect(extra).toEqual([])
    expect(backup).toBeDefined()
    expect(await readFile(join(dirname(path), backup ?? ''), 'utf8')).toBe(original)
    expect(install.stdout).toContain(`Backup: ${path}.bmn-backup-`)
    // The atomic write renames a temp file in the same folder; none of them is left behind.
    expect((await readdir(dirname(path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    expect(install.stdout).toContain(`--- ${path}`)
    expect(install.stdout).toContain(`+++ ${path}`)
    expect(install.stdout).toMatch(/^\+.*bmn hook claude/m)
    // A diff that only adds never prints a removed line.
    expect(install.stdout.split('\n').filter((line) => /^-[^-]/.test(line))).toEqual([])
  })

  it('creates a missing file with only the hooks object and no backup', async () => {
    const path = await hookFileFixture()

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])
    const written = JSON.parse(await readFile(path, 'utf8'))

    expect(install.code).toBe(0)
    expect(Object.keys(written)).toEqual(['hooks'])
    expect(Object.keys(written.hooks)).toEqual(CLAUDE_EVENTS)
    expect(await backupsOf(path)).toEqual([])
  })

  it('installs nothing when nothing is missing and says so', async () => {
    const path = await hookFileFixture({
      hooks: Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [entryGroup(DOCUMENTED_CLAUDE)]]))
    })
    const before = await readFile(path, 'utf8')

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])

    expect(install.code).toBe(0)
    expect(install.stdout).toContain('Nothing to do')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it('leaves an unparsable file untouched, writes no backup and exits 1', async () => {
    const broken = '{ "hooks": { "Stop": [ }'
    const path = await hookFileFixture(broken)

    const install = await runHooks(['install', '--yes', 'claude', '--file', path])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('not valid JSON')
    expect(await readFile(path, 'utf8')).toBe(broken)
    expect(await backupsOf(path)).toEqual([])
  })

  it('tells the owner about the Codex trust step, and only for Codex', async () => {
    const codexPath = await hookFileFixture({}, 'hooks.json')
    const claudePath = await hookFileFixture({})

    const codex = await runHooks(['install', '--yes', 'codex', '--file', codexPath])
    const claude = await runHooks(['install', '--yes', 'claude', '--file', claudePath])

    // The whole sentence, not just "/hooks": the fixture's own path ends in hooks.json.
    expect(codex.stdout).toContain('Codex must trust the hooks once: run /hooks in Codex.')
    expect(codex.stdout).toContain('reports configuration, not that a hook fired')
    expect(claude.stdout).not.toContain('trust the hooks once')
    // Install writes the required events only; PermissionRequest stays the owner's own choice.
    expect(Object.keys(JSON.parse(await readFile(codexPath, 'utf8')).hooks)).toEqual(CODEX_EVENTS)
  })

  it('leaves check reporting everything wired afterwards', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(OLDER_CLAUDE)] } })

    await runHooks(['install', '--yes', 'claude', '--file', path])
    const check = await runHooks(['check', 'claude', '--file', path])

    expect(check.code).toBe(0)
    expect(check.stdout).toContain('Every hook BMN expects is wired')
  })

  it('refuses install without an agent', async () => {
    const result = await runHooks(['install'])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('hooks install expects one agent')
  })
})

describe('the hook event lists check and hook share', () => {
  it('drives bmn hook with every event check expects, and each one reaches the app', async () => {
    const fixture = await cliFixture()
    const payloads: Record<string, unknown> = {
      Notification: { notification_type: 'permission_prompt', message: 'needs permission' },
      PreToolUse: { tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which?' }] } },
      PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      PostToolUse: { tool_name: 'Bash', tool_input: {} },
      PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' },
      UserPromptSubmit: {},
      Stop: {},
      SessionStart: { source: 'startup', session_id: OBSERVED_REFERENCE },
      SessionEnd: {},
      Interrupt: {}
    }

    for (const agent of ['claude', 'codex'] as const) {
      // The list comes from `hooks check` itself, so the fence breaks if either side drifts.
      const path = await hookFileFixture({})
      const reported = JSON.parse((await runHooks(['check', agent, '--file', path, '--json'])).stdout)
      const events: string[] = reported.agents[0].events
        .filter((row: { optional: boolean }) => !row.optional)
        .map((row: { event: string }) => row.event)
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        fixture.handlers.observeHookEvent.mockClear()
        const before = fixture.handlers.openAttention.mock.calls.length +
          fixture.handlers.withdrawAttention.mock.calls.length +
          fixture.handlers.resolveAttention.mock.calls.length
        // Claude's only PreToolUse is its own question dialog; Codex's is request_user_input.
        const payload = agent === 'claude' && event === 'PreToolUse'
          ? { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A', description: 'a' }] }] } }
          : payloads[event]
        await runHook(fixture, agent, { hook_event_name: event, ...(payload as object) })
        const after = fixture.handlers.openAttention.mock.calls.length +
          fixture.handlers.withdrawAttention.mock.calls.length +
          fixture.handlers.resolveAttention.mock.calls.length
        if (event === 'SessionStart') expect(fixture.handlers.observeConversation).toHaveBeenCalled()
        else expect(after, `${agent} ${event} changed nothing in Needs you`).toBeGreaterThan(before)
        expect(fixture.handlers.observeHookEvent, `${agent} ${event} was not logged`).toHaveBeenCalled()
      }
    }
  })
})

// Session shape observed from OpenCode 1.18.31 on 2026-09-22.
const OPENCODE_SESSION = 'ses_0123456789abSyntheticTest0'
const OPENCODE_FOREGROUND = { ...HOLDS_TERMINAL, comm: 'opencode' }

describe('OpenCode hooks', () => {
  it('runs the printed plugin with a process-local session pin, stdin JSON and swallowed errors', async () => {
    const printed = await runHooks(['print', 'opencode'])
    expect(printed, printed.stderr).toMatchObject({ code: 0 })
    expect(printed.stdout).toContain('export const BMNPlugin')
    const javascript = stripTypeScriptTypes(printed.stdout).replace('export const BMNPlugin', 'const BMNPlugin')
    const env: Record<string, string> = {}
    const calls: Array<{ command: string; payload: string; env: Record<string, string> | undefined }> = []
    let fail = false
    const shell = (strings: TemplateStringsArray, payload: string, deadline: string[]) => {
      const call = { command: strings[0] + '<payload>' + strings[1] + (deadline?.join(' ') ?? '') + (strings[2] ?? ''), payload, env: undefined as Record<string, string> | undefined }
      calls.push(call)
      const result = {
        env: (value: Record<string, string>) => { call.env = value; return result },
        quiet: () => result,
        nothrow: () => fail ? Promise.reject(new Error('missing bmn')) : Promise.resolve()
      }
      return result
    }
    const create = runInNewContext(`${javascript}; BMNPlugin`, { Headers, AbortController, clearTimeout, process: { env } })
    const plugin = await create({ $: shell })
    const root = { type: 'session.created', properties: { sessionID: OPENCODE_SESSION } }
    await plugin.event({ event: root })
    expect(calls).toHaveLength(0)
    env.AITERM_CONTROL_SOCKET = '/fixture/socket'
    await plugin.event({ event: root })
    expect(JSON.parse(calls[0]?.payload ?? "null")).toEqual({ hook_event_name: root.type, ...root.properties })
    expect(calls[0]?.command).toBe("printf '%s' <payload> | timeout -s KILL 3s bmn hook opencode")
    expect(calls[0]?.env?.BMN_OPENCODE_SESSION_ID).toBe(OPENCODE_SESSION)
    await plugin.event({ event: { type: 'permission.asked', properties: { sessionID: 'ses_child' } } })
    expect(calls[1]?.env?.BMN_OPENCODE_SESSION_ID).toBe(OPENCODE_SESSION)
    await plugin.event({ event: { type: 'tui.session.select', properties: { sessionID: 'ses_selected' } } })
    expect(calls[2]?.env?.BMN_OPENCODE_SESSION_ID).toBe('ses_selected')
    fail = true
    await expect(plugin.event({ event: root })).resolves.toBeUndefined()
  })

  it('posts a collected answer to its own server, sends Deny only for the one waiting permission, and reports each response', async () => {
    const printed = await runHooks(['print', 'opencode'])
    expect(printed, printed.stderr).toMatchObject({ code: 0 })
    const javascript = stripTypeScriptTypes(printed.stdout).replace('export const BMNPlugin', 'const BMNPlugin')
    const takes: string[] = []
    const answerNext: Array<(answers: unknown[]) => void> = []
    const shell = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const command = strings.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ''), '')
      const result = {
        env: () => result,
        quiet: () => result,
        nothrow: async () => {
          if (!command.includes('bmn answer take')) return { exitCode: 0, stdout: Buffer.from('') }
          takes.push(command)
          const answers = await new Promise<unknown[]>((resolve) => answerNext.push(resolve))
          return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ answers })) }
        }
      }
      return result
    }
    const posts: Array<{ url: string; body: unknown }> = []
    let status = 200
    const fetcher = async (request: Request) => {
      posts.push({ url: request.url, body: JSON.parse(await request.text()) })
      return { ok: status < 300, status }
    }
    const create = runInNewContext(`${javascript}; BMNPlugin`, { Headers, AbortController, clearTimeout,
      process: { env: { BMN_CONTROL_SOCKET: '/fixture/socket' } }, URL, Request, setTimeout, Buffer
    })
    const plugin = await create({
      $: shell, serverUrl: new URL('http://127.0.0.1:4096/'), directory: '/work',
      client: { _client: { getConfig: () => ({ fetch: fetcher }) } }
    })
    const event = (type: string, properties: Record<string, unknown>) => plugin.event({ event: { type, properties } })
    const answer = async (answers: unknown[], expectedTakes: number) => {
      await vi.waitFor(() => expect(answerNext).toHaveLength(1))
      answerNext.shift()!(answers)
      await vi.waitFor(() => expect(takes).toHaveLength(expectedTakes))
    }
    await event('session.created', { sessionID: OPENCODE_SESSION })
    await event('permission.asked', { sessionID: OPENCODE_SESSION, id: 'per_1' })
    await event('permission.asked', { sessionID: OPENCODE_SESSION, id: 'per_2' })
    await vi.waitFor(() => expect(takes).toHaveLength(1))
    expect(takes[0]).toBe('timeout -s KILL 35s bmn answer take --wait 25 --json')
    // Two permissions wait, and OpenCode's reject would deny both: the Deny is not sent, and nothing is reported.
    await answer([{ requestRef: 'per_1', kind: 'permission', reply: 'reject' }], 2)
    expect(posts).toEqual([])
    expect(takes[1]).toBe('timeout -s KILL 35s bmn answer take --wait 25 --json')
    await answer([{ requestRef: 'per_2', kind: 'permission', reply: 'once' }], 3)
    expect(posts).toEqual([{ url: 'http://127.0.0.1:4096/permission/per_2/reply?directory=%2Fwork', body: { reply: 'once' } }])
    expect(takes[2]).toBe('timeout -s KILL 10s bmn answer take --wait 0 --reported per_2=ok --json')
    await event('permission.replied', { sessionID: OPENCODE_SESSION, requestID: 'per_2', reply: 'once' })
    await answer([], 4)
    // A server error may still have applied the reply: nothing is reported, so BMN keeps it uncertain.
    status = 503
    await answer([{ requestRef: 'per_1', kind: 'permission', reply: 'reject' }], 5)
    expect(posts[1]).toEqual({ url: 'http://127.0.0.1:4096/permission/per_1/reply?directory=%2Fwork', body: { reply: 'reject' } })
    expect(takes[4]).toBe('timeout -s KILL 35s bmn answer take --wait 25 --json')
    // A refused request (4xx) applied nothing.
    status = 404
    await answer([{ requestRef: 'per_1', kind: 'permission', reply: 'reject' }], 6)
    expect(takes[5]).toBe('timeout -s KILL 10s bmn answer take --wait 0 --reported per_1=failed --json')
    await event('session.idle', { sessionID: OPENCODE_SESSION })
    answerNext.shift()!([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(takes).toHaveLength(6)
  })

  it('kills a stalled plugin child within 3 seconds', async () => {
    const printed = await runHooks(['print', 'opencode'])
    expect(printed, printed.stderr).toMatchObject({ code: 0 })
    expect(printed.stdout).toContain('export const BMNPlugin')
    const javascript = stripTypeScriptTypes(printed.stdout).replace('export const BMNPlugin', 'const BMNPlugin')
    const root = await mkdtemp(join(tmpdir(), 'bmn-plugin-deadline-'))
    createdRoots.add(root)
    const pidFile = join(root, 'pid')
    await writeFile(join(root, 'bmn'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
    await chmod(join(root, 'bmn'), 0o700)
    let child: ReturnType<typeof execFile> | undefined
    let safetyTimeout = false
    const shell = (strings: TemplateStringsArray, ...values: unknown[]) => {
      let env = { ...process.env, PATH: `${root}:${process.env.PATH}` }
      const result = {
        env: (value: Record<string, string>) => { env = { ...env, ...value }; return result },
        quiet: () => result,
        nothrow: () => new Promise<void>((resolve) => {
          const quote = (value: unknown): string => `'${String(value).replaceAll("'", "'\"'\"'")}'`
          const command = strings.reduce((text, part, index) => text + part + (index < values.length
            ? (Array.isArray(values[index]) ? values[index].map(quote).join(' ') : quote(values[index])) : ''), '')
          child = execFile(fixtureShell('sh'), ['-c', command], { env }, () => resolve())
        })
      }
      return result
    }
    const create = runInNewContext(`${javascript}; BMNPlugin`, { Headers, AbortController, clearTimeout, process: { env: { BMN_CONTROL_SOCKET: '/fixture/socket' } } })
    const plugin = await create({ $: shell })
    const started = Date.now()
    const safety = setTimeout(() => {
      safetyTimeout = true
      void readFile(pidFile, 'utf8').then((pid) => {
        try { process.kill(Number(pid), 'SIGKILL') } catch { /* already exited */ }
      }).catch(() => undefined)
      child?.kill('SIGKILL')
    }, 4500)
    try {
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: OPENCODE_SESSION } } })
      expect(safetyTimeout).toBe(false)
      expect(Date.now() - started).toBeLessThan(4200)
      const pid = Number(await readFile(pidFile, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    } finally {
      clearTimeout(safety)
      child?.kill('SIGKILL')
      if (existsSync(pidFile)) {
        try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8000)

  it.each([
    ['permission.asked', { permission: 'edit', patterns: ['src/**'] }, 'openAttention', { requestKey: 'opencode:permission', kind: 'permission', title: 'OpenCode asks to edit', body: 'src/**' }],
    ['permission.replied', { reply: 'once' }, 'resolveAttention', { requestKey: 'opencode:permission', resolution: 'answered in the terminal' }],
    ['permission.replied', { reply: 'always' }, 'resolveAttention', { requestKey: 'opencode:permission' }],
    ['permission.replied', { reply: 'reject' }, 'withdrawAttention', { requestKey: 'opencode:permission' }],
    ['session.status', { status: { type: 'busy' } }, 'resolveAttention', { requestKey: 'opencode:question' }],
    ['session.idle', {}, 'openAttention', { requestKey: 'opencode:turn', title: 'OpenCode finished a turn', kind: 'notice' }],
    ['session.error', { error: { data: { message: 'Provider unavailable' } } }, 'openAttention', { requestKey: 'opencode:error', body: 'Provider unavailable' }],
    ['session.deleted', {}, 'withdrawAttention', { requestKey: 'opencode:error' }],
    ['question.asked', { questions: [{ question: 'Which one?', options: [{ label: 'First' }, { label: 'Second' }] }] }, 'openAttention', { requestKey: 'opencode:question', kind: 'question', body: '1. Which one?\n   First | Second' }],
    ['question.replied', {}, 'resolveAttention', { requestKey: 'opencode:question' }],
    ['question.rejected', {}, 'withdrawAttention', { requestKey: 'opencode:question' }]
  ])('maps %s and records provenance', async (event, properties, handler, expected) => {
    const fixture = await cliFixture()
    expect(await runHook(fixture, 'opencode', { hook_event_name: event, sessionID: OPENCODE_SESSION, ...properties }, OPENCODE_FOREGROUND)).toEqual(QUIET)
    const spy = fixture.handlers[handler as 'openAttention']
    expect(spy.mock.calls.some(([params]) => {
      try { expect(params).toMatchObject({ ...expected, origin: `hook:opencode:${event}` }); return true } catch { return false }
    })).toBe(true)
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'opencode', event, effects: expect.arrayContaining([handler === 'openAttention' ? 'opened' : handler === 'resolveAttention' ? 'answered' : 'withdrew']) }))
  })

  it.each([
    ['permission.asked', { permission: 'edit', patterns: ['src/**', 'docs/**'] }, 'openAttention', { requestKey: 'opencode:subagent-permission', kind: 'permission', title: 'OpenCode subagent asks to edit', body: 'src/**\ndocs/**' }],
    ['permission.replied', { reply: 'once' }, 'resolveAttention', { requestKey: 'opencode:subagent-permission', resolution: 'answered in the terminal' }],
    ['permission.replied', { reply: 'always' }, 'resolveAttention', { requestKey: 'opencode:subagent-permission', resolution: 'answered in the terminal' }],
    ['permission.replied', { reply: 'reject' }, 'withdrawAttention', { requestKey: 'opencode:subagent-permission' }],
    ['question.asked', { questions: [{ question: 'Which one?', options: [{ label: 'First' }] }] }, 'openAttention', { requestKey: 'opencode:subagent-question', kind: 'question', title: 'OpenCode subagent asks: Which one?', body: '1. Which one?\n   First' }],
    ['question.replied', {}, 'resolveAttention', { requestKey: 'opencode:subagent-question', resolution: 'answered in the terminal' }],
    ['question.rejected', {}, 'withdrawAttention', { requestKey: 'opencode:subagent-question' }]
  ])('maps child %s to its own slot', async (event, properties, handler, expected) => {
    const fixture = await cliFixture()
    const bound = { ...fixture, sessionEnv: { ...fixture.sessionEnv, BMN_OPENCODE_SESSION_ID: 'ses_main' } }
    expect(await runHook(bound, 'opencode', { hook_event_name: event, sessionID: 'ses_child', ...properties }, OPENCODE_FOREGROUND)).toEqual(QUIET)
    expect(fixture.handlers[handler as 'openAttention']).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...expected, origin: `hook:opencode:${event}` }))
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
  })

  it.each([
    { info: { id: 'ses_main', parentID: 'ses_parent' } },
    { info: { id: 'ses_sibling' } },
    { sessionID: 'ses_sibling' }
  ])('routes parentID and sibling identities to child slots: %j', async (identity) => {
    const fixture = await cliFixture()
    const bound = { ...fixture, sessionEnv: { ...fixture.sessionEnv, BMN_OPENCODE_SESSION_ID: 'ses_main' } }
    await runHook(bound, 'opencode', { hook_event_name: 'permission.asked', permission: 'edit', ...identity }, OPENCODE_FOREGROUND)
    expect(fixture.handlers.openAttention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestKey: 'opencode:subagent-permission' }))
  })

  it.each(['session.status', 'session.idle', 'session.error', 'session.created', 'session.deleted', 'tui.session.select', 'unknown'])('ignores child %s', async (event) => {
    const fixture = await cliFixture()
    const bound = { ...fixture, sessionEnv: { ...fixture.sessionEnv, BMN_OPENCODE_SESSION_ID: 'ses_main' } }
    await runHook(bound, 'opencode', { hook_event_name: event, sessionID: 'ses_child', status: { type: 'busy' } }, OPENCODE_FOREGROUND)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.resolveAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledWith(expect.objectContaining({ effects: [] }))
  })

  it.each(['session.idle', 'session.deleted', 'tui.session.select', 'session.status'])('handles child slots during main %s', async (event) => {
    const fixture = await cliFixture()
    const bound = { ...fixture, sessionEnv: { ...fixture.sessionEnv, BMN_OPENCODE_SESSION_ID: OPENCODE_SESSION } }
    const openKeys = new Set<string>()
    fixture.handlers.openAttention.mockImplementation(async (params) => { openKeys.add(params.requestKey); return { opened: true } })
    fixture.handlers.withdrawAttention.mockImplementation(async (params) => { openKeys.delete(params.requestKey); return { withdrawn: true } })
    fixture.handlers.resolveAttention.mockImplementation(async (params) => { openKeys.delete(params.requestKey); return { resolved: true } })
    for (const hook of ['permission.asked', 'question.asked']) {
      await runHook(bound, 'opencode', { hook_event_name: hook, sessionID: 'ses_child' }, OPENCODE_FOREGROUND)
    }
    expect([...openKeys].sort()).toEqual(['opencode:subagent-permission', 'opencode:subagent-question'])
    await runHook(bound, 'opencode', { hook_event_name: event, sessionID: OPENCODE_SESSION, status: { type: 'busy' } }, OPENCODE_FOREGROUND)
    for (const key of ['opencode:subagent-permission', 'opencode:subagent-question']) {
      expect(openKeys.has(key)).toBe(event === 'session.status')
    }
  })

  it('drops an OpenCode session reference that the binding store would refuse', async () => {
    const fixture = await cliFixture()
    const malformed = 'ses_zzzzzzzzzzzzhVbLiXJ8YHJQjV'
    const methods: string[] = []
    const sockets = new Set<Socket>(), started = Date.now()
    const trace: { stage: string; elapsedMs: number; metadata?: Record<string, string | number | boolean | null> }[] = []
    const track: CliTrace = (stage, metadata) => { if (trace.length < 100) trace.push({ stage, elapsedMs: Date.now() - started, ...(metadata ? { metadata } : {}) }) }
    const socketPath = rawEndpoint(fixture.root, 'raw-hook.sock')
    const rawServer = createServer((socket) => {
      sockets.add(socket); track('server-connection')
      socket.on('end', () => track('socket-end'))
      socket.on('error', error => track('socket-error', { code: (error as NodeJS.ErrnoException).code ?? null }))
      socket.on('close', () => { sockets.delete(socket); track('socket-close') })
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        track('server-data', { bytes: Buffer.byteLength(chunk), newlines: chunk.split('\n').length - 1 })
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string }
          buffer = buffer.slice(newline + 1)
          methods.push(message.method)
          track('complete-method', { method: ['auth', 'conversation.observe', 'hook.observe'].includes(message.method) ? message.method : 'other' })
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { recorded: true } })}\n`, () => track('reply-written'))
          newline = buffer.indexOf('\n')
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      rawServer.once('error', reject)
      rawServer.listen(socketPath, resolve)
    })
    track('listen-ready')
    try {
      const proc = await procTree(fixture.root, OPENCODE_FOREGROUND)
      const env = { ...fixture.sessionEnv, BMN_CONTROL_SOCKET: socketPath, BMN_PROC_ROOT: proc }
      const observed = await runCli(['hook', 'opencode'], { env, trace: track, input: JSON.stringify({
        hook_event_name: 'session.created', sessionID: malformed, info: { id: malformed }
      }) })
      const originalMethods = [...methods], originalTrace = [...trace]
      const connectionMatrix: unknown[] = []
      {
        const source = await readFile(CLI, 'utf8')
        for (const listenersFirst of [false, true]) {
          const copy = join(fixture.root, `instrumented-${listenersFirst ? 'listeners-first' : 'original'}.mjs`)
          await writeFile(copy, instrumentCliConnection(source, new URL('../../bin/safe-config-write.mjs', import.meta.url).href, listenersFirst))
          for (const [referenceKind, reference] of [['malformed', malformed], ['valid', OPENCODE_SESSION]] as const) {
            methods.length = 0
            const sample = await runCommand(process.execPath, [copy, 'hook', 'opencode'], { env, input: JSON.stringify({
              hook_event_name: 'session.created', sessionID: reference, info: { id: reference }
            }) })
            const phases = sample.stderr.split(/\r?\n/).filter(line => line.startsWith('[BMN_SYNTHETIC_CLIENT]'))
              .slice(0, 100).map(line => JSON.parse(line.slice('[BMN_SYNTHETIC_CLIENT]'.length)) as unknown)
            connectionMatrix.push({ construction: listenersFirst ? 'listeners-first' : 'original', runtime: 'Node',
              referenceKind, code: sample.code, stdoutBytes: Buffer.byteLength(sample.stdout), phases, methods: [...methods] })
          }
        }
        connectionMatrix.push({ runtime: 'Bun', result: 'UNVERIFIED', reason: 'Actual pinned Bun runs in the separately owned native CLI gate' })
      }
      if (process.platform === 'win32') console.log(JSON.stringify({ nativeDiagnostic: 'hook-connection', originalTrace, connectionMatrix }))
      expect(observed, JSON.stringify({ methods: originalMethods, trace: originalTrace, connectionMatrix })).toEqual(QUIET)
      // Diagnostic matrix methods must not replace the original invocation's proof.
      expect(originalMethods).toEqual(['auth', 'hook.observe'])

      methods.length = 0
      expect(await runCli(['hook', 'opencode'], { env, input: JSON.stringify({
        hook_event_name: 'session.created', sessionID: OPENCODE_SESSION, info: { id: OPENCODE_SESSION }
      }) })).toEqual(QUIET)
      expect(methods).toEqual(['auth', 'conversation.observe', 'hook.observe'])
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Synthetic raw pipe cleanup timeout')), 2000)
        rawServer.close(() => { clearTimeout(timer); resolve() })
      })
    }
  }, process.platform === 'win32' ? 90000 : 5000)

  it.each([['session.created', 'startup'], ['tui.session.select', 'resume']])('captures %s with the OpenCode reference', async (event, source) => {
    const fixture = await cliFixture()
    await runHook(fixture, 'opencode', { hook_event_name: event, sessionID: OPENCODE_SESSION }, OPENCODE_FOREGROUND)
    expect(fixture.handlers.observeConversation).toHaveBeenCalledWith(expect.objectContaining({ agentCli: 'opencode', conversationReference: OPENCODE_SESSION, source }))
    if (source === 'resume') expect(fixture.handlers.withdrawAttention).toHaveBeenCalledTimes(6)
  })

  it('ignores child conversation bindings, malformed references and nested agent processes', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'opencode', { hook_event_name: 'session.created', info: { id: OPENCODE_SESSION, parentID: 'parent' } }, OPENCODE_FOREGROUND)
    await runHook(fixture, 'opencode', { hook_event_name: 'session.created', sessionID: OBSERVED_REFERENCE }, OPENCODE_FOREGROUND)
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
    const proc = await procTree(fixture.root, OPENCODE_FOREGROUND)
    await runCli(['hook', 'opencode'], { env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc, BMN_OPENCODE_SESSION_ID: 'ses_other' }, input: JSON.stringify({ hook_event_name: 'permission.asked', sessionID: OPENCODE_SESSION }) })
    expect(fixture.handlers.openAttention).toHaveBeenCalledWith(expect.objectContaining({ requestKey: 'opencode:subagent-permission', title: 'OpenCode subagent asks to use a tool' }))
    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'permission.asked', effects: ['opened'] }))
    fixture.handlers.observeHookEvent.mockClear()
    await runHook(fixture, 'opencode', { hook_event_name: 'session.idle', sessionID: OPENCODE_SESSION }, { ...OPENCODE_FOREGROUND, tty: 0 })
    expect(fixture.handlers.observeHookEvent).not.toHaveBeenCalled()
  })

  it('prints, installs, compares, backs up and repairs the exact shipped plugin', async () => {
    const path = await hookFileFixture(undefined, 'bmn.ts')
    const printed = await runHooks(['print', 'opencode'])
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain('export const BMNPlugin: Plugin')
    expect(printed.stdout).toContain('bmn hook opencode')
    expect((await runHooks(['check', 'opencode', '--file', path])).code).toBe(1)
    const install = await runHooks(['install', '--yes', 'opencode', '--file', path, '--json'])
    expect(install.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(printed.stdout)
    expect((await runHooks(['check', 'opencode', '--file', path])).code).toBe(0)
    expect(JSON.parse((await runHooks(['install', '--yes', 'opencode', '--file', path, '--json'])).stdout).installed).toEqual([])
    await writeFile(path, '// unrelated plugin\n')
    expect((await runHooks(['check', 'opencode', '--file', path])).stdout).toMatch(/plugin\s+missing/)
    await writeFile(path, '// Shipped by BMN\n// bmn hook opencode\n')
    expect((await runHooks(['check', 'opencode', '--file', path])).stdout).toContain('wired (older wording)')
    const repair = JSON.parse((await runHooks(['install', '--yes', 'opencode', '--file', path, '--json'])).stdout)
    expect(await readFile(repair.backup, 'utf8')).toBe('// Shipped by BMN\n// bmn hook opencode\n')
    expect(await readFile(path, 'utf8')).toBe(printed.stdout)
  })

  it('uses the existing singular folder or the documented plural folder in an isolated config', async () => {
    const fixture = await cliFixture()
    const config = join(fixture.root, 'opencode')
    const env = { OPENCODE_CONFIG_DIR: config }
    const first = JSON.parse((await runHooks(['check', 'opencode', '--json'], env)).stdout)
    expect(normalize(first.agents[0].file)).toBe(join(config, 'plugins', 'bmn.ts'))
    const fresh = JSON.parse((await runHooks(['install', '--yes', 'opencode', '--json'], env)).stdout)
    expect(normalize(fresh.file)).toBe(join(config, 'plugins', 'bmn.ts'))
    expect(await readFile(fresh.file, 'utf8')).toContain('export const BMNPlugin')
    await mkdir(join(config, 'plugin'), { recursive: true })
    const installed = JSON.parse((await runHooks(['install', '--yes', 'opencode', '--json'], env)).stdout)
    expect(normalize(installed.file)).toBe(join(config, 'plugin', 'bmn.ts'))
  })
})

// Payloads recorded from the real harnesses on 2026-09-27 (docs/remote-answers.md), sanitised.
const REMOTE_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'remote-answers')

async function recorded(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(REMOTE_FIXTURES, name), 'utf8')) as Record<string, unknown>
}

function lastOpen(fixture: Awaited<ReturnType<typeof cliFixture>>): Record<string, unknown> {
  const calls = fixture.handlers.openAttention.mock.calls
  return calls[calls.length - 1]?.[0] as Record<string, unknown>
}

describe('structured prompts from the recorded hooks (Epic 30)', () => {
  it('opens a Claude question with its options and tool call id', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/ask-single.pre-tool-use.json'))
    expect(lastOpen(fixture)).toMatchObject({
      requestKey: 'claude:question',
      kind: 'question',
      origin: 'hook:claude:PreToolUse',
      prompt: {
        type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_01PqP3uetPam78QueRqjK7xL',
        questions: [{
          id: null, header: 'Auth method', text: 'Which auth method should the API use?', multiSelect: false,
          options: [
            { label: 'JWT', description: 'Stateless tokens, no session store' },
            { label: 'Session cookies', description: 'Server-side sessions in Redis' },
            { label: 'OAuth only', description: 'Delegate sign-in to Google and GitHub' }
          ]
        }]
      }
    })
  })

  it('files Claude\'s PermissionRequest for its own question under the question, without the call id', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/ask-single.permission-request.json'))
    expect(lastOpen(fixture)).toMatchObject({
      requestKey: 'claude:question', kind: 'question', prompt: { type: 'questions', toolUseId: null }
    })
  })

  it('keeps all three questions of one Claude dialog, and marks a multi-select dialog', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/ask-three.pre-tool-use.json'))
    const three = lastOpen(fixture).prompt as { questions: Array<{ header: string }> }
    expect(three.questions.map((each) => each.header)).toEqual(['Database', 'Tests', 'Deploy'])
    await runHook(fixture, 'claude', await recorded('claude/ask-multiselect.pre-tool-use.json'))
    expect(lastOpen(fixture).prompt).toMatchObject({ shape: 'multi-select', questions: [{ multiSelect: true }] })
  })

  it('opens a Claude permission with the exact command and working directory', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/bash.permission-request.json'))
    expect(lastOpen(fixture)).toMatchObject({
      requestKey: 'claude:permission',
      kind: 'permission',
      prompt: {
        type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null,
        tool: 'Bash', command: 'touch spike-allow.txt', cwd: '/work/project', description: 'Create spike-allow.txt file'
      }
    })
  })

  it('opens Codex blocking and async questions as different shapes', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', await recorded('codex/ask-two.pre-tool-use.json'))
    expect(lastOpen(fixture).prompt).toMatchObject({
      harness: 'codex', shape: 'choice', toolUseId: expect.stringMatching(/^call_/),
      questions: [{ id: 'database', header: 'Database' }, { id: 'tests', header: 'Tests' }]
    })
    await runHook(fixture, 'codex', await recorded('codex/ask-async.pre-tool-use.json'))
    expect(lastOpen(fixture).prompt).toMatchObject({
      shape: 'async-choice',
      questions: [{ id: null, header: null, text: 'Which color should the logo use?',
        options: [{ label: 'Gold', description: null }, { label: 'Black', description: null }] }]
    })
  })

  it('leaves Codex permissions plain', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', { hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'ls' } })
    expect(lastOpen(fixture)).not.toHaveProperty('prompt')
  })

  it('opens OpenCode questions and permissions with their request ids, command only from metadata', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'opencode', await recorded('opencode/question.asked.json'), OPENCODE_FOREGROUND)
    expect(lastOpen(fixture)).toMatchObject({
      requestKey: 'opencode:question', prompt: { harness: 'opencode', shape: 'choice', requestRef: 'que_0e3488978001RROK6B1gVoiWiS' }
    })
    await runHook(fixture, 'opencode', await recorded('opencode/permission.asked.json'), OPENCODE_FOREGROUND)
    expect(lastOpen(fixture)).toMatchObject({
      requestKey: 'opencode:permission',
      prompt: { tool: 'bash', command: 'touch oc-c.txt', requestRef: 'per_0e34a38370010edWsFz2o7GSqa', cwd: null }
    })
    const patternsOnly = { ...(await recorded('opencode/permission.asked.json')), metadata: {} }
    await runHook(fixture, 'opencode', patternsOnly, OPENCODE_FOREGROUND)
    expect(lastOpen(fixture).prompt).toMatchObject({ command: null })
  })

  it('marks OpenCode subagent prompts as their own shape', async () => {
    const fixture = await cliFixture()
    const env = { BMN_OPENCODE_SESSION_ID: 'ses_0123456789abSyntheticMain0' }
    await runHook(fixture, 'opencode', await recorded('opencode/question.asked.json'), OPENCODE_FOREGROUND, env)
    expect(lastOpen(fixture)).toMatchObject({ requestKey: 'opencode:subagent-question', prompt: { shape: 'subagent' } })
    await runHook(fixture, 'opencode', await recorded('opencode/permission.asked.json'), OPENCODE_FOREGROUND, env)
    expect(lastOpen(fixture)).toMatchObject({ requestKey: 'opencode:subagent-permission', prompt: { shape: 'subagent' } })
  })

  it('sends a dialog larger than the app stores as a plain request instead of a cut one', async () => {
    const fixture = await cliFixture()
    const options = Array.from({ length: 21 }, (_, index) => ({ label: `Option ${index}`, description: 'x' }))
    await runHook(fixture, 'claude', {
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_big',
      tool_input: { questions: [{ question: 'Which?', header: 'Big', options, multiSelect: false }] }
    })
    expect(lastOpen(fixture)).toMatchObject({ requestKey: 'claude:question', kind: 'question' })
    expect(lastOpen(fixture)).not.toHaveProperty('prompt')
  })

  it('cleans control characters out of prompt text rather than losing the request', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', {
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_bell',
      tool_input: { questions: [{ question: 'Ring\u0007 now?\nReally', header: 'Bell\tH', multiSelect: false,
        options: [{ label: 'Yes\u001b[31m', description: 'red\u0000' }] }] }
    })
    expect(lastOpen(fixture).prompt).toMatchObject({
      questions: [{ text: 'Ring now?\nReally', header: 'Bell H', options: [{ label: 'Yes [31m', description: 'red' }] }]
    })
  })
})

describe('Claude PreToolUse gated to its question tool (Epic 30)', () => {
  it('counts BMN\'s own AskUserQuestion matcher as wired, and any other matcher as gated', async () => {
    const own = await hookFileFixture({
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }] }
    })
    const ownReport = JSON.parse((await runHooks(['check', 'claude', '--file', own, '--json'])).stdout)
    const ownRow = ownReport.agents[0].events.find((row: { event: string }) => row.event === 'PreToolUse')
    expect(ownRow.state).toBe('wired')

    const other = await hookFileFixture({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }] }
    })
    const otherReport = JSON.parse((await runHooks(['check', 'claude', '--file', other, '--json'])).stdout)
    const otherRow = otherReport.agents[0].events.find((row: { event: string }) => row.event === 'PreToolUse')
    expect(otherRow.state).toBe('missing')
  })
})

describe('evidence of how a prompt ended, from the recorded hooks (Epic 30.2)', () => {
  const resolved = (fixture: Awaited<ReturnType<typeof cliFixture>>, requestKey: string): Record<string, unknown> | undefined =>
    fixture.handlers.resolveAttention.mock.calls.map(([params]) => params as Record<string, unknown>)
      .find((params) => params.requestKey === requestKey)

  it('sends Claude\'s chosen answers in the order the dialog asked them', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/ask-three.post-tool-use.json'))
    expect(resolved(fixture, 'claude:question')).toMatchObject({
      evidence: {
        toolUseId: 'toolu_01YENoYpvTY1rDaqboBWAGmy', requestRef: null,
        answers: [['Postgres'], ['Later'], ['Staging']], permission: null, tool: null, command: null
      }
    })
  })

  it('sends the tool and exact command a Claude permission let run', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/bash.post-tool-use.json'))
    expect(resolved(fixture, 'claude:permission')).toMatchObject({
      evidence: { toolUseId: 'toolu_014AAdE1ZSjo3GMghU99naAq', answers: null, permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' }
    })
  })

  it('orders Codex answers by the question ids the tool asked, not by the response', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', await recorded('codex/ask-two.post-tool-use.json'))
    expect(resolved(fixture, 'codex:question')).toMatchObject({
      evidence: { toolUseId: 'call_V5f15sVVybbRPi2QBgmKciRj', answers: [['SQLite'], ['Yes']] }
    })
  })

  it('leaves answers out when a report does not name one per question', async () => {
    const fixture = await cliFixture()
    const post = await recorded('codex/ask-two.post-tool-use.json')
    await runHook(fixture, 'codex', { ...post, tool_response: '{"answers":{"database":{"answers":["SQLite"]}}}' })
    expect(resolved(fixture, 'codex:question')).toMatchObject({ evidence: { answers: null } })
    const broken = await cliFixture()
    await runHook(broken, 'codex', { ...post, tool_response: 'not json' })
    expect(resolved(broken, 'codex:question')).toMatchObject({ evidence: { answers: null } })
  })

  it('sends OpenCode\'s request id with the answers or the permission reply', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'opencode', await recorded('opencode/question.replied.json'), OPENCODE_FOREGROUND)
    expect(resolved(fixture, 'opencode:question')).toMatchObject({
      evidence: { requestRef: 'que_0e3488978001RROK6B1gVoiWiS', answers: [['Session cookies']], permission: null }
    })
    await runHook(fixture, 'opencode', await recorded('opencode/permission.replied.once.json'), OPENCODE_FOREGROUND)
    expect(resolved(fixture, 'opencode:permission')).toMatchObject({
      evidence: { requestRef: 'per_0e34b1329001CyMk3xp8kIma9a', permission: 'allowed' }
    })
    await runHook(fixture, 'opencode', { ...(await recorded('opencode/permission.replied.once.json')), reply: 'reject' }, OPENCODE_FOREGROUND)
    const withdrawn = fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params as Record<string, unknown>)
      .find((params) => params.requestKey === 'opencode:permission')
    expect(withdrawn).toMatchObject({ evidence: { requestRef: 'per_0e34b1329001CyMk3xp8kIma9a', permission: 'denied' } })
  })
})

describe('multi-select and typed answers from the recorded hooks (Epic 31.4)', () => {
  const resolved = (fixture: Awaited<ReturnType<typeof cliFixture>>, requestKey: string): Record<string, unknown> | undefined =>
    fixture.handlers.resolveAttention.mock.calls.map(([params]) => params as Record<string, unknown>)
      .find((params) => params.requestKey === requestKey)

  it('sends Claude\'s multi-select answer as the one string it reports, typed text included', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'claude', await recorded('claude/ask-multiselect-typed.post-tool-use.json'))
    expect(resolved(fixture, 'claude:question')).toMatchObject({ evidence: { answers: [['Audit log, Passkeys']] } })
  })

  it('sends Codex\'s whole answer list, so a typed note counts as the answer', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'codex', await recorded('codex/ask-other.post-tool-use.json'))
    expect(resolved(fixture, 'codex:question')).toMatchObject({
      evidence: { answers: [['None of the above', 'user_note: Passkeys first, JWT as fallback'], ['Postgres']] }
    })
  })

  it('keeps OpenCode\'s multiple and custom flags, and every label it reports', async () => {
    const fixture = await cliFixture()
    await runHook(fixture, 'opencode', await recorded('opencode/question.asked.multiple.json'), OPENCODE_FOREGROUND)
    expect(lastOpen(fixture).prompt).toMatchObject({
      shape: 'multi-select',
      questions: [{ header: 'Features', multiSelect: true }, { header: 'Auth', multiSelect: false }]
    })
    const questionsOf = (params: Record<string, unknown>): Array<Record<string, unknown>> =>
      (params.prompt as { questions: Array<Record<string, unknown>> }).questions
    expect(questionsOf(lastOpen(fixture))[0]).not.toHaveProperty('custom')
    const noTyped = await cliFixture()
    const asked = await recorded('opencode/question.asked.multiple.json')
    const [first, ...rest] = asked.questions as Array<Record<string, unknown>>
    await runHook(noTyped, 'opencode', { ...asked, questions: [{ ...first, custom: false }, ...rest] }, OPENCODE_FOREGROUND)
    expect(questionsOf(lastOpen(noTyped))[0]).toMatchObject({ custom: false })
    await runHook(fixture, 'opencode', await recorded('opencode/question.replied.multiple-typed.json'), OPENCODE_FOREGROUND)
    expect(resolved(fixture, 'opencode:question')).toMatchObject({
      evidence: { answers: [['SSO', 'Rate limiting'], ['Passkeys first, JWT as fallback']] }
    })
  })

  it('reports a 2,000-character typed answer whole', async () => {
    const post = await recorded('claude/ask-multiselect-typed.post-tool-use.json')
    const question = 'Which features should the first release include?'
    const long = await cliFixture()
    await runHook(long, 'claude', { ...post, tool_response: { ...(post.tool_response as object), answers: { [question]: 'y'.repeat(2_000) } } })
    expect(resolved(long, 'claude:question')).toMatchObject({ evidence: { answers: [['y'.repeat(2_000)]] } })
  })
})

describe('bmn answer take (Epic 30.2)', () => {
  it('collects this session\'s answers and waits as long as asked', async () => {
    const fixture = await cliFixture()
    fixture.handlers.takeAnswers.mockResolvedValue({
      answers: [{ requestRef: 'que_1', kind: 'question', answers: [['JWT']] }]
    })
    const result = await runCli(['answer', 'take', '--wait', '2', '--json'], { env: fixture.sessionEnv })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ answers: [{ requestRef: 'que_1', kind: 'question', answers: [['JWT']] }] })
    expect(fixture.handlers.takeAnswers).toHaveBeenCalledWith({ sessionId: 'session-1', incarnationId: 'incarnation-1', waitMs: 2000, report: null })
  })

  it('passes on what OpenCode\'s server said to a posted reply', async () => {
    const fixture = await cliFixture()
    expect((await runCli(['answer', 'take', '--reported', 'per_1=ok', '--json'], { env: fixture.sessionEnv })).code).toBe(0)
    expect(fixture.handlers.takeAnswers).toHaveBeenLastCalledWith({
      sessionId: 'session-1', incarnationId: 'incarnation-1', waitMs: 0, report: { requestRef: 'per_1', delivered: true }
    })
    expect((await runCli(['answer', 'take', '--reported', 'per_1=failed'], { env: fixture.sessionEnv })).code).toBe(0)
    expect(fixture.handlers.takeAnswers).toHaveBeenLastCalledWith(expect.objectContaining({ report: { requestRef: 'per_1', delivered: false } }))
    for (const value of ['per_1', 'per_1=maybe', '=ok', 'per 1=ok']) {
      expect((await runCli(['answer', 'take', '--reported', value], { env: fixture.sessionEnv })).code).toBe(2)
    }
    expect(fixture.handlers.takeAnswers).toHaveBeenCalledTimes(2)
  })

  it.each([['-1'], ['26'], ['1.5'], ['soon']])('refuses --wait %s as a usage error', async (wait) => {
    const fixture = await cliFixture()
    const result = await runCli(['answer', 'take', '--wait', wait], { env: fixture.sessionEnv })
    expect(result.code).toBe(2)
    expect(fixture.handlers.takeAnswers).not.toHaveBeenCalled()
  })

  it('offers no command that could send an answer', async () => {
    const fixture = await cliFixture()
    for (const action of ['give', 'send', 'allow']) {
      expect((await runCli(['answer', action], { env: fixture.sessionEnv })).code).toBe(2)
    }
    expect(fixture.handlers.takeAnswers).not.toHaveBeenCalled()
  })
})

// Payloads recorded from cursor-agent 2026.09.26-dd393fe on 2026-09-28, sanitised (docs/agent-control.md).
const CURSOR_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'cursor')
const CURSOR_FOREGROUND = { ...HOLDS_TERMINAL, comm: 'MainThread' }
const CURSOR_CHAT = 'c741bb07-352f-457b-8e7c-ee00517cd9ff'
const DOCUMENTED_CURSOR = '[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook cursor; exit 0'

async function cursorEvent(name: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return { ...JSON.parse(await readFile(join(CURSOR_FIXTURES, name), 'utf8')) as Record<string, unknown>, ...extra }
}

describe('Cursor hooks (Epic 31.3)', () => {
  const calls = (fixture: Awaited<ReturnType<typeof cliFixture>>): string[] => [
    ...fixture.handlers.openAttention.mock.calls.map(([params]) => `open ${params.requestKey} ${params.title}`),
    ...fixture.handlers.withdrawAttention.mock.calls.map(([params]) => `withdraw ${params.requestKey}`),
    ...fixture.handlers.resolveAttention.mock.calls.map(([params]) => `resolve ${params.requestKey}`)
  ]

  it.each([
    ['sessionStart.json', {}, ['withdraw cursor:turn'], 'startup'],
    ['beforeSubmitPrompt.json', {}, ['withdraw cursor:turn'], 'prompt'],
    ['beforeSubmitPrompt.resumed.json', {}, ['withdraw cursor:turn'], 'prompt'],
    ['postToolUse.json', {}, ['withdraw cursor:turn'], null],
    ['stop.json', {}, ['open cursor:turn Cursor finished its turn'], null],
    ['stop.json', { status: 'error' }, ['open cursor:turn Cursor stopped with an error'], null],
    ['stop.json', { status: 'aborted' }, ['withdraw cursor:turn'], null],
    ['sessionEnd.json', {}, ['withdraw cursor:turn'], null],
    ['preToolUse.json', {}, [], null],
    ['beforeShellExecution.json', {}, [], null],
    ['afterAgentResponse.json', {}, [], null]
  ] as const)('maps the recorded %s %j to the turn notice and the chat id', async (name, extra, expected, source) => {
    const fixture = await cliFixture()
    const event = await cursorEvent(name, extra)

    expect(await runHook(fixture, 'cursor', event, CURSOR_FOREGROUND)).toEqual(QUIET)

    expect(calls(fixture)).toEqual(expected)
    for (const [params] of [...fixture.handlers.openAttention.mock.calls, ...fixture.handlers.withdrawAttention.mock.calls]) {
      expect(params.origin).toBe(`hook:cursor:${String(event.hook_event_name)}`)
    }
    if (source === null) {
      expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
    } else {
      expect(fixture.handlers.observeConversation.mock.calls[0]?.[0]).toEqual({
        sessionId: 'session-1', incarnationId: 'incarnation-1', agentCli: 'cursor', conversationReference: CURSOR_CHAT, source,
        ...(typeof event.transcript_path === 'string' ? { transcriptPath: event.transcript_path } : {})
      })
    }
    // Every event is logged with the model Cursor named, and nothing Claude-only rides along.
    const observed = fixture.handlers.observeHookEvent.mock.calls[0]?.[0]
    expect(observed).toMatchObject({ agent: 'cursor', event: event.hook_event_name, model: 'default' })
    expect(observed).not.toHaveProperty('claudeConfigDir')
    expect(observed).not.toHaveProperty('apiHost')
    expect(observed).not.toHaveProperty('fingerprint')
  })

  it('reports no chat for an id that is not a UUID', async () => {
    const fixture = await cliFixture()

    await runHook(fixture, 'cursor', await cursorEvent('sessionStart.json', { conversation_id: 'not-a-chat' }), CURSOR_FOREGROUND)

    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
    expect(calls(fixture)).toEqual(['withdraw cursor:turn'])
  })

  it('ignores a Cursor payload that reaches bmn hook claude through Cursor\'s Claude hook support', async () => {
    const fixture = await cliFixture()

    for (const name of ['stop.json', 'sessionStart.json', 'postToolUse.json']) {
      expect(await runHook(fixture, 'claude', await cursorEvent(name), CURSOR_FOREGROUND)).toEqual(QUIET)
    }

    expect(calls(fixture)).toEqual([])
    expect(fixture.handlers.observeHookEvent).not.toHaveBeenCalled()
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
  })

  it('says nothing for a cursor-agent run from a tool call, which holds no terminal', async () => {
    const fixture = await cliFixture()

    await runHook(fixture, 'cursor', await cursorEvent('stop.json'), { ...CURSOR_FOREGROUND, tty: 0 })

    expect(calls(fixture)).toEqual([])
    expect(fixture.handlers.observeHookEvent).not.toHaveBeenCalled()
  })

  it('installs Cursor\'s own flat format into a new file, and check then reads every event wired', async () => {
    const path = await hookFileFixture(undefined, 'hooks.json')

    const install = await runHooks(['install', '--yes', 'cursor', '--file', path, '--json'])
    const check = await runHooks(['check', 'cursor', '--file', path, '--json'])
    const again = await runHooks(['install', '--yes', 'cursor', '--file', path, '--json'])

    expect(install.code).toBe(0)
    expect(JSON.parse(install.stdout)).toMatchObject({ installed: CURSOR_EVENTS, backup: null })
    const entry = { command: DOCUMENTED_CURSOR, timeout: 5 }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1, hooks: Object.fromEntries(CURSOR_EVENTS.map((event) => [event, [entry]]))
    })
    expect(check.code).toBe(0)
    expect(JSON.parse(check.stdout).agents[0].events.map((row: { state: string }) => row.state))
      .toEqual(CURSOR_EVENTS.map(() => 'wired'))
    expect(JSON.parse(again.stdout)).toMatchObject({ installed: [], backup: null })
  })

  it('adds beside the owner\'s entries after a backup, keeps them byte for byte and keeps the file\'s version', async () => {
    const owner = { command: './my-audit.sh', timeout: 30 }
    const original = { version: 1, hooks: { stop: [owner], afterFileEdit: [{ command: 'fmt' }] } }
    const path = await hookFileFixture(original, 'hooks.json')

    const install = await runHooks(['install', '--yes', 'cursor', '--file', path, '--json'])

    const report = JSON.parse(install.stdout)
    expect(report.installed).toEqual(CURSOR_EVENTS)
    expect(JSON.parse(await readFile(report.backup, 'utf8'))).toEqual(original)
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.hooks.stop).toEqual([owner, { command: DOCUMENTED_CURSOR, timeout: 5 }])
    expect(written.hooks.afterFileEdit).toEqual(original.hooks.afterFileEdit)
    expect(written.version).toBe(1)
  })

  it('counts only an entry Cursor would run for every call: no matcher, not a prompt, a positive timeout', async () => {
    const path = await hookFileFixture({ version: 1, hooks: {
      sessionStart: [{ command: DOCUMENTED_CURSOR }],
      beforeSubmitPrompt: [{ command: DOCUMENTED_CURSOR, type: 'command', timeout: 5 }],
      postToolUse: [{ command: DOCUMENTED_CURSOR, matcher: 'Shell' }],
      stop: [{ command: DOCUMENTED_CURSOR, type: 'prompt' }],
      sessionEnd: [{ command: DOCUMENTED_CURSOR, timeout: 0 }]
    } }, 'hooks.json')

    const report = JSON.parse((await runHooks(['check', 'cursor', '--file', path, '--json'])).stdout).agents[0]

    expect(Object.fromEntries(report.events.map((row: { event: string; state: string }) => [row.event, row.state]))).toEqual({
      sessionStart: 'wired', beforeSubmitPrompt: 'wired', postToolUse: 'missing', stop: 'missing', sessionEnd: 'missing'
    })
    expect(report.events.find((row: { event: string }) => row.event === 'postToolUse').gated).toEqual([DOCUMENTED_CURSOR])
    expect(report.missing).toEqual(['postToolUse', 'stop', 'sessionEnd'])
  })

  it('reads ~/.cursor/hooks.json when no --file is given, beside the other agents', async () => {
    const home = await cliFixture()

    // A moved Codex home is Codex's alone; Cursor still reads its file in the home directory.
    const result = await runHooks(['check', '--json'], { HOME: home.root, CODEX_HOME: join(home.root, 'moved-codex') })

    const report = JSON.parse(result.stdout)
    expect(report.agents.map((agent: { agent: string }) => agent.agent)).toEqual(['claude', 'codex', 'opencode', 'cursor'])
    expect(normalize(report.agents[3].file)).toBe(join(home.root, '.cursor', 'hooks.json'))
  })

  it('drives bmn hook cursor with every event check expects, and each one reaches the app', async () => {
    const fixture = await cliFixture()
    const path = await hookFileFixture({}, 'hooks.json')
    const events: string[] = JSON.parse((await runHooks(['check', 'cursor', '--file', path, '--json'])).stdout)
      .agents[0].events.map((row: { event: string }) => row.event)
    expect(events).toEqual(CURSOR_EVENTS)
    const recorded: Record<string, string> = {
      sessionStart: 'sessionStart.json', beforeSubmitPrompt: 'beforeSubmitPrompt.json', postToolUse: 'postToolUse.json',
      stop: 'stop.json', sessionEnd: 'sessionEnd.json'
    }
    for (const event of events) {
      fixture.handlers.observeHookEvent.mockClear()
      const before = calls(fixture).length
      await runHook(fixture, 'cursor', await cursorEvent(recorded[event]!), CURSOR_FOREGROUND)
      expect(calls(fixture).length, `cursor ${event} changed nothing in Needs you`).toBeGreaterThan(before)
      expect(fixture.handlers.observeHookEvent, `cursor ${event} was not logged`).toHaveBeenCalled()
    }
  })
})

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd']

describe('compaction events (Story 36.1)', () => {
  it('logs Claude\'s and Codex\'s SessionStart compact with its source and asks nothing of the owner', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const fixture = await cliFixture()

      const result = await runHook(fixture, agent, { hook_event_name: 'SessionStart', source: 'compact', session_id: OBSERVED_REFERENCE })

      expect(result).toEqual(QUIET)
      expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
      expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
      expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
      expect(fixture.handlers.observeHookEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        agent, event: 'SessionStart', source: 'compact', effects: []
      }))
    }
  })

  it.each(['manual', 'auto'])('logs Codex PostCompact with its %s trigger as the source', async (trigger) => {
    const fixture = await cliFixture()

    // Payload keys measured from Codex 0.157.1 on a disposable profile (docs/agent-control.md).
    await runHook(fixture, 'codex', {
      hook_event_name: 'PostCompact', trigger, session_id: OBSERVED_REFERENCE, turn_id: 'turn-1', model: 'gpt-test', cwd: '/tmp'
    })

    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent: 'codex', event: 'PostCompact', source: trigger, effects: []
    }))
  })

  it('logs the owner\'s OpenCode session.compacted plainly and a subagent\'s as the subagent\'s', async () => {
    const fixture = await cliFixture()
    const bound = { ...fixture, sessionEnv: { ...fixture.sessionEnv, BMN_OPENCODE_SESSION_ID: 'ses_main' } }

    await runHook(bound, 'opencode', { hook_event_name: 'session.compacted', sessionID: 'ses_main' }, OPENCODE_FOREGROUND)
    await runHook(bound, 'opencode', { hook_event_name: 'session.compacted', sessionID: 'ses_child' }, OPENCODE_FOREGROUND)

    const [owner, subagent] = fixture.handlers.observeHookEvent.mock.calls.map((call) => call[0])
    expect(owner).toMatchObject({ agent: 'opencode', event: 'session.compacted', source: null, effects: [] })
    expect(subagent).toMatchObject({ agent: 'opencode', event: 'session.compacted', source: 'subagent', effects: [] })
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it('never installs PostCompact: it is optional like PermissionRequest', async () => {
    const path = await hookFileFixture({}, 'hooks.json')

    expect((await runHooks(['install', '--yes', 'codex', '--file', path])).code).toBe(0)

    const installed = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown> }
    expect(Object.keys(installed.hooks)).not.toContain('PostCompact')
    expect(Object.keys(installed.hooks)).toContain('SessionStart')
  })
})

describe('bmn statusline (Story 37.2)', () => {
  const ORIGINAL = 'input=$(cat); printf \'%s\' "$input" | wc -c; echo "it\'s the owner\'s" >&2; exit 4'
  const settings = { theme: 'dark', statusLine: { type: 'command', command: ORIGINAL, padding: 1 }, zzz: [1, 2] }
  const runStatusLine = (args: string[], env?: Record<string, string>) => runCli(['statusline', ...args], env === undefined ? {} : { env })
  /** Status-line input in the shape Claude Code 2.1.283 sends (docs/usage-sources.md), with synthetic values. */
  const input = (rateLimits: unknown) => JSON.stringify({
    session_id: '11111111-1111-4111-8111-111111111111', cwd: '/synthetic', model: { id: 'synthetic' },
    context_window: { used_percentage: 37 }, rate_limits: rateLimits
  })
  const LIMITS = { five_hour: { used_percentage: 42, resets_at: 1_790_610_000 }, seven_day: { used_percentage: 18, resets_at: 1_790_900_000 } }

  it('wraps the owner\'s command without changing it, and uninstall gives the file back byte for byte', async () => {
    const path = await hookFileFixture(settings)
    const original = await readFile(path, 'utf8')

    expect((await runStatusLine(['check', '--file', path])).code).toBe(1)
    const install = await runStatusLine(['install', '--file', path])
    const wrapped = JSON.parse(await readFile(path, 'utf8'))

    expect(install.code).toBe(0)
    expect(install.stdout).toContain(`Backup: ${path}.bmn-backup-`)
    expect(wrapped.statusLine.command.endsWith(`\n${ORIGINAL}`)).toBe(true)
    expect({ ...wrapped, statusLine: { ...wrapped.statusLine, command: ORIGINAL } }).toEqual(settings)
    const [backup] = await backupsOf(path)
    expect(await readFile(join(dirname(path), backup ?? ''), 'utf8')).toBe(original)
    expect((await runStatusLine(['check', '--file', path])).code).toBe(0)

    const again = await runStatusLine(['install', '--file', path, '--json'])
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ state: 'wrapped', changed: false, backup: null })
    expect(await backupsOf(path)).toHaveLength(1)

    const uninstall = await runStatusLine(['uninstall', '--file', path])
    expect(uninstall.code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await backupsOf(path)).toHaveLength(2)
  })

  it('refuses to install the POSIX wrapper on Windows and leaves the file alone; check still reads it', async () => {
    const path = await hookFileFixture(settings)
    const original = await readFile(path, 'utf8')

    const install = await runStatusLine(['install', '--file', path], HOOK_FORM_POWERSHELL)
    const check = await runStatusLine(['check', '--file', path, '--json'], HOOK_FORM_POWERSHELL)

    expect(install.code).toBe(1)
    expect(install.stderr).toBe(`bmn: the status-line wrapper is not supported on Windows yet; ${path} was left untouched\n`)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await backupsOf(path)).toHaveLength(0)
    expect(JSON.parse(check.stdout)).toMatchObject({ state: 'unwrapped' })
  })

  it('finds Claude\'s settings the way hooks install does when no file is named', async () => {
    const path = await hookFileFixture(settings)
    const check = await runStatusLine(['check', '--json'], { CLAUDE_CONFIG_DIR: dirname(path) })
    const report = JSON.parse(check.stdout)
    expect({ ...report, file: normalize(report.file) }).toEqual({ file: path, state: 'unwrapped' })
  })

  it.each([
    ['no statusLine command', { theme: 'dark' }, 'has no statusLine command'],
    ['a statusLine that is not a command', { statusLine: { type: 'static', text: 'x' } }, 'not a command'],
    ['a file that is not JSON', '{ "statusLine": ', 'is not valid JSON'],
    // Wrapped by another version, or by hand: a second line in front would report every refresh twice.
    ['a line another bmn wrote', { statusLine: { type: 'command', command: 'bmn statusline report & exec my-line' } }, 'in a form this bmn did not write']
  ])('leaves a file with %s untouched', async (_label, contents, reason) => {
    const path = await hookFileFixture(contents)
    const before = await readFile(path, 'utf8')

    for (const action of ['install', 'uninstall']) {
      const result = await runStatusLine([action, '--file', path])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(reason)
    }
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it('refuses rather than overwriting a file another writer changed while it was reading', async () => {
    const path = await hookFileFixture(settings)
    const gate = join(dirname(path), 'gate')
    const installing = runStatusLine(['install', '--file', path], { BMN_HOOKS_TEST_GATE: gate })
    const deadline = Date.now() + 10_000
    while (!existsSync(`${gate}.waiting`)) {
      if (Date.now() > deadline) throw new Error('the installer never reached its check')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await writeFile(path, `${JSON.stringify({ ...settings, other: 'ADDED BY SOMEBODY ELSE' }, null, 2)}\n`)
    await writeFile(gate, '')
    const install = await installing

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('changed while BMN was reading it')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ other: 'ADDED BY SOMEBODY ELSE', statusLine: { command: ORIGINAL } })
    expect((await readdir(dirname(path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  describe('the installed line, run as Claude runs it', () => {
    /** `/bin/sh -c <command>` with the input on stdin, and a `bmn` on PATH that is this CLI (after `pathFirst`). */
    const runLine = async (command: string, stdin: string, env: Record<string, string>, pathFirst = '') => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'aitline-')))
      createdRoots.add(root)
      await mkdir(join(root, 'bin'))
      await writeFile(join(root, 'bin', 'bmn'), `#!/bin/sh\nexec ${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(CLI))} "$@"\n`, { mode: 0o755 })
      const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BMN_') && !key.startsWith('AITERM_')))
      return new Promise<CliResult & { tmp: string }>((resolve) => {
        const child = execFile(fixtureShell('sh'), ['-c', command], {
          env: { ...clean, PATH: fixtureSearchPath([pathFirst, join(root, 'bin')].filter(Boolean), process.env.PATH ?? ''), TMPDIR: shellPath(root), ...env }, timeout: 15_000
        }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr, tmp: root })
        })
        child.stdin?.end(stdin)
      })
    }
    const wrappedCommand = async () => {
      const path = await hookFileFixture(settings)
      await runStatusLine(['install', '--file', path])
      return JSON.parse(await readFile(path, 'utf8')).statusLine.command as string
    }
    const reported = async (handler: ReturnType<typeof vi.fn>, calls: number) => {
      const deadline = Date.now() + 10_000
      while (handler.mock.calls.length < calls && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    }

    it('prints what the owner\'s command printed and exits with its code, inside BMN and outside it', async () => {
      const fixture = await cliFixture()
      const command = await wrappedCommand()
      const stdin = input(LIMITS)
      const expected = await runLine(ORIGINAL, stdin, {})

      const inside = await runLine(command, stdin, fixture.sessionEnv)
      const outside = await runLine(command, stdin, {})

      expect(expected).toMatchObject({ code: 4, stdout: `${Buffer.byteLength(stdin)}\n`, stderr: "it's the owner's\n" })
      for (const result of [inside, outside]) {
        expect({ code: result.code, stdout: result.stdout, stderr: result.stderr })
          .toEqual({ code: expected.code, stdout: expected.stdout, stderr: expected.stderr })
      }
      await reported(fixture.handlers.reportUsage, 1)
      // Only the windows and the context share reach BMN, and only from inside a session.
      expect(fixture.handlers.reportUsage).toHaveBeenCalledTimes(1)
      expect(fixture.handlers.reportUsage).toHaveBeenCalledWith({
        sessionId: 'session-1', incarnationId: 'incarnation-1', agent: 'claude', contextUsedPercent: 37,
        windows: [
          { minutes: 300, usedPercent: 42, resetsAt: new Date(1_790_610_000_000).toISOString() },
          { minutes: 10_080, usedPercent: 18, resetsAt: new Date(1_790_900_000_000).toISOString() }
        ]
      })
      // The copy of the input is removed at once; nothing is left in the temporary folder.
      expect((await readdir(inside.tmp)).filter((entry) => entry !== 'bin')).toEqual([])
    })

    it('gives the owner\'s command what was copied and leaves no copy or message when the copy fails part-way', async () => {
      const fixture = await cliFixture()
      const command = await wrappedCommand()
      const stdin = input(LIMITS)
      const root = await realpath(await mkdtemp(join(tmpdir(), 'aitcat-')))
      createdRoots.add(root)
      // A shell function intercepts the same command on POSIX and Git for Windows,
      // where native cat.exe lookup can bypass an extensionless PATH script.
      const partialCat = `cat() {
if [ ! -f ${shellQuote(shellPath(join(root, 'copied')))} ]; then
  : > ${shellQuote(shellPath(join(root, 'copied')))}
  head -c 40; echo 'cat: write error: No space left on device' >&2; return 1
fi
/bin/cat "$@"
}`
      await mkdir(join(root, 'tmp'))
      const result = await runLine(`${partialCat}\n${command}`, stdin, { ...fixture.sessionEnv, TMPDIR: shellPath(join(root, 'tmp')) })

      expect(result).toMatchObject({ code: 4, stdout: '40\n', stderr: "it's the owner's\n" })
      expect(await readdir(join(root, 'tmp'))).toEqual([])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(fixture.handlers.reportUsage).not.toHaveBeenCalled()
    })

    it('runs the owner\'s command unchanged when BMN\'s own bmn is not on PATH', async () => {
      const fixture = await cliFixture()
      const command = await wrappedCommand()
      const stdin = input(LIMITS)
      const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BMN_')))
      const result = await new Promise<CliResult>((resolve) => {
        const child = execFile(fixtureShell('sh'), ['-c', command], { env: { ...clean, PATH: process.platform === 'win32' ? fixtureSearchPath([], '') : '/usr/bin:/bin', ...fixture.sessionEnv } },
          (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }))
        child.stdin?.end(stdin)
      })
      expect(result).toEqual({ code: 4, stdout: `${Buffer.byteLength(stdin)}\n`, stderr: "it's the owner's\n" })
      expect(fixture.handlers.reportUsage).not.toHaveBeenCalled()
    })

    it('sends context use alone when the plan reports no limits, and nothing when the input carries neither', async () => {
      const fixture = await cliFixture()
      const report = (stdin: string) => runCli(['statusline', 'report'], { env: fixture.sessionEnv, input: stdin })

      expect(await report(input(null))).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(await report('{"cwd":"/synthetic"}')).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(await report('not json')).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(fixture.handlers.reportUsage).toHaveBeenCalledTimes(1)
      expect(fixture.handlers.reportUsage).toHaveBeenCalledWith(expect.objectContaining({ windows: [], contextUsedPercent: 37 }))
      // Outside BMN the report is silent and sends nothing.
      expect(await runCli(['statusline', 'report'], { input: input(LIMITS) })).toEqual({ code: 0, stdout: '', stderr: '' })
    })
  })
})

describe('manual structured ask inputs', () => {
  const choices = { options: [{ label: 'Proceed', description: null }, { label: 'Wait', description: 'Keep pending' }] }
  it('accepts explicit JSON and one piped choices source through the real socket', async () => {
    const fixture = await cliFixture()
    expect((await runCli(['ask', 'json', 'Checkpoint', '--choices-json', JSON.stringify(choices)], { env: fixture.sessionEnv })).code).toBe(0)
    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({ manualChoices: { ...choices, allowOther: true }, origin: 'cli' }))
    expect((await runCli(['ask', 'piped', 'Decision', '--kind', 'permission', '--choices-file', '-'], { env: fixture.sessionEnv, input: JSON.stringify(choices) })).code).toBe(0)
    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'permission', manualChoices: { ...choices, allowOther: true } }))
  })
  it.each([
    ['--kind', 'notice', '--choices-json', JSON.stringify(choices)],
    ['--choices-json', '{}'],
    ['--choices-json', JSON.stringify({ ...choices, allowOther: false })],
    ['--choices-json', JSON.stringify({ options: [choices.options[0], choices.options[0]] })],
    ['--choices-json', '{'],
    ['--choices-json', JSON.stringify(choices), '--choices-file', '-'],
    ['--choices-file', '-', '--body-file', '-']
  ])('rejects invalid/conflicting sources without creating a request: %s', async (...flags) => {
    const fixture = await cliFixture()
    expect((await runCli(['ask', 'invalid', 'Checkpoint', ...flags], { env: fixture.sessionEnv, input: JSON.stringify(choices) })).code).toBe(2)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })
})

it('carries foreground conversation identity without SessionStart cleanup and on native mutations', async () => {
  const fixture = await cliFixture()
  const identity = { agentCli: 'codex', conversationReference: OBSERVED_REFERENCE }
  expect(await runHook(fixture, 'codex', { hook_event_name: 'SessionStart', source: 'startup', session_id: OBSERVED_REFERENCE },
    { ...HOLDS_TERMINAL, comm: 'codex' })).toEqual(QUIET)
  expect(fixture.handlers.observeConversation).toHaveBeenCalled()
  expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()
  expect(await runHook(fixture, 'codex', { hook_event_name: 'PreToolUse', session_id: OBSERVED_REFERENCE,
    tool_name: 'functions.request_user_input_async', tool_input: { questions: [{ id: 'color', header: 'Color', question: 'Which?',
      options: [{ label: 'Gold', description: 'Gold' }, { label: 'Black', description: 'Black' }] }] } },
    { ...HOLDS_TERMINAL, comm: 'codex' })).toEqual(QUIET)
  expect(fixture.handlers.openAttention).toHaveBeenCalledWith(expect.objectContaining({ producer: identity }))
  expect(await runHook(fixture, 'codex', { hook_event_name: 'SessionEnd', session_id: OBSERVED_REFERENCE },
    { ...HOLDS_TERMINAL, comm: 'codex' })).toEqual(QUIET)
  expect(fixture.handlers.withdrawAttention).toHaveBeenLastCalledWith(expect.objectContaining({ producer: identity }))
})


it.each(['\u00ad', '\u061c', '\u2060'])('refuses a format-bearing manual option at the CLI before host mutation %s', async character => {
  const fixture = await cliFixture()
  const options = { options: [{ label: `Pro${character}ceed`, description: null }, { label: 'Wait', description: null }] }
  const result = await runCli(['ask', 'format-choice', 'Synthetic', '--choices-json', JSON.stringify(options)], { env: fixture.sessionEnv })
  expect(result.code).toBe(2)
  expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
})

// Story 53.4: the native launcher sessions find on PATH. Built by scripts/build/windows-cli.mjs during install.
describe.runIf(process.platform === 'win32')('native Windows bmn launcher', () => {
  const launcher = fileURLToPath(new URL('../../native-out/windows-cli/bmn.exe', import.meta.url))
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const awkward = [
    'he said "hi" and \\"escaped\\"',
    '100% ^caret & amp | pipe <in >out %PATH% !bang!',
    'C:\\Users\\Ålesia\\dir with space\\',
    'trailing backslashes\\\\',
    '日本語 ✓ — emoji 🙂',
    '  spaced  '
  ]

  it('gives the CLI exactly the arguments, output and exit code the script gets when run directly', async () => {
    const fixture = await cliFixture()
    for (const detail of awkward) {
      const args = ['progress', 'running', 'Fidelity', '--detail', detail, '--json']
      const direct = await runCli(args, { env: fixture.sessionEnv })
      const native = await runCommand(launcher, args, { env: fixture.sessionEnv })
      expect(native).toEqual(direct)
    }
    const details = fixture.handlers.reportProgress.mock.calls.map(([call]) => call.detail)
    expect(details).toEqual(awkward.flatMap((detail) => [detail, detail]))

    const refused = await runCommand(launcher, ['list'], { env: { ...fixture.sessionEnv, BMN_TOKEN: 's1.x.y.0' } })
    expect(refused).toEqual(await runCli(['list'], { env: { ...fixture.sessionEnv, BMN_TOKEN: 's1.x.y.0' } }))
    expect(refused.code).not.toBe(0)
  })

  it('passes multiline standard input through unchanged', async () => {
    const fixture = await cliFixture()
    const text = 'first line\r\nsecond "quoted" & 100%\nthird ✓\n'

    const native = await runCommand(launcher, ['send', '--text-file', '-'], { env: fixture.sessionEnv, input: text })
    const direct = await runCli(['send', '--text-file', '-'], { env: fixture.sessionEnv, input: text })

    expect(native).toEqual(direct)
    const sent = fixture.handlers.submitInput.mock.calls.map(([call]) => call.text)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(sent[1])
  })

  it('is reached by name from Command Prompt and PowerShell with quoted metacharacters intact', async () => {
    const fixture = await cliFixture()
    const env = { ...fixture.sessionEnv, PATH: `${dirname(launcher)};${process.env.PATH ?? ''}` }
    const cmd = await runCommand(join(system, 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', '"bmn progress running Prompt --detail "a & b ^ c | d 100%""'], { env, verbatim: true })
    const powershell = await runCommand(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "bmn progress running Shell --detail 'a & b ^ c | d 100% $x'; exit $LASTEXITCODE"], { env })

    expect(cmd).toMatchObject({ code: 0, stderr: '' })
    expect(powershell).toMatchObject({ code: 0, stderr: '' })
    expect(fixture.handlers.reportProgress.mock.calls.map(([call]) => [call.label, call.detail])).toEqual([
      ['Prompt', 'a & b ^ c | d 100%'],
      ['Shell', 'a & b ^ c | d 100% $x']
    ])
  })
})

const POWERSHELL_ENTRY = (agent: string): string =>
  `if ($env:BMN_CONTROL_SOCKET -and (Get-Command bmn -ErrorAction SilentlyContinue)) { bmn hook ${agent} }; exit 0`
type EventRow = { event: string; optional: boolean; state: string; unrecognised?: string[] }
const states = (stdout: string): string[] =>
  (JSON.parse(stdout).agents[0].events as EventRow[]).filter((row) => !row.optional).map((row) => row.state)

describe('hook entries in PowerShell form (Story 53.6, Windows)', () => {
  it('writes Claude\'s entry pinned to PowerShell, and check reads every event wired', async () => {
    const path = await hookFileFixture(undefined)

    const install = await runHooks(['install', '--yes', 'claude', '--file', path, '--json'], HOOK_FORM_POWERSHELL)
    const check = await runHooks(['check', 'claude', '--file', path, '--json'], HOOK_FORM_POWERSHELL)

    expect(install.code, install.stderr).toBe(0)
    const written = JSON.parse(await readFile(path, 'utf8'))
    for (const event of CLAUDE_EVENTS) {
      expect(written.hooks[event]).toEqual([{ ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}),
        hooks: [{ type: 'command', timeout: 5, command: POWERSHELL_ENTRY('claude'), shell: 'powershell' }] }])
    }
    expect(states(check.stdout)).toEqual(CLAUDE_EVENTS.map(() => 'wired'))
  })

  it('does not count Claude\'s PowerShell form without "shell": Git Bash would run it; it shows it and adds a pinned one', async () => {
    const loose = { type: 'command', timeout: 5, command: POWERSHELL_ENTRY('claude') }
    const path = await hookFileFixture({ hooks: { Stop: [{ hooks: [loose] }] } })

    const check = await runHooks(['check', 'claude', '--file', path, '--json'], HOOK_FORM_POWERSHELL)
    const install = await runHooks(['install', '--yes', 'claude', '--file', path, '--json'], HOOK_FORM_POWERSHELL)

    const stop = (JSON.parse(check.stdout).agents[0].events as EventRow[]).find((row) => row.event === 'Stop')
    expect(stop).toMatchObject({ state: 'missing', unrecognised: [POWERSHELL_ENTRY('claude')] })
    expect(install.code, install.stderr).toBe(0)
    expect(JSON.parse(await readFile(path, 'utf8')).hooks.Stop).toEqual([{ hooks: [loose] },
      { hooks: [{ ...loose, shell: 'powershell' }] }])
  })

  it.each([['codex', CODEX_EVENTS, 'hooks.json'], ['cursor', CURSOR_EVENTS, 'hooks.json']] as const)(
    'writes %s\'s entries in PowerShell form with no shell field, read back as wired', async (agent, events, name) => {
      const path = await hookFileFixture(undefined, name)

      const install = await runHooks(['install', '--yes', agent, '--file', path, '--json'], HOOK_FORM_POWERSHELL)
      const check = await runHooks(['check', agent, '--file', path, '--json'], HOOK_FORM_POWERSHELL)

      expect(install.code, install.stderr).toBe(0)
      const commands = JSON.stringify(JSON.parse(await readFile(path, 'utf8')))
      expect(commands).toContain(JSON.stringify(POWERSHELL_ENTRY(agent)))
      expect(commands).not.toContain('"shell"')
      expect(states(check.stdout)).toEqual(events.map(() => 'wired'))
    })

  it('shows a POSIX entry on Windows rather than calling it wired: PowerShell cannot run it', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CODEX }] }] } }, 'hooks.json')

    const check = await runHooks(['check', 'codex', '--file', path, '--json'], HOOK_FORM_POWERSHELL)

    expect((JSON.parse(check.stdout).agents[0].events as EventRow[]).find((row) => row.event === 'Stop'))
      .toMatchObject({ state: 'missing', unrecognised: [DOCUMENTED_CODEX] })
  })

  it('writes the form of the OS it runs on when no test chooses one', async () => {
    const path = await hookFileFixture(undefined, 'hooks.json')

    const install = await runHooks(['install', '--yes', 'codex', '--file', path, '--json'], { BMN_TEST_HOOK_SHELL: '' })

    expect(install.code, install.stderr).toBe(0)
    expect(JSON.stringify(JSON.parse(await readFile(path, 'utf8'))))
      .toContain(JSON.stringify(process.platform === 'win32' ? POWERSHELL_ENTRY('codex') : DOCUMENTED_CODEX))
  })

  it('reads a payload PowerShell piped with a byte-order mark in front', async () => {
    const fixture = await cliFixture()
    const proc = await procTree(fixture.root, HOLDS_TERMINAL)

    const result = await runCli(['hook', 'claude'], {
      env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc, CLAUDE_CONFIG_DIR: join(fixture.root, 'claude') },
      input: `\uFEFF${JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting' })}`
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeHookEvent).toHaveBeenCalledTimes(1)
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({ agent: 'claude', event: 'Notification' })
  })
})
