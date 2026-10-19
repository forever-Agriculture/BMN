// MODULE: database-grant-store.ts - the Away grant as one raw setting beside the away record, changed only by serialised operations (Epic 84, Story 84.3)
import { randomUUID } from 'node:crypto'
import {
  AWAY_RECORD_KEY,
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
  type GrantAnswerSource,
  type GrantAskResult,
  type GrantLifecycleResult,
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

export function readGrantRow(database: DatabaseConnection): GrantRead {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(GRANT_RECORD_KEY) as { value_json: string } | undefined
  return readGrantRecord(row?.value_json)
}

/** The record a change starts from: an unreadable row holds no authority, so a change starts afresh over it. */
export function grantBase(read: GrantRead): GrantRecord {
  return read.state === 'read' ? read.record : { version: 1, revision: 0, periods: [], operations: [] }
}

export function writeGrantRow(database: DatabaseConnection, record: GrantRecord, now: string): void {
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(GRANT_RECORD_KEY, JSON.stringify(record), now)
}

/** Every grant as stored, with the away record it is read against; unreadable is `unknown`, which grants nothing. */
export function getGrants(database: DatabaseConnection): { read: GrantRead; away: AwayRecord } {
  return { read: readGrantRow(database), away: getAway(database) }
}

/** His departure words or `bmn away --leaving` (84.3 AC1): a pending departure with its period id, read against Away. */
export function leaveAway(database: DatabaseConnection, start: { source: AwaySource; agentSessionId: string | null }, now: string): GrantLifecycleResult & { read: GrantRead } {
  const read = readGrantRow(database)
  const result = startDeparture(grantBase(read), { ...start, periodId: randomUUID() }, getAway(database).state, now)
  if (result.outcome === 'changed') writeGrantRow(database, result.record, now)
  return { ...result, read: result.outcome === 'changed' ? { state: 'read', record: result.record } : read }
}

export function askGrantCard(database: DatabaseConnection, ask: {
  runId: string; sessionId: string | null; agentCli: string | null; card: { title: string; scope: string; nothing: boolean; terms: GrantTerm[] }; operationKey?: string
}, now: string): GrantAskResult {
  const result = askGrant(grantBase(readGrantRow(database)), ask, now)
  if (result.outcome !== 'no-departure' && result.outcome !== 'repeated') writeGrantRow(database, result.record, now)
  return result
}

/** Only the owner's own surfaces reach this: the window's IPC and the Telegram connector inside this process. */
export function answerGrantCard(database: DatabaseConnection, answer: {
  periodId: string; runId: string; cardRevision: number; choices: Record<string, unknown>; via: GrantAnswerSource; operationKey: string
}, now: string): GrantAnswerResult {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'refused', record: grantBase(read), reason: 'invalid', detail: read.reason, run: null }
  const result = answerGrant(read.record, answer, now)
  if (result.outcome === 'granted') writeGrantRow(database, result.record, now)
  return result
}

export function useGrantRecord(database: DatabaseConnection, use: Parameters<typeof useGrant>[2], now: string): GrantUseResult {
  const read = readGrantRow(database)
  const result = useGrant(read, getAway(database), use, now)
  // A refusal is kept too, for the morning; an unreadable record is never written over by a use.
  if (read.state === 'read' && result.outcome !== 'repeated' && result.record !== read.record) writeGrantRow(database, result.record, now)
  return result
}

/** An agent's report of a step (Story 84.7): kept for the morning; an unreadable record is never written over by one. */
export function reportGrantRecord(database: DatabaseConnection, report: GrantReportInput, now: string): GrantReportOutcome {
  const read = readGrantRow(database)
  const result = reportGrant(read, report, now)
  if (read.state === 'read' && result.outcome === 'recorded') writeGrantRow(database, result.record, now)
  return result
}

export function markGrantTold(database: DatabaseConnection, periodId: string, sessionId: string, now: string): GrantLifecycleResult {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'unchanged', record: grantBase(read) }
  const result = markDepartureTold(read.record, periodId, sessionId)
  if (result.outcome === 'changed') writeGrantRow(database, result.record, now)
  return result
}

export function setGrantPhoneMessage(database: DatabaseConnection, periodId: string, runId: string, phone: GrantRun['phone'], now: string): GrantLifecycleResult {
  const read = readGrantRow(database)
  if (read.state === 'unknown') return { outcome: 'unchanged', record: grantBase(read) }
  const result = setGrantPhone(read.record, periodId, runId, phone)
  if (result.outcome === 'changed') writeGrantRow(database, result.record, now)
  return result
}

export const GRANT_OPERATIONS = Object.freeze({ getGrants, leaveAway, askGrantCard, answerGrantCard, useGrantRecord, reportGrantRecord, markGrantTold, setGrantPhoneMessage })
