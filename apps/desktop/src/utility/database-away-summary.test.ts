// MODULE: database-away-summary.test.ts - one away period's activity and decisions, bounded and period-aware (Story 76.6)
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeAway } from './database-away-store'
import { AWAY_ACTIVITY_LIMITS, awaySummaryData, type AwaySummaryCall } from './database-away-summary'
import { recordDecision } from './database-decision-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-10-16T19:10:00.000Z'
const IN = '2026-10-16T22:00:00.000Z'
const BEFORE = '2026-10-16T18:00:00.000Z'
const T1 = '2026-10-17T04:40:00.000Z'
let database: DatabaseConnection
let turnNumber = 0

function addSession(id: string, position: number): void {
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, ?)`
  ).run(id, DEFAULT_WORKSPACE_ID, `Name ${id}`, T0, position)
}
function addTurn(sessionId: string, endedAt: string, totals: { state: string; files: number | null }): void {
  turnNumber += 1
  database.prepare(
    `INSERT INTO turn_record(turn_id, number, session_id, foreground, app, state, started_at, ended_at, totals_state, totals_json)
     VALUES (?, ?, ?, 'claude', 'claude', 'closed', ?, ?, ?, ?)`
  ).run(`t${turnNumber}`, turnNumber, sessionId, endedAt, endedAt, totals.state, totals.files === null ? null : JSON.stringify({ files: totals.files, added: 1, removed: 0 }))
}
function addFile(id: string, sessionId: string, name: string, createdAt: string, state = 'ready'): void {
  database.prepare(
    `INSERT INTO artifact(artifact_id, session_id, direction, source, original_name, media_type, byte_length, sha256, stored_path, state, created_at)
     VALUES (?, ?, 'output', 'agent', ?, 'text/plain', 1, ?, '/x', ?, ?)`
  ).run(id, sessionId, name, 'a'.repeat(64), state, createdAt)
}
function addMessage(id: string, from: string, to: string, state: string, sentAt: string, handoff = false): void {
  database.prepare(
    `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text, sent_at, expires_at, state)
     VALUES (?, ?, ?, ?, '/w', 'stamp', 'text', ?, '2026-10-20T00:00:00.000Z', ?)`
  ).run(id, DEFAULT_WORKSPACE_ID, from, to, sentAt, state)
  if (handoff) {
    database.prepare(`INSERT INTO input_draft(draft_id, session_id, origin, origin_key, state, created_at, updated_at) VALUES (?, ?, 'handoff', ?, 'draft', ?, ?)`)
      .run(`d-${id}`, to, `handoff-message:${id}`, sentAt, sentAt)
  }
}

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, T0)
  addSession('s2', 1); addSession('s1', 0)
  turnNumber = 0
})
afterEach(() => database.close())

const call = (over: Partial<AwaySummaryCall> = {}): AwaySummaryCall => ({ periodId: 'p', since: T0, until: T1, now: T1, keepDays: 30, ...over })

describe('awaySummaryData (Story 76.6 AC1-AC2)', () => {
  it('counts the period\'s turns, published files, messages, handoffs and exits per session, and nothing outside the period', () => {
    addTurn('s1', IN, { state: 'complete', files: 2 })
    addTurn('s1', IN, { state: 'complete', files: 0 })
    addTurn('s1', IN, { state: 'partial', files: null })
    addTurn('s1', BEFORE, { state: 'complete', files: 3 })
    addFile('a1', 's1', 'report.md', IN); addFile('a2', 's1', 'gone.md', IN, 'missing'); addFile('a3', 's1', 'old.md', BEFORE)
    addMessage('m1', 's1', 's2', 'printed', IN); addMessage('m2', 's1', 's2', 'waiting', IN); addMessage('m3', 's1', 's2', 'taken', IN)
    addMessage('h1', 's1', 's2', 'printed', IN, true); addMessage('m4', 's1', 's2', 'printed', BEFORE)
    database.prepare(`INSERT INTO process_incarnation(incarnation_id, session_id, process_start_identity, state, started_at, exited_at, exit_code) VALUES ('i', 's2', 'x', 'exited', ?, ?, 1)`).run(T0, IN)
    const data = awaySummaryData(database, call())
    expect(data.order).toEqual(['s1', 's2'])
    const s1 = data.activity!.sessions.find((session) => session.sessionId === 's1')!
    expect(s1).toMatchObject({
      app: 'claude', turnsEnded: 3, turnsWithChanges: 1, changesAtLeast: true, published: ['report.md'], publishedCount: 1,
      messages: { printed: 1, queued: 1, uncertain: 1, expired: 0 }, handoffs: [{ receiver: 'Name s2', state: 'printed' }]
    })
    expect(data.activity!.sessions.find((session) => session.sessionId === 's2')!.exits).toEqual([{ at: IN, code: 1, signal: null }])
    expect(data.activity!.gaps).toEqual({})
  })

  it('says when a source was cut and when the period is older than what is retained', () => {
    for (let index = 0; index <= AWAY_ACTIVITY_LIMITS.files; index += 1) addFile(`f${index}`, 's1', `f${index}`, IN)
    const data = awaySummaryData(database, call())
    expect(data.activity!.gaps.files).toEqual({ kind: 'truncated', at: AWAY_ACTIVITY_LIMITS.files })
    expect(data.activity!.sessions[0]!.publishedCount).toBe(AWAY_ACTIVITY_LIMITS.files)
    const old = awaySummaryData(database, call({ now: '2026-12-01T00:00:00.000Z', keepDays: 30 }))
    expect(old.activity!.gaps).toMatchObject({ turns: { kind: 'expired' }, messages: { kind: 'expired' } })
  })

  it('reads the summary so far while he is away, and the period\'s decisions with the names of the files they reference', () => {
    const period = changeAway(database, { to: 'away', source: 'app' }, T0).record
    addFile('a1', 's1', 'report.md', IN)
    recordDecision(database, {
      sessionId: 's1', incarnationId: 'i', key: 'k', expectedRevision: 1, provenance: { agentCli: 'claude', conversation: 'c' },
      payload: { choice: 'c', reason: 'r', affects: 'a', reverse: 'v', depends: [], references: [{ kind: 'artifact', id: 'a1' }] }
    }, IN)
    addTurn('s1', IN, { state: 'complete', files: 1 })
    const data = awaySummaryData(database, call({ periodId: period.periodId!, until: null, now: '2026-10-16T23:00:00.000Z' }))
    expect(data.decisions).toMatchObject({ complete: true, decisions: [{ key: 'k' }] })
    expect(data.artifactNames).toEqual({ a1: 'report.md' })
    expect(data.activity!.sessions[0]!.turnsEnded).toBe(1)
  })
})
