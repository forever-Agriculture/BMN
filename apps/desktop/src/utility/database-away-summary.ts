// MODULE: database-away-summary.ts - one away period's retained activity and decisions, read in one bounded transaction (Story 76.6)
import {
  sessionHandoffState,
  type AwayPeriodActivity,
  type AwaySessionActivity,
  type AwaySourceGap,
  type AwaySourceName,
  type AwaySummaryPayload,
  type AwaySummarySession
} from '@bmn/protocol'
import { listPeriodDecisions } from './database-decision-store'
import { readGrantRow } from './database-grant-store'
import type { DatabaseConnection } from './database-initialization'

/** The most rows each source reads for one period; a source cut there says so. */
export const AWAY_ACTIVITY_LIMITS = Object.freeze({ turns: 500, files: 200, messages: 500, exits: 200 })

export interface AwaySummaryCall {
  periodId: string
  since: string
  /** The period's end; null while he is still away (the summary so far). */
  until: string | null
  now: string
  /** The owner's confirmed Keep agent history days: turns and messages older than that are no longer retained. */
  keepDays: number | null
}

const HANDOFF_KEY = 'handoff-message:'

/**
 * Story 76.6 AC1–AC2: what BMN holds for one period, read in one transaction so no source moves under another: the
 * period's decision records, per session the turns that ended, the files it published, the messages and handoffs it
 * sent with where each stands, and the exits a record proves; with the sessions the summary may name, in sidebar order,
 * and the kept grant periods up to this one (Story 84.7). Each source is bounded and says when it was cut or is no longer
 * retained; counts are never summed past a cut.
 */
export function awaySummaryData(database: DatabaseConnection, call: AwaySummaryCall): Omit<AwaySummaryPayload, 'away' | 'wentOn'> {
  const until = call.until ?? call.now
  const gaps: Partial<Record<AwaySourceName, AwaySourceGap>> = {}
  if (call.keepDays !== null && Date.parse(call.since) < Date.parse(call.now) - call.keepDays * 86_400_000) {
    gaps.turns = { kind: 'expired' }
    gaps.messages = { kind: 'expired' }
  }
  const activity = new Map<string, AwaySessionActivity>()
  const of = (sessionId: string): AwaySessionActivity => {
    let entry = activity.get(sessionId)
    if (!entry) {
      entry = {
        sessionId, app: null, turnsEnded: 0, turnsWithChanges: 0, changesAtLeast: false, published: [], publishedCount: 0, asksCompleted: [],
        messages: { printed: 0, queued: 0, uncertain: 0, expired: 0 }, handoffs: [], exits: []
      }
      activity.set(sessionId, entry)
    }
    return entry
  }

  const turns = database.prepare(
    `SELECT session_id, app, totals_state, totals_json FROM turn_record
     WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ? ORDER BY ended_at LIMIT ?`
  ).all(call.since, until, AWAY_ACTIVITY_LIMITS.turns + 1) as Array<{ session_id: string; app: string; totals_state: string; totals_json: string | null }>
  if (turns.length > AWAY_ACTIVITY_LIMITS.turns) gaps.turns = { kind: 'truncated', at: AWAY_ACTIVITY_LIMITS.turns }
  let partial = 0
  for (const turn of turns.slice(0, AWAY_ACTIVITY_LIMITS.turns)) {
    const entry = of(turn.session_id)
    entry.turnsEnded += 1
    if (turn.app && turn.app !== 'unknown') entry.app = turn.app
    let files: number
    try { files = turn.totals_json === null ? 0 : Number((JSON.parse(turn.totals_json) as { files?: unknown }).files) || 0 } catch { files = 0 }
    if (files > 0) entry.turnsWithChanges += 1
    // A turn whose changes were not captured whole says its count is a floor, and the source says so in its gap line;
    // 'none' is capture unavailable (switched off, overlapped, a scan missing), never evidence of no change (the consultant).
    if (turn.totals_state !== 'complete') { entry.changesAtLeast = true; partial += 1 }
  }
  if (partial > 0) gaps.changes = { kind: 'partial', read: Math.min(turns.length, AWAY_ACTIVITY_LIMITS.turns) - partial, skipped: partial }

  const files = database.prepare(
    `SELECT session_id, original_name FROM artifact
     WHERE direction = 'output' AND state = 'ready' AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid LIMIT ?`
  ).all(call.since, until, AWAY_ACTIVITY_LIMITS.files + 1) as Array<{ session_id: string; original_name: string }>
  if (files.length > AWAY_ACTIVITY_LIMITS.files) gaps.files = { kind: 'truncated', at: AWAY_ACTIVITY_LIMITS.files }
  for (const file of files.slice(0, AWAY_ACTIVITY_LIMITS.files)) {
    const entry = of(file.session_id)
    entry.publishedCount += 1
    if (entry.published.length < 3) entry.published.push(file.original_name)
  }

  const messages = database.prepare(
    `SELECT m.sender_session_id, m.receiver_session_id, m.state, m.expires_at,
       EXISTS (SELECT 1 FROM input_draft d WHERE d.origin_key = '${HANDOFF_KEY}' || m.message_id) AS handoff,
       (SELECT name FROM session WHERE session_id = m.receiver_session_id) AS receiver
     FROM session_message m WHERE m.sent_at >= ? AND m.sent_at < ? ORDER BY m.sent_at, m.rowid LIMIT ?`
  ).all(call.since, until, AWAY_ACTIVITY_LIMITS.messages + 1) as Array<{
    sender_session_id: string; receiver_session_id: string; state: 'waiting' | 'paste-uncertain' | 'pasted' | 'taken' | 'printed'; expires_at: string
    handoff: number; receiver: string | null
  }>
  if (messages.length > AWAY_ACTIVITY_LIMITS.messages) gaps.messages = { kind: 'truncated', at: AWAY_ACTIVITY_LIMITS.messages }
  const nowMs = Date.parse(call.now)
  for (const message of messages.slice(0, AWAY_ACTIVITY_LIMITS.messages)) {
    const entry = of(message.sender_session_id)
    const state = sessionHandoffState({ state: message.state, expiresAt: message.expires_at }, nowMs)
    if (message.handoff) entry.handoffs.push({ receiver: message.receiver ?? 'a session BMN no longer holds', state })
    else entry.messages[state] += 1
  }

  const exits = database.prepare(
    `SELECT session_id, exited_at, exit_code, exit_signal FROM process_incarnation
     WHERE state = 'exited' AND exited_at IS NOT NULL AND exited_at >= ? AND exited_at < ? ORDER BY exited_at LIMIT ?`
  ).all(call.since, until, AWAY_ACTIVITY_LIMITS.exits + 1) as Array<{ session_id: string; exited_at: string; exit_code: number | null; exit_signal: number | null }>
  if (exits.length > AWAY_ACTIVITY_LIMITS.exits) gaps.exits = { kind: 'truncated', at: AWAY_ACTIVITY_LIMITS.exits }
  for (const exit of exits.slice(0, AWAY_ACTIVITY_LIMITS.exits)) of(exit.session_id).exits.push({ at: exit.exited_at, code: exit.exit_code, signal: exit.exit_signal })

  const decisions = listPeriodDecisions(database, call.periodId)
  const artifactName = database.prepare('SELECT original_name FROM artifact WHERE artifact_id = ?')
  const artifactNames: Record<string, string> = {}
  for (const record of decisions.decisions) {
    for (const reference of record.references) {
      if (reference.kind !== 'artifact' || !reference.valid) continue
      const row = artifactName.get(reference.id) as { original_name: string } | undefined
      if (row) artifactNames[reference.id] = row.original_name
    }
  }

  const sessionRows = database.prepare(
    `SELECT s.session_id, s.name, s.archived_at, w.name AS workspace FROM session s JOIN workspace w ON w.workspace_id = s.workspace_id
     ORDER BY CASE WHEN w.archived_at IS NULL THEN 0 ELSE 1 END, w.position, w.workspace_id, s.position, s.created_at, s.session_id`
  ).all() as Array<{ session_id: string; name: string; archived_at: string | null; workspace: string }>
  const sessions: AwaySummarySession[] = sessionRows.map((row) => ({ sessionId: row.session_id, name: row.name, workspace: row.workspace, archivedAt: row.archived_at }))
  const result: AwayPeriodActivity = { sessions: [...activity.values()], gaps }
  const grantRead = readGrantRow(database)
  const kept = grantRead.state === 'read' ? grantRead.record.periods : []
  const upTo = kept.findIndex((period) => period.periodId === call.periodId)
  const grants = grantRead.state === 'unknown' ? null : { periods: upTo < 0 ? [] : kept.slice(0, upTo + 1) }
  return { sessions, order: sessions.map((session) => session.sessionId), decisions, activity: result, artifactNames, grants }
}

/** Every session's name by id, archived ones included, for the `/back` reply's Waiting on you. */
export function awaySessionNames(database: DatabaseConnection): Record<string, string> {
  const rows = database.prepare('SELECT session_id, name FROM session').all() as Array<{ session_id: string; name: string }>
  return Object.fromEntries(rows.map((row) => [row.session_id, row.name]))
}

export const AWAY_SUMMARY_OPERATIONS = Object.freeze({ awaySummaryData, awaySessionNames })
