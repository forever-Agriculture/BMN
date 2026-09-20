import type { PersistedConversationBinding } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { parseBoundBinding } from './conversation-binding'

function parsedForWrite(input: unknown): PersistedConversationBinding {
  const suppliedStatus = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).status
    : undefined
  const suppliedDetail = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).detail
    : undefined
  const binding = parseBoundBinding(input)
  if (
    suppliedStatus !== binding.status ||
    (suppliedStatus === 'unsupported' && suppliedDetail !== binding.detail)
  ) {
    throw new Error(binding.detail)
  }
  return binding
}

function writeConversationBinding(
  database: DatabaseConnection,
  binding: PersistedConversationBinding,
  replace: boolean
): void {
  const conflictClause = replace
    ? `ON CONFLICT(session_id) DO UPDATE SET
         agent_cli = excluded.agent_cli,
         status = excluded.status,
         conversation_reference = excluded.conversation_reference,
         capture_route = excluded.capture_route,
         launch_cwd = excluded.launch_cwd,
         launch_executable = excluded.launch_executable,
         launch_argv_json = excluded.launch_argv_json,
         launch_environment_json = excluded.launch_environment_json,
         detail = excluded.detail,
         captured_at = excluded.captured_at`
    : ''
  database
    .prepare(
      `INSERT INTO conversation_binding(
        session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}`
    )
    .run(
      binding.sessionId,
      binding.agentCli,
      binding.status,
      binding.status === 'bound' ? binding.conversationReference : null,
      binding.captureRoute,
      binding.launchContext.cwd,
      binding.launchContext.executable,
      JSON.stringify(binding.launchContext.argv),
      JSON.stringify(binding.launchContext.environment),
      binding.detail,
      binding.capturedAt
    )
}

export function insertConversationBinding(
  database: DatabaseConnection,
  input: unknown
): void {
  writeConversationBinding(database, parsedForWrite(input), false)
}

/** Only a later capture may replace a stored binding: the owner's explicit reference, or the harness's own word. */
const REPLACEABLE_ROUTES = ['explicit-resume-reference', 'hook-session-start'] as const

export function replaceConversationBinding(
  database: DatabaseConnection,
  input: unknown
): PersistedConversationBinding {
  const binding = parsedForWrite(input)
  if (
    binding.status !== 'bound' ||
    !(REPLACEABLE_ROUTES as readonly string[]).includes(binding.captureRoute)
  ) {
    throw new Error('Replacement conversation bindings require an explicit resume reference or a hook observation')
  }
  writeConversationBinding(database, binding, true)
  return binding
}

export function clearConversationBinding(
  database: DatabaseConnection,
  sessionId: string
): boolean {
  const result = database
    .prepare('DELETE FROM conversation_binding WHERE session_id = ?')
    .run(sessionId)
  return Number(result.changes) === 1
}

export function selectConversationBinding(
  database: DatabaseConnection,
  sessionId: string
): PersistedConversationBinding | undefined {
  const row = database
    .prepare(
      `SELECT session_id, agent_cli, status, conversation_reference, capture_route,
              launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
              detail, captured_at
       FROM conversation_binding WHERE session_id = ?`
    )
    .get(sessionId) as Record<string, unknown> | undefined
  if (!row) return undefined
  let argv: unknown
  let environment: unknown
  try {
    argv = JSON.parse(typeof row.launch_argv_json === 'string' ? row.launch_argv_json : '')
    environment = JSON.parse(
      typeof row.launch_environment_json === 'string' ? row.launch_environment_json : ''
    )
  } catch {
    argv = undefined
    environment = undefined
  }
  return parseBoundBinding({
    sessionId,
    agentCli: row.agent_cli,
    status: row.status,
    ...(typeof row.conversation_reference === 'string'
      ? { conversationReference: row.conversation_reference }
      : {}),
    captureRoute: row.capture_route,
    launchContext: {
      cwd: row.launch_cwd,
      executable: row.launch_executable,
      argv,
      environment
    },
    detail: row.detail,
    capturedAt: row.captured_at
  })
}
