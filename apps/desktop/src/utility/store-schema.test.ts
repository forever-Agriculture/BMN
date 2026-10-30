// MODULE: store-schema.test.ts - holds the list of schema versions and of owned tables, and migrates databases of earlier versions with their rows
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
import { createWorkspace, selectWorkspace } from './database-workspace-store'
import { DATABASE_MIGRATIONS, DEFAULT_WORKSPACE_ID, STORY_SCHEMA_TABLES } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

describe('owned database schema', () => {
  it('contains the 34 ordered migrations and only the owned tables', () => {
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34])
    expect(STORY_SCHEMA_TABLES).toEqual([
      'app_setting',
      'artifact',
      'attention_request',
      'control_receipt',
      'conversation_binding',
      'first_run_setup',
      'input_draft',
      'launch_set',
      'launch_template',
      'process_incarnation',
      'progress_evidence',
      'progress_observation',
      'qa_audit',
      'qa_grant',
      'qa_grant_use',
      'qa_run',
      'schema_migration',
      'session',
      'session_message',
      'session_message_pair',
      'telegram_message',
      'turn_capture',
      'turn_capture_reference',
      'turn_record',
      'turn_removal_job',
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
          { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 },
          { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 },
          { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 },
          { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }, { version: 33 }, { version: 34 }
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
          { version: 11, applied_at: migratedAt },
          { version: 12, applied_at: migratedAt },
          { version: 13, applied_at: migratedAt },
          { version: 14, applied_at: migratedAt },
          { version: 15, applied_at: migratedAt },
          { version: 16, applied_at: migratedAt },
          { version: 17, applied_at: migratedAt },
          { version: 18, applied_at: migratedAt },
          { version: 19, applied_at: migratedAt },
          { version: 20, applied_at: migratedAt }, { version: 21, applied_at: migratedAt },
          { version: 22, applied_at: migratedAt }, { version: 23, applied_at: migratedAt }, { version: 24, applied_at: migratedAt }, { version: 25, applied_at: migratedAt },
          { version: 26, applied_at: migratedAt }, { version: 27, applied_at: migratedAt }, { version: 28, applied_at: migratedAt }, { version: 29, applied_at: migratedAt }, { version: 30, applied_at: migratedAt }, { version: 31, applied_at: migratedAt }, { version: 32, applied_at: migratedAt }, { version: 33, applied_at: migratedAt }, { version: 34, applied_at: migratedAt }
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
        `SELECT draft_id, origin, source_session_id, prepared_by, text, artifact_ids_json,
                attempted_incarnation_id, state
         FROM input_draft`
      ).get()).toEqual({
        draft_id: 'legacy-draft',
        origin: 'telegram',
        source_session_id: null,
        prepared_by: null,
        text: 'hello',
        artifact_ids_json: '[]',
        attempted_incarnation_id: null,
        state: 'draft'
      })
      expect(database.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get())
        .toEqual({ version: 34 })
    } finally {
      database.close()
    }
  })

  it('gives a legacy attention row unknown provenance and adds definition tables', () => {
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
      // Later migrations add evidence and launch definitions without changing legacy records.
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
        .toEqual([...tablesBefore, { name: 'qa_audit' }, { name: 'qa_grant' }, { name: 'qa_grant_use' }, { name: 'qa_run' }, { name: 'first_run_setup' }, { name: 'progress_evidence' }, { name: 'launch_set' }, { name: 'session_message' }, { name: 'session_message_pair' },
          { name: 'turn_capture' }, { name: 'turn_capture_reference' }, { name: 'turn_record' }, { name: 'turn_removal_job' }]
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

  it('preserves legacy rows and admits handoff attention plus OpenCode bindings', () => {
    const database = new BetterSqlite3(':memory:')
    const legacyTime = '2026-09-14T10:00:00.000Z'
    try {
      for (const migration of DATABASE_MIGRATIONS.slice(0, 12)) {
        database.exec(migration.sql)
        database.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
          .run(migration.version, legacyTime)
      }
      const insertSession = database.prepare(
        `INSERT INTO session(
           session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position
         ) VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?)`
      )
      insertSession.run('legacy-session', DEFAULT_WORKSPACE_ID, 'Legacy', '/legacy', '/bin/bash', legacyTime, 0)
      insertSession.run('opencode-session', DEFAULT_WORKSPACE_ID, 'OpenCode', '/opencode', '/bin/bash', legacyTime, 1)
      database.prepare(
        `INSERT INTO input_draft(
           draft_id, session_id, origin, origin_key, request_id, text, artifact_id,
           state, detail, created_at, updated_at
         ) VALUES ('legacy-draft', 'legacy-session', 'telegram', 'telegram:legacy', NULL, 'hello', NULL,
           'draft', NULL, ?, ?)`
      ).run(legacyTime, legacyTime)
      database.prepare(
        `INSERT INTO attention_request(
           request_id, session_id, incarnation_id, request_key, kind, title, body,
           state, resolution, opened_at, expires_at, resolved_at, seen_at, revision,
           opened_by, resolved_by
         ) VALUES ('legacy-request', 'legacy-session', NULL, 'legacy:key', 'question', 'Legacy question',
           'Keep this', 'open', NULL, ?, NULL, NULL, NULL, 1, NULL, NULL)`
      ).run(legacyTime)
      database.prepare(
        `INSERT INTO conversation_binding(
           session_id, agent_cli, status, conversation_reference, capture_route,
           launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
           detail, captured_at
         ) VALUES ('legacy-session', 'claude', 'bound',
           '01a0b657-21a8-7f00-addd-b73646828f5b', 'claude-session-id',
           '/legacy', '/usr/bin/claude', '[]', '{}', 'legacy binding', ?)`
      ).run(legacyTime)

      insertSession.run('legacy-hook', DEFAULT_WORKSPACE_ID, 'Hook', '/hook', '/usr/bin/codex', legacyTime, 2)
      database.prepare(
        `INSERT INTO conversation_binding(
           session_id, agent_cli, status, conversation_reference, capture_route,
           launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
           detail, captured_at
         ) VALUES ('legacy-hook', 'codex', 'bound',
           '01a0b659-2862-7d93-a4c5-bc1bd2a47915', 'hook-session-start',
           '/hook', '/usr/bin/codex', '["--model","test"]', '{"TEST":"kept"}', 'hook binding', ?)`
      ).run(legacyTime)
      const legacyBindings = database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all()

      initializeDatabase(database, '2026-09-14T11:00:00.000Z')
      expect(database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all()).toEqual(legacyBindings)
      initializeDatabase(database, '2026-09-14T12:00:00.000Z')
      expect(database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all()).toEqual(legacyBindings)


      expect(database.prepare(
        `SELECT draft_id, origin, source_session_id, prepared_by, text, state
         FROM input_draft WHERE draft_id = 'legacy-draft'`
      ).get()).toEqual({
        draft_id: 'legacy-draft', origin: 'telegram', source_session_id: null,
        prepared_by: null, text: 'hello', state: 'draft'
      })
      expect(database.prepare(
        `SELECT request_id, kind, title, body, state, opened_by, resolved_by, prompt_json
         FROM attention_request WHERE request_id = 'legacy-request'`
      ).get()).toEqual({
        request_id: 'legacy-request', kind: 'question', title: 'Legacy question', body: 'Keep this',
        state: 'open', opened_by: null, resolved_by: null, prompt_json: null
      })
      // Migration 17 stores only JSON a prompt reader can parse; anything else is refused at the row.
      expect(() => database.prepare("UPDATE attention_request SET prompt_json = 'not json' WHERE request_id = 'legacy-request'").run())
        .toThrow(/CHECK constraint/)
      expect(database.prepare(
        `SELECT agent_cli, status, conversation_reference, capture_route
         FROM conversation_binding WHERE session_id = 'legacy-session'`
      ).get()).toEqual({
        agent_cli: 'claude', status: 'bound',
        conversation_reference: '01a0b657-21a8-7f00-addd-b73646828f5b',
        capture_route: 'claude-session-id'
      })

      database.prepare(
        `INSERT INTO attention_request(
           request_id, session_id, incarnation_id, request_key, kind, title, body,
           state, resolution, opened_at, expires_at, resolved_at, seen_at, revision,
           opened_by, resolved_by
         ) VALUES ('handoff-request', 'legacy-session', 'incarnation-1', 'handoff:draft-1', 'handoff',
           'Asks to hand off to "OpenCode"', 'result', 'open', NULL, ?, NULL, NULL, NULL, 1, 'cli', NULL)`
      ).run('2026-09-15T10:00:00.000Z')
      database.prepare(
        `INSERT INTO conversation_binding(
           session_id, agent_cli, status, conversation_reference, capture_route,
           launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
           detail, captured_at
         ) VALUES ('opencode-session', 'opencode', 'bound', 'session-123456789012345678901234567',
           'explicit-resume-reference', '/opencode', '/usr/bin/opencode', '[]', '{}',
           'OpenCode binding', ?)`
      ).run('2026-09-14T11:00:00.000Z')

      expect(database.prepare(
        `SELECT kind, opened_by FROM attention_request WHERE request_id = 'handoff-request'`
      ).get()).toEqual({ kind: 'handoff', opened_by: 'cli' })
      expect(database.prepare(
        `SELECT agent_cli, status, conversation_reference, capture_route
         FROM conversation_binding WHERE session_id = 'opencode-session'`
      ).get()).toEqual({
        agent_cli: 'opencode', status: 'bound',
        conversation_reference: 'session-123456789012345678901234567',
        capture_route: 'explicit-resume-reference'
      })
    } finally {
      database.close()
    }
  })
})

it('upgrades schema 14 additively without seeding launch sets or changing template definitions', () => {
  const database = new BetterSqlite3(':memory:')
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 14)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, '2026-09-01T00:00:00.000Z')
    }
    database.prepare("INSERT INTO launch_template VALUES ('old-template', 'Old', '/bin/sh', '[]', '/work', NULL, 1, ?)")
      .run('2026-09-01T00:00:00.000Z')
    const before = database.prepare('SELECT * FROM launch_template').all()
    initializeDatabase(database, '2026-09-24T00:00:00.000Z')
    expect(database.prepare('SELECT * FROM launch_set').all()).toEqual([])
    expect(database.prepare('SELECT * FROM launch_template').all()).toEqual(
      before.map((row) => ({ ...row as object, terminal_graphics: null }))
    )
    expect(database.pragma('foreign_key_check')).toEqual([])
  } finally { database.close() }
})

it('widens the binding CHECKs for Cursor at version 19 and keeps every earlier row verbatim', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-09-27T00:00:00.000Z'
  const cursorBinding = `INSERT INTO conversation_binding(
       session_id, agent_cli, status, conversation_reference, capture_route,
       launch_cwd, launch_executable, launch_argv_json, launch_environment_json, detail, captured_at
     ) VALUES ('cursor-session', 'cursor', 'bound', 'c741bb07-352f-457b-8e7c-ee00517cd9ff', 'hook-session-start',
       '/work', '/usr/bin/cursor-agent', '["--model","fixture"]', '{}', 'Reported by Cursor at session start', ?)`
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 18)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, at)
    }
    const insertSession = database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?)`
    )
    const bindings = [
      ['claude-session', 'claude', 'bound', '01a0b657-21a8-7f00-addd-b73646828f5b', 'claude-session-id', '/usr/bin/claude'],
      ['codex-session', 'codex', 'bound', '01a0b659-2862-7d93-a4c5-bc1bd2a47915', 'hook-session-start', '/usr/bin/codex'],
      ['opencode-session', 'opencode', 'bound', 'ses_0123456789abSyntheticTest0', 'hook-session-start', '/usr/bin/opencode'],
      ['shell-session', 'other', 'unsupported', null, 'unsupported', '/bin/bash']
    ] as const
    bindings.forEach(([session, cli, status, reference, route, executable], index) => {
      insertSession.run(session, DEFAULT_WORKSPACE_ID, session, '/work', executable, at, index)
      database.prepare(
        `INSERT INTO conversation_binding(
           session_id, agent_cli, status, conversation_reference, capture_route,
           launch_cwd, launch_executable, launch_argv_json, launch_environment_json, detail, captured_at
         ) VALUES (?, ?, ?, ?, ?, '/work', ?, '[]', '{"TERM":"xterm"}', 'kept', ?)`
      ).run(session, cli, status, reference, route, executable, at)
    })
    insertSession.run('cursor-session', DEFAULT_WORKSPACE_ID, 'Cursor', '/work', '/usr/bin/cursor-agent', at, 9)
    // Before the migration a Cursor binding is refused by the table itself.
    expect(() => database.prepare(cursorBinding).run(at)).toThrow(/CHECK constraint/)
    const before = database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all()

    initializeDatabase(database, '2026-09-28T00:00:00.000Z')

    expect(database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all()).toEqual(before)
    database.prepare(cursorBinding).run(at)
    expect(database.prepare("SELECT agent_cli, status, capture_route FROM conversation_binding WHERE session_id = 'cursor-session'").get())
      .toEqual({ agent_cli: 'cursor', status: 'bound', capture_route: 'hook-session-start' })
    // A bound row still needs a reference, and an unknown CLI is still refused.
    expect(() => database.prepare(`UPDATE conversation_binding SET conversation_reference = NULL WHERE session_id = 'cursor-session'`).run())
      .toThrow(/CHECK constraint/)
    expect(() => database.prepare(`UPDATE conversation_binding SET agent_cli = 'gemini' WHERE session_id = 'cursor-session'`).run())
      .toThrow(/CHECK constraint/)
    expect(database.pragma('foreign_key_check')).toEqual([])
    initializeDatabase(database, '2026-09-28T01:00:00.000Z')
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversation_binding').get()).toEqual({ count: 5 })
  } finally { database.close() }
})

it('adds the reported resume command at version 20, empty for every existing session and only as valid JSON', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-09-29T00:00:00.000Z'
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 19)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, at)
    }
    database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES ('old-session', ?, 'Old', '/work', '/bin/bash', '[]', 1, ?, 0)`
    ).run(DEFAULT_WORKSPACE_ID, at)
    const before = database.prepare("SELECT * FROM session WHERE session_id = 'old-session'").get() as object

    initializeDatabase(database, '2026-09-29T01:00:00.000Z')

    expect(database.prepare("SELECT * FROM session WHERE session_id = 'old-session'").get())
      .toEqual({ ...before, reported_resume_json: null, receive_messages: 1, setup_purpose_json: null })
    database.prepare("UPDATE session SET reported_resume_json = ? WHERE session_id = 'old-session'")
      .run('{"argv":["my-agent","--resume","abc"],"reportedAt":"2026-09-29T01:00:00.000Z","incarnationId":"i-1"}')
    expect(() => database.prepare("UPDATE session SET reported_resume_json = 'not json' WHERE session_id = 'old-session'").run())
      .toThrow(/CHECK constraint/)
    expect(database.pragma('foreign_key_check')).toEqual([])
  } finally { database.close() }
})

it('adds messages between sessions at version 26, which version 28 turns on for every existing workspace and session (Epic 66, Story 75.4)', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-10-13T00:00:00.000Z'
  try {
    // A copy of a version-25 database with a workspace and two sessions the owner already had.
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 25)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, at)
    }
    const insertSession = database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, ?)`
    )
    insertSession.run('old-a', DEFAULT_WORKSPACE_ID, 'A', at, 0)
    insertSession.run('old-b', DEFAULT_WORKSPACE_ID, 'B', at, 1)
    const workspaceBefore = database.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(DEFAULT_WORKSPACE_ID) as object
    const sessionBefore = database.prepare("SELECT * FROM session WHERE session_id = 'old-a'").get() as object

    initializeDatabase(database, '2026-10-13T01:00:00.000Z')

    expect(database.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(DEFAULT_WORKSPACE_ID)).toEqual({
      ...workspaceBefore, session_messages: 1, session_messages_paused_at: null, session_messages_paused_by: null,
      session_messages_counted_from: null, turn_changes: 1
    })
    expect(database.prepare("SELECT * FROM session WHERE session_id = 'old-a'").get()).toEqual({ ...sessionBefore, receive_messages: 1, setup_purpose_json: null })
    expect(database.prepare('SELECT COUNT(*) AS count FROM session_message').get()).toEqual({ count: 0 })
    const insertMessage = database.prepare(
      `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
         sent_at, expires_at, state) VALUES (?, ?, 'old-a', 'old-b', '/work', '[stamp]', 'text', ?, ?, ?)`
    )
    insertMessage.run('m-1', DEFAULT_WORKSPACE_ID, at, at, 'waiting')
    // Only the five states exist, the switches hold 0 or 1, and a pair is stored once, smaller id first.
    expect(() => insertMessage.run('m-2', DEFAULT_WORKSPACE_ID, at, at, 'read')).toThrow(/CHECK constraint/)
    expect(() => database.prepare('UPDATE workspace SET session_messages = 2').run()).toThrow(/CHECK constraint/)
    expect(() => database.prepare("UPDATE session SET receive_messages = 2 WHERE session_id = 'old-a'").run()).toThrow(/CHECK constraint/)
    expect(() => database.prepare("UPDATE workspace SET session_messages_paused_by = 'agent'").run()).toThrow(/CHECK constraint/)
    const insertPair = database.prepare(
      'INSERT INTO session_message_pair(workspace_id, first_session_id, second_session_id, paused_at) VALUES (?, ?, ?, ?)'
    )
    expect(() => insertPair.run(DEFAULT_WORKSPACE_ID, 'old-b', 'old-a', at)).toThrow(/CHECK constraint/)
    insertPair.run(DEFAULT_WORKSPACE_ID, 'old-a', 'old-b', at)
    // Any delete of either session takes its messages and its pair with it.
    database.prepare("DELETE FROM session WHERE session_id = 'old-b'").run()
    expect(database.prepare('SELECT COUNT(*) AS count FROM session_message').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM session_message_pair').get()).toEqual({ count: 0 })
    expect(database.pragma('foreign_key_check')).toEqual([])
    initializeDatabase(database, '2026-10-13T02:00:00.000Z')
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migration').get()).toEqual({ version: 34 })
  } finally { database.close() }
})

it('adds turn changes at version 27, which version 28 turns on for every existing workspace, and four tables that name no file (Epic 69, Story 75.4)', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-10-13T00:00:00.000Z'
  try {
    // A copy of a version-26 database with a workspace, a session and a message the owner already had.
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 26)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, at)
    }
    const insertSession = database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, ?)`
    )
    insertSession.run('old-a', DEFAULT_WORKSPACE_ID, 'A', at, 0)
    insertSession.run('old-b', DEFAULT_WORKSPACE_ID, 'B', at, 1)
    database.prepare('UPDATE workspace SET session_messages = 1 WHERE workspace_id = ?').run(DEFAULT_WORKSPACE_ID)
    database.prepare(
      `INSERT INTO session_message(message_id, workspace_id, sender_session_id, receiver_session_id, sender_root, stamp, text,
         sent_at, expires_at, state) VALUES ('m-1', ?, 'old-a', 'old-b', '/work', '[stamp]', 'text', ?, ?, 'waiting')`
    ).run(DEFAULT_WORKSPACE_ID, at, at)
    const workspaceBefore = database.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(DEFAULT_WORKSPACE_ID) as object
    const sessionBefore = database.prepare("SELECT * FROM session WHERE session_id = 'old-a'").get() as object
    const messageBefore = database.prepare("SELECT * FROM session_message WHERE message_id = 'm-1'").get() as object

    initializeDatabase(database, '2026-10-13T01:00:00.000Z')

    expect(database.prepare('SELECT * FROM workspace WHERE workspace_id = ?').get(DEFAULT_WORKSPACE_ID)).toEqual({ ...workspaceBefore, turn_changes: 1 })
    expect(database.prepare("SELECT * FROM session WHERE session_id = 'old-a'").get()).toEqual({ ...sessionBefore, setup_purpose_json: null })
    expect(database.prepare("SELECT * FROM session_message WHERE message_id = 'm-1'").get()).toEqual(messageBefore)
    for (const table of ['turn_capture', 'turn_record', 'turn_capture_reference', 'turn_removal_job']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    // No column of the four tables can hold a file's name or its bytes: a capture's rows name the root and commits.
    const columns = (table: string): string[] => (database.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns('turn_capture')).toEqual(['capture_id', 'session_id', 'work_tree', 'scan_started_ms', 'scan_ended_ms', 'head_start', 'head_end', 'state', 'bound', 'size'])
    expect(columns('turn_record')).toEqual(['turn_id', 'number', 'session_id', 'incarnation_id', 'foreground', 'app', 'app_version', 'conversation', 'app_turn_id',
      'named_folder', 'work_tree', 'state', 'end_kind', 'started_at', 'ended_at', 'totals_state', 'totals_json', 'wording', 'labels_json'])
    expect(columns('turn_capture_reference')).toEqual(['turn_id', 'role', 'capture_id'])
    expect(columns('turn_removal_job')).toEqual(['job_id', 'session_id', 'work_tree', 'capture_id', 'created_at', 'attempts', 'last_tried_at'])

    const capture = database.prepare(
      `INSERT INTO turn_capture(capture_id, session_id, work_tree, scan_started_ms, scan_ended_ms, state, size) VALUES (?, 'old-a', '/work', 1, 2, ?, ?)`
    )
    capture.run('c-1', 'whole', 10)
    capture.run('c-2', 'incomplete', 0)
    expect(() => capture.run('c-3', 'gone', 0)).toThrow(/CHECK constraint/)
    expect(() => capture.run('c-3', 'whole', -1)).toThrow(/CHECK constraint/)
    const turn = database.prepare(
      `INSERT INTO turn_record(turn_id, number, session_id, foreground, app, state, started_at, totals_state) VALUES (?, ?, 'old-a', '1:2:3', 'codex', ?, ?, ?)`
    )
    turn.run('t-1', 1, 'open', at, 'none')
    expect(() => turn.run('t-2', 1, 'closed', at, 'complete')).toThrow(/UNIQUE constraint/)
    expect(() => turn.run('t-2', 2, 'ended', at, 'complete')).toThrow(/CHECK constraint/)
    expect(() => turn.run('t-2', 2, 'closed', at, 'zero')).toThrow(/CHECK constraint/)
    expect(() => turn.run('t-2', 0, 'closed', at, 'none')).toThrow(/CHECK constraint/)
    const refer = database.prepare('INSERT INTO turn_capture_reference(turn_id, role, capture_id) VALUES (?, ?, ?)')
    refer.run('t-1', 'before', 'c-1')
    refer.run('t-1', 'after', 'c-2')
    expect(() => refer.run('t-1', 'before', 'c-2')).toThrow(/UNIQUE constraint/)
    expect(() => refer.run('t-1', 'between', 'c-2')).toThrow(/CHECK constraint/)
    expect(() => refer.run('t-1', 'after', 'no-such-capture')).toThrow(/constraint/)
    // A job names a capture with its work tree, or a session's whole folder; it outlives the session it names.
    const job = database.prepare('INSERT INTO turn_removal_job(session_id, work_tree, capture_id, created_at) VALUES (?, ?, ?, ?)')
    job.run('old-a', '/work', 'c-9', at)
    job.run('old-a', null, null, at)
    expect(() => job.run('old-a', '/work', null, at)).toThrow(/CHECK constraint/)
    expect(() => database.prepare('UPDATE workspace SET turn_changes = 2').run()).toThrow(/CHECK constraint/)
    // Any delete of the session takes its turns, their references and its captures with it; the jobs stay.
    database.prepare("DELETE FROM session_message WHERE sender_session_id = 'old-a'").run()
    database.prepare("DELETE FROM session WHERE session_id = 'old-a'").run()
    for (const table of ['turn_capture', 'turn_record', 'turn_capture_reference']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM turn_removal_job').get()).toEqual({ count: 2 })
    expect(database.pragma('foreign_key_check')).toEqual([])
    initializeDatabase(database, '2026-10-13T02:00:00.000Z')
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migration').get()).toEqual({ version: 34 })
  } finally { database.close() }
})

it('turns messages and turn changes on at version 28 for every workspace and session, archived ones and "Receive messages" off included, and lifts the owner\'s pauses only (Story 75.4)', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-10-16T00:00:00.000Z'
  const hourAgo = '2026-10-15T23:00:00.000Z'
  try {
    // A copy of a version-27 database: the default workspace with both switches off and the owner's pause; an
    // archived one with messages on and the hourly limit's pause; sessions shut out of messages, one archived;
    // and a pair the limit paused.
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 27)) {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migration VALUES (?, ?)').run(migration.version, at)
    }
    database.prepare(
      "INSERT INTO workspace(workspace_id, name, default_cwd, archived_at, revision) VALUES ('w-archived', 'Old', NULL, ?, 1)"
    ).run(at)
    const insertSession = database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, ?)`
    )
    insertSession.run('old-a', DEFAULT_WORKSPACE_ID, 'A', at, 0)
    insertSession.run('old-b', DEFAULT_WORKSPACE_ID, 'B', at, 1)
    insertSession.run('old-c', 'w-archived', 'C', at, 0)
    database.prepare("UPDATE session SET receive_messages = 0 WHERE session_id IN ('old-b', 'old-c')").run()
    database.prepare("UPDATE session SET archived_at = ? WHERE session_id = 'old-c'").run(at)
    database.prepare(
      `UPDATE workspace SET session_messages_paused_at = ?, session_messages_paused_by = 'owner', session_messages_counted_from = ?
       WHERE workspace_id = ?`
    ).run(at, hourAgo, DEFAULT_WORKSPACE_ID)
    database.prepare(
      `UPDATE workspace SET session_messages = 1, session_messages_paused_at = ?, session_messages_paused_by = 'limit'
       WHERE workspace_id = 'w-archived'`
    ).run(at)
    database.prepare(
      "INSERT INTO session_message_pair(workspace_id, first_session_id, second_session_id, paused_at, counted_from) VALUES (?, 'old-a', 'old-b', ?, ?)"
    ).run(DEFAULT_WORKSPACE_ID, at, hourAgo)
    const rows = (sql: string) => database.prepare(sql).all() as Array<Record<string, unknown>>
    const workspacesBefore = rows('SELECT * FROM workspace ORDER BY workspace_id')
    const sessionsBefore = rows('SELECT * FROM session ORDER BY session_id')
    const pairsBefore = rows('SELECT * FROM session_message_pair')

    initializeDatabase(database, '2026-10-16T01:00:00.000Z')

    const on = { session_messages: 1, turn_changes: 1 }
    expect(rows('SELECT * FROM workspace ORDER BY workspace_id')).toEqual([
      // The owner's pause is lifted; where the hourly count starts stays as it was.
      { ...workspacesBefore[0], ...on, session_messages_paused_at: null, session_messages_paused_by: null, session_messages_counted_from: hourAgo },
      // The limit's pause stays, to lift by itself once the count falls.
      { ...workspacesBefore[1], ...on, session_messages_paused_at: at, session_messages_paused_by: 'limit' }
    ])
    expect(rows('SELECT * FROM session ORDER BY session_id')).toEqual(sessionsBefore.map((row) => ({ ...row, receive_messages: 1, setup_purpose_json: null })))
    expect(rows('SELECT * FROM session_message_pair')).toEqual(pairsBefore)
    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migration').get()).toEqual({ version: 34 })

    // A workspace created after the upgrade is on, though the column's declared default is still 0; the record
    // carries no switch.
    database.transaction(() => createWorkspace(database, { name: 'New' }, 'w-new', at))()
    expect(database.prepare("SELECT session_messages, turn_changes FROM workspace WHERE workspace_id = 'w-new'").get()).toEqual(on)
    expect(selectWorkspace(database, 'w-new')).not.toHaveProperty('sessionMessages')
    expect(selectWorkspace(database, 'w-new')).not.toHaveProperty('turnChanges')
    // Running it again changes nothing.
    const after = rows('SELECT * FROM workspace ORDER BY workspace_id')
    initializeDatabase(database, '2026-10-16T02:00:00.000Z')
    expect(rows('SELECT * FROM workspace ORDER BY workspace_id')).toEqual(after)
    expect(database.pragma('foreign_key_check')).toEqual([])
  } finally { database.close() }
})

it('starts a fresh database with its default workspace on, and every workspace and session created later (Story 75.4)', () => {
  const database = new BetterSqlite3(':memory:')
  const at = '2026-10-16T00:00:00.000Z'
  try {
    initializeDatabase(database, at)
    expect(database.prepare('SELECT session_messages, turn_changes FROM workspace WHERE workspace_id = ?').get(DEFAULT_WORKSPACE_ID))
      .toEqual({ session_messages: 1, turn_changes: 1 })
    database.transaction(() => createWorkspace(database, { name: 'Shop' }, 'w-shop', at))()
    database.prepare(
      `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
       VALUES ('s-new', 'w-shop', 'New', '/work', '/bin/bash', '[]', 1, ?, 0)`
    ).run(at)
    expect(database.prepare("SELECT session_messages, turn_changes FROM workspace WHERE workspace_id = 'w-shop'").get())
      .toEqual({ session_messages: 1, turn_changes: 1 })
    expect(database.prepare("SELECT receive_messages FROM session WHERE session_id = 's-new'").get()).toEqual({ receive_messages: 1 })
  } finally { database.close() }
})
