// MODULE: database-decision-store.test.ts - recorded decisions: key before period, payload checks, outcomes, period query, migration 29 (Story 76.5)
import { createRequire } from 'node:module'
import type { DecisionPayload } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeAway } from './database-away-store'
import { getAttention, listAttention, openAttention, putSettingsSection } from './database-companion-store'
import { DECISION_PERIOD_LIMIT, addDecisionOutcome, listPeriodDecisions, recordDecision, type DecisionRecordCall } from './database-decision-store'
import { purgeExpiredArchives } from './database-archive-purge'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { DATABASE_MIGRATIONS, DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-10-16T19:10:00.000Z'
const T1 = '2026-10-16T21:00:00.000Z'
const T2 = '2026-10-17T04:40:00.000Z'
let database: DatabaseConnection

function addSession(id: string): void {
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, 0)`
  ).run(id, DEFAULT_WORKSPACE_ID, id, T0)
}

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, T0)
  addSession('s1'); addSession('s2')
})
afterEach(() => database.close())

const payload: DecisionPayload = {
  choice: 'Store greetings as a JSON array', reason: 'Nothing in the folder settles it; JSON needs no dependency',
  affects: 'src/store.js and the functions built on it', reverse: 'Replace src/store.js; nothing else reads the file',
  references: [{ kind: 'session', id: 's2' }, { kind: 'artifact', id: 'nope' }, { kind: 'workflow', id: 'dev-auto/epic-76#d1' }], depends: []
}
const call = (over: Partial<DecisionRecordCall> = {}): DecisionRecordCall => ({
  sessionId: 's1', incarnationId: 'i1', key: 'storage-format', payload, provenance: { agentCli: 'claude', conversation: 'c-1' },
  expectedRevision: 1, ...over
})
const away = (now = T0) => changeAway(database, { to: 'away', source: 'app' }, now).record

describe('recordDecision (Story 76.5 AC1-AC2)', () => {
  it('binds a new key to the current period, revision, conversation, process and time, and checks each reference', () => {
    const period = away()
    const { outcome, record } = recordDecision(database, call(), T1)
    expect(outcome).toBe('recorded')
    expect(record).toMatchObject({ key: 'storage-format', periodId: period.periodId, revision: 1, conversation: 'c-1', incarnationId: 'i1', recordedAt: T1, outcomes: [] })
    expect(record.references).toEqual([
      { kind: 'session', id: 's2', valid: true }, { kind: 'artifact', id: 'nope', valid: false }, { kind: 'workflow', id: 'dev-auto/epic-76#d1', valid: false }
    ])
  })

  it('refuses while he is not away and at a stale revision, recording nothing', () => {
    expect(() => recordDecision(database, call({ expectedRevision: 0 }), T1)).toThrow(/not away/)
    away()
    expect(() => recordDecision(database, call({ expectedRevision: 0 }), T1)).toThrow(/revision 1 now/)
    expect(listPeriodDecisions(database, 'any').decisions).toEqual([])
  })

  it('looks the key up before the period: an identical retry returns the first record even after back and a new away', () => {
    away()
    const first = recordDecision(database, call(), T1).record
    changeAway(database, { to: 'back', source: 'app' }, T2)
    changeAway(database, { to: 'away', source: 'app' }, T2)
    expect(recordDecision(database, call({ expectedRevision: 3, provenance: { agentCli: 'claude', conversation: 'c-9' } }), T2)).toEqual({ outcome: 'repeated', record: first })
    expect(() => recordDecision(database, call({ expectedRevision: 3, payload: { ...payload, choice: 'SQLite' } }), T2)).toThrow(/other text/)
  })

  it('keeps each session\'s keys apart', () => {
    away()
    recordDecision(database, call(), T1)
    expect(recordDecision(database, call({ sessionId: 's2' }), T1).outcome).toBe('recorded')
    expect(() => addDecisionOutcome(database, { sessionId: 's2', key: 'other', op: 'o', result: 'done', evidence: [] }, T1)).toThrow(/No decision other/)
  })

  it('is never open, never in the owner\'s list and never blocks a request with the same key', () => {
    away()
    recordDecision(database, call({ key: 'shared' }), T1)
    expect(listAttention(database)).toEqual([])
    const opened = openAttention(database, { sessionId: 's1', incarnationId: 'i1', requestKey: 'decision:shared', kind: 'question', title: 'Q' }, 'r-1', T1)
    expect(getAttention(database, opened.requestId).state).toBe('open')
  })
})

describe('recorded decisions and the archive purge (Story 76.5 consumer audit)', () => {
  it('go with a session the purge deletes, as its other rows do, and stay for a session it keeps', () => {
    const record = away()
    recordDecision(database, call({ key: 'kept' }), T1)
    recordDecision(database, call({ sessionId: 's2', key: 'purged' }), T1)
    putSettingsSection(database, 'archive', { deleteAfterDays: 10 }, T1)
    database.prepare('UPDATE session SET archived_at = ? WHERE session_id = ?').run(T0, 's2')
    expect(purgeExpiredArchives(database, '2026-10-30T00:00:00.000Z').sessionIds).toEqual(['s2'])
    expect(listPeriodDecisions(database, record.periodId!).decisions.map((item) => [item.sessionId, item.key])).toEqual([['s1', 'kept']])
  })
})

describe('addDecisionOutcome (Story 76.5 AC3)', () => {
  it('appends under its own operation key, returns the first append for a retry and refuses other data under the key', () => {
    away()
    recordDecision(database, call(), T1)
    changeAway(database, { to: 'back', source: 'app' }, T2)
    expect(addDecisionOutcome(database, { sessionId: 's1', key: 'storage-format', op: 'first-try', result: 'failed', evidence: [] }, T1).outcome).toBe('appended')
    const later = addDecisionOutcome(database, { sessionId: 's1', key: 'storage-format', op: 'second-try', result: 'done', evidence: [] }, T2)
    expect(later.record.outcomes.map((o) => [o.op, o.result, o.reporter])).toEqual([['first-try', 'failed', 'agent'], ['second-try', 'done', 'agent']])
    expect(addDecisionOutcome(database, { sessionId: 's1', key: 'storage-format', op: 'first-try', result: 'failed', evidence: [] }, T2).outcome).toBe('repeated')
    expect(() => addDecisionOutcome(database, { sessionId: 's1', key: 'storage-format', op: 'first-try', result: 'done', evidence: [] }, T2)).toThrow(/other data/)
    expect(later.record.periodId).not.toBeNull()
    expect(() => addDecisionOutcome(database, { sessionId: 's1', key: 'storage-format', op: 'x', result: 'done', evidence: ['not-mine'] }, T2)).toThrow(/not a ready file/)
  })
})

describe('listPeriodDecisions (Story 76.5 AC6)', () => {
  it('returns one period\'s decisions, oldest first, and says when more were retained than it lists', () => {
    const first = away()
    recordDecision(database, call({ key: 'a' }), T1)
    changeAway(database, { to: 'back', source: 'app' }, T2)
    const second = changeAway(database, { to: 'away', source: 'app' }, T2).record
    recordDecision(database, call({ key: 'b', expectedRevision: 3 }), T2)
    expect(listPeriodDecisions(database, first.periodId!).decisions.map((d) => d.key)).toEqual(['a'])
    for (let index = 0; index < DECISION_PERIOD_LIMIT; index += 1) recordDecision(database, call({ key: `k${index}`, expectedRevision: 3 }), T2)
    const many = listPeriodDecisions(database, second.periodId!)
    expect(many.decisions).toHaveLength(DECISION_PERIOD_LIMIT)
    expect(many.complete).toBe(false)
  })
})

describe('migration 29', () => {
  it('keeps every attention row, column and index, and lets only notices with a decision be recorded', () => {
    const old = new BetterSqlite3(':memory:')
    try {
      old.exec('CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
      for (const migration of DATABASE_MIGRATIONS.filter((m) => m.version < 29)) {
        old.exec(migration.sql)
        old.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)').run(migration.version, T0)
      }
      old.prepare(`INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
        VALUES ('s1', ?, 's1', '/w', '/bin/bash', '[]', 1, ?, 0)`).run(DEFAULT_WORKSPACE_ID, T0)
      old.prepare(`INSERT INTO attention_request(request_id, session_id, incarnation_id, request_key, kind, title, body, state, resolution, opened_at,
        expires_at, resolved_at, seen_at, revision, opened_by, resolved_by, prompt_json, producer_json, manual_choices_json, telegram_quiet_held_at,
        telegram_quiet_eligible, telegram_quiet_attempt_revision)
        VALUES ('r1', 's1', 'i1', 'k', 'question', 'T', 'B', 'answered', 'yes', ?, NULL, ?, ?, 3, 'cli', 'telegram', '{}', '{"a":1}', '{"b":2}', 5, 1, 2)`).run(T0, T1, T1)
      const before = old.prepare('SELECT * FROM attention_request').get() as Record<string, unknown>
      initializeDatabase(old, T2)
      expect(old.prepare('SELECT * FROM attention_request').get()).toEqual({ ...before, decision_json: null })
      const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attention_request' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
      expect(indexes).toEqual(['attention_decision_key', 'attention_open_key', 'attention_quiet_held'])
      expect(() => old.prepare(`INSERT INTO attention_request(request_id, session_id, request_key, kind, title, state, opened_at, revision)
        VALUES ('r2', 's1', 'k2', 'notice', 'T', 'recorded', ?, 1)`).run(T2)).toThrow(/CHECK constraint/)
      expect(() => old.prepare(`INSERT INTO attention_request(request_id, session_id, request_key, kind, title, state, opened_at, revision, decision_json)
        VALUES ('r3', 's1', 'k3', 'question', 'T', 'recorded', ?, 1, '{}')`).run(T2)).toThrow(/CHECK constraint/)
      expect(old.pragma('foreign_key_check')).toEqual([])
    } finally { old.close() }
  })
})
