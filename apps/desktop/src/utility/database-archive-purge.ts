// MODULE: database-archive-purge.ts - deletes sessions and workspaces archived longer than the owner's chosen period
import { DEFAULT_WORKSPACE_ID } from '@ai-terminal/protocol'
import { getSettings } from './database-companion-store'
import type { DatabaseConnection } from './database-initialization'

export interface ArchivePurgeResult {
  sessionIds: string[]
  workspaceIds: string[]
}

const DAY_MS = 86_400_000

/** Rows that point at a session and go with it; artifacts are kept and only lose their session link. */
const SESSION_CHILD_TABLES = [
  'input_draft',
  'telegram_message',
  'attention_request',
  'progress_observation',
  'conversation_binding',
  'process_incarnation'
] as const

/**
 * Permanently deletes sessions and workspaces archived before the retention cutoff. Runs once at host
 * start, before any process is launched and before a renderer has read the lists, so no live session
 * or open view can refer to a deleted row. The default workspace is never deleted. Run inside one
 * transaction.
 */
export function purgeExpiredArchives(database: DatabaseConnection, now: string): ArchivePurgeResult {
  const days = getSettings(database).archive.deleteAfterDays
  if (days === null) return { sessionIds: [], workspaceIds: [] }
  const cutoff = new Date(Date.parse(now) - days * DAY_MS).toISOString()

  const workspaceIds = (database
    .prepare(
      `SELECT workspace_id FROM workspace
       WHERE archived_at IS NOT NULL AND archived_at <= ? AND workspace_id <> ?`
    )
    .all(cutoff, DEFAULT_WORKSPACE_ID) as Array<{ workspace_id: string }>).map((row) => row.workspace_id)
  const deletedWorkspaces = new Set(workspaceIds)
  // An expired workspace takes all its sessions, archived or not.
  const sessions = database
    .prepare(
      `SELECT session_id, workspace_id FROM session
       WHERE (archived_at IS NOT NULL AND archived_at <= ?)
          OR workspace_id IN (SELECT value FROM json_each(?))
       ORDER BY session_id`
    )
    .all(cutoff, JSON.stringify(workspaceIds)) as Array<{ session_id: string; workspace_id: string }>
  const deletedSessions = new Set(sessions.map((row) => row.session_id))

  const unlinkArtifacts = database.prepare('UPDATE artifact SET session_id = NULL WHERE session_id = ?')
  const deleteChildren = SESSION_CHILD_TABLES.map((table) =>
    database.prepare(`DELETE FROM ${table} WHERE session_id = ?`))
  const deleteSession = database.prepare('DELETE FROM session WHERE session_id = ?')
  for (const { session_id: sessionId } of sessions) {
    unlinkArtifacts.run(sessionId)
    for (const statement of deleteChildren) statement.run(sessionId)
    deleteSession.run(sessionId)
  }

  // Any retained workspace may show a session from another workspace in its split.
  const keptWorkspaces = (database
    .prepare('SELECT workspace_id FROM workspace')
    .all() as Array<{ workspace_id: string }>)
    .map((row) => row.workspace_id)
    .filter((workspaceId) => !deletedWorkspaces.has(workspaceId))
  for (const workspaceId of keptWorkspaces) {
    forgetSessionsInLayout(database, workspaceId, deletedSessions, now)
  }
  for (const workspaceId of workspaceIds) {
    database.prepare('DELETE FROM workspace_layout WHERE workspace_id = ?').run(workspaceId)
    database.prepare('DELETE FROM workspace WHERE workspace_id = ?').run(workspaceId)
  }
  return { sessionIds: sessions.map((row) => row.session_id), workspaceIds }
}

/** Drops deleted sessions from a kept workspace's saved layout so it still validates on the next read. */
function forgetSessionsInLayout(
  database: DatabaseConnection,
  workspaceId: string,
  deleted: ReadonlySet<string>,
  now: string
): void {
  const row = database
    .prepare('SELECT layout_json, revision FROM workspace_layout WHERE workspace_id = ?')
    .get(workspaceId) as { layout_json: string; revision: unknown } | undefined
  if (!row || !Number.isSafeInteger(row.revision)) return
  let layout: {
    selectedSessionId: string | null
    split: { panes: Array<{ sessionId: string; ratio: number }> }
    sessionView: Record<string, unknown>
    revision: number
  }
  try {
    layout = JSON.parse(row.layout_json)
    if (!Array.isArray(layout.split?.panes) || !layout.sessionView || typeof layout.sessionView !== 'object') return
  } catch {
    // An unreadable layout already opens empty and is replaced by the next valid write.
    return
  }
  const panes = layout.split.panes.filter((pane) => !deleted.has(pane.sessionId))
  const views = Object.keys(layout.sessionView).filter((sessionId) => deleted.has(sessionId))
  if (panes.length === layout.split.panes.length && views.length === 0) return
  for (const sessionId of views) delete layout.sessionView[sessionId]
  if (panes.length !== layout.split.panes.length) {
    layout.split.panes = panes.map((pane) => ({ ...pane, ratio: panes.length === 1 ? 1 : pane.ratio }))
    if (layout.selectedSessionId === null || deleted.has(layout.selectedSessionId)) {
      layout.selectedSessionId = panes[0]?.sessionId ?? null
    }
  }
  const revision = Number(row.revision) + 1
  layout.revision = revision
  database
    .prepare('UPDATE workspace_layout SET layout_json = ?, revision = ?, updated_at = ? WHERE workspace_id = ?')
    .run(JSON.stringify(layout), revision, now, workspaceId)
}
