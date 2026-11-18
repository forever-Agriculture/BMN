// MODULE: database-grant-store.ts - the Away grant as one raw setting beside the away record, changed only by serialised operations (Epic 84, Story 84.3)
import { randomUUID } from 'node:crypto'
import {
  AWAY_RECORD_KEY,
  EMPTY_GRANT_RECORD,
  GRANT_RECORD_KEY,
  answerGrant,
  askGrant,
  markDepartureTold,
  parseAwayRecord,
  readGrantRecord,
  reportGrant,
  setGrantPhone,
  startDeparture,
  useGrant,
  type AwayRecord,
  type AwaySource,
  type GrantAnswerResult,
  type GrantAskResult,
  type GrantLifecycleResult,
  openGrantPeriod,
  type GrantRead,
  type GrantRecord,
  type GrantReportInput,
  type GrantReportOutcome,
  type GrantRun,
  type GrantTerm,
  type GrantUseResult
} from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'

/** The away record as the away store reads it (read here too, so neither store imports the other's module). */
function getAway(database: DatabaseConnection): AwayRecord {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(AWAY_RECORD_KEY) as { value_json: string } | undefined
  if (!row) return parseAwayRecord(undefined)
  try { return parseAwayRecord(JSON.parse(row.value_json)) } catch { return parseAwayRecord(undefined) }
}

type GrantGeneration = { generation: number; has_record: 0 | 1 }
type StoredGrant = { value_json: string }

function grantGeneration(database: DatabaseConnection): GrantGeneration | undefined {
  const row = database.prepare('SELECT generation, has_record FROM grant_generation WHERE id = 1').get() as GrantGeneration | undefined
  return row && Number.isSafeInteger(row.generation) && row.generation >= 0 &&
    (row.has_record === 0 || row.has_record === 1) ? row : undefined
}

function storedGrant(database: DatabaseConnection): StoredGrant | undefined {
  return database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(GRANT_RECORD_KEY) as StoredGrant | undefined
}

export function readGrantRow(database: DatabaseConnection): GrantRead {
  const metadata = grantGeneration(database)
  if (!metadata) return { state: 'unknown', reason: 'The grant generation could not be read', generation: null }
  const row = storedGrant(database)
  if (row === undefined && metadata.has_record) {
    return { state: 'unknown', reason: 'The stored grant record is missing', generation: metadata.generation }
  }
  return { ...readGrantRecord(row?.value_json), generation: metadata.generation }
}

/** The record a change starts from: an unreadable row holds no authority, so a change starts afresh over it. */
export function grantBase(read: GrantRead): GrantRecord {
  if (read.generation === null) throw new Error('The grant generation could not be read')
  if (read.state === 'unknown' && read.reason.includes('unknown version')) throw new Error('Unsupported grant version; the stored record is preserved')
  return read.state === 'read' ? read.record : { version: 1, revision: 0, periods: [], carried: [], operations: [] }
}

export function writeGrantRow(database: DatabaseConnection, record: GrantRecord, now: string): GrantRead & { state: 'read' } {
  const metadata = grantGeneration(database)
  if (!metadata) throw new Error('The grant generation could not be read')
  const previous = storedGrant(database)
  const parsed = readGrantRecord(previous?.value_json)
  if (parsed.state === 'unknown' && parsed.reason.includes('unknown version')) throw new Error('Unsupported grant version; the stored record is preserved')
  const reset = parsed.state === 'unknown' || previous === undefined && metadata.has_record === 1
  const generation = metadata.generation + Number(reset)
  if (!Number.isSafeInteger(generation)) throw new Error('The grant generation is exhausted')
  if (reset && previous !== undefined) {
    database.prepare('INSERT INTO grant_reset_archive (generation, value_json, archived_at) VALUES (?, ?, ?)')
      .run(metadata.generation, previous.value_json, now)
  }
  if (reset || !metadata.has_record) {
    database.prepare('UPDATE grant_generation SET generation = ?, has_record = 1 WHERE id = 1').run(generation)
  }
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(GRANT_RECORD_KEY, JSON.stringify(record), now)
  return { state: 'read', record, generation }
}

/** Every grant as stored, with the away record it is read against; unreadable is `unknown`, which grants nothing. */
export function getGrants(database: DatabaseConnection): { read: GrantRead; away: AwayRecord } {
  return { read: readGrantRow(database), away: getAway(database) }
}

/** His departure words or `bmn away --leaving` (84.3 AC1): a pending departure with its period id, read against Away. */
export function leaveAway(database: DatabaseConnection, start: { source: AwaySource; agentSessionId: string | null }, now: string): GrantLifecycleResult & { read: GrantRead } {
  const read = readGrantRow(database)
  const result = startDeparture(grantBase(read), { ...start, periodId: randomUUID() }, getAway(database).state, now)
  return { ...result, read: result.outcome === 'changed' ? writeGrantRow(database, result.record, now) : read }
}

export function askGrantCard(database: DatabaseConnection, ask: {
  runId: string; sessionId: string | null; agentCli: string | null; card: { title: string; scope: string; nothing: boolean; terms: GrantTerm[] }; operationKey?: string
  origin: { generation: number; periodId: string | null }
}, now: string): GrantAskResult & { read: GrantRead } {
  const read = readGrantRow(database)
  const record = read.state === 'read' ? read.record : EMPTY_GRANT_RECORD
  if (read.state !== 'read' || (read.generation ?? 0) !== ask.origin.generation ||
    (openGrantPeriod(record)?.periodId ?? null) !== ask.origin.periodId) {
    return { outcome: 'no-departure', record, read, reason: 'The departure changed before the request reached the store' }
  }
  const result = askGrant(record, ask, now)
  return { ...result, read: result.outcome === 'no-departure' || result.outcome === 'repeated' ? read : writeGrantRow(database, result.record, now) }
}

/** Only the owner's own surfaces reach this: the window's IPC and the Telegram connector inside this process. */
export function answerGrantCard(database: DatabaseConnection, answer: Parameters<typeof answerGrant>[1] & {
  expectedGeneration?: number
}, now: string): GrantAnswerResult & { read: GrantRead } {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'refused', record: EMPTY_GRANT_RECORD, reason: 'invalid', detail: read.reason, run: null, read }
  if (answer.expectedGeneration !== undefined && answer.expectedGeneration !== read.generation) {
    return { outcome: 'refused', record: read.record, reason: 'stale', detail: 'The grant record was replaced. Look again.', run: null, read }
  }
  const result = answerGrant(read.record, answer, now)
  // A refused answer of his is kept for the morning; a replay changes nothing.
  const next = result.outcome !== 'repeated' && result.record !== read.record ? writeGrantRow(database, result.record, now) : read
  return { ...result, read: next }
}

export function useGrantRecord(database: DatabaseConnection, use: Parameters<typeof useGrant>[2], now: string): GrantUseResult & { read: GrantRead } {
  const read = readGrantRow(database)
  const result = useGrant(read, getAway(database), use, now)
  // A refusal is kept too, for the morning; an unreadable record is never written over by a use.
  const next = read.state === 'read' && result.outcome !== 'repeated' && result.record !== read.record ? writeGrantRow(database, result.record, now) : read
  return { ...result, read: next }
}

/** An agent's report of a step (Story 84.7): kept for the morning; an unreadable record is never written over by one. */
function reportGrantRecord(database: DatabaseConnection, report: GrantReportInput, now: string): GrantReportOutcome & { read: GrantRead } {
  const read = readGrantRow(database)
  const result = reportGrant(read, report, now)
  return { ...result, read: read.state === 'read' && result.outcome === 'recorded' ? writeGrantRow(database, result.record, now) : read }
}

export function markGrantTold(database: DatabaseConnection, periodId: string, sessionId: string, now: string): GrantLifecycleResult & { read: GrantRead } {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'unchanged', record: EMPTY_GRANT_RECORD, read }
  const result = markDepartureTold(read.record, periodId, sessionId, now)
  return { ...result, read: result.outcome === 'changed' ? writeGrantRow(database, result.record, now) : read }
}

function setGrantPhoneMessage(database: DatabaseConnection, periodId: string, runId: string, phone: GrantRun['phone'], now: string): GrantLifecycleResult & { read: GrantRead } {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'unchanged', record: EMPTY_GRANT_RECORD, read }
  const result = setGrantPhone(read.record, periodId, runId, phone)
  return { ...result, read: result.outcome === 'changed' ? writeGrantRow(database, result.record, now) : read }
}

export const GRANT_OPERATIONS = Object.freeze({ getGrants, leaveAway, askGrantCard, answerGrantCard, useGrantRecord, reportGrantRecord, markGrantTold, setGrantPhoneMessage })
