// MODULE: database-away-store.test.ts - the said away state as one raw setting: written only on a change, read back whole (Story 76.3)
import { createRequire } from 'node:module'
import { AWAY_RECORD_KEY } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeAway, getAway, markAwaySummaryShown } from './database-away-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-10-16T19:10:00.000Z'
const T1 = '2026-10-17T04:40:00.000Z'
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, T0)
})
afterEach(() => database.close())

const stored = (): string | undefined =>
  (database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_RECORD_KEY) as { value_json: string } | undefined)?.value_json

describe('away store', () => {
  it('writes a change with a new period id and nothing for an unchanged or refused one', () => {
    expect(getAway(database).state).toBe('none')
    expect(changeAway(database, { to: 'back', source: 'app' }, T0).outcome).toBe('unchanged')
    expect(stored()).toBeUndefined()
    const away = changeAway(database, { to: 'away', source: 'cli', note: 'train' }, T0)
    expect(away.record.periodId).toMatch(/^[0-9a-f-]{36}$/)
    const written = stored()
    expect(changeAway(database, { to: 'away', source: 'app', note: 'x'.repeat(201) }, T1).outcome).toBe('invalid')
    expect(changeAway(database, { to: 'away', source: 'app' }, T1).outcome).toBe('unchanged')
    expect(stored()).toBe(written)
    expect(getAway(database)).toEqual(away.record)
  })

  it('stores the key of an operation that changed nothing, so its redelivery after a later away ends nothing', () => {
    expect(changeAway(database, { to: 'back', source: 'telegram', operationKey: 'telegram:bot:41' }, T0).outcome).toBe('unchanged')
    expect(changeAway(database, { to: 'away', source: 'app' }, T0).outcome).toBe('changed')
    expect(changeAway(database, { to: 'back', source: 'telegram', operationKey: 'telegram:bot:41' }, T1).outcome).toBe('unchanged')
    expect(getAway(database).state).toBe('away')
  })

  it('applies one change after another against what the one before left', () => {
    const first = changeAway(database, { to: 'away', source: 'app', expectedRevision: 0 }, T0)
    const second = changeAway(database, { to: 'back', source: 'telegram', expectedRevision: 0 }, T1)
    expect([first.outcome, second.outcome]).toEqual(['changed', 'stale'])
    expect(getAway(database)).toMatchObject({ state: 'away', revision: 1 })
  })

  it('reads a damaged value as nothing said', () => {
    database.prepare('INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)').run(AWAY_RECORD_KEY, '{"version":1,"state":', T0)
    expect(getAway(database)).toMatchObject({ state: 'none', revision: 0 })
    expect(changeAway(database, { to: 'away', source: 'app' }, T1).record.state).toBe('away')
  })

  it('marks a summary shown once, for the closed period only', () => {
    const away = changeAway(database, { to: 'away', source: 'app' }, T0).record
    expect(markAwaySummaryShown(database, away.periodId!, T1).summaryShownAt).toBeNull()
    changeAway(database, { to: 'back', source: 'app' }, T1)
    expect(markAwaySummaryShown(database, 'other', T1).summaryShownAt).toBeNull()
    expect(markAwaySummaryShown(database, away.periodId!, T1).summaryShownAt).toBe(T1)
    expect(markAwaySummaryShown(database, away.periodId!, '2026-10-18T00:00:00.000Z').summaryShownAt).toBe(T1)
  })
})
