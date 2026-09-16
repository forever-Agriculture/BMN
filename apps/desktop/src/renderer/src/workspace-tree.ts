import type { SessionRecord, WorkspaceRecord } from '@ai-terminal/protocol'
import type { LayoutChange } from './layout-writer'
import { selectLayoutSession, splitLayoutSession } from './workspace-layout'

/**
 * The sidebar tree state. Per-workspace session selection is not held here: its single owner is each
 * workspace layout's `selectedSessionId`, changed through the layout writer.
 */
export interface WorkspaceTreeState {
  selectedWorkspaceId: string | null
  expandedWorkspaceIds: ReadonlySet<string>
  showArchived: boolean
}

/**
 * A tree action on a session: the tree update (selects the session's own workspace) plus the change
 * for that workspace's layout. Both are functions of the current state so a late caller never
 * applies a stale snapshot.
 */
export interface TreeSessionAction {
  workspaceId: string
  tree(state: WorkspaceTreeState): WorkspaceTreeState
  change: LayoutChange
}

export function initialWorkspaceTree(
  workspaces: readonly WorkspaceRecord[],
  selectedWorkspaceId: string | null
): WorkspaceTreeState {
  return {
    selectedWorkspaceId,
    expandedWorkspaceIds: new Set(
      workspaces.filter((workspace) => workspace.archivedAt === null).map((workspace) => workspace.workspaceId)
    ),
    showArchived: false
  }
}

export function visibleWorkspaces(
  workspaces: readonly WorkspaceRecord[],
  showArchived: boolean
): WorkspaceRecord[] {
  return workspaces
    .filter((workspace) => showArchived || workspace.archivedAt === null)
    .toSorted((left, right) => left.position - right.position || left.workspaceId.localeCompare(right.workspaceId))
}

export function orderedWorkspaceSessions(
  sessions: readonly SessionRecord[],
  workspaceId: string
): SessionRecord[] {
  return sessions
    .filter((session) => session.workspaceId === workspaceId)
    .toSorted((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt) || left.sessionId.localeCompare(right.sessionId))
}

/** The sessions the sidebar lists: archived ones only while Show archived is on. */
export function visibleWorkspaceSessions(
  sessions: readonly SessionRecord[],
  workspaceId: string,
  showArchived: boolean
): SessionRecord[] {
  return orderedWorkspaceSessions(sessions, workspaceId)
    .filter((session) => showArchived || session.archivedAt === null)
}

export function selectTreeWorkspace(
  state: WorkspaceTreeState,
  workspaceId: string
): WorkspaceTreeState {
  return state.selectedWorkspaceId === workspaceId ? state : { ...state, selectedWorkspaceId: workspaceId }
}

/** The workspace row: toggles that workspace's expansion and makes it the selected workspace. */
export function toggleWorkspaceExpanded(
  state: WorkspaceTreeState,
  workspaceId: string
): WorkspaceTreeState {
  const expanded = new Set(state.expandedWorkspaceIds)
  if (expanded.has(workspaceId)) expanded.delete(workspaceId)
  else expanded.add(workspaceId)
  return { ...state, selectedWorkspaceId: workspaceId, expandedWorkspaceIds: expanded }
}

export function toggleShowArchived(state: WorkspaceTreeState): WorkspaceTreeState {
  return { ...state, showArchived: !state.showArchived }
}

function sessionAction(
  sessions: readonly SessionRecord[],
  sessionId: string,
  transition: (layout: Parameters<LayoutChange>[0], sessionId: string, sessionIds: readonly string[]) => ReturnType<LayoutChange>
): TreeSessionAction | null {
  const workspaceId = sessions.find((session) => session.sessionId === sessionId)?.workspaceId
  if (!workspaceId) return null
  const sessionIds = sessions.map((session) => session.sessionId)
  return {
    workspaceId,
    tree: (state) => selectTreeWorkspace(state, workspaceId),
    change: (layout) => {
      if (layout.workspaceId !== workspaceId) {
        throw new Error(`Session ${sessionId} does not belong to workspace ${layout.workspaceId}`)
      }
      return transition(layout, sessionId, sessionIds)
    }
  }
}

/** Selecting a session selects its own workspace and makes it that workspace layout's selection. */
export function selectTreeSession(
  sessions: readonly SessionRecord[],
  sessionId: string
): TreeSessionAction | null {
  return sessionAction(sessions, sessionId, selectLayoutSession)
}

/** Split shows the session beside the current pane of its own workspace and selects it. */
export function splitTreeSession(
  sessions: readonly SessionRecord[],
  sessionId: string
): TreeSessionAction | null {
  return sessionAction(sessions, sessionId, (layout, id, ids) => splitLayoutSession(layout, id, ids))
}

export function adjacentPositionUpdates<T extends { position: number }>(
  ordered: readonly T[],
  index: number,
  direction: -1 | 1
): Array<{ record: T; position: number }> {
  const otherIndex = index + direction
  const current = ordered[index]
  const other = ordered[otherIndex]
  if (!current || !other) return []
  return [
    { record: current, position: other.position },
    { record: other, position: current.position }
  ]
}
