// MODULE: control-server.ts - authenticated newline-delimited JSON-RPC control socket for agents and the owner CLI
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import {
  AGENT_ATTENTION_ORIGINS,
  ERROR_CODES,
  MAX_CONTROL_FRAME_BYTES,
  isAttentionOrigin,
  isHookEventName,
  isProtocolErrorCode,
  type ProtocolErrorCode
} from '@bmn/protocol'
import type { ControlAuth, ControlScope } from './control-auth'

export class ControlError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string, readonly retryable = false) {
    super(message)
    this.name = 'ControlError'
  }
}

export type ProgressState = 'running' | 'waiting' | 'blocked' | 'claimed-done' | 'verified' | 'failed' | 'unknown'
export type AttentionKind = 'question' | 'permission' | 'review' | 'notice'
export type ConversationAgentCli = 'claude' | 'codex'
export type HookEventAgent = 'claude' | 'codex'
export type HookEventEffect = 'opened' | 'withdrew' | 'answered'
export type ConversationObservationSource = 'startup' | 'resume' | 'clear' | 'fork'

export interface ControlHandlers {
  /** Revocation: session tokens are valid only while their incarnation is the current live one. */
  isCurrentIncarnation(sessionId: string, incarnationId: string): boolean
  sessionExists(sessionId: string): boolean
  /** Must resolve to an object with a numeric `watermark`. */
  snapshot(scope: ControlScope): Promise<unknown>
  listSessions(scope: ControlScope): Promise<unknown>
  publishArtifact(p: {
    sessionId: string
    incarnationId: string | null
    path: string
    name?: string
    source: 'agent' | 'owner'
  }): Promise<unknown>
  reportProgress(p: {
    sessionId: string
    incarnationId: string | null
    source: string
    state: ProgressState
    label: string
    detail?: string
    observedAt: string
  }): Promise<unknown>
  openAttention(p: {
    sessionId: string
    incarnationId: string | null
    requestKey: string
    kind: AttentionKind
    title: string
    body?: string
    expiresAt?: string
    /** The agent's own app already notifies the owner's phone. */
    phoneNotified?: boolean
    /** What opened it, from the closed origin vocabulary. */
    origin?: string
  }): Promise<unknown>
  /** Records why a conversation report was refused, so a refusal is not silent to the owner. */
  reportRefusal(method: string, sessionId: string | null, reason: string): void
  /** The harness's own word about which conversation its process is in; never reachable by the owner token. */
  observeConversation(p: {
    sessionId: string
    incarnationId: string | null
    agentCli: ConversationAgentCli
    conversationReference: string
    source: ConversationObservationSource
    transcriptPath?: string
  }): Promise<unknown>
  withdrawAttention(p: { sessionId: string; requestKey: string; origin?: string }): Promise<unknown>
  resolveAttention(p: {
    sessionId: string
    requestKey: string
    resolution: string
    origin?: string
  }): Promise<unknown>
  /** One hook event, recorded so the owner can see which events arrived; it changes nothing by itself. */
  observeHookEvent(p: {
    sessionId: string
    agent: HookEventAgent
    event: string
    source: string | null
    toolName: string | null
    effects: readonly HookEventEffect[]
  }): Promise<unknown>
  /** Writes text into the PTY as a bracketed paste; appends '\r' only when submit is true. */
  submitInput(p: { sessionId: string; text: string; submit: boolean }): Promise<void>
}

export interface ReceiptRecord {
  key: string
  paramsHash: string
  state: 'staged' | 'done' | 'failed'
  result?: unknown
  error?: { code: string; message: string }
}

export interface ReceiptStore {
  get(key: string): Promise<ReceiptRecord | undefined>
  put(record: ReceiptRecord): Promise<void>
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly records = new Map<string, ReceiptRecord>()

  async get(key: string): Promise<ReceiptRecord | undefined> {
    const record = this.records.get(key)
    return record === undefined ? undefined : structuredClone(record)
  }

  async put(record: ReceiptRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record))
  }
}

export interface ControlServerOptions {
  /** Parent dir created 0700; socket chmod 0600; a stale socket file is removed only if connecting to it fails. */
  socketPath: string
  auth: ControlAuth
  handlers: ControlHandlers
  receipts: ReceiptStore
  now?: () => Date
}

type Params = Record<string, unknown>
type RequestId = string | number | null

interface ControlRequest {
  id: string | number
  method: string
  params: unknown
}

interface Connection {
  socket: Socket
  scope: ControlScope | null
  buffered: Buffer[]
  bufferedBytes: number
  closing: boolean
  discarding: boolean
  queue: Promise<void>
}

interface TextRule {
  min: number
  max: number
  unit: 'characters' | 'bytes'
  controls: 'reject' | 'allow-whitespace' | 'allow'
}

const JSONRPC_SERVER_ERROR = -32000
const MAX_INPUT_TEXT_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 500
const CLOSE_GRACE_MS = 1000
const REQUEST_KEYS = ['jsonrpc', 'id', 'method', 'params']
const PROGRESS_STATES: readonly ProgressState[] = [
  'running', 'waiting', 'blocked', 'claimed-done', 'verified', 'failed', 'unknown'
]
const ATTENTION_KINDS: readonly AttentionKind[] = ['question', 'permission', 'review', 'notice']
const HOOK_EVENT_AGENTS: readonly HookEventAgent[] = ['claude', 'codex']
const HOOK_EVENT_EFFECTS: readonly HookEventEffect[] = ['opened', 'withdrew', 'answered']
const MAX_HOOK_EVENT_EFFECTS = 8
const CONVERSATION_AGENT_CLIS: readonly ConversationAgentCli[] = ['claude', 'codex']
const CONVERSATION_OBSERVATION_SOURCES: readonly ConversationObservationSource[] = [
  'startup', 'resume', 'clear', 'fork'
]
/** 8-4-4-4-12 hex, the shape both Claude Code session ids and Codex rollout ids use. */
const CONVERSATION_REFERENCE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const SESSION_TOKEN_TEXT = /s1\.[A-Za-z0-9_:-]+\.[A-Za-z0-9_:-]+\.[0-9a-fA-F]{16,}/g
const LONG_HEX_TEXT = /[0-9a-fA-F]{32,}/g

const IDENTIFIER: TextRule = { min: 1, max: 128, unit: 'characters', controls: 'reject' }
const RULES = {
  sessionId: IDENTIFIER,
  requestKey: IDENTIFIER,
  idempotencyKey: IDENTIFIER,
  path: { min: 1, max: 4096, unit: 'bytes', controls: 'reject' },
  name: { min: 1, max: 255, unit: 'characters', controls: 'reject' },
  source: { min: 1, max: 64, unit: 'characters', controls: 'reject' },
  label: { min: 1, max: 200, unit: 'characters', controls: 'reject' },
  detail: { min: 1, max: 2000, unit: 'characters', controls: 'allow-whitespace' },
  title: { min: 1, max: 200, unit: 'characters', controls: 'reject' },
  body: { min: 1, max: 8000, unit: 'characters', controls: 'allow-whitespace' },
  resolution: { min: 1, max: 200, unit: 'characters', controls: 'reject' },
  conversationReference: { min: 36, max: 36, unit: 'characters', controls: 'reject' },
  text: { min: 0, max: MAX_INPUT_TEXT_BYTES, unit: 'bytes', controls: 'allow' },
  timestamp: { min: 1, max: 64, unit: 'characters', controls: 'reject' }
} satisfies Record<string, TextRule>

const utf8 = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Params {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): ControlError {
  return new ControlError(ERROR_CODES.invalidArgument, message)
}

function unauthorized(message: string): ControlError {
  return new ControlError(ERROR_CODES.unauthorized, message)
}

function hasControlCharacter(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f) return true
    if (code < 0x20 && !(allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d))) return true
  }
  return false
}

function closedParams(value: unknown, allowed: readonly string[]): Params {
  if (value === undefined) return {}
  if (!isRecord(value)) throw invalid('params must be an object')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`Unknown parameter: ${key.slice(0, 64)}`)
  }
  return value
}

function readText(params: Params, key: string, rule: TextRule): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be a string`)
  const size = rule.unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : value.length
  if (size < rule.min || size > rule.max) {
    throw invalid(`${key} must be ${rule.min}..${rule.max} ${rule.unit}`)
  }
  if (rule.controls !== 'allow' && hasControlCharacter(value, rule.controls === 'allow-whitespace')) {
    throw invalid(`${key} must not contain control characters`)
  }
  return value
}

function requireText(params: Params, key: string, rule: TextRule): string {
  const value = readText(params, key, rule)
  if (value === undefined) throw invalid(`${key} is required`)
  return value
}

function readTimestamp(params: Params, key: string): string | undefined {
  const value = readText(params, key, RULES.timestamp)
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(time)) {
    throw invalid(`${key} must be an ISO 8601 timestamp with a timezone`)
  }
  return new Date(time).toISOString()
}

function readBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || typeof value === 'boolean') return value
  throw invalid(`${key} must be a boolean`)
}

function requireEnum<T extends string>(params: Params, key: string, allowed: readonly T[]): T {
  const value = params[key]
  if (value === undefined) throw invalid(`${key} is required`)
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * Provenance is optional metadata, so a malformed, oversized or unauthorized origin is dropped and recorded -
 * never allowed to stop the open, withdraw or resolve it came with. `owner`, `input`, `telegram` and `expiry`
 * are the app's own words: a session token may claim only its harness's hook events and the CLI it runs itself,
 * so an agent cannot dress its own action up as the owner's.
 */
function acceptableOrigin(value: unknown, scope: ControlScope): boolean {
  if (typeof value !== 'string' || !isAttentionOrigin(value)) return false
  return scope.kind === 'owner' ||
    value.startsWith('hook:') ||
    (AGENT_ATTENTION_ORIGINS as readonly string[]).includes(value)
}

/** The origin to store, or undefined when none was offered or the one offered was dropped and recorded. */
function usableOrigin(
  params: Params,
  scope: ControlScope,
  method: string,
  handlers: ControlHandlers
): string | undefined {
  const value = params.origin
  if (value === undefined || value === null) return undefined
  if (acceptableOrigin(value, scope)) return value as string
  // The refused word is never echoed: a caller must not be able to write its own line into the refusal log.
  handlers.reportRefusal(
    method,
    scope.kind === 'session' ? scope.sessionId : null,
    'origin refused: unknown provenance for this credential'
  )
  return undefined
}

function requireEffects(params: Params, key: string): HookEventEffect[] {
  const value = params[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${key} must be an array`)
  if (value.length > MAX_HOOK_EVENT_EFFECTS) {
    throw invalid(`${key} must hold at most ${MAX_HOOK_EVENT_EFFECTS} entries`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !(HOOK_EVENT_EFFECTS as readonly string[]).includes(entry)) {
      throw invalid(`${key} entries must be one of: ${HOOK_EVENT_EFFECTS.join(', ')}`)
    }
  }
  return value as HookEventEffect[]
}

function requestId(message: unknown): RequestId {
  if (!isRecord(message)) return null
  const { id } = message
  if (typeof id === 'string' && id.length <= 128) return id
  if (typeof id === 'number' && Number.isFinite(id)) return id
  return null
}

function parseRequest(message: unknown): ControlRequest {
  if (!isRecord(message)) throw invalid('Request must be a JSON-RPC 2.0 object')
  for (const key of Object.keys(message)) {
    if (!REQUEST_KEYS.includes(key)) throw invalid(`Unknown request member: ${key.slice(0, 64)}`)
  }
  if (message.jsonrpc !== '2.0') throw invalid('jsonrpc must be "2.0"')
  const id = requestId(message)
  if (id === null) throw invalid('Request id must be a finite number or a string of at most 128 characters')
  if (typeof message.method !== 'string' || message.method.length === 0) {
    throw invalid('method must be a non-empty string')
  }
  if (message.params !== undefined && !isRecord(message.params)) throw invalid('params must be an object')
  return { id, method: message.method, params: message.params }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function paramsHash(params: Params): string {
  const rest = { ...params }
  delete rest.idempotencyKey
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

function withDuplicate(result: unknown): unknown {
  return isRecord(result) ? { ...result, duplicate: true } : { result: result ?? null, duplicate: true }
}

function incarnationOf(scope: ControlScope): string | null {
  return scope.kind === 'session' ? scope.incarnationId : null
}

function scopeKey(scope: ControlScope): string {
  return scope.kind === 'owner' ? 'owner' : `session:${scope.sessionId}`
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy()
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stats
  try {
    stats = await lstat(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSocket()) throw new Error('Refusing to replace a non-socket file at the control socket path')
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Control socket is already in use by a live server')
  }
  try {
    await unlink(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class ControlServer {
  private server: Server | undefined
  private readonly connections = new Set<Connection>()
  private readonly receiptLocks = new Map<string, Promise<void>>()
  private readonly now: () => Date

  constructor(private readonly options: ControlServerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error('Control server is already listening')
    const { socketPath } = this.options
    const directory = dirname(socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await removeStaleSocket(socketPath)
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    try {
      await chmod(socketPath, 0o600)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Node unlinks the socket path when a listening pipe server closes. */
  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    for (const connection of this.connections) {
      connection.closing = true
      connection.socket.destroy()
    }
    this.connections.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      scope: null,
      buffered: [],
      bufferedBytes: 0,
      closing: false,
      discarding: false,
      queue: Promise.resolve()
    }
    this.connections.add(connection)
    socket.on('data', (chunk: Buffer) => this.receive(connection, chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      connection.closing = true
      this.connections.delete(connection)
    })
  }

  private receive(connection: Connection, chunk: Buffer): void {
    if (connection.closing || connection.discarding) return
    let start = 0
    let newline = chunk.indexOf(0x0a, start)
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline)
      if (connection.bufferedBytes + piece.byteLength > MAX_CONTROL_FRAME_BYTES) {
        this.rejectOversize(connection)
        return
      }
      const line = Buffer.concat([...connection.buffered, piece])
      connection.buffered = []
      connection.bufferedBytes = 0
      this.enqueue(connection, () => this.handleLine(connection, line))
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    const rest = chunk.subarray(start)
    if (connection.bufferedBytes + rest.byteLength > MAX_CONTROL_FRAME_BYTES) {
      this.rejectOversize(connection)
      return
    }
    if (rest.byteLength > 0) {
      connection.buffered.push(Buffer.from(rest))
      connection.bufferedBytes += rest.byteLength
    }
  }

  /** Earlier complete lines still run first; everything after the oversize line is discarded. */
  private rejectOversize(connection: Connection): void {
    connection.discarding = true
    connection.buffered = []
    connection.bufferedBytes = 0
    this.enqueue(connection, async () => {
      this.fail(connection, null, invalid(`Request line exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`), true)
    })
  }

  private enqueue(connection: Connection, task: () => Promise<void>): void {
    connection.queue = connection.queue
      .then(async () => {
        if (!connection.closing) await task()
      })
      .catch(() => {
        connection.closing = true
        connection.socket.destroy()
      })
  }

  private async handleLine(connection: Connection, line: Buffer): Promise<void> {
    const beforeAuth = connection.scope === null
    let text: string
    try {
      text = utf8.decode(line)
    } catch {
      this.fail(connection, null, invalid('Request is not valid UTF-8'), beforeAuth)
      return
    }
    if (text.trim() === '') return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.fail(connection, null, invalid('Request is not valid JSON'), beforeAuth)
      return
    }
    let request: ControlRequest
    try {
      request = parseRequest(message)
    } catch (error) {
      this.fail(connection, requestId(message), error, beforeAuth)
      return
    }
    const scope = connection.scope
    if (scope === null) {
      this.authenticate(connection, request)
      return
    }
    try {
      this.assertNotRevoked(scope)
    } catch (error) {
      this.fail(connection, request.id, error, true)
      return
    }
    try {
      const result = await this.dispatch(scope, request.method, request.params)
      this.respond(connection, { jsonrpc: '2.0', id: request.id, result: result ?? null })
    } catch (error) {
      this.fail(connection, request.id, error, false)
    }
  }

  private authenticate(connection: Connection, request: ControlRequest): void {
    try {
      if (request.method !== 'auth') throw unauthorized('The first request on a connection must be auth')
      const params = closedParams(request.params, ['token'])
      const scope = this.options.auth.verify(params.token)
      if (scope === null) throw unauthorized('Invalid credential')
      this.assertNotRevoked(scope)
      connection.scope = scope
      this.respond(connection, {
        jsonrpc: '2.0',
        id: request.id,
        result: scope.kind === 'owner' ? { scope: 'owner' } : { scope: 'session', sessionId: scope.sessionId }
      })
    } catch (error) {
      this.fail(connection, request.id, error, true)
    }
  }

  private assertNotRevoked(scope: ControlScope): void {
    if (
      scope.kind === 'session' &&
      !this.options.handlers.isCurrentIncarnation(scope.sessionId, scope.incarnationId)
    ) {
      throw unauthorized('Credential revoked')
    }
  }

  private respond(connection: Connection, payload: Record<string, unknown>): void {
    if (connection.closing) return
    let line: string
    try {
      line = JSON.stringify(payload)
    } catch {
      line = JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id ?? null,
        error: {
          code: JSONRPC_SERVER_ERROR,
          message: 'Control result could not be encoded',
          data: { code: ERROR_CODES.ioError, retryable: false }
        }
      })
    }
    connection.socket.write(`${line}\n`)
  }

  private fail(connection: Connection, id: RequestId, error: unknown, close: boolean): void {
    const controlError = this.toControlError(error)
    this.respond(connection, {
      jsonrpc: '2.0',
      id,
      error: {
        code: JSONRPC_SERVER_ERROR,
        message: this.redact(controlError.message),
        data: { code: controlError.code, retryable: controlError.retryable }
      }
    })
    if (!close || connection.closing) return
    connection.closing = true
    connection.socket.end()
    setTimeout(() => connection.socket.destroy(), CLOSE_GRACE_MS).unref()
  }

  private toControlError(error: unknown): ControlError {
    if (error instanceof ControlError) return error
    const detail = error instanceof Error ? error.message : String(error)
    return new ControlError(ERROR_CODES.ioError, `Control request failed: ${detail}`)
  }

  private redact(message: string): string {
    const { ownerToken } = this.options.auth
    return message
      .split(ownerToken)
      .join('[redacted]')
      .replace(SESSION_TOKEN_TEXT, '[redacted]')
      .replace(LONG_HEX_TEXT, '[redacted]')
      .slice(0, MAX_ERROR_MESSAGE_LENGTH)
  }

  /** Session scope may omit sessionId (own) or name only itself; owner scope must name an existing session. */
  private target(scope: ControlScope, params: Params): string {
    const requested = readText(params, 'sessionId', RULES.sessionId)
    if (scope.kind === 'session') {
      if (requested !== undefined && requested !== scope.sessionId) {
        throw unauthorized('Session credentials may only target their own session')
      }
      return scope.sessionId
    }
    if (requested === undefined) throw invalid('sessionId is required for owner requests')
    if (!this.options.handlers.sessionExists(requested)) {
      throw new ControlError(ERROR_CODES.notFound, 'Session not found')
    }
    return requested
  }

  private async dispatch(scope: ControlScope, method: string, rawParams: unknown): Promise<unknown> {
    const { handlers } = this.options
    switch (method) {
      case 'auth':
        throw invalid('Connection is already authenticated')
      case 'state.snapshot': {
        closedParams(rawParams, [])
        const snapshot = await handlers.snapshot(scope)
        if (!isRecord(snapshot) || typeof snapshot.watermark !== 'number' || !Number.isFinite(snapshot.watermark)) {
          throw new ControlError(ERROR_CODES.ioError, 'State snapshot is missing its watermark', true)
        }
        return snapshot
      }
      case 'session.list':
        closedParams(rawParams, [])
        return handlers.listSessions(scope)
      case 'artifact.publish': {
        const params = closedParams(rawParams, ['sessionId', 'path', 'name', 'idempotencyKey'])
        const path = requireText(params, 'path', RULES.path)
        if (!isAbsolute(path)) throw invalid('path must be absolute')
        const name = readText(params, 'name', RULES.name)
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.publishArtifact({
          sessionId,
          incarnationId: incarnationOf(scope),
          path,
          ...(name === undefined ? {} : { name }),
          source: scope.kind === 'session' ? 'agent' : 'owner'
        }))
      }
      case 'progress.report': {
        const params = closedParams(rawParams, ['sessionId', 'source', 'state', 'label', 'detail', 'observedAt'])
        const source = requireText(params, 'source', RULES.source)
        const state = requireEnum(params, 'state', PROGRESS_STATES)
        const label = requireText(params, 'label', RULES.label)
        const detail = readText(params, 'detail', RULES.detail)
        const observedAt = readTimestamp(params, 'observedAt') ?? this.now().toISOString()
        const sessionId = this.target(scope, params)
        return handlers.reportProgress({
          sessionId,
          incarnationId: incarnationOf(scope),
          source,
          state,
          label,
          ...(detail === undefined ? {} : { detail }),
          observedAt
        })
      }
      case 'attention.open': {
        const params = closedParams(rawParams, [
          'sessionId', 'requestKey', 'kind', 'title', 'body', 'expiresAt', 'idempotencyKey', 'phoneNotified',
          'origin'
        ])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        const kind = requireEnum(params, 'kind', ATTENTION_KINDS)
        const title = requireText(params, 'title', RULES.title)
        const body = readText(params, 'body', RULES.body)
        const expiresAt = readTimestamp(params, 'expiresAt')
        const idempotencyKey = readText(params, 'idempotencyKey', RULES.idempotencyKey)
        const phoneNotified = readBoolean(params, 'phoneNotified')
        const origin = usableOrigin(params, scope, method, handlers)
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.openAttention({
          sessionId,
          incarnationId: incarnationOf(scope),
          requestKey,
          kind,
          title,
          ...(body === undefined ? {} : { body }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(phoneNotified === undefined ? {} : { phoneNotified }),
          ...(origin === undefined ? {} : { origin })
        }))
      }
      case 'conversation.observe': {
        // A hook discards what this call answers, so every refusal is recorded instead of vanishing.
        try {
          const params = closedParams(rawParams, [
            'sessionId', 'agentCli', 'conversationReference', 'source', 'transcriptPath'
          ])
          // The owner keeps the explicit replace route; only a session may speak for its own process.
          if (scope.kind !== 'session') {
            throw unauthorized('Only a session credential may report its own conversation')
          }
          const observedCli = requireEnum(params, 'agentCli', CONVERSATION_AGENT_CLIS)
          const conversationReference = requireText(params, 'conversationReference', RULES.conversationReference)
          if (!CONVERSATION_REFERENCE.test(conversationReference)) {
            throw invalid('conversationReference must be a UUID')
          }
          const source = requireEnum(params, 'source', CONVERSATION_OBSERVATION_SOURCES)
          const transcriptPath = readText(params, 'transcriptPath', RULES.path)
          if (transcriptPath !== undefined && !isAbsolute(transcriptPath)) {
            throw invalid('transcriptPath must be absolute')
          }
          const sessionId = this.target(scope, params)
          return await handlers.observeConversation({
            sessionId,
            incarnationId: incarnationOf(scope),
            agentCli: observedCli,
            conversationReference: conversationReference.toLowerCase(),
            source,
            ...(transcriptPath === undefined ? {} : { transcriptPath })
          })
        } catch (error) {
          handlers.reportRefusal(
            method,
            scope.kind === 'session' ? scope.sessionId : null,
            this.redact(this.toControlError(error).message)
          )
          throw error
        }
      }
      case 'attention.withdraw': {
        const params = closedParams(rawParams, ['sessionId', 'requestKey', 'origin'])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        const origin = usableOrigin(params, scope, method, handlers)
        const sessionId = this.target(scope, params)
        return handlers.withdrawAttention({ sessionId, requestKey, ...(origin === undefined ? {} : { origin }) })
      }
      case 'attention.resolve': {
        const params = closedParams(rawParams, ['sessionId', 'requestKey', 'resolution', 'origin'])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        const resolution = requireText(params, 'resolution', RULES.resolution)
        const origin = usableOrigin(params, scope, method, handlers)
        const sessionId = this.target(scope, params)
        return handlers.resolveAttention({
          sessionId,
          requestKey,
          resolution,
          ...(origin === undefined ? {} : { origin })
        })
      }
      case 'hook.observe': {
        // The log is a record of what the harness reported, never a reason to act: it opens nothing.
        const params = closedParams(rawParams, ['sessionId', 'agent', 'event', 'source', 'toolName', 'effects'])
        const agent = requireEnum(params, 'agent', HOOK_EVENT_AGENTS)
        const event = requireText(params, 'event', RULES.source)
        if (!isHookEventName(event)) throw invalid('event must be printable ASCII without spaces')
        const source = readText(params, 'source', RULES.source)
        const toolName = readText(params, 'toolName', RULES.source)
        const effects = requireEffects(params, 'effects')
        const sessionId = this.target(scope, params)
        return handlers.observeHookEvent({
          sessionId,
          agent,
          event,
          source: source ?? null,
          toolName: toolName ?? null,
          effects
        })
      }
      case 'input.submit': {
        const params = closedParams(rawParams, ['sessionId', 'text', 'submit', 'idempotencyKey'])
        const text = requireText(params, 'text', RULES.text)
        const submit = readBoolean(params, 'submit') ?? false
        if (text.length === 0 && !submit) throw invalid('text is empty and submit is false')
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, async () => {
          await handlers.submitInput({ sessionId, text, submit })
          return { ok: true }
        })
      }
      default:
        throw invalid(`Unknown method: ${method.slice(0, 64)}`)
    }
  }

  /**
   * Receipts make retries safe: a staged receipt means an earlier delivery may have happened before a crash,
   * so it is reported as uncertain and never repeated.
   */
  private async idempotent(
    scope: ControlScope,
    method: string,
    idempotencyKey: string | undefined,
    params: Params,
    run: () => Promise<unknown>
  ): Promise<unknown> {
    if (idempotencyKey === undefined) return run()
    const key = `${scopeKey(scope)}|${method}|${idempotencyKey}`
    const hash = paramsHash(params)
    return this.withReceiptLock(key, async () => {
      const { receipts } = this.options
      const existing = await receipts.get(key)
      if (existing !== undefined) {
        if (existing.paramsHash !== hash) {
          throw new ControlError(ERROR_CODES.revisionConflict, 'idempotency key reused with different parameters')
        }
        if (existing.state === 'done') return withDuplicate(existing.result)
        if (existing.state === 'staged') return { state: 'uncertain', duplicate: true }
        const stored = existing.error
        const code = stored && isProtocolErrorCode(stored.code) ? stored.code : ERROR_CODES.ioError
        throw new ControlError(code, stored?.message || 'Earlier attempt failed')
      }
      await receipts.put({ key, paramsHash: hash, state: 'staged' })
      let result: unknown
      try {
        result = await run()
      } catch (error) {
        const controlError = this.toControlError(error)
        const message = this.redact(controlError.message)
        // A lost failure record leaves the receipt staged: later replays report 'uncertain', never re-run.
        await receipts
          .put({ key, paramsHash: hash, state: 'failed', error: { code: controlError.code, message } })
          .catch(() => undefined)
        throw new ControlError(controlError.code, message, controlError.retryable)
      }
      // The effect already happened; a lost done record degrades replays to 'uncertain', never a second delivery.
      await receipts.put({ key, paramsHash: hash, state: 'done', result }).catch(() => undefined)
      return result
    })
  }

  private async withReceiptLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.receiptLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = previous.then(() => current)
    this.receiptLocks.set(key, chained)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.receiptLocks.get(key) === chained) this.receiptLocks.delete(key)
    }
  }
}
