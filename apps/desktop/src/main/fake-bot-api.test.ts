// MODULE: fake-bot-api.test.ts - canceled test polls leave later replies for a live connector
import { expect, it } from 'vitest'
import { startFakeBotApi } from './fake-bot-api'

it('keeps a later reply when the previous long poll was canceled', async () => {
  const bot = await startFakeBotApi(424242, 424242)
  const post = (method: string, body: unknown, signal?: AbortSignal): Promise<Response> => fetch(`${bot.origin}/botfake/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {})
  })
  try {
    await (await post('getMe', {})).json()
    const controller = new AbortController()
    const canceled = post('getUpdates', {}, controller.signal).catch(() => null)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await canceled

    bot.tapOn('Poll fixture', [{ reply: 'Synthetic reply' }])
    const sent = await (await post('sendMessage', {
      text: 'Poll fixture', reply_markup: { inline_keyboard: [[{ text: 'Other', callback_data: 'synthetic' }]] }
    })).json() as { result: { message_id: number } }
    // Let the old request's handler observe the reply before the next poll starts.
    await new Promise(resolve => setTimeout(resolve, 260))
    const received = await (await post('getUpdates', {})).json() as {
      result: Array<{ message: { text: string; reply_to_message: { message_id: number } } }>
    }
    expect(received.result).toHaveLength(1)
    expect(received.result[0]!.message.text).toBe('Synthetic reply')
    expect(received.result[0]!.message.reply_to_message.message_id).toBe(sent.result.message_id)
  } finally {
    await bot.close()
  }
})
