// MODULE: telegram-connector.ts - Telegram Bot API long-poll connector with a per-token lock, sender allowlist and token redaction
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const API_ORIGIN = 'https://api.telegram.org'
const MESSAGE_CHAR_LIMIT = 4096
const DEFAULT_POLL_TIMEOUT_SECONDS = 25
const POLL_GRACE_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 300_000
const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const LOCK_ATTEMPTS = 3

export type ConnectorState = 'disabled' | 'starting' | 'polling' | 'backoff' | 'conflict' | 'unauthorized' | 'stopped'

export interface ConnectorHealth {
  state: ConnectorState
  detail: string
  lastPollAt: string | null
  lastError: string | null
  rejectedUpdates: number
}

export interface InboundReply {
  updateId: number
  chatId: number
  fromUserId: number
  messageId: number
  replyToMessageId: number | null
  text: string | null
  file: {
    fileId: string
    fileName: string
    mimeType: string | null
    fileSize: number | null
    kind: 'document' | 'photo'
  } | null
}

export interface TelegramConnectorOptions {
  token: string
  allowedChatId: number
  /** null accepts any sender, but only when the allowed chat is a private chat. */
  allowedUserId: number | null
  fetch: typeof fetch
  now?: () => Date
  lockDirectory: string
  isPidAlive?: (pid: number) => boolean
  offset: { get(): Promise<number | null>; set(next: number): Promise<void> }
  onReply(reply: InboundReply): Promise<void>
  onHealth(health: ConnectorHealth): void
  pollTimeoutSeconds?: number
  sleep?: (ms: number) => Promise<void>
}

export type TelegramErrorKind =
  | 'conflict'
  | 'unauthorized'
  | 'http'
  | 'network'
  | 'protocol'
  | 'too-large'
  | 'invalid-argument'

export class TelegramConnectorError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'TelegramConnectorError'
  }
}

type LockResult = { acquired: true; nonce: string } | { acquired: false; pid: number | null }

type ParsedUpdate = { updateId: number; outcome: InboundReply | 'ignored' | 'rejected' }

/** Shows at most four leading and four trailing characters, and fewer for short tokens. */
export function maskToken(token: string): string {
  if (token.length === 0) return ''
  const visible = Math.min(4, Math.floor(token.length / 4))
  if (visible === 0) return '…'
  return `${token.slice(0, visible)}…${token.slice(-visible)}`
}

/** Replaces the token, its URL-encoded form and its secret half (after ':') with the masked token. */
export function redactToken(text: string, token: string): string {
  if (token.length === 0) return text
  const masked = maskToken(token)
  const secret = token.includes(':') ? token.slice(token.indexOf(':') + 1) : ''
  const forms = [token, encodeURIComponent(token), ...(secret.length >= 8 ? [secret] : [])]
  return forms
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, form) => redacted.split(form).join(masked), text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockFileName(token: string): string {
  return `telegram-${createHash('sha256').update(token).digest('hex').slice(0, 16)}.lock`
}

async function readLockHolder(path: string): Promise<{ raw: string; pid: number | null } | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value: unknown = JSON.parse(raw)
    return { raw, pid: isRecord(value) && isInteger(value.pid) && value.pid > 0 ? value.pid : null }
  } catch {
    return { raw, pid: null }
  }
}

/**
 * The lock is created with link() so it appears atomically with complete content. A stale lock is
 * renamed aside and compared with what was read, so a lock that another process took over in the
 * meantime is put back instead of being deleted.
 */
async function acquireLock(path: string, isPidAlive: (pid: number) => boolean): Promise<LockResult> {
  const nonce = randomUUID()
  const temporary = `${path}.${process.pid}.${nonce}.tmp`
  await writeFile(temporary, JSON.stringify({ pid: process.pid, nonce }), { encoding: 'utf8', mode: 0o600 })
  try {
    let lastPid: number | null = null
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await link(temporary, path)
        return { acquired: true, nonce }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const holder = await readLockHolder(path)
      if (!holder) continue
      lastPid = holder.pid
      if (holder.pid !== null && isPidAlive(holder.pid)) return { acquired: false, pid: holder.pid }
      const aside = `${path}.${nonce}.stale`
      try {
        await rename(path, aside)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const moved = await readFile(aside, 'utf8').catch(() => null)
      if (moved !== holder.raw) await link(aside, path).catch(() => undefined)
      await unlink(aside).catch(() => undefined)
    }
    return { acquired: false, pid: lastPid }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function largestPhoto(sizes: unknown[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null
  let bestArea = -1
  let bestBytes = -1
  for (const size of sizes) {
    if (!isRecord(size) || !isText(size.file_id)) continue
    const area = (isInteger(size.width) ? size.width : 0) * (isInteger(size.height) ? size.height : 0)
    const bytes = isInteger(size.file_size) ? size.file_size : 0
    if (area > bestArea || (area === bestArea && bytes > bestBytes)) {
      best = size
      bestArea = area
      bestBytes = bytes
    }
  }
  return best
}

function attachedFile(message: Record<string, unknown>, messageId: number): InboundReply['file'] {
  const document = message.document
  if (isRecord(document) && isText(document.file_id)) {
    return {
      fileId: document.file_id,
      fileName: isText(document.file_name) ? document.file_name : `document-${messageId}`,
      mimeType: isText(document.mime_type) ? document.mime_type : null,
      fileSize: isInteger(document.file_size) ? document.file_size : null,
      kind: 'document'
    }
  }
  if (!Array.isArray(message.photo)) return null
  const photo = largestPhoto(message.photo)
  if (!photo) return null
  return {
    fileId: photo.file_id as string,
    fileName: `photo-${messageId}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: isInteger(photo.file_size) ? photo.file_size : null,
    kind: 'photo'
  }
}

function parseUpdate(
  update: Record<string, unknown> & { update_id: number },
  allowedChatId: number,
  allowedUserId: number | null
): ParsedUpdate {
  const updateId = update.update_id
  const message = update.message
  if (!isRecord(message)) return { updateId, outcome: 'ignored' }
  const chat = message.chat
  const from = message.from
  if (!isRecord(chat) || chat.id !== allowedChatId) return { updateId, outcome: 'rejected' }
  if (allowedUserId === null && chat.type !== 'private') return { updateId, outcome: 'rejected' }
  if (!isRecord(from) || !isInteger(from.id)) return { updateId, outcome: 'rejected' }
  if (allowedUserId !== null && from.id !== allowedUserId) return { updateId, outcome: 'rejected' }
  if (!isInteger(message.message_id)) return { updateId, outcome: 'rejected' }
  const replyTo = message.reply_to_message
  const text = typeof message.text === 'string'
    ? message.text
    : typeof message.caption === 'string' ? message.caption : null
  return {
    updateId,
    outcome: {
      updateId,
      chatId: allowedChatId,
      fromUserId: from.id,
      messageId: message.message_id,
      replyToMessageId: isRecord(replyTo) && isInteger(replyTo.message_id) ? replyTo.message_id : null,
      text,
      file: attachedFile(message, message.message_id)
    }
  }
}

function truncateMessage(text: string): string {
  if (text.length <= MESSAGE_CHAR_LIMIT) return text
  let end = MESSAGE_CHAR_LIMIT - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

export class TelegramConnector {
  private readonly options: TelegramConnectorOptions
  private readonly lockPath: string
  private readonly pollTimeoutSeconds: number
  private readonly now: () => Date
  private readonly isPidAlive: (pid: number) => boolean
  private current: ConnectorHealth = {
    state: 'disabled',
    detail: 'Telegram connector has not started',
    lastPollAt: null,
    lastError: null,
    rejectedUpdates: 0
  }
  private controller: AbortController | null = null
  private starting: Promise<void> | null = null
  private loop: Promise<void> | null = null
  private lockNonce: string | null = null
  private verified = false
  private backoffMs = 0
  private offsetLoaded = false
  private nextOffset: number | null = null

  constructor(options: TelegramConnectorOptions) {
    if (!isText(options.token)) {
      throw new TelegramConnectorError('invalid-argument', 'Telegram bot token is required')
    }
    if (!isInteger(options.allowedChatId)) {
      throw new TelegramConnectorError('invalid-argument', 'Allowed Telegram chat id must be an integer')
    }
    if (options.allowedUserId !== null && !isInteger(options.allowedUserId)) {
      throw new TelegramConnectorError('invalid-argument', 'Allowed Telegram user id must be an integer or null')
    }
    const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    if (!isInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 0) {
      throw new TelegramConnectorError('invalid-argument', 'Telegram poll timeout must be a non-negative integer')
    }
    this.options = options
    this.pollTimeoutSeconds = pollTimeoutSeconds
    this.lockPath = join(options.lockDirectory, lockFileName(options.token))
    this.now = options.now ?? (() => new Date())
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  }

  /**
   * Acquires the per-token lock and checks the token with getMe, then polls in the background.
   * Rejects when another live process holds the lock ('conflict') or Telegram rejects the token
   * ('unauthorized'). A network or server failure during getMe does not reject: the connector enters
   * 'backoff' and keeps retrying.
   */
  async start(): Promise<void> {
    if (this.controller) return
    const controller = new AbortController()
    this.controller = controller
    const starting = this.begin(controller.signal)
    this.starting = starting
    await starting
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.starting?.catch(() => undefined)
    await this.loop?.catch(() => undefined)
    this.controller = null
    this.starting = null
    this.loop = null
    this.backoffMs = 0
    await this.releaseLock()
    this.publish({ state: 'stopped', detail: 'Telegram connector stopped' })
  }

  health(): ConnectorHealth {
    return { ...this.current }
  }

  async sendMessage(text: string, options: { replyToMessageId?: number } = {}): Promise<{ messageId: number }> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TelegramConnectorError('invalid-argument', 'Telegram message text must not be empty')
    }
    if (options.replyToMessageId !== undefined && !isInteger(options.replyToMessageId)) {
      throw new TelegramConnectorError('invalid-argument', 'Telegram reply target must be an integer message id')
    }
    const result = await this.call('sendMessage', {
      chat_id: this.options.allowedChatId,
      text: truncateMessage(text),
      ...(options.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }
        : {})
    }, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    if (!isRecord(result) || !isInteger(result.message_id)) {
      throw new TelegramConnectorError('protocol', 'Telegram sendMessage returned a malformed result')
    }
    return { messageId: result.message_id }
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<{ bytes: Uint8Array; filePath: string }> {
    if (!isText(fileId)) throw new TelegramConnectorError('invalid-argument', 'Telegram file id is required')
    if (!isInteger(maxBytes) || maxBytes <= 0) {
      throw new TelegramConnectorError('invalid-argument', 'Download limit must be a positive integer')
    }
    const file = await this.call('getFile', { file_id: fileId }, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    if (!isRecord(file) || !isText(file.file_path)) {
      throw new TelegramConnectorError('protocol', 'Telegram did not return a downloadable path for this file')
    }
    if (isInteger(file.file_size) && file.file_size > maxBytes) {
      throw this.tooLarge(maxBytes)
    }
    const filePath = file.file_path
    const encodedPath = filePath.split('/').map((part) => encodeURIComponent(part)).join('/')
    const response = await this.request(
      `${API_ORIGIN}/file/bot${this.options.token}/${encodedPath}`,
      { method: 'GET', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      'file download'
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new TelegramConnectorError('http', `Telegram file download failed (${response.status})`, response.status)
    }
    const declared = Number(response.headers.get('content-length'))
    if (response.headers.has('content-length') && Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw this.tooLarge(maxBytes)
    }
    return { bytes: await this.readLimited(response, maxBytes), filePath }
  }

  private async begin(signal: AbortSignal): Promise<void> {
    this.publish({ state: 'starting', detail: 'Connecting to Telegram', lastError: null })
    await mkdir(this.options.lockDirectory, { recursive: true, mode: 0o700 })
    const lock = await acquireLock(this.lockPath, this.isPidAlive)
    if (!lock.acquired) {
      this.controller = null
      const detail = lock.pid === null
        ? 'Another process holds the Telegram connector lock for this bot token'
        : `Another process (pid ${lock.pid}) is already running the Telegram connector for this bot token`
      this.publish({ state: 'conflict', detail, lastError: detail })
      throw new TelegramConnectorError('conflict', detail)
    }
    this.lockNonce = lock.nonce
    if (signal.aborted) return
    this.verified = false
    this.backoffMs = 0
    try {
      await this.call('getMe', {}, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]))
      this.verified = true
      this.publish({ state: 'polling', detail: 'Waiting for Telegram replies' })
    } catch (error) {
      if (signal.aborted) return
      if (await this.recordFailure(error) === 'halt') throw this.sanitized(error)
    }
    this.loop = this.run(signal)
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.backoffMs > 0) {
        await this.pause(this.backoffMs, signal)
        if (signal.aborted) return
      }
      try {
        if (!this.verified) {
          await this.call('getMe', {}, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]))
          this.verified = true
        }
        const updates = await this.getUpdates(signal)
        this.backoffMs = 0
        this.publish({
          state: 'polling',
          detail: 'Waiting for Telegram replies',
          lastPollAt: this.now().toISOString()
        })
        await this.handleUpdates(updates, signal)
      } catch (error) {
        if (signal.aborted) return
        if (await this.recordFailure(error) === 'halt') return
      }
    }
  }

  private async getUpdates(signal: AbortSignal): Promise<Array<Record<string, unknown> & { update_id: number }>> {
    if (!this.offsetLoaded) {
      this.nextOffset = await this.options.offset.get()
      this.offsetLoaded = true
    }
    const result = await this.call('getUpdates', {
      ...(this.nextOffset !== null ? { offset: this.nextOffset } : {}),
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message']
    }, AbortSignal.any([signal, AbortSignal.timeout(this.pollTimeoutSeconds * 1000 + POLL_GRACE_MS)]))
    if (!Array.isArray(result)) {
      throw new TelegramConnectorError('protocol', 'Telegram getUpdates returned a malformed result')
    }
    const updates = result.filter(
      (update): update is Record<string, unknown> & { update_id: number } =>
        isRecord(update) && isInteger(update.update_id)
    )
    if (result.length > 0 && updates.length === 0) {
      throw new TelegramConnectorError('protocol', 'Telegram getUpdates returned updates without ids')
    }
    return updates.sort((left, right) => left.update_id - right.update_id)
  }

  /**
   * Delivery is at most once per update: the offset advances after onReply settles even when it
   * throws, so a failing handler is reported through lastError instead of being redelivered forever.
   * Rejected senders never reach onReply and their files are never downloaded.
   */
  private async handleUpdates(
    updates: Array<Record<string, unknown> & { update_id: number }>,
    signal: AbortSignal
  ): Promise<void> {
    for (const update of updates) {
      if (signal.aborted) return
      if (this.nextOffset !== null && update.update_id < this.nextOffset) continue
      const { updateId, outcome } = parseUpdate(update, this.options.allowedChatId, this.options.allowedUserId)
      if (outcome === 'rejected') {
        this.publish({ rejectedUpdates: this.current.rejectedUpdates + 1 })
      } else if (outcome !== 'ignored') {
        try {
          await this.options.onReply(outcome)
        } catch (error) {
          this.publish({ lastError: `Reply handler failed for update ${updateId}: ${errorMessage(error)}` })
        }
      }
      await this.advance(updateId + 1)
    }
  }

  /** Telegram confirms updates below the next offset on the following poll, so a failed save is reported, not retried. */
  private async advance(next: number): Promise<void> {
    this.nextOffset = next
    try {
      await this.options.offset.set(next)
    } catch (error) {
      this.publish({ lastError: `Could not save the Telegram update offset: ${errorMessage(error)}` })
    }
  }

  private async recordFailure(error: unknown): Promise<'halt' | 'retry'> {
    const message = errorMessage(error)
    const status = error instanceof TelegramConnectorError ? error.status : null
    if (status === 409) {
      await this.halt()
      this.publish({ state: 'conflict', detail: 'Another client is polling this bot token', lastError: message })
      return 'halt'
    }
    if (status === 401 || status === 404) {
      await this.halt()
      this.publish({ state: 'unauthorized', detail: 'Telegram rejected the bot token', lastError: message })
      return 'halt'
    }
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.publish({
      state: 'backoff',
      detail: `Telegram is unreachable; retrying in ${Math.round(this.backoffMs / 1000)}s`,
      lastError: message
    })
    return 'retry'
  }

  private async halt(): Promise<void> {
    this.controller = null
    this.backoffMs = 0
    await this.releaseLock()
  }

  private async releaseLock(): Promise<void> {
    const nonce = this.lockNonce
    if (!nonce) return
    this.lockNonce = null
    const holder = await readLockHolder(this.lockPath).catch(() => null)
    if (!holder) return
    try {
      const value: unknown = JSON.parse(holder.raw)
      if (isRecord(value) && value.nonce === nonce) await unlink(this.lockPath)
    } catch {
      // A lock we no longer own (or cannot parse) is left for its holder.
    }
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (!this.options.sleep) {
      await delay(ms, undefined, { signal }).catch(() => undefined)
      return
    }
    let onAbort: () => void = () => undefined
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([this.options.sleep(ms), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`${API_ORIGIN}/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal
    }, method)
    const payload: unknown = await response.json().catch(() => null)
    if (response.ok && isRecord(payload) && payload.ok === true) return payload.result
    const status = !response.ok
      ? response.status
      : isRecord(payload) && isInteger(payload.error_code) ? payload.error_code : response.status
    const description = isRecord(payload) && typeof payload.description === 'string'
      ? payload.description
      : response.statusText || 'no description'
    const kind: TelegramErrorKind = status === 409 ? 'conflict' : status === 401 || status === 404 ? 'unauthorized' : 'http'
    throw new TelegramConnectorError(kind, this.redact(`Telegram ${method} failed (${status}): ${description}`), status)
  }

  private async request(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.options.fetch(url, init)
    } catch (error) {
      throw new TelegramConnectorError('network', this.redact(`Telegram ${label} request failed: ${errorMessage(error)}`))
    }
  }

  private async readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array(0)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw this.tooLarge(maxBytes)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  private tooLarge(maxBytes: number): TelegramConnectorError {
    return new TelegramConnectorError('too-large', `Telegram file is larger than the ${maxBytes}-byte limit`)
  }

  private sanitized(error: unknown): Error {
    if (error instanceof TelegramConnectorError) return error
    return new TelegramConnectorError('network', this.redact(errorMessage(error)))
  }

  private redact(text: string): string {
    return redactToken(text, this.options.token)
  }

  private publish(patch: Partial<ConnectorHealth>): void {
    const next = { ...this.current, ...patch }
    this.current = {
      ...next,
      detail: this.redact(next.detail),
      lastError: next.lastError === null ? null : this.redact(next.lastError)
    }
    try {
      this.options.onHealth(this.health())
    } catch {
      // A faulty health observer must not stop polling.
    }
  }
}
