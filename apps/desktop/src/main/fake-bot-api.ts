// MODULE: fake-bot-api.ts - a local stand-in for the Telegram Bot API that taps card buttons; Electron self-test only (Story 30.3)
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

export interface FakeBotApi {
  /** `http://127.0.0.1:<port>`, handed to the host as its Bot API origin. */
  origin: string
  calls: FakeBotCall[]
  /**
   * Taps, in order, the given option of each card state that shows buttons, but only on the message whose
   * text first contained `match`; every other card is left alone.
   */
  tapOn(match: string, options: FakeBotStep[]): void
  /** Story 32.2: answer getMe and getUpdates with this HTTP error, or drop the connection; null serves again. */
  failWith(mode: 409 | 401 | 'network' | null): void
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
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

export async function startFakeBotApi(chatId: number, userId: number): Promise<FakeBotApi> {
  const calls: FakeBotCall[] = []
  const updates: Array<Record<string, unknown>> = []
  let nextUpdate = 1
  let nextMessage = 5000
  let target: { match: string; options: FakeBotStep[]; messageId: number | null } | null = null
  let failure: 409 | 401 | 'network' | null = null

  const tapLater = (messageId: number, keyboard: Keyboard): void => {
    if (!target || keyboard.length === 0 || target.messageId !== messageId) return
    const step = target.options.shift()
    if (step === undefined) return
    const actions = Array.isArray(step) ? step : [step]
    actions.forEach((action, index) => {
      const button = typeof action === 'number'
        ? keyboard.flat()[action]
        : 'tap' in action ? keyboard.flat().find((candidate) => candidate.text === action.tap) : undefined
      setTimeout(() => {
        if (typeof action === 'object' && 'reply' in action) {
          updates.push({
            update_id: nextUpdate++,
            message: {
              message_id: nextMessage++, date: 1_789_000_000, text: action.reply,
              chat: { id: chatId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Owner' },
              reply_to_message: { message_id: messageId }
            }
          })
          return
        }
        if (!button) return
        updates.push({
          update_id: nextUpdate++,
          callback_query: {
            id: `tap-${nextUpdate}`,
            from: { id: userId, is_bot: false, first_name: 'Owner' },
            message: { message_id: messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } },
            data: button.callback_data
          }
        })
      }, TAP_DELAY_MS * (index + 1))
    })
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
        while (updates.length === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
        return reply(response, updates.splice(0))
      }
      const call: FakeBotCall = { method, body, at: Date.now() }
      calls.push(call)
      if (method === 'getMe') return reply(response, { id: 1, is_bot: true, username: 'bmn_self_test_bot' })
      if (method === 'sendMessage') {
        const messageId = nextMessage++
        call.messageId = messageId
        if (target && target.messageId === null && String(body.text ?? '').includes(target.match)) target.messageId = messageId
        tapLater(messageId, keyboardOf(body))
        return reply(response, { message_id: messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } })
      }
      if (method === 'editMessageText') {
        tapLater(Number(body.message_id), keyboardOf(body))
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
    tapOn: (match, options) => {
      target = { match, options: [...options], messageId: null }
    },
    failWith: (mode) => {
      failure = mode
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}
