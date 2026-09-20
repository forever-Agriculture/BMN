import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPLICATION_INTERRUPTION_REASON,
  initializeDatabase,
  type DatabaseConnection
} from './database-initialization'
import { DATABASE_MIGRATIONS, DEFAULT_WORKSPACE_ID, STORY_SCHEMA_TABLES } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

describe('owned database schema', () => {
  it('contains the eleven ordered migrations and only the owned tables', () => {
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(STORY_SCHEMA_TABLES).toEqual([
      'app_setting',
      'artifact',
      'attention_request',
      'control_receipt',
      'conversation_binding',
      'input_draft',
      'launch_template',
      'process_incarnation',
      'progress_evidence',
      'progress_observation',
      'schema_migration',
      'session',
      'telegram_message',
      'workspace',
      'workspace_layout'
    ])

    const sql = DATABASE_MIGRATIONS.map((migration) => migration.sql).join('\n').toLowerCase()
    for (const table of STORY_SCHEMA_TABLES) {
      expect(sql).toMatch(new RegExp(`table(?: if not exists)? ${table}`))
    }
    expect(sql).not.toContain('table media')
    expect(sql).toContain("'starting', 'running', 'exited', 'interrupted'")
    expect(sql).toContain('exit_signal integer')
    expect(sql).toContain('exit_detail text')
    expect(sql).toContain("status in ('bound', 'unsupported')")
    expect(sql).toContain(
      "'claude-session-id', 'explicit-resume-reference', 'hook-session-start', 'unsupported'"
    )
    expect(sql).toContain('conversation_reference text')
    expect(sql).toContain("marker in ('none', 'slate', 'teal', 'blue', 'violet', 'rose')")
    // Evidence belongs to its observation and goes with it; it deliberately does not reference
    // artifact, so losing an original leaves a named, visible reference instead of erasing it.
    expect(sql).toContain('foreign key (session_id, source) references progress_observation')
    expect(sql).not.toMatch(/artifact_id text not null references/)
    expect(sql).toContain('launch_environment_json text not null')
    expect(sql).toContain(DEFAULT_WORKSPACE_ID)
  })

  it('migrates a populated Epic 1 database without losing rows and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-v3-migration-test-'))
    createdRoots.add(root)
    const database = new BetterSqlite3(join(root, 'state.sqlite3'))
    const firstAppliedAt = '2026-09-12T10:00:00.000Z'
    const migratedAt = '2026-09-13T10:00:00.000Z'
    try {
      for (const migration of DATABASE_MIGRATIONS.slice(0, 2)) {
        database.exec(migration.sql)
        database
          .prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
          .run(migration.version, firstAppliedAt)
      }
      database
        .prepare(
          `INSERT INTO workspace(workspace_id, name, default_cwd, archived_at, revision)
           VALUES ('workspace-b', 'Work', '/work', NULL, 4)`
        )
        .run()
      const insertSession = database.prepare(
        `INSERT INTO session(
          session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      insertSession.run(
        'session-z',
        DEFAULT_WORKSPACE_ID,
        'Later',
        '/personal/later',
        '/usr/bin/codex',
        '["--model","gpt"]',
        2,
        '2026-09-12T12:00:00.000Z'
      )
      insertSession.run(
        'session-a',
        DEFAULT_WORKSPACE_ID,
        'Earlier by ID',
        '/personal/earlier',
        '/usr/bin/claude',
        '[]',
        3,
        '2026-09-12T11:00:00.000Z'
      )
      insertSession.run(
        'session-b',
        DEFAULT_WORKSPACE_ID,
        'Later by ID',
        '/personal/tie',
        '/usr/bin/claude',
        '["--model","opus"]',
        5,
        '2026-09-12T11:00:00.000Z'
      )
      const insertIncarnation = database.prepare(
        `INSERT INTO process_incarnation(
          incarnation_id, session_id, process_start_identity, state, started_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      insertIncarnation.run('incarnation-a', 'session-a', 'linux-proc-start:1', 'running', firstAppliedAt)
      insertIncarnation.run('incarnation-z', 'session-z', 'linux-proc-start:2', 'starting', firstAppliedAt)
      const insertBinding = database.prepare(
        `INSERT INTO conversation_binding(
          session_id, agent_cli, status, conversation_reference, capture_route,
          launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
          detail, captured_at
        ) VALUES (?, ?, 'bound', ?, ?, ?, ?, ?, '{}', ?, ?)`
      )
      insertBinding.run(
        'session-a',
        'claude',
        '11111111-1111-4111-8111-111111111111',
        'claude-session-id',
        '/personal/earlier',
        '/usr/bin/claude',
        '[]',
        'captured Claude binding',
        firstAppliedAt
      )
      insertBinding.run(
        'session-z',
        'codex',
        '22222222-2222-4222-8222-222222222222',
        'explicit-resume-reference',
        '/personal/later',
        '/usr/bin/codex',
        '["--model","gpt"]',
        'captured Codex binding',
        firstAppliedAt
      )
      // Every legacy route and status must survive the version 8 table rebuild unchanged.
      database
        .prepare(
          `INSERT INTO conversation_binding(
            session_id, agent_cli, status, conversation_reference, capture_route,
            launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
            detail, captured_at
          ) VALUES ('session-b', 'claude', 'unsupported', NULL, 'unsupported', ?, ?, '[]', '{}', ?, ?)`
        )
        .run('/personal/tie', '/usr/bin/claude', 'no exact binding was captured', firstAppliedAt)
      const sessionsBefore = database.prepare('SELECT * FROM session ORDER BY session_id').all()
      const workspacesBefore = database.prepare(
        `SELECT workspace_id, name, default_cwd, archived_at, revision
         FROM workspace ORDER BY workspace_id`
      ).all()
      const incarnationsBefore = database.prepare(
        `SELECT incarnation_id, session_id, process_start_identity, started_at
         FROM process_incarnation ORDER BY incarnation_id`
      ).all()
      const bindingsBefore = database
        .prepare('SELECT * FROM conversation_binding ORDER BY session_id')
        .all()

      const initialized = initializeDatabase(database, migratedAt)

      expect(initialized.interruptedIncarnations).toBe(2)
      expect(initialized.database).toEqual({
        journalMode: 'wal',
        foreignKeys: true,
        busyTimeoutMs: 5_000
      })
      expect(database.prepare('SELECT version FROM schema_migration ORDER BY version').all())
        .toEqual([
          { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
          { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 },
          { version: 10 }, { version: 11 }
        ])
      expect(database.prepare('SELECT applied_at FROM schema_migration WHERE version = 3').get())
        .toEqual({ applied_at: migratedAt })
      expect(database.prepare(
        `SELECT session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at
         FROM session ORDER BY session_id`
      ).all()).toEqual(sessionsBefore)
      expect(database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all())
        .toEqual(bindingsBefore)
      expect(database.prepare(
        `SELECT workspace_id, name, default_cwd, archived_at, revision
         FROM workspace ORDER BY workspace_id`
      ).all()).toEqual(workspacesBefore)
      expect(database.prepare(
        `SELECT incarnation_id, session_id, process_start_identity, started_at
         FROM process_incarnation ORDER BY incarnation_id`
      ).all()).toEqual(incarnationsBefore)
      expect(database.prepare(
        'SELECT session_id, position FROM session ORDER BY position, session_id'
      ).all()).toEqual([
        { session_id: 'session-a', position: 0 },
        { session_id: 'session-b', position: 1 },
        { session_id: 'session-z', position: 2 }
      ])
      expect(database.prepare(
        'SELECT workspace_id, position FROM workspace ORDER BY position'
      ).all()).toEqual([
        { workspace_id: DEFAULT_WORKSPACE_ID, position: 0 },
        { workspace_id: 'workspace-b', position: 1 }
      ])
      // Every workspace that predates the marker column reads as the default, so nothing looks different.
      expect(database.prepare(
        'SELECT workspace_id, marker FROM workspace ORDER BY workspace_id'
      ).all()).toEqual([
        { workspace_id: DEFAULT_WORKSPACE_ID, marker: 'none' },
        { workspace_id: 'workspace-b', marker: 'none' }
      ])
      // Every report that predates evidence reads as an empty list, and an observation still deletes
      // its own links even when a caller forgets the child table.
      database.prepare(
        `INSERT INTO progress_observation(
           session_id, source, incarnation_id, state, label, detail, observed_at, received_at
         ) VALUES ('session-a', 'agent', NULL, 'running', 'Legacy', NULL, ?, ?)`
      ).run(firstAppliedAt, firstAppliedAt)
      expect(database.prepare('SELECT count(*) AS links FROM progress_evidence').get())
        .toEqual({ links: 0 })
      database.prepare(
        `INSERT INTO progress_evidence(session_id, source, position, artifact_id, display_name)
         VALUES ('session-a', 'agent', 0, 'missing-artifact', 'checks.log')`
      ).run()
      database.prepare("DELETE FROM progress_observation WHERE session_id = 'session-a'").run()
      expect(database.prepare('SELECT count(*) AS links FROM progress_evidence').get())
        .toEqual({ links: 0 })
      const layouts = database.prepare(
        'SELECT workspace_id, layout_json, revision FROM workspace_layout ORDER BY workspace_id'
      ).all() as Array<{ workspace_id: string; layout_json: string; revision: number }>
      expect(layouts).toHaveLength(2)
      expect(layouts.map((row) => ({
        workspaceId: row.workspace_id,
        layout: JSON.parse(row.layout_json),
        revision: row.revision
      }))).toEqual([
        {
          workspaceId: DEFAULT_WORKSPACE_ID,
          layout: {
            workspaceId: DEFAULT_WORKSPACE_ID,
            selectedSessionId: null,
            split: { orientation: 'side-by-side', panes: [] },
            sessionView: {},
            revision: 1
          },
          revision: 1
        },
        {
          workspaceId: 'workspace-b',
          layout: {
            workspaceId: 'workspace-b',
            selectedSessionId: null,
            split: { orientation: 'side-by-side', panes: [] },
            sessionView: {},
            revision: 1
          },
          revision: 1
        }
      ])
      expect(database.prepare(
        `SELECT state, exited_at, exit_detail FROM process_incarnation ORDER BY incarnation_id`
      ).all()).toEqual([
        { state: 'interrupted', exited_at: migratedAt, exit_detail: APPLICATION_INTERRUPTION_REASON },
        { state: 'interrupted', exited_at: migratedAt, exit_detail: APPLICATION_INTERRUPTION_REASON }
      ])

      const rerun = initializeDatabase(database, '2026-09-13T11:00:00.000Z')
      expect(rerun.interruptedIncarnations).toBe(0)
      expect(database.prepare('SELECT version, applied_at FROM schema_migration ORDER BY version').all())
        .toEqual([
          { version: 1, applied_at: firstAppliedAt },
          { version: 2, applied_at: firstAppliedAt },
          { version: 3, applied_at: migratedAt },
          { version: 4, applied_at: migratedAt },
          { version: 5, applied_at: migratedAt },
          { version: 6, applied_at: migratedAt },
          { version: 7, applied_at: migratedAt },
          { version: 8, applied_at: migratedAt },
          { version: 9, applied_at: migratedAt },
          { version: 10, applied_at: migratedAt },
          { version: 11, applied_at: migratedAt }
        ])
      expect(database.prepare('SELECT COUNT(*) AS count FROM workspace_layout').get())
        .toEqual({ count: 2 })
    } finally {
      database.close()
    }
  })

  it('migrates legacy drafts into the handoff-capable schema without changing them', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      for (const migration of DATABASE_MIGRATIONS.slice(0, 5)) {
        database.exec(migration.sql)
        database.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
          .run(migration.version, '2026-09-14T10:00:00.000Z')
      }
      database.prepare(
        `INSERT INTO session(
           session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position
         ) VALUES ('legacy-session', ?, 'Legacy', '/work', '/bin/bash', '[]', 1, ?, 0)`
      ).run(DEFAULT_WORKSPACE_ID, '2026-09-14T10:00:00.000Z')
      database.prepare(
        `INSERT INTO input_draft(
           draft_id, session_id, origin, origin_key, request_id, text, artifact_id,
           state, detail, created_at, updated_at
         ) VALUES ('legacy-draft', 'legacy-session', 'telegram', 'telegram:1', NULL, 'hello', NULL,
           'draft', NULL, ?, ?)`
      ).run('2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')

      initializeDatabase(database, '2026-09-14T11:00:00.000Z')

      expect(database.prepare(
        `SELECT draft_id, origin, source_session_id, text, artifact_ids_json, attempted_incarnation_id, state
         FROM input_draft`
      ).get()).toEqual({
        draft_id: 'legacy-draft',
        origin: 'telegram',
        source_session_id: null,
        text: 'hello',
        artifact_ids_json: '[]',
        attempted_incarnation_id: null,
        state: 'draft'
      })
      expect(database.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get())
        .toEqual({ version: 11 })
    } finally {
      database.close()
    }
  })

  it('gives a legacy attention row unknown provenance and adds only the evidence table', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      for (const migration of DATABASE_MIGRATIONS.slice(0, 8)) {
        database.exec(migration.sql)
        database.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
          .run(migration.version, '2026-09-14T10:00:00.000Z')
      }
      database.prepare(
        `INSERT INTO session(
           session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position
         ) VALUES ('legacy-session', ?, 'Legacy', '/work', '/bin/bash', '[]', 1, ?, 0)`
      ).run(DEFAULT_WORKSPACE_ID, '2026-09-14T10:00:00.000Z')
      database.prepare(
        `INSERT INTO attention_request(
           request_id, session_id, incarnation_id, request_key, kind, title, body,
           state, resolution, opened_at, expires_at, resolved_at, seen_at, revision
         ) VALUES ('legacy-request', 'legacy-session', NULL, 'claude:permission', 'permission', 'Allow Bash?',
           NULL, 'open', NULL, ?, NULL, NULL, NULL, 1)`
      ).run('2026-09-14T10:00:00.000Z')
      const tablesBefore = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      ).all()

      initializeDatabase(database, '2026-09-14T11:00:00.000Z')

      expect(database.prepare(
        'SELECT request_id, state, title, opened_by, resolved_by FROM attention_request'
      ).get()).toEqual({
        request_id: 'legacy-request',
        state: 'open',
        title: 'Allow Bash?',
        opened_by: null,
        resolved_by: null
      })
      // Migrations 9 and 10 only add columns; 11 adds exactly one table and touches nothing else.
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
        .toEqual([...tablesBefore, { name: 'progress_evidence' }]
          .sort((left, right) => (left as { name: string }).name.localeCompare((right as { name: string }).name)))
    } finally {
      database.close()
    }
  })

  it('keeps existing Telegram mappings draft-only when adding process incarnation binding', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      for (const migration of DATABASE_MIGRATIONS.slice(0, 6)) {
        database.exec(migration.sql)
        database.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
          .run(migration.version, '2026-09-14T10:00:00.000Z')
      }
      database.prepare(
        `INSERT INTO session(
           session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at
         ) VALUES ('telegram-session', ?, 'Telegram', '/work', '/bin/bash', '[]', 1, ?)`
      ).run(DEFAULT_WORKSPACE_ID, '2026-09-14T10:00:00.000Z')
      database.prepare(
        `INSERT INTO telegram_message(message_id, session_id, request_id, sent_at)
         VALUES (77, 'telegram-session', NULL, ?)`
      ).run('2026-09-14T10:00:00.000Z')

      initializeDatabase(database, '2026-09-14T11:00:00.000Z')

      expect(database.prepare(
        'SELECT message_id, session_id, request_id, incarnation_id FROM telegram_message'
      ).get()).toEqual({
        message_id: 77,
        session_id: 'telegram-session',
        request_id: null,
        incarnation_id: null
      })
    } finally {
      database.close()
    }
  })
})
