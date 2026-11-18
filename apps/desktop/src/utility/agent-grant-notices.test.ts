// MODULE: agent-grant-notices.test.ts - the bounded pre-Go selection never suppresses the existing post-Go hook handover
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_GRANT_RECORD, newDepartureCollection, startDeparture, type GrantPeriod } from '@bmn/protocol'
import { GrantDepartureNotices } from './agent-grant-notices'
const AT = '2026-11-17T19:00:00.000Z'
describe('late departure hook handover', () => {
  it.each(['claude', 'codex'])('hands %s a post-Go notice after both selected and zero-selected departures', agent => {
    for (const selected of [false, true]) {
      const period = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'one', collection: newDepartureCollection([], AT) }, 'back', AT).record.periods[0]!
      if (selected) period.collection!.sessions = [{ sessionId: 'earlier', incarnationId: 'i', name: 'Earlier synthetic', agent: 'claude', lastEventAt: AT, selectedAt: AT, selected: true, reason: null, toldAt: AT, via: 'hook', claim: null }]
      period.state = 'away'; period.awayAt = AT
      for (const [event, source] of [['SessionStart', 'startup'], ['PostToolUse', null]] as const) {
        const mark = vi.fn(async () => {})
        const tracker = new GrantDepartureNotices({ now: () => new Date(AT), mark })
        const observation = { sessionId: 'late', incarnationId: 'new', agent, event, source, turn: { conversation: 'synthetic-late', nested: false } }
        expect(tracker.answer(observation, period)).toContain('bmn grant ask')
        expect(tracker.answer(observation, period)).toBeNull()
        expect(mark).toHaveBeenCalledExactlyOnceWith('one', 'late')
        expect(tracker.answer({ ...observation, sessionId: 'nested', turn: { conversation: 'child', nested: true } }, period)).toBeNull()
        const leaving: GrantPeriod = { ...period, state: 'leaving' }
        expect(new GrantDepartureNotices({ now: () => new Date(AT), mark }).answer(observation, leaving)).toBeNull()
      }
    }
  })
})
