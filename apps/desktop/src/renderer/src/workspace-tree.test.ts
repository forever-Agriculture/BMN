// MODULE: workspace-tree.test.ts - sidebar tree semantics
import { describe, expect, it } from 'vitest'
import { emptyWorkspaceLayout, type SessionRecord, type WorkspaceRecord } from '@bmn/protocol'
import { selectLayoutSession, splitLayoutSession } from './workspace-layout'
import {
  adjacentPositionUpdates,
  initialWorkspaceTree,
  orderedWorkspaceSessions,
  selectTreeSession,
  selectTreeWorkspace,
  splitTreeSession,
  toggleShowArchived,
  toggleWorkspaceExpanded,
  visibleWorkspaceSessions,
  visibleWorkspaces
} from './workspace-tree'

const workspaces: WorkspaceRecord[] = [
  { workspaceId: 'b', name: 'B', defaultCwd: null, position: 1, archivedAt: null, revision: 1 },
  { workspaceId: 'a', name: 'A', defaultCwd: null, position: 0, archivedAt: null, revision: 1 },
  { workspaceId: 'c', name: 'C', defaultCwd: null, position: 2, archivedAt: '2026-09-13T00:00:00Z', revision: 2 }
]
const sessions: SessionRecord[] = ['a-2', 'a-1', 'b-1', 'b-2'].map((sessionId, index) => ({
  sessionId,
  workspaceId: sessionId[0]!,
  name: sessionId,
  cwd: '/workspace',
  executable: '/bin/bash',
  argv: [],
  position: index === 0 || index === 3 ? 1 : 0,
  backgroundChoice: null,
  revision: 1,
  createdAt: `2026-09-13T00:00:0${index}Z`,
  archivedAt: null,
  lastProcess: null
}))

const initial = initialWorkspaceTree(workspaces, 'a')

describe('workspace tree semantics', () => {
  it('preserves per-workspace selection and database session order while switching', () => {
    // ADAPTATION: per-workspace selection has one owner, each workspace layout's selectedSessionId.
    const layoutA = selectLayoutSession(emptyWorkspaceLayout('a'), 'a-2', ['a-1', 'a-2'])
    const layoutB = emptyWorkspaceLayout('b')
    const switched = selectTreeSession(sessions, 'b-1')!
    expect(switched.workspaceId).toBe('b')
    expect(switched.tree(initial).selectedWorkspaceId).toBe('b')
    expect(switched.change(layoutB).selectedSessionId).toBe('b-1')
    expect(() => switched.change(layoutA)).toThrow(/does not belong/)
    expect(layoutA.selectedSessionId).toBe('a-2')
    expect(selectTreeSession(sessions, 'unknown')).toBeNull()
    expect(orderedWorkspaceSessions(sessions, 'a').map((session) => session.sessionId))
      .toEqual(['a-1', 'a-2'])
  })

  it('splits within the session own workspace and selects that workspace', () => {
    const layoutB = selectLayoutSession(emptyWorkspaceLayout('b'), 'b-1', ['b-1', 'b-2'])
    const split = splitTreeSession(sessions, 'b-2')!
    expect(split.tree(initial).selectedWorkspaceId).toBe('b')
    expect(split.change(layoutB).split.panes.map((pane) => pane.sessionId)).toEqual(['b-1', 'b-2'])
  })

  it('selects normally after the workspace layout has held a foreign session', () => {
    const allSessionIds = sessions.map((session) => session.sessionId)
    const layoutA = splitLayoutSession(
      selectLayoutSession(emptyWorkspaceLayout('a'), 'a-2', allSessionIds),
      'b-1',
      allSessionIds
    )
    const selection = selectTreeSession(sessions, 'a-1')!

    expect(selection.change(layoutA).selectedSessionId).toBe('a-1')
  })

  it('expands unarchived workspaces initially and toggles one row, selecting its workspace', () => {
    expect([...initial.expandedWorkspaceIds].toSorted()).toEqual(['a', 'b'])
    const collapsed = toggleWorkspaceExpanded(initial, 'b')
    expect(collapsed.selectedWorkspaceId).toBe('b')
    expect(collapsed.expandedWorkspaceIds.has('b')).toBe(false)
    expect(toggleWorkspaceExpanded(collapsed, 'b').expandedWorkspaceIds.has('b')).toBe(true)
    expect(selectTreeWorkspace(initial, 'a')).toBe(initial)
    expect(selectTreeWorkspace(initial, 'c').selectedWorkspaceId).toBe('c')
  })

  it('keeps an archived workspace reachable only through Show archived', () => {
    expect(visibleWorkspaces(workspaces, initial.showArchived).map((item) => item.workspaceId))
      .toEqual(['a', 'b'])
    const showing = toggleShowArchived(initial)
    expect(visibleWorkspaces(workspaces, showing.showArchived).map((item) => item.workspaceId))
      .toEqual(['a', 'b', 'c'])
  })

  it('lists an archived session only while Show archived is on, in its usual place', () => {
    const withArchived = sessions.map((session) =>
      session.sessionId === 'a-1' ? { ...session, archivedAt: '2026-09-14T00:00:00Z' } : session)
    expect(visibleWorkspaceSessions(withArchived, 'a', false).map((session) => session.sessionId)).toEqual(['a-2'])
    expect(visibleWorkspaceSessions(withArchived, 'a', true).map((session) => session.sessionId)).toEqual(['a-1', 'a-2'])
  })

  it('expresses Move up/down as adjacent persisted position swaps', () => {
    const ordered = visibleWorkspaces(workspaces, true)
    expect(adjacentPositionUpdates(ordered, 1, -1)).toEqual([
      { record: workspaces[0], position: 0 },
      { record: workspaces[1], position: 1 }
    ])
    expect(adjacentPositionUpdates(ordered, 0, -1)).toEqual([])
  })
})
