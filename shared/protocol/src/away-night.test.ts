// MODULE: away-night.test.ts - Story 113.6 AC2-AC3: the night's account from recorded ticks: woken, skipped, missed, unknown
import { describe, expect, it } from 'vitest'
import { AWAY_WAKE_REASON_CODES, AWAY_WAKE_REASONS, awayNightAccount, awayNightLines, awayWakeReasonCode, type AwayWakeDecisionRow, type AwayWakeTick } from './away-night'

const T = Date.parse('2026-11-08T22:00:00.000Z')
const HOUR = 3_600_000
const EVERY = 2 * HOUR
const at = (ms: number): string => new Date(ms).toISOString()
const tick = (n: number, over: Partial<AwayWakeTick> = {}): AwayWakeTick => ({ periodId: 'p1', tick: n, at: at(T + n * EVERY), processStartedAt: at(T - HOUR), state: 'swept', sessionsSeen: 1, ...over })
const decision = (n: number, sessionId: string, over: Partial<AwayWakeDecisionRow> = {}): AwayWakeDecisionRow => ({
  periodId: 'p1', tick: n, at: at(T + n * EVERY), sessionId, incarnationId: `inc-${sessionId}`, app: 'claude', foreground: null, generation: 1,
  prompt: null, outcome: 'skipped', reason: 'quiet', ...over
})
const night = (ticks: AwayWakeTick[], decisions: AwayWakeDecisionRow[], sessions: string[] = [], hours = 8) => awayNightAccount({
  periodId: 'p1', since: at(T), until: at(T + hours * HOUR), everyMs: EVERY, ticks, decisions, sessions: sessions.map((sessionId) => ({ sessionId, app: 'codex' }))
})

describe('the night\'s account (Story 113.6 AC2)', () => {
  it('reads each session as woken, correctly skipped with its reason, missed while eligible, or unknown', () => {
    const account = night([tick(1), tick(2), tick(3), tick(4)], [
      decision(1, 'woke', { outcome: 'typed', reason: null, foreground: true, prompt: 'idle' }),
      decision(1, 'rested', { reason: 'quiet' }), decision(2, 'rested', { reason: 'request-open' }),
      decision(1, 'lost', { reason: 'prompt-busy', foreground: true, prompt: 'busy' }), decision(2, 'lost', { reason: 'quiet' }),
      decision(3, 'moved-on', { reason: 'reported-again', foreground: null })
    ], ['woke', 'rested', 'lost', 'moved-on', 'never-seen'], 9)
    expect(account.woken).toEqual([{ sessionId: 'woke', app: 'claude', reason: null, at: at(T + EVERY) }])
    expect(account.skipped.map((row) => [row.sessionId, row.reason])).toEqual([['rested', 'request-open'], ['moved-on', 'reported-again']])
    expect(account.missed).toEqual([{ sessionId: 'lost', app: 'claude', reason: 'prompt-busy', at: at(T + EVERY) }])
    expect(account.unknown).toEqual([{ sessionId: 'never-seen', app: 'codex', reason: null, at: null }])
    expect(account.ticks).toEqual({ expected: 4, swept: 4 })
    expect(account.unknownSpans).toEqual([])
  })

  it('a session woken on a later tick is woken, not missed', () => {
    const account = night([tick(1), tick(2)], [decision(1, 's', { reason: 'no-screen', prompt: 'none', foreground: true }), decision(2, 's', { outcome: 'typed', reason: null })])
    expect(account.woken.map((row) => row.sessionId)).toEqual(['s'])
    expect(account.missed).toEqual([])
  })

  it('names every code the wake can give, and only the last checks it could not finish count as missed', () => {
    expect(AWAY_WAKE_REASON_CODES.filter((code) => AWAY_WAKE_REASONS[code].missed)).toEqual(['not-foreground', 'no-screen', 'prompt-busy', 'unreadable', 'other'])
    expect(AWAY_WAKE_REASON_CODES.filter((code) => AWAY_WAKE_REASONS[code].stage === 'early').every((code) => !AWAY_WAKE_REASONS[code].missed)).toBe(true)
    const texts: Array<[string, string]> = [
      ['no hook event since the owner left', 'no-event-since-away'], ['other sessions are not woken (no recorded idle prompt)', 'app-not-woken'],
      ['its latest event is PreToolUse, not a finished turn', 'not-finished-turn'], ['its latest event is session.idle from subagent, not its own finished turn', 'child-or-stop'],
      ['its OpenCode runs an earlier BMN plugin, which reports the owner\'s stop as a finished turn', 'plugin-earlier'],
      ['BMN did not see this run finish a turn', 'finish-unknown'], ['its turn finished less than 15 minutes ago', 'quiet'],
      ['another request of it is open', 'request-open'], ['the owner is no longer away in this period', 'owner-back'], ['its run changed', 'run-changed'],
      ['its agent reported again', 'reported-again'], ['its requests changed', 'requests-changed'], ['its agent is not in the foreground', 'not-foreground'],
      ['no screen to read', 'no-screen'], ['its prompt is not empty and idle', 'prompt-busy'], ['unreadable state', 'unreadable'], ['something new', 'other']
    ]
    for (const [text, code] of texts) expect(awayWakeReasonCode(text), text).toBe(code)
  })
})

describe('unknown hours (Story 113.6 AC3)', () => {
  it('a restart during the night reads its hours unknown, never woken or missed', () => {
    // BMN ran ticks 1 and 2, was restarted after 2, so tick 3 (its first tick) was never acted on; tick 4 ran in the new process.
    const account = night([tick(1), tick(2), tick(4, { processStartedAt: at(T + 5 * HOUR) })],
      [decision(1, 's'), decision(2, 's'), decision(4, 's', { outcome: 'typed', reason: null })], ['s'], 9)
    expect(account.unknownSpans).toEqual([{ from: at(T + 3 * EVERY), to: at(T + 4 * EVERY), why: 'restart' }])
    expect(account.ticks).toEqual({ expected: 4, swept: 3 })
    expect(account.woken.map((row) => row.sessionId)).toEqual(['s'])
  })

  it('a missing log reads unknown: a night with no tick rows has every hour unknown and no session woken or missed', () => {
    const account = night([], [], ['a', 'b'])
    expect(account.unknownSpans).toEqual([{ from: at(T + EVERY), to: at(T + 8 * HOUR), why: 'not-recorded' }])
    expect(account.woken).toEqual([])
    expect(account.missed).toEqual([])
    expect(account.unknown.map((row) => row.sessionId)).toEqual(['a', 'b'])
  })

  it('a gap within one process (the computer asleep) and an unreadable tick are told apart', () => {
    const account = night([tick(1), tick(2, { state: 'unreadable' }), tick(4)], [decision(1, 's')], ['s'], 9)
    expect(account.unknownSpans).toEqual([
      { from: at(T + 2 * EVERY), to: at(T + 3 * EVERY), why: 'unreadable' },
      { from: at(T + 3 * EVERY), to: at(T + 4 * EVERY), why: 'not-recorded' }
    ])
  })

  it('BMN started after he left: the hours before its first swept tick read as a restart', () => {
    const account = night([tick(3, { processStartedAt: at(T + 5 * HOUR) })], [decision(3, 's')], ['s'])
    expect(account.unknownSpans).toEqual([{ from: at(T + EVERY), to: at(T + 3 * EVERY), why: 'restart' }])
  })

  it('ignores ticks and decisions of another period and ticks past its end', () => {
    const account = night([tick(1), tick(9), tick(1, { periodId: 'p0' })], [decision(1, 'x', { periodId: 'p0', outcome: 'typed', reason: null })], [], 4)
    expect(account.ticks).toEqual({ expected: 1, swept: 1 })
    expect(account.woken).toEqual([])
  })
})

describe('the account as lines', () => {
  it('prints one line per session with names, reasons in words, and the unknown hours', () => {
    const account = night([tick(1), tick(2)], [decision(1, 'a', { outcome: 'typed', reason: null }), decision(1, 'b', { reason: 'prompt-busy' }), decision(2, 'c', { reason: 'quiet' })], ['d'], 8)
    expect(awayNightLines(account, { a: 'BMN', b: 'Q24' })).toEqual([
      `The wake: 2 of 3 ticks swept, from ${at(T)} to ${at(T + 8 * HOUR)}`,
      `woken: BMN (claude) at ${at(T + EVERY)}`,
      'missed while eligible: Q24 (claude): its prompt was not empty and idle',
      'skipped: c (claude): its turn finished less than 15 minutes before',
      'unknown: d (codex): no tick decided it',
      'unknown hours: 04:00–06:00 UTC: BMN swept no tick (the computer asleep, or no record)'
    ])
  })
})
