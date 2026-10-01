// One transient, revision-addressed restore. It never selects, opens or starts anything.
import type { SessionRecord, WorkspaceRecord } from '@bmn/protocol'

export type ArchiveUndoTarget = { kind: 'workspace' | 'session'; id: string; revision: number }
type RestoreApi = Pick<Window['aiTerminal'], 'listWorkspaces' | 'listSessions' | 'updateWorkspace' | 'updateSession'>
export type ArchiveRestored = { kind: 'workspace'; record: WorkspaceRecord } | { kind: 'session'; record: SessionRecord }

export async function restoreArchive(target: ArchiveUndoTarget, api: RestoreApi): Promise<ArchiveRestored> {
  const workspaces = await api.listWorkspaces(true)
  if (target.kind === 'workspace') {
    const workspace = workspaces.find(row => row.workspaceId === target.id)
    if (!workspace?.archivedAt || workspace.revision !== target.revision) throw new Error('That archive changed; Undo is no longer available.')
    return { kind: 'workspace', record: await api.updateWorkspace({ workspaceId: target.id, expectedRevision: target.revision, archived: false }) }
  }
  for (const workspace of workspaces) {
    const session = (await api.listSessions(workspace.workspaceId)).find(row => row.sessionId === target.id)
    if (!session) continue
    if (workspace.archivedAt !== null) throw new Error('Restore the parent workspace first; this Undo cannot restore it.')
    if (!session.archivedAt || session.revision !== target.revision) throw new Error('That archive changed; Undo is no longer available.')
    return { kind: 'session', record: await api.updateSession({ sessionId: target.id, expectedRevision: target.revision, archived: false }) }
  }
  throw new Error('That session is no longer available to Undo.')
}
