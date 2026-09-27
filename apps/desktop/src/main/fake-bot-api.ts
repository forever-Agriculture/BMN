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

export interface FakeBotApi {
  /** `http://127.0.0.1:<port>`, handed to the host as its Bot API origin. */
  origin: string
  calls: FakeBotCall[]
  /**
   * Taps, in order, the given option of each card state that shows buttons, but only on the message whose
   * text first contained `match`; every other card is left alone.
   */
  tapOn(match: string, options: number[]): void
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
  let target: { match: string; options: number[]; messageId: number | null } | null = null

  const tapLater = (messageId: number, keyboard: Keyboard): void => {
    if (!target || keyboard.length === 0 || target.messageId !== messageId) return
    const option = target.options.shift()
    if (option === undefined) return
    const button = keyboard.flat()[option]
    if (!button) return
    setTimeout(() => {
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id: `tap-${nextUpdate}`,
          from: { id: userId, is_bot: false, first_name: 'Owner' },
          message: { message_id: messageId, date: 1_789_000_000, chat: { id: chatId, type: 'private' } },
          data: button.callback_data
        }
      })
    }, TAP_DELAY_MS)
  }

  const reply = (response: ServerResponse, result: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result }))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const method = (request.url ?? '').slice((request.url ?? '').lastIndexOf('/') + 1)
      const body = await readBody(request)
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
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}
