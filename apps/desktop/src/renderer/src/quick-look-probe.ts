// MODULE: quick-look-probe.ts - what the Electron self-test proves about Quick look (Story 67.1), shared by renderer and main

export interface QuickLookFlowProbe {
  /** Ctrl+Shift+E from the window opened the sheet, and focus went to the tree. */
  opened: boolean
  focusInTree: boolean
  rootShown: string
  rows: string[]
  pathRow: string
  /** Syntax classes drawn in the opened TypeScript file. */
  highlighted: { keyword: number; comment: number; def: number; lineNumbers: number }
  focusInFile: boolean
  closed: boolean
  refitsBefore: number
  refitsAfter: number
}
