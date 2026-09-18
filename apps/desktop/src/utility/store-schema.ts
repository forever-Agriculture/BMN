import { DEFAULT_WORKSPACE_ID } from '@bmn/protocol'

export { DEFAULT_WORKSPACE_ID }

export const STORY_SCHEMA_TABLES = Object.freeze([
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
] as const)

export interface DatabaseMigration {
  version: number
  sql: string
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = Object.freeze([
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE workspace (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_cwd TEXT,
        archived_at TEXT,
        revision INTEGER NOT NULL
      );

      CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        executable TEXT NOT NULL,
        argv_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE process_incarnation (
        incarnation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        process_start_identity TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'exited', 'interrupted')),
        started_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        exit_signal INTEGER,
        exit_detail TEXT
      );

      INSERT INTO workspace(workspace_id, name, default_cwd, archived_at, revision)
      VALUES ('${DEFAULT_WORKSPACE_ID}', 'Personal', NULL, NULL, 1);
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE conversation_binding (
        session_id TEXT PRIMARY KEY REFERENCES session(session_id),
        agent_cli TEXT NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'other')),
        status TEXT NOT NULL CHECK (status IN ('bound', 'unsupported')),
        conversation_reference TEXT,
        capture_route TEXT NOT NULL CHECK (
          capture_route IN ('claude-session-id', 'explicit-resume-reference', 'unsupported')
        ),
        launch_cwd TEXT NOT NULL,
        launch_executable TEXT NOT NULL,
        launch_argv_json TEXT NOT NULL,
        launch_environment_json TEXT NOT NULL,
        detail TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        CHECK (
          (
            status = 'bound' AND agent_cli IN ('claude', 'codex') AND
            conversation_reference IS NOT NULL AND capture_route != 'unsupported'
          ) OR (
            status = 'unsupported' AND conversation_reference IS NULL AND
            capture_route = 'unsupported'
          )
        )
      );
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE workspace ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session ADD COLUMN background_choice TEXT NULL CHECK (
        background_choice IN ('hide', 'stop') OR background_choice IS NULL
      );

      CREATE TABLE launch_template (
        template_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executable TEXT NOT NULL,
        argv_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        background_choice TEXT NULL CHECK (
          background_choice IN ('hide', 'stop') OR background_choice IS NULL
        ),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE workspace_layout (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
        layout_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      WITH ranked AS (
        SELECT workspace_id, ROW_NUMBER() OVER (ORDER BY workspace_id) - 1 AS next_position
        FROM workspace
      )
      UPDATE workspace
      SET position = (
        SELECT next_position FROM ranked WHERE ranked.workspace_id = workspace.workspace_id
      );

      WITH ranked AS (
        SELECT session_id,
               ROW_NUMBER() OVER (
                 PARTITION BY workspace_id ORDER BY created_at, session_id
               ) - 1 AS next_position
        FROM session
      )
      UPDATE session
      SET position = (
        SELECT next_position FROM ranked WHERE ranked.session_id = session.session_id
      );

      INSERT INTO workspace_layout(workspace_id, layout_json, revision, updated_at)
      SELECT workspace_id,
             json_object(
               'workspaceId', workspace_id,
               'selectedSessionId', NULL,
               'split', json_object('orientation', 'side-by-side', 'panes', json_array()),
               'sessionView', json_object(),
               'revision', 1
             ),
             1,
             CURRENT_TIMESTAMP
      FROM workspace;
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE artifact (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES session(session_id),
        incarnation_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
        source TEXT NOT NULL CHECK (source IN ('owner', 'agent', 'telegram')),
        original_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        stored_path TEXT NOT NULL,
        source_path TEXT,
        state TEXT NOT NULL CHECK (state IN ('ready', 'missing', 'corrupt')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX artifact_by_session ON artifact(session_id, created_at);

      CREATE TABLE attention_request (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        incarnation_id TEXT,
        request_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'review', 'notice')),
        title TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'withdrawn', 'expired')),
        resolution TEXT,
        opened_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        seen_at TEXT,
        revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX attention_open_key ON attention_request(session_id, request_key)
        WHERE state = 'open';

      CREATE TABLE progress_observation (
        session_id TEXT NOT NULL REFERENCES session(session_id),
        source TEXT NOT NULL,
        incarnation_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('running', 'waiting', 'blocked', 'claimed-done', 'verified', 'failed', 'unknown')
        ),
        label TEXT NOT NULL,
        detail TEXT,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source)
      );

      CREATE TABLE control_receipt (
        receipt_key TEXT PRIMARY KEY,
        params_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('staged', 'done', 'failed')),
        result_json TEXT,
        error_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE input_draft (
        draft_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        origin TEXT NOT NULL CHECK (origin IN ('telegram', 'control')),
        origin_key TEXT UNIQUE,
        request_id TEXT,
        text TEXT,
        artifact_id TEXT REFERENCES artifact(artifact_id),
        state TEXT NOT NULL CHECK (
          state IN ('draft', 'accepted', 'submitted', 'uncertain', 'discarded')
        ),
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE telegram_message (
        message_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        request_id TEXT,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE app_setting (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 5,
    sql: `
      ALTER TABLE session ADD COLUMN archived_at TEXT;
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE input_draft RENAME TO input_draft_legacy;

      CREATE TABLE input_draft (
        draft_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        origin TEXT NOT NULL CHECK (origin IN ('telegram', 'control', 'handoff')),
        origin_key TEXT UNIQUE,
        source_session_id TEXT REFERENCES session(session_id) ON DELETE SET NULL,
        request_id TEXT,
        text TEXT,
        artifact_id TEXT REFERENCES artifact(artifact_id),
        artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        attempted_incarnation_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('draft', 'accepted', 'submitted', 'uncertain', 'discarded')
        ),
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO input_draft(
        draft_id, session_id, origin, origin_key, source_session_id, request_id, text,
        artifact_id, artifact_ids_json, attempted_incarnation_id, state, detail, created_at, updated_at
      )
      SELECT draft_id, session_id, origin, origin_key, NULL, request_id, text,
        artifact_id, '[]', NULL, state, detail, created_at, updated_at
      FROM input_draft_legacy;

      DROP TABLE input_draft_legacy;
    `
  }
])
