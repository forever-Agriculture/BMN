// MODULE: progress-evidence-probe.ts - what the Electron self-test proves about the progress evidence detail

export interface ProgressEvidenceProbe {
  /** The other pane's strip, whose session reported `verified` with one published file. */
  reportedStrip: string
  /** This pane's own strip, whose session reported nothing with it. */
  bareStrip: string
  /** The detail as it reads: the note, the provenance line and the one evidence row. */
  dialog: {
    title: string
    note: string
    provenance: string
    rowName: string
    rowAvailability: string
    previewText: string
  }
  /** Opening, previewing and closing the detail must touch neither the PTY nor the terminal's size. */
  quiet: {
    inputEventsBefore: number
    inputEventsAfter: number
    surfaceHeightBefore: number
    surfaceHeightWhileOpen: number
    surfaceHeightAfter: number
    gridBefore: { cols: number; rows: number }
    gridAfter: { cols: number; rows: number }
  }
  /** Escape closes it and hands focus back to the word that opened it. */
  focusReturnedToStrip: boolean
  /** The keyboard route: the pane's More menu, since xterm eats Tab inside the terminal. */
  openedFromPaneMenu: boolean
  /** This pane's own detail, opened from its menu: the same surface with nothing behind the claim. */
  bareDialog: { title: string; body: string }
}
