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
  'progress_evidence',
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
  },
  {
    version: 7,
    sql: `
      ALTER TABLE telegram_message ADD COLUMN incarnation_id TEXT;
    `
  },
  {
    // capture_route carries a SQL CHECK, which SQLite cannot alter, so the widened route needs a
    // table rebuild: create, copy every legacy row unchanged, drop, rename.
    version: 8,
    sql: `
      CREATE TABLE conversation_binding_next (
        session_id TEXT PRIMARY KEY REFERENCES session(session_id),
        agent_cli TEXT NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'other')),
        status TEXT NOT NULL CHECK (status IN ('bound', 'unsupported')),
        conversation_reference TEXT,
        capture_route TEXT NOT NULL CHECK (
          capture_route IN (
            'claude-session-id', 'explicit-resume-reference', 'hook-session-start', 'unsupported'
          )
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

      INSERT INTO conversation_binding_next(
        session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at
      )
      SELECT session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at
      FROM conversation_binding;

      DROP TABLE conversation_binding;

      ALTER TABLE conversation_binding_next RENAME TO conversation_binding;
    `
  },
  {
    // Request provenance: two nullable columns, so every legacy row reads as unknown provenance and
    // no other table changes. Backups and the archive purge carry them as ordinary request data.
    version: 9,
    sql: `
      ALTER TABLE attention_request ADD COLUMN opened_by TEXT;
      ALTER TABLE attention_request ADD COLUMN resolved_by TEXT;
    `
  },
  {
    // Workspace identity marker: one added column with a default, so every legacy workspace reads as
    // 'none' and looks exactly as it did. The CHECK keeps an unknown marker out of the column; the
    // store still maps an unexpected stored value back to 'none' rather than hiding the workspace.
    version: 10,
    sql: `
      ALTER TABLE workspace ADD COLUMN marker TEXT NOT NULL DEFAULT 'none'
        CHECK (marker IN ('none', 'slate', 'teal', 'blue', 'violet', 'rose'));
    `
  },
  {
    // Progress evidence: files a report points at, in one child table, so every legacy observation
    // reads as an empty list. The link belongs to the observation and goes with it, which is why the
    // foreign key is to progress_observation and cascades. There is deliberately NO reference to
    // artifact: deleting or losing an original must leave a visible, named, unavailable reference
    // rather than quietly erasing what a report claimed to rest on.
    version: 11,
    sql: `
      CREATE TABLE progress_evidence (
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        artifact_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        PRIMARY KEY (session_id, source, position),
        FOREIGN KEY (session_id, source) REFERENCES progress_observation(session_id, source)
          ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE INDEX progress_evidence_by_artifact ON progress_evidence(artifact_id);
    `
  },
  {
    // Resume-after-stop offer: one nullable column on the incarnation the stop interrupted, stamped
    // for every incarnation in a cohort once its dialog has been shown. Every legacy row reads as
    // never offered, which is what a session interrupted before this version should read as: the
    // offer is about the dialog, never about the process, so nothing starts from a missing stamp.
    version: 12,
    sql: `
      ALTER TABLE process_incarnation ADD COLUMN cohort_offered_at TEXT;
    `
  },
  {
    // Agent handoff provenance is additive. SQLite needs an attention table rebuild to widen its
    // kind CHECK; preserve every request and the partial open-key index without changing its IDs.
    version: 13,
    sql: `
      ALTER TABLE input_draft ADD COLUMN prepared_by TEXT CHECK (prepared_by IN ('agent'));

      CREATE TABLE attention_request_next (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        incarnation_id TEXT,
        request_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'review', 'notice', 'handoff')),
        title TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'withdrawn', 'expired')),
        resolution TEXT,
        opened_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        seen_at TEXT,
        revision INTEGER NOT NULL,
        opened_by TEXT,
        resolved_by TEXT
      );
      INSERT INTO attention_request_next
        SELECT request_id, session_id, incarnation_id, request_key, kind, title, body,
               state, resolution, opened_at, expires_at, resolved_at, seen_at, revision,
               opened_by, resolved_by FROM attention_request;
      DROP TABLE attention_request;
      ALTER TABLE attention_request_next RENAME TO attention_request;
      CREATE UNIQUE INDEX attention_open_key ON attention_request(session_id, request_key)
        WHERE state = 'open';
      CREATE INDEX input_draft_agent_source ON input_draft(source_session_id, created_at)
        WHERE prepared_by = 'agent';
    `
  },
  {
    // OpenCode adds a third bound harness. Rebuild both CHECKs unconditionally so every legacy row
    // survives verbatim, including unsupported rows and bindings captured before this release.
    version: 14,
    sql: `
      CREATE TABLE conversation_binding_next (
        session_id TEXT PRIMARY KEY REFERENCES session(session_id),
        agent_cli TEXT NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'opencode', 'other')),
        status TEXT NOT NULL CHECK (status IN ('bound', 'unsupported')),
        conversation_reference TEXT,
        capture_route TEXT NOT NULL CHECK (
          capture_route IN (
            'claude-session-id', 'explicit-resume-reference', 'hook-session-start', 'unsupported'
          )
        ),
        launch_cwd TEXT NOT NULL,
        launch_executable TEXT NOT NULL,
        launch_argv_json TEXT NOT NULL,
        launch_environment_json TEXT NOT NULL,
        detail TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        CHECK (
          (
            status = 'bound' AND agent_cli IN ('claude', 'codex', 'opencode') AND
            conversation_reference IS NOT NULL AND capture_route != 'unsupported'
          ) OR (
            status = 'unsupported' AND conversation_reference IS NULL AND
            capture_route = 'unsupported'
          )
        )
      );
      INSERT INTO conversation_binding_next(
        session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at
      )
      SELECT session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at FROM conversation_binding;
      DROP TABLE conversation_binding;
      ALTER TABLE conversation_binding_next RENAME TO conversation_binding;
    `
  }
])
