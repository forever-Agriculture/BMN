// MODULE: quick-look-keys.ts - the one line of keys Quick look's footer shows for whatever has focus (Story 67.1 AC10)

export type QuickLookFocus = 'field' | 'tree' | 'file'

export interface QuickLookHint {
  keys: string[]
  label: string
}

export interface QuickLookFooterState {
  focus: QuickLookFocus
  fileOpen: boolean
  /** Letters typed in the tree, which Esc clears before it closes anything. */
  typed: boolean
  folded: boolean
}

const hint = (label: string, ...keys: string[]): QuickLookHint => ({ keys, label })

/** The keys of the state the sheet is in, left to right; "Hold F8 Show terminals" stands apart at the right. */
export function quickLookFooter(state: QuickLookFooterState): QuickLookHint[] {
  const escape = hint(state.typed ? 'Clear typed' : 'Close', 'Esc')
  if (state.focus === 'tree') {
    return [
      hint('Move', '↑ ↓'),
      hint('Fold', '← →'),
      hint('Open', 'Enter'),
      hint('Jump to name', 'A–Z'),
      ...(state.fileOpen ? [hint('File', 'Tab')] : []),
      hint('Hide tree', 'Ctrl B'),
      escape
    ]
  }
  if (state.focus === 'file') {
    return [
      hint('Move', '↑ ↓'),
      ...(state.folded ? [hint('Show tree', 'Ctrl B')] : [hint('Tree', 'Tab')]),
      escape
    ]
  }
  return [
    ...(state.folded ? [hint('Show tree', 'Ctrl B')] : [hint('Tree', 'Tab')]),
    escape
  ]
}
