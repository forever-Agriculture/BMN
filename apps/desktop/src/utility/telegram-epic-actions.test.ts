// MODULE: telegram-epic-actions.test.ts - a phone tap answers only under the deploy rule its own button was drawn under (Epic 132 S4)
import { describe, expect, it } from 'vitest'
import type { EpicActionAnswer, EpicActionCard } from '@bmn/protocol'
import type { TelegramConnector } from './telegram-connector'
import { TelegramEpicActions, shownRuleMark } from './telegram-epic-actions'

type Keyboard = Array<Array<{ text: string; callback_data: string }>>

function fixture() {
  let card: EpicActionCard = {
    id: '11111111-2222-3333-4444-555555555555', epic: 7, project: '/synthetic', requestedAt: '2026-11-19T00:00:00.000Z', revision: 3,
    actions: [{ id: 'push', words: 'Push synthetic/repo default branch main · 1 use', rule: 'nothing deploys' }], answers: {}, binding: null
  }
  const messages = new Map<number, { text: string; keyboard: Keyboard }>()
  const answers: EpicActionAnswer[] = [], toasts: string[] = []
  let next = 1
  const telegram = {
    sendMessage: async (text: string, options: { keyboard?: Keyboard } = {}) => { const messageId = next++; messages.set(messageId, { text, keyboard: options.keyboard ?? [] }); return { messageId } },
    editMessageText: async (id: number, text: string, options: { keyboard?: Keyboard } = {}) => { messages.set(id, { text, keyboard: options.keyboard ?? [] }) },
    answerCallbackQuery: async (_id: string, text: string) => { toasts.push(text) }
  } as unknown as TelegramConnector
  const phone = new TelegramEpicActions(() => telegram, async () => [card], async answer => { answers.push(answer) })
  const settle = async () => { phone.reconcile(); await phone['pending'] }
  const yes = () => { const [id, message] = [...messages][0]!; return { id, data: message.keyboard.flat().find(button => button.text.startsWith('Yes'))!.callback_data } }
  let callback = 0
  const tap = (button: { id: number; data: string }) => phone.tap({ updateId: ++callback, callbackId: `c${callback}`, chatId: 1, fromUserId: 1, messageId: button.id, data: button.data })
  return { set: (next: EpicActionCard) => { card = next }, get: () => card, messages, answers, toasts, settle, yes, tap }
}

describe('An epic action tap on the phone (Epic 132 S4)', () => {
  it('carries the rule its button was drawn under and fits Telegram\'s 64 bytes', async () => {
    const f = fixture()
    await f.settle()
    const button = f.yes()
    expect(button.data.endsWith(`:${shownRuleMark('nothing deploys')}:y`)).toBe(true)
    expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64)
    await f.tap(button)
    expect(f.answers).toEqual([{ card: f.get().id, action: 'push', choice: 'yes', revision: 3, rule: 'nothing deploys' }])
  })

  it('refuses an old button after the rule changed, before and after the redraw, and the redrawn button saves', async () => {
    const f = fixture()
    await f.settle()
    const old = f.yes()
    // His rule changes with no new card revision; the old message is still on the phone.
    f.set({ ...f.get(), actions: [{ ...f.get().actions[0]!, rule: 'other branches deploy' }] })
    await f.tap(old)
    expect(f.answers).toEqual([])
    await f.settle()
    expect(f.messages.get(old.id)!.text).toContain('other branches deploy')
    // A queued tap of the old button arriving after the edit is still refused.
    await f.tap(old)
    expect(f.answers).toEqual([])
    expect(f.toasts.filter(text => text.startsWith('This card changed'))).toHaveLength(2)
    await f.tap(f.yes())
    expect(f.answers).toEqual([{ card: f.get().id, action: 'push', choice: 'yes', revision: 3, rule: 'other branches deploy' }])
  })
})
