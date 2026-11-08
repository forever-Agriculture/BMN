// MODULE: away-night-check.test.mjs - Story 113.6 AC4: the live check's comparison of the read-back account with the wake's log
import { describe, expect, it } from 'vitest'
import { AWAY_WAKE_REASONS, awayNightAccount, awayWakeReasonCode } from '../../shared/protocol/dist/away-night.js'
import { logDecisions, nightMismatches } from '../test/away-night-check.mjs'

const T = Date.parse('2026-11-08T22:00:00.000Z')
const EVERY = 240_000
const at = (ms) => new Date(ms).toISOString()
const line = (tick, text) => `${at(T + tick * EVERY + 9_000)} away wake: ${text}`
const LINES = [
  line(1, 'skipped s1 (period p1, tick 1): its turn finished less than 15 minutes ago'),
  line(2, 'typed the wake line into s1 (period p1, tick 2)'),
  line(2, 'skipped s2 (period p1, tick 2): its prompt is not empty and idle'),
  line(3, 'skipped s2 (period p1, tick 3): its latest event is PreToolUse, not a finished turn'),
  line(3, 'skipped s3 (period p0, tick 3): no screen to read'),
  'unrelated line'
]
const decision = (tick, sessionId, over) => ({ periodId: 'p1', tick, at: at(T + tick * EVERY), sessionId, incarnationId: 'i', app: 'claude', foreground: null, generation: 1, prompt: null, outcome: 'skipped', reason: 'quiet', ...over })
const account = (decisions, ticks = [1, 2, 3]) => awayNightAccount({
  periodId: 'p1', since: at(T), until: at(T + 4 * EVERY - 1), everyMs: EVERY,
  ticks: ticks.map((tick) => ({ periodId: 'p1', tick, at: at(T + tick * EVERY), processStartedAt: at(T), state: 'swept', sessionsSeen: 2 })), decisions, sessions: []
})
const RIGHT = [decision(1, 's1'), decision(2, 's1', { outcome: 'typed', reason: null }), decision(2, 's2', { reason: 'prompt-busy' }), decision(3, 's2', { reason: 'not-finished-turn' })]

describe('the night read back against the wake log (Story 113.6 AC4)', () => {
  it('reads the log per session and period', () => {
    expect([...logDecisions(LINES, 'p1').keys()]).toEqual(['s1', 's2'])
    expect(logDecisions(LINES, 'p1').get('s2')).toEqual([{ tick: 2, typed: false, reason: 'its prompt is not empty and idle' }, { tick: 3, typed: false, reason: 'its latest event is PreToolUse, not a finished turn' }])
  })

  it('agrees with an account built from the same decisions', () => {
    expect(nightMismatches(account(RIGHT), LINES, awayWakeReasonCode, AWAY_WAKE_REASONS)).toEqual([])
  })

  it('names a woken session read as skipped, a lost row, a session the log never names and a decided tick read as unknown', () => {
    expect(nightMismatches(account([decision(1, 's1'), ...RIGHT.slice(2)]), LINES, awayWakeReasonCode, AWAY_WAKE_REASONS))
      .toEqual([{ sessionId: 's1', account: { state: 'skipped', reason: 'quiet' }, log: { state: 'woken', reason: null } }])
    expect(nightMismatches(account(RIGHT.slice(0, 2)), LINES, awayWakeReasonCode, AWAY_WAKE_REASONS))
      .toEqual([{ sessionId: 's2', account: null, log: { state: 'missed', reason: 'prompt-busy' } }])
    expect(nightMismatches(account([...RIGHT, decision(1, 'ghost')]), LINES, awayWakeReasonCode, AWAY_WAKE_REASONS))
      .toEqual([{ sessionId: 'ghost', account: { state: 'skipped', reason: 'quiet' }, log: null }])
    const gap = nightMismatches(account(RIGHT, [1, 2]), LINES, awayWakeReasonCode, AWAY_WAKE_REASONS)
    expect(gap).toEqual([
      { tick: 3, account: { from: at(T + 3 * EVERY), to: at(T + 4 * EVERY - 1), why: 'not-recorded' }, log: 'decided' },
      { ticks: { expected: 3, swept: 2 }, log: 3 }
    ])
  })
})
