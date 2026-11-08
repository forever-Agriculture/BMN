// MODULE: database-away-wake-store.test.ts - Story 113.6: the Away wake's facts kept per tick, bounded, and the night read back
import { createRequire } from 'node:module'
import { AWAY_WAKE_LIMITS, type AwayWakeDecision, type AwayWakeTick } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { awayNightData, recordAwayWake } from './database-away-wake-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T = Date.parse('2026-11-08T22:00:00.000Z')
const HOUR = 3_600_000
const EVERY = 2 * HOUR
const at = (ms: number): string => new Date(ms).toISOString()
let database: DatabaseConnection
beforeEach(() => { database = new BetterSqlite3(':memory:'); initializeDatabase(database, at(T - HOUR)) })
afterEach(() => database.close())

const tick = (n: number, over: Partial<AwayWakeTick> = {}): AwayWakeTick => ({ periodId: 'p1', tick: n, at: at(T + n * EVERY), processStartedAt: at(T - HOUR), state: 'swept', sessionsSeen: 1, ...over })
const decision = (sessionId: string, over: Partial<AwayWakeDecision> = {}): AwayWakeDecision => ({
  sessionId, incarnationId: `inc-${sessionId}`, app: 'claude', foreground: true, generation: 2, prompt: 'busy', outcome: 'skipped', reason: 'prompt-busy', ...over
})
const decisions = () => database.prepare('SELECT * FROM away_wake_decision ORDER BY period_id, tick, session_id').all() as Record<string, unknown>[]
const ticks = () => database.prepare('SELECT * FROM away_wake_tick ORDER BY period_id, tick').all() as Record<string, unknown>[]

function session(sessionId: string, startedAt: number, exitedAt: number | null = null): void {
  database.prepare(`INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
    SELECT ?, workspace_id, ?, '/work', '/bin/bash', '[]', 1, ?, 0 FROM workspace LIMIT 1`).run(sessionId, sessionId, at(startedAt))
  database.prepare(`INSERT INTO process_incarnation(incarnation_id, session_id, process_start_identity, state, started_at, exited_at) VALUES (?, ?, 'x', ?, ?, ?)`)
    .run(`inc-${sessionId}`, sessionId, exitedAt === null ? 'running' : 'exited', at(startedAt), exitedAt === null ? null : at(exitedAt))
}

function agentSession(sessionId: string, app: string, startedAt: number, exitedAt: number | null = null): void {
  session(sessionId, startedAt, exitedAt)
  database.prepare(`INSERT INTO conversation_binding(session_id, agent_cli, status, conversation_reference, capture_route, launch_cwd,
    launch_executable, launch_argv_json, launch_environment_json, detail, captured_at)
    VALUES (?, ?, 'bound', ?, 'hook-session-start', '/work', '/bin/bash', '[]', '{}', '', ?)`).run(sessionId, app, `conversation-${sessionId}`, at(startedAt))
}

describe('recordAwayWake (Story 113.6 AC1)', () => {
  it('keeps the tick and per session the facts that decided it, with no text column', () => {
    expect(recordAwayWake(database, tick(1), [decision('a'), decision('b', { outcome: 'typed', reason: null, prompt: 'idle', foreground: true })])).toEqual({ recorded: 2 })
    expect(ticks()).toEqual([{ period_id: 'p1', tick: 1, at: at(T + EVERY), process_started_at: at(T - HOUR), state: 'swept', sessions_seen: 1 }])
    expect(decisions()[0]).toEqual({ period_id: 'p1', tick: 1, session_id: 'a', incarnation_id: 'inc-a', app: 'claude', foreground: 1, generation: 2,
      prompt: 'busy', outcome: 'skipped', reason_code: 'prompt-busy', at: at(T + EVERY) })
    expect(Object.keys(decisions()[0]!).sort()).toEqual(['app', 'at', 'foreground', 'generation', 'incarnation_id', 'outcome', 'period_id', 'prompt', 'reason_code', 'session_id', 'tick'])
  })

  it('the database refuses a typed row with a reason, a skip without one, and a code it does not know', () => {
    expect(() => recordAwayWake(database, tick(1), [decision('a', { outcome: 'typed' })])).toThrow()
    expect(() => recordAwayWake(database, tick(1), [decision('a', { reason: null })])).toThrow()
    expect(() => recordAwayWake(database, tick(1), [decision('a', { reason: 'made-up' as never })])).toThrow()
    expect(decisions()).toEqual([])
  })

  it('a later sweep of one tick adds its sessions, keeps the first row of a session, and keeps the tick swept', () => {
    recordAwayWake(database, tick(1, { sessionsSeen: 0 }), [])
    recordAwayWake(database, tick(1, { sessionsSeen: 2 }), [decision('a'), decision('b')])
    recordAwayWake(database, tick(1, { state: 'unreadable', sessionsSeen: 1 }), [decision('a', { reason: 'quiet' })])
    expect(ticks()).toEqual([expect.objectContaining({ tick: 1, state: 'swept', sessions_seen: 3 })])
    expect(decisions().map((row) => [row.session_id, row.reason_code])).toEqual([['a', 'prompt-busy'], ['b', 'prompt-busy']])
  })

  it('keeps the newest rows per session and the newest periods', () => {
    for (let n = 1; n <= AWAY_WAKE_LIMITS.perSession + 5; n++) recordAwayWake(database, tick(n), [decision('a')])
    const kept = decisions().map((row) => row.tick as number)
    expect(kept).toHaveLength(AWAY_WAKE_LIMITS.perSession)
    expect(Math.min(...kept)).toBe(6)
    for (let p = 0; p < AWAY_WAKE_LIMITS.periods; p++) recordAwayWake(database, tick(1, { periodId: `q${p}`, at: at(T + (p + 100) * EVERY) }), [decision('a')])
    expect(ticks().some((row) => row.period_id === 'p1')).toBe(false)
    expect(new Set(ticks().map((row) => row.period_id)).size).toBe(AWAY_WAKE_LIMITS.periods)
  })
})

describe('awayNightData (Story 113.6 AC2-AC3)', () => {
  it('reads the night back, with an agent session no tick decided as unknown and a plain shell left out', () => {
    agentSession('woke', 'claude', T - HOUR)
    agentSession('lost', 'codex', T - HOUR)
    agentSession('quiet', 'claude', T + HOUR)
    agentSession('gone', 'codex', T - 3 * HOUR, T - 2 * HOUR)
    session('shell', T)
    recordAwayWake(database, tick(1), [decision('woke', { outcome: 'typed', reason: null, prompt: 'idle' }), decision('lost', { app: 'codex' })])
    recordAwayWake(database, tick(3, { processStartedAt: at(T + 5 * HOUR) }), [decision('lost', { app: 'codex', reason: 'quiet', prompt: null, foreground: null })])
    const night = awayNightData(database, { periodId: 'p1', since: at(T), until: at(T + 7 * HOUR), everyMs: EVERY })
    expect(night.woken.map((row) => row.sessionId)).toEqual(['woke'])
    expect(night.missed).toEqual([{ sessionId: 'lost', app: 'codex', reason: 'prompt-busy', at: at(T + EVERY) }])
    expect(night.unknown).toEqual([{ sessionId: 'quiet', app: 'claude', reason: null, at: null }])
    expect(night.unknownSpans).toEqual([{ from: at(T + 2 * EVERY), to: at(T + 3 * EVERY), why: 'restart' }])
    expect(night.complete).toBe(true)
  })
})
