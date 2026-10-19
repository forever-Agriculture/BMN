// MODULE: quick-look-place.ts - where he was in Quick look: go to line, the trail back and forward, the place kept per root and Esc's order (Story 67.2)

/** `44` or `44:7`, clamped to the file's last line; null for anything else. */
export function parseGoToLine(text: string, lineCount: number): { line: number; column: number | null } | null {
  const match = /^\s*(\d{1,9})(?:\s*:\s*(\d{1,9}))?\s*$/u.exec(text)
  if (!match) return null
  const line = Number(match[1])
  if (line < 1) return null
  const column = match[2] === undefined ? null : Math.max(1, Number(match[2]))
  return { line: Math.min(line, Math.max(1, lineCount)), column }
}

interface TrailEntry {
  path: string
  /** The line he came for, marked in gold whenever the file is shown again. */
  line: number | null
  column: number | null
  /** The line at the top when he left the file, where Back and Forward return. */
  topLine?: number | null
}

/** Files opened one after another; `index` is the one shown. */
export interface Trail {
  entries: readonly TrailEntry[]
  index: number
}

/** The trail keeps this many files; the oldest go first. */
export const TRAIL_MAX = 100

export const EMPTY_TRAIL: Trail = { entries: [], index: -1 }

/** The shown file's entry, kept at the line now at its top so that Back returns there. */
function withCurrentTop(trail: Trail, topLine: number | null): TrailEntry[] {
  const entries = [...trail.entries]
  const current = entries[trail.index]
  if (current && topLine !== null) entries[trail.index] = { ...current, topLine }
  return entries
}

/**
 * A file opened from the tree, a search result, a link or a printed path: anything forward of the shown file is
 * dropped and the new one is added. Opening the shown file at its own line again adds nothing.
 */
export function trailVisit(trail: Trail, entry: TrailEntry, currentTop: number | null): Trail {
  const current = trail.entries[trail.index]
  if (current && current.path === entry.path && (entry.line === null || entry.line === current.line)) return trail
  const entries = [...withCurrentTop(trail, currentTop).slice(0, trail.index + 1), entry]
  const kept = entries.slice(Math.max(0, entries.length - TRAIL_MAX))
  return { entries: kept, index: kept.length - 1 }
}

export const canGoBack = (trail: Trail): boolean => trail.index > 0
export const canGoForward = (trail: Trail): boolean => trail.index >= 0 && trail.index < trail.entries.length - 1

/** One step back or forward, with the entry to open; null when there is nowhere to go. */
export function trailStep(trail: Trail, direction: -1 | 1, currentTop: number | null): { trail: Trail; entry: TrailEntry } | null {
  const index = trail.index + direction
  if (trail.index < 0 || index < 0 || index >= trail.entries.length) return null
  const entries = withCurrentTop(trail, currentTop)
  return { trail: { entries, index }, entry: entries[index]! }
}

/** What a root keeps while BMN runs: the last file and its top line, the open folders and the last search. */
interface RootPlace {
  file: { path: string; topLine: number } | null
  expanded: readonly string[]
  find: { query: string; matchCase: boolean } | null
}

/**
 * Kept in this window's memory only, until BMN quits; nothing is written to disk. A root is the folder the tree
 * shows, so the session folder and its Git root each keep their own place.
 */
const places = new Map<string, RootPlace>()

export function rememberPlace(root: string, place: RootPlace): void {
  places.set(root, place)
}

export function recalledPlace(root: string): RootPlace | null {
  return places.get(root) ?? null
}

/** Test seam: forgets every root's place. */
export function forgetPlaces(): void {
  places.clear()
}

export type EscapeStep = 'keep-editing' | 'leave-field' | 'close-menu' | 'clear-typed' | 'hide-secret' | 'close-goto' | 'close-find' | 'stop-search' | 'clear-search' | 'back-to-results' | 'close-sheet'

interface EscapeState {
  focus: 'field' | 'tree' | 'file'
  typed: boolean
  /** A hidden value is shown for its ten seconds (Story 67.3). */
  revealed?: boolean
  goTo: boolean
  find: boolean
  /** The top field holds a search: one still running, or its results (Story 67.5). */
  search?: 'searching' | 'results' | null
  /** The open file was opened from those results. */
  fromResults?: boolean
  /** The path row's "…" menu is open (Story 67.6). */
  menu?: boolean
  /** A question about unsaved edits, a blocked save or an invalid file is on screen; Esc means Keep editing (Story 68.1 AC8). */
  question?: boolean
  /** A value or name field of the edited file has the focus; Esc leaves it and keeps the draft (Story 68.1 AC2). */
  editField?: boolean
}

/**
 * Esc closes the innermost open thing first and the sheet last: the path row's menu, letters typed in the tree while it has the keys,
 * then a value shown for ten seconds, then the go-to-line row, then the find row, then a running search, its results
 * (back to the tree) or a file opened from them (back to the results), then any letters left typed.
 */
export function escapeStep(state: EscapeState): EscapeStep {
  if (state.question) return 'keep-editing'
  if (state.menu) return 'close-menu'
  if (state.editField) return 'leave-field'
  if (state.focus === 'tree' && state.typed) return 'clear-typed'
  if (state.revealed) return 'hide-secret'
  if (state.goTo) return 'close-goto'
  if (state.find) return 'close-find'
  if (state.focus === 'field' && state.search === 'searching') return 'stop-search'
  if (state.focus === 'field' && state.search) return 'clear-search'
  if (state.focus === 'file' && state.fromResults && state.search) return 'back-to-results'
  if (state.typed) return 'clear-typed'
  return 'close-sheet'
}

export const ESCAPE_LABELS: Record<EscapeStep, string> = {
  'keep-editing': 'Keep editing',
  'leave-field': 'Leave the field',
  'close-menu': 'Close menu',
  'clear-typed': 'Clear typed',
  'hide-secret': 'Hide value',
  'close-goto': 'Close go to line',
  'close-find': 'Close find',
  'stop-search': 'Stop search',
  'clear-search': 'Back to tree',
  'back-to-results': 'Back to results',
  'close-sheet': 'Close'
}
