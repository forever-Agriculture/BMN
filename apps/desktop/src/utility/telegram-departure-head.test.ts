// MODULE: telegram-departure-head.test.ts - the shared head, restart recovery, stale taps and zero-selected departures
import { describe, expect, it, vi } from 'vitest'
import { TelegramConnectorError } from './telegram-connector'
import { answerGrant, askGrant, EMPTY_GRANT_RECORD, newDepartureCollection, ownerGrantView, selectDepartureSessions, setDepartureCollection, startDeparture, type OwnerDepartureInput, type GrantRecord } from '@bmn/protocol'
import { departureHeadText, TelegramDepartureHead } from './telegram-departure-head'
const AT = '2026-11-17T19:00:00.000Z'
function harness(selected = true, options: { sendError?: Error; loseReceipt?: boolean } = {}) {
  const sessions = selectDepartureSessions(selected ? [{ sessionId: 's', incarnationId: 'i', name: 'Synthetic', agent: 'claude', lastEventAt: AT }] : [], AT)
  let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'one', collection: newDepartureCollection(sessions, AT) }, 'back', AT).record
  const messages: string[] = [], edits: Array<{ text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> | null }> = [], actions: OwnerDepartureInput[] = []
  let connected = true
  const view = () => ownerGrantView({ state: 'read', record })
  const connector = { sendMessage: async (text: string) => { if (options.sendError) throw options.sendError; messages.push(text); return { messageId: 100 + messages.length } }, editMessageText: async (_id: number, text: string, options: { keyboard: typeof edits[number]['keyboard'] }) => { edits.push({ text, keyboard: options.keyboard }) }, answerCallbackQuery: async () => {} }
  const make = () => new TelegramDepartureHead({ connector: () => connected ? connector : undefined, view, now: () => new Date(AT),
    action: async input => { actions.push(input); return { outcome: input.expectedRevision === record.revision ? 'changed' : 'stale', view: view(), away: { state: 'back', revision: 0, periodId: null, since: null, endedAt: null, source: null, endedBy: null, note: null, summaryShownAt: null, agentSessionId: null }, detail: null } },
    keep: async (periodId, phone) => { if (options.loseReceipt && phone.state === 'sent') throw Error('synthetic crash before receipt'); const period = record.periods.find(period => period.periodId === periodId)!; record = setDepartureCollection(record, periodId, { ...period.collection!, phone }) }
  })
  return { make, messages, edits, actions, view, set connected(value: boolean) { connected = value }, get record() { return record }, set record(value: GrantRecord) { record = value } }
}
describe('Before you go head', () => {
  it('retries a definite rejected send after five seconds, without a recursive send loop', async () => {
    vi.useFakeTimers()
    const options: { sendError?: Error } = { sendError: new TelegramConnectorError('http', 'synthetic rejected', 400) }
    const h = harness(true, options), head = h.make()
    try {
      await head.reconcile()
      expect(h.view().period?.collection?.phone.state).toBe('unreachable')
      delete options.sendError
      await head.reconcile()
      expect(h.messages).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.messages).toHaveLength(1)
      expect(h.view().period?.collection?.phone.state).toBe('sent')
    } finally { head.dispose(); vi.useRealTimers() }
  })
  it.each([new TelegramConnectorError('network', 'ambiguous synthetic send'), new TelegramConnectorError('http', 'malformed success', 200)])('never repeats an ambiguously completed send: %s', async sendError => {
    const options: { sendError?: Error } = { sendError }
    const h = harness(true, options), head = h.make()
    await head.reconcile()
    expect(h.view().period?.collection?.phone.state).toBe('uncertain')
    delete options.sendError
    await head.reconcile(); head.dispose(); await h.make().reconcile()
    expect(h.messages).toHaveLength(0)
  })
  it('keeps a success with a lost receipt uncertain across restart instead of sending it twice', async () => {
    const options = { loseReceipt: true }
    const h = harness(true, options), head = h.make()
    await head.reconcile()
    expect(h.messages).toHaveLength(1)
    expect(h.view().period?.collection?.phone.state).toBe('uncertain')
    options.loseReceipt = false; head.dispose(); await h.make().reconcile()
    expect(h.messages).toHaveLength(1)
  })
  it('recovers a definitely rejected automatic notice without claiming it was delivered', async () => {
    vi.useFakeTimers()
    const options: { sendError?: Error } = {}
    const h = harness(true, options), head = h.make()
    try {
      await head.reconcile()
      h.record = { ...h.record, periods: h.record.periods.map(period => ({ ...period, state: 'away', awayAt: AT, collection: { ...period.collection!, autoStartedAt: AT } })) }
      options.sendError = new TelegramConnectorError('http', 'synthetic automatic rejection', 400)
      await head.reconcile()
      expect(h.view().period?.collection?.phone.autoAnnounced).toBe(false)
      delete options.sendError
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.messages.filter(text => text.startsWith('Away started by itself'))).toHaveLength(1)
      expect(h.view().period?.collection?.phone.autoAnnounced).toBe(true)
    } finally { head.dispose(); vi.useRealTimers() }
  })
  it('sends once, edits counts with Go, and recovers on the same message after a restart', async () => {
    const h = harness(), first = h.make(); await first.reconcile()
    expect(h.messages).toHaveLength(1)
    expect(h.edits.at(-1)?.text).toContain('Asked 1 session. 1 still answering.')
    expect(h.edits.at(-1)?.keyboard?.[0]?.map(button => button.text)).toEqual(['Go now', 'Not leaving'])
    first.dispose(); await h.make().reconcile()
    expect(h.messages).toHaveLength(1)
    expect(h.view().period?.collection?.phone.messageId).toBe(101)
  })
  it('carries the revision actually displayed on a stale tap without modifying a record', async () => {
    const h = harness(), head = h.make(); await head.reconcile()
    const token = h.edits.at(-1)!.keyboard![0]![0]!.callback_data
    const shown = h.record.revision
    h.record = { ...h.record, revision: shown + 1 }
    const before = JSON.stringify(h.record)
    await head.tap({ updateId: 1, callbackId: 'stale', chatId: 1, fromUserId: 1, messageId: 101, data: token })
    expect(h.actions[0]?.expectedRevision).toBe(shown)
    expect(JSON.stringify(h.record)).toBe(before)
  })
  it('does not send a head for an immediate zero-selected departure', async () => {
    const h = harness(false); await h.make().reconcile(); expect(h.messages).toEqual([])
  })
  it('keeps the window usable when disconnected and sends once on recovery', async () => {
    const h = harness(); h.connected = false; const head = h.make(); await head.reconcile()
    expect(h.view().period?.collection?.phone.state).toBe('unreachable')
    h.connected = true; await head.reconcile(); await head.reconcile()
    expect(h.messages).toHaveLength(1)
  })
  it('shows what an unreturned run was granted without restoring its authority', () => {
    const h = harness()
    h.record.offers = [{ runId: 'earlier', title: 'Earlier synthetic run', endedAt: AT, answer: { cardRevision: 1, terms: [{ id: 'rounds', kind: 'rounds', proposed: 3, reason: 'Synthetic' }], choices: { rounds: 2 }, at: AT, via: 'app', operationKey: 'earlier' } }]
    const text = departureHeadText(h.view(), new Date(AT))
    expect(text).toContain('Earlier synthetic run')
    expect(text).toContain('2 rounds per boundary')
    expect(text).toContain('has not asked again')
    expect(text).toContain('nothing granted')
    expect(h.record.periods[0]!.runs).toHaveLength(0)
    h.record.offers = Array.from({ length: 32 }, (_, index) => ({ ...h.record.offers![0]!, runId: `prior-${index}`, title: '<'.repeat(120) }))
    expect(departureHeadText(h.view(), new Date(AT)).length).toBeLessThanOrEqual(4096)
  })
  it('stops describing repeat choices as ungranted after the owner saves them', () => {
    const h = harness()
    const terms = [{ id: 'rounds' as const, kind: 'rounds' as const, proposed: 3, reason: 'Synthetic' }]
    h.record.offers = [{ runId: 'run', title: 'Synthetic', endedAt: AT, answer: { cardRevision: 1, terms, choices: { rounds: 2 }, at: AT, via: 'app', operationKey: 'prior' } }]
    h.record = askGrant(h.record, { runId: 'run', sessionId: 's', agentCli: 'claude', card: { title: 'Synthetic', scope: 'Synthetic', nothing: false, terms } }, AT).record
    const answered = answerGrant(h.record, { periodId: 'one', runId: 'run', cardRevision: 1, choices: { rounds: 2 }, expectedRevision: h.record.revision, operationKey: 'new-answer', via: 'app' }, AT)
    expect(answered.outcome).toBe('granted'); h.record = answered.record
    expect(departureHeadText(h.view(), new Date(AT))).not.toContain('Nothing is granted before your tap')
  })
  it('bounds the head even with 64 long session labels and reasons', () => {
    const h = harness(); const period = h.record.periods[0]!
    period.collection!.sessions = Array.from({ length: 64 }, (_, index) => ({ ...period.collection!.sessions[0]!, sessionId: `s${index}`, name: '<'.repeat(100), reason: '&'.repeat(100), selected: false }))
    expect(departureHeadText(h.view(), new Date(AT)).length).toBeLessThanOrEqual(4096)
  })
})
