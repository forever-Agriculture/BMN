// MODULE: database-decision-store.ts - decisions agents record while the owner is away: recorded notices in the attention store (Story 76.5)
import { randomUUID } from 'node:crypto'
import {
  DECISION_LIMITS,
  ERROR_CODES,
  sameDecisionPayload,
  type DecisionOutcome,
  type DecisionPayload,
  type DecisionRecord,
  type DecisionReference
} from '@bmn/protocol'
import { getAway } from './database-away-store'
import type { DatabaseConnection } from './database-initialization'
import { WorkspaceStoreError } from './database-workspace-store'

/** A decision's key lives in its session's own namespace, apart from every request key. */
export const DECISION_KEY_PREFIX = 'decision:'
/** The most decisions one period query returns; more is said, never summed. */
export const DECISION_PERIOD_LIMIT = 200

export interface DecisionRecordCall {
  sessionId: string
  incarnationId: string
  key: string
  payload: DecisionPayload
  /** The running process's conversation, from its own hook; BMN never takes it from the caller. */
  provenance: { agentCli: string; conversation: string }
  /** The away revision the agent saw. */
  expectedRevision: number
}

function storedDecision(json: string | null): DecisionRecord | null {
  if (json === null) return null
  try { return JSON.parse(json) as DecisionRecord } catch { return null }
}

/**
 * Whether BMN finds each reference, by its existing rules: a session it holds, a file this session published and still has
 * ready. A workflow entry is the agent's own and never BMN's to check. One BMN does not find is kept as the agent's words
 * and never offered as a link.
 */
/** A file this session published and still has ready: the rule progress evidence follows. */
function ownReadyFile(database: DatabaseConnection, sessionId: string, artifactId: string): boolean {
  const row = database.prepare('SELECT session_id, direction, state FROM artifact WHERE artifact_id = ?').get(artifactId) as
    { session_id: string; direction: string; state: string } | undefined
  return row !== undefined && row.session_id === sessionId && row.direction === 'output' && row.state === 'ready'
}

function checkedReferences(database: DatabaseConnection, sessionId: string, references: DecisionPayload['references']): DecisionReference[] {
  const session = database.prepare('SELECT 1 FROM session WHERE session_id = ?')
  return references.map(({ kind, id }) => {
    if (kind === 'session') return { kind, id, valid: session.get(id) !== undefined }
    if (kind === 'artifact') {
      return { kind, id, valid: ownReadyFile(database, sessionId, id) }
    }
    return { kind, id, valid: false }
  })
}

function decisionRow(database: DatabaseConnection, sessionId: string, key: string): { request_id: string; decision_json: string } | undefined {
  return database.prepare(
    "SELECT request_id, decision_json FROM attention_request WHERE session_id = ? AND request_key = ? AND state = 'recorded'"
  ).get(sessionId, `${DECISION_KEY_PREFIX}${key}`) as { request_id: string; decision_json: string } | undefined
}

/**
 * Story 76.5 AC1–AC2, in one transaction of the worker: the key is looked up first, so an identical retry returns the
 * first record with its provenance, period and time, whatever the away state is now, and a changed payload fails. Only a
 * new key is bound: to the away period that is current and only at the revision the agent saw, never to a past one.
 */
export function recordDecision(database: DatabaseConnection, call: DecisionRecordCall, now: string): { outcome: 'recorded' | 'repeated'; record: DecisionRecord } {
  const existing = decisionRow(database, call.sessionId, call.key)
  if (existing) {
    const record = storedDecision(existing.decision_json)
    if (record !== null && sameDecisionPayload(record, call.payload)) return { outcome: 'repeated', record }
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, `Decision ${call.key} was recorded with other text; another decision needs a new key; nothing was changed`)
  }
  const away = getAway(database)
  if (away.state !== 'away' || away.periodId === null) {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, 'The owner is not away; a decision is recorded only while he is; nothing was recorded')
  }
  if (away.revision !== call.expectedRevision) {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, `The away state changed since the revision you saw; it is at revision ${away.revision} now; nothing was recorded`)
  }
  const record: DecisionRecord = {
    key: call.key, sessionId: call.sessionId, choice: call.payload.choice, reason: call.payload.reason, affects: call.payload.affects,
    reverse: call.payload.reverse, references: checkedReferences(database, call.sessionId, call.payload.references), depends: call.payload.depends, periodId: away.periodId,
    revision: away.revision, agentCli: call.provenance.agentCli, conversation: call.provenance.conversation,
    incarnationId: call.incarnationId, recordedAt: now, outcomes: []
  }
  database.prepare(
    `INSERT INTO attention_request(request_id, session_id, incarnation_id, request_key, kind, title, body, state, resolution,
       opened_at, expires_at, resolved_at, seen_at, revision, opened_by, resolved_by, decision_json)
     VALUES (?, ?, ?, ?, 'notice', ?, NULL, 'recorded', NULL, ?, NULL, ?, NULL, 1, 'agent', 'decision', ?)`
  ).run(randomUUID(), call.sessionId, call.incarnationId, `${DECISION_KEY_PREFIX}${call.key}`, call.payload.choice.slice(0, 200), now, now, JSON.stringify(record))
  return { outcome: 'recorded', record }
}

/**
 * Story 76.5 AC3: an outcome is appended under its own operation key; an identical retry returns the first append and other
 * data under the same key fails. Earlier appends stay and the decision keeps its period, whatever the away state is now.
 */
export function addDecisionOutcome(
  database: DatabaseConnection,
  call: { sessionId: string; key: string; op: string; result: 'done' | 'failed'; evidence: string[] },
  now: string
): { outcome: 'appended' | 'repeated'; record: DecisionRecord } {
  const row = decisionRow(database, call.sessionId, call.key)
  const record = row ? storedDecision(row.decision_json) : null
  if (!row || record === null) throw new WorkspaceStoreError(ERROR_CODES.notFound, `No decision ${call.key} recorded by this session`)
  const earlier = record.outcomes.find((outcome) => outcome.op === call.op)
  if (earlier) {
    if (earlier.result === call.result && JSON.stringify(earlier.evidence) === JSON.stringify(call.evidence)) return { outcome: 'repeated', record }
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, `Outcome ${call.op} was reported with other data; nothing was changed`)
  }
  // Evidence follows the progress rule: files this session published and still has; anything else refuses the append.
  if (new Set(call.evidence).size !== call.evidence.length || call.evidence.length > DECISION_LIMITS.evidence) {
    throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, `Evidence is at most ${DECISION_LIMITS.evidence} different files; nothing was changed`)
  }
  const foreign = call.evidence.find((id) => !ownReadyFile(database, call.sessionId, id))
  if (foreign !== undefined) throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, `Evidence ${foreign} is not a ready file this session published; nothing was changed`)
  if (record.outcomes.length >= DECISION_LIMITS.outcomes) {
    throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, `A decision keeps at most ${DECISION_LIMITS.outcomes} outcomes; nothing was changed`)
  }
  const outcome: DecisionOutcome = { op: call.op, result: call.result, evidence: call.evidence, reporter: 'agent', at: now }
  const next = { ...record, outcomes: [...record.outcomes, outcome] }
  database.prepare('UPDATE attention_request SET decision_json = ?, revision = revision + 1 WHERE request_id = ?').run(JSON.stringify(next), row.request_id)
  return { outcome: 'appended', record: next }
}

/**
 * Story 76.5 AC6: one period's decisions, oldest first, bounded. `complete` says only that every retained BMN record of
 * the period is in the list; it never says every decision an agent made was reported.
 */
export function listPeriodDecisions(database: DatabaseConnection, periodId: string): { decisions: DecisionRecord[]; complete: boolean } {
  const rows = database.prepare(
    `SELECT decision_json FROM attention_request WHERE state = 'recorded' AND json_extract(decision_json, '$.periodId') = ?
     ORDER BY opened_at, rowid LIMIT ?`
  ).all(periodId, DECISION_PERIOD_LIMIT + 1) as Array<{ decision_json: string }>
  const decisions = rows.slice(0, DECISION_PERIOD_LIMIT).map((row) => storedDecision(row.decision_json)).filter((record): record is DecisionRecord => record !== null)
  return { decisions, complete: rows.length <= DECISION_PERIOD_LIMIT && decisions.length === Math.min(rows.length, DECISION_PERIOD_LIMIT) }
}

export const DECISION_OPERATIONS = Object.freeze({ recordDecision, addDecisionOutcome, listPeriodDecisions })
