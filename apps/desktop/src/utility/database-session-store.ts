import type {
  PersistedConversationBinding,
  ReplaceableConversationBinding
} from '@bmn/protocol'
import {
  clearConversationBinding,
  insertConversationBinding,
  replaceConversationBinding,
  selectConversationBinding
} from './database-binding-store'
import type { DatabaseConnection, SqlValue } from './database-initialization'
import type {
  CreateResumingRecord,
  CreateStartingRecord,
  IncarnationExit
} from './session-manager'

function insertIncarnation(
  database: DatabaseConnection,
  record: CreateResumingRecord & { sessionId: string }
): void {
  database
    .prepare(
      `INSERT INTO process_incarnation(
        incarnation_id, session_id, process_start_identity, state, started_at
      ) VALUES (?, ?, ?, 'starting', ?)`
    )
    .run(
      record.incarnationId,
      record.sessionId,
      record.processStartIdentity,
      record.startedAt
    )
}

/** Production SQLite write used by the database worker for a newly created session. */
export function createStartingSession(
  database: DatabaseConnection,
  record: CreateStartingRecord
): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO session(
          session_id, workspace_id, name, cwd, executable, argv_json,
          revision, created_at, position, background_choice
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?,
          COALESCE((SELECT MAX(position) + 1 FROM session WHERE workspace_id = ?), 0), ?)`
      )
      .run(
        record.sessionId,
        record.workspaceId,
        record.name,
        record.cwd,
        record.executable,
        JSON.stringify(record.argv),
        record.startedAt,
        record.workspaceId,
        record.backgroundChoice
      )
    insertConversationBinding(database, record.binding)
    insertIncarnation(database, record)
  })()
}

/** Production SQLite write used by the database worker for a resumed session incarnation. */
export function createResumingSession(
  database: DatabaseConnection,
  record: CreateResumingRecord
): void {
  insertIncarnation(database, record)
}

function updateState(
  database: DatabaseConnection,
  incarnationId: string,
  fromStates: readonly string[],
  state: 'running' | 'exited' | 'interrupted',
  exit?: IncarnationExit,
  reason?: string
): void {
  const placeholders = fromStates.map(() => '?').join(', ')
  const values: SqlValue[] = [state]
  let suffix = ''
  if (state === 'exited') {
    suffix = ', exited_at = ?, exit_code = ?, exit_signal = ?, exit_detail = NULL'
    values.push(new Date().toISOString(), exit!.exitCode, exit?.signal ?? null)
  } else if (state === 'interrupted') {
    suffix = ', exited_at = ?, exit_code = NULL, exit_signal = NULL, exit_detail = ?'
    values.push(new Date().toISOString(), reason!.slice(0, 240))
  }
  values.push(incarnationId, ...fromStates)
  const result = database
    .prepare(
      `UPDATE process_incarnation SET state = ?${suffix}
       WHERE incarnation_id = ? AND state IN (${placeholders})`
    )
    .run(...values)
  if (Number(result.changes) !== 1) throw new Error(`incarnation ${incarnationId} is not current`)
}

export function markSessionRunning(database: DatabaseConnection, incarnationId: string): void {
  updateState(database, incarnationId, ['starting'], 'running')
}

export function markSessionExited(
  database: DatabaseConnection,
  incarnationId: string,
  exit: IncarnationExit
): void {
  // Once lifecycle intent owns an interruption, no later exit callback may downgrade its cause.
  updateState(database, incarnationId, ['starting', 'running'], 'exited', exit)
}

export function markSessionInterrupted(
  database: DatabaseConnection,
  incarnationId: string,
  reason: string
): void {
  // A late PTY exit during a lifecycle stop adds its observed signal/code to the interruption
  // detail. Keeping interrupted in the allowed source states makes that evidence update atomic.
  updateState(database, incarnationId, ['starting', 'running', 'interrupted'], 'interrupted', undefined, reason)
}

export function getSessionConversationBinding(
  database: DatabaseConnection,
  sessionId: string
): PersistedConversationBinding | undefined {
  return selectConversationBinding(database, sessionId)
}

export function replaceSessionConversationBinding(
  database: DatabaseConnection,
  binding: ReplaceableConversationBinding
): PersistedConversationBinding {
  return database.transaction(() => replaceConversationBinding(database, binding))()
}

export function clearSessionConversationBinding(
  database: DatabaseConnection,
  sessionId: string
): boolean {
  return database.transaction(() => clearConversationBinding(database, sessionId))()
}
