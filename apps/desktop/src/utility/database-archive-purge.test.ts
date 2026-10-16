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
  state: 'draft' | 'accepted' | 'submitted' | 'uncertain' | 'discarded',
  artifactIds: string[] = []
): void {
  database.prepare(
    `INSERT INTO input_draft(
       draft_id, session_id, origin, source_session_id, text, artifact_ids_json, state, created_at, updated_at
     ) VALUES (?, ?, 'handoff', ?, 'Synthetic handoff', ?, ?, ?, ?)`
  ).run(draftId, destinationSessionId, sourceSessionId, JSON.stringify(artifactIds), state, now, now)
}

function artifact(artifactId: string, sessionId: string): void {
  database.prepare(
    `INSERT INTO artifact(artifact_id, session_id, incarnation_id, direction, source, original_name, media_type,
       byte_length, sha256, stored_path, source_path, state, created_at)
     VALUES (?, ?, NULL, 'output', 'agent', 'notes.md', 'text/markdown', 1, ?, '/store/x', NULL, 'ready', ?)`
  ).run(artifactId, sessionId, 'b'.repeat(64), now)
}

function artifactSessions(): Array<{ artifact_id: string; session_id: string | null }> {
  return database.prepare('SELECT artifact_id, session_id FROM artifact ORDER BY artifact_id').all() as
    Array<{ artifact_id: string; session_id: string | null }>
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
    `INSERT INTO progress_evidence(session_id, source, position, artifact_id, display_name)
     VALUES (?, 'agent', 0, ?, 'report.md')`
  ).run(sessionId, artifactId)
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
  'progress_evidence',
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
    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: [], workspaceIds: [], originals: [] })
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

  it('deletes sessions archived past the period with their records and their files', () => {
    retention(30)
    session('expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('fresh', DEFAULT_WORKSPACE_ID, daysAgo(29))
    session('active', DEFAULT_WORKSPACE_ID, null)
    for (const id of ['expired', 'fresh', 'active']) dependents(id)

    expect(purgeExpiredArchives(database, now)).toEqual({
      sessionIds: ['expired'], workspaceIds: [], originals: [{ artifactId: 'a-expired', sha256: 'a'.repeat(64) }]
    })

    expect(listSessions(database, DEFAULT_WORKSPACE_ID).map((record) => record.sessionId).sort()).toEqual(['active', 'fresh'])
    expect(childCount('expired')).toBe(0)
    expect(childCount('fresh')).toBe(CHILD_TABLES.length)
    expect(childCount('active')).toBe(CHILD_TABLES.length)
    expect(database.prepare('SELECT artifact_id FROM artifact ORDER BY artifact_id').all())
      .toEqual([{ artifact_id: 'a-active' }, { artifact_id: 'a-fresh' }])
    expect(database.prepare("SELECT COUNT(*) AS n FROM progress_evidence WHERE artifact_id = 'a-expired'").get())
      .toEqual({ n: 0 })
  })

  it('deletes evidence links with their session even with foreign keys off', () => {
    retention(30)
    session('expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    dependents('expired')
    // The purge names the table itself, so it does not rely on the cascade the pragma provides.
    database.pragma('foreign_keys = OFF')

    try {
      expect(purgeExpiredArchives(database, now)).toMatchObject({ sessionIds: ['expired'], workspaceIds: [] })
      expect(database.prepare('SELECT COUNT(*) AS n FROM progress_evidence').get()).toEqual({ n: 0 })
    } finally {
      database.pragma('foreign_keys = ON')
    }
    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: [], workspaceIds: [], originals: [] })
  })

  it('deletes an expired workspace with all its sessions and never the default workspace', () => {
    retention(10)
    database.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?').run(daysAgo(50), DEFAULT_WORKSPACE_ID)
    workspace('w-expired', daysAgo(11))
    workspace('w-fresh', daysAgo(9))
    session('inside-active', 'w-expired', null)
    session('inside-fresh', 'w-fresh', daysAgo(2))
    dependents('inside-active')

    expect(purgeExpiredArchives(database, now)).toEqual({
      sessionIds: ['inside-active'], workspaceIds: ['w-expired'], originals: [{ artifactId: 'a-inside-active', sha256: 'a'.repeat(64) }]
    })

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
      workspaceIds: [],
      originals: []
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

  it('keeps a file a kept session handoff still names until that handoff is deleted too', () => {
    retention(30)
    session('source', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('destination', DEFAULT_WORKSPACE_ID, null)
    session('other', DEFAULT_WORKSPACE_ID, null)
    for (const id of ['handed', 'discarded-only', 'unused']) artifact(id, 'source')
    handoff('pending', 'source', 'destination', 'accepted', ['handed'])
    handoff('dropped', 'source', 'other', 'discarded', ['discarded-only'])

    const first = purgeExpiredArchives(database, now)

    expect(first.originals.map((original) => original.artifactId)).toEqual(['discarded-only', 'unused'])
    expect(artifactSessions()).toEqual([{ artifact_id: 'handed', session_id: null }])

    // The destination expires later: its handoff goes, and the file it alone kept goes with it.
    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'destination'").run(daysAgo(31))
    expect(purgeExpiredArchives(database, now)).toEqual({
      sessionIds: ['destination'],
      workspaceIds: [],
      originals: [{ artifactId: 'handed', sha256: 'b'.repeat(64) }]
    })
    expect(artifactSessions()).toEqual([])
  })

  it.each(['draft', 'accepted', 'submitted', 'uncertain'] as const)(
    'keeps the file of a kept %s handoff and drops the file of a discarded one',
    (state) => {
      retention(30)
      session('source', DEFAULT_WORKSPACE_ID, daysAgo(31))
      session('destination', DEFAULT_WORKSPACE_ID, null)
      artifact('named', 'source')
      artifact('dropped', 'source')
      handoff('open', 'source', 'destination', state, ['named'])
      handoff('closed', 'source', 'destination', 'discarded', ['dropped'])

      expect(purgeExpiredArchives(database, now).originals).toEqual([{ artifactId: 'dropped', sha256: 'b'.repeat(64) }])
      expect(artifactSessions()).toEqual([{ artifact_id: 'named', session_id: null }])
    }
  )

  it('keeps a queued handoff\'s stored file and attachments while its record stands, through either side\'s purge (Story 75.5)', () => {
    retention(30)
    session('sender', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('receiver', DEFAULT_WORKSPACE_ID, null)
    artifact('stored', 'sender')
    artifact('attached', 'sender')
    database.prepare(
      `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
         sent_at, expires_at, state) VALUES ('m1', ?, 'sender', 'receiver', '/work', '[stamp]', 'pointer', ?, ?, 'printed')`
    ).run(DEFAULT_WORKSPACE_ID, now, now)
    database.prepare(
      `INSERT INTO input_draft(draft_id, session_id, origin, origin_key, source_session_id, request_id, text, artifact_id,
         artifact_ids_json, state, created_at, updated_at, prepared_by)
       VALUES ('queued', 'receiver', 'handoff', 'handoff-message:m1', 'sender', 'm1', 'Synthetic handoff', 'stored', '["attached"]',
         'submitted', ?, ?, 'agent')`
    ).run(now, now)

    // The sender goes: its message goes with it, and the record keeps both files, unlinked.
    expect(purgeExpiredArchives(database, now)).toEqual({ sessionIds: ['sender'], workspaceIds: [], originals: [] })
    expect(artifactSessions()).toEqual([{ artifact_id: 'attached', session_id: null }, { artifact_id: 'stored', session_id: null }])
    expect(database.prepare('SELECT COUNT(*) AS n FROM session_message').get()).toEqual({ n: 0 })
    expect(database.prepare("SELECT source_session_id FROM input_draft WHERE draft_id = 'queued'").get()).toEqual({ source_session_id: null })

    // The receiver goes later: the record goes, and the files it alone kept go with it.
    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'receiver'").run(daysAgo(31))
    expect(purgeExpiredArchives(database, now).originals.map((original) => original.artifactId)).toEqual(['attached', 'stored'])
    expect(artifactSessions()).toEqual([])
  })

  it('keeps a file named by two kept handoffs until the last of their sessions is deleted', () => {
    retention(30)
    session('source', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('first', DEFAULT_WORKSPACE_ID, null)
    session('second', DEFAULT_WORKSPACE_ID, null)
    artifact('shared', 'source')
    handoff('to-first', 'source', 'first', 'accepted', ['shared'])
    handoff('to-second', 'source', 'second', 'draft', ['shared'])
    expect(purgeExpiredArchives(database, now).originals).toEqual([])

    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'first'").run(daysAgo(31))
    expect(purgeExpiredArchives(database, now)).toMatchObject({ sessionIds: ['first'], originals: [] })
    expect(artifactSessions()).toEqual([{ artifact_id: 'shared', session_id: null }])

    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'second'").run(daysAgo(31))
    expect(purgeExpiredArchives(database, now).originals).toEqual([{ artifactId: 'shared', sha256: 'b'.repeat(64) }])
    expect(artifactSessions()).toEqual([])
  })

  it('keeps a file a kept session draft holds by its own reference, whatever the draft state, until that session goes', () => {
    retention(30)
    session('source', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('holder', DEFAULT_WORKSPACE_ID, null)
    artifact('held', 'source')
    // The single artifact_id of a draft is a foreign key: deleting the file's record would break it.
    database.prepare(
      `INSERT INTO input_draft(draft_id, session_id, origin, artifact_id, state, created_at, updated_at)
       VALUES ('holder-draft', 'holder', 'telegram', 'held', 'discarded', ?, ?)`
    ).run(now, now)

    expect(purgeExpiredArchives(database, now).originals).toEqual([])
    expect(artifactSessions()).toEqual([{ artifact_id: 'held', session_id: null }])
    expect(database.pragma('foreign_key_check')).toEqual([])

    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'holder'").run(daysAgo(31))
    expect(purgeExpiredArchives(database, now).originals).toEqual([{ artifactId: 'held', sha256: 'b'.repeat(64) }])
    expect(artifactSessions()).toEqual([])
  })

  it('never deletes an unlinked file no deleted session refers to', () => {
    retention(30)
    session('expired', DEFAULT_WORKSPACE_ID, daysAgo(31))
    session('kept', DEFAULT_WORKSPACE_ID, null)
    artifact('earlier-orphan', 'kept')
    database.prepare("UPDATE artifact SET session_id = NULL WHERE artifact_id = 'earlier-orphan'").run()

    expect(purgeExpiredArchives(database, now).originals).toEqual([])
    expect(artifactSessions()).toEqual([{ artifact_id: 'earlier-orphan', session_id: null }])
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

it('cascades only expired workspace launch sets while preserving unrelated definitions', () => {
  workspace('expired-sets', daysAgo(40))
  workspace('kept-sets', null)
  for (const id of ['expired-sets', 'kept-sets']) {
    database.prepare('INSERT INTO launch_set VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, id, 'Saved set', JSON.stringify([{ entryId: 'entry', name: 'Shell', executable: '/bin/sh', argv: [], backgroundChoice: null }]), now)
  }
  putSettingsSection(database, 'archive', { deleteAfterDays: 30 }, now)
  database.transaction(() => purgeExpiredArchives(database, now))()
  expect(database.prepare('SELECT set_id FROM launch_set').all()).toEqual([{ set_id: 'kept-sets' }])
  expect(database.pragma('foreign_key_check')).toEqual([])
})

describe('agent history setting (Story 31.1)', () => {
  it('reads an old settings row without it as 30 days, unconfirmed, and keeps it beside archive', () => {
    expect(getSettings(database).agentHistory).toEqual({ keepDays: 30, claudeConfigDirs: [] })
    database.prepare("INSERT INTO app_setting(key, value_json, updated_at) VALUES ('archive', '{\"deleteAfterDays\":30}', ?)").run(now)
    expect(getSettings(database)).toMatchObject({ archive: { deleteAfterDays: 30 }, agentHistory: { keepDays: 30, claudeConfigDirs: [] } })
    expect(getSettings(database).agentHistory.confirmedKeepDays).toBeUndefined()
  })

  it('reads a stored, retired 7-day limit as 10 days and keeps its learned folders', () => {
    database.prepare("INSERT INTO app_setting(key, value_json, updated_at) VALUES ('agentHistory', ?, ?)")
      .run(JSON.stringify({ keepDays: 7, confirmedKeepDays: 7, claudeConfigDirs: ['/home/o/.claude-glm'] }), now)
    expect(getSettings(database).agentHistory).toEqual({ keepDays: 10, confirmedKeepDays: 10, claudeConfigDirs: ['/home/o/.claude-glm'] })
    expect(() => putSettingsSection(database, 'agentHistory', { keepDays: 7, claudeConfigDirs: [] }, now)).toThrow()
  })

  it.each([10, 30, 90, null] as const)('stores %s days with its confirmation and learned folders', (days) => {
    putSettingsSection(database, 'agentHistory', { keepDays: days, confirmedKeepDays: days, claudeConfigDirs: ['/home/o/.claude-glm'] }, now)
    expect(getSettings(database).agentHistory).toEqual({ keepDays: days, confirmedKeepDays: days, claudeConfigDirs: ['/home/o/.claude-glm'] })
  })

  it.each([
    ['an unknown limit', { keepDays: 14, claudeConfigDirs: [] }],
    ['a text limit', { keepDays: '30', claudeConfigDirs: [] }],
    ['an unknown confirmed limit', { keepDays: 30, confirmedKeepDays: 0, claudeConfigDirs: [] }],
    ['a relative folder', { keepDays: 30, claudeConfigDirs: ['conf/glm'] }],
    ['too many folders', { keepDays: 30, claudeConfigDirs: Array.from({ length: 10 }, (_, index) => `/c/${index}`) }]
  ])('refuses %s and keeps the stored value', (_label, value) => {
    putSettingsSection(database, 'agentHistory', { keepDays: 90, claudeConfigDirs: [] }, now)
    expect(() => putSettingsSection(database, 'agentHistory', value, now)).toThrow()
    expect(getSettings(database).agentHistory).toEqual({ keepDays: 90, claudeConfigDirs: [] })
  })
})
