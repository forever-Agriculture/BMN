import { describe, expect, it } from 'vitest'
import {
  AWAY_NOTE_LIMIT,
  AWAY_OPERATIONS_KEPT,
  EMPTY_AWAY_RECORD,
  agentAwayView,
  applyAwayChange,
  awayDurationWords,
  awayMomentWords,
  awayNoteProblem,
  awayPeriodWords,
  awaySinceWords,
  effectiveAway,
  ownerAwayView,
  parseAwayRecord,
  type AwayChange,
  type AwayRecord
} from './away'

const T0 = '2026-10-14T19:10:00.000Z'
const T1 = '2026-10-15T04:40:00.000Z'
const empty = (): AwayRecord => ({ ...EMPTY_AWAY_RECORD, operations: [] })
const change = (over: Partial<AwayChange>): AwayChange => ({ to: 'away', source: 'app', periodId: 'p-1', ...over })
const changed = (record: AwayRecord, over: Partial<AwayChange>, now = T0): AwayRecord => {
  const result = applyAwayChange(record, change(over), now)
  expect(result.outcome).toBe('changed')
  return result.record
}

describe('applyAwayChange (Story 76.3 AC1)', () => {
  it('starts a period with its own id, since, source and note', () => {
    const away = changed(empty(), { note: 'dentist', source: 'cli' })
    expect(away).toMatchObject({ state: 'away', revision: 1, periodId: 'p-1', since: T0, source: 'cli', note: 'dentist', endedAt: null })
  })

  it('keeps since and note on a repeated away, and replaces only the note when a different one is given', () => {
    const away = changed(empty(), { note: 'dentist' })
    expect(applyAwayChange(away, change({ periodId: 'p-2' }), T1).outcome).toBe('unchanged')
    expect(applyAwayChange(away, change({ note: 'dentist', periodId: 'p-2' }), T1).outcome).toBe('unchanged')
    const replaced = changed(away, { note: 'train', periodId: 'p-2' }, T1)
    expect(replaced).toMatchObject({ since: T0, periodId: 'p-1', note: 'train', revision: 2 })
  })

  it('ends a period once; a repeated back or a back with nothing said changes nothing', () => {
    expect(applyAwayChange(empty(), change({ to: 'back' }), T0).outcome).toBe('unchanged')
    const back = changed(changed(empty(), {}), { to: 'back', source: 'telegram' }, T1)
    expect(back).toMatchObject({ state: 'back', since: T0, endedAt: T1, endedBy: 'telegram', revision: 2, summaryShownAt: null })
    expect(applyAwayChange(back, change({ to: 'back' }), T1).outcome).toBe('unchanged')
  })

  it('a new away after back is a new period that forgets the old note', () => {
    const back = changed(changed(empty(), { note: 'old' }), { to: 'back' }, T1)
    const again = changed(back, { periodId: 'p-2' }, T1)
    expect(again).toMatchObject({ periodId: 'p-2', since: T1, note: null, endedAt: null, endedBy: null, revision: 3 })
  })

  it('refuses a stale revision and accepts the current one', () => {
    const away = changed(empty(), {})
    expect(applyAwayChange(away, change({ to: 'back', expectedRevision: 0 }), T1).outcome).toBe('stale')
    expect(applyAwayChange(away, change({ to: 'back', expectedRevision: 1 }), T1).outcome).toBe('changed')
  })

  it('an agent names the revision it saw and its session; its period records the session', () => {
    expect(applyAwayChange(empty(), change({ source: 'agent', agentSessionId: 's-1' }), T0).outcome).toBe('invalid')
    expect(applyAwayChange(empty(), change({ source: 'agent', expectedRevision: 0 }), T0).outcome).toBe('invalid')
    expect(changed(empty(), { source: 'agent', agentSessionId: 's-1', expectedRevision: 0 }).agentSessionId).toBe('s-1')
    expect(changed(empty(), { agentSessionId: 's-1' }).agentSessionId).toBeNull()
  })

  it('returns the first result for a retried operation key and remembers only the recent keys', () => {
    const away = changed(empty(), { operationKey: 'k-1' })
    expect(away.operations).toEqual([{ key: 'k-1', revision: 1 }])
    const retried = applyAwayChange(away, change({ to: 'back', operationKey: 'k-1' }), T1)
    expect(retried).toEqual({ outcome: 'repeated', record: away })
    let record = away
    for (let index = 0; index < AWAY_OPERATIONS_KEPT + 5; index += 1) {
      record = changed(record, { note: `n${index}`, operationKey: `n-${index}` })
    }
    expect(record.operations).toHaveLength(AWAY_OPERATIONS_KEPT)
    expect(record.operations.some((item) => item.key === 'k-1')).toBe(false)
  })

  it('remembers a key that changed nothing, so replaying it after a later change still changes nothing', () => {
    const noop = applyAwayChange(empty(), change({ to: 'back', operationKey: 'tg-7' }), T0)
    expect(noop.outcome).toBe('unchanged')
    expect(noop.record.operations).toEqual([{ key: 'tg-7', revision: 0, unchanged: true }])
    const away = changed(noop.record, { operationKey: 'k-2' })
    expect(applyAwayChange(away, change({ to: 'back', operationKey: 'tg-7' }), T1)).toEqual({ outcome: 'unchanged', record: away })
    expect(parseAwayRecord(JSON.parse(JSON.stringify(away))).operations).toEqual(away.operations)
  })

  it('refuses an overlong note whole, a note with back and control or direction characters', () => {
    const long = 'x'.repeat(AWAY_NOTE_LIMIT + 1)
    expect(applyAwayChange(empty(), change({ note: long }), T0)).toMatchObject({ outcome: 'invalid', record: empty() })
    expect(applyAwayChange(empty(), change({ note: 'x'.repeat(AWAY_NOTE_LIMIT) }), T0).outcome).toBe('changed')
    const away = changed(empty(), {})
    expect(applyAwayChange(away, change({ to: 'back', note: 'hi' }), T1).outcome).toBe('invalid')
    for (const bad of ['a\nb', 'a\u202eb', 'a\u200bb']) {
      expect(awayNoteProblem(bad)).not.toBeNull()
    }
    expect(awayNoteProblem('Kyiv train, back by 9 \u{1F686}')).toBeNull()
  })
})

describe('parseAwayRecord', () => {
  it('reads back what was stored', () => {
    const back = changed(changed(empty(), { note: 'n', operationKey: 'k' }), { to: 'back' }, T1)
    expect(parseAwayRecord(JSON.parse(JSON.stringify(back)))).toEqual(back)
  })

  it('makes a damaged value the empty record, so BMN goes by the desk input', () => {
    for (const value of [undefined, null, 'away', { version: 2, state: 'away' }, { version: 1, state: 'asleep' }]) {
      expect(parseAwayRecord(value)).toEqual(empty())
    }
    expect(parseAwayRecord({ version: 1, state: 'away', revision: 4, since: 'never', periodId: 'p' })).toEqual({ ...empty(), revision: 4 })
  })
})

describe('views and effective presence (R76-NFR1, NFR3)', () => {
  it('gives an agent the state, since and revision only', () => {
    const away = changed(empty(), { note: 'private', source: 'agent', agentSessionId: 's-1', expectedRevision: 0 })
    expect(agentAwayView(away)).toEqual({ state: 'away', since: T0, revision: 1 })
    expect(ownerAwayView(away)).toMatchObject({ note: 'private', agentSessionId: 's-1' })
    expect(ownerAwayView(away)).not.toHaveProperty('operations')
  })

  it('is away while said away, and the measured value otherwise; back never means watching', () => {
    expect(effectiveAway({ state: 'away' }, false)).toBe(true)
    expect(effectiveAway({ state: 'away' }, null)).toBe(true)
    for (const measured of [true, false, null]) {
      expect(effectiveAway({ state: 'back' }, measured)).toBe(measured)
      expect(effectiveAway({ state: 'none' }, measured)).toBe(measured)
    }
  })
})

describe('time words (Fable, Story 76.1)', () => {
  const now = new Date(2026, 9, 15, 9, 0)
  const at = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute).toISOString()

  it('names today by the clock, this week by weekday and older days by date', () => {
    expect(awaySinceWords(at(15, 7, 5), now)).toBe('Away since 07:05')
    expect(awayMomentWords(at(14, 22, 10), now)).toBe('Wed 22:10')
    expect(awayMomentWords(at(9, 22, 10), now)).toBe('Fri 22:10')
    expect(awayMomentWords(at(8, 22, 10), now)).toBe('Oct 8, 22:10')
    expect(awayMomentWords('broken', now)).toBe('--:--')
  })

  it('words durations and periods', () => {
    expect(awayDurationWords(at(15, 7, 5), at(15, 7, 40))).toBe('35 min')
    expect(awayDurationWords(at(14, 22, 10), at(15, 7, 40))).toBe('9 h 30 min')
    expect(awayDurationWords(at(14, 22, 10), at(14, 22, 10))).toBe('under a minute')
    expect(awayDurationWords(at(14, 22, 0), at(15, 7, 0))).toBe('9 h')
    expect(awayDurationWords(at(12, 6, 0), at(14, 9, 0))).toBe('2 d 3 h')
    expect(awayPeriodWords(at(14, 22, 10), at(15, 7, 40), now)).toBe('Wed 22:10 – Thu 07:40')
    expect(awayPeriodWords(at(15, 7, 5), at(15, 7, 40), now)).toBe('Thu 07:05 – 07:40')
    expect(awayPeriodWords(at(2, 22, 10), at(3, 7, 40), now)).toBe('Oct 2, 22:10 – Oct 3, 07:40')
  })
})
