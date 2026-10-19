// MODULE: database-away-store.ts - the owner's said away state as one raw setting, changed only by one serialised operation (Story 76.3)
import { randomUUID } from 'node:crypto'
import {
  AWAY_RECORD_KEY,
  applyAwayChange,
  departurePeriodId,
  followAwayChange,
  parseAwayRecord,
  type AwayChange,
  type AwayChangeResult,
  type AwayRecord,
  type GrantRead
} from '@bmn/protocol'
import { grantBase, readGrantRow, writeGrantRow } from './database-grant-store'
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
 * applied one after another, each against the record the one before it left. The period id is made here, never by a caller:
 * a pending departure's (Epic 84, Decisions "departure lifecycle"), else a new one. The grant record follows in the same
 * transaction: Away carries the departure, Back ends its grants, back while only leaving cancels it. `grant` is the grant
 * record when this change changed it, else null.
 */
export function changeAway(database: DatabaseConnection, change: Omit<AwayChange, 'periodId'>, now: string): AwayChangeResult & { grant: GrantRead | null } {
  const current = readRecord(database)
  const grants = readGrantRow(database)
  const result = applyAwayChange(current, { ...change, periodId: departurePeriodId(grantBase(grants)) ?? randomUUID() }, now)
  // An unchanged state with a remembered key is written too: the key is what makes a later replay a no-op.
  if (result.outcome === 'changed' || result.record !== current) writeRecord(database, result.record, now)
  const followed = followAwayChange(grantBase(grants), current, result.record, { to: change.to, source: change.source, outcome: result.outcome }, now)
  if (followed.outcome === 'changed') writeGrantRow(database, followed.record, now)
  return { ...result, grant: followed.outcome === 'changed' ? { state: 'read', record: followed.record } : null }
}

/** The summary of this closed period was shown: stored once, so a crash before this shows it again and after it does not. */
export function markAwaySummaryShown(database: DatabaseConnection, periodId: string, now: string): AwayRecord {
  const record = readRecord(database)
  if (record.state !== 'back' || record.periodId !== periodId || record.summaryShownAt !== null) return record
  const next = { ...record, summaryShownAt: now }
  writeRecord(database, next, now)
  return next
}

/** Which conversation was handed which away state (Story 76.4), kept so a resume after a restart is told back. */
export const AWAY_NOTICES_KEY = 'away-notices-v1'
export interface StoredAwayTold { revision: number; state: 'away' | 'back'; status: 'claimed' | 'printed'; incarnationId: string; claimedAt?: string; claimId?: string }

export function getAwayNotices(database: DatabaseConnection): Array<[string, StoredAwayTold]> {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_NOTICES_KEY) as { value_json: string } | undefined
  let value: unknown
  try { value = row ? JSON.parse(row.value_json) : null } catch { value = null }
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { entries?: unknown }).entries)) return []
  return ((value as { entries: unknown[] }).entries).filter((entry): entry is [string, StoredAwayTold] => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'object' || entry[1] === null) return false
    const told = entry[1] as Record<string, unknown>
    return Number.isSafeInteger(told.revision) && (told.state === 'away' || told.state === 'back') &&
      (told.status === 'claimed' || told.status === 'printed') && typeof told.incarnationId === 'string'
  })
}

export function putAwayNotices(database: DatabaseConnection, entries: Array<[string, StoredAwayTold]>, now: string): void {
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(AWAY_NOTICES_KEY, JSON.stringify({ version: 1, entries }), now)
}

export const AWAY_OPERATIONS = Object.freeze({ getAway, changeAway, markAwaySummaryShown, getAwayNotices, putAwayNotices })
