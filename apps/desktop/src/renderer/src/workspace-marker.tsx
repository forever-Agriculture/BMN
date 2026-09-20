// MODULE: workspace-marker.tsx - the optional per-workspace identity mark shown beside a workspace name and in its panes
import type { WorkspaceMarker, WorkspaceRecord } from '@bmn/protocol'
import { WORKSPACE_MARKER_PRESENTATION, workspaceMarkerLabel } from './theme'

/**
 * A short solid bar, deliberately not the 7px circle every status mark uses: the marker says which
 * workspace this row or pane belongs to and never what the session is doing. `none` renders nothing
 * at all, so a workspace that never chose a marker looks exactly as it did before the choice existed.
 * The workspace name travels with it as the accessible name and the tooltip, so the identity is
 * readable without seeing the hue.
 */
export function WorkspaceIdentityMark(props: {
  workspaceName: string
  marker: WorkspaceMarker
  /**
   * Sidebar rows only. Once any workspace carries a marker, the unmarked rows hold an invisible slot
   * of the same width so the names keep one left edge; with no marker anywhere the slot is not there
   * at all and the sidebar is pixel-identical to what it was before the choice existed.
   */
  reserveSlot?: boolean
  /**
   * True where the workspace name is already beside the mark, as in the sidebar row: the mark is then
   * decoration and repeating the name would make a screen reader read it twice. A pane heading names
   * only its session, so there the mark carries the workspace as its accessible name.
   */
  decorative?: boolean
}): React.JSX.Element | null {
  if (props.marker === 'none') {
    return props.reserveSlot ? <span className="workspace-marker" aria-hidden="true" /> : null
  }
  const label = workspaceMarkerLabel(props.workspaceName, props.marker)
  return (
    <span
      className="workspace-marker"
      data-marker={props.marker}
      {...(props.decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': label })}
      title={label}
    />
  )
}

/** The swatch shown against each choice in the menu; the choice's name carries the meaning. */
export function WorkspaceMarkerSwatch(props: { marker: WorkspaceMarker }): React.JSX.Element {
  return <span className="workspace-marker menu-swatch" data-marker={props.marker} aria-hidden="true" />
}

/** A pane's marker comes from the session's own workspace, so a split never borrows the active one. */
export function markerForWorkspace(
  workspaces: readonly WorkspaceRecord[],
  workspaceId: string | undefined
): { name: string; marker: WorkspaceMarker } | null {
  if (workspaceId === undefined) return null
  const workspace = workspaces.find((item) => item.workspaceId === workspaceId)
  return workspace ? { name: workspace.name, marker: workspace.marker } : null
}

/** The menu's six exclusive choices, in the order the epic names them. */
export function workspaceMarkerOptions(): ReadonlyArray<{
  value: WorkspaceMarker
  label: string
  mark: React.JSX.Element
}> {
  return (Object.keys(WORKSPACE_MARKER_PRESENTATION) as WorkspaceMarker[]).map((marker) => ({
    value: marker,
    label: WORKSPACE_MARKER_PRESENTATION[marker].label,
    mark: <WorkspaceMarkerSwatch key={marker} marker={marker} />
  }))
}
