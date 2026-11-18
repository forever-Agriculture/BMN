// MODULE: fake-bot-api.ts - a local stand-in for the Telegram Bot API that taps card buttons; Electron self-test only (Story 30.3)
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeBotCall {
  method: string
  body: Record<string, unknown>
  at: number
  /** The id a sent message was given. */
  messageId?: number
}

/**
 * One owner action on a card: tap the button at an index, tap the button with exactly this text, or reply to the
 * card with text (Story 31.4). A list is several actions on the same card state, in order.
 */
export type FakeBotStep = number | { tap: string } | { reply: string } | Array<{ tap: string } | { reply: string }>

export interface FakeBotEvent {
  kind: string; at: number; messageId?: number; updateId?: number; callbackId?: string
  dataHash?: string; buttons?: string[]; found?: boolean; match?: string
}

export interface FakeBotApi {
  /** `http://127.0.0.1:<port>`, handed to the host as its Bot API origin. */
  origin: string
  calls: FakeBotCall[]
  /** Last 200 synthetic routing observations; callback data is fingerprinted. */
  events: FakeBotEvent[]
  /**
   * Taps, in order, the given option of each card state that shows buttons, but only on the message whose
   * text first contained `match`; every other card is left alone.
   */
  tapOn(match: string, options: FakeBotStep[], messageId?: number): void
  /** Story 32.2: answer getMe and getUpdates with this HTTP error, or drop the connection; null serves again. */
  failWith(mode: 409 | 401 | 'network' | null): void
  /** Story 76.3: the owner sends this text as a message of its own (`/away`, `/back`), replying to nothing. */
  say(text: string): void
  close(): Promise<void>
}

const TAP_DELAY_MS = 200
const EMPTY_POLL_MS = 400

type Keyboard = Array<Array<{ text: string; callback_data: string }>>

function keyboardOf(body: Record<string, unknown>): Keyboard {
  const markup = body.reply_markup as { inline_keyboard?: Keyboard } | undefined
  return markup?.inline_keyboard ?? []
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks)
  // Story 78.4: a file upload is multipart; the self-test keeps its size and the file's own bytes.
  if (/^multipart\/form-data/.test(request.headers['content-type'] ?? '')) {
    const form = await new Response(raw, { headers: { 'content-type': request.headers['content-type']! } }).formData()
    const document = form.get('document')
    return {
      caption: form.get('caption'),
      ...(document instanceof Blob ? { document: { name: (document as File).name, text: await document.text() } } : {})
    }
  }
  const text = raw.toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

export async function startFakeBotApi(chatId: number, userId: number): Promise<FakeBotApi> {
  const calls: FakeBotCall[] = []
  const events: FakeBotEvent[] = []
  const trace = (kind: string, fields: Omit<FakeBotEvent, 'kind' | 'at'> = {}): void => {
    events.push({ kind, at: Date.now(), ...fields })
    if (events.length > 200) events.shift()
  }
  const fingerprint = (data: string): string => createHash('sha256').update(data).digest('hex').slice(0, 16)
  const updates: Array<Record<string, unknown>> = []
  let nextUpdate = 1
  let nextMessage = 5000
  type Target = { match: string; options: FakeBotStep[]; messageId: number | null; keyboard: Keyboard; scheduled: boolean; pending: Set<string> }
  let target: Target | null = null
  const callbackOwners = new Map<string, Target>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (action: () => void, ms: number): void => {
    const timer = setTimeout(() => { timers.delete(timer); action() }, ms)
    timers.add(timer)
  }
  let failure: 409 | 401 | 'network' | null = null

  const actionsOf = (step: FakeBotStep): Array<number | { tap: string } | { reply: string }> => Array.isArray(step) ? step : [step]
  const buttonFor = (action: ReturnType<typeof actionsOf>[number], keyboard: Keyboard) => typeof action === 'number'
    ? keyboard.flat()[action] : 'tap' in action ? keyboard.flat().find(button => button.text === action.tap) : undefined
  const ready = (step: FakeBotStep, keyboard: Keyboard): boolean => actionsOf(step).every(action =>
    typeof action === 'object' && 'reply' in action || buttonFor(action, keyboard) !== undefined)
  const advance = (current: Target): void => {
    const step = current.options[0]
    if (target !== current || current.scheduled || current.pending.size || step === undefined || !ready(step, current.keyboard)) return
    current.scheduled = true
    later(() => {
      current.scheduled = false
      if (target !== current || !ready(step, current.keyboard)) return
      // Read the actual latest keyboard at the tap, after any redraws during the human delay.
      current.options.shift()
      const messageId = current.messageId!
      const actions = actionsOf(step).map(action => {
        const button = buttonFor(action, current.keyboard)
        const callbackId = button ? `tap-${nextUpdate++}` : null
        if (callbackId !== null) { current.pending.add(callbackId); callbackOwners.set(callbackId, current) }
        return { action, button, callbackId }
      })
      actions.forEach(({ action, button, callbackId }, index) => later(() => {
        if (target !== current) return
        trace('step-selected', { messageId, found: button !== undefined, ...(button ? { dataHash: fingerprint(button.callback_data) } : {}) })
        const updateId = nextUpdate++
        if (typeof action === 'object' && 'reply' in action) {
          updates.push({ update_id: updateId, message: {
            message_id: nextMessage++, date: 1_789_000_000, text: action.reply,
            chat: { id: chatId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Owner' },
            reply_to_message: { message_id: messageId }
          } })
        } else if (button && callbackId !== null) {
          trace('callback-enqueued', { messageId, updateId, callbackId, dataHash: fingerprint(button.callback_data) })
          updates.push({ update_id: updateId, callback_query: {
            id: callbackId, from: { id: userId, is_bot: false, first_name: 'Owner' },
            message: { message_id: messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } }, data: button.callback_data
          } })
        }
      }, TAP_DELAY_MS * index))
    }, TAP_DELAY_MS)
  }
  const tapLater = (messageId: number, keyboard: Keyboard): void => {
    if (!target || target.messageId !== messageId) return
    target.keyboard = keyboard
    trace('target-keyboard', { messageId, buttons: keyboard.flat().map(button => button.text.slice(0, 80)) })
    advance(target)
  }

  const reply = (response: ServerResponse, result: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result }))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const method = (request.url ?? '').slice((request.url ?? '').lastIndexOf('/') + 1)
      const body = await readBody(request)
      if (failure !== null && (method === 'getUpdates' || method === 'getMe')) {
        if (failure === 'network') {
          request.socket.destroy()
          return
        }
        response.writeHead(failure, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error_code: failure,
          description: failure === 409 ? 'Conflict: terminated by other getUpdates request' : 'Unauthorized' }))
        return
      }
      if (method === 'getUpdates') {
        const end = Date.now() + EMPTY_POLL_MS
        while (!response.destroyed && updates.length === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
        if (response.destroyed) return
        const batch = updates.splice(0)
        for (const update of batch) trace('update-delivered', { updateId: Number(update.update_id) })
        return reply(response, batch)
      }
      const call: FakeBotCall = { method, body, at: Date.now() }
      calls.push(call)
      if (method === 'getMe') return reply(response, { id: 1, is_bot: true, username: 'bmn_self_test_bot' })
      if (method === 'answerCallbackQuery') {
        const callbackId = String(body.callback_query_id)
        const current = callbackOwners.get(callbackId)
        if (current) {
          current.pending.delete(callbackId); callbackOwners.delete(callbackId)
          trace('callback-acknowledged', { callbackId, messageId: current.messageId! })
          advance(current)
        }
        return reply(response, true)
      }
      if (method === 'sendMessage') {
        const messageId = nextMessage++
        call.messageId = messageId
        if (target && target.messageId === null && String(body.text ?? '').includes(target.match)) {
          target.messageId = messageId
          trace('target-bound', { messageId, match: target.match })
        }
        tapLater(messageId, keyboardOf(body))
        return reply(response, { message_id: messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } })
      }
      if (method === 'sendDocument') {
        call.messageId = nextMessage++
        return reply(response, { message_id: call.messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } })
      }
      if (method === 'editMessageText') {
        call.messageId = Number(body.message_id)
        tapLater(call.messageId, keyboardOf(body))
        return reply(response, true)
      }
      return reply(response, true)
    })().catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    events,
    tapOn: (match, options, messageId) => {
      const latest = messageId === undefined ? undefined : calls.findLast(call => call.messageId === messageId &&
        (call.method === 'editMessageText' || call.method === 'sendMessage'))
      if (messageId !== undefined && (latest === undefined || !String(latest.body.text).includes(match))) throw new Error('Unknown fake phone message')
      target = { match, options: [...options], messageId: messageId ?? null, keyboard: latest === undefined ? [] : keyboardOf(latest.body),
        scheduled: false, pending: new Set() }
      trace('target-armed', { match })
      if (messageId !== undefined) advance(target)
    },
    failWith: (mode) => {
      failure = mode
    },
    say: (text) => {
      updates.push({
        update_id: nextUpdate++,
        message: { message_id: nextMessage++, date: 1_789_000_000, text, chat: { id: chatId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Owner' } }
      })
    },
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear(); callbackOwners.clear()
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}
