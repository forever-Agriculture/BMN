import {
  isWorkspaceLayoutState,
  type SessionRecord,
  type WorkspaceLayoutState
} from '@bmn/protocol'
import type { LayoutChange, LayoutWriter } from './layout-writer'

export type SessionView = WorkspaceLayoutState['sessionView'][string]

export interface OutputTransition {
  state: WorkspaceLayoutState
  scrollToBottom: boolean
}

/** The persisted view of a session that follows the tail; it never changes while output grows. */
export const FOLLOW_TAIL_VIEW: SessionView = Object.freeze({ scrollLine: null, followTail: true })

/**
 * The only view changes a session can request: a user scroll away from the tail (or within
 * history), or the explicit New-output action returning it to the tail.
 */
export type SessionViewUpdate =
  | { kind: 'scrolled-away'; scrollLine: number }
  | { kind: 'follow-tail' }

function accepted(
  state: WorkspaceLayoutState,
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  if (!isWorkspaceLayoutState(state, sessionIds)) {
    throw new Error('Workspace layout transition produced an invalid state')
  }
  return state
}

function sameView(left: SessionView | undefined, right: SessionView): boolean {
  return left?.scrollLine === right.scrollLine && left.followTail === right.followTail
}

/** A rebased change keeps ids already validated in the authoritative layout it receives. */
function sessionIdsForViewChange(
  state: WorkspaceLayoutState,
  sessionIds: readonly string[]
): string[] {
  return [
    ...sessionIds,
    ...state.split.panes.map((pane) => pane.sessionId),
    ...Object.keys(state.sessionView)
  ]
}

export function selectLayoutSession(
  state: WorkspaceLayoutState,
  sessionId: string,
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  const panes = state.split.panes
  const existing = panes.find((pane) => pane.sessionId === sessionId)
  const nextPanes = existing
    ? panes
    : panes.length === 0
      ? [{ sessionId, ratio: 1 }]
      : panes.map((pane) =>
          pane.sessionId === state.selectedSessionId ? { ...pane, sessionId } : pane
        )
  return accepted({
    ...state,
    selectedSessionId: sessionId,
    split: { ...state.split, panes: nextPanes },
    sessionView: {
      ...state.sessionView,
      [sessionId]: state.sessionView[sessionId] ?? FOLLOW_TAIL_VIEW
    }
  }, sessionIds)
}

export function splitLayoutSession(
  state: WorkspaceLayoutState,
  sessionId: string,
  sessionIds: readonly string[],
  orientation: WorkspaceLayoutState['split']['orientation'] = state.split.orientation
): WorkspaceLayoutState {
  if (state.split.panes.some((pane) => pane.sessionId === sessionId)) {
    return selectLayoutSession(state, sessionId, sessionIds)
  }
  if (state.split.panes.length >= 2) throw new Error('A workspace can show at most two panes')
  const paneIds = [...state.split.panes.map((pane) => pane.sessionId), sessionId]
  const ratio = 1 / paneIds.length
  return accepted({
    ...state,
    selectedSessionId: sessionId,
    split: { orientation, panes: paneIds.map((id) => ({ sessionId: id, ratio })) },
    sessionView: {
      ...state.sessionView,
      [sessionId]: state.sessionView[sessionId] ?? FOLLOW_TAIL_VIEW
    }
  }, sessionIds)
}

/** Removes a session's pane; the remaining pane takes the whole area and becomes selected. */
export function closeLayoutPane(
  state: WorkspaceLayoutState,
  sessionId: string,
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  const remaining = state.split.panes.filter((pane) => pane.sessionId !== sessionId)
  if (remaining.length === state.split.panes.length) return state
  return accepted({
    ...state,
    selectedSessionId: remaining[0]?.sessionId ?? null,
    split: { ...state.split, panes: remaining.map((pane) => ({ ...pane, ratio: 1 })) }
  }, sessionIds)
}

export const SPLIT_RATIO_RANGE = Object.freeze({ min: 0.15, max: 0.85 })

/** Sets the first pane's share of a two-pane split, clamped so both panes stay usable. */
export function resizeLayoutSplit(
  state: WorkspaceLayoutState,
  firstRatio: number,
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  const [first, second] = state.split.panes
  if (!first || !second || !Number.isFinite(firstRatio)) return state
  const ratio = Math.round(Math.min(SPLIT_RATIO_RANGE.max, Math.max(SPLIT_RATIO_RANGE.min, firstRatio)) * 1000) / 1000
  if (first.ratio === ratio) return state
  return accepted({
    ...state,
    split: { ...state.split, panes: [{ ...first, ratio }, { ...second, ratio: Math.round((1 - ratio) * 1000) / 1000 }] }
  }, sessionIds)
}

export function setLayoutOrientation(
  state: WorkspaceLayoutState,
  orientation: WorkspaceLayoutState['split']['orientation'],
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  if (state.split.orientation === orientation) return state
  return accepted({ ...state, split: { ...state.split, orientation } }, sessionIds)
}

/** A user scroll away from the tail; returns the same state when the view already matches. */
export function captureLayoutScroll(
  state: WorkspaceLayoutState,
  sessionId: string,
  scrollLine: number,
  sessionIds: readonly string[]
): WorkspaceLayoutState {
  const view: SessionView = { scrollLine, followTail: false }
  if (sameView(state.sessionView[sessionId], view)) return state
  return accepted({ ...state, sessionView: { ...state.sessionView, [sessionId]: view } }, sessionIds)
}

/** The explicit New-output action: the persisted view returns to the constant follow-tail view. */
export function resumeLayoutFollowTail(
  state: WorkspaceLayoutState,
  sessionId: string,
  sessionIds: readonly string[]
): OutputTransition {
  if (sameView(state.sessionView[sessionId], FOLLOW_TAIL_VIEW)) {
    return { state, scrollToBottom: true }
  }
  return {
    state: accepted(
      { ...state, sessionView: { ...state.sessionView, [sessionId]: FOLLOW_TAIL_VIEW } },
      sessionIds
    ),
    scrollToBottom: true
  }
}

/**
 * The scroll rule for a viewport event the user caused. A following session changes its view only
 * when the viewport leaves the tail; a session reading history records its new line. Reaching the
 * tail again does not resume following — only the explicit New-output action does.
 */
export function userScrollUpdate(
  view: SessionView,
  line: number,
  tailLine: number
): SessionViewUpdate | null {
  if (view.followTail) return line < tailLine ? { kind: 'scrolled-away', scrollLine: line } : null
  return line === view.scrollLine ? null : { kind: 'scrolled-away', scrollLine: line }
}

/** The persisted view of a session read from its OWN workspace's layout. Never throws. */
export function sessionLayoutView(
  layouts: Readonly<Record<string, WorkspaceLayoutState>>,
  sessions: readonly SessionRecord[],
  sessionId: string
): SessionView {
  const workspaceId = sessions.find((session) => session.sessionId === sessionId)?.workspaceId
  const view = workspaceId ? layouts[workspaceId]?.sessionView[sessionId] : undefined
  return view ?? FOLLOW_TAIL_VIEW
}

/**
 * The view-update router. It resolves the session's own workspace and validates new references
 * against the current session snapshot. When the writer rebases the change, ids already present in
 * authoritative layout state remain valid. An inactive session never updates another workspace.
 */
export function routeSessionView(
  sessions: readonly SessionRecord[],
  sessionId: string,
  update: SessionViewUpdate
): { workspaceId: string; change: LayoutChange } | null {
  const workspaceId = sessions.find((session) => session.sessionId === sessionId)?.workspaceId
  if (!workspaceId) return null
  const sessionIds = sessions.map((session) => session.sessionId)
  return {
    workspaceId,
    change: (state) => {
      if (state.workspaceId !== workspaceId) {
        throw new Error(`Session ${sessionId} does not belong to workspace ${state.workspaceId}`)
      }
      const acceptedSessionIds = sessionIdsForViewChange(state, sessionIds)
      return update.kind === 'follow-tail'
        ? resumeLayoutFollowTail(state, sessionId, acceptedSessionIds).state
        : captureLayoutScroll(state, sessionId, update.scrollLine, acceptedSessionIds)
    }
  }
}

/** Routes one session view update through the router into the single layout writer. Never throws. */
export function applySessionView(
  writer: Pick<LayoutWriter, 'apply'>,
  sessions: readonly SessionRecord[],
  sessionId: string,
  update: SessionViewUpdate
): boolean {
  const route = routeSessionView(sessions, sessionId, update)
  return route ? writer.apply(route.workspaceId, route.change) : false
}
