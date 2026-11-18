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

it('keeps a scripted action until its expected keyboard actually appears', async () => {
  const bot = await startFakeBotApi(424242, 424242)
  const post = async <T>(method: string, body: unknown): Promise<{ result: T }> => (await fetch(`${bot.origin}/botfake/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ result: T }>
  const markup = (text: string, data: string) => ({ inline_keyboard: [[{ text, callback_data: data }]] })
  try {
    bot.tapOn('Synthetic redraw', [{ tap: 'Go' }])
    const sent = await post<{ message_id: number }>('sendMessage', { text: 'Synthetic redraw', reply_markup: markup('Other', 'unrelated') })
    expect((await post<Array<{ callback_query: { id: string; data: string } }>>('getUpdates', {})).result).toEqual([])
    await post('editMessageText', { message_id: sent.result.message_id, text: 'Synthetic redraw', reply_markup: markup('Go', 'expected') })
    const updates = (await post<Array<{ callback_query: { id: string; data: string } }>>('getUpdates', {})).result
    expect(updates).toHaveLength(1)
    expect(updates[0]!.callback_query.data).toBe('expected')
  } finally { await bot.close() }
})

it('taps the latest drawn token and waits for its callback acknowledgment before advancing', async () => {
  const bot = await startFakeBotApi(424242, 424242)
  const post = async <T>(method: string, body: unknown): Promise<{ result: T }> => (await fetch(`${bot.origin}/botfake/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ result: T }>
  const markup = (text: string, data: string) => ({ inline_keyboard: [[{ text, callback_data: data }]] })
  try {
    bot.tapOn('Synthetic redraw', [{ tap: 'Go' }, { tap: 'Next' }])
    const sent = await post<{ message_id: number }>('sendMessage', { text: 'Synthetic redraw', reply_markup: markup('Go', 'old-revision') })
    await post('editMessageText', { message_id: sent.result.message_id, text: 'Synthetic redraw', reply_markup: markup('Go', 'latest-revision') })
    const first = (await post<Array<{ callback_query: { id: string; data: string } }>>('getUpdates', {})).result
    expect(first).toHaveLength(1)
    expect(first[0]!.callback_query.data).toBe('latest-revision')
    await post('editMessageText', { message_id: sent.result.message_id, text: 'Synthetic redraw', reply_markup: markup('Next', 'next-step') })
    expect((await post<Array<{ callback_query: { id: string; data: string } }>>('getUpdates', {})).result).toEqual([])
    await post('answerCallbackQuery', { callback_query_id: first[0]!.callback_query.id })
    const next = (await post<Array<{ callback_query: { id: string; data: string } }>>('getUpdates', {})).result
    expect(next).toHaveLength(1)
    expect(next[0]!.callback_query.data).toBe('next-step')
  } finally { await bot.close() }
})
