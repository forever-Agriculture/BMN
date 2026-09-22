// MODULE: control-cli.test.ts - the bmn CLI drives a real control server with truthful output and exit codes
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlAuth, writeOwnerToken } from './control-auth'
import { ERROR_CODES } from '@bmn/protocol'
import { ControlError, ControlServer, MemoryReceiptStore, type ControlHandlers } from './control-server'

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

function runCli(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; input?: string } = {}
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('BMN_') || key.startsWith('AITERM_')) delete env[key]
  }
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...env, ...options.env }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeout: 15_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout, stderr })
      }
    )
    child.stdin?.end(options.input ?? '')
  })
}

async function cliFixture() {
  // macOS reaches the temporary folder through a symlink, and the CLI child reports the real path.
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
    reportRefusal: vi.fn<ControlHandlers['reportRefusal']>(),
    observeConversation: vi.fn<ControlHandlers['observeConversation']>(async () => ({ accepted: true, detail: 'observed' })),
    withdrawAttention: vi.fn<ControlHandlers['withdrawAttention']>(async () => ({ withdrawn: true })),
    resolveAttention: vi.fn<ControlHandlers['resolveAttention']>(async () => ({ resolved: true })),
    observeHookEvent: vi.fn<ControlHandlers['observeHookEvent']>(async () => ({ recorded: true })),
    submitInput: vi.fn<ControlHandlers['submitInput']>(async () => undefined)
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
  agentProcess: ProcessStat = HOLDS_TERMINAL
): Promise<CliResult> {
  const proc = await procTree(fixture.root, agentProcess)
  return runCli(['hook', agent], {
    env: { ...fixture.sessionEnv, BMN_PROC_ROOT: proc, CLAUDE_CONFIG_DIR: join(fixture.root, 'claude') },
    input: JSON.stringify(event)
  })
}

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
      'Never run it by hand'
    ]) {
      expect(brief.stdout).toContain(rule)
    }
  })

  it('keeps the printed brief and the documented one identical', async () => {
    const [brief, documentation] = await Promise.all([
      runCli(['help', 'agents']),
      readFile(AGENT_CONTROL_DOC, 'utf8')
    ])
    const fenced = /## A brief for agents[\s\S]*?```text\n([\s\S]*?)```/.exec(documentation)

    expect(fenced?.[1]).toBe(brief.stdout)
  })

  it('names the brief in its usage, and plain help still prints the commands', async () => {
    const usage = await runCli(['help'])

    expect(usage.code).toBe(0)
    expect(usage.stdout).toContain('help [agents]')
    expect(usage.stdout).toContain('Usage: bmn <command> [arguments] [options]')
  })
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
  ])('reports the conversation %s is in when SessionStart says %s, on top of the withdrawals', async (agent, source, extra) => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, agent, {
      hook_event_name: 'SessionStart',
      source,
      session_id: OBSERVED_REFERENCE,
      ...extra
    })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.withdrawAttention.mock.calls.map(([params]) => params.requestKey)).toEqual([
      `${agent}:permission`, `${agent}:question`, `${agent}:turn`
    ])
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
    expect(fixture.handlers.withdrawAttention).toHaveBeenCalledTimes(
      (event as { source?: string }).source === 'compact' ? 0 : 3
    )
  })

  it('keeps the withdrawals when the app refuses the conversation it reported', async () => {
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
    expect(fixture.handlers.withdrawAttention).toHaveBeenCalledTimes(3)
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
const CLAUDE_EVENTS = ['Notification', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt']
const DOCUMENTED_CODEX = DOCUMENTED_CLAUDE.replace('bmn hook claude', 'bmn hook codex')

/** Every hook fixture lives under a fresh temporary folder, so a public clone carries no owner data. */
async function hookFileFixture(contents?: unknown, name = 'settings.json'): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aithooks-')))
  createdRoots.add(root)
  const path = join(root, name)
  if (contents !== undefined) {
    await writeFile(path, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`)
  }
  return path
}

function entryGroup(command: string, timeout = 5): unknown {
  return { hooks: [{ type: 'command', command, timeout }] }
}

async function backupsOf(path: string): Promise<string[]> {
  const entries = await readdir(dirname(path))
  return entries.filter((entry) => entry.startsWith(`${basename(path)}.bmn-backup-`))
}

/** `hooks` is an owner command: no socket, no token, nothing on the wire. */
function runHooks(args: string[], env?: Record<string, string>): Promise<CliResult> {
  return runCli(['hooks', ...args], env === undefined ? {} : { env })
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
    await chmod(path, 0o000)

    const check = await runHooks(['check', 'claude', '--file', path])
    const install = await runHooks(['install', 'claude', '--file', path])
    await chmod(path, 0o600)

    expect(check.code).toBe(1)
    expect(check.stdout).toContain('EACCES')
    expect(install.code).toBe(1)
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

  it('shows Codex PermissionRequest as optional and does not fail the check for it', async () => {
    const codex = CODEX_EVENTS.map((event) => [event, [entryGroup(`bmn hook codex`)]])
    const path = await hookFileFixture({ hooks: Object.fromEntries(codex) }, 'hooks.json')

    const result = await runHooks(['check', 'codex', '--file', path])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/PermissionRequest\s+missing \(optional\)/)
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
    expect(plain.stdout).toContain('timeout 5 bmn hook claude # mine')
    expect(JSON.parse(json.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing', unrecognised: ['timeout 5 bmn hook claude # mine'] })
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
    ['a matcher that is null', null, 'wired'],
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
  ])('refuses a whole file whose matcher is %s, and installs nothing over it', async (_label, matcher) => {
    const path = await hookFileFixture({
      hooks: { PostToolUse: [{ matcher, hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }] }
    })
    const before = await readFile(path, 'utf8')

    const check = await runHooks(['check', 'claude', '--file', path, '--json'])
    const install = await runHooks(['install', 'claude', '--file', path])

    // A matcher of this shape is one the harness itself rejects, and Codex refuses the whole file
    // over it - so no event in it can be reported, and adding a group beside it would not help.
    const report = JSON.parse(check.stdout).agents[0]
    expect(report.state).toBe('unusable')
    expect(report.detail).toContain('matcher')
    expect(report.events.map((row: { state: string }) => row.state))
      .toEqual(report.events.map(() => 'missing'))
    expect(install.code).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it.each(['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'PreToolUse'])(
    'refuses a file whose matcher under %s it cannot read, though it reports no such event',
    async (event) => {
      const path = await hookFileFixture({
        hooks: {
          ...Object.fromEntries(CLAUDE_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CLAUDE)]])),
          [event]: [{ matcher: 42, hooks: [{ type: 'command', timeout: 5, command: 'true' }] }]
        }
      })

      const result = await runHooks(['check', 'claude', '--file', path, '--json'])
      const report = JSON.parse(result.stdout)

      // The events BMN expects are all wired, and it must still not say so: a matcher the harness
      // cannot read stops it loading the file, and those hooks are in the same file.
      expect(result.code).toBe(1)
      expect(report.ok).toBe(false)
      expect(report.agents[0].state).toBe('unusable')
      expect(report.agents[0].detail).toContain(event)
    }
  )

  it.each([
    ['claude', 'settings.json', CLAUDE_EVENTS, DOCUMENTED_CLAUDE, 'read'],
    ['codex', 'hooks.json', CODEX_EVENTS, DOCUMENTED_CODEX, 'unusable']
  ] as const)('reads a list matcher as %s expects', async (agent, file, events, documented, state) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(events.map((each) => [each, [entryGroup(documented)]])),
        PostToolUse: [entryGroup(documented), { matcher: ['Write'], hooks: [{ type: 'command', timeout: 5, command: 'true' }] }]
      }
    }, file)

    const result = await runHooks(['check', agent, '--file', path, '--json'])

    // Claude Code takes a list of patterns; Codex's matcher is one optional pattern, so a list
    // fails its schema and its loader refuses the whole file. The rule is per harness.
    expect(JSON.parse(result.stdout).agents[0].state).toBe(state)
  })

  it('refuses a file holding something that is not a hook group', async () => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CLAUDE_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CLAUDE)]])),
        Stop: [entryGroup(DOCUMENTED_CLAUDE), 'oops']
      }
    })
    const before = await readFile(path, 'utf8')

    const check = await runHooks(['check', 'claude', '--file', path, '--json'])
    const install = await runHooks(['install', 'claude', '--file', path])

    expect(JSON.parse(check.stdout).agents[0].state).toBe('unusable')
    expect(JSON.parse(check.stdout).agents[0].detail).toContain('not a hook group')
    expect(install.code).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it.each([
    ['a variation selector', 'bmn hook claude\ufe0f', 'bmn hook claude\\u{fe0f}'],
    ['a combining grapheme joiner', 'bmn\u034fhook claude', 'bmn\\u{34f}hook claude'],
    ['an astral character', 'bmn hook claude \u{1f600}', 'bmn hook claude \\u{1f600}'],
    // The literal text and the character it names must not print the same, or the note cannot be
    // trusted to mean what it says.
    ['the text of an escape', '\\u00a0bmn hook claude', '\\\\u00a0bmn hook claude']
  ])('prints %s as its code point rather than as itself', async (_label, command, shown) => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(command)] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    expect(JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').unrecognised).toEqual([shown])
  })

  it('never cuts an escape in half when it shortens a long entry', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [entryGroup(`bmn hook claude ${'a'.repeat(100)}\u00a0${'b'.repeat(40)}`)] }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const shown = JSON.parse(result.stdout).agents[0].events
      .find((row: { event: string }) => row.event === 'Stop').unrecognised[0]

    expect(shown.endsWith('\u2026')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(120)
    // A trailing `\u00a` would name a character that is not the one in the file.
    expect(/\\u[0-9a-f]{0,3}\u2026$/.test(shown)).toBe(false)
  })

  it('shows the invisible character that stopped an entry being recognised', async () => {
    const path = await hookFileFixture({
      hooks: {
        Stop: [entryGroup('\u00a0bmn hook claude')],
        Notification: [entryGroup('bmn\rhook\rclaude')]
      }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const events = JSON.parse(result.stdout).agents[0].events

    // Folding the whitespace away would print `bmn hook claude` under a line saying that is not an
    // entry BMN recognises - true, self-contradictory, and with the cause erased.
    expect(events.find((row: { event: string }) => row.event === 'Stop').unrecognised)
      .toEqual(['\\u{a0}bmn hook claude'])
    expect(events.find((row: { event: string }) => row.event === 'Notification').unrecognised)
      .toEqual(['bmn\\u{d}hook\\u{d}claude'])
  })

  it('says what check recognises in its own usage text', async () => {
    const result = await runHooks(['--help'])

    // Nothing else pins this text, and it described the deleted grammar for one whole revision.
    expect(result.stdout).toContain('wired for the entry BMN writes')
    expect(result.stdout).toContain('$AITERM_CONTROL_SOCKET')
    expect(result.stdout).toContain('apart from space, tab and newline')
    expect(result.stdout).toContain('inside a matcher')
  })

  it('names an entry whose only difference is whitespace', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup('bmn  hook\tclaude')] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    // The verdict compares the command as bash would read it; the note may look past any
    // whitespace at all, because the owner needs to see the entry however it is spaced.
    expect(JSON.parse(result.stdout).agents[0].events.find((row: { event: string }) => row.event === 'Stop'))
      .toEqual({ event: 'Stop', optional: false, state: 'missing', unrecognised: ['bmn hook claude'] })
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
    ['a group whose hooks is not a list', { hooks: 'echo hi' }, 'is not a list'],
    ['an entry that is not an object', { hooks: ['echo hi'] }, 'not an object'],
    ['an entry whose command is not a string', { hooks: [{ type: 'command', command: 5 }] }, '"command" is not a string'],
    ['an entry whose timeout is not a number', { hooks: [{ type: 'command', command: 'true', timeout: '5' }] }, '"timeout" is not a number'],
    ['an entry whose type is not a string', { hooks: [{ type: 7, command: 'true' }] }, '"type" is not a string']
  ])('refuses a file holding %s', async (_label, group, detail) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CLAUDE_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CLAUDE)]])),
        Stop: [entryGroup(DOCUMENTED_CLAUDE), group]
      }
    })
    const before = await readFile(path, 'utf8')

    const check = await runHooks(['check', 'claude', '--file', path, '--json'])
    const install = await runHooks(['install', 'claude', '--file', path])

    // A field of the wrong type fails the same strict parse a matcher of the wrong type fails, so
    // the file does not load and none of its hooks run - including the ones BMN expects.
    const report = JSON.parse(check.stdout)
    expect(report.ok).toBe(false)
    expect(report.agents[0].state).toBe('unusable')
    expect(report.agents[0].detail).toContain(detail)
    expect(install.code).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it.each([
    ['a key no harness event is named by', '_comment', ['owner note']],
    ['an event this harness does not have', 'Notification', [{ matcher: ['Write'], hooks: [] }]]
  ])('leaves %s alone rather than refusing the file', async (_label, key, value) => {
    const path = await hookFileFixture({
      hooks: {
        ...Object.fromEntries(CODEX_EVENTS.map((each) => [each, [entryGroup(DOCUMENTED_CODEX)]])),
        [key]: value
      }
    }, 'hooks.json')

    const result = await runHooks(['check', 'codex', '--file', path, '--json'])

    // Both harnesses ignore keys they do not recognise, so refusing over one would stop `install`
    // on a file that works. Refusing a real file is not a safer answer than reading it.
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).agents[0].state).toBe('read')
  })

  it('claims nothing about any event in a file it cannot add to', async () => {
    const path = await hookFileFixture({
      hooks: { Stop: [entryGroup(DOCUMENTED_CLAUDE)], Notification: 'not a list' }
    })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])
    const report = JSON.parse(result.stdout).agents[0]

    // `install` cannot merge into this file, so `check` reports nothing about it rather than a
    // wired event beside an event it could not read: a half-read file is not a report.
    expect(result.code).toBe(1)
    expect(report.state).toBe('unusable')
    expect(report.events.map((row: { state: string }) => row.state)).toEqual(report.events.map(() => 'missing'))
  })

  it('shortens a long unrecognised entry to one line', async () => {
    const written = `bmn hook claude\n${'# padding '.repeat(30)}`
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(written)] } })

    const result = await runHooks(['check', 'claude', '--file', path, '--json'])

    const row = JSON.parse(result.stdout).agents[0].events.find((r: { event: string }) => r.event === 'Stop')
    expect(row.unrecognised[0]).toHaveLength(120)
    expect(row.unrecognised[0].endsWith('…')).toBe(true)
    expect(row.unrecognised[0]).not.toContain('\n')
  })

  it('leaves an unrecognised entry exactly as it was when install adds its own beside it', async () => {
    const written = 'timeout 5 bmn hook claude'
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(written)] } })

    const install = await runHooks(['install', 'claude', '--file', path])
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
        `echo yes >> ${ran}`, 'exit 0', ''].join('\n'),
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
        const child = execFile('/bin/bash', ['-c', `${command}\nwait`], {
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, BMN_CONTROL_SOCKET: '/x', AITERM_CONTROL_SOCKET: '/x' },
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

      expect((await runHooks(['install', agent, '--file', path])).code).toBe(0)
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
    expect(report.agents.map((agent: { agent: string }) => agent.agent)).toEqual(['claude', 'codex'])
    expect(report.agents[0].file).toBe(join(home.root, '.claude', 'settings.json'))
    expect(report.agents[1].file).toBe(join(codexHome, 'hooks.json'))
    expect(report.agents[0].events.find((row: { event: string }) => row.event === 'Stop').state).toBe('wired')
    expect(report.agents[1].events.every((row: { state: string }) => row.state === 'missing')).toBe(true)
    expect(result.code).toBe(1)
  })

  it('installs into the harness own file when no --file says otherwise', async () => {
    const home = await cliFixture()
    const codexHome = join(home.root, 'moved-codex')
    const env = { HOME: home.root, CODEX_HOME: codexHome }

    const install = await runHooks(['install', 'codex'], env)
    const check = await runHooks(['check', 'codex'], env)

    expect(install.code).toBe(0)
    expect(install.stdout).toContain(join(codexHome, 'hooks.json'))
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
  it('adds only the missing entries, keeps foreign hooks byte for byte and leaves an older wording alone', async () => {
    const foreign = entryGroup('echo foreign', 9)
    const path = await hookFileFixture({
      theme: 'dark',
      hooks: { PostToolUse: [{ matcher: 'Write', ...(foreign as object) }], Stop: [entryGroup(OLDER_CLAUDE)] }
    })
    const before = JSON.parse(await readFile(path, 'utf8'))

    const install = await runHooks(['install', 'claude', '--file', path])
    const after = JSON.parse(await readFile(path, 'utf8'))

    expect(install.code).toBe(0)
    expect(after.theme).toBe('dark')
    // The foreign entry and the older-wording entry are exactly what they were.
    expect(after.hooks.PostToolUse[0]).toEqual(before.hooks.PostToolUse[0])
    expect(after.hooks.Stop).toEqual(before.hooks.Stop)
    expect(after.hooks.PostToolUse[1]).toEqual({ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] })
    for (const event of ['Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']) {
      expect(after.hooks[event]).toEqual([{ hooks: [{ type: 'command', timeout: 5, command: DOCUMENTED_CLAUDE }] }])
    }
    expect(install.stdout).toContain('Notification, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd')
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

    const install = await runHooks(['install', 'claude', '--file', path])
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

    const install = await runHooks(['install', 'claude', '--file', path])
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
    await symlink(real, link)

    const install = await runHooks(['install', 'claude', '--file', link])

    expect(install.code).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(real, 'utf8')).hooks)).toEqual(CLAUDE_EVENTS)
    expect((await stat(real)).mode & 0o777).toBe(0o640)
  })

  it('writes through a symlinked parent to the file the kernel would, not one of the same name', async () => {
    // alias -> real/nested, and real/nested/settings.json -> ../target.json. The kernel lands on
    // real/target.json; resolving the written path lexically would land on target.json beside alias
    // and overwrite whatever is there.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await mkdir(join(root, 'real', 'nested'), { recursive: true })
    await symlink(join('real', 'nested'), join(root, 'alias'))
    await symlink(join('..', 'target.json'), join(root, 'real', 'nested', 'settings.json'))
    await writeFile(join(root, 'target.json'), 'SENTINEL: nothing to do with any harness\n')
    await writeFile(join(root, 'real', 'target.json'), '{"real":"target"}\n')

    const install = await runHooks(['install', 'claude', '--file', join(root, 'alias', 'settings.json')])

    expect(install.code).toBe(0)
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
    await symlink(join('real', 'nested'), join(root, 'branch'))
    await symlink('branch/../target.json', join(root, 'settings.json'))
    await writeFile(join(root, 'target.json'), 'SENTINEL: nothing to do with any harness\n')
    await writeFile(join(root, 'real', 'target.json'), '{"real":true}\n')

    const install = await runHooks(['install', 'claude', '--file', join(root, 'settings.json')])

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

    const install = await runHooks(['install', 'claude', '--file', join(root, 'settings.json')])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('which does not exist; resolve it by hand')
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
    await symlink(join(root, 'cfg', 'claude'), join(root, 'x'))

    const install = await runHooks(['install', 'claude', '--file', `${join(root, 'x')}/../settings.json`])

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
    await symlink(join(root, 'cfg', 'claude'), join(root, 'x'))

    const install = await runHooks(['install', 'claude'], { CLAUDE_CONFIG_DIR: `${join(root, 'x')}/..` })

    expect(install.code).toBe(0)
    expect(Object.keys(JSON.parse(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).hooks))
      .toEqual(CLAUDE_EVENTS)
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
  })

  it('refuses a .. that steps back through a component of the given path that is not there', async () => {
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))
    await writeFile(join(root, 'settings.json'), 'SENTINEL\n')

    const install = await runHooks(['install', 'claude', '--file', `${join(root, 'none')}/../settings.json`])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('which does not exist; resolve it by hand')
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('SENTINEL\n')
  })

  it('still creates a config directory that simply does not exist yet', async () => {
    // The refusal above must not catch the fresh machine, which is what install is for.
    const root = dirname(await hookFileFixture({ hooks: {} }, 'unused.json'))

    const install = await runHooks(['install', 'codex', '--file', join(root, 'fresh', 'hooks.json')])

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

    const install = await runHooks(['install', 'claude', '--file', join(root, 'l12.json')])

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

    const install = await runHooks(['install', 'claude', '--file', link])

    expect(install.code).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(real, 'utf8')).hooks)).toEqual(CLAUDE_EVENTS)
  })

  it('refuses rather than overwriting a file another writer changed while it was reading', async () => {
    const path = await hookFileFixture({ hooks: {} })

    // A handshake, not a race: the installer says when it is between its read and its rename, the
    // other writer goes then, and only then is the installer let go.
    const gate = join(dirname(path), 'gate')
    const installing = runHooks(['install', 'claude', '--file', path], { BMN_HOOKS_TEST_GATE: gate })
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

    const install = await runHooks(['install', 'claude', '--file', path])
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

    const install = await runHooks(['install', 'claude', '--file', path])
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

    const install = await runHooks(['install', 'claude', '--file', path])

    expect(install.code).toBe(0)
    expect(install.stdout).toContain('Nothing to do')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await backupsOf(path)).toEqual([])
  })

  it('leaves an unparsable file untouched, writes no backup and exits 1', async () => {
    const broken = '{ "hooks": { "Stop": [ }'
    const path = await hookFileFixture(broken)

    const install = await runHooks(['install', 'claude', '--file', path])

    expect(install.code).toBe(1)
    expect(install.stderr).toContain('not valid JSON')
    expect(await readFile(path, 'utf8')).toBe(broken)
    expect(await backupsOf(path)).toEqual([])
  })

  it('tells the owner about the Codex trust step, and only for Codex', async () => {
    const codexPath = await hookFileFixture({}, 'hooks.json')
    const claudePath = await hookFileFixture({})

    const codex = await runHooks(['install', 'codex', '--file', codexPath])
    const claude = await runHooks(['install', 'claude', '--file', claudePath])

    // The whole sentence, not just "/hooks": the fixture's own path ends in hooks.json.
    expect(codex.stdout).toContain('Codex must trust the hooks once: run /hooks in Codex.')
    expect(codex.stdout).toContain('reports configuration, not that a hook fired')
    expect(claude.stdout).not.toContain('trust the hooks once')
    // Install writes the required events only; PermissionRequest stays the owner's own choice.
    expect(Object.keys(JSON.parse(await readFile(codexPath, 'utf8')).hooks)).toEqual(CODEX_EVENTS)
  })

  it('leaves check reporting everything wired afterwards', async () => {
    const path = await hookFileFixture({ hooks: { Stop: [entryGroup(OLDER_CLAUDE)] } })

    await runHooks(['install', 'claude', '--file', path])
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
      PostToolUse: { tool_name: 'Bash', tool_input: {} },
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
        await runHook(fixture, agent, { hook_event_name: event, ...(payloads[event] as object) })
        const after = fixture.handlers.openAttention.mock.calls.length +
          fixture.handlers.withdrawAttention.mock.calls.length +
          fixture.handlers.resolveAttention.mock.calls.length
        expect(after, `${agent} ${event} changed nothing in Needs you`).toBeGreaterThan(before)
        expect(fixture.handlers.observeHookEvent, `${agent} ${event} was not logged`).toHaveBeenCalled()
      }
    }
  })
})
