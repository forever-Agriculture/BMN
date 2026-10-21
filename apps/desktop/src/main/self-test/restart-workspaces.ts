// MODULE: restart-workspaces.ts - Exact identities and persisted workspace state across the self-test host restart.
import type { WorkspaceRecord } from '@bmn/protocol'

export function workspacePersistenceView(row: WorkspaceRecord): WorkspaceRecord {
  return { workspaceId: row.workspaceId, name: row.name, defaultCwd: row.defaultCwd, pinnedFilePaths: [...row.pinnedFilePaths],
    position: row.position, marker: row.marker, archivedAt: row.archivedAt, revision: row.revision }
}

/** Expected IDs come from creation receipts, never from the restored list; duplicates and unknown fixtures fail. */
export function workspaceRestorationMatches(expectedIds: readonly string[], before: readonly WorkspaceRecord[], after: readonly WorkspaceRecord[]): boolean {
  if (expectedIds.length !== 4 || new Set(expectedIds).size !== 4 || expectedIds.some(id => !id)) return false
  for (const rows of [before, after]) {
    if (rows.length !== expectedIds.length || new Set(rows.map(row => row.workspaceId)).size !== expectedIds.length ||
      rows.some(row => !expectedIds.includes(row.workspaceId))) return false
  }
  return JSON.stringify(before.map(workspacePersistenceView)) === JSON.stringify(after.map(workspacePersistenceView))
}
