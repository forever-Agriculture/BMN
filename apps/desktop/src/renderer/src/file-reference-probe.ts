// MODULE: file-reference-probe.ts - what the Electron self-test proves about file references, shared by renderer and main

export interface FileReferenceFlowProbe {
  launchDirectory: string
  palette: {
    focusedInput: boolean
    base: string
    file: string
    marked: string
    position: string
    copied: string
    shownFeedback: string
    focusReturned: boolean
  }
  shellDirectoryIgnored: { base: string; file: string; message: string }
  chosenFolder: { pickerMessage: string; kind: string; canonicalPath: string }
  rejected: { message: string; inputPreserved: boolean }
  link: {
    reference: string
    session: string
    marked: string
    selectedElsewhere: boolean
    underlinedWithCtrl: boolean
    focusReturned: boolean
  }
  /**
   * Ctrl+click in the order macOS delivers it: press, context menu, release. It opens the file once, and focus
   * returns to the clicked terminal, which xterm focuses on a context menu.
   */
  contextMenuClick: { reference: string; focusReturned: boolean }
  plainClick: { underlined: boolean; opened: boolean }
  /** A Ctrl+drag across a link stays a selection that copies, not an open. */
  ctrlDrag: { selected: string; copiedSelection: boolean; opened: boolean }
  /** The typed error code when the source session no longer exists. */
  missingSessionCode: string
  mouseMode: { underlined: boolean; opened: boolean; reportsToProgram: number; dragReportsToProgram: number; copiedSelection: boolean }
  /** Palette opening from a pane that shows another workspace's session: its own name, workspace and base. */
  crossWorkspace: { session: string; base: string; file: string; marked: string } | null
  /** Output rewrote a hovered link: the old link stays shut, and the reference printed in its place opens as itself. */
  redraw: {
    underlinedBefore: boolean
    staleOpened: boolean
    staleUnderlined: boolean
    reference: string
    marked: string
    ptyInputEvents: number
  }
  /** Input events xterm produced for the PTY while nothing but file-reference actions ran. */
  ptyInputEvents: number
  terminalUnchanged: boolean
  /** Grid size and refit count before and after, and whether the same xterm element stayed mounted. */
  terminalGeometry: { before: string; after: string; sameElement: boolean }
  attentionUnchanged: boolean
  epic27: {
    chooserDefaultEmpty: boolean
    chooserCrossWorkspace: boolean
    previewPayload: string
    previewTarget: string
    previewIncarnation: string
    pastedFeedback: string
    pastedIntoTarget: boolean
    focusLossClearedTarget: boolean
    searchCapLabel: string
    searchRows: number
    skippedRowsAbsent: boolean
    supersededRowsAbsent: boolean
    openedFromSession: string
    openedFile: string
    colonFile: string
    foreignSearchSession: string
    foreignSearchFile: string
    numericSuffixRejected: boolean
  } | null
}
