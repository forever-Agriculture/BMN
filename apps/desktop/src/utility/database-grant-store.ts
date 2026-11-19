// MODULE: database-grant-store.ts - the Away grant as one raw setting beside the away record, changed only by serialised operations (Epic 84, Story 84.3)
import { randomUUID } from 'node:crypto'
import {
  AWAY_RECORD_KEY,
  EMPTY_GRANT_RECORD,
  GRANT_RECORD_KEY,
  answerGrant,
  changeGrantAccess,
  askGrant,
  markDepartureTold,
  markGrantLimit,
  settleGrantLimit,
  parseAwayRecord,
  readGrantRecord,
  readGrantLimitApply,
  reportGrant,
  setGrantPhone,
  startDeparture,
  useGrant,
  type AwayRecord,
  type AwaySource,
  type GrantAnswerResult,
  type GrantAskResult,
  type GrantLifecycleResult,
  type GrantLimitRequest,
  type NightAllowanceReceipt,
  openGrantPeriod,
  type GrantRead,
  type GrantRecord,
  type GrantReportInput,
  type GrantReportOutcome,
  type GrantRun,
  type GrantAskCard,
  type GrantUseResult
} from '@bmn/protocol'
import { grantStatus, nightTermHold } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { getPushPolicy } from './database-push-policy-store'

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
  runId: string; sessionId: string | null; agentCli: string | null; card: GrantAskCard; operationKey?: string
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
  const away = getAway(database)
  // Epic 132 S1 (owner 2026-11-19): a typed night merge, push or PR write his deploy rule holds is refused here, in the
  // transaction that would spend it, against the rule in force now; no use is taken.
  if (use.kind === 'action' && read.state === 'read') {
    const status = grantStatus(read, away, use.runId)
    const term = status.active ? status.grant.items.find(item => item.term.id === use.item)?.term : undefined
    const hold = term === undefined ? null : nightTermHold(getPushPolicy(database), term)
    if (hold !== null) return { outcome: 'refused', record: read.record, reason: hold, read }
  }
  const result = useGrant(read, away, use, now)
  // A refusal is kept too, for the morning; an unreadable record is never written over by a use.
  const next = read.state === 'read' && result.outcome !== 'repeated' && result.record !== read.record ? writeGrantRow(database, result.record, now) : read
  return { ...result, read: next }
}

/** An agent's report of a step (Story 84.7): kept for the morning; an unreadable record is never written over by one. */
function reportGrantRecord(database: DatabaseConnection, report: GrantReportInput, now: string): GrantReportOutcome & { read: GrantRead } {
  const read = readGrantRow(database)
  const result = reportGrant(read, report, now, getAway(database))
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

const NIGHT_ALLOWANCE_PREFIX = 'night-allowance-receipt:'
type NightAllowanceKey = Pick<GrantLimitRequest, 'runId' | 'sessionId' | 'useId'>

export function nightAllowanceKey(request: NightAllowanceKey): string {
  return `${NIGHT_ALLOWANCE_PREFIX}${JSON.stringify([request.runId, request.sessionId, request.useId])}`
}

function parseNightApply(row: { value_json: string; key: string }): NightAllowanceReceipt {
  const raw = JSON.parse(row.value_json) as NightAllowanceReceipt
  const entry = readGrantLimitApply(raw.entry)
  if (entry === null || typeof raw.periodId !== 'string' || nightAllowanceKey(entry) !== row.key) {
    throw new Error('The allowance write receipt could not be read')
  }
  return { periodId: raw.periodId, entry }
}

function getLimitApply(database: DatabaseConnection, request: NightAllowanceKey): NightAllowanceReceipt | null {
  const key = nightAllowanceKey(request)
  const row = database.prepare('SELECT key, value_json FROM app_setting WHERE key = ?').get(key) as { key: string; value_json: string } | undefined
  if (row !== undefined) return parseNightApply(row)
  const grant = readGrantRow(database)
  if (grant.state !== 'read') return null
  for (const period of grant.record.periods) {
    const entry = period.limitApplies?.find(item => nightAllowanceKey(item) === key)
    if (entry !== undefined) return { periodId: period.periodId, entry }
  }
  return null
}

function openLimitApplies(database: DatabaseConnection, runId?: string): NightAllowanceReceipt[] {
  const byKey = new Map<string, NightAllowanceReceipt>()
  const grant = readGrantRow(database)
  if (grant.state === 'read') for (const period of grant.record.periods) for (const entry of period.limitApplies ?? []) {
    if (entry.state === 'writing') byKey.set(nightAllowanceKey(entry), { periodId: period.periodId, entry })
  }
  const rows = database.prepare(`SELECT key, value_json FROM app_setting WHERE key GLOB 'night-allowance-receipt:*'
    AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.entry.state') = 'writing' ELSE 1 END`).all() as Array<{ key: string; value_json: string }>
  for (const row of rows) byKey.set(row.key, parseNightApply(row))
  return [...byKey.values()].filter(({ entry }) => entry.state === 'writing' && (runId === undefined || entry.runId === runId))
}

function keepNightApply(database: DatabaseConnection, receipt: NightAllowanceReceipt, now: string): void {
  database.prepare(`INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(nightAllowanceKey(receipt.entry), JSON.stringify(receipt), now)
}

function markLimitApply(database: DatabaseConnection, request: GrantLimitRequest & { incarnationId: string },
  period: string, revision: number, pin: Parameters<typeof markGrantLimit>[5], operation: string, now: string) {
  const read = readGrantRow(database)
  const { incarnationId, ...scope } = request
  if (getLimitApply(database, scope) !== null) return { entry: null, detail: 'This use id was already applied', read }
  const live = database.prepare(`SELECT 1 FROM process_incarnation WHERE session_id = ? AND incarnation_id = ? AND state = 'running'`)
    .get(scope.sessionId, incarnationId)
  if (live === undefined) return { entry: null, detail: 'The requesting session ended before apply; nothing was written', read }
  const result = markGrantLimit(read, getAway(database), scope, period, revision, pin, operation, now)
  if (result.entry === null) return { ...result, read }
  keepNightApply(database, { periodId: period, entry: result.entry }, now)
  return { ...result, read: writeGrantRow(database, result.record, now) }
}

function settleLimitApply(database: DatabaseConnection, request: NightAllowanceKey, source: string, result: Parameters<typeof settleGrantLimit>[3], now: string) {
  const read = readGrantRow(database)
  const pending = getLimitApply(database, request)
  if (pending?.entry.source !== source || pending.entry.state !== 'writing') return { settled: false, read }
  const settled = settleGrantLimit(read, pending.periodId, source, result, now)
  if (result.state === 'interrupted') database.prepare('DELETE FROM app_setting WHERE key = ?').run(nightAllowanceKey(request))
  else keepNightApply(database, { periodId: pending.periodId, entry: { ...pending.entry, ...result, at: now } }, now)
  return { settled: true, read: settled === null ? read : writeGrantRow(database, settled, now) }
}

function updateGrantAccess(database: DatabaseConnection, update: Parameters<typeof changeGrantAccess>[1], now: string) {
  const read = readGrantRow(database)
  const result = changeGrantAccess(read, update, now)
  return { outcome: result.outcome, read: result.outcome === 'recorded' ? writeGrantRow(database, result.record, now) : read }
}

export const GRANT_OPERATIONS = Object.freeze({ getGrants, leaveAway, askGrantCard, answerGrantCard, useGrantRecord, reportGrantRecord, markGrantTold, setGrantPhoneMessage, getLimitApply, openLimitApplies, markLimitApply, settleLimitApply, updateGrantAccess })
