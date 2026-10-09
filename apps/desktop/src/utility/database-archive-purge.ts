// MODULE: database-archive-purge.ts - deletes sessions and workspaces archived longer than the owner's chosen period
import { DEFAULT_WORKSPACE_ID } from '@bmn/protocol'
import { getSettings } from './database-companion-store'
import type { DatabaseConnection } from './database-initialization'

export interface ArchivePurgeResult {
  sessionIds: string[]
  workspaceIds: string[]
  /** Originals whose records went with their sessions; the caller removes the files after commit. */
  originals: Array<{ artifactId: string; sha256: string }>
}

const DAY_MS = 86_400_000

/** Rows that point at a session and go with it. Artifacts are handled apart: see expiredArtifacts. */
const SESSION_CHILD_TABLES = [
  'input_draft',
  'telegram_message',
  'attention_request',
  // Before its observation: the cascade would take it anyway, but the purge should not depend on a pragma.
  'progress_evidence',
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
  if (days === null) return { sessionIds: [], workspaceIds: [], originals: [] }
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

  // Read before the drafts go: they decide which files a kept session still needs.
  const artifacts = expiredArtifacts(database, deletedSessions)
  const deleteChildren = SESSION_CHILD_TABLES.map((table) =>
    database.prepare(`DELETE FROM ${table} WHERE session_id = ?`))
  for (const { session_id: sessionId } of sessions) {
    for (const statement of deleteChildren) statement.run(sessionId)
  }
  const unlinkArtifact = database.prepare('UPDATE artifact SET session_id = NULL WHERE artifact_id = ?')
  const deleteArtifact = database.prepare('DELETE FROM artifact WHERE artifact_id = ?')
  const originals: ArchivePurgeResult['originals'] = []
  for (const artifact of artifacts) {
    if (artifact.needed) {
      unlinkArtifact.run(artifact.artifactId)
    } else {
      deleteArtifact.run(artifact.artifactId)
      originals.push({ artifactId: artifact.artifactId, sha256: artifact.sha256 })
    }
  }
  const deleteSession = database.prepare('DELETE FROM session WHERE session_id = ?')
  for (const { session_id: sessionId } of sessions) deleteSession.run(sessionId)

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
  return { sessionIds: sessions.map((row) => row.session_id), workspaceIds, originals }
}

/**
 * Files that go with the deleted sessions: their own, plus unlinked files an earlier purge kept only for
 * a handoff that is now deleted too. A file stays, unlinked, while a kept session's handoff that was not
 * discarded still names it, since that session may have it or still paste it. A draft's single
 * artifact_id is a foreign key, so any kept draft holding it keeps the file whatever its state.
 */
function expiredArtifacts(
  database: DatabaseConnection,
  deleted: ReadonlySet<string>
): Array<{ artifactId: string; sha256: string; needed: boolean }> {
  if (deleted.size === 0) return []
  const rows = database.prepare(
    `WITH deleted(session_id) AS (SELECT value FROM json_each(?)),
     reference(session_id, state, artifact_id, foreign_key) AS (
       SELECT session_id, state, artifact_id, 1 FROM input_draft WHERE artifact_id IS NOT NULL
       UNION ALL
       SELECT draft.session_id, draft.state, entry.value, 0
       FROM input_draft AS draft, json_each(draft.artifact_ids_json) AS entry
       WHERE json_valid(draft.artifact_ids_json)
     )
     SELECT artifact.artifact_id, artifact.sha256,
       EXISTS (
         SELECT 1 FROM reference
         WHERE reference.artifact_id = artifact.artifact_id
           AND reference.session_id NOT IN (SELECT session_id FROM deleted)
           AND (reference.foreign_key = 1 OR reference.state <> 'discarded')
       ) AS needed
     FROM artifact
     WHERE artifact.session_id IN (SELECT session_id FROM deleted)
        OR (artifact.session_id IS NULL AND artifact.artifact_id IN (
          SELECT artifact_id FROM reference WHERE session_id IN (SELECT session_id FROM deleted)))
     ORDER BY artifact.artifact_id`
  ).all(JSON.stringify([...deleted])) as Array<{ artifact_id: string; sha256: string; needed: number }>
  return rows.map((row) => ({ artifactId: row.artifact_id, sha256: row.sha256, needed: row.needed === 1 }))
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
