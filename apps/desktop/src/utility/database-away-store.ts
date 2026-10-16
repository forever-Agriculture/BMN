// MODULE: database-away-store.ts - the owner's said away state as one raw setting, changed only by one serialised operation (Story 76.3)
import { createHash, randomUUID } from 'node:crypto'
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

/**
 * Every away or back operation key ever applied, as a short hash and whether it changed nothing (Story 76.3 AC1, Astra's
 * review): a retry however much later never changes the state again. A raw setting beside the record (R76-NFR4: no new
 * table); only keys a caller chose and Telegram's update ids come here, so it grows with what the owner does by hand.
 */
const AWAY_OPERATIONS_KEY = 'owner-away-operations-v1'

function operationHash(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 22)
}

function readOperations(database: DatabaseConnection): Record<string, 0 | 1> {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_OPERATIONS_KEY) as { value_json: string } | undefined
  if (row !== undefined) {
    try {
      const value = JSON.parse(row.value_json) as { version?: unknown; keys?: unknown }
      if (value.version === 1 && typeof value.keys === 'object' && value.keys !== null) {
        return Object.fromEntries(Object.entries(value.keys).filter((entry): entry is [string, 0 | 1] => entry[1] === 0 || entry[1] === 1))
      }
    } catch { /* unreadable: start from what the record kept */ }
  }
  // The keys the record itself kept before they moved here come along once.
  const record = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_RECORD_KEY) as { value_json: string } | undefined
  try {
    const kept = (JSON.parse(record?.value_json ?? '{}') as { operations?: unknown }).operations
    return Array.isArray(kept) ? Object.fromEntries(kept.flatMap((item: { key?: unknown; unchanged?: unknown }) =>
      typeof item?.key === 'string' ? [[operationHash(item.key), item.unchanged === true ? 1 : 0] as const] : [])) : {}
  } catch { return {} }
}

function operationsStored(database: DatabaseConnection): boolean {
  return database.prepare('SELECT 1 FROM app_setting WHERE key = ?').get(AWAY_OPERATIONS_KEY) !== undefined
}

function writeOperations(database: DatabaseConnection, keys: Record<string, 0 | 1>, now: string): void {
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(AWAY_OPERATIONS_KEY, JSON.stringify({ version: 1, keys }), now)
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
  const operations = readOperations(database)
  const hash = change.operationKey === undefined ? null : operationHash(change.operationKey)
  const known = hash !== null ? operations[hash] : undefined
  const result = applyAwayChange(readRecord(database), { ...change, periodId: randomUUID() }, now, known === undefined ? undefined : { unchanged: known === 1 })
  // Every key applied is kept, a no-op's too, so a replay however much later changes nothing and answers the same; the
  // keys the record held move out before the record is written without them.
  const remembered = hash !== null && known === undefined && (result.outcome === 'changed' || result.outcome === 'unchanged')
  if (remembered || (result.outcome === 'changed' && !operationsStored(database) && Object.keys(operations).length > 0)) {
    writeOperations(database, remembered ? { ...operations, [hash]: result.outcome === 'unchanged' ? 1 : 0 } : operations, now)
  }
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

/** Which conversation was handed which away state (Story 76.4), kept so a resume after a restart is told back. */
export const AWAY_NOTICES_KEY = 'away-notices-v1'
export interface StoredAwayTold { revision: number; state: 'away' | 'back'; status: 'claimed' | 'printed'; incarnationId: string; claimedAt?: string }

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
