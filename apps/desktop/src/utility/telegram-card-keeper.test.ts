// MODULE: telegram-card-keeper.test.ts - card lifecycle: taps, single-use tokens, outcomes, in-place edits, restart sweep, fallback
import { describe, expect, it } from 'vitest'
import type { AttentionPrompt, AttentionRecord } from '@bmn/protocol'
import type { TelegramCardData, TelegramCardRecord, TelegramCardState } from './database-companion-store'
import type { AnswerOutcome, AnswerRequest } from './remote-answer'
import { TelegramCardKeeper, type Answerability, type CardConnector } from './telegram-card-keeper'
import { TelegramConnectorError, type CardMessageOptions, type InboundTap } from './telegram-connector'

const QUESTION: AttentionPrompt = {
  type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_1',
  questions: [{
    id: null, header: 'Auth method', text: 'Which auth method?', multiSelect: false,
    options: [{ label: 'JWT', description: null }, { label: 'Session cookies', description: null }]
  }]
}
const TWO: AttentionPrompt = {
  ...QUESTION,
  questions: [
    QUESTION.questions[0]!,
    { id: null, header: 'Tests', text: 'Tests now?', multiSelect: false, options: [{ label: 'Yes', description: null }, { label: 'Later', description: null }] }
  ]
} as AttentionPrompt
const BASH: AttentionPrompt = {
  type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null,
  tool: 'Bash', command: 'touch x', cwd: null
}

function record(prompt: AttentionPrompt | null, patch: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    requestId: 'r1', sessionId: 's1', incarnationId: 'i1', requestKey: 'question', kind: prompt?.type === 'permission' ? 'permission' : 'question',
    title: 'Claude asks', body: null, state: 'open', resolution: null, openedAt: '2026-09-27T00:00:00.000Z', expiresAt: null,
    resolvedAt: null, seenAt: null, revision: 1, openedBy: 'cli', resolvedBy: null, prompt, ...patch
  }
}

class FakeConnector implements CardConnector {
  readonly sends: Array<{ id: number; text: string; options: CardMessageOptions }> = []
  readonly edits: Array<{ id: number; text: string; options: Omit<CardMessageOptions, 'replyToMessageId'> }> = []
  readonly toasts: Array<{ id: string; text: string }> = []
  refuseHtml = false
  failAll = false
  private next = 100

  async sendMessage(text: string, options: CardMessageOptions = {}): Promise<{ messageId: number }> {
    if (this.failAll) throw new TelegramConnectorError('network', 'down')
    if (this.refuseHtml && options.html) throw new TelegramConnectorError('http', "Telegram sendMessage failed (400): can't parse entities", 400)
    // The real connector refuses an HTML card over the limit before sending it.
    if (options.html && text.length > 4096) throw new TelegramConnectorError('invalid-argument', 'A formatted Telegram card must fit 4,096 characters')
    const id = this.next++
    this.sends.push({ id, text, options })
    return { messageId: id }
  }

  async editMessageText(id: number, text: string, options: Omit<CardMessageOptions, 'replyToMessageId'> = {}): Promise<void> {
    this.edits.push({ id, text, options })
  }

  async answerCallbackQuery(id: string, text: string): Promise<void> {
    this.toasts.push({ id, text })
  }

  buttons(index = this.sends.length - 1): string[] {
    return (this.sends[index]?.options.keyboard ?? []).flat().map((button) => button.callback_data)
  }

  lastEdit(): { id: number; text: string; options: Omit<CardMessageOptions, 'replyToMessageId'> } | undefined {
    return this.edits[this.edits.length - 1]
  }

  editButtons(): string[] {
    return (this.lastEdit()?.options.keyboard ?? []).flat().map((button) => button.callback_data)
  }
}

function setup(options: {
  record?: AttentionRecord | null
  answerability?: Answerability
  answer?: (request: AnswerRequest) => Promise<AnswerOutcome>
  stored?: TelegramCardRecord[]
} = {}) {
  const connector = new FakeConnector()
  const state = { record: options.record === undefined ? record(QUESTION) : options.record, connected: true }
  const answers: AnswerRequest[] = []
  const puts: TelegramCardRecord[] = []
  const updates: Array<{ messageId: number; state: TelegramCardState; card: TelegramCardData }> = []
  const messages: number[] = []
  let token = 0
  const keeper = new TelegramCardKeeper({
    connector: () => (state.connected ? connector : undefined),
    getAttention: async () => state.record,
    header: () => ({ session: 'api', agent: 'claude', flag: null }),
    answerability: async () => options.answerability ?? { answerable: true, deny: true },
    answerEpoch: () => 4,
    liveIncarnationId: () => 'i1',
    answer: async (request) => {
      answers.push(request)
      return options.answer ? options.answer(request) : { state: 'confirmed', sent: ['JWT'] }
    },
    store: {
      put: async (card) => void puts.push(card),
      update: async (messageId, _revision, cardState, card) => void updates.push({ messageId, state: cardState, card }),
      list: async (states) => (options.stored ?? []).filter((row) => states.includes(row.state)),
      message: async (messageId) => void messages.push(messageId)
    },
    home: null,
    settleMs: 1,
    token: () => `tok-${++token}`
  })
  const tap = (data: string, messageId = 100): InboundTap =>
    ({ updateId: 1, callbackId: `cb-${data}`, chatId: 1, fromUserId: 1, messageId, data })
  return { keeper, connector, state, answers, puts, updates, messages, tap }
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

describe('sending a card', () => {
  it('sends one HTML card with a single-use token per option and stores it with its revision', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends).toHaveLength(1)
    expect(h.connector.sends[0]?.options.html).toBe(true)
    expect(h.connector.buttons()).toEqual(['tok-1', 'tok-2'])
    expect(h.puts).toEqual([expect.objectContaining({ messageId: 100, requestId: 'r1', revision: 1, state: 'buttons', incarnationId: 'i1' })])
  })

  it('draws no buttons where 30.2 has no route, and stores the card as open', async () => {
    const h = setup({ answerability: { answerable: false, reason: 'unsupported' } })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard).toBeNull()
    expect(h.connector.sends[0]?.text).toContain('No buttons for this kind yet. Answer at the laptop.')
    expect(h.puts[0]?.state).toBe('open')
  })

  it('offers only Allow once when Deny would answer more than this request, and nothing with the setting off', async () => {
    const allowOnly = setup({ record: record(BASH), answerability: { answerable: true, deny: false } })
    await allowOnly.keeper.page(allowOnly.state.record!)
    expect(allowOnly.connector.sends[0]?.options.keyboard).toEqual([[{ text: 'Allow once', callback_data: 'tok-1' }]])
    const off = setup({ record: record(BASH), answerability: { answerable: false, reason: 'permissions-off' } })
    await off.keeper.page(off.state.record!)
    expect(off.connector.sends[0]?.text).toContain('<i>Answer this at the laptop.</i>')
    expect(off.connector.sends[0]?.options.keyboard).toBeNull()
  })

  it('resends a card Telegram refuses to format once as plain words without buttons', async () => {
    const h = setup()
    h.connector.refuseHtml = true
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends).toHaveLength(1)
    expect(h.connector.sends[0]?.options.html).toBeUndefined()
    expect(h.connector.sends[0]?.text).toContain('Which auth method?')
    expect(h.connector.sends[0]?.text).not.toContain('<b>')
    expect(h.connector.sends[0]?.text.endsWith('Answer at the laptop.')).toBe(true)
    expect(h.puts[0]).toMatchObject({ state: 'open', card: { format: 'plain' } })
  })

  it('still pages a card too long to fit, as plain words, instead of losing it', async () => {
    const huge: AttentionPrompt = {
      ...QUESTION,
      questions: [{ ...QUESTION.questions[0]!, options: Array.from({ length: 20 }, (_, index) => ({ label: `${index} ${'L'.repeat(240)}`, description: null })) }]
    } as AttentionPrompt
    const h = setup({ record: record(huge) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends).toHaveLength(1)
    expect(h.connector.sends[0]?.options.html).toBeUndefined()
    expect(h.connector.sends[0]?.text).toContain('Which auth method?')
    expect(h.puts[0]).toMatchObject({ state: 'open', card: { format: 'plain' } })
  })

  it('does not resend after a network failure', async () => {
    const h = setup()
    h.connector.failAll = true
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends).toEqual([])
    expect(h.puts).toEqual([])
  })

  it('edits the same card in place when the request revision changes, killing the old tokens', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    h.state.record = record(QUESTION, { revision: 2, title: 'again' })
    h.keeper.changed('s1')
    await settle()
    expect(h.connector.sends).toHaveLength(1)
    expect(h.connector.lastEdit()?.id).toBe(100)
    expect(h.connector.editButtons()).toEqual(['tok-3', 'tok-4'])
    await h.keeper.page(h.state.record)
    expect(h.connector.sends).toHaveLength(1)
    await h.keeper.tap(h.tap('tok-1'))
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-1', text: 'This button is no longer active.' }])
    expect(h.answers).toEqual([])
  })
})

describe('a tap', () => {
  it('toasts, shows Sending, answers the bound request once and shows the confirmed outcome without a reply', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-1', text: 'Sending JWT…' }])
    expect(h.answers).toEqual([{ requestId: 'r1', revision: 1, epoch: 4, incarnationId: 'i1', answer: { type: 'choices', choices: [0] } }])
    expect(h.connector.edits.map((edit) => edit.text.split('\n').pop())).toEqual(['<i>Sending: JWT…</i>', '✓ <i>Sent: JWT</i>'])
    expect(h.connector.edits.every((edit) => (edit.options.keyboard ?? null) === null)).toBe(true)
    expect(h.connector.sends).toHaveLength(1)
    expect(h.updates.map((update) => update.state)).toEqual(['sending', 'final'])
  })

  it('returns to the poll loop before the answer is confirmed', async () => {
    let release: (outcome: AnswerOutcome) => void = () => undefined
    const h = setup({ answer: () => new Promise((resolve) => (release = resolve)) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-2'))
    expect(h.connector.lastEdit()?.text.endsWith('<i>Sending: Session cookies…</i>')).toBe(true)
    release({ state: 'confirmed', sent: ['Session cookies'] })
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Sent: Session cookies</i>')).toBe(true)
  })

  it('refuses a used, unknown or misplaced token without answering', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-2', 999))
    await h.keeper.tap(h.tap('forged'))
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-2'))
    await settle()
    expect(h.answers).toHaveLength(1)
    expect(h.connector.toasts.map((toast) => toast.text)).toEqual([
      'This button is no longer active.', 'This button is no longer active.', 'Sending JWT…',
      'This button is no longer active.', 'This button is no longer active.'
    ])
  })

  it('walks several questions on one message and sends them together at the last tap', async () => {
    const h = setup({ record: record(TWO), answer: async () => ({ state: 'confirmed', sent: ['Session cookies', 'Later'] }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-2'))
    expect(h.connector.toasts[0]?.text).toBe('Question 2 of 2')
    expect(h.connector.lastEdit()?.text).toContain('<blockquote>Auth method: <b>Session cookies</b></blockquote>')
    expect(h.connector.editButtons()).toEqual(['tok-3', 'tok-4'])
    expect(h.answers).toEqual([])
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-4'))
    await settle()
    expect(h.connector.toasts.map((toast) => toast.text)).toEqual([
      'Question 2 of 2', 'This button is no longer active.', 'Sending Session cookies · Later…'
    ])
    expect(h.answers).toEqual([expect.objectContaining({ answer: { type: 'choices', choices: [1, 1] } })])
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Sent: Session cookies · Later</i>')).toBe(true)
  })

  it('answers a permission with Allow once or Deny', async () => {
    const h = setup({ record: record(BASH), answer: async () => ({ state: 'confirmed', sent: ['Deny'] }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-2'))
    await settle()
    expect(h.answers[0]?.answer).toEqual({ type: 'permission', decision: 'deny' })
    expect(h.connector.toasts[0]?.text).toBe('Sending Deny…')
    expect(h.connector.lastEdit()?.text).toContain('<pre>touch x</pre>')
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Denied</i>')).toBe(true)
  })
})

describe('outcomes', () => {
  it('says an unconfirmed answer is uncertain, replies so the phone sounds, and upgrades it on a late report', async () => {
    const h = setup({ answer: async () => ({ state: 'sent-unconfirmed', sent: ['JWT'] }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('⚠ <i>Sent: JWT — not confirmed, check the laptop.</i>')).toBe(true)
    expect(h.connector.sends[1]).toMatchObject({ text: 'Sent, but not confirmed. Check the laptop.', options: { replyToMessageId: 100 } })
    expect(h.messages).toEqual([101])
    h.keeper.lateOutcome('r1', { state: 'confirmed', sent: ['JWT'] })
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Sent: JWT</i>')).toBe(true)
  })

  it('reports a partial answer and replies', async () => {
    const h = setup({ record: record(TWO), answer: async () => ({ state: 'partial', sent: ['JWT'], total: 2 }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('⚠ <i>Sent 1 of 2 — stopped: the dialog changed. Check the laptop.</i>')).toBe(true)
    expect(h.connector.sends[1]?.text).toBe('Sent 1 of 2, then the dialog changed. Check the laptop.')
  })

  it('gives fresh buttons with the reason when nothing was sent and the request is still open', async () => {
    const h = setup({ answer: async () => ({ state: 'refused', reason: 'not-on-screen' }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.lastEdit()?.text).toContain('⚠ <i>Nothing was sent: that dialog is not on the screen.</i>')
    expect(h.connector.editButtons()).toEqual(['tok-3', 'tok-4'])
    expect(h.connector.sends[1]?.text).toBe('Nothing was sent: that dialog is not on the screen.')
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    expect(h.answers).toHaveLength(2)
  })

  it('finishes the card with the refusal when the request closed meanwhile', async () => {
    const h = setup({ answer: async () => ({ state: 'refused', reason: 'gone' }) })
    await h.keeper.page(h.state.record!)
    h.state.record = record(QUESTION, { state: 'withdrawn' })
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('⚠ <i>Nothing was sent: this is no longer open.</i>')).toBe(true)
    expect(h.connector.lastEdit()?.options.keyboard ?? null).toBeNull()
  })

  it.each([
    ['answered at the laptop', { state: 'answered' as const, resolvedBy: 'owner' }, '<i>Answered at the laptop.</i>'],
    ['answered from Telegram by a reply', { state: 'answered' as const, resolvedBy: 'telegram' }, '✓ <i>Answered from Telegram.</i>'],
    ['withdrawn', { state: 'withdrawn' as const, resolvedBy: 'hook:claude:UserPromptSubmit' }, '<i>No longer open.</i>'],
    ['expired', { state: 'expired' as const, resolvedBy: 'expiry' }, '<i>No longer open.</i>']
  ])('removes the buttons and says so when the request is %s', async (_label, patch, line) => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    h.state.record = record(QUESTION, patch)
    h.keeper.changed(null)
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith(line)).toBe(true)
    expect(h.connector.lastEdit()?.options.keyboard ?? null).toBeNull()
    expect(h.updates[h.updates.length - 1]?.state).toBe('final')
    await h.keeper.tap(h.tap('tok-1'))
    expect(h.answers).toEqual([])
  })

  it('leaves a card that is sending to its outcome when the request closes first', async () => {
    let release: (outcome: AnswerOutcome) => void = () => undefined
    const h = setup({ answer: () => new Promise((resolve) => (release = resolve)) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    h.state.record = record(QUESTION, { state: 'answered', resolvedBy: 'telegram' })
    h.keeper.changed('s1')
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('<i>Sending: JWT…</i>')).toBe(true)
    release({ state: 'confirmed', sent: ['JWT'] })
    await settle()
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Sent: JWT</i>')).toBe(true)
  })
})

describe('after a restart', () => {
  const card = (messageId: number, state: TelegramCardState, format: 'html' | 'plain' = 'html'): TelegramCardRecord => ({
    messageId, sessionId: 's1', requestId: `r${messageId}`, incarnationId: 'i0', revision: 1, state,
    card: { base: '❓ <b>api</b>\n<b>Q?</b>', format }
  })

  it('finishes cards left with buttons or sending, once, and leaves the rest', async () => {
    const h = setup({ stored: [card(1, 'buttons'), card(2, 'sending'), card(3, 'open'), card(4, 'final'), card(5, 'buttons', 'plain')] })
    await h.keeper.sweep()
    await h.keeper.sweep()
    expect(h.connector.edits).toEqual([
      { id: 1, text: '❓ <b>api</b>\n<b>Q?</b>\n\n<i>BMN restarted — answer at the laptop.</i>', options: { html: true, keyboard: null } },
      { id: 2, text: '❓ <b>api</b>\n<b>Q?</b>\n\n⚠ <i>Sent — not confirmed, check the laptop.</i>', options: { html: true, keyboard: null } },
      { id: 5, text: '❓ api\nQ?\n\nBMN restarted — answer at the laptop.', options: { html: false, keyboard: null } }
    ])
    expect(h.updates.map((update) => [update.messageId, update.state])).toEqual([[1, 'final'], [2, 'final'], [5, 'final']])
  })

  it('does not sweep while Telegram is not connected, and sweeps once it is', async () => {
    const h = setup({ stored: [card(1, 'buttons')] })
    h.state.connected = false
    await h.keeper.sweep()
    expect(h.connector.edits).toEqual([])
    h.state.connected = true
    await h.keeper.sweep()
    expect(h.connector.edits).toHaveLength(1)
  })
})
