// MODULE: control-cli.test.ts - the bmn CLI drives a real control server with truthful output and exit codes
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    ['an invalid attention kind', ['ask', 'q1', 'Deploy?', '--kind', 'urgent']]
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

  it('carries an unfamiliar but printable event name, which is what the log is for', async () => {
    const fixture = await cliFixture()

    const result = await runHook(fixture, 'claude', { hook_event_name: 'Custom-Event' })

    expect(result).toEqual(QUIET)
    expect(fixture.handlers.observeHookEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'Custom-Event',
      effects: []
    })
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
