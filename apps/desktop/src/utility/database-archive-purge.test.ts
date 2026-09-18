// MODULE: database-archive-purge.test.ts - archive retention deletes only expired archives and leaves a readable layout
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { purgeExpiredArchives } from './database-archive-purge'
import { getSettings, putSettingsSection } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { getLayout, listSessions, listWorkspaces, putLayout } from './database-workspace-store'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-09-15T12:00:00.000Z'
const daysAgo = (days: number): string => new Date(Date.parse(now) - days * 86_400_000).toISOString()
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, now)
})

afterEach(() => database.close())

function workspace(workspaceId: string, archivedAt: string | null): void {
  database.prepare(
    `INSERT INTO workspace(workspace_id, name, default_cwd, archived_at, revision, position) VALUES (?, ?, NULL, ?, 1, 1)`
  ).run(workspaceId, workspaceId, archivedAt)
  database.prepare(
    `INSERT INTO workspace_layout(workspace_id, layout_json, revision, updated_at) VALUES (?, ?, 1, ?)`
  ).run(workspaceId, JSON.stringify({
    workspaceId,
    selectedSessionId: null,
    split: { orientation: 'side-by-side', panes: [] },
    sessionView: {},
    revision: 1
  }), now)
}

function session(sessionId: string, workspaceId: string, archivedAt: string | null): void {
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position, archived_at)
     VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, 0, ?)`
  ).run(sessionId, workspaceId, sessionId, now, archivedAt)
}

function handoff(
  draftId: string,
  sourceSessionId: string,
  destinationSessionId: string,
  state: 'draft' | 'accepted' | 'uncertain' | 'discarded'
): void {
  database.prepare(
    `INSERT INTO input_draft(
       draft_id, session_id, origin, source_session_id, text, artifact_ids_json, state, created_at, updated_at
     ) VALUES (?, ?, 'handoff', ?, 'Synthetic handoff', '[]', ?, ?, ?)`
  ).run(draftId, destinationSessionId, sourceSessionId, state, now, now)
}

/** One row in every table that points at a session. */
function dependents(sessionId: string): void {
  const n = (database.prepare('SELECT COUNT(*) AS n FROM telegram_message').get() as { n: number }).n
  const artifactId = `a-${sessionId}`
  database.prepare(
    `INSERT INTO artifact(artifact_id, session_id, incarnation_id, direction, source, original_name, media_type,
       byte_length, sha256, stored_path, source_path, state, created_at)
     VALUES (?, ?, NULL, 'output', 'agent', 'report.md', 'text/markdown', 1, ?, '/store/x', NULL, 'ready', ?)`
  ).run(artifactId, sessionId, 'a'.repeat(64), now)
  database.prepare(
    `INSERT INTO process_incarnation(incarnation_id, session_id, process_start_identity, state, started_at)
     VALUES (?, ?, 'pid', 'exited', ?)`
  ).run(`i-${sessionId}`, sessionId, now)
  database.prepare(
    `INSERT INTO conversation_binding(session_id, agent_cli, status, conversation_reference, capture_route, launch_cwd,
       launch_executable, launch_argv_json, launch_environment_json, detail, captured_at)
     VALUES (?, 'other', 'unsupported', NULL, 'unsupported', '/work', '/bin/bash', '[]', '{}', '', ?)`
  ).run(sessionId, now)
  database.prepare(
    `INSERT INTO attention_request(request_id, session_id, request_key, kind, title, state, opened_at, revision)
     VALUES (?, ?, 'k', 'question', 'Q', 'open', ?, 1)`
  ).run(`r-${sessionId}`, sessionId, now)
  database.prepare(
    `INSERT INTO progress_observation(session_id, source, state, label, observed_at, received_at)
     VALUES (?, 'agent', 'running', 'L', ?, ?)`
  ).run(sessionId, now, now)
  database.prepare(
    `INSERT INTO input_draft(draft_id, session_id, origin, artifact_id, state, created_at, updated_at)
     VALUES (?, ?, 'telegram', ?, 'draft', ?, ?)`
  ).run(`d-${sessionId}`, sessionId, artifactId, now, now)
  database.prepare(
    `INSERT INTO telegram_message(message_id, session_id, sent_at) VALUES (?, ?, ?)`
  ).run(100 + n, sessionId, now)
}

const CHILD_TABLES = [
  'process_incarnation',
  'conversation_binding',
  'attention_request',
  'progress_observation',
  'input_draft',
  'telegram_message'
]

function childCount(sessionId: string): number {
  return CHILD_TABLES.reduce((total, table) =>
    total + (database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n, 0)
}

function retention(days: 90 | 30 | 10 | null): void {
  putSettingsSection(database, 'archive', { deleteAfterDays: days }, now)
}

describe('archive retention', () => {
  it('defaults to never and deletes nothing', () => {
    expect(getSettings(database).archive).toEqual({ deleteAfterDays: null })
    session('old', DEFAULT_WORKSPACE_ID, daysAgo(400))
    workspace('w-old', daysAgo(400))
    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: [], workspaceIds: [] })
    expect(listSessions(database, DEFAULT_WORKSPACE_ID).map((record) => record.sessionId)).toEqual(['old'])
    expect(listWorkspaces(database, true).map((record) => record.workspaceId)).toContain('w-old')
  })

  it('accepts only never, 90, 30 or 10 days', () => {
    retention(30)
    expect(getSettings(database).archive).toEqual({ deleteAfterDays: 30 })
    expect(() => putSettingsSection(database, 'archive', { deleteAfterDays: 7 }, now)).toThrow(/Never, 90, 30 or 10/)
    expect(() => putSettingsSection(database, 'archive', { deleteAfterDays: '30' }, now)).toThrow()
    expect(getSettings(database).archive).toEqual({ deleteAfterDays: 30 })
  })

  it('deletes sessions archived past the period with their records and keeps published files', () => {
    retention(30)
    session('expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('fresh', DEFAULT_WORKSPACE_ID, daysAgo(29))
    session('active', DEFAULT_WORKSPACE_ID, null)
    for (const id of ['expired', 'fresh', 'active']) dependents(id)

    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: ['expired'], workspaceIds: [] })

    expect(listSessions(database, DEFAULT_WORKSPACE_ID).map((record) => record.sessionId).sort()).toEqual(['active', 'fresh'])
    expect(childCount('expired')).toBe(0)
    expect(childCount('fresh')).toBe(CHILD_TABLES.length)
    expect(childCount('active')).toBe(CHILD_TABLES.length)
    expect(database.prepare("SELECT session_id FROM artifact WHERE artifact_id = 'a-expired'").get()).toEqual({ session_id: null })
    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: [], workspaceIds: [] })
  })

  it('deletes an expired workspace with all its sessions and never the default workspace', () => {
    retention(10)
    database.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?').run(daysAgo(50), DEFAULT_WORKSPACE_ID)
    workspace('w-expired', daysAgo(11))
    workspace('w-fresh', daysAgo(9))
    session('inside-active', 'w-expired', null)
    session('inside-fresh', 'w-fresh', daysAgo(2))
    dependents('inside-active')

    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: ['inside-active'], workspaceIds: ['w-expired'] })

    expect(listWorkspaces(database, true).map((record) => record.workspaceId).sort())
      .toEqual([DEFAULT_WORKSPACE_ID, 'w-fresh'].sort())
    expect(database.prepare("SELECT COUNT(*) AS n FROM workspace_layout WHERE workspace_id = 'w-expired'").get()).toEqual({ n: 0 })
    expect(childCount('inside-active')).toBe(0)
    expect(listSessions(database, 'w-fresh').map((record) => record.sessionId)).toEqual(['inside-fresh'])
  })

  it('retains handoff history with a removed-source fallback and deletes removed destinations', () => {
    retention(30)
    session('source-expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('source-kept', DEFAULT_WORKSPACE_ID, null)
    session('destination-kept', DEFAULT_WORKSPACE_ID, null)
    session('destination-expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    for (const state of ['draft', 'accepted', 'uncertain', 'discarded'] as const) {
      handoff(`kept-${state}`, 'source-expired', 'destination-kept', state)
      handoff(`removed-${state}`, 'source-kept', 'destination-expired', state)
    }

    expect(purgeExpiredArchives(database, now)).toEqual({
      sessionIds: ['destination-expired', 'source-expired'],
      workspaceIds: []
    })

    expect(database.prepare(
      `SELECT draft_id, source_session_id, state FROM input_draft ORDER BY draft_id`
    ).all()).toEqual([
      { draft_id: 'kept-accepted', source_session_id: null, state: 'accepted' },
      { draft_id: 'kept-discarded', source_session_id: null, state: 'discarded' },
      { draft_id: 'kept-draft', source_session_id: null, state: 'draft' },
      { draft_id: 'kept-uncertain', source_session_id: null, state: 'uncertain' }
    ])
  })

  it('removes deleted sessions from a kept workspace layout so it still opens', () => {
    retention(90)
    session('kept', DEFAULT_WORKSPACE_ID, null)
    session('gone', DEFAULT_WORKSPACE_ID, daysAgo(91))
    const before = getLayout(database, DEFAULT_WORKSPACE_ID).layout
    putLayout(database, DEFAULT_WORKSPACE_ID, before.revision, {
      ...before,
      selectedSessionId: 'gone',
      split: { orientation: 'side-by-side', panes: [{ sessionId: 'kept', ratio: 0.4 }, { sessionId: 'gone', ratio: 0.6 }] },
      sessionView: { kept: { scrollLine: null, followTail: true }, gone: { scrollLine: 3, followTail: false } }
    }, now)
    const saved = getLayout(database, DEFAULT_WORKSPACE_ID).layout

    purgeExpiredArchives(database, now)

    const result = getLayout(database, DEFAULT_WORKSPACE_ID)
    expect(result.notice).toBeNull()
    expect(result.layout).toEqual({
      ...saved,
      selectedSessionId: 'kept',
      split: { orientation: 'side-by-side', panes: [{ sessionId: 'kept', ratio: 1 }] },
      sessionView: { kept: { scrollLine: null, followTail: true } },
      revision: saved.revision + 1
    })
  })

  it('removes a deleted session from a different workspace saved split', () => {
    retention(90)
    workspace('w-view', null)
    session('kept', 'w-view', null)
    session('gone-foreign', DEFAULT_WORKSPACE_ID, daysAgo(91))
    const before = getLayout(database, 'w-view').layout
    putLayout(database, 'w-view', before.revision, {
      ...before,
      selectedSessionId: 'gone-foreign',
      split: {
        orientation: 'side-by-side',
        panes: [{ sessionId: 'kept', ratio: 0.5 }, { sessionId: 'gone-foreign', ratio: 0.5 }]
      },
      sessionView: {
        kept: { scrollLine: null, followTail: true },
        'gone-foreign': { scrollLine: 7, followTail: false }
      }
    }, now)

    purgeExpiredArchives(database, now)

    const result = getLayout(database, 'w-view')
    expect(result.notice).toBeNull()
    expect(result.layout.selectedSessionId).toBe('kept')
    expect(result.layout.split.panes).toEqual([{ sessionId: 'kept', ratio: 1 }])
    expect(result.layout.sessionView).toEqual({ kept: { scrollLine: null, followTail: true } })
  })
})
