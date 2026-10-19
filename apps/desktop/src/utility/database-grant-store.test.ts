// MODULE: database-grant-store.test.ts - the Away grant beside the away record: one transaction, the departure's period id, refusals that change nothing (Story 84.3)
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { AWAY_RECORD_KEY, GRANT_RECORD_KEY, applyAwayChange, parseAwayRecord, type AwayChange, type AwayRecord } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeAway, markAwaySummaryShown } from './database-away-store'
import { answerGrantCard, askGrantCard, getGrants, leaveAway, markGrantTold, readGrantRow, useGrantRecord } from './database-grant-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-10-19T19:31:00.000Z'
const T1 = '2026-10-19T19:40:00.000Z'
const T2 = '2026-10-20T04:40:00.000Z'
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, T0)
})
afterEach(() => database.close())

const raw = (db: DatabaseConnection, key: string): string | undefined =>
  (db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as { value_json: string } | undefined)?.value_json
const CARD = {
  title: 'Epic 80 · clean up ai slop', scope: 'Stories 80.2–80.6', nothing: false,
  terms: [{ id: 'rounds' as const, kind: 'rounds' as const, proposed: 3, reason: 'two boundaries are ahead' }]
}
const ask = (runId = 'run-80') => askGrantCard(database, { runId, sessionId: 's-builder', agentCli: 'claude', card: CARD }, T0)

describe('grant store (Story 84.3)', () => {
  it('starts with no row, and starts a departure whose period id Away then carries (AC1)', () => {
    expect(getGrants(database).read).toEqual({ state: 'read', record: { version: 1, revision: 0, periods: [], operations: [] } })
    expect(ask()).toMatchObject({ outcome: 'no-departure' })
    expect(raw(database, GRANT_RECORD_KEY)).toBeUndefined()
    const left = leaveAway(database, { source: 'agent', agentSessionId: 's-builder' }, T0)
    const periodId = left.record.periods[0]!.periodId
    expect(periodId).toMatch(/^[0-9a-f-]{36}$/)
    expect(leaveAway(database, { source: 'app', agentSessionId: null }, T0).outcome).toBe('unchanged')
    expect(ask().outcome).toBe('opened')
    const away = changeAway(database, { to: 'away', source: 'agent', agentSessionId: 's-builder', expectedRevision: 0 }, T1)
    expect(away.record.periodId).toBe(periodId)
    expect(away.grant?.state === 'read' && away.grant.record.periods.at(-1)).toMatchObject({ periodId, state: 'away', awayAt: T1 })
    expect(leaveAway(database, { source: 'agent', agentSessionId: 's' }, T1).outcome).toBe('unchanged')
  })

  it('starts the period at Away when Away is pressed with no departure pending', () => {
    const away = changeAway(database, { to: 'away', source: 'app' }, T0)
    expect(readGrantRow(database)).toMatchObject({ state: 'read', record: { periods: [{ periodId: away.record.periodId, state: 'away', startedBy: 'app' }] } })
  })

  it('stores an answer only from the owner\'s call, bound to period, run and revision; refusals leave the row as it was (AC2, AC3)', () => {
    const periodId = leaveAway(database, { source: 'agent', agentSessionId: 's-builder' }, T0).record.periods[0]!.periodId
    expect(ask().outcome).toBe('opened')
    const answer = (over: Record<string, unknown> = {}) => answerGrantCard(database, {
      periodId, runId: 'run-80', cardRevision: 1, choices: { rounds: 3 }, via: 'app', operationKey: 'op-1', ...over
    }, T1)
    for (const over of [{ cardRevision: 2 }, { periodId: 'p-0' }, { choices: { rounds: 9 } }]) {
      const before = raw(database, GRANT_RECORD_KEY)
      expect(answer(over).outcome).toBe('refused')
      expect(raw(database, GRANT_RECORD_KEY)).toBe(before)
    }
    expect(answer().outcome).toBe('granted')
    const after = raw(database, GRANT_RECORD_KEY)
    expect(answer().outcome).toBe('repeated')
    expect(answer({ operationKey: 'op-2', via: 'telegram' })).toMatchObject({ outcome: 'refused', reason: 'answered' })
    expect(raw(database, GRANT_RECORD_KEY)).toBe(after)
  })

  it('ends the grants at Back and withdraws open cards; a later answer is refused (AC4)', () => {
    leaveAway(database, { source: 'agent', agentSessionId: 's-builder' }, T0)
    ask('run-80')
    ask('run-81')
    const away = changeAway(database, { to: 'away', source: 'agent', agentSessionId: 's-builder', expectedRevision: 0 }, T1).record
    answerGrantCard(database, { periodId: away.periodId!, runId: 'run-80', cardRevision: 1, choices: { rounds: 3 }, via: 'telegram', operationKey: 'tg-1' }, T1)
    expect(useGrantRecord(database, { runId: 'run-80', sessionId: 's-builder', id: 'u1', kind: 'round', boundary: '80.3' }, T1)).toMatchObject({ outcome: 'recorded', left: 2 })
    const back = changeAway(database, { to: 'back', source: 'app' }, T2)
    const period = back.grant?.state === 'read' ? back.grant.record.periods.at(-1)! : null
    expect(period).toMatchObject({ state: 'ended', endedBy: 'app' })
    expect(period!.runs.map((run) => run.card.state)).toEqual(['answered', 'withdrawn'])
    expect(answerGrantCard(database, { periodId: away.periodId!, runId: 'run-81', cardRevision: 1, choices: { rounds: 3 }, via: 'app', operationKey: 'k' }, T2))
      .toMatchObject({ outcome: 'refused', reason: 'withdrawn-back' })
    expect(useGrantRecord(database, { runId: 'run-80', sessionId: 's-builder', id: 'u2', kind: 'round', boundary: '80.3' }, T2)).toMatchObject({ outcome: 'refused' })
  })

  it('cancels a departure on back while only leaving, with the away record untouched', () => {
    leaveAway(database, { source: 'cli', agentSessionId: null }, T0)
    ask()
    const back = changeAway(database, { to: 'back', source: 'app' }, T1)
    expect(back.outcome).toBe('unchanged')
    expect(raw(database, AWAY_RECORD_KEY)).toBeUndefined()
    expect(back.grant?.state === 'read' && back.grant.record.periods[0]).toMatchObject({ state: 'cancelled', runs: [{ card: { state: 'withdrawn', withdrawnFor: 'not-leaving' } }] })
  })

  it('reads a malformed row as no grant, never writes a use over it, and starts afresh at the next departure', () => {
    database.prepare('INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)').run(GRANT_RECORD_KEY, '{"version":1,', T0)
    expect(getGrants(database).read.state).toBe('unknown')
    expect(useGrantRecord(database, { runId: 'r', sessionId: 's', id: 'u', kind: 'round', boundary: 'b' }, T0)).toMatchObject({ outcome: 'refused' })
    expect(markGrantTold(database, 'p', 's', T0).outcome).toBe('unchanged')
    expect(raw(database, GRANT_RECORD_KEY)).toBe('{"version":1,')
    expect(changeAway(database, { to: 'away', source: 'app' }, T1).record.state).toBe('away')
    expect(readGrantRow(database).state).toBe('read')
  })
})

/** The away store before Epic 84, kept here only to compare: a new period id for every away. */
function oldChangeAway(db: DatabaseConnection, change: Omit<AwayChange, 'periodId'>, now: string): void {
  const row = raw(db, AWAY_RECORD_KEY)
  let current: AwayRecord
  try { current = parseAwayRecord(row === undefined ? undefined : JSON.parse(row)) } catch { current = parseAwayRecord(undefined) }
  const result = applyAwayChange(current, { ...change, periodId: randomUUID() }, now)
  if (result.outcome === 'changed' || result.record !== current) {
    db.prepare(`INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(AWAY_RECORD_KEY, JSON.stringify(result.record), now)
  }
}

describe('owner-away-v1 parity (Story 84.3 AC5)', () => {
  it('reads identical between the old and new implementations, but for a period id that comes from the departure', () => {
    const old = new BetterSqlite3(':memory:')
    initializeDatabase(old, T0)
    try {
      const steps: Array<{ change?: Omit<AwayChange, 'periodId'>; shown?: true; leave?: true; at: string }> = [
        { change: { to: 'back', source: 'telegram', operationKey: 'tg:1' }, at: T0 },
        { leave: true, at: T0 },
        { change: { to: 'away', source: 'agent', agentSessionId: 's-builder', expectedRevision: 0, operationKey: 'agent:A' }, at: T0 },
        { change: { to: 'away', source: 'app', note: 'train' }, at: T1 },
        { change: { to: 'away', source: 'agent', agentSessionId: 's-builder', expectedRevision: 0, operationKey: 'agent:A' }, at: T1 },
        { change: { to: 'back', source: 'cli', operationKey: 'cli:B' }, at: T2 },
        { shown: true, at: T2 },
        { change: { to: 'back', source: 'telegram', operationKey: 'tg:1' }, at: T2 },
        { change: { to: 'away', source: 'app' }, at: T2 },
        { change: { to: 'away', source: 'app', note: 'x'.repeat(201) }, at: T2 },
        { change: { to: 'back', source: 'app', expectedRevision: 1 }, at: T2 }
      ]
      const periods = new Map<string, string>()
      const normal = (value: string | undefined): unknown => {
        if (value === undefined) return undefined
        const record = JSON.parse(value) as AwayRecord
        if (record.periodId !== null && !periods.has(record.periodId)) periods.set(record.periodId, `period-${periods.size}`)
        return { ...record, periodId: record.periodId === null ? null : periods.get(record.periodId) }
      }
      let departure: string | null = null
      for (const step of steps) {
        if (step.leave) departure = leaveAway(database, { source: 'agent', agentSessionId: 's-builder' }, step.at).record.periods.at(-1)!.periodId
        if (step.change) {
          oldChangeAway(old, step.change, step.at)
          const result = changeAway(database, step.change, step.at)
          if (departure !== null && result.outcome === 'changed' && result.record.state === 'away') {
            expect(result.record.periodId).toBe(departure)
            departure = null
          }
        }
        if (step.shown) {
          const periodOf = (db: DatabaseConnection): string => (JSON.parse(raw(db, AWAY_RECORD_KEY)!) as AwayRecord).periodId!
          markAwaySummaryShown(old, periodOf(old), step.at)
          markAwaySummaryShown(database, periodOf(database), step.at)
        }
        periods.clear()
        const oldNormal = normal(raw(old, AWAY_RECORD_KEY))
        periods.clear()
        expect(normal(raw(database, AWAY_RECORD_KEY))).toEqual(oldNormal)
      }
    } finally {
      old.close()
    }
  })
})
