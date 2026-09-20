import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '@bmn/protocol'
import { WORKSPACE_MARKERS } from '@bmn/protocol'
import { WORKSPACE_MARKER_PRESENTATION, workspaceMarkerLabel } from './theme'
import { markerForWorkspace, workspaceMarkerOptions } from './workspace-marker'

const workspace = (workspaceId: string, name: string, marker: WorkspaceRecord['marker']): WorkspaceRecord => ({
  workspaceId,
  name,
  defaultCwd: null,
  position: 0,
  marker,
  archivedAt: null,
  revision: 1
})

const workspaces: WorkspaceRecord[] = [
  workspace('home', 'Personal', 'teal'),
  workspace('work', 'Work', 'violet'),
  workspace('gone', 'Retired', 'rose')
]

describe('workspace marker presentation', () => {
  it('offers every curated choice once, in the order the epic names them', () => {
    expect(workspaceMarkerOptions().map((option) => option.value)).toEqual([...WORKSPACE_MARKERS])
    expect(workspaceMarkerOptions().map((option) => option.label))
      .toEqual(['None', 'Slate', 'Teal', 'Blue', 'Violet', 'Rose'])
    expect(new Set(Object.keys(WORKSPACE_MARKER_PRESENTATION))).toEqual(new Set(WORKSPACE_MARKERS))
  })

  it('names the workspace first, so identity survives without the hue', () => {
    expect(workspaceMarkerLabel('Personal', 'teal')).toBe('Personal workspace · Teal marker')
    expect(workspaceMarkerLabel('Personal', 'none')).toBe('Personal workspace')
    // Two workspaces on the same marker are still told apart by the name in the label.
    expect(workspaceMarkerLabel('Work', 'teal')).not.toBe(workspaceMarkerLabel('Personal', 'teal'))
  })

  it("takes a pane's marker from its own workspace, never from the active one", () => {
    expect(markerForWorkspace(workspaces, 'work')).toEqual({ name: 'Work', marker: 'violet' })
    expect(markerForWorkspace(workspaces, 'home')).toEqual({ name: 'Personal', marker: 'teal' })
  })

  it('has no marker for a pane whose workspace is unknown or whose session is not loaded', () => {
    expect(markerForWorkspace(workspaces, undefined)).toBeNull()
    expect(markerForWorkspace(workspaces, 'never-created')).toBeNull()
  })

  it('still resolves a workspace that is archived, because its panes can stay in a split', () => {
    const archived = [...workspaces.slice(0, 2), { ...workspaces[2]!, archivedAt: '2026-09-20T00:00:00Z' }]
    expect(markerForWorkspace(archived, 'gone')).toEqual({ name: 'Retired', marker: 'rose' })
  })
})
