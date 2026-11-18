// MODULE: grant-reoffers.test.ts - changes of target, count, SHA or exact text never inherit an earlier grant
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD } from './away'
import { answerGrant, askGrant, EMPTY_GRANT_RECORD, followAwayChange, grantStatus, openGrantPeriod, parseGrantCardInput, startDeparture, type GrantRecord } from './grant'
import { grantNotAskedAgain, grantReoffer } from './grant-reoffers'

const AT = '2026-11-17T19:00:00.000Z'
const BACK = '2026-11-17T20:00:00.000Z'
const NEXT = '2026-11-17T20:30:00.000Z'
const terms = [
  { id: 'merge', kind: 'merge', repository: 'example/widgets', pr: 14, headSha: '123abcd', proposed: 'pr', reason: 'checks passed' },
  { id: 'command', kind: 'command', command: 'node tool.mjs', folder: '/synthetic/project', count: 1, proposed: 'yes', reason: 'one check' }
]
function ask(record: GrantRecord, items = terms): GrantRecord {
  const parsed = parseGrantCardInput({ title: 'Synthetic run', scope: 'Synthetic work', terms: items })
  if ('problem' in parsed) throw Error(parsed.problem)
  return askGrant(record, { runId: 'run', sessionId: 'session', agentCli: 'claude', card: parsed.card }, NEXT).record
}
function setup(next = NEXT): GrantRecord {
  let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] },
    { source: 'app', agentSessionId: null, periodId: 'one' }, 'back', AT).record
  record = ask(record)
  record = answerGrant(record, { periodId: 'one', runId: 'run', cardRevision: 1,
    choices: { merge: 'pr', command: 'yes' }, via: 'app', operationKey: 'one' }, AT).record
  const away = { ...EMPTY_AWAY_RECORD, state: 'away' as const, periodId: 'one', since: AT }
  record = followAwayChange(record, away, { ...away, state: 'back', endedAt: BACK }, { to: 'back', source: 'app', outcome: 'changed' }, BACK).record
  return startDeparture(record, { source: 'app', agentSessionId: null, periodId: 'two' }, 'back', next).record
}

describe('the 12-hour offer', () => {
  it('matches each earlier grant to at most one new line', () => {
    const record = ask(setup(), [...terms, { ...terms[1]!, id: 'second-copy' }])
    const period = openGrantPeriod(record)!
    const offer = grantReoffer(record, period, period.runs[0]!)!
    expect(offer.choices).toEqual({ merge: 'pr', command: 'yes' })
    expect(offer.changed).toContain('second-copy')
  })
  it('does not repeat merge authority without a pinned matching head', () => {
    const record = ask(setup())
    const period = openGrantPeriod(record)!
    const old = record.offers?.find(offer => offer.runId === 'run')?.answer ?? record.periods[0]!.runs[0]!.answer!
    const prior = old.terms[0]!
    const current = period.runs[0]!.card.terms[0]!
    if (prior.kind !== 'merge' || current.kind !== 'merge') throw Error('synthetic merge missing')
    Object.assign(prior, { headSha: null, upTo: 2, proposed: 'green' })
    Object.assign(current, { headSha: null, upTo: 2, proposed: 'green' })
    old.choices.merge = 'green'
    const offer = grantReoffer(record, period, period.runs[0]!)!
    expect(offer.choices).not.toHaveProperty('merge')
    expect(offer.changed).toContain('merge')
  })
  it('keeps history separate when a run has not asked, and offers identical lines without granting them', () => {
    const record = setup()
    expect(grantNotAskedAgain(record, openGrantPeriod(record)!)).toEqual([{ runId: 'run', title: 'Synthetic run', at: AT, granted: ['merge PR 14 at 123abcd', 'run node tool.mjs'] }])
    const next = ask(record)
    const period = openGrantPeriod(next)!
    expect(grantNotAskedAgain(next, period)).toEqual([])
    expect(grantReoffer(next, period, period.runs[0]!)).toEqual({ runId: 'run', at: AT, choices: { merge: 'pr', command: 'yes' }, changed: [] })
    expect(grantStatus({ state: 'read', record: next }, EMPTY_AWAY_RECORD, 'run').active).toBe(false)
  })
  it.each([
    [0, { headSha: '765abcd' }], [0, { repository: 'example/other' }], [0, { pr: 15 }],
    [1, { count: 2 }], [1, { command: 'node different.mjs' }], [1, { folder: '/synthetic/other' }]
  ])('does not offer the changed line %j %j', (index, change) => {
    const items = terms.map((term, at) => at === index ? { ...term, ...change } : term)
    const record = ask(setup(), items)
    const period = openGrantPeriod(record)!
    const offer = grantReoffer(record, period, period.runs[0]!)!
    expect(offer.changed).toContain(terms[index]!.id)
    expect(offer.choices).not.toHaveProperty(terms[index]!.id)
  })
  it('ends the offer at 12 hours without erasing the old answer', () => {
    const record = ask(setup('2026-11-18T08:00:00.000Z'))
    const period = openGrantPeriod(record)!
    expect(grantReoffer(record, period, period.runs[0]!)).toBeNull()
    expect(record.periods[0]!.runs[0]!.answer?.choices.merge).toBe('pr')
  })
})
