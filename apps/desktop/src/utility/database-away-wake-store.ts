// MODULE: database-away-wake-store.ts - Story 113.6: the Away wake's per-tick facts kept text-free, and the night's account read back
import {
  AWAY_WAKE_LIMITS,
  awayNightAccount,
  type AwayNight,
  type AwayStopReport,
  type AwayWakeDecision,
  type AwayWakeDecisionRow,
  type AwayWakeReason,
  type AwayWakeTick
} from '@bmn/protocol'
import { readGrantRow } from './database-grant-store'
import type { DatabaseConnection } from './database-initialization'

/**
 * Keeps one sweep's tick and its decisions (113.6 AC1). A later sweep of the same tick adds the sessions it decided and
 * keeps the tick swept if any sweep of it was. A session decided twice in one tick keeps its first row. Past the bounds
 * the oldest rows go: per session and period, per period, and whole periods beyond the newest ones.
 */
export function recordAwayWake(database: DatabaseConnection, tick: AwayWakeTick, decisions: readonly AwayWakeDecision[]): { recorded: number } {
  let recorded = 0
  database.transaction(() => {
    database.prepare(`INSERT INTO away_wake_tick(period_id, tick, at, process_started_at, state, sessions_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_id, tick) DO UPDATE SET sessions_seen = sessions_seen + excluded.sessions_seen,
        state = CASE WHEN state = 'swept' OR excluded.state = 'swept' THEN 'swept' ELSE 'unreadable' END`)
      .run(tick.periodId, tick.tick, tick.at, tick.processStartedAt, tick.state, tick.sessionsSeen)
    const insert = database.prepare(`INSERT INTO away_wake_decision(period_id, tick, session_id, incarnation_id, app, foreground, generation,
      prompt, outcome, reason_code, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(period_id, tick, session_id) DO NOTHING`)
    for (const decision of decisions) {
      recorded += Number(insert.run(tick.periodId, tick.tick, decision.sessionId, decision.incarnationId, decision.app,
        decision.foreground === null ? null : decision.foreground ? 1 : 0, decision.generation, decision.prompt, decision.outcome,
        decision.reason, tick.at).changes)
    }
    for (const decision of decisions) {
      database.prepare(`DELETE FROM away_wake_decision WHERE rowid IN (SELECT rowid FROM away_wake_decision WHERE period_id = ? AND session_id = ?
        ORDER BY tick DESC LIMIT -1 OFFSET ?)`).run(tick.periodId, decision.sessionId, AWAY_WAKE_LIMITS.perSession)
    }
    database.prepare(`DELETE FROM away_wake_decision WHERE rowid IN (SELECT rowid FROM away_wake_decision WHERE period_id = ?
      ORDER BY tick DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(tick.periodId, AWAY_WAKE_LIMITS.perPeriod)
    const kept = `SELECT period_id FROM away_wake_tick GROUP BY period_id ORDER BY MAX(at) DESC LIMIT ${AWAY_WAKE_LIMITS.periods}`
    database.prepare(`DELETE FROM away_wake_decision WHERE period_id NOT IN (${kept})`).run()
    database.prepare(`DELETE FROM away_wake_tick WHERE period_id NOT IN (${kept})`).run()
  })()
  return { recorded }
}

export interface AwayNightCall {
  periodId: string
  since: string
  until: string
  everyMs: number
  hostStartedAt?: string
}

/**
 * The night of one period (113.6 AC2–AC3): its kept ticks and decisions, and every agent session BMN ran in the period
 * (a bound conversation of a woken app, or a turn one of them ended), so a session no tick decided reads unknown.
 */
export function awayNightData(database: DatabaseConnection, call: AwayNightCall): AwayNight {
  const ticks = (database.prepare(`SELECT period_id, tick, at, process_started_at, state, sessions_seen FROM away_wake_tick
    WHERE period_id = ? ORDER BY tick`).all(call.periodId) as Array<{
    period_id: string; tick: number; at: string; process_started_at: string; state: 'swept' | 'unreadable'; sessions_seen: number
  }>).map((row): AwayWakeTick => ({ periodId: row.period_id, tick: row.tick, at: row.at, processStartedAt: row.process_started_at,
    state: row.state, sessionsSeen: row.sessions_seen }))
  const rows = database.prepare(`SELECT period_id, tick, session_id, incarnation_id, app, foreground, generation, prompt, outcome, reason_code, at
    FROM away_wake_decision WHERE period_id = ? ORDER BY tick, session_id`).all(call.periodId) as Array<{
    period_id: string; tick: number; session_id: string; incarnation_id: string; app: string; foreground: number | null; generation: number | null
    prompt: AwayWakeDecision['prompt']; outcome: AwayWakeDecision['outcome']; reason_code: AwayWakeReason | null; at: string
  }>
  const decisions = rows.map((row): AwayWakeDecisionRow => ({
    periodId: row.period_id, tick: row.tick, at: row.at, sessionId: row.session_id, incarnationId: row.incarnation_id, app: row.app,
    foreground: row.foreground === null ? null : row.foreground === 1, generation: row.generation, prompt: row.prompt, outcome: row.outcome,
    reason: row.reason_code
  }))
  const sessions = database.prepare(`SELECT session_id, MAX(app) AS app FROM (
      SELECT i.session_id, b.agent_cli AS app FROM process_incarnation i JOIN conversation_binding b ON b.session_id = i.session_id
      WHERE b.status = 'bound' AND b.agent_cli IN ('claude', 'codex', 'opencode')
        AND i.started_at < ? AND (i.exited_at IS NULL OR i.exited_at > ?)
      UNION ALL
      SELECT session_id, app FROM turn_record WHERE app IN ('claude', 'codex', 'opencode') AND ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?
    ) GROUP BY session_id ORDER BY session_id`).all(call.until, call.since, call.since, call.until) as Array<{ session_id: string; app: string | null }>
  const perSession = new Map<string, number>()
  for (const row of rows) perSession.set(row.session_id, (perSession.get(row.session_id) ?? 0) + 1)
  // A bound reached may have dropped older rows: the account says so rather than reading them as never decided.
  const complete = rows.length < AWAY_WAKE_LIMITS.perPeriod && [...perSession.values()].every((count) => count < AWAY_WAKE_LIMITS.perSession)
  const grant = readGrantRow(database)
  const period = grant.state === 'read' ? grant.record.periods.find(item => item.periodId === call.periodId) : undefined
  const reports = new Map<string, AwayStopReport>()
  for (const report of period?.reports ?? []) {
    if (report.kind !== 'stopped' || report.cause === undefined || report.at < call.since || report.at > call.until) continue
    reports.set(report.sessionId, { runId: report.runId, cause: report.cause, at: report.at, text: report.text })
    if (!sessions.some(session => session.session_id === report.sessionId)) sessions.push({ session_id: report.sessionId, app: null })
  }
  const night = awayNightAccount({ ...call, ticks, decisions, sessions: sessions.map((row) => ({ sessionId: row.session_id, app: row.app })), complete })
  const lastTurn = database.prepare(`SELECT started_at, ended_at, end_kind, incarnation_id FROM turn_record
    WHERE session_id = ? AND started_at < ? ORDER BY started_at DESC, number DESC LIMIT 1`)
  const changedProcess = database.prepare(`SELECT 1 FROM process_incarnation WHERE session_id = ?
    AND (started_at > ? AND started_at < ? OR incarnation_id = ? AND exited_at > ? AND exited_at < ?) LIMIT 1`)
  const lastProgress = database.prepare(`SELECT state, observed_at FROM progress_observation
    WHERE session_id = ? AND incarnation_id = ? AND observed_at >= ? AND received_at <= ?
    ORDER BY observed_at DESC, received_at DESC LIMIT 1`)
  const hostStarts = [...ticks.map(tick => tick.processStartedAt), ...(call.hostStartedAt === undefined ? [] : [call.hostStartedAt])]
  for (const session of [...night.woken, ...night.skipped, ...night.missed, ...night.unknown]) {
    const turn = lastTurn.get(session.sessionId, call.until) as {
      started_at: string; ended_at: string | null; end_kind: string | null; incarnation_id: string | null
    } | undefined
    const reported = reports.get(session.sessionId)
    session.stopReport = reported !== undefined && (turn === undefined || reported.at >= turn.started_at) ? reported : null
    const progress = turn?.incarnation_id ? lastProgress.get(session.sessionId, turn.incarnation_id, turn.started_at, call.until) as
      { state: string; observed_at: string } | undefined : undefined
    if (progress && (progress.state === 'claimed-done' || progress.state === 'verified') &&
      (session.stopReport === null || session.stopReport.at <= progress.observed_at)) {
      session.stopReport = null
      session.restedFrom = null
      session.restedMs = null
      continue
    }
    const finished = turn?.end_kind === 'finished' && turn.ended_at !== null && turn.ended_at <= call.until ? turn.ended_at : null
    const interrupted = finished === null || hostStarts.some(at => at > finished && at < call.until) ||
      changedProcess.get(session.sessionId, finished, call.until, turn?.incarnation_id ?? null, finished, call.until) !== undefined ||
      night.unknownSpans.some(span => span.to > finished) ||
      (session.at !== null && session.at > finished && night.woken.includes(session))
    const restedFrom = interrupted || finished === null ? null : finished < call.since ? call.since : finished
    session.restedFrom = restedFrom
    session.restedMs = restedFrom === null ? null : Date.parse(call.until) - Date.parse(restedFrom)
  }
  return night
}

export const AWAY_WAKE_OPERATIONS = Object.freeze({ recordAwayWake, awayNightData })
