// MODULE: quick-look-probe.ts - what the Electron self-test proves about Quick look (Story 67.1), shared by renderer and main

export interface QuickLookFlowProbe {
  /**
   * Ctrl+Shift+E from the window opened the sheet. Focus went to the tree, or, when the root's remembered place
   * held a file (the file-reference phase opens printed paths here first, Story 67.6), to that file's view.
   */
  opened: boolean
  focusAtOpen: 'tree' | 'file' | 'elsewhere'
  /** The remembered file the sheet reopened, or null. */
  recalledAtOpen: string | null
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
