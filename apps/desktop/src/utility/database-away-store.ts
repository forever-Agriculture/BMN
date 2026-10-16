// MODULE: database-away-store.ts - the owner's said away state as one raw setting, changed only by one serialised operation (Story 76.3)
import { randomUUID } from 'node:crypto'
import {
  AWAY_RECORD_KEY,
  applyAwayChange,
  parseAwayRecord,
  type AwayChange,
  type AwayChangeResult,
  type AwayRecord
} from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'

function readRecord(database: DatabaseConnection): AwayRecord {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_RECORD_KEY) as { value_json: string } | undefined
  if (!row) return parseAwayRecord(undefined)
  try { return parseAwayRecord(JSON.parse(row.value_json)) } catch { return parseAwayRecord(undefined) }
}

function writeRecord(database: DatabaseConnection, record: AwayRecord, now: string): void {
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(AWAY_RECORD_KEY, JSON.stringify(record), now)
}

export function getAway(database: DatabaseConnection): AwayRecord {
  return readRecord(database)
}

/**
 * Reads, decides and writes in the worker's one transaction, so the app, the CLI and Telegram changing it at once are
 * applied one after another, each against the record the one before it left. The period id is made here, never by a caller.
 */
export function changeAway(database: DatabaseConnection, change: Omit<AwayChange, 'periodId'>, now: string): AwayChangeResult {
  const result = applyAwayChange(readRecord(database), { ...change, periodId: randomUUID() }, now)
  if (result.outcome === 'changed') writeRecord(database, result.record, now)
  return result
}

/** The summary of this closed period was shown: stored once, so a crash before this shows it again and after it does not. */
export function markAwaySummaryShown(database: DatabaseConnection, periodId: string, now: string): AwayRecord {
  const record = readRecord(database)
  if (record.state !== 'back' || record.periodId !== periodId || record.summaryShownAt !== null) return record
  const next = { ...record, summaryShownAt: now }
  writeRecord(database, next, now)
  return next
}

export const AWAY_OPERATIONS = Object.freeze({ getAway, changeAway, markAwaySummaryShown })
