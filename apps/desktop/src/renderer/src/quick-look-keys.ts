// MODULE: quick-look-keys.ts - the one line of keys Quick look's footer shows for whatever has focus (Stories 67.1 AC10, 67.2 AC5)
import { ESCAPE_LABELS, type EscapeStep } from './quick-look-place'

/** Where the keys go: the top field, the tree, the open file, or the file's find or go-to-line row. */
export type QuickLookFocus = 'field' | 'tree' | 'file' | 'find' | 'goto'

interface QuickLookHint {
  keys: string[]
  label: string
}

interface QuickLookFooterState {
  focus: QuickLookFocus
  fileOpen: boolean
  /** What Esc does now, innermost first. */
  escape: EscapeStep
  folded: boolean
  /** A Markdown file's view, which M switches; null for any other file. */
  markdown?: 'rendered' | 'source' | null
  /** The shown file hides values, which Ctrl+R shows one at a time. */
  secrets?: boolean
  /** True when Alt+← has a file to return to. */
  back: boolean
  forward: boolean
  /** The top field shows results of this search (Story 67.5), or the paths the terminal printed (Story 67.6). */
  search?: 'files' | 'contents' | 'recent' | null
  /**
   * The shown file is edited: a .env file's rows or one of its fields (Story 68.1), or a config file in edit mode;
   * `config-available` is a config file E puts in edit mode (Story 68.2).
   */
  edit?: 'env-rows' | 'env-field' | 'config' | 'config-available' | null
  /** Why the file may not be edited, or what just happened, where the hint would be (Story 68.2 AC1, AC4). */
  note?: string | null
}

const hint = (label: string, ...keys: string[]): QuickLookHint => ({ keys, label })

/** The keys of the state the sheet is in, left to right; "Hold F8 Show terminals" stands apart at the right. */
export function quickLookFooter(state: QuickLookFooterState): QuickLookHint[] {
  const escape = hint(ESCAPE_LABELS[state.escape], 'Esc')
  const trail = [...(state.back ? [hint('Back', 'Alt ←')] : []), ...(state.forward ? [hint('Forward', 'Alt →')] : [])]
  const tree = state.folded ? hint('Show tree', 'Ctrl B') : hint('Tree', 'Tab')
  switch (state.focus) {
    case 'tree':
      return [
        hint('Move', '↑ ↓'),
        hint('Fold', '← →'),
        hint('Open', 'Enter'),
        hint('Jump to name', 'A–Z'),
        ...(state.fileOpen ? [hint('File', 'Tab')] : []),
        hint('Hide tree', 'Ctrl B'),
        ...trail,
        escape
      ]
    case 'file':
      // The board's .env frame: key, edit, paste, reveal, save, Esc.
      if (state.edit === 'env-rows') return [hint('Key', '↑ ↓'), hint('Edit', 'Enter'), hint('Paste', 'Ctrl V'), hint('Reveal 10 s', 'Ctrl R'), hint('Save', 'Ctrl S'), tree, escape]
      if (state.edit === 'env-field') return [hint('Paste', 'Ctrl V'), hint('Reveal 10 s', 'Ctrl R'), hint('Done', 'Enter'), hint('Save', 'Ctrl S'), escape]
      // The board's config frame: undo, paste, reveal, save, Esc; a note takes the place of the first hint.
      if (state.edit === 'config') return [...(state.note ? [hint(state.note)] : []), hint('Undo', 'Ctrl Z'), hint('Paste', 'Ctrl V'), hint('Reveal 10 s', 'Ctrl R'), hint('Save', 'Ctrl S'), escape]
      // The board's order for a source file: move, tree, go to line, find, back, Esc; a Markdown page scrolls and
      // M switches it to source and back.
      return [hint(state.markdown === 'rendered' ? 'Scroll' : 'Move', '↑ ↓'), ...(state.edit === 'config-available' ? [hint('Edit', 'E')] : state.note ? [hint(state.note)] : []),
        ...(state.markdown ? [hint('Rendered / source', 'M')] : []), tree,
        hint('Go to line', 'Ctrl G'), hint('Find in file', 'Ctrl F'), ...(state.secrets ? [hint('Reveal 10 s', 'Ctrl R')] : []), ...trail, escape]
    case 'find':
      return [hint('Next', 'Enter'), hint('Previous', 'Shift Enter'), hint('Case', 'Alt C'), escape]
    case 'goto':
      return [hint('Go', 'Enter'), escape]
    case 'field':
      // The board's search frame: match, open at line, case, whole word, Esc.
      if (state.search === 'contents') return [hint('Match', '↑ ↓'), hint('Open at line', 'Enter'), hint('Case', 'Alt C'), hint('Whole word', 'Alt W'), escape]
      if (state.search === 'files') return [hint('Move', '↑ ↓'), hint('Open', 'Enter'), escape]
      if (state.search === 'recent') return [hint('Move', '↑ ↓'), hint('Open at line', 'Enter'), hint('Search contents', 'Ctrl Shift G'), escape]
      return [hint('Search contents', 'Ctrl Shift G'), ...trail, tree, escape]
  }
}
