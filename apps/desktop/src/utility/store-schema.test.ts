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
  it('contains the five ordered migrations and only the owned tables', () => {
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5])
    expect(STORY_SCHEMA_TABLES).toEqual([
      'app_setting',
      'artifact',
      'attention_request',
      'control_receipt',
      'conversation_binding',
      'input_draft',
      'launch_template',
      'process_incarnation',
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
    expect(sql).toContain('conversation_reference text')
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
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }])
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
          { version: 5, applied_at: migratedAt }
        ])
      expect(database.prepare('SELECT COUNT(*) AS count FROM workspace_layout').get())
        .toEqual({ count: 2 })
    } finally {
      database.close()
    }
  })
})
