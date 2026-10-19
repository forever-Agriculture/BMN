// MODULE: telegram-grant-cards.test.ts - departure cards on the phone: delivery, Grant all, the Choose… walk, re-asks, restarts and endings (Story 84.3)
import { describe, expect, it } from 'vitest'
import {
  answerGrant,
  askGrant,
  DEFAULT_TELEGRAM_QUIET_HOURS,
  EMPTY_AWAY_RECORD,
  EMPTY_GRANT_RECORD,
  followAwayChange,
  parseGrantCardInput,
  setGrantPhone,
  startDeparture,
  type AwayRecord,
  type GrantRecord,
  type TelegramQuietHours
} from '@bmn/protocol'
import { GRANT_TOKEN_PREFIX, TelegramGrantCards } from './telegram-grant-cards'
import type { InboundTap } from './telegram-connector'

const T0 = '2026-10-19T19:31:00.000Z'
const T1 = '2026-10-19T19:40:00.000Z'
const LATE = '2026-10-19T23:10:00.000Z'
const awayRecord = (over: Partial<AwayRecord>): AwayRecord => ({ ...EMPTY_AWAY_RECORD, operations: [], ...over })
const AWAY = awayRecord({ state: 'away', revision: 1, periodId: 'p-1', since: T1, source: 'agent' })
const BACK = awayRecord({ state: 'back', revision: 2, periodId: 'p-1', since: T1, endedAt: LATE, source: 'agent', endedBy: 'app' })

const TERMS = [
  { kind: 'rounds', proposed: 3, reason: 'two review boundaries are ahead' },
  { kind: 'merge', id: 'merge-12', repository: 'octo/widgets', pr: 12, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'checks green at 22:20' },
  { kind: 'push-default', id: 'push-81', repository: 'octo/tools', branch: 'dev-auto/epic-81', proposed: 'yes', reason: 'tools takes no PRs' }
]
const parsed = (terms: unknown[] = TERMS) => {
  const result = parseGrantCardInput({ title: 'Epic 80 · tidy', scope: 'Stories 80.2-80.6', terms })
  if ('problem' in result) throw new Error(result.problem)
  return result.card
}
const leaving = (): GrantRecord => startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] },
  { source: 'agent', agentSessionId: 's-builder', periodId: 'p-1' }, 'back', T0).record
const ask = (record: GrantRecord, terms: unknown[] = TERMS, at = T0): GrantRecord =>
  askGrant(record, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card: parsed(terms) }, at).record
const away = (record: GrantRecord): GrantRecord => followAwayChange(record, awayRecord({}), AWAY, { to: 'away', source: 'agent', outcome: 'changed' }, T1).record

interface Sent { messageId: number; text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> | null; replyTo?: number }

function harness(start: GrantRecord, options: { atDesk?: boolean; quiet?: Partial<TelegramQuietHours>; now?: string; failAnswer?: boolean } = {}) {
  let record = start
  let nextId = 100
  let callback = 0
  const sent: Sent[] = []
  const edits: Sent[] = []
  const toasts: string[] = []
  const answers: unknown[] = []
  const connector = {
    sendMessage: async (text: string, opts: { keyboard?: Sent['keyboard']; replyToMessageId?: number } = {}) => {
      const messageId = nextId++
      sent.push({ messageId, text, keyboard: opts.keyboard ?? null, ...(opts.replyToMessageId === undefined ? {} : { replyTo: opts.replyToMessageId }) })
      return { messageId }
    },
    editMessageText: async (messageId: number, text: string, opts: { keyboard?: Sent['keyboard'] } = {}) => { edits.push({ messageId, text, keyboard: opts.keyboard ?? null }) },
    answerCallbackQuery: async (_id: string, text: string) => { toasts.push(text) }
  }
  const cards = new TelegramGrantCards({
    connector: () => connector as never,
    read: () => ({ state: 'read', record }),
    header: () => ({ session: 'Builder', agent: 'claude', flag: null }),
    ownerAway: () => options.atDesk === true ? false : true,
    quiet: () => ({ ...DEFAULT_TELEGRAM_QUIET_HOURS, ...options.quiet }),
    now: () => new Date(options.now ?? T1),
    answer: async (answer) => {
      answers.push(answer)
      if (options.failAnswer === true) throw new Error('database is locked')
      const result = answerGrant(record, answer, T1)
      // A refused answer of his is kept too, as the store keeps it.
      if (result.outcome !== 'repeated') record = result.record
      return result
    },
    keep: async (periodId, runId, phone) => { record = setGrantPhone(record, periodId, runId, phone).record }
  })
  const last = (): Sent => edits.at(-1) ?? sent.at(-1)!
  const button = (label: string, from: Sent = last()): string => {
    const found = (from.keyboard ?? []).flat().find((one) => one.text === label)
    if (!found) throw new Error(`no button ${label} in ${JSON.stringify(from.keyboard)}`)
    return found.callback_data
  }
  const tap = (data: string, messageId = sent[0]!.messageId): Promise<void> => {
    callback += 1
    const event: InboundTap = { updateId: callback, callbackId: `cb-${callback}`, chatId: 1, fromUserId: 1, messageId, data }
    return cards.tap(event)
  }
  return {
    cards, sent, edits, toasts, answers, last, button, tap,
    get record() { return record },
    set record(next: GrantRecord) { record = next }
  }
}

describe('TelegramGrantCards (Story 84.3, the notes 84.2 §1 On Telegram)', () => {
  it('holds a leaving card while he is at the desk and sends it once Away is set, with the overview and its three buttons', async () => {
    const h = harness(ask(leaving()), { atDesk: true })
    await h.cards.reconcile()
    expect(h.sent).toHaveLength(0)
    h.record = away(h.record)
    await h.cards.reconcile()
    expect(h.sent).toHaveLength(1)
    const card = h.sent[0]!
    expect(card.text).toContain('❓ <b>Builder</b> · Claude')
    expect(card.text).toContain('<i>Before you go · asked')
    expect(card.text).toContain('1. Extra repair rounds per boundary: 3')
    expect(card.text).toContain('2. Merge in octo/widgets: PR 12 at 3f2a9c1')
    expect(card.text).toContain('No admin merges or force pushes.')
    expect(card.keyboard).toHaveLength(1)
    expect(card.keyboard![0]!.map((one) => one.text)).toEqual(['Grant all', 'Choose…', 'Grant none'])
    expect(card.keyboard!.flat().every((one) => one.callback_data.startsWith(GRANT_TOKEN_PREFIX))).toBe(true)
    expect(h.record.periods[0]!.runs[0]!.phone).toEqual({ messageId: card.messageId, cardRevision: 1 })
    await h.cards.reconcile()
    expect(h.sent).toHaveLength(1)
  })

  it('Grant all answers through BMN as proposed, ends the card with what was granted, and revokes every button', async () => {
    const h = harness(away(ask(leaving())))
    await h.cards.reconcile()
    const none = h.button('Grant none')
    await h.tap(h.button('Grant all'))
    expect(h.answers).toEqual([expect.objectContaining({ choices: { rounds: 3, 'merge-12': 'pr', 'push-81': 'yes' }, via: 'telegram', operationKey: 'telegram:cb-1' })])
    expect(h.toasts).toEqual(['Granted.'])
    expect(h.last().keyboard).toBeNull()
    expect(h.last().text).toContain('✓ Granted until you are back: 3 rounds per boundary · merge PR 12 at 3f2a9c1 · push to the default branch in tools.')
    await h.tap(none)
    expect(h.toasts.at(-1)).toBe('This button is no longer active.')
    expect(h.answers).toHaveLength(1)
  })

  it('Choose… walks the terms one at a time with Back, and only the last tap grants', async () => {
    const h = harness(away(ask(leaving())))
    await h.cards.reconcile()
    await h.tap(h.button('Choose…'))
    expect(h.last().text).toContain('Before you go · 1 of 3')
    expect(h.last().keyboard![0]!.map((one) => one.text)).toEqual(['No', '2', '● 3', '4'])
    expect(h.last().keyboard!.at(-1)!.map((one) => one.text)).toEqual(['‹ Back'])
    await h.tap(h.button('4'))
    expect(h.toasts.at(-1)).toBe('2 of 3')
    expect(h.last().text).toContain('1. Extra repair rounds per boundary: 4')
    expect(h.last().keyboard!.slice(0, 3).map((row) => row.map((one) => one.text))).toEqual([['No'], ['● PR 12 at 3f2a9c1'], ['Up to 2 when green']])
    await h.tap(h.button('‹ Back'))
    expect(h.last().text).toContain('Before you go · 1 of 3')
    await h.tap(h.button('● 4'))
    await h.tap(h.button('No'))
    expect(h.last().text).toContain('Nothing is granted until this answer.')
    expect(h.answers).toHaveLength(0)
    await h.tap(h.button('● Yes'))
    expect(h.answers).toEqual([expect.objectContaining({ choices: { rounds: 4, 'merge-12': 'no', 'push-81': 'yes' } })])
    expect(h.last().text).toContain('✓ Granted until you are back: 4 rounds per boundary · push to the default branch in tools. Not granted: merge PR 12 at 3f2a9c1.')
  })

  it('a one-term card answers in one tap', async () => {
    const h = harness(away(ask(leaving(), [TERMS[0]])))
    await h.cards.reconcile()
    expect(h.sent[0]!.text).toContain('One tap answers.')
    expect(h.sent[0]!.keyboard).toEqual([[expect.objectContaining({ text: 'No' }), expect.objectContaining({ text: '2' }), expect.objectContaining({ text: '● 3' }), expect.objectContaining({ text: '4' })]])
    await h.tap(h.button('No'))
    expect(h.toasts).toEqual(['Granted none.'])
    expect(h.last().text).toContain('✓ Granted none.')
  })

  it('a re-ask edits the same message silently; a tap drawn for the earlier revision grants nothing and says so', async () => {
    const h = harness(away(ask(leaving())))
    await h.cards.reconcile()
    const old = h.button('Grant all')
    h.record = ask(h.record, [{ ...TERMS[0], proposed: 4 }, TERMS[1], TERMS[2]], T1)
    await h.cards.reconcile()
    expect(h.sent).toHaveLength(1)
    expect(h.edits.at(-1)!.messageId).toBe(h.sent[0]!.messageId)
    expect(h.edits.at(-1)!.text).toMatch(/^⚠ Changed at .*: rounds 3 → 4\./)
    await h.tap(old)
    // The stale Grant all was his answer: BMN refuses it for its old revision and keeps the refusal for the morning.
    expect(h.answers).toEqual([expect.objectContaining({ cardRevision: 1, via: 'telegram' })])
    expect(h.record.periods.at(-1)!.refusals).toEqual([expect.objectContaining({ runId: 'run-80', kind: 'answer', reason: 'changed', via: 'telegram' })])
    expect(h.record.periods.at(-1)!.runs[0]!.answer).toBeNull()
    expect(h.toasts.at(-1)).toBe('This card changed. Look again.')
    expect(h.edits.at(-1)!.text).toContain('Nothing was granted.')
    expect(h.sent.at(-1)).toMatchObject({ text: 'Nothing was granted: the card changed. Look again.', replyTo: h.sent[0]!.messageId })
    expect(h.edits.at(-1)!.keyboard).not.toBeNull()
  })

  it('after a restart an open card is redrawn on its own message with fresh buttons, never "answer at the laptop"', async () => {
    const before = harness(away(ask(leaving())))
    await before.cards.reconcile()
    const h = harness(before.record)
    await h.cards.reconcile()
    expect(h.sent).toHaveLength(0)
    expect(h.edits).toHaveLength(1)
    expect(h.edits[0]!.messageId).toBe(before.sent[0]!.messageId)
    expect(h.edits[0]!.text).not.toMatch(/restarted|laptop/i)
    await h.tap(h.button('Grant none'), before.sent[0]!.messageId)
    expect(h.answers).toEqual([expect.objectContaining({ choices: { rounds: 0, 'merge-12': 'no', 'push-81': 'no' } })])
  })

  it('a card asked within 30 minutes of Away goes at once; one asked later follows quiet hours', async () => {
    const quiet = { enabled: true, start: '00:00', end: '23:59' }
    const soon = harness(ask(away(leaving()), TERMS, '2026-10-19T20:00:00.000Z'), { quiet, now: '2026-10-19T20:00:00.000Z' })
    await soon.cards.reconcile()
    expect(soon.sent).toHaveLength(1)
    const later = harness(ask(away(leaving()), TERMS, LATE), { quiet, now: LATE })
    await later.cards.reconcile()
    expect(later.sent).toHaveLength(0)
    later.cards.dispose()
  })

  it('ends a drawn card for an answer in the app and withdraws an open one at Back', async () => {
    const h = harness(away(ask(leaving())))
    await h.cards.reconcile()
    h.record = answerGrant(h.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 3, 'merge-12': 'no', 'push-81': 'no' }, via: 'app', operationKey: 'app:1' }, T1).record
    await h.cards.reconcile()
    expect(h.last().text).toContain('Answered at the laptop: granted 3 rounds per boundary.')
    expect(h.last().keyboard).toBeNull()
    const open = harness(away(ask(leaving())))
    await open.cards.reconcile()
    open.record = followAwayChange(open.record, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    await open.cards.reconcile()
    expect(open.last().text).toContain('Withdrawn: you are back.')
    await open.tap(open.button('Grant all', open.sent[0]!))
    expect(open.toasts.at(-1)).toBe('This button is no longer active.')
    expect(open.answers).toHaveLength(0)
  })

  it('says nothing was granted when BMN could not save, with fresh buttons and a reply that sounds', async () => {
    const h = harness(away(ask(leaving())), { failAnswer: true })
    await h.cards.reconcile()
    await h.tap(h.button('Grant all'))
    expect(h.edits.at(-1)!.text).toMatch(/^⚠ Nothing was granted: BMN could not save your answer\. Try again\./)
    expect(h.edits.at(-1)!.keyboard).not.toBeNull()
    expect(h.sent.at(-1)).toMatchObject({ text: 'Nothing was granted: BMN could not save your answer. Try again.' })
  })

  it('knows its messages, so a typed reply to one is answered with the buttons rule', async () => {
    const h = harness(away(ask(leaving())))
    await h.cards.reconcile()
    expect(h.cards.owns(h.sent[0]!.messageId)).toBe(true)
    expect(h.cards.owns(9_999)).toBe(false)
  })
})
