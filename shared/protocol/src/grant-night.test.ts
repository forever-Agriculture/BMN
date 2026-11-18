// MODULE: grant-night.test.ts - replay, access and stop report checks for Epic 131
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD } from './away'
import { grantReoffer } from './grant-reoffers'
import {
  EMPTY_GRANT_RECORD, answerGrant, askGrant, changeGrantAccess, followAwayChange, grantAccessStatus,
  grantStatus, grantTermLabel, markGrantLimit, parseGrantCardInput, readGrantRecord, reportGrant,
  settleGrantLimit, startDeparture, type GrantRecord
} from './grant'

const at = '2026-11-18T20:00:00.000Z'
const later = '2026-11-18T20:00:30.000Z'
const afterTimeout = '2026-11-18T20:01:01.000Z'
const pin = { go: 'a'.repeat(40), commit: 'b'.repeat(40), token: 'c'.repeat(16) }
const limit = { id: 'limit', kind: 'limit', project: '/sample', epic: 7, name: 'rechecks', from: 4, to: 6, reason: 'One check is ahead', pin }
const access = { id: 'login', kind: 'access', name: 'Sample sign-in', command: 'gh auth login', reason: 'The authorization expired' }
const runId = 'run'
const sessionId = 'session'
const read = (record: GrantRecord) => ({ state: 'read' as const, record })
const back = { state: 'back' as const, periodId: null }

function asked(term: unknown) {
  const base = startDeparture({ ...EMPTY_GRANT_RECORD, version: 2, offers: [] }, { source: 'app', agentSessionId: null, periodId: 'period' }, 'back', at).record
  const parsed = parseGrantCardInput({ title: 'Sample', scope: 'One story', terms: [term] })
  if ('problem' in parsed) throw Error(parsed.problem)
  return askGrant(base, { runId, sessionId, agentCli: 'claude', card: parsed.card }, at).record
}
function answer(record: GrantRecord, item: string, choice: string, accessAttemptId?: string, now = at) {
  return answerGrant(record, { runId, periodId: 'period', cardRevision: 1, expectedRevision: record.revision,
    lineId: item, choices: { [item]: choice }, via: 'app', operationKey: `answer-${record.revision}`, ...(accessAttemptId ? { accessAttemptId } : {}) }, now)
}
const request = { runId, sessionId, useId: 'use', item: 'limit' }
const target = { runId, sessionId, item: 'login', incarnation: 'one', attempt: 'attempt-1' }
const mark = (record: GrantRecord, revision = 1) => markGrantLimit(read(record), back, request, 'period', revision, pin, 'operation', at)

describe('night-only lines', () => {
  it('retains each acknowledged fact and refuses an unreadable stored contradiction list', () => {
    const record = asked(limit)
    for (const length of [0, 32, 33, 256, 257]) {
      const despiteFacts = Array.from({ length }, (_, index) => `checks at 7.${index + 1}: 4 of 4 used`)
      const card = { title: 'Sample', scope: 'Fixture', nothing: true, terms: [], nothingReason: 'No further checks', despiteFacts }
      const nothing = askGrant(record, { runId, sessionId, agentCli: 'claude', card }, later).record
      const parsed = readGrantRecord(JSON.stringify(nothing))
      if (length === 257) {
        expect(parsed.state).toBe('unknown')
      } else {
        expect(parsed.state === 'read' && parsed.record.periods[0]?.runs[0]?.card.despiteFacts).toEqual(despiteFacts)
      }
    }
  })

  it('labels the exact checkout and requires an explicit yes on the raise itself', () => {
    const initial = asked(limit)
    const period = initial.periods[0]!
    const term = period.runs[0]!.card.terms[0]!
    expect(grantTermLabel(term)).toContain('Epic 7 from 4 to 6 in /sample')
    const bulk = answerGrant(initial, { runId, periodId: 'period', cardRevision: 1, expectedRevision: initial.revision,
      choices: { limit: 'yes' }, via: 'telegram', operationKey: 'bulk' }, at)
    expect(bulk).toMatchObject({ outcome: 'refused', reason: 'invalid' })
    expect(mark(bulk.record).entry).toBeNull()
  })

  it('only reoffers ordinary grants from a mixed card with previous Yes and Done', () => {
    const terms = [limit, access, { kind: 'rounds', proposed: 3, reason: 'One more boundary' }]
    const card = parseGrantCardInput({ title: 'Mixed old and new choices', scope: 'Synthetic', terms })
    if ('problem' in card) throw Error(card.problem)
    const initial = asked(limit)
    const period = initial.periods[0]!
    const next = askGrant(initial, { runId, sessionId, agentCli: 'claude', card: card.card }, at).record
    const run = next.periods[0]!.runs[0]!
    const withOffer = { ...next, offers: [{ runId, title: run.title, endedAt: at, answer: {
      cardRevision: run.card.revision, terms: run.card.terms, choices: { limit: 'yes' as const, login: 'done' as const, rounds: 3 as const },
      at, via: 'app' as const, operationKey: 'earlier'
    } }] }
    expect(grantReoffer(withOffer, period, run)?.choices).toEqual({ rounds: 3 })
  })

  it('rejects credential-shaped text throughout the new card inputs before storage', () => {
    const canary = 'ghp_' + 'Z'.repeat(36)
    const tests = [
      { title: canary }, { scope: canary },
      { terms: [{ ...access, name: canary }] }, { terms: [{ ...access, reason: canary }] },
      { terms: [{ ...access, command: `gh auth login --hostname ${canary}` }] },
      { terms: [{ ...limit, reason: canary }] }, { terms: [{ ...limit, project: `/fixture/${canary}` }] }
    ]
    for (const field of tests) {
      const result = parseGrantCardInput({ title: 'Fixture', scope: 'Synthetic scope', terms: [access], ...field })
      expect(result).toHaveProperty('problem')
      expect(JSON.stringify(result)).not.toContain(canary)
    }
  })

  it('locks one approved revision and keeps the first result in readback', () => {
    const approved = answer(asked(limit), 'limit', 'yes').record
    const marked = mark(approved)
    expect(marked.entry?.source).toContain('Yes to "Raise rechecks for Epic 7 from 4 to 6" in the window')
    expect(mark(marked.record).entry).toBeNull()
    const changed = answer(marked.record, 'limit', 'no')
    expect(changed.outcome).toBe('refused')
    if (changed.outcome !== 'refused') throw Error('expected refusal')
    expect(changed.detail).toMatch(/already being written/u)
    const settled = settleGrantLimit(read(marked.record), 'period', marked.entry!.source, { state: 'written', commit: 'd'.repeat(40) }, later)!
    const reread = readGrantRecord(JSON.stringify(settled))
    expect(reread.state).toBe('read')
    if (reread.state === 'read') expect(reread.record.periods[0]?.limitApplies?.[0]?.state).toBe('written')
    expect(grantStatus(read(settled), back, runId).active).toBe(false)
  })

  it('refuses a superseded or denied card and reopens a failed write', () => {
    const initial = asked(limit)
    expect(mark(answer(initial, 'limit', 'no').record).entry).toBeNull()
    const approved = answer(initial, 'limit', 'yes').record
    const parsed = parseGrantCardInput({ title: 'Sample', scope: 'Changed scope', terms: [limit] })
    if ('problem' in parsed) throw Error(parsed.problem)
    const updated = askGrant(approved, { runId, sessionId, agentCli: 'claude', card: parsed.card }, later).record
    expect(mark(updated, 2).entry).toBeNull()
    const marked = mark(approved)
    const reopened = settleGrantLimit(read(marked.record), 'period', marked.entry!.source, { state: 'interrupted' }, later)!
    expect(mark(reopened).entry).not.toBeNull()
  })

  it('claims one check, accepts fixed words, and fences a late report after Check again', () => {
    const initial = asked(access)
    const ready = answer(initial, 'login', 'done', target.attempt).record
    expect(grantStatus(read(ready), back, runId).active).toBe(false)
    const claimed = changeGrantAccess(read(ready), { kind: 'claim', target }, at)
    expect(claimed.outcome).toBe('recorded')
    expect(changeGrantAccess(read(claimed.record), { kind: 'claim', target }, at).outcome).toBe('refused')
    const failed = changeGrantAccess(read(claimed.record), { kind: 'report', target: { ...target, outcome: 'fails', cause: 'expired' } }, later)
    expect(grantAccessStatus(failed.record.periods[0]!.runs[0]!, 'login', new Date(later)).words).toContain('sign-in expired')
    const retry = answer(failed.record, 'login', 'done', 'attempt-2', later).record
    expect(changeGrantAccess(read(retry), { kind: 'report', target: { ...target, outcome: 'works', cause: null } }, later).outcome).toBe('refused')
    expect(grantAccessStatus(claimed.record.periods[0]!.runs[0]!, 'login', new Date(afterTimeout)).words).toBe('Not checked')
  })

  it('accepts stop reports only during the matching Away period', () => {
    const away = { ...EMPTY_AWAY_RECORD, state: 'away' as const, periodId: 'period', since: at }
    const base = followAwayChange({ ...EMPTY_GRANT_RECORD, version: 2, offers: [] }, EMPTY_AWAY_RECORD,
      away, { to: 'away', source: 'app', outcome: 'changed' }, at).record
    const issue = { kind: 'stopped' as const, cause: 'access' as const, text: 'The login is pending', runId, sessionId }
    expect(reportGrant(read(base), issue, later, back).outcome).toBe('refused')
    const result = reportGrant(read(base), issue, later, { state: 'away', periodId: 'period' })
    expect(result.outcome).toBe('recorded')
    expect(result.record.periods[0]?.reports[0]).toMatchObject({ cause: 'access', at: later })
    expect(reportGrant(read(result.record), { ...issue, periodId: 'earlier-departure' }, later, away).outcome).toBe('refused')
    const prompt = reportGrant(read(result.record), { ...issue, cause: 'prompt', text: 'Approval prompt open' }, at, away)
    const again = reportGrant(read(prompt.record), { ...issue, periodId: 'period' }, afterTimeout, away)
    expect(again.outcome).toBe('recorded')
    expect(again.record.periods[0]?.reports.at(-1)).toMatchObject({ cause: 'access', at: afterTimeout })
  })

  it('keeps the exact sign-in that was waiting at Go even if the run asks again afterward', () => {
    const opening = { ...EMPTY_AWAY_RECORD, state: 'away' as const, periodId: 'period', since: later }
    const start = (record: GrantRecord) => followAwayChange(record, EMPTY_AWAY_RECORD,
      opening, { to: 'away', source: 'app', outcome: 'changed' }, later).record
    const requested = asked(access)
    expect(start(answer(requested, 'login', 'done', target.attempt).record).periods[0]?.loginsAtDeparture).toBeUndefined()
    const parsed = parseGrantCardInput({ title: 'Sample renamed', scope: 'One story', terms: [{ ...access, name: 'Another sign-in' }] })
    if ('problem' in parsed) throw Error(parsed.problem)
    const updated = askGrant(start(requested), { runId, sessionId, agentCli: 'claude', card: parsed.card }, afterTimeout)
    const reread = readGrantRecord(JSON.stringify(updated.record))
    expect(reread.state === 'read' && reread.record.periods[0]?.loginsAtDeparture).toEqual([
      { runId, item: 'login', title: 'Sample', name: 'Sample sign-in' }
    ])
  })
})
