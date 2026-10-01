// MODULE: telegram-card-keeper.test.ts - card lifecycle: taps, single-use tokens, outcomes, in-place edits, restart sweep, fallback
import { describe, expect, it, vi } from 'vitest'
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
  /** While set, edits wait for it: an edit still on its way to Telegram. */
  holdEdits: Promise<void> | null = null
  failEdits = false
  editError: Error | null = null
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
    if (this.holdEdits) await this.holdEdits
    if (this.editError) throw this.editError
    if (this.failEdits) throw new TelegramConnectorError('network', 'down')
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
  acknowledge?: (record: AttentionRecord) => Promise<void>
  stored?: TelegramCardRecord[]
  retryMs?: number[]
  epoch?: number | null
} = {}) {
  const connector = new FakeConnector()
  const state = { record: options.record === undefined ? record(QUESTION) : options.record, connected: true }
  const answers: AnswerRequest[] = []
  const acknowledgements: AttentionRecord[] = []
  const puts: TelegramCardRecord[] = []
  const updates: Array<{ messageId: number; state: TelegramCardState; card: TelegramCardData }> = []
  const messages: number[] = []
  let token = 0
  const keeper = new TelegramCardKeeper({
    connector: () => (state.connected ? connector : undefined),
    getAttention: async () => state.record,
    header: () => ({ session: 'api', agent: 'claude', flag: null }),
    answerability: async () => options.answerability ?? { answerable: true, deny: true },
    answerEpoch: () => options.epoch === undefined ? 4 : options.epoch,
    liveIncarnationId: () => 'i1',
    answer: async (request) => {
      answers.push(request)
      return options.answer ? options.answer(request) : { state: 'confirmed', sent: ['JWT'] }
    },
    acknowledge: async (record) => { acknowledgements.push(record); await options.acknowledge?.(record) },
    store: {
      put: async (card) => void puts.push(card),
      update: async (messageId, _revision, cardState, card) => void updates.push({ messageId, state: cardState, card }),
      list: async (states) => (options.stored ?? []).filter((row) => states.includes(row.state)),
      message: async (messageId) => void messages.push(messageId)
    },
    home: null,
    settleMs: 1,
    retryMs: options.retryMs ?? [5, 5],
    token: () => `tok-${++token}`
  })
  const tap = (data: string, messageId = 100): InboundTap =>
    ({ updateId: 1, callbackId: `cb-${data}`, chatId: 1, fromUserId: 1, messageId, data })
  return { keeper, connector, state, answers, acknowledgements, puts, updates, messages, tap }
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

describe('sending a card', () => {
  it('distinguishes an unavailable connector from an ambiguous send attempt', async () => {
    const h = setup()
    h.state.connected = false
    expect(await h.keeper.page(h.state.record!)).toBe(false)
    expect(h.connector.sends).toEqual([])
    h.state.connected = true; h.connector.failAll = true
    expect(await h.keeper.page(h.state.record!)).toBe(true)
    h.keeper.dispose()
  })

  it('serializes first-card creation across concurrent revisions', async () => {
    const h = setup()
    let release!: () => void, started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { started = resolve })
    const send = h.connector.sendMessage.bind(h.connector)
    vi.spyOn(h.connector, 'sendMessage').mockImplementationOnce(async (text, options) => {
      started(); await held; return send(text, options)
    })
    const initial = h.keeper.page(h.state.record!)
    await reached
    h.state.record = record(TWO, { revision: 2, title: 'Revised question' })
    const revised = h.keeper.page(h.state.record)
    const repeated = h.keeper.page(h.state.record)
    release(); await Promise.all([initial, revised, repeated])
    expect(h.connector.sends).toHaveLength(1)
    expect(h.puts).toHaveLength(1)
    expect(h.connector.lastEdit()?.text).toContain('1 of 2')
    h.keeper.dispose()
  })

  it('refuses an attachment caption after Other without turning it into an answer', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    const other = h.connector.buttons().at(-1)!
    await h.keeper.tap(h.tap(other))
    const attachment = { updateId: 50, chatId: 1, fromUserId: 1, messageId: 500, replyToMessageId: 100,
      text: 'Caption is not a text answer', file: {
      fileId: 'synthetic-document', fileName: 'synthetic.txt', mimeType: 'text/plain', fileSize: 3, kind: 'document' as const
    } }
    await expect(h.keeper.typedReply(attachment)).resolves.toBe(true)
    expect(h.answers).toEqual([])
    expect(h.connector.sends.at(-1)?.text).toContain('text reply without an attachment')
  })
  it('renews notice buttons after a failed acknowledgement of the unchanged revision', async () => {
    let attempts = 0
    const h = setup({ record: record(null, { kind: 'notice' }), acknowledge: async () => {
      if (++attempts === 1) throw new Error('Synthetic acknowledgement failure')
    } })
    await h.keeper.page(h.state.record!)
    const original = h.connector.buttons()[0]!
    await h.keeper.tap(h.tap(original))
    expect(h.connector.lastEdit()?.text).toContain('Acknowledgement failed')
    const renewed = h.connector.editButtons()[0]!
    expect(renewed).toBeTruthy()
    expect(renewed).not.toBe(original)
    await h.keeper.tap(h.tap(original))
    expect(attempts).toBe(1)
    await h.keeper.tap(h.tap(renewed))
    expect(attempts).toBe(2)
    expect(h.connector.lastEdit()?.text).toContain('Update acknowledged. No terminal input sent.')
    expect(h.answers).toEqual([])
    h.keeper.dispose()
  })

  it('offers notice acknowledgement and an addressed draft follow-up without invoking native answers', async () => {
    const h = setup({ record: record(null, { kind: 'notice', requestKey: 'update' }) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard?.flat().map(b => b.text)).toEqual(['Acknowledge', 'Other…'])
    const [ack, other] = h.connector.buttons()
    await h.keeper.tap(h.tap(other!))
    expect(h.connector.lastEdit()?.text).toContain('Reply to this card to continue in this session.')
    expect(h.answers).toEqual([])
    // Old buttons are revoked, including the acknowledgement from before Other….
    await h.keeper.tap(h.tap(ack!))
    expect(h.acknowledgements).toEqual([])
    await h.keeper.tap(h.tap(h.connector.editButtons()[0]!))
    expect(h.acknowledgements).toHaveLength(1)
    expect(h.connector.lastEdit()?.text).toContain('Update acknowledged. No terminal input sent.')
    expect(h.answers).toEqual([])
    h.keeper.dispose()
  })

  it('does not acknowledge a notice whose revision changed', async () => {
    const h = setup({ record: record(null, { kind: 'notice' }) })
    await h.keeper.page(h.state.record!)
    const token = h.connector.buttons()[0]!
    h.state.record = { ...h.state.record!, revision: 2 }
    await h.keeper.tap(h.tap(token))
    expect(h.acknowledgements).toEqual([])
    expect(h.answers).toEqual([])
    h.keeper.dispose()
  })
  it('sends one HTML card with a single-use token per option and stores it with its revision', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends).toHaveLength(1)
    expect(h.connector.sends[0]?.options.html).toBe(true)
    expect(h.connector.buttons()).toEqual(['tok-1', 'tok-2', 'tok-3'])
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

  it('mints no tokens for a permission whose command the card would clip', async () => {
    const long = { ...BASH, command: `${'x'.repeat(3100)}; touch unseen.txt` } as AttentionPrompt
    const h = setup({ record: record(long) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard).toBeNull()
    expect(h.connector.sends[0]?.text).toContain('The command is too long to show here. Answer at the laptop.')
    expect(h.puts[0]?.state).toBe('open')
    await h.keeper.tap(h.tap('tok-1'))
    expect(h.answers).toEqual([])
  })

  it('mints no tokens for a permission whose command has a secret hidden (Story 34.2)', async () => {
    const h = setup({ record: record({ ...BASH, command: 'export OPENAI_API_KEY=abcdefgh12345678' } as AttentionPrompt) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.buttons()).toEqual([])
    expect(h.connector.sends[0]!.text).toContain('Part of the command is hidden here. Answer at the laptop.')
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

  it('says Answer at the laptop before the secret footnote in the plain words (Astra review)', async () => {
    const leaky = { ...QUESTION, questions: [{ ...QUESTION.questions[0]!, text: 'Rotate sk-ant-api03-SyntheticKeyForTests_0123456789?' }] } as AttentionPrompt
    const h = setup({ record: record(leaky) })
    h.connector.refuseHtml = true
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.text).not.toContain('SyntheticKey')
    expect(h.connector.sends[0]?.text.endsWith('Answer at the laptop.\n\nSome text looked like a secret and was hidden. The full text is on the laptop.')).toBe(true)
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
    expect(h.connector.editButtons()).toEqual(['tok-4', 'tok-5', 'tok-6'])
    await h.keeper.page(h.state.record)
    expect(h.connector.sends).toHaveLength(1)
    await h.keeper.tap(h.tap('tok-1'))
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-1', text: 'This button is no longer active.' }])
    expect(h.answers).toEqual([])
  })
})

describe('buttons drawn for one revision', () => {
  it('never answer the next revision while its card is still on the way (Astra A1)', async () => {
    const h = setup({ record: record(BASH) })
    let epoch = 4
    ;(h.keeper as unknown as { deps: { answerEpoch: () => number } }).deps.answerEpoch = () => epoch
    await h.keeper.page(h.state.record!)
    expect(h.connector.buttons()).toEqual(['tok-1', 'tok-2'])
    let release!: () => void
    h.connector.holdEdits = new Promise((resolve) => { release = resolve })
    h.state.record = record(BASH, { revision: 2 })
    epoch = 5
    h.keeper.changed('s1')
    await settle()
    // The revision-2 card is still being drawn: the revision-1 Allow once must not answer it.
    const tapped = h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-1', text: 'This button is no longer active.' }])
    release()
    h.connector.holdEdits = null
    await tapped
    await settle()
    expect(h.answers).toEqual([])
    expect(h.connector.editButtons()).toEqual(['tok-3', 'tok-4'])
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    expect(h.answers).toEqual([expect.objectContaining({ revision: 2, epoch: 5, answer: { type: 'permission', decision: 'allow' } })])
  })

  it('stay dead when the new card could not be drawn, and answer nothing', async () => {
    const h = setup({ record: record(BASH) })
    await h.keeper.page(h.state.record!)
    h.connector.failEdits = true
    h.state.record = record(BASH, { revision: 2 })
    h.keeper.changed('s1')
    await settle()
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.answers).toEqual([])
    expect(h.connector.toasts[0]?.text).toBe('This button is no longer active.')
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

  it('answers a masked option by its identity and never sends the secret in a card or toast (Story 34.2)', async () => {
    // A synthetic key in the sk-ant- shape; not a real credential.
    const key = 'sk-ant-api03-SyntheticKeyForTests_0123456789'
    const masked: AttentionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0]!,
      options: [{ label: 'JWT', description: null }, { label: `Keep ${key}`, description: null }] }] } as AttentionPrompt
    const h = setup({ record: record(masked), answer: async () => ({ state: 'confirmed', sent: [`Keep ${key}`] }) })
    await h.keeper.page(h.state.record!)
    expect((h.connector.sends[0]!.options.keyboard ?? []).flat().slice(0, 2))
      .toEqual([{ text: '1 · JWT', callback_data: 'tok-1' }, { text: '2 · Keep [secret hidden]', callback_data: 'tok-2' }])
    await h.keeper.tap(h.tap('tok-2'))
    await settle()
    expect(h.answers.map((answer) => answer.answer)).toEqual([{ type: 'choices', choices: [1] }])
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-2', text: 'Sending Keep [secret hidden]…' }])
    const sent = [...h.connector.sends.map((send) => send.text), ...h.connector.edits.map((edit) => edit.text), ...h.connector.toasts.map((toast) => toast.text)]
    expect(sent.some((text) => text.includes(key))).toBe(false)
    expect(h.connector.lastEdit()?.text.endsWith('The full text is on the laptop.</i>')).toBe(true)
  })

  it('toasts a masked multi-select toggle without the secret', async () => {
    const key = 'sk-ant-api03-SyntheticKeyForTests_0123456789'
    const multi: AttentionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0]!, multiSelect: true,
      options: [{ label: `Keep ${key}`, description: null }, { label: 'JWT', description: null }] }] } as AttentionPrompt
    const h = setup({ record: record(multi) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.connector.toasts).toEqual([{ id: 'cb-tok-1', text: '● Keep [secret hidden]' }])
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
    expect(h.connector.editButtons()).toEqual(['tok-4', 'tok-5', 'tok-6', 'tok-7'])
    expect(h.answers).toEqual([])
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-5'))
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

  it('gives fresh buttons when OpenCode later refuses an unconfirmed answer, and a pending retry never overwrites them', async () => {
    const h = setup({ answer: async () => ({ state: 'sent-unconfirmed', sent: ['JWT'] }), retryMs: [100, 100] })
    await h.keeper.page(h.state.record!)
    h.connector.failEdits = true
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    h.connector.failEdits = false
    h.keeper.lateOutcome('r1', { state: 'refused', reason: 'api-refused' })
    await settle()
    expect(h.connector.lastEdit()?.text).toContain('OpenCode rejected the answer; nothing was applied.')
    expect(h.connector.editButtons()).toEqual(['tok-4', 'tok-5', 'tok-6'])
    expect(h.connector.sends.at(-1)).toMatchObject({ options: { replyToMessageId: 100 } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(h.connector.editButtons()).toEqual(['tok-4', 'tok-5', 'tok-6'])
    expect(h.connector.lastEdit()?.text).not.toContain('not confirmed')
    expect(h.answers).toHaveLength(1)
  })

  it('reports a partial answer and replies', async () => {
    const h = setup({ record: record(TWO), answer: async () => ({ state: 'partial', sent: ['JWT'], total: 2 }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-1'))
    await h.keeper.tap(h.tap('tok-4'))
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
    expect(h.connector.editButtons()).toEqual(['tok-4', 'tok-5', 'tok-6'])
    expect(h.connector.sends[1]?.text).toBe('Nothing was sent: that dialog is not on the screen.')
    await h.keeper.tap(h.tap('tok-4'))
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

  it('keeps a card whose ending Telegram did not take unfinished, retries it and never answers again (Astra A7)', async () => {
    const h = setup({ retryMs: [100, 100] })
    await h.keeper.page(h.state.record!)
    h.connector.failEdits = true
    await h.keeper.tap(h.tap('tok-1'))
    await settle()
    expect(h.answers).toHaveLength(1)
    expect(h.updates.map((update) => update.state)).not.toContain('final')
    h.connector.failEdits = false
    await vi.waitFor(() => expect(h.updates.map((update) => update.state)).toContain('final'))
    expect(h.connector.lastEdit()).toMatchObject({ id: 100, options: { keyboard: null } })
    expect(h.connector.lastEdit()?.text).toContain('Sent: JWT')
    expect(h.answers).toHaveLength(1)
  })

  it('gives up retrying after the last wait and leaves the stored card for the next start', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    h.connector.failEdits = true
    await h.keeper.tap(h.tap('tok-1'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.updates.map((update) => update.state)).not.toContain('final')
  })

  it('finishes a card Telegram will never edit instead of retrying it', async () => {
    const h = setup({ stored: [card(1, 'buttons')] })
    h.connector.editError = new TelegramConnectorError('http', 'Telegram editMessageText failed (400): message to edit not found', 400)
    await h.keeper.sweep()
    expect(h.updates.map((update) => [update.messageId, update.state])).toEqual([[1, 'final']])
  })

  it('leaves a stale card unfinished when its restart edit fails, and finishes it on the next sweep', async () => {
    const h = setup({ stored: [card(1, 'buttons')] })
    h.connector.failEdits = true
    await h.keeper.sweep()
    expect(h.updates).toEqual([])
    h.connector.failEdits = false
    await h.keeper.sweep()
    expect(h.updates.map((update) => [update.messageId, update.state])).toEqual([[1, 'final']])
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

  it('cleans and masks a card stored before Stories 34.1 and 34.2 when it finishes it (Astra review)', async () => {
    // A synthetic key; not a real credential.
    const key = 'sk-ant-api03-SyntheticKeyForTests_0123456789'
    const legacy = (messageId: number, format: 'html' | 'plain'): TelegramCardRecord => ({
      ...card(messageId, 'buttons', format), card: { base: `❓ <b>api</b>\n<b>Use \u202E${key}?</b>`, format }
    })
    const h = setup({ stored: [legacy(1, 'html'), legacy(2, 'plain')] })
    await h.keeper.sweep()
    const footnote = 'Some text looked like a secret and was hidden. The full text is on the laptop.'
    expect(h.connector.edits).toEqual([
      { id: 1, text: `❓ <b>api</b>\n<b>Use [secret hidden]?</b>\n\n<i>BMN restarted — answer at the laptop.</i>\n\n<i>${footnote}</i>`, options: { html: true, keyboard: null } },
      { id: 2, text: `❓ api\nUse [secret hidden]?\n\nBMN restarted — answer at the laptop.\n\n${footnote}`, options: { html: false, keyboard: null } }
    ])
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

describe('multi-select, Other… and Back (Epic 31)', () => {
  const FEATURES: AttentionPrompt = {
    type: 'questions', harness: 'claude', shape: 'multi-select', requestRef: null, toolUseId: 'toolu_2',
    questions: [{
      id: null, header: 'Features', text: 'Which features?', multiSelect: true,
      options: [{ label: 'Rate limiting', description: null }, { label: 'Audit log', description: null }, { label: 'Webhooks', description: null }]
    }]
  }
  const reply = (text: string | null, replyTo = 100, messageId = 500) =>
    ({ updateId: 9, chatId: 1, fromUserId: 1, messageId, replyToMessageId: replyTo, text, file: null })
  const texts = (h: ReturnType<typeof setup>) => (h.connector.lastEdit()?.options.keyboard ?? []).flat().map((button) => button.text)

  it('toggles only edit the card; Send delivers the set in option order', async () => {
    const h = setup({ record: record(FEATURES), answer: async () => ({ state: 'confirmed', sent: ['Rate limiting · Webhooks'] }) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard?.flat().map((button) => button.text)).toEqual(['○ 1 · Rate limiting', '○ 2 · Audit log', '○ 3 · Webhooks', 'Other…'])
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    expect(texts(h)).toEqual(['○ 1 · Rate limiting', '○ 2 · Audit log', '● 3 · Webhooks', 'Other…', 'Send 1 selected'])
    await h.keeper.tap(h.tap('tok-5'))
    await settle()
    expect(texts(h)).toEqual(['● 1 · Rate limiting', '○ 2 · Audit log', '● 3 · Webhooks', 'Other…', 'Send 2 selected'])
    expect(h.connector.lastEdit()?.text).toContain('<i>Chosen: Webhooks · Rate limiting</i>')
    expect(h.answers).toEqual([])
    // Send is the last button: tokens 10 to 14 are the three toggles, Other… and Send.
    await h.keeper.tap(h.tap('tok-14'))
    await settle()
    expect(h.answers).toEqual([expect.objectContaining({ answer: { type: 'choices', choices: [{ set: [0, 2] }] }, revision: 1, epoch: 4 })])
    expect(h.connector.lastEdit()?.text.endsWith('✓ <i>Sent: Rate limiting · Webhooks</i>')).toBe(true)
  })

  it('refuses a reply to a card just paged, before any tap: never a draft (Astra review)', async () => {
    const h = setup({ record: record(FEATURES) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard?.flat().map((button) => button.text)).toContain('Other…')
    await expect(h.keeper.typedReply(reply('GraphQL'))).resolves.toBe(true)
    expect(h.connector.sends.at(-1)).toMatchObject({ text: 'Tap Other… first, then reply with your answer.', options: { replyToMessageId: 500 } })
    expect(h.answers).toEqual([])
  })

  it('refuses replies while an Other answer is sending and releases later conversation replies after completion', async () => {
    let release!: () => void
    const h = setup({ record: record(FEATURES), answer: () => new Promise((resolve) => { release = () => resolve({ state: 'confirmed', sent: ['“GraphQL”'] }) }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-4'))
    await settle()
    await expect(h.keeper.typedReply(reply('GraphQL'))).resolves.toBe(true)
    await settle()
    expect(h.answers).toHaveLength(1)
    // The answer is on its way: a second reply is kept and refused, and nothing else is typed.
    await expect(h.keeper.typedReply(reply('Something else', 100, 501))).resolves.toBe(true)
    expect(h.connector.sends.at(-1)).toMatchObject({ text: 'Another answer is already on its way.', options: { replyToMessageId: 501 } })
    expect(h.answers).toHaveLength(1)
    release()
    await settle()
    // The owner now permits follow-up conversation messages after the original answer settles.
    await expect(h.keeper.typedReply(reply('And another', 100, 502))).resolves.toBe(false)
    expect(h.answers).toHaveLength(1)
  })

  it('Other… asks for a reply, ‹ Options returns with the toggles intact, and the reply is the typed answer', async () => {
    const h = setup({ record: record(FEATURES), answer: async () => ({ state: 'confirmed', sent: ['Audit log · “GraphQL”'] }) })
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-2'))
    await settle()
    // A reply before Other… is refused: never a draft, never a prompt.
    await expect(h.keeper.typedReply(reply('GraphQL'))).resolves.toBe(true)
    expect(h.connector.sends.at(-1)).toMatchObject({ text: 'Tap Other… first, then reply with your answer.', options: { replyToMessageId: 500 } })
    await h.keeper.tap(h.tap('tok-8'))
    await settle()
    expect(h.connector.lastEdit()?.text).toContain('<i>Reply to this message with your answer.</i>')
    expect(texts(h)).toEqual(['‹ Options'])
    await h.keeper.tap(h.tap('tok-10'))
    await settle()
    expect(texts(h)).toEqual(['○ 1 · Rate limiting', '● 2 · Audit log', '○ 3 · Webhooks', 'Other…', 'Send 1 selected'])
    await h.keeper.tap(h.tap('tok-14'))
    await settle()
    await expect(h.keeper.typedReply(reply('  Graph\nQL\u0007 please '))).resolves.toBe(true)
    await settle()
    expect(h.answers).toEqual([expect.objectContaining({ answer: { type: 'choices', choices: [{ set: [1], typed: 'Graph QL please' }] } })])
    expect(h.answers).toHaveLength(1)
  })

  it('clips a typed reply to 2,000 characters and asks again for an empty one', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    await expect(h.keeper.typedReply(reply(null))).resolves.toBe(true)
    expect(h.connector.sends.at(-1)?.text).toBe('Reply with your answer as text.')
    await h.keeper.typedReply(reply('x'.repeat(2_500)))
    await settle()
    const choice = (h.answers[0]?.answer as { choices: Array<{ typed: string }> }).choices[0]!
    expect(choice.typed).toHaveLength(2_000)
  })

  it('refuses a typed reply to a card whose request changed, and sends nothing', async () => {
    const h = setup()
    await h.keeper.page(h.state.record!)
    await h.keeper.tap(h.tap('tok-3'))
    await settle()
    h.state.record = record(QUESTION, { revision: 2 })
    await expect(h.keeper.typedReply(reply('Mine'))).resolves.toBe(true)
    await settle()
    expect(h.answers).toEqual([])
    expect(h.connector.sends.at(-1)?.text).toBe('Nothing was sent: the dialog changed on the laptop.')
  })

  it('leaves replies to cards without Other… to their usual meaning', async () => {
    const noTyped: AttentionPrompt = {
      ...QUESTION, harness: 'opencode', requestRef: 'que_1',
      questions: [{ ...(QUESTION as Extract<AttentionPrompt, { type: 'questions' }>).questions[0]!, custom: false }]
    } as AttentionPrompt
    const h = setup({ record: record(noTyped) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.buttons()).toEqual(['tok-1', 'tok-2'])
    await expect(h.keeper.typedReply(reply('Mine'))).resolves.toBe(false)
    await expect(h.keeper.typedReply(reply('Mine', 999))).resolves.toBe(false)
    const closed = setup({ answerability: { answerable: false, reason: 'unsupported' } })
    await closed.keeper.page(closed.state.record!)
    await expect(closed.keeper.typedReply(reply('Mine'))).resolves.toBe(false)
  })

  it('Back returns to the previous question with its choice marked, never shown on the first', async () => {
    const h = setup({ record: record(TWO) })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]?.options.keyboard?.flat().map((button) => button.text)).toEqual(['1 · JWT', '2 · Session cookies', 'Other…'])
    await h.keeper.tap(h.tap('tok-2'))
    await settle()
    expect(texts(h)).toEqual(['1 · Yes', '2 · Later', 'Other…', '‹ Back'])
    await h.keeper.tap(h.tap('tok-7'))
    await settle()
    expect(h.connector.toasts.at(-1)?.text).toBe('Question 1 of 2')
    expect(texts(h)).toEqual(['1 · JWT', '● 2 · Session cookies', 'Other…'])
    expect(h.connector.lastEdit()?.text).not.toContain('<blockquote>')
    await h.keeper.tap(h.tap('tok-8'))
    await settle()
    await h.keeper.tap(h.tap('tok-12'))
    await settle()
    expect(h.answers).toEqual([expect.objectContaining({ answer: { type: 'choices', choices: [0, 1] } })])
  })
})

describe('manual choice cards without native epochs', () => {
  const manual = () => record(null, { manualChoices: { options: [{ label: 'Proceed', description: null }, { label: 'Wait', description: 'Keep pending' }], allowOther: true } })
  it('offers exact options and Other, submits once, and leaves direct replies to preference routing', async () => {
    const h = setup({ record: manual(), epoch: null })
    await h.keeper.page(h.state.record!)
    expect(h.connector.sends[0]!.options.keyboard!.flat().map(button => button.text)).toEqual(['Proceed', 'Wait', 'Other…'])
    expect(await h.keeper.typedReply({ updateId: 1, chatId: 1, fromUserId: 1, messageId: 200, replyToMessageId: 100, text: 'direct', file: null })).toBe(false)
    const token = h.connector.buttons()[0]!
    await Promise.all([h.keeper.tap(h.tap(token)), h.keeper.tap(h.tap(token))]); await settle()
    expect(h.answers).toHaveLength(1); expect(h.answers[0]!.answer).toEqual({ type: 'choices', choices: [0] })
    h.keeper.dispose()
  })
  it('preserves a usable keyboard on formatting fallback and full labels with maximal description/body text', async () => {
    const request = manual()
    request.manualChoices!.options = Array.from({ length: 8 }, (_, index) => ({ label: `${index}${'L'.repeat(199)}`, description: 'D'.repeat(500) }))
    request.body = 'B'.repeat(8000)
    const h = setup({ record: request, epoch: null })
    h.connector.refuseHtml = true
    await h.keeper.page(request)
    expect(h.connector.sends[0]!.text.length).toBeLessThanOrEqual(4096)
    expect(h.connector.buttons()).toHaveLength(9)
    for (const option of request.manualChoices!.options) expect(h.connector.sends[0]!.text).toContain(option.label)
    expect(h.connector.sends[0]!.text).toContain('Full text at laptop')
    h.keeper.dispose()
  })
})


it.each([false, true])('full review masks manual request keys/options through send, keyboard, edits and fallback=%s', async fallback => {
  const secret = 'sk-ant-api03-' + 'SyntheticKeyForTests_0123456789'
  const h = setup({ record: record(null, { requestKey: `request-${secret}`, manualChoices: { options: [
    { label: `Keep ${secret}`, description: null }, { label: 'Wait', description: null }], allowOther: true } }), epoch: null,
    answer: async () => ({ state: 'submitted', sent: [`Keep ${secret}`] }) })
  h.connector.refuseHtml = fallback
  await h.keeper.page(h.state.record!)
  expect(JSON.stringify(h.connector.sends).includes(secret)).toBe(false)
  await h.keeper.tap(h.tap(h.connector.buttons()[0]!)); await settle()
  expect(h.answers.map(answer => answer.answer)).toEqual([{ type: 'choices', choices: [0] }])
  expect(JSON.stringify([h.connector.sends, h.connector.edits, h.connector.toasts]).includes(secret)).toBe(false)
  h.keeper.dispose()
})
