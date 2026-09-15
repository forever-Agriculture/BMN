// MODULE: telegram-connector.test.ts - fake-fetch coverage of polling, sender allowlist, lock, backoff, redaction and downloads
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TelegramConnector,
  maskToken,
  redactToken,
  type ConnectorHealth,
  type InboundReply,
  type TelegramConnectorOptions
} from './telegram-connector'

const TOKEN = '987654321:FAKE-test-token-not-real-ZyXwVuTsRq'
const TOKEN_SECRET = TOKEN.slice(TOKEN.indexOf(':') + 1)
const CHAT_ID = 5550001
const USER_ID = 5550001
const NOW = '2026-09-14T10:00:00.000Z'

interface RecordedCall {
  url: string
  method: string
  body: Record<string, unknown>
  signal: AbortSignal | null
}

type Handler = (call: RecordedCall) => Response | Promise<Response>

const createdRoots = new Set<string>()
const connectors = new Set<TelegramConnector>()

afterEach(async () => {
  await Promise.all([...connectors].map((connector) => connector.stop()))
  connectors.clear()
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ok(result: unknown): Response {
  return json(200, { ok: true, result })
}

function apiError(status: number, description: string): Response {
  return json(status, { ok: false, error_code: status, description })
}

function pendingUntilAbort(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    const abort = (): void => reject(new DOMException('The operation was aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

class FakeBotApi {
  readonly calls: RecordedCall[] = []
  /** Scripted getUpdates answers; once drained, getUpdates hangs like a long poll until aborted. */
  readonly updates: Handler[] = []
  readonly handlers = new Map<string, Handler>()
  getMe: Handler = () => ok({ id: 1, is_bot: true, username: 'fake_test_bot' })

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const isFile = url.includes('/file/bot')
    const method = isFile ? 'file' : url.slice(url.lastIndexOf('/') + 1)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const call: RecordedCall = { url, method, body, signal: init?.signal ?? null }
    this.calls.push(call)
    if (method === 'getMe') return this.getMe(call)
    if (method === 'getUpdates') {
      const next = this.updates.shift()
      return next ? next(call) : pendingUntilAbort(call.signal)
    }
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`unexpected Telegram method ${method}`)
    return handler(call)
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length
  }

  polls(): RecordedCall[] {
    return this.calls.filter((call) => call.method === 'getUpdates')
  }
}

class MemoryOffset {
  value: number | null = null
  readonly saved: number[] = []

  async get(): Promise<number | null> {
    return this.value
  }

  async set(next: number): Promise<void> {
    this.value = next
    this.saved.push(next)
  }
}

interface Harness {
  api: FakeBotApi
  connector: TelegramConnector
  offset: MemoryOffset
  replies: InboundReply[]
  healths: ConnectorHealth[]
  sleeps: number[]
  lockDirectory: string
}

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiterm-telegram-test-'))
  createdRoots.add(root)
  return root
}

async function harness(
  overrides: Partial<TelegramConnectorOptions> & { api?: FakeBotApi; offsetStore?: MemoryOffset } = {}
): Promise<Harness> {
  const { api = new FakeBotApi(), offsetStore = new MemoryOffset(), ...options } = overrides
  const replies: InboundReply[] = []
  const healths: ConnectorHealth[] = []
  const sleeps: number[] = []
  const lockDirectory = options.lockDirectory ?? await tempDirectory()
  const connector = new TelegramConnector({
    token: TOKEN,
    allowedChatId: CHAT_ID,
    allowedUserId: USER_ID,
    fetch: api.fetch,
    now: () => new Date(NOW),
    lockDirectory,
    offset: offsetStore,
    onReply: async (reply) => {
      replies.push(reply)
    },
    onHealth: (health) => healths.push(health),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...options
  })
  connectors.add(connector)
  return { api, connector, offset: offsetStore, replies, healths, sleeps, lockDirectory }
}

function messageUpdate(
  updateId: number,
  fields: {
    chatId?: number
    chatType?: string
    fromId?: number
    messageId?: number
    text?: string
    replyTo?: number
    extra?: Record<string, unknown>
  } = {}
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: fields.messageId ?? updateId * 10,
      date: 1_789_000_000,
      chat: { id: fields.chatId ?? CHAT_ID, type: fields.chatType ?? 'private' },
      from: { id: fields.fromId ?? USER_ID, is_bot: false, first_name: 'Owner' },
      text: fields.text ?? `reply ${updateId}`,
      ...(fields.replyTo !== undefined ? { reply_to_message: { message_id: fields.replyTo } } : {}),
      ...fields.extra
    }
  }
}

function lockPath(directory: string): string {
  return join(directory, `telegram-${createHash('sha256').update(TOKEN).digest('hex').slice(0, 16)}.lock`)
}

async function lockFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith('telegram-'))
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('telegram connector polling', () => {
  it('delivers an authorized text reply and persists the next offset before polling again', async () => {
    const h = await harness()
    h.api.updates.push(() => ok([messageUpdate(41, { text: 'looks good', messageId: 900 })]))

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(2))

    expect(h.replies).toEqual([{
      updateId: 41,
      chatId: CHAT_ID,
      fromUserId: USER_ID,
      messageId: 900,
      replyToMessageId: null,
      text: 'looks good',
      file: null
    }])
    const [first, second] = h.api.polls()
    expect(first?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`)
    expect(first?.body).toEqual({ timeout: 25, allowed_updates: ['message'] })
    expect(second?.body).toEqual({ offset: 42, timeout: 25, allowed_updates: ['message'] })
    expect(h.offset.saved).toEqual([42])
    expect(h.connector.health()).toMatchObject({ state: 'polling', lastPollAt: NOW, rejectedUpdates: 0 })
    expect(h.healths.map((health) => health.state)).toContain('starting')
  })

  it('passes reply_to mapping and attachment metadata through, choosing the largest photo size', async () => {
    const h = await harness()
    h.api.updates.push(() => ok([
      messageUpdate(3, { replyTo: 777, messageId: 31 }),
      messageUpdate(4, {
        messageId: 41,
        replyTo: 778,
        extra: {
          text: undefined,
          caption: 'the log',
          document: { file_id: 'doc-1', file_unique_id: 'u1', file_name: 'build.log', mime_type: 'text/plain', file_size: 120 }
        }
      }),
      messageUpdate(5, {
        messageId: 51,
        extra: {
          text: undefined,
          photo: [
            { file_id: 'small', file_unique_id: 's', width: 90, height: 60, file_size: 900 },
            { file_id: 'large', file_unique_id: 'l', width: 1280, height: 853, file_size: 90_000 },
            { file_id: 'medium', file_unique_id: 'm', width: 320, height: 213, file_size: 9_000 }
          ]
        }
      })
    ]))

    await h.connector.start()
    await vi.waitFor(() => expect(h.replies).toHaveLength(3))

    expect(h.replies[0]).toMatchObject({ updateId: 3, messageId: 31, replyToMessageId: 777, text: 'reply 3', file: null })
    expect(h.replies[1]).toMatchObject({
      updateId: 4,
      replyToMessageId: 778,
      text: 'the log',
      file: { fileId: 'doc-1', fileName: 'build.log', mimeType: 'text/plain', fileSize: 120, kind: 'document' }
    })
    expect(h.replies[2]).toMatchObject({
      updateId: 5,
      replyToMessageId: null,
      text: null,
      file: { fileId: 'large', fileName: 'photo-51.jpg', mimeType: 'image/jpeg', fileSize: 90_000, kind: 'photo' }
    })
    expect(h.api.count('getFile') + h.api.count('file')).toBe(0)
  })

  it('rejects other chats and senders without delivering or downloading, and still advances the offset', async () => {
    const h = await harness()
    const document = { document: { file_id: 'evil-doc', file_unique_id: 'e', file_name: 'x.sh', file_size: 10 } }
    h.api.updates.push(() => ok([
      messageUpdate(11, { chatId: 999, fromId: 999, extra: document }),
      messageUpdate(12, { fromId: 4242, extra: document }),
      messageUpdate(13, { text: 'allowed' })
    ]))

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(2))

    expect(h.replies.map((reply) => reply.text)).toEqual(['allowed'])
    expect(h.connector.health().rejectedUpdates).toBe(2)
    expect(h.offset.saved).toEqual([12, 13, 14])
    expect(h.api.count('getFile') + h.api.count('file')).toBe(0)
  })

  it('with no allowed user, accepts only the private chat and rejects the same id as a group', async () => {
    const h = await harness({ allowedUserId: null })
    h.api.updates.push(() => ok([
      messageUpdate(1, { chatType: 'supergroup', fromId: 77 }),
      messageUpdate(2, { fromId: CHAT_ID, text: 'private' })
    ]))

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(2))

    expect(h.replies.map((reply) => reply.text)).toEqual(['private'])
    expect(h.connector.health().rejectedUpdates).toBe(1)
  })

  it('keeps delivering and advancing when the reply handler throws', async () => {
    const delivered: number[] = []
    const h = await harness({
      onReply: async (reply) => {
        delivered.push(reply.updateId)
        if (reply.updateId === 1) throw new Error('database unavailable')
      }
    })
    h.api.updates.push(() => ok([messageUpdate(1), messageUpdate(2)]))

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(2))

    expect(delivered).toEqual([1, 2])
    expect(h.offset.saved).toEqual([2, 3])
    expect(h.connector.health()).toMatchObject({ state: 'polling' })
    expect(h.connector.health().lastError).toContain('Reply handler failed for update 1: database unavailable')
    expect(h.api.polls()[1]?.body).toMatchObject({ offset: 3 })
  })

  it('resumes from the persisted offset after a restart and skips already-handled updates', async () => {
    const offsetStore = new MemoryOffset()
    const lockDirectory = await tempDirectory()
    const first = await harness({ offsetStore, lockDirectory })
    first.api.updates.push(() => ok([messageUpdate(10), messageUpdate(11)]))
    await first.connector.start()
    await vi.waitFor(() => expect(first.api.count('getUpdates')).toBe(2))
    await first.connector.stop()
    expect(offsetStore.value).toBe(12)

    const second = await harness({ offsetStore, lockDirectory })
    second.api.updates.push(() => ok([messageUpdate(11), messageUpdate(12)]))
    await second.connector.start()
    await vi.waitFor(() => expect(second.api.count('getUpdates')).toBe(2))

    expect(first.replies.map((reply) => reply.updateId)).toEqual([10, 11])
    expect(second.api.polls()[0]?.body).toMatchObject({ offset: 12 })
    expect(second.replies.map((reply) => reply.updateId)).toEqual([12])
    expect(offsetStore.value).toBe(13)
  })

  it('stop() aborts a pending long poll, releases the lock and reports stopped', async () => {
    const h = await harness()
    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(1))
    const signal = h.api.polls()[0]?.signal
    expect(signal?.aborted).toBe(false)
    expect(await lockFiles(h.lockDirectory)).toHaveLength(1)

    await h.connector.stop()
    await settle()

    expect(signal?.aborted).toBe(true)
    expect(h.connector.health().state).toBe('stopped')
    expect(await lockFiles(h.lockDirectory)).toEqual([])
    expect(h.api.count('getUpdates')).toBe(1)
    expect(h.sleeps).toEqual([])
  })
})

describe('telegram connector failures', () => {
  it('stops without retry on HTTP 409 and releases the lock', async () => {
    const h = await harness()
    h.api.updates.push(() => apiError(409, 'Conflict: terminated by other getUpdates request'))

    await h.connector.start()
    await vi.waitFor(() => expect(h.connector.health().state).toBe('conflict'))
    await settle()

    expect(h.connector.health().detail).toBe('Another client is polling this bot token')
    expect(h.api.count('getUpdates')).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(await lockFiles(h.lockDirectory)).toEqual([])
  })

  it('rejects start() as unauthorized when getMe returns 401 and never polls', async () => {
    const h = await harness()
    h.api.getMe = () => apiError(401, 'Unauthorized')

    await expect(h.connector.start()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })

    expect(h.connector.health()).toMatchObject({ state: 'unauthorized', detail: 'Telegram rejected the bot token' })
    expect(h.api.count('getUpdates')).toBe(0)
    expect(await lockFiles(h.lockDirectory)).toEqual([])
  })

  it('stops polling as unauthorized when getUpdates returns 401 or 404', async () => {
    for (const status of [401, 404]) {
      const h = await harness()
      h.api.updates.push(() => apiError(status, 'Unauthorized'))

      await h.connector.start()
      await vi.waitFor(() => expect(h.connector.health().state).toBe('unauthorized'))
      await settle()

      expect(h.api.count('getUpdates')).toBe(1)
      expect(h.sleeps).toEqual([])
      expect(await lockFiles(h.lockDirectory)).toEqual([])
    }
  })

  it('backs off exponentially up to 60s on network and server errors, then recovers and resets', async () => {
    const h = await harness()
    const networkFailure: Handler = () => {
      throw new TypeError('fetch failed')
    }
    h.api.updates.push(
      networkFailure,
      () => apiError(502, 'Bad Gateway'),
      () => new Response('<html>oops</html>', { status: 500 }),
      networkFailure,
      networkFailure,
      networkFailure,
      networkFailure,
      networkFailure,
      () => ok([messageUpdate(7, { text: 'after outage' })]),
      networkFailure
    )

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(11))

    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 1000])
    expect(h.replies.map((reply) => reply.text)).toEqual(['after outage'])
    const states = h.healths.map((health) => health.state)
    expect(states.indexOf('backoff')).toBeGreaterThan(-1)
    expect(states.lastIndexOf('polling')).toBeGreaterThan(states.indexOf('backoff'))
    expect(h.connector.health()).toMatchObject({ state: 'backoff', lastPollAt: NOW })
  })

  it('retries getMe with backoff when Telegram is unreachable at start', async () => {
    const h = await harness()
    let attempts = 0
    h.api.getMe = () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('fetch failed')
      return ok({ id: 1, is_bot: true })
    }

    await h.connector.start()
    expect(h.connector.health().state).toBe('backoff')
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(1))

    expect(attempts).toBe(2)
    expect(h.sleeps).toEqual([1000])
  })
})

describe('telegram connector lock', () => {
  it('refuses to start while a live process holds the token lock', async () => {
    const lockDirectory = await tempDirectory()
    const holder = JSON.stringify({ pid: 424242 })
    await writeFile(lockPath(lockDirectory), holder)
    const h = await harness({ lockDirectory, isPidAlive: (pid) => pid === 424242 })

    await expect(h.connector.start()).rejects.toMatchObject({ kind: 'conflict' })

    expect(h.connector.health().state).toBe('conflict')
    expect(h.connector.health().detail).toContain('pid 424242')
    expect(h.api.calls).toEqual([])
    expect(await readFile(lockPath(lockDirectory), 'utf8')).toBe(holder)
    expect(await lockFiles(lockDirectory)).toHaveLength(1)
  })

  it('takes over a stale lock left by a dead process and removes it on stop', async () => {
    const lockDirectory = await tempDirectory()
    await writeFile(lockPath(lockDirectory), JSON.stringify({ pid: 424242 }))
    const h = await harness({ lockDirectory, isPidAlive: () => false })

    await h.connector.start()

    const held = JSON.parse(await readFile(lockPath(lockDirectory), 'utf8')) as { pid: number }
    expect(held.pid).toBe(process.pid)
    expect(await lockFiles(lockDirectory)).toHaveLength(1)
    await h.connector.stop()
    expect(await lockFiles(lockDirectory)).toEqual([])
  })

  it('makes a second connector for the same token conflict with the live first one', async () => {
    const lockDirectory = await tempDirectory()
    const first = await harness({ lockDirectory })
    const second = await harness({ lockDirectory })

    await first.connector.start()
    await expect(second.connector.start()).rejects.toMatchObject({ kind: 'conflict' })
    await second.connector.stop()

    expect(await lockFiles(lockDirectory)).toHaveLength(1)
    await first.connector.stop()
    expect(await lockFiles(lockDirectory)).toEqual([])
  })
})

describe('telegram connector token redaction', () => {
  it('masks tokens to at most four leading and trailing characters', () => {
    expect(maskToken(TOKEN)).toBe('9876…TsRq')
    expect(maskToken('abcdefgh')).toBe('ab…gh')
    expect(maskToken('abc')).toBe('…')
    expect(maskToken('')).toBe('')
  })

  it('redacts the raw, URL-encoded and secret forms of the token', () => {
    const text = `GET /bot${TOKEN}/x ${encodeURIComponent(TOKEN)} secret=${TOKEN_SECRET}`
    const redacted = redactToken(text, TOKEN)

    expect(redacted).not.toContain(TOKEN_SECRET)
    expect(redacted).not.toContain(encodeURIComponent(TOKEN))
    expect(redacted).toBe(`GET /bot9876…TsRq/x 9876…TsRq secret=9876…TsRq`)
  })

  it('keeps the token out of health reports and thrown errors', async () => {
    const h = await harness()
    h.api.updates.push(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getUpdates`)
    })
    h.api.handlers.set('sendMessage', () => apiError(400, `Bad Request: token ${TOKEN} is echoed back`))

    await h.connector.start()
    await vi.waitFor(() => expect(h.api.count('getUpdates')).toBe(2))
    const sendError = await h.connector.sendMessage('hello').catch((error: unknown) => error)

    expect(sendError).toBeInstanceOf(Error)
    expect((sendError as Error).message).toContain('9876…TsRq')
    expect((sendError as Error).message).not.toContain(TOKEN_SECRET)
    const lastBackoff = h.healths.find((health) => health.state === 'backoff')
    expect(lastBackoff?.lastError).toContain('ECONNREFUSED https://api.telegram.org/bot9876…TsRq/getUpdates')
    expect(JSON.stringify(h.healths)).not.toContain(TOKEN_SECRET)
    expect(JSON.stringify(h.connector.health())).not.toContain(TOKEN_SECRET)
  })
})

describe('telegram connector outbound', () => {
  it('sends to the allowed chat, truncating to 4096 characters and threading replies', async () => {
    const h = await harness()
    h.api.handlers.set('sendMessage', () => ok({ message_id: 321 }))

    await expect(h.connector.sendMessage('x'.repeat(5000), { replyToMessageId: 900 }))
      .resolves.toEqual({ messageId: 321 })
    await h.connector.sendMessage('short')

    const [long, short] = h.api.calls
    expect(long?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(long?.body.chat_id).toBe(CHAT_ID)
    expect((long?.body.text as string).length).toBe(4096)
    expect((long?.body.text as string).endsWith('x…')).toBe(true)
    expect(long?.body.reply_parameters).toEqual({ message_id: 900, allow_sending_without_reply: true })
    expect(short?.body).toEqual({ chat_id: CHAT_ID, text: 'short' })
  })

  it('downloads a file within the limit from the file endpoint', async () => {
    const h = await harness()
    const content = new TextEncoder().encode('hello from telegram')
    h.api.handlers.set('getFile', () => ok({ file_id: 'doc-1', file_size: content.byteLength, file_path: 'documents/file_1.txt' }))
    h.api.handlers.set('file', () => new Response(content, { status: 200 }))

    const downloaded = await h.connector.downloadFile('doc-1', 1024)

    expect(Buffer.from(downloaded.bytes).toString('utf8')).toBe('hello from telegram')
    expect(downloaded.filePath).toBe('documents/file_1.txt')
    expect(h.api.calls.map((call) => call.method)).toEqual(['getFile', 'file'])
    expect(h.api.calls[0]?.body).toEqual({ file_id: 'doc-1' })
    expect(h.api.calls[1]?.url).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_1.txt`)
  })

  it('rejects a file whose known size exceeds the limit before downloading it', async () => {
    const h = await harness()
    h.api.handlers.set('getFile', () => ok({ file_id: 'doc-2', file_size: 2048, file_path: 'documents/file_2.bin' }))

    await expect(h.connector.downloadFile('doc-2', 1024)).rejects.toMatchObject({ kind: 'too-large' })

    expect(h.api.count('file')).toBe(0)
  })

  it('stops streaming a file of unknown size once it passes the limit', async () => {
    const h = await harness()
    let cancelled = false
    let pulls = 0
    h.api.handlers.set('getFile', () => ok({ file_id: 'doc-3', file_path: 'documents/file_3.bin' }))
    h.api.handlers.set('file', () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 10) controller.close()
        else controller.enqueue(new Uint8Array(400))
      },
      cancel() {
        cancelled = true
      }
    }), { status: 200 }))

    await expect(h.connector.downloadFile('doc-3', 1000)).rejects.toMatchObject({ kind: 'too-large' })

    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })
})
