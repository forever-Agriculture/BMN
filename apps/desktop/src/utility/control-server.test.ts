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
    observeConversation: vi.fn(async (): Promise<unknown> => ({ accepted: true, detail: 'observed' })),
    withdrawAttention: vi.fn(async (): Promise<unknown> => ({ withdrawn: true })),
    resolveAttention: vi.fn(async (): Promise<unknown> => ({ resolved: true })),
    submitInput: vi.fn(async (): Promise<void> => undefined)
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
      observedAt: NOW.toISOString()
    })

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
    ['relative path', 'artifact.publish', { path: 'notes.md', idempotencyKey: 'k' }],
    ['missing publish key', 'artifact.publish', { path: '/tmp/notes.md' }],
    ['bad kind', 'attention.open', { requestKey: 'q', kind: 'urgent', title: 'Title' }],
    ['expiry without timezone', 'attention.open', { requestKey: 'q', kind: 'question', title: 'T', expiresAt: '2026-09-14T12:00:00' }],
    ['missing resolution', 'attention.resolve', { requestKey: 'q' }],
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
      { agentCli: 'claude', conversationReference: OBSERVED_REFERENCE, source: 'startup', pid: 12 }]
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
      fixture.handlers.observeConversation
    ]) {
      expect(handler).not.toHaveBeenCalled()
    }
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
