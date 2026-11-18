// MODULE: telegram-grant-cards.test.ts - departure cards on the phone: delivery, Grant all, the Choose… walk, re-asks, restarts and endings (Story 84.3)
import { describe, expect, it } from 'vitest'
import {
  answerGrant,
  askGrant,
  changeGrantAccess,
  markGrantLimit,
  settleGrantLimit,
  DEFAULT_TELEGRAM_QUIET_HOURS,
  EMPTY_AWAY_RECORD,
  EMPTY_GRANT_RECORD,
  followAwayChange,
  parseGrantCardInput,
  setGrantPhone,
  startDeparture,
  newDepartureCollection,
  type AwayRecord,
  type GrantRecord,
  type TelegramQuietHours
} from '@bmn/protocol'
import { GRANT_TOKEN_PREFIX, grantNothingFitsPhone, TelegramGrantCards } from './telegram-grant-cards'
import { TELEGRAM_TEXT_LIMIT } from './telegram-cards'
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

function harness(start: GrantRecord, options: { atDesk?: boolean; quiet?: Partial<TelegramQuietHours>; now?: string; failAnswer?: boolean; failEdit?: boolean; beforeEdit?(messageId: number): Promise<void> } = {}) {
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
    editMessageText: async (messageId: number, text: string, opts: { keyboard?: Sent['keyboard'] } = {}) => { if (options.failEdit) throw Error('synthetic edit rejected'); await options.beforeEdit?.(messageId); edits.push({ messageId, text, keyboard: opts.keyboard ?? null }) },
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
      const access = Object.entries(answer.choices).find(([, choice]) => choice === 'done')
      const result = answerGrant(record, { ...answer, ...(access ? { lineId: access[0], accessAttemptId: `attempt-${answers.length}` } : {}) }, options.now ?? T1)
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

  describe('a command and a message (Story 103.3 AC1)', () => {
    it('names a pinned file and its whole SHA-256, at the most a card may hold, on the overview and each step (D7; the full review, finding 4)', async () => {
      const sha256 = 'a'.repeat(64)
      const path = `scripts/${'p'.repeat(480)}.sh`
      const pinned = { kind: 'command', id: 'check-1', command: `./${path} ${'c'.repeat(500)}`, folder: `/work/${'f'.repeat(480)}`, count: 1, script: { path, sha256 }, proposed: 'yes', reason: 'r'.repeat(300) }
      const message = { kind: 'message', id: 'tell-1', tool: 'send_message', target: 'the team', text: 'm'.repeat(150), proposed: 'yes', reason: 'r'.repeat(300) }
      const rest = [
        { kind: 'rounds', proposed: 3, reason: 'r'.repeat(300) },
        ...[1, 2, 3, 4, 5].map((pr) => ({ kind: 'merge', id: `merge-${pr}`, repository: `octo/widgets-with-a-rather-long-name-${pr}`, pr, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'r'.repeat(300) }))
      ]
      const h = harness(away(ask(leaving(), [pinned, message, ...rest])))
      await h.cards.reconcile()
      const pinWords = `While ${path} has SHA-256 ${sha256}`
      expect(h.sent[0]!.text).toContain(pinWords)
      expect(h.sent[0]!.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      await h.tap(h.button('Choose…'))
      expect(h.last().text).toContain(pinWords)
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      await h.tap(h.button('● Yes'))
      expect(h.last().text).toContain(pinWords)
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    })

    const COMMAND = { kind: 'command', id: 'check-1', command: `./scripts/check.sh ${'c'.repeat(980)}`, folder: '/work/app', count: 3, proposed: 'yes', reason: 'r'.repeat(300) }
    const MESSAGE = { kind: 'message', id: 'tell-1', tool: 'send_message', target: 'the team chat', text: `The <build> & the page\n${'m'.repeat(970)}`, proposed: 'yes', reason: 'r'.repeat(300) }
    const FULL = [
      COMMAND, MESSAGE,
      { kind: 'rounds', proposed: 3, reason: 'r'.repeat(300) },
      ...[1, 2, 3, 4, 5].map((pr) => ({ kind: 'merge', id: `merge-${pr}`, repository: `octo/widgets-with-a-rather-long-name-${pr}`, pr, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'r'.repeat(300) }))
    ]

    it('shows both whole, on the overview and on each step, within what Telegram takes, and offers no and yes', async () => {
      const h = harness(away(ask(leaving(), FULL)))
      await h.cards.reconcile()
      const overview = h.sent[0]!.text
      expect(overview).toContain(COMMAND.command)
      expect(overview).toContain('The &lt;build&gt; &amp; the page\n')
      expect(overview).toContain('m'.repeat(970))
      expect(overview.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      await h.tap(h.button('Choose…'))
      expect(h.last().text).toContain(COMMAND.command)
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      expect(h.last().keyboard!.flat().map((one) => one.text)).toEqual(expect.arrayContaining(['No', expect.stringContaining('Up to 3')]))
      await h.tap(h.button('● Up to 3'))
      expect(h.last().text).toContain(COMMAND.command)
      expect(h.last().text).toContain('m'.repeat(970))
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      expect(h.last().keyboard!.flat().map((one) => one.text)).toEqual(expect.arrayContaining(['No', expect.stringContaining('Yes')]))
    })

    it('fits the largest card a parser takes, in the most escaped text', async () => {
      const worst = [{ ...MESSAGE, text: '&'.repeat(200) }, { ...MESSAGE, id: 'tell-2', text: 'x'.repeat(1000) }]
      const h = harness(away(ask(leaving(), worst)))
      await h.cards.reconcile()
      expect(h.sent[0]!.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      expect(h.sent[0]!.text).toContain('&amp;'.repeat(200))
    })
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


describe('getting-ready Telegram choices (130.4)', () => {
  const v2 = () => ask(startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'p-1', collection: newDepartureCollection([], T0) }, 'back', T0).record)
  it('keeps the saved non-default value shown by the same overview when Grant all is tapped', async () => {
    const h = harness(v2(), { atDesk: true })
    h.record = answerGrant(h.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 4 }, via: 'app', operationKey: 'saved-four', expectedRevision: h.record.revision }, T1).record
    await h.cards.reconcile()
    expect(h.last().text).toContain('Extra repair rounds per boundary: 4')
    const saved = structuredClone(h.record.periods[0]!.runs[0]!.answer!.lines!.rounds)
    await h.tap(h.button('Grant all'))
    expect(h.record.periods[0]!.runs[0]!.answer?.choices.rounds).toBe(4)
    expect(h.record.periods[0]!.runs[0]!.answer!.lines!.rounds).toEqual(saved)
  })
  it('shows the persisted non-default pick on the next v2 Choose screen', async () => {
    const h = harness(v2(), { atDesk: true })
    await h.cards.reconcile()
    await h.tap(h.button('Choose…'))
    await h.tap(h.button('2'))
    expect(h.record.periods[0]!.runs[0]!.answer?.choices.rounds).toBe(2)
    expect(h.last().text).toContain('1. Extra repair rounds per boundary: 2')
  })
  it('skips an already answered middle line in one immediate-Away v2 Choose walk', async () => {
    const ended = followAwayChange(away(v2()), AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    const next = followAwayChange(ended, BACK, { ...AWAY, periodId: 'p-2', since: LATE }, { to: 'away', source: 'cli', outcome: 'changed' }, LATE).record
    const h = harness(ask(next), { now: LATE })
    h.record = answerGrant(h.record, { periodId: 'p-2', runId: 'run-80', cardRevision: 1, choices: { 'merge-12': 'no' }, via: 'app', operationKey: 'middle-answered', expectedRevision: h.record.revision }, LATE).record
    h.record = setGrantPhone(h.record, 'p-2', 'run-80', { messageId: 101, cardRevision: 1 }).record
    await h.cards.reconcile()
    await h.tap(h.button('Choose…'), 101)
    await h.tap(h.button('2'), 101)
    expect(h.last().text).toContain('<b>3. Push')
    await h.tap(h.button('No'), 101)
    expect(h.record.periods.at(-1)!.runs[0]!.answer?.choices).toEqual({ rounds: 2, 'merge-12': 'no', 'push-81': 'no' })
    expect(h.last().keyboard).toBeNull()
  })
  it('accepts the first displayed v2 button immediately after its message id is kept', async () => {
    const h = harness(v2(), { atDesk: true })
    await h.cards.reconcile()
    await h.tap(h.button('Grant all'))
    expect(h.record.periods[0]!.runs[0]!.answer?.choices.rounds).toBe(3)
  })
  it('answers a multi-line explicit Away period after the record has upgraded to v2', async () => {
    const ended = followAwayChange(away(v2()), AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    const next = followAwayChange(ended, BACK, { ...AWAY, periodId: 'p-2', since: LATE }, { to: 'away', source: 'cli', outcome: 'changed' }, LATE).record
    const h = harness(ask(next), { now: LATE })
    expect(h.record.version).toBe(2)
    expect(h.record.periods.at(-1)!.collection).toBeUndefined()
    h.record = setGrantPhone(h.record, 'p-2', 'run-80', { messageId: 101, cardRevision: 1 }).record
    await h.cards.reconcile()
    await h.tap(h.button('Choose…'), 101)
    await h.tap(h.button('2'), 101)
    expect(h.record.periods.at(-1)!.runs[0]!.answer?.choices).toEqual({ rounds: 2 })
    expect(h.last().text).toContain('<b>2. Merge')
    await h.tap(h.button('No'), 101)
    expect(h.last().text).toContain('<b>3. Push')
    await h.tap(h.button('No'), 101)
    expect(h.record.periods.at(-1)!.runs[0]!.answer?.choices).toEqual({ rounds: 2, 'merge-12': 'no', 'push-81': 'no' })
    expect(h.last().keyboard).toBeNull()
  })
  it('Grant all saves the earlier choices actually displayed as proposals', async () => {
    let first = v2()
    const answered = answerGrant(first, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 2, 'merge-12': 'pr' }, via: 'app', operationKey: 'prior', expectedRevision: first.revision }, T1)
    expect(answered.outcome).toBe('granted'); first = away(answered.record)
    const ended = followAwayChange(first, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    const next = startDeparture(ended, { source: 'app', agentSessionId: null, periodId: 'p-2', collection: newDepartureCollection([], LATE) }, 'back', LATE).record
    const h = harness(ask(next), { atDesk: true, now: LATE })
    await h.cards.reconcile(); await h.cards.reconcile()
    expect(h.last().text).toContain('proposed 2 · not answered')
    await h.tap(h.button('Grant all'))
    expect(h.record.periods.at(-1)!.runs[0]!.answer?.choices.rounds).toBe(2)
    expect(h.last().text).not.toContain('not granted until your tap')
  })
  it('retries an unacknowledged edit after an app answer without requiring another write', async () => {
    const options = { atDesk: true, failEdit: false }
    const h = harness(v2(), options)
    await h.cards.reconcile()
    options.failEdit = true
    h.record = answerGrant(h.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 2 }, via: 'app', operationKey: 'app-edit-failed', expectedRevision: h.record.revision }, T1).record
    await h.cards.reconcile()
    options.failEdit = false
    await h.cards.reconcile()
    expect(h.last().text).toContain('Extra repair rounds per boundary: 2')
    expect(h.last().text).toContain('Answered at the laptop')
  })
  it('draws the current run snapshot when another answer arrives during a multi-card redraw', async () => {
    const options: { atDesk: boolean; beforeEdit?: (messageId: number) => Promise<void> } = { atDesk: true }
    const h = harness(v2(), options)
    h.record = askGrant(h.record, { runId: 'second', sessionId: 's-second', agentCli: 'claude', card: parsed([{ kind: 'rounds', proposed: 2, reason: 'Second initial' }]) }, T0).record
    let changed = false
    options.beforeEdit = async messageId => {
      if (messageId !== 100 || changed) return
      changed = true
      h.record = askGrant(h.record, { runId: 'second', sessionId: 's-second', agentCli: 'claude', card: parsed([{ kind: 'rounds', proposed: 4, reason: 'Second revised' }]) }, T1).record
    }
    await h.cards.reconcile(); await h.cards.reconcile()
    expect(changed).toBe(true)
    const second = h.edits.findLast(row => row.messageId === 101) ?? h.sent.find(row => row.messageId === 101)!
    expect(second.text).toContain('proposed 4 · not answered')
    await h.tap(h.button('4', second), 101)
    expect(h.record.periods[0]!.runs.find(run => run.runId === 'second')!.answer?.choices.rounds).toBe(4)
  })
  it('retries a failed redraw and displays only callbacks for the current saved revision', async () => {
    const options = { atDesk: true, failEdit: false }
    const h = harness(v2(), options)
    await h.cards.reconcile(); await h.cards.reconcile()
    options.failEdit = true
    h.record = ask(h.record, [{ kind: 'rounds', proposed: 4, reason: 'changed' }])
    await h.cards.reconcile()
    options.failEdit = false
    await h.cards.reconcile()
    expect(h.last().text).toContain('proposed 4 · not answered')
    await h.tap(h.button('4'))
    expect(h.record.periods.at(-1)!.runs[0]!.answer?.choices.rounds).toBe(4)
  })
  it('saves each pick immediately, shows its origin, and freezes answered lines after Go', async () => {
    const h = harness(v2(), { atDesk: true })
    await h.cards.reconcile(); await h.cards.reconcile()
    await h.tap(h.button('Choose…'))
    await h.tap(h.button('No'))
    expect(h.record.periods[0]?.runs[0]?.answer?.choices).toEqual({ rounds: 0 })
    expect(h.last().text).not.toContain('Nothing is granted until this answer.')
    h.record = away(h.record)
    await h.cards.reconcile()
    await h.tap(h.button('‹ Back'))
    expect(h.last().keyboard?.flat().some(button => button.text === '● No')).toBe(false)
  })

  it('keeps the earlier authority visible when a run revises its card to needs nothing', async () => {
    const h = harness(v2(), { atDesk: true })
    const answered = answerGrant(h.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 2 }, via: 'app', operationKey: 'earlier-nothing', expectedRevision: h.record.revision }, T1)
    expect(answered.outcome).toBe('granted'); h.record = answered.record
    await h.cards.reconcile()
    h.record = askGrant(h.record, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card: { title: 'Nothing now', scope: 'Synthetic scope', nothing: true, terms: [] } }, T1).record
    await h.cards.reconcile()
    expect(h.last().text).toContain('Earlier answer still holds: 2 rounds per boundary')
  })
  it('shows the prior grant still in force when a lower proposal has no answer', async () => {
    const h = harness(v2(), { atDesk: true })
    const answered = answerGrant(h.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 3 }, via: 'app', operationKey: 'first', expectedRevision: h.record.revision }, T1)
    expect(answered.outcome).toBe('granted')
    h.record = answered.record
    h.record = ask(h.record, [{ kind: 'rounds', proposed: 2, reason: 'Less work' }])
    await h.cards.reconcile(); await h.cards.reconcile()
    expect(h.last().text).toContain('Earlier answer still holds: 3 rounds per boundary. A new answer replaces it.')
    expect(h.last().text).toContain('proposed 2 · not answered')
  })
  it('rejects old v2 tokens with zero record writes, including old-card tokens retired on re-ask', async () => {
    const h = harness(v2(), { atDesk: true })
    await h.cards.reconcile(); await h.cards.reconcile()
    const token = h.button('Grant all')
    h.record = ask(h.record, [{ kind: 'rounds', proposed: 4, reason: 'changed' }])
    await h.cards.reconcile()
    const before = JSON.stringify(h.record)
    await h.tap(token)
    expect(JSON.stringify(h.record)).toBe(before)
    expect(h.answers).toHaveLength(0)
  })
})

describe('phone sign-in retries and night allowance receipts (Epic 131)', () => {
  const modern = () => startDeparture({ ...EMPTY_GRANT_RECORD, version: 2, offers: [] },
    { source: 'app', agentSessionId: null, periodId: 'p-1' }, 'back', T0).record
  const login = { id: 'login', kind: 'access', name: 'Sample sign-in', command: 'gh auth login', reason: 'The session lacks access' }
  const pin = { go: 'a'.repeat(40), commit: 'b'.repeat(40), token: 'c'.repeat(16) }
  const limit = { id: 'limit', kind: 'limit', project: '/sample', epic: 7, name: 'rechecks', from: 4, to: 6, reason: 'One check is ahead' }

  it('sends a compact overview and shows the exact checkout next to each individual Yes', async () => {
    const project = '/' + 'x'.repeat(485) + '&<>'
    const terms = Array.from({ length: 8 }, (_, index) => ({ ...limit, id: `raise-${index}`, name: `limit_${index}`, project }))
    const h = harness(away(ask(modern(), terms)))
    await h.cards.reconcile()
    expect(h.sent[0]?.text).toContain('Choose a raise to see its checkout.')
    expect(h.sent[0]?.text).not.toContain(project.slice(0, -3))
    await h.tap(h.button('Choose…'))
    for (let index = 0; index < terms.length; index += 1) {
      expect(h.last().text).toContain(`Raise limit ${index} for Epic 7 from 4 to 6 in ${project.slice(0, -3)}&amp;&lt;&gt;`)
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      await h.tap(h.button(index === terms.length - 1 ? 'Yes' : 'No'))
    }
    expect(h.answers.at(-1)).toMatchObject({ choices: { 'raise-7': 'yes' }, lineId: 'raise-7' })
    h.record = followAwayChange(h.record, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    await h.cards.reconcile()
    expect(h.last().keyboard).toBeNull()
    expect(h.edits.every(edit => edit.text.length <= TELEGRAM_TEXT_LIMIT)).toBe(true)
  })

  it('keeps the reason and all fitting contradictions in one phone send or edit', async () => {
    const despiteFacts = Array.from({ length: 33 }, (_, index) => `Checks at 7.${index + 1}: 4 of 4 used & verified 😀`)
    const card = { ...parsed(), nothing: true, terms: [], nothingReason: 'Review finished <before> leaving', despiteFacts }
    expect(grantNothingFitsPhone(card)).toBe(true)
    const escaped = Array.from({ length: 33 }, (_, index) =>
      `rechecks at 7.${index + 1}: 4 of 4 used · confirmed counts & & & & ${'verified '.repeat(3)}`)
    expect(grantNothingFitsPhone({ ...card, nothingReason: '&'.repeat(300), despiteFacts: escaped })).toBe(false)
    expect(grantNothingFitsPhone({ ...card, despiteFacts: Array.from({ length: 256 }, () => 'One full checked fact with a boundary and a count') })).toBe(false)
    for (const existing of [modern(), ask(modern())]) {
      const h = harness(existing)
      if (existing.periods[0]?.runs.length) await h.cards.reconcile()
      h.record = askGrant(h.record, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card }, T1).record
      await h.cards.reconcile()
      expect(h.sent).toHaveLength(1)
      expect(h.last().text).toContain('Review finished &lt;before&gt; leaving')
      for (const fact of despiteFacts) expect(h.last().text).toContain(fact.replace('&', '&amp;'))
      expect(h.last().text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      expect(h.last().keyboard).toBeNull()
    }
  })

  it('keeps Check again usable on an answered card after Go', async () => {
    const time = { now: T1 }
    const h = harness(away(ask(modern(), [login])), time)
    await h.cards.reconcile()
    await h.tap(h.button('Done'))
    expect(h.last().text).toContain('Waiting for the agent’s check')
    const target = { sessionId: 's-builder', incarnation: 'inc', runId: 'run-80', item: 'login', attempt: 'attempt-1' }
    let changed = changeGrantAccess({ state: 'read', record: h.record }, { kind: 'claim', target }, T1)
    changed = changeGrantAccess({ state: 'read', record: changed.record }, {
      kind: 'report', target: { ...target, outcome: 'fails', cause: 'expired' }
    }, T1)
    expect(changed.outcome).toBe('recorded')
    h.record = changed.record
    await h.cards.reconcile()
    expect(h.last().text).toMatch(/still fails.*expired/iu)
    await h.tap(h.button('Check again'))
    expect(h.toasts.at(-1)).toBe('Check requested.')
    expect(h.record.periods[0]?.runs[0]?.access?.[0]).toMatchObject({ id: 'attempt-2', outcome: null })

    time.now = '2026-10-19T19:41:01.000Z'
    await h.cards.reconcile()
    expect(h.last().text).toContain('Not checked')
    await h.tap(h.button('Check again'))
    expect(h.record.periods[0]?.runs[0]?.access?.[0]?.id).toBe('attempt-3')
  })

  it('refreshes a closed phone line when a previously marked write settles after Back', async () => {
    const initial = ask(modern(), [limit])
    const card = initial.periods[0]!.runs[0]!.card
    const record = { ...initial, periods: [{ ...initial.periods[0]!, runs: [{ ...initial.periods[0]!.runs[0]!,
      card: { ...card, terms: [{ ...limit, kind: 'limit' as const, pin }] } }] }] }
    const h = harness(away(record))
    await h.cards.reconcile()
    expect(h.last().text).toContain('Epic 7 from 4 to 6 in /sample')
    await h.tap(h.button('Yes'))
    const marked = markGrantLimit({ state: 'read', record: h.record }, AWAY, {
      runId: 'run-80', sessionId: 's-builder', item: 'limit', useId: 'use'
    }, 'p-1', card.revision, pin, 'apply-op', T1)
    expect(marked.entry).not.toBeNull()
    h.record = followAwayChange(marked.record, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, LATE).record
    await h.cards.reconcile()
    expect(h.last().text).toContain('Already being written')
    h.record = settleGrantLimit({ state: 'read', record: h.record }, 'p-1', marked.entry!.source, { state: 'written', commit: 'd'.repeat(40) }, LATE)!
    await h.cards.reconcile()
    expect(h.last().text).toContain('use bmn plan allow to lower it')
    expect(h.last().keyboard).toBeNull()
  })
})
