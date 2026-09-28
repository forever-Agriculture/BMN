// MODULE: control-server.test.ts - the control socket authenticates, targets, validates and deduplicates requests
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ERROR_CODES, MAX_CONTROL_FRAME_BYTES } from '@bmn/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlAuth } from './control-auth'
import {
  ControlError,
  ControlServer,
  MemoryReceiptStore,
  type ControlHandlers,
  type ReceiptStore
} from './control-server'

interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data: { code: string; retryable: boolean } }
}

const NOW = new Date('2026-09-14T12:00:00.000Z')
const createdRoots = new Set<string>()
const servers = new Set<ControlServer>()
const clients = new Set<TestClient>()

afterEach(async () => {
  for (const client of clients) client.destroy()
  clients.clear()
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

class TestClient {
  closed = false
  private buffer = ''
  private nextId = 1
  private readonly inbox: RpcResponse[] = []
  private readonly waiters = new Set<() => void>()

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        this.inbox.push(JSON.parse(this.buffer.slice(0, newline)) as RpcResponse)
        this.buffer = this.buffer.slice(newline + 1)
        newline = this.buffer.indexOf('\n')
      }
      this.wake()
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.closed = true
      this.wake()
    })
  }

  static connect(path: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.off('error', reject)
        const client = new TestClient(socket)
        clients.add(client)
        resolve(client)
      })
    })
  }

  write(payload: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(payload, (error) => (error ? reject(error) : resolve()))
    })
  }

  async next(): Promise<RpcResponse> {
    while (this.inbox.length === 0) {
      if (this.closed) throw new Error('Connection closed without a response')
      await this.waitForEvent()
    }
    return this.inbox.shift() as RpcResponse
  }

  async request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId
    this.nextId += 1
    await this.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    const response = await this.next()
    expect(response.id).toBe(id)
    return response
  }

  async untilClosed(): Promise<void> {
    while (!this.closed) await this.waitForEvent()
  }

  destroy(): void {
    this.socket.destroy()
  }

  private waitForEvent(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve))
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
  }
}

function fakeHandlers(current: Map<string, string>) {
  return {
    isCurrentIncarnation: vi.fn((sessionId: string, incarnationId: string) => current.get(sessionId) === incarnationId),
    sessionExists: vi.fn((sessionId: string) => current.has(sessionId)),
    snapshot: vi.fn(async (): Promise<unknown> => ({ watermark: 7, sessions: [] })),
    listSessions: vi.fn(async (): Promise<unknown> => [{ sessionId: 'session-1', name: 'one' }]),
    publishArtifact: vi.fn(async (p: Parameters<ControlHandlers['publishArtifact']>[0]): Promise<unknown> => ({
      artifactId: `artifact-for-${p.path}`
    })),
    reportProgress: vi.fn(async (): Promise<unknown> => ({ recorded: true })),
    openAttention: vi.fn(async (): Promise<unknown> => ({ opened: true })),
    prepareHandoff: vi.fn(async (): Promise<unknown> => ({ draftId: 'draft-1', requestId: 'request-1', state: 'draft' })),
    reportRefusal: vi.fn(),
    observeConversation: vi.fn(async (): Promise<unknown> => ({ accepted: true, detail: 'observed' })),
    withdrawAttention: vi.fn(async (): Promise<unknown> => ({ withdrawn: true })),
    resolveAttention: vi.fn(async (): Promise<unknown> => ({ resolved: true })),
    observeHookEvent: vi.fn(async (): Promise<unknown> => ({ recorded: true })),
    reportUsage: vi.fn(async (): Promise<unknown> => ({ recorded: true })),
    submitInput: vi.fn(async (): Promise<void> => undefined),
    takeAnswers: vi.fn(async (): Promise<unknown> => ({ answers: [] })),
    reportResumeCommand: vi.fn(async (p: Parameters<ControlHandlers['reportResumeCommand']>[0]): Promise<unknown> =>
      ({ recorded: true, argv: [...p.argv], reportedAt: '2026-09-29T10:15:00.000Z' })),
    clearResumeCommand: vi.fn(async (): Promise<unknown> => ({ cleared: true }))
  } satisfies ControlHandlers
}

async function serverFixture(receipts: ReceiptStore = new MemoryReceiptStore()) {
  const root = await mkdtemp(join(tmpdir(), 'aitcs-'))
  createdRoots.add(root)
  const socketPath = join(root, 'ctl', 'control.sock')
  expect(socketPath.length).toBeLessThan(100)
  const auth = new ControlAuth()
  const current = new Map([['session-1', 'incarnation-1'], ['session-2', 'incarnation-2']])
  const handlers = fakeHandlers(current)
  const server = new ControlServer({ socketPath, auth, handlers, receipts, now: () => NOW })
  await server.listen()
  servers.add(server)
  return { root, socketPath, auth, current, handlers, receipts, server }
}

type Fixture = Awaited<ReturnType<typeof serverFixture>>

async function authenticated(fixture: Fixture, token: string): Promise<TestClient> {
  const client = await TestClient.connect(fixture.socketPath)
  const response = await client.request('auth', { token })
  expect(response.error).toBeUndefined()
  return client
}

const OBSERVED_REFERENCE = '01a0b657-21a8-7f00-addd-b73646828f5b'

function sessionToken(fixture: Fixture, sessionId = 'session-1', incarnationId = 'incarnation-1'): string {
  return fixture.auth.sessionToken(sessionId, incarnationId)
}

function expectError(response: RpcResponse, code: string): void {
  expect(response.result).toBeUndefined()
  expect(response.error).toMatchObject({ code: -32000, data: { code } })
  expect(typeof response.error?.data.retryable).toBe('boolean')
}

async function leaveStaleSocket(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const script = `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
}

describe('control server authentication', () => {
  it('requires auth as the first request and closes the connection otherwise', async () => {
    const fixture = await serverFixture()
    const client = await TestClient.connect(fixture.socketPath)

    expectError(await client.request('state.snapshot', { token: fixture.auth.ownerToken }), ERROR_CODES.unauthorized)
    await client.untilClosed()
    expect(fixture.handlers.snapshot).not.toHaveBeenCalled()
  })

  it('reports owner and session scopes and passes them to handlers', async () => {
    const fixture = await serverFixture()
    const owner = await TestClient.connect(fixture.socketPath)
    expect((await owner.request('auth', { token: fixture.auth.ownerToken })).result).toEqual({ scope: 'owner' })
    expect((await owner.request('state.snapshot')).result).toEqual({ watermark: 7, sessions: [] })
    expect(fixture.handlers.snapshot).toHaveBeenLastCalledWith({ kind: 'owner' })

    const session = await TestClient.connect(fixture.socketPath)
    expect((await session.request('auth', { token: sessionToken(fixture) })).result).toEqual({
      scope: 'session',
      sessionId: 'session-1'
    })
    expect((await session.request('session.list', {})).result).toEqual([{ sessionId: 'session-1', name: 'one' }])
    expect(fixture.handlers.listSessions).toHaveBeenLastCalledWith({
      kind: 'session',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1'
    })
    expectError(await session.request('auth', { token: sessionToken(fixture) }), ERROR_CODES.invalidArgument)
  })

  it.each([
    ['forged', (fixture: Fixture) => ({ token: `${sessionToken(fixture).slice(0, -4)}0000` })],
    ['non-string', () => ({ token: 42 })],
    ['missing', () => ({})],
    ['foreign owner', () => ({ token: new ControlAuth().ownerToken })]
  ])('rejects a %s credential and closes', async (_label, params) => {
    const fixture = await serverFixture()
    const client = await TestClient.connect(fixture.socketPath)

    const response = await client.request('auth', params(fixture))

    expectError(response, ERROR_CODES.unauthorized)
    await client.untilClosed()
  })

  it('rejects unknown auth parameters and closes', async () => {
    const fixture = await serverFixture()
    const client = await TestClient.connect(fixture.socketPath)

    expectError(
      await client.request('auth', { token: fixture.auth.ownerToken, scope: 'owner' }),
      ERROR_CODES.invalidArgument
    )
    await client.untilClosed()
  })

  it('rejects a session token whose incarnation is no longer current', async () => {
    const fixture = await serverFixture()
    const client = await TestClient.connect(fixture.socketPath)

    const response = await client.request('auth', { token: sessionToken(fixture, 'session-1', 'incarnation-old') })

    expectError(response, ERROR_CODES.unauthorized)
    expect(response.error?.message).toMatch(/revoked/i)
    await client.untilClosed()
  })

  it('revokes an open connection once its incarnation is replaced', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    fixture.current.set('session-1', 'incarnation-new')

    const response = await client.request('progress.report', { source: 'agent', state: 'running', label: 'Working' })

    expectError(response, ERROR_CODES.unauthorized)
    expect(response.error?.message).toMatch(/revoked/i)
    await client.untilClosed()
    expect(fixture.handlers.reportProgress).not.toHaveBeenCalled()
  })
})

describe('conversation observation from a session hook', () => {
  it('passes the session, its incarnation and a lowercased reference to the handler', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    const response = await client.request('conversation.observe', {
      agentCli: 'codex',
      conversationReference: OBSERVED_REFERENCE.toUpperCase(),
      source: 'clear',
      transcriptPath: '/home/owner/.codex/sessions/rollout.jsonl'
    })

    expect(response.result).toEqual({ accepted: true, detail: 'observed' })
    expect(fixture.handlers.observeConversation).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      agentCli: 'codex',
      conversationReference: OBSERVED_REFERENCE,
      source: 'clear',
      transcriptPath: '/home/owner/.codex/sessions/rollout.jsonl'
    })
  })

  it('refuses the owner token, which keeps its own explicit replace route', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    expectError(
      await client.request('conversation.observe', {
        sessionId: 'session-1',
        agentCli: 'claude',
        conversationReference: OBSERVED_REFERENCE,
        source: 'startup'
      }),
      ERROR_CODES.unauthorized
    )
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
  })

  it('refuses a session credential that names another session', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    expectError(
      await client.request('conversation.observe', {
        sessionId: 'session-2',
        agentCli: 'claude',
        conversationReference: OBSERVED_REFERENCE,
        source: 'startup'
      }),
      ERROR_CODES.unauthorized
    )
    expect(fixture.handlers.observeConversation).not.toHaveBeenCalled()
  })

  it('records the refusal reason, which the hook itself throws away', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    expectError(
      await client.request('conversation.observe', {
        agentCli: 'claude',
        conversationReference: 'not-a-uuid-at-all-not-a-uuid-at-all1',
        source: 'startup'
      }),
      ERROR_CODES.invalidArgument
    )

    expect(fixture.handlers.reportRefusal).toHaveBeenLastCalledWith(
      'conversation.observe',
      'session-1',
      'conversationReference must be a UUID'
    )
  })
})

describe('control server targeting', () => {
  it('lets session credentials default to and only target their own session', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('progress.report', { source: 'agent', state: 'running', label: 'Working' })
    expect(fixture.handlers.reportProgress).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      source: 'agent',
      state: 'running',
      label: 'Working',
      // A report that names nothing carries an empty list, never the previous report's files.
      evidenceIds: [],
      observedAt: NOW.toISOString()
    })

    await client.request('progress.report', {
      source: 'agent', state: 'verified', label: 'Checks passed', evidenceIds: ['art-2', 'art-1']
    })
    expect(fixture.handlers.reportProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-1', evidenceIds: ['art-2', 'art-1'] })
    )

    expectError(
      await client.request('attention.withdraw', { sessionId: 'session-2', requestKey: 'q1' }),
      ERROR_CODES.unauthorized
    )
    expect(fixture.handlers.withdrawAttention).not.toHaveBeenCalled()

    const own = await client.request('attention.withdraw', { sessionId: 'session-1', requestKey: 'q1' })
    expect(own.result).toEqual({ withdrawn: true })
    expect(fixture.handlers.withdrawAttention).toHaveBeenLastCalledWith({ sessionId: 'session-1', requestKey: 'q1' })
  })

  it('requires owner requests to name an existing session', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    expectError(
      await client.request('attention.resolve', { requestKey: 'q1', resolution: 'approved' }),
      ERROR_CODES.invalidArgument
    )
    expectError(
      await client.request('attention.resolve', { sessionId: 'session-9', requestKey: 'q1', resolution: 'approved' }),
      ERROR_CODES.notFound
    )
    expect(fixture.handlers.resolveAttention).not.toHaveBeenCalled()

    await client.request('attention.resolve', { sessionId: 'session-2', requestKey: 'q1', resolution: 'approved' })
    expect(fixture.handlers.resolveAttention).toHaveBeenLastCalledWith({
      sessionId: 'session-2',
      requestKey: 'q1',
      resolution: 'approved'
    })
  })

  it('marks artifact sources by credential kind', async () => {
    const fixture = await serverFixture()
    const owner = await authenticated(fixture, fixture.auth.ownerToken)
    const agent = await authenticated(fixture, sessionToken(fixture))

    await owner.request('artifact.publish', { sessionId: 'session-2', path: '/tmp/a.txt', idempotencyKey: 'k1' })
    await agent.request('artifact.publish', { path: '/tmp/b.txt', name: 'b', idempotencyKey: 'k1' })

    expect(fixture.handlers.publishArtifact.mock.calls.map(([call]) => call)).toEqual([
      { sessionId: 'session-2', incarnationId: null, path: '/tmp/a.txt', source: 'owner' },
      { sessionId: 'session-1', incarnationId: 'incarnation-1', path: '/tmp/b.txt', name: 'b', source: 'agent' }
    ])
  })
})

describe('a program reporting how to resume it (Story 43.1)', () => {
  it('takes the command exactly, for the reporting session\'s own running process only', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const argv = ['my-agent', '--resume', 'ses 1', '']

    const recorded = await client.request('resume.report', { argv, idempotencyKey: 'resume-1' })
    expect(recorded.result).toEqual({ recorded: true, argv, reportedAt: '2026-09-29T10:15:00.000Z' })
    expect(fixture.handlers.reportResumeCommand).toHaveBeenLastCalledWith({ sessionId: 'session-1', incarnationId: 'incarnation-1', argv })
    // A retry with the same key is the same report: it is answered from the receipt, not recorded twice.
    expect((await client.request('resume.report', { argv, idempotencyKey: 'resume-1' })).result).toMatchObject({ duplicate: true })
    expect(fixture.handlers.reportResumeCommand).toHaveBeenCalledTimes(1)

    // A token for session 1 can neither set nor clear session 2's command.
    expectError(await client.request('resume.report', { sessionId: 'session-2', argv }), ERROR_CODES.unauthorized)
    expectError(await client.request('resume.clear', { sessionId: 'session-2' }), ERROR_CODES.unauthorized)
    expect((await client.request('resume.clear', { idempotencyKey: 'clear-1' })).result).toEqual({ cleared: true })
    expect(fixture.handlers.clearResumeCommand).toHaveBeenLastCalledWith({ sessionId: 'session-1', incarnationId: 'incarnation-1' })
  })

  it('refuses the owner token, and a process that is no longer the session\'s running one', async () => {
    const fixture = await serverFixture()
    const owner = await authenticated(fixture, fixture.auth.ownerToken)
    expectError(await owner.request('resume.report', { sessionId: 'session-1', argv: ['my-agent'] }), ERROR_CODES.unauthorized)
    expectError(await owner.request('resume.clear', { sessionId: 'session-1' }), ERROR_CODES.unauthorized)
    const agent = await authenticated(fixture, sessionToken(fixture))
    fixture.current.set('session-1', 'incarnation-9')
    expectError(await agent.request('resume.report', { argv: ['my-agent'] }), ERROR_CODES.unauthorized)
    expect(fixture.handlers.reportResumeCommand).not.toHaveBeenCalled()
    expect(fixture.handlers.clearResumeCommand).not.toHaveBeenCalled()
  })

  it.each([
    ['no command', {}, 'The command is missing'],
    ['a path', { argv: ['/opt/bin/my-agent'] }, 'not a path'],
    ['65 parts', { argv: Array.from({ length: 65 }, () => 'x') }, 'at most 64'],
    ['a long part', { argv: ['my-agent', 'x'.repeat(1025)] }, 'each may be at most 1024'],
    ['too much in all', { argv: ['my-agent', ...Array.from({ length: 9 }, () => 'x'.repeat(1000))] }, 'at most 8192'],
    ['an escape', { argv: ['my-agent', '\u001b[2J'] }, 'control or invisible formatting character'],
    ['an unknown parameter', { argv: ['my-agent'], shell: true }, 'Unknown parameter: shell']
  ])('refuses %s with the rule it broke', async (_label, params, rule) => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const response = await client.request('resume.report', params)
    expectError(response, ERROR_CODES.invalidArgument)
    expect(response.error?.message).toContain(rule)
    expect(fixture.handlers.reportResumeCommand).not.toHaveBeenCalled()
  })
})

describe('control server handoff preparation', () => {
  const handoff = {
    destinationSessionId: 'session-2',
    text: 'A bounded result',
    artifactIds: ['published-1'],
    idempotencyKey: 'handoff-1'
  }

  it('refuses the owner token and rejects closed params', async () => {
    const fixture = await serverFixture()
    const owner = await authenticated(fixture, fixture.auth.ownerToken)
    expectError(await owner.request('handoff.prepare', handoff), ERROR_CODES.unauthorized)
    expect(fixture.handlers.prepareHandoff).not.toHaveBeenCalled()

    const agent = await authenticated(fixture, sessionToken(fixture))
    expectError(
      await agent.request('handoff.prepare', { ...handoff, extra: true }),
      ERROR_CODES.invalidArgument
    )
    expect(fixture.handlers.prepareHandoff).not.toHaveBeenCalled()
  })

  it('derives the source session and incarnation and forwards the destination and files', async () => {
    const fixture = await serverFixture()
    const agent = await authenticated(fixture, sessionToken(fixture))

    const response = await agent.request('handoff.prepare', handoff)

    expect(response.result).toEqual({ draftId: 'draft-1', requestId: 'request-1', state: 'draft' })
    expect(fixture.handlers.prepareHandoff).toHaveBeenLastCalledWith({
      sourceSessionId: 'session-1',
      sourceIncarnationId: 'incarnation-1',
      destinationSessionId: 'session-2',
      text: 'A bounded result',
      artifactIds: ['published-1']
    })
  })

  it.each([
    ['missing text', { ...handoff, text: undefined }],
    ['carriage return', { ...handoff, text: 'line\rbreak' }],
    ['oversized text', { ...handoff, text: 'x'.repeat(16 * 1024 + 1) }],
    ['too many files', { ...handoff, artifactIds: Array.from({ length: 11 }, (_, index) => `file-${index}`) }],
    ['non-array files', { ...handoff, artifactIds: 'published-1' }]
  ])('rejects %s before invoking the handler', async (_label, params) => {
    const fixture = await serverFixture()
    const agent = await authenticated(fixture, sessionToken(fixture))

    expectError(await agent.request('handoff.prepare', params), ERROR_CODES.invalidArgument)
    expect(fixture.handlers.prepareHandoff).not.toHaveBeenCalled()
  })

  it('replays durable idempotency and refuses a rekeyed request', async () => {
    const fixture = await serverFixture()
    const agent = await authenticated(fixture, sessionToken(fixture))

    const first = await agent.request('handoff.prepare', handoff)
    const duplicate = await agent.request('handoff.prepare', handoff)
    const conflict = await agent.request('handoff.prepare', { ...handoff, text: 'Changed result' })

    expect(first.result).toEqual({ draftId: 'draft-1', requestId: 'request-1', state: 'draft' })
    expect(duplicate.result).toEqual({ draftId: 'draft-1', requestId: 'request-1', state: 'draft', duplicate: true })
    expectError(conflict, ERROR_CODES.revisionConflict)
    expect(conflict.error?.message).toBe('idempotency key reused with different parameters')
    expect(fixture.handlers.prepareHandoff).toHaveBeenCalledTimes(1)
  })
})

describe('control server validation', () => {
  it.each([
    ['params array', 'progress.report', ['running']],
    ['unknown key', 'progress.report', { source: 'a', state: 'running', label: 'x', extra: true }],
    ['bad state', 'progress.report', { source: 'a', state: 'done', label: 'x' }],
    ['empty label', 'progress.report', { source: 'a', state: 'running', label: '' }],
    ['long label', 'progress.report', { source: 'a', state: 'running', label: 'x'.repeat(201) }],
    ['long source', 'progress.report', { source: 's'.repeat(65), state: 'running', label: 'x' }],
    ['control character label', 'progress.report', { source: 'a', state: 'running', label: 'a[2Jb' }],
    ['non-string detail', 'progress.report', { source: 'a', state: 'running', label: 'x', detail: 5 }],
    ['bad observedAt', 'progress.report', { source: 'a', state: 'running', label: 'x', observedAt: 'yesterday' }],
    ['evidence not an array', 'progress.report', { source: 'a', state: 'running', label: 'x', evidenceIds: 'a1' }],
    ['non-string evidence', 'progress.report', { source: 'a', state: 'running', label: 'x', evidenceIds: [1] }],
    ['empty evidence id', 'progress.report', { source: 'a', state: 'running', label: 'x', evidenceIds: [''] }],
    ['control character evidence id', 'progress.report',
      { source: 'a', state: 'running', label: 'x', evidenceIds: ['a\u0007b'] }],
    ['eleven evidence ids', 'progress.report',
      { source: 'a', state: 'running', label: 'x', evidenceIds: Array.from({ length: 11 }, (_, i) => `a${i}`) }],
    ['relative path', 'artifact.publish', { path: 'notes.md', idempotencyKey: 'k' }],
    ['missing publish key', 'artifact.publish', { path: '/tmp/notes.md' }],
    ['bad kind', 'attention.open', { requestKey: 'q', kind: 'urgent', title: 'Title' }],
    ['the plan-use notice key', 'attention.open', { requestKey: 'usage:codex:10080:29823300', kind: 'notice', title: 'T' }],
    ['expiry without timezone', 'attention.open', { requestKey: 'q', kind: 'question', title: 'T', expiresAt: '2026-09-14T12:00:00' }],
    ['unknown prompt type', 'attention.open', { requestKey: 'q', kind: 'question', title: 'T', prompt: { type: 'survey' } }],
    ['permission prompt on a question', 'attention.open', { requestKey: 'q', kind: 'question', title: 'T', prompt: {
      type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null, tool: 'Bash', command: 'ls', cwd: null
    } }],
    ['prompt on a notice', 'attention.open', { requestKey: 'q', kind: 'notice', title: 'T', prompt: {
      type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null, tool: 'Bash', command: 'ls', cwd: null
    } }],
    ['missing resolution', 'attention.resolve', { requestKey: 'q' }],
    ['evidence with an unknown key', 'attention.resolve', { requestKey: 'q', resolution: 'r', evidence: {
      toolUseId: null, requestRef: null, answers: null, permission: null, tool: null, command: null, answered: true
    } }],
    ['evidence with an unknown permission word', 'attention.withdraw', { requestKey: 'q', evidence: {
      toolUseId: null, requestRef: 'per_1', answers: null, permission: 'always', tool: null, command: null
    } }],
    ['evidence with an empty answer list', 'attention.resolve', { requestKey: 'q', resolution: 'r', evidence: {
      toolUseId: null, requestRef: null, answers: [[]], permission: null, tool: null, command: null
    } }],
    ['answer.take waiting too long', 'answer.take', { wait: 26 }],
    ['answer.take with a fractional wait', 'answer.take', { wait: 1.5 }],
    ['answer.take naming a request', 'answer.take', { requestId: 'r1' }],
    ['answer.take reporting without an outcome', 'answer.take', { reported: { requestRef: 'per_1' } }],
    ['answer.take reporting an answer', 'answer.take', { reported: { requestRef: 'per_1', delivered: true, reply: 'once' } }],
    ['a method that would give an answer', 'answer.give', { requestId: 'r1' }],
    ['an attention answer method', 'attention.answer', { requestId: 'r1' }],
    ['missing input key', 'input.submit', { text: 'ls' }],
    ['oversize text', 'input.submit', { text: 'x'.repeat(64 * 1024 + 1), idempotencyKey: 'k' }],
    ['non-boolean submit', 'input.submit', { text: 'ls', submit: 'yes', idempotencyKey: 'k' }],
    ['empty text without submit', 'input.submit', { text: '', idempotencyKey: 'k' }],
    ['snapshot params', 'state.snapshot', { verbose: true }],
    ['unknown method', 'session.kill', {}],
    ['non-UUID conversation reference', 'conversation.observe',
      { agentCli: 'claude', conversationReference: 'not-a-uuid-not-a-uuid-not-a-uuid-abcd', source: 'startup' }],
    ['short conversation reference', 'conversation.observe',
      { agentCli: 'claude', conversationReference: '11111111-1111-4111-8111-11111111111', source: 'startup' }],
    ['unknown observation source', 'conversation.observe',
      { agentCli: 'claude', conversationReference: OBSERVED_REFERENCE, source: 'compact' }],
    ['unknown observation agent', 'conversation.observe',
      { agentCli: 'gemini', conversationReference: OBSERVED_REFERENCE, source: 'startup' }],
    ['relative transcript path', 'conversation.observe',
      { agentCli: 'claude', conversationReference: OBSERVED_REFERENCE, source: 'startup', transcriptPath: 'x.jsonl' }],
    ['oversize transcript path', 'conversation.observe',
      { agentCli: 'claude', conversationReference: OBSERVED_REFERENCE, source: 'startup', transcriptPath: `/${'x'.repeat(4096)}` }],
    ['unknown observation parameter', 'conversation.observe',
      { agentCli: 'claude', conversationReference: OBSERVED_REFERENCE, source: 'startup', pid: 12 }],
    ['invalid fingerprint', 'hook.observe', { agent: 'claude', event: 'PostToolUse', effects: [], fingerprint: 'XYZ' }],
    ['uppercase fingerprint', 'hook.observe', { agent: 'claude', event: 'PostToolUse', effects: [], fingerprint: 'ABCDEF0123456789' }],
    ['unknown hook agent', 'hook.observe', { agent: 'gemini', event: 'Stop', effects: [] }],
    // Only the window sees a session's own output, so no token may file an event as the terminal.
    ['the window own terminal label', 'hook.observe', { agent: 'terminal', event: 'osc:9', effects: [] }],
    ['control character hook event', 'hook.observe', { agent: 'claude', event: 'Stop\u0007', effects: [] }],
    ['oversize hook event', 'hook.observe', { agent: 'claude', event: 'E'.repeat(65), effects: [] }],
    ['missing hook event', 'hook.observe', { agent: 'claude', effects: [] }],
    ['hook effects not an array', 'hook.observe', { agent: 'claude', event: 'Stop', effects: 'opened' }],
    ['invented hook effect', 'hook.observe', { agent: 'claude', event: 'Stop', effects: ['notified'] }],
    ['too many hook effects', 'hook.observe',
      { agent: 'claude', event: 'Stop', effects: ['opened', 'opened', 'opened', 'opened', 'opened', 'opened', 'opened', 'opened', 'opened'] }],
    ['api host with a path', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'api.z.ai/api' }],
    ['api host with credentials', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'user@api.z.ai' }],
    ['api host with a scheme', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'https://api.z.ai' }],
    ['api host with a space', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'api.z ai' }],
    ['control character api host', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'api.z.ai\u0007' }],
    ['oversize api host', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: `${'a'.repeat(256)}.ai` }],
    ['empty api host', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: '' }],
    ['non-string api host', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 12 }],
    ['api host with a stray bracket', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost: 'api]z.ai' }],
    ['control character model', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], model: 'glm\u0007' }],
    ['oversize model', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], model: 'x'.repeat(129) }],
    ['empty model', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], model: '' }],
    ['non-string model', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], model: 42 }],
    ['unknown hook parameter', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], pid: 12 }],
    // Story 31.1: a Claude folder is an absolute path, and only a Claude hook reports one.
    ['relative claude config folder', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], claudeConfigDir: 'conf/glm' }],
    ['claude config folder from codex', 'hook.observe', { agent: 'codex', event: 'Stop', effects: [], claudeConfigDir: '/srv/glm' }],
    ['control character claude config folder', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], claudeConfigDir: '/srv/\u0007glm' }],
    ['empty claude config folder', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], claudeConfigDir: '' }],
    ['non-string claude config folder', 'hook.observe', { agent: 'claude', event: 'Stop', effects: [], claudeConfigDir: 7 }],
    // Story 37.2: only Claude's status line reports, and only plan windows and context use.
    ['usage from codex', 'usage.report', { agent: 'codex', windows: [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }] }],
    ['usage without an agent', 'usage.report', { windows: [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }] }],
    ['usage windows not an array', 'usage.report', { agent: 'claude', windows: { minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' } }],
    ['three usage windows', 'usage.report', { agent: 'claude', windows: [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, { ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, minutes: 10_080 }, { ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, minutes: 60 }] }],
    ['a repeated usage window', 'usage.report', { agent: 'claude', windows: [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, { minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }] }],
    ['a fractional window length', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, minutes: 1.5 }] }],
    ['a negative share used', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, usedPercent: -1 }] }],
    ['a share used over 1000', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, usedPercent: 1001 }] }],
    ['a share used as text', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, usedPercent: '42' }] }],
    ['a reset without a timezone', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, resetsAt: '2026-09-14T16:10:00' }] }],
    ['a reset as epoch seconds', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, resetsAt: 1_790_610_000 }] }],
    ['an unknown window field', 'usage.report', { agent: 'claude', windows: [{ ...{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, limitId: 'x' }] }],
    ['an unknown usage parameter', 'usage.report', { agent: 'claude', windows: [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }], statusLine: '{}' }],
    ['a context share as text', 'usage.report', { agent: 'claude', windows: [], contextUsedPercent: '37' }],
    ['an empty reading', 'usage.report', { agent: 'claude', windows: [] }]
  ])('rejects %s with INVALID_ARGUMENT and keeps the connection', async (_label, method, params) => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    expectError(await client.request(method, params), ERROR_CODES.invalidArgument)

    expect((await client.request('state.snapshot')).result).toMatchObject({ watermark: 7 })
    for (const handler of [
      fixture.handlers.publishArtifact,
      fixture.handlers.reportProgress,
      fixture.handlers.openAttention,
      fixture.handlers.resolveAttention,
      fixture.handlers.submitInput,
      fixture.handlers.observeConversation,
      fixture.handlers.observeHookEvent,
      fixture.handlers.reportUsage
    ]) {
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it('passes a session\'s plan-use reading to the service with its own run, and refuses the owner', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const windows = [{ minutes: 300, usedPercent: 42, resetsAt: '2026-09-14T16:10:00.000Z' }, { minutes: 10_080, usedPercent: 18.5, resetsAt: '2026-09-18T09:00:00+03:00' }]

    expect((await client.request('usage.report', { agent: 'claude', windows, contextUsedPercent: 37 })).result).toEqual({ recorded: true })
    expect((await client.request('usage.report', { agent: 'claude', windows: [], contextUsedPercent: 12 })).result).toEqual({ recorded: true })
    expect(fixture.handlers.reportUsage).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1', incarnationId: 'incarnation-1', agent: 'claude', contextUsedPercent: 37,
      windows: [windows[0], { minutes: 10_080, usedPercent: 18.5, resetsAt: '2026-09-18T06:00:00.000Z' }]
    })
    expect(fixture.handlers.reportUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ windows: [], contextUsedPercent: 12 }))

    const owner = await authenticated(fixture, fixture.auth.ownerToken)
    expectError(await owner.request('usage.report', { sessionId: 'session-1', agent: 'claude', windows }), ERROR_CODES.unauthorized)
    // A session may report only its own plan use.
    expectError(await client.request('usage.report', { sessionId: 'session-2', agent: 'claude', windows }), ERROR_CODES.unauthorized)
    expect(fixture.handlers.reportUsage).toHaveBeenCalledTimes(2)
  })

  it('stores the closed origin vocabulary and records one hook event per call', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('attention.open', {
      requestKey: 'q', kind: 'question', title: 'Which one?', origin: 'hook:claude:Notification'
    })
    await client.request('attention.withdraw', { requestKey: 'q', origin: 'hook:codex:Stop' })
    await client.request('attention.resolve', { requestKey: 'q', resolution: 'done', origin: 'cli' })
    const observed = await client.request('hook.observe', {
      agent: 'claude', event: 'PostToolUse', toolName: 'Bash', fingerprint: '0123456789abcdef', effects: ['answered', 'withdrew']
    })

    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: 'hook:claude:Notification' })
    )
    expect(fixture.handlers.withdrawAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: 'hook:codex:Stop' })
    )
    expect(fixture.handlers.resolveAttention).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: 'cli' })
    )
    expect(observed.result).toEqual({ recorded: true })
    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      // The incarnation that reported it: a later process must not inherit its predecessor's log.
      incarnationId: 'incarnation-1',
      agent: 'claude',
      event: 'PostToolUse',
      source: null,
      toolName: 'Bash',
      fingerprint: '0123456789abcdef',
      effects: ['answered', 'withdrew']
    })

    // Epic 29: model facts ride along when the CLI sends them, and an older CLI that sends none
    // still records its observation unchanged.
    await client.request('hook.observe', {
      agent: 'claude', event: 'SessionStart', effects: [], apiHost: 'api.z.ai', model: 'GLM-5.3'
    })
    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      agent: 'claude',
      event: 'SessionStart',
      source: null,
      toolName: null,
      apiHost: 'api.z.ai',
      model: 'GLM-5.3',
      effects: []
    })
    // Story 31.1: the folder a Claude session's settings live in reaches the handler as sent.
    await client.request('hook.observe', { agent: 'claude', event: 'Stop', effects: [], claudeConfigDir: '/home/owner/.claude-glm' })
    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      agent: 'claude', claudeConfigDir: '/home/owner/.claude-glm'
    }))
    // Names the URL parser keeps, underscores and IPv6 literals included, are hosts too.
    for (const apiHost of ['my_host.internal.example', '[::1]', 'xn--bcher-kva.example']) {
      await client.request('hook.observe', { agent: 'claude', event: 'Stop', effects: [], apiHost })
      expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith(expect.objectContaining({ apiHost }))
    }
    await client.request('hook.observe', { agent: 'codex', event: 'Stop', effects: [] })
    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      agent: 'codex',
      event: 'Stop',
      source: null,
      toolName: null,
      effects: []
    })
  })

  it('passes a validated agent prompt to the handler', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const prompt = {
      type: 'questions', harness: 'codex', shape: 'choice', requestRef: null, toolUseId: 'call_1',
      questions: [{ id: 'db', header: 'Database', text: 'Which database?', multiSelect: false,
        options: [{ label: 'Postgres', description: 'Already used' }, { label: 'SQLite', description: null }] }]
    }

    await client.request('attention.open', { requestKey: 'q', kind: 'question', title: 'Which database?', prompt })

    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith({
      sessionId: 'session-1', incarnationId: 'incarnation-1', requestKey: 'q', kind: 'question', title: 'Which database?', prompt
    })
  })

  it('passes validated evidence with a resolve and a withdraw', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const evidence = {
      toolUseId: 'toolu_1', requestRef: null, answers: [['Postgres'], ['Later']], permission: null, tool: null, command: null
    }
    await client.request('attention.resolve', { requestKey: 'claude:question', resolution: 'answered in the terminal', evidence })
    expect(fixture.handlers.resolveAttention).toHaveBeenLastCalledWith({
      sessionId: 'session-1', requestKey: 'claude:question', resolution: 'answered in the terminal', evidence
    })
    const denied = { ...evidence, toolUseId: null, requestRef: 'per_1', answers: null, permission: 'denied' }
    await client.request('attention.withdraw', { requestKey: 'opencode:permission', evidence: denied })
    expect(fixture.handlers.withdrawAttention).toHaveBeenLastCalledWith({ sessionId: 'session-1', requestKey: 'opencode:permission', evidence: denied })
  })

  it('lets a session collect only its own answers, and never with the owner token', async () => {
    const fixture = await serverFixture()
    const session = await authenticated(fixture, sessionToken(fixture))
    expect((await session.request('answer.take', { wait: 3 })).error).toBeUndefined()
    expect(fixture.handlers.takeAnswers).toHaveBeenLastCalledWith({ sessionId: 'session-1', incarnationId: 'incarnation-1', waitMs: 3000, report: null })
    expect((await session.request('answer.take', { reported: { requestRef: 'per_1', delivered: false } })).error).toBeUndefined()
    expect(fixture.handlers.takeAnswers).toHaveBeenLastCalledWith({
      sessionId: 'session-1', incarnationId: 'incarnation-1', waitMs: 0, report: { requestRef: 'per_1', delivered: false }
    })
    expect((await session.request('answer.take', { sessionId: 'session-2' })).error).toBeDefined()
    const owner = await authenticated(fixture, fixture.auth.ownerToken)
    expect((await owner.request('answer.take', {})).error).toMatchObject({ data: { code: ERROR_CODES.unauthorized } })
    expect(fixture.handlers.takeAnswers).toHaveBeenCalledTimes(2)
  })

  it('opens and resolves without an origin, which stores no provenance', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('attention.open', { requestKey: 'q', kind: 'question', title: 'Which one?' })

    // An exact match: a caller that says nothing stores no provenance rather than a guessed word.
    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      requestKey: 'q',
      kind: 'question',
      title: 'Which one?'
    })
  })

  it.each([
    ['an invented word', 'guess'],
    ['an unknown hook agent', 'hook:gemini:Stop'],
    // `terminal` is the window's own label for what it read out of a session's output.
    ['the window own terminal label', 'hook:terminal:osc:9'],
    ['an oversize hook event', `hook:claude:${'E'.repeat(65)}`],
    ['a control character', 'cli\nowner'],
    ["the owner's own word", 'owner'],
    ['a typed answer', 'input'],
    ['a Telegram reply', 'telegram'],
    ['expiry', 'expiry'],
    // Only the window sees a session's own output, so only the window may say a notice came from it.
    ['the repeat watch', 'watch:repeat'],
    ['a terminal notification', 'osc:9'],
    ['a kitty notification', 'osc:99'],
    ['an urxvt notification', 'osc:777']
  ])('drops %s as provenance and still opens, withdraws and resolves the request', async (_label, origin) => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    const opened = await client.request('attention.open', {
      requestKey: 'q', kind: 'question', title: 'Which one?', origin
    })
    const withdrawn = await client.request('attention.withdraw', { requestKey: 'q', origin })
    const resolved = await client.request('attention.resolve', { requestKey: 'q', resolution: 'done', origin })

    // AC5: a bad origin is refused without affecting the operation it arrived with.
    expect(opened.error).toBeUndefined()
    expect(withdrawn.error).toBeUndefined()
    expect(resolved.error).toBeUndefined()
    const withoutOrigin = expect.not.objectContaining({ origin: expect.anything() })
    expect(fixture.handlers.openAttention).toHaveBeenCalledExactlyOnceWith(withoutOrigin)
    expect(fixture.handlers.withdrawAttention).toHaveBeenCalledExactlyOnceWith(withoutOrigin)
    expect(fixture.handlers.resolveAttention).toHaveBeenCalledExactlyOnceWith(withoutOrigin)
    // The drop is recorded rather than silent, but only once per caller per quiet period: the reason never
    // varies, and a caller must not be able to turn a bad parameter into an unbounded queue of log appends.
    expect(fixture.handlers.reportRefusal).toHaveBeenCalledExactlyOnceWith(
      'attention.open', 'session-1', 'origin refused: unknown provenance for this credential'
    )
    // The refused word is never echoed back into the log.
    expect(fixture.handlers.reportRefusal.mock.calls.every(([, , reason]) => !String(reason).includes(origin)))
      .toBe(true)
  })

  it('has no socket method for a terminal notice, for either credential', async () => {
    const fixture = await serverFixture()
    const asSession = await authenticated(fixture, sessionToken(fixture))
    const asOwner = await authenticated(fixture, fixture.auth.ownerToken)
    const params = { sessionId: 'session-1', incarnationId: 'incarnation-1', code: 9, title: 'Hello' }

    const bySession = await asSession.request('attention.terminalNotice', params)
    const byOwner = await asOwner.request('attention.terminalNotice', params)

    // It is the window's own channel: putting it on the socket would widen what an agent can reach.
    for (const outcome of [bySession, byOwner]) {
      expect(outcome.error?.data?.code).toBe(ERROR_CODES.invalidArgument)
      expect(String(outcome.error?.message)).toContain('Unknown method')
    }
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it("lets the owner token record the owner's own routes", async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    for (const origin of ['owner', 'input', 'telegram', 'expiry']) {
      await client.request('attention.resolve', {
        sessionId: 'session-1', requestKey: 'q', resolution: 'done', origin
      })
      expect(fixture.handlers.resolveAttention).toHaveBeenLastCalledWith(expect.objectContaining({ origin }))
    }
    expect(fixture.handlers.reportRefusal).not.toHaveBeenCalled()
  })

  it.each([
    'hook:claude:Custom-Event',
    'hook:codex:Pre_Tool.Use',
    'hook:claude:Custom Event',
    'hook:codex:Évènement',
    'hook:claude:Custom:Event',
    `hook:claude:${'E'.repeat(52)}`
  ])('accepts %s, the RULES.source shape the epic names', async (origin) => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('attention.open', { requestKey: 'q', kind: 'question', title: 'T', origin })

    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({ origin }))
    expect(fixture.handlers.reportRefusal).not.toHaveBeenCalled()
  })

  it('normalizes timestamps and accepts text at the 64 KiB limit', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('attention.open', {
      requestKey: 'q',
      kind: 'permission',
      title: 'Run migration?',
      body: 'Line one\nLine two',
      expiresAt: '2026-09-14T14:00:00+02:00'
    })
    const submitted = await client.request('input.submit', { text: 'x'.repeat(64 * 1024), idempotencyKey: 'k' })

    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      requestKey: 'q',
      kind: 'permission',
      title: 'Run migration?',
      body: 'Line one\nLine two',
      expiresAt: '2026-09-14T12:00:00.000Z'
    })
    expect(submitted.result).toEqual({ ok: true })
    expect(fixture.handlers.submitInput).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      text: 'x'.repeat(64 * 1024),
      submit: false
    })
  })

  it('answers malformed JSON after auth without closing', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    await client.write('{not json\n')
    const response = await client.next()

    expect(response.id).toBeNull()
    expectError(response, ERROR_CODES.invalidArgument)
    expect((await client.request('state.snapshot')).result).toMatchObject({ watermark: 7 })
  })

  it('rejects a line longer than the frame limit and closes the connection', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    await client.write(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1, 0x61))
    const response = await client.next()

    expect(response.id).toBeNull()
    expectError(response, ERROR_CODES.invalidArgument)
    await client.untilClosed()
  })

  it('reports a snapshot without a watermark as an IO error', async () => {
    const fixture = await serverFixture()
    fixture.handlers.snapshot.mockResolvedValueOnce({ sessions: [] })
    const client = await authenticated(fixture, fixture.auth.ownerToken)

    expectError(await client.request('state.snapshot'), ERROR_CODES.ioError)
  })

  it('turns unexpected handler errors into IO_ERROR without leaking tokens', async () => {
    const fixture = await serverFixture()
    const token = sessionToken(fixture)
    fixture.handlers.reportProgress.mockRejectedValueOnce(
      new Error(`disk exploded near ${fixture.auth.ownerToken} and ${token}`)
    )
    const client = await authenticated(fixture, token)

    const response = await client.request('progress.report', { source: 'a', state: 'failed', label: 'x' })

    expectError(response, ERROR_CODES.ioError)
    expect(response.error?.message).toContain('disk exploded')
    expect(response.error?.message).not.toContain(fixture.auth.ownerToken)
    expect(response.error?.message).not.toContain(token)
    expect(response.error?.message).not.toContain(token.split('.')[3])
  })
})

describe('format characters in agent text (Story 34.1)', () => {
  const SPOOF = 'Approve \u202Ecod.exe\u202C \u200Bnow'

  it('strips them from attention titles, bodies and prompt text before the handler stores anything', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const prompt = {
      type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_1',
      questions: [{ id: null, header: 'Pi\u2066ck\u2069', text: SPOOF, multiSelect: false,
        options: [{ label: 'Y\uFEFFes', description: 'Go\u200F on' }, { label: 'No', description: null }] }]
    }

    const response = await client.request('attention.open', {
      requestKey: 'q', kind: 'question', title: SPOOF, body: 'line one\n\u2067two\u2069', prompt
    })

    expect(response.error).toBeUndefined()
    expect(fixture.handlers.openAttention).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Approve cod.exe now',
      body: 'line one\ntwo',
      prompt: expect.objectContaining({ questions: [expect.objectContaining({
        header: 'Pick', text: 'Approve cod.exe now',
        options: [{ label: 'Y\uFEFFes', description: 'Go on' }, { label: 'No', description: null }]
      })] })
    }))
  })

  it('strips them from progress labels and details', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('progress.report', {
      source: 'agent', state: 'running', label: 'Build\u202E ing', detail: 'step\u200B 2\nof 3'
    })

    expect(fixture.handlers.reportProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      label: 'Build ing', detail: 'step 2\nof 3'
    }))
  })

  it('strips them from hook sources, tool names and models, and from a progress source (pre-review)', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('hook.observe', {
      agent: 'claude', event: 'SessionStart', source: 'start\u200Bup', toolName: 'Ba\u202Esh', effects: [], model: 'GLM\u2066-5.3\u2069'
    })
    await client.request('progress.report', { source: 'dev\uFEFF-auto', state: 'running', label: 'Build' })

    expect(fixture.handlers.observeHookEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      source: 'startup', toolName: 'Bash', model: 'GLM-5.3'
    }))
    expect(fixture.handlers.reportProgress).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'dev-auto' }))
  })

  it('strips them from handoff text', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    await client.request('handoff.prepare', {
      destinationSessionId: 'session-2', text: 'Done\u2066 here\u2069\n\tnext', artifactIds: [], idempotencyKey: 'h'
    })

    expect(fixture.handlers.prepareHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Done here\n\tnext' }))
  })

  it.each([
    ['attention.open', { requestKey: 'q', kind: 'question', title: '\u202E\u200B' }, 'title must be 1..200 characters'],
    ['progress.report', { source: 'agent', state: 'running', label: '\uFEFF' }, 'label must be 1..200 characters'],
    ['handoff.prepare', { destinationSessionId: 'session-2', text: '\u2066\u2069', artifactIds: [], idempotencyKey: 'e' },
      'text must be 1..16384 bytes']
  ])('%s refuses a field that held only format characters as empty', async (method, params, message) => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))

    const response = await client.request(method, params)

    expectError(response, ERROR_CODES.invalidArgument)
    expect(response.error?.message).toBe(message)
  })

  it('keeps hashing the parameters as received, so a retry of a request sent before this change is a duplicate', async () => {
    const receipts = new MemoryReceiptStore()
    const raw = { requestKey: 'spoof', kind: 'question', title: SPOOF }
    const paramsHash = createHash('sha256').update(
      `{"kind":"question","requestKey":"spoof","title":${JSON.stringify(SPOOF)}}`
    ).digest('hex')
    await receipts.put({
      key: 'session:session-1|attention.open|ask-1', paramsHash, state: 'done', result: { requestId: 'request-9' }
    })
    const fixture = await serverFixture(receipts)
    const client = await authenticated(fixture, sessionToken(fixture))

    const retry = await client.request('attention.open', { ...raw, idempotencyKey: 'ask-1' })

    expect(retry.result).toEqual({ requestId: 'request-9', duplicate: true })
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
  })

  it('replays a receipt for a title that held only format characters, and refuses that title in a new request (Astra review)', async () => {
    const receipts = new MemoryReceiptStore()
    const raw = { requestKey: 'spoof', kind: 'question', title: '\u202E\u200B' }
    const paramsHash = createHash('sha256').update(
      `{"kind":"question","requestKey":"spoof","title":${JSON.stringify(raw.title)}}`
    ).digest('hex')
    await receipts.put({
      key: 'session:session-1|attention.open|ask-2', paramsHash, state: 'done', result: { requestId: 'request-8' }
    })
    const fixture = await serverFixture(receipts)
    const client = await authenticated(fixture, sessionToken(fixture))

    const retry = await client.request('attention.open', { ...raw, idempotencyKey: 'ask-2' })
    const fresh = await client.request('attention.open', { ...raw, idempotencyKey: 'ask-3' })
    const changed = await client.request('attention.open', { ...raw, requestKey: 'other', idempotencyKey: 'ask-2' })

    expect(retry.result).toEqual({ requestId: 'request-8', duplicate: true })
    expectError(fresh, ERROR_CODES.invalidArgument)
    expectError(changed, ERROR_CODES.invalidArgument)
    expect(fixture.handlers.openAttention).not.toHaveBeenCalled()
    await expect(receipts.get('session:session-1|attention.open|ask-3')).resolves.toBeUndefined()
  })

  it('never replays a receipt for another method spelled to reach its key (Astra recheck)', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const params = { requestKey: 'k', kind: 'question', title: 'T' }

    const first = await client.request('attention.open', { ...params, idempotencyKey: 'a|b' })
    const alias = await client.request('attention.open|a', { ...params, idempotencyKey: 'b' })

    expect(first.error).toBeUndefined()
    expectError(alias, ERROR_CODES.invalidArgument)
    expect(alias.error?.message).toBe('Unknown method: attention.open|a')
    expect(fixture.handlers.openAttention).toHaveBeenCalledTimes(1)
  })
})

describe('control server idempotency', () => {
  it('returns the stored result for a duplicate without calling the handler again', async () => {
    const fixture = await serverFixture()
    const client = await authenticated(fixture, sessionToken(fixture))
    const params = { path: '/tmp/report.md', idempotencyKey: 'publish-1' }

    const first = await client.request('artifact.publish', params)
    const second = await client.request('artifact.publish', params)
    const sent = await client.request('input.submit', { text: 'yes', submit: true, idempotencyKey: 'send-1' })
    const resent = await client.request('input.submit', { text: 'yes', submit: true, idempotencyKey: 'send-1' })

    expect(first.result).toEqual({ artifactId: 'artifact-for-/tmp/report.md' })
    expect(second.result).toEqual({ artifactId: 'artifact-for-/tmp/report.md', duplicate: true })
    expect(fixture.handlers.publishArtifact).toHaveBeenCalledTimes(1)
    expect(sent.result).toEqual({ ok: true })
    expect(resent.result).toEqual({ ok: true, duplicate: true })
    expect(fixture.handlers.submitInput).toHaveBeenCalledTimes(1)
  })

  it('rejects a reused key with different parameters and scopes keys per credential', async () => {
    const fixture = await serverFixture()
    const agent = await authenticated(fixture, sessionToken(fixture))
    const owner = await authenticated(fixture, fixture.auth.ownerToken)

    await agent.request('artifact.publish', { path: '/tmp/one.md', idempotencyKey: 'shared' })
    const conflict = await agent.request('artifact.publish', { path: '/tmp/two.md', idempotencyKey: 'shared' })
    const ownerCall = await owner.request('artifact.publish', {
      sessionId: 'session-1',
      path: '/tmp/two.md',
      idempotencyKey: 'shared'
    })

    expectError(conflict, ERROR_CODES.revisionConflict)
    expect(conflict.error?.message).toBe('idempotency key reused with different parameters')
    expect(ownerCall.result).toEqual({ artifactId: 'artifact-for-/tmp/two.md' })
    expect(fixture.handlers.publishArtifact).toHaveBeenCalledTimes(2)
  })

  it('reports a staged receipt as uncertain and never redelivers', async () => {
    const receipts = new MemoryReceiptStore()
    const paramsHash = createHash('sha256').update('{"submit":true,"text":"rm -rf build"}').digest('hex')
    await receipts.put({ key: 'session:session-1|input.submit|send-9', paramsHash, state: 'staged' })
    const fixture = await serverFixture(receipts)
    const client = await authenticated(fixture, sessionToken(fixture))

    const response = await client.request('input.submit', {
      text: 'rm -rf build',
      submit: true,
      idempotencyKey: 'send-9'
    })

    expect(response.result).toEqual({ state: 'uncertain', duplicate: true })
    expect(fixture.handlers.submitInput).not.toHaveBeenCalled()
  })

  it('replays a stored failure for the same key and parameters', async () => {
    const fixture = await serverFixture()
    fixture.handlers.publishArtifact.mockRejectedValueOnce(
      new ControlError(ERROR_CODES.notFound, 'Source file is missing')
    )
    const client = await authenticated(fixture, sessionToken(fixture))
    const params = { path: '/tmp/missing.md', idempotencyKey: 'publish-2' }

    const first = await client.request('artifact.publish', params)
    const replay = await client.request('artifact.publish', params)

    for (const response of [first, replay]) {
      expectError(response, ERROR_CODES.notFound)
      expect(response.error?.message).toBe('Source file is missing')
    }
    expect(fixture.handlers.publishArtifact).toHaveBeenCalledTimes(1)
    await expect(fixture.receipts.get('session:session-1|artifact.publish|publish-2')).resolves.toMatchObject({
      state: 'failed',
      error: { code: ERROR_CODES.notFound }
    })
  })

  it('delivers once when two connections race with the same key', async () => {
    const fixture = await serverFixture()
    let release: () => void = () => undefined
    fixture.handlers.submitInput.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const first = await authenticated(fixture, sessionToken(fixture))
    const second = await authenticated(fixture, sessionToken(fixture))
    const params = { text: 'deploy', submit: true, idempotencyKey: 'race' }

    const firstResponse = first.request('input.submit', params)
    await vi.waitFor(() => expect(fixture.handlers.submitInput).toHaveBeenCalledTimes(1))
    const secondResponse = second.request('input.submit', params)
    release()

    expect((await firstResponse).result).toEqual({ ok: true })
    expect((await secondResponse).result).toEqual({ ok: true, duplicate: true })
    expect(fixture.handlers.submitInput).toHaveBeenCalledTimes(1)
  })
})

describe('control server socket lifecycle', () => {
  it('creates a private directory and socket and removes the socket on close', async () => {
    const fixture = await serverFixture()

    expect((await stat(dirname(fixture.socketPath))).mode & 0o777).toBe(0o700)
    expect((await lstat(fixture.socketPath)).isSocket()).toBe(true)
    expect((await lstat(fixture.socketPath)).mode & 0o777).toBe(0o600)

    await fixture.server.close()
    await expect(lstat(fixture.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces a stale socket left by a crashed server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aitcs-'))
    createdRoots.add(root)
    const socketPath = join(root, 'ctl', 'control.sock')
    await leaveStaleSocket(socketPath)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
    const auth = new ControlAuth()
    const server = new ControlServer({
      socketPath,
      auth,
      handlers: fakeHandlers(new Map()),
      receipts: new MemoryReceiptStore()
    })

    await server.listen()
    servers.add(server)

    const client = await TestClient.connect(socketPath)
    expect((await client.request('auth', { token: auth.ownerToken })).result).toEqual({ scope: 'owner' })
  })

  it('refuses to take over a live socket', async () => {
    const fixture = await serverFixture()
    const intruder = new ControlServer({
      socketPath: fixture.socketPath,
      auth: new ControlAuth(),
      handlers: fakeHandlers(new Map()),
      receipts: new MemoryReceiptStore()
    })

    await expect(intruder.listen()).rejects.toThrow(/already in use/)
    await intruder.close()

    const client = await TestClient.connect(fixture.socketPath)
    expect((await client.request('auth', { token: fixture.auth.ownerToken })).result).toEqual({ scope: 'owner' })
  })
})
