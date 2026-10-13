// MODULE: database-turn-store.ts - the rows of turn changes: captures, turns and which turn needs which capture, how long they are kept, and the jobs that remove their bytes (Epic 69)
//
// No row holds a file's name or content. Bytes live in BMN's own store under the data root; a row is
// deleted together with a job that names those bytes, in one transaction, and the job is cleared only
// when they are gone, so a crash or a failed removal leaves the job and the removal is tried again.
import type { DatabaseConnection } from './database-initialization'

const DAY_MS = 86_400_000

export type TurnState = 'open' | 'provisional' | 'closed'
export type TurnTotalsState = 'none' | 'complete' | 'partial' | 'not-complete'
export type TurnCaptureRole = 'before' | 'after'

/** One scan of a work tree, as its rows know it: where, when, which commit `HEAD` named, how it ended, its size. */
export interface TurnCaptureRow {
  captureId: string
  sessionId: string
  /** The root of the work tree, as BMN established it. */
  workTree: string
  scanStartedMs: number
  scanEndedMs: number
  headStart: string | null
  headEnd: string | null
  state: 'whole' | 'incomplete'
  /** The limit an incomplete capture met, in the words shown to the owner. */
  bound: string | null
  /** Bytes this capture added to the store. */
  size: number
}

export interface TurnTotals {
  files: number
  added: number
  removed: number
}

/** One turn of an agent (Story 69.4, criterion 7). */
export interface TurnRow {
  turnId: string
  /** The host's own count of this session's turns, from 1. */
  number: number
  sessionId: string
  incarnationId: string | null
  /** The host's reading of the terminal's foreground process. */
  foreground: string
  app: string
  appVersion: string | null
  conversation: string | null
  /** The turn's id where the app gives one. */
  appTurnId: string | null
  /** The folder the event named. */
  namedFolder: string | null
  workTree: string | null
  state: TurnState
  endKind: string | null
  startedAt: string
  endedAt: string | null
  totalsState: TurnTotalsState
  totals: TurnTotals | null
  /** Why there are no complete totals, in one of the fixed wordings. */
  wording: string | null
  labels: string[]
  before: string | null
  after: string | null
}

/** Bytes to remove: one capture of a session's work tree, or (with `workTree` null) the session's whole store folder. */
export interface TurnRemovalJob {
  jobId: number
  sessionId: string
  workTree: string | null
  captureId: string | null
  createdAt: string
  attempts: number
  lastTriedAt: string | null
}

interface TurnDatabaseRow {
  turn_id: string
  number: number
  session_id: string
  incarnation_id: string | null
  foreground: string
  app: string
  app_version: string | null
  conversation: string | null
  app_turn_id: string | null
  named_folder: string | null
  work_tree: string | null
  state: TurnState
  end_kind: string | null
  started_at: string
  ended_at: string | null
  totals_state: TurnTotalsState
  totals_json: string | null
  wording: string | null
  labels_json: string
  before_capture: string | null
  after_capture: string | null
}

const TURN_SELECT = `SELECT t.*,
    (SELECT capture_id FROM turn_capture_reference r WHERE r.turn_id = t.turn_id AND r.role = 'before') AS before_capture,
    (SELECT capture_id FROM turn_capture_reference r WHERE r.turn_id = t.turn_id AND r.role = 'after') AS after_capture
  FROM turn_record t`

function turnRow(row: TurnDatabaseRow): TurnRow {
  return {
    turnId: row.turn_id, number: row.number, sessionId: row.session_id, incarnationId: row.incarnation_id, foreground: row.foreground,
    app: row.app, appVersion: row.app_version, conversation: row.conversation, appTurnId: row.app_turn_id, namedFolder: row.named_folder,
    workTree: row.work_tree, state: row.state, endKind: row.end_kind, startedAt: row.started_at, endedAt: row.ended_at,
    totalsState: row.totals_state, totals: row.totals_json === null ? null : JSON.parse(row.totals_json) as TurnTotals,
    wording: row.wording, labels: JSON.parse(row.labels_json) as string[], before: row.before_capture, after: row.after_capture
  }
}

/** A published capture gets its row. A capture already recorded is left as it is. */
export function recordTurnCapture(database: DatabaseConnection, capture: TurnCaptureRow): void {
  database.prepare(
    `INSERT OR IGNORE INTO turn_capture(capture_id, session_id, work_tree, scan_started_ms, scan_ended_ms, head_start, head_end, state, bound, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(capture.captureId, capture.sessionId, capture.workTree, capture.scanStartedMs, capture.scanEndedMs, capture.headStart, capture.headEnd,
    capture.state, capture.bound, capture.size)
}

export function getTurnCapture(database: DatabaseConnection, captureId: string): TurnCaptureRow | null {
  const row = database.prepare('SELECT * FROM turn_capture WHERE capture_id = ?').get(captureId) as {
    capture_id: string; session_id: string; work_tree: string; scan_started_ms: number; scan_ended_ms: number
    head_start: string | null; head_end: string | null; state: 'whole' | 'incomplete'; bound: string | null; size: number
  } | undefined
  return row ? {
    captureId: row.capture_id, sessionId: row.session_id, workTree: row.work_tree, scanStartedMs: row.scan_started_ms, scanEndedMs: row.scan_ended_ms,
    headStart: row.head_start, headEnd: row.head_end, state: row.state, bound: row.bound, size: row.size
  } : null
}

/**
 * Writes a turn whole, new or again, with the captures it needs. `captures` are published captures that
 * get their rows in this same transaction: a capture's row never exists without a turn that refers to
 * it, so the sweep cannot take a capture between its row and its turn.
 */
export function putTurn(database: DatabaseConnection, p: { turn: TurnRow; captures?: TurnCaptureRow[] }): void {
  const { turn } = p
  for (const capture of p.captures ?? []) recordTurnCapture(database, capture)
  database.prepare(
    `INSERT INTO turn_record(turn_id, number, session_id, incarnation_id, foreground, app, app_version, conversation, app_turn_id, named_folder,
       work_tree, state, end_kind, started_at, ended_at, totals_state, totals_json, wording, labels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id) DO UPDATE SET
       incarnation_id = excluded.incarnation_id, foreground = excluded.foreground, app = excluded.app, app_version = excluded.app_version,
       conversation = excluded.conversation, app_turn_id = excluded.app_turn_id, named_folder = excluded.named_folder,
       work_tree = excluded.work_tree, state = excluded.state, end_kind = excluded.end_kind, started_at = excluded.started_at,
       ended_at = excluded.ended_at, totals_state = excluded.totals_state, totals_json = excluded.totals_json, wording = excluded.wording,
       labels_json = excluded.labels_json`
  ).run(turn.turnId, turn.number, turn.sessionId, turn.incarnationId, turn.foreground, turn.app, turn.appVersion, turn.conversation,
    turn.appTurnId, turn.namedFolder, turn.workTree, turn.state, turn.endKind, turn.startedAt, turn.endedAt, turn.totalsState,
    turn.totals === null ? null : JSON.stringify(turn.totals), turn.wording, JSON.stringify(turn.labels))
  database.prepare('DELETE FROM turn_capture_reference WHERE turn_id = ?').run(turn.turnId)
  const refer = database.prepare('INSERT INTO turn_capture_reference(turn_id, role, capture_id) VALUES (?, ?, ?)')
  if (turn.before !== null) refer.run(turn.turnId, 'before', turn.before)
  if (turn.after !== null) refer.run(turn.turnId, 'after', turn.after)
}

export function getTurn(database: DatabaseConnection, turnId: string): TurnRow | null {
  const row = database.prepare(`${TURN_SELECT} WHERE t.turn_id = ?`).get(turnId) as TurnDatabaseRow | undefined
  return row ? turnRow(row) : null
}

/** A session's kept turns, newest first. */
export function listTurns(database: DatabaseConnection, p: { sessionId: string; limit: number }): TurnRow[] {
  return (database.prepare(`${TURN_SELECT} WHERE t.session_id = ? ORDER BY t.number DESC LIMIT ?`)
    .all(p.sessionId, Math.max(1, Math.min(500, Math.trunc(p.limit)))) as TurnDatabaseRow[]).map(turnRow)
}

/** The number the session's next turn gets. */
export function nextTurnNumber(database: DatabaseConnection, sessionId: string): number {
  const row = database.prepare('SELECT COALESCE(MAX(number), 0) AS last FROM turn_record WHERE session_id = ?').get(sessionId) as { last: number }
  return row.last + 1
}

/** Turns stored as open or provisional: after a restart nobody will end them. */
export function listUnclosedTurns(database: DatabaseConnection): TurnRow[] {
  return (database.prepare(`${TURN_SELECT} WHERE t.state <> 'closed' ORDER BY t.session_id, t.number`).all() as TurnDatabaseRow[]).map(turnRow)
}

export interface TurnSweepResult {
  /** Turns whose time had passed, removed whole. */
  turns: number
  /** Captures no kept turn refers to; each left a job for its bytes. */
  captures: number
}

/**
 * What the keep rule removes now, in one transaction: every turn that ended (or, without an end,
 * started) more than `keepDays` days ago, and every capture no kept turn refers to, each with a job
 * for its bytes. `keepDays` is the owner's confirmed Keep agent history limit: `null` (Never) or
 * `undefined` (nothing confirmed yet) keeps every turn, and a shorter limit he picked but has not
 * confirmed is not passed here at all.
 */
export function sweepTurns(database: DatabaseConnection, p: { now: string; keepDays: number | null | undefined }): TurnSweepResult {
  let turns = 0
  if (typeof p.keepDays === 'number') {
    const cutoff = new Date(Date.parse(p.now) - p.keepDays * DAY_MS).toISOString()
    const expired = (database.prepare('SELECT turn_id FROM turn_record WHERE COALESCE(ended_at, started_at) <= ?').all(cutoff) as Array<{ turn_id: string }>)
    const dropReferences = database.prepare('DELETE FROM turn_capture_reference WHERE turn_id = ?')
    const dropTurn = database.prepare('DELETE FROM turn_record WHERE turn_id = ?')
    for (const { turn_id: turnId } of expired) {
      dropReferences.run(turnId)
      dropTurn.run(turnId)
    }
    turns = expired.length
  }
  const unused = database.prepare(
    `SELECT capture_id, session_id, work_tree FROM turn_capture
     WHERE NOT EXISTS (SELECT 1 FROM turn_capture_reference r WHERE r.capture_id = turn_capture.capture_id)
     ORDER BY capture_id`
  ).all() as Array<{ capture_id: string; session_id: string; work_tree: string }>
  const dropCapture = database.prepare('DELETE FROM turn_capture WHERE capture_id = ?')
  const job = database.prepare('INSERT INTO turn_removal_job(session_id, work_tree, capture_id, created_at) VALUES (?, ?, ?, ?)')
  for (const capture of unused) {
    dropCapture.run(capture.capture_id)
    job.run(capture.session_id, capture.work_tree, capture.capture_id, p.now)
  }
  return { turns, captures: unused.length }
}

/**
 * A session is being deleted: its turns, their references and its captures go now, in the caller's
 * transaction, with one job for the session's whole store folder. The job is written whether or not
 * a row was found: after a database restore the folder may hold captures no row names.
 */
export function deleteSessionTurns(database: DatabaseConnection, sessionId: string, now: string): void {
  database.prepare('DELETE FROM turn_capture_reference WHERE turn_id IN (SELECT turn_id FROM turn_record WHERE session_id = ?)').run(sessionId)
  database.prepare('DELETE FROM turn_capture_reference WHERE capture_id IN (SELECT capture_id FROM turn_capture WHERE session_id = ?)').run(sessionId)
  database.prepare('DELETE FROM turn_record WHERE session_id = ?').run(sessionId)
  database.prepare('DELETE FROM turn_capture WHERE session_id = ?').run(sessionId)
  // A capture's job is covered by the folder's: the whole folder goes.
  database.prepare('DELETE FROM turn_removal_job WHERE session_id = ?').run(sessionId)
  database.prepare('INSERT INTO turn_removal_job(session_id, work_tree, capture_id, created_at) VALUES (?, NULL, NULL, ?)').run(sessionId, now)
}

/** Jobs that wait, oldest first. */
export function listTurnRemovalJobs(database: DatabaseConnection): TurnRemovalJob[] {
  return (database.prepare('SELECT * FROM turn_removal_job ORDER BY job_id').all() as Array<{
    job_id: number; session_id: string; work_tree: string | null; capture_id: string | null; created_at: string; attempts: number; last_tried_at: string | null
  }>).map((row) => ({
    jobId: row.job_id, sessionId: row.session_id, workTree: row.work_tree, captureId: row.capture_id, createdAt: row.created_at,
    attempts: row.attempts, lastTriedAt: row.last_tried_at
  }))
}

/** The bytes a job named are gone. */
export function finishTurnRemovalJob(database: DatabaseConnection, jobId: number): void {
  database.prepare('DELETE FROM turn_removal_job WHERE job_id = ?').run(jobId)
}

/** A removal that failed stays, to be tried again; only how often and when is kept, never the error's words. */
export function failTurnRemovalJob(database: DatabaseConnection, p: { jobId: number; now: string }): void {
  database.prepare('UPDATE turn_removal_job SET attempts = attempts + 1, last_tried_at = ? WHERE job_id = ?').run(p.now, p.jobId)
}

/** Sessions with a removal that waits: their turn changes dialog says "Removal pending". */
export function turnRemovalPendingSessions(database: DatabaseConnection): string[] {
  return (database.prepare('SELECT DISTINCT session_id FROM turn_removal_job ORDER BY session_id').all() as Array<{ session_id: string }>)
    .map((row) => row.session_id)
}

/** Every capture a row names, per session; a published capture that is not among them is left to its own time. */
export function namedTurnCaptures(database: DatabaseConnection): Array<{ sessionId: string; captureId: string }> {
  return (database.prepare('SELECT session_id, capture_id FROM turn_capture ORDER BY session_id, capture_id').all() as Array<{ session_id: string; capture_id: string }>)
    .map((row) => ({ sessionId: row.session_id, captureId: row.capture_id }))
}

export const TURN_OPERATIONS = Object.freeze({
  getTurnCapture,
  putTurn,
  getTurn,
  listTurns,
  nextTurnNumber,
  listUnclosedTurns,
  sweepTurns,
  listTurnRemovalJobs,
  finishTurnRemovalJob,
  failTurnRemovalJob,
  turnRemovalPendingSessions,
  namedTurnCaptures
})
