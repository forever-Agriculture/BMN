// MODULE: quick-look-search.ts - the words and order of Quick look's top-field results: what a search covered, its matches in one list, and a matching line cut to fit (Story 67.5)
import {
  QUICK_LOOK_SEARCH_MAX_FILES,
  QUICK_LOOK_SEARCH_MAX_LINES,
  QUICK_LOOK_SEARCH_MIN_CHARS,
  SECRET_MASK,
  quickLookCount,
  type QuickLookContentsLine,
  type QuickLookContentsResult,
  type QuickLookSearchResult
} from '@bmn/protocol'

/** The wait after the last key before a search starts: the palette's for names, 150 ms for contents (AC2). */
export const FILES_SEARCH_WAIT_MS = 120
export const CONTENTS_SEARCH_WAIT_MS = 150

export type QuickLookSearchMode = 'files' | 'contents'

/** True when the top field's text is something to search for in this mode. */
export function searchable(mode: QuickLookSearchMode, query: string): boolean {
  return mode === 'files' ? query.trim().length > 0 : [...query].length >= QUICK_LOOK_SEARCH_MIN_CHARS
}

interface ContentsHeader {
  /** "8 matches in 3 files", or "No matches". */
  count: string
  /** "619 files read · 0.2 s". */
  read: string
  /** Quiet lines under the count, each true of this search; never "all" or "complete". */
  notes: string[]
}

const pluralWithCommas = (count: number, one: string, many: string): string => `${quickLookCount(count)} ${count === 1 ? one : many}`

/** What a contents search covered and what cut it short (AC4). */
export function contentsHeader(result: QuickLookContentsResult): ContentsHeader {
  const notes: string[] = []
  if (result.cancelled) notes.push('Partial results · search stopped')
  else if (result.limit === 'files') notes.push(`Partial results · limit reached: ${quickLookCount(QUICK_LOOK_SEARCH_MAX_FILES)} files searched`)
  else if (result.limit === 'lines') notes.push(`Partial results · limit reached: ${quickLookCount(QUICK_LOOK_SEARCH_MAX_LINES)} matching lines`)
  if (result.unreadable > 0) notes.push(`${pluralWithCommas(result.unreadable, 'file', 'files')} could not be read`)
  if (result.scope === 'git') notes.push('Files Git ignores were skipped.')
  return {
    count: result.matchCount === 0 ? 'No matches' : `${pluralWithCommas(result.matchCount, 'match', 'matches')} in ${pluralWithCommas(result.files.length, 'file', 'files')}`,
    read: `${pluralWithCommas(result.filesRead, 'file', 'files')} read · ${(result.elapsedMs / 1000).toFixed(1)} s`,
    notes
  }
}

/** The name search's line, as the palette words it. */
export function filesHeader(result: Extract<QuickLookSearchResult, { mode: 'files' }>): string {
  if (result.unavailable) return 'This folder is unavailable'
  if (result.files.length === 0) return result.capped ? `No matches; search capped after ${quickLookCount(result.scanned)} entries.` : 'No matches'
  return result.capped
    ? `Showing first ${result.files.length} matches; search capped after ${result.scanned} entries.`
    : pluralWithCommas(result.files.length, 'file', 'files')
}

interface SearchMatch {
  path: string
  line: number
  column: number
  length: number
}

/** Every match in the order the results show them: by file, then by line. */
export function flatMatches(result: QuickLookContentsResult | null): SearchMatch[] {
  if (!result) return []
  return result.files.flatMap((file) => file.lines.map((line) => ({ path: file.path, line: line.line, column: line.column, length: line.length })))
}

/** "Match 2 of 8". */
export function matchLabel(index: number, total: number): string {
  return `Match ${quickLookCount(index + 1)} of ${quickLookCount(total)}`
}

/** The next or previous match, wrapping at either end; -1 with none. */
export function stepSearchMatch(index: number, total: number, direction: 1 | -1): number {
  if (total === 0) return -1
  if (index < 0) return direction === 1 ? 0 : total - 1
  return (index + direction + total) % total
}

/**
 * A matching line as its row shows it: a few characters before the match, so the match is in view in a narrow
 * column, with "…" where the line was cut.
 */
export function rowPieces(line: QuickLookContentsLine, lead = 16): { before: string; match: string; after: string } {
  let from = line.matchStart > lead ? line.matchStart - lead : 0
  // A cut never falls inside "[secret hidden]": the whole mask is kept, so it never reads as part of the line.
  for (let at = line.text.indexOf(SECRET_MASK); at !== -1 && at < line.matchStart; at = line.text.indexOf(SECRET_MASK, at + 1)) {
    if (from > at && from < at + SECRET_MASK.length) from = at
  }
  const cutBefore = line.cutBefore || from > 0
  return {
    before: `${cutBefore ? '…' : ''}${line.text.slice(from, line.matchStart).trimStart()}`,
    match: line.text.slice(line.matchStart, line.matchEnd),
    after: `${line.text.slice(line.matchEnd)}${line.cutAfter ? '…' : ''}`
  }
}

/** A result's folder under the root, shortened from the left; the root itself reads as nothing. */
export function resultFolder(path: string, root: string | null): string {
  const slash = path.lastIndexOf('/')
  const folder = slash > 0 ? path.slice(0, slash) : '/'
  if (root && folder === root) return ''
  if (root && folder.startsWith(`${root}/`)) return folder.slice(root.length + 1)
  return folder
}

/** Where a match is in the file view's text: the line's start plus the column, for `length` characters. */
export function matchInText(text: string, match: Pick<SearchMatch, 'line' | 'column' | 'length'>): { from: number; to: number } | null {
  let at = 0
  for (let line = 1; line < match.line; line += 1) {
    const next = text.indexOf('\n', at)
    if (next === -1) return null
    at = next + 1
  }
  const end = text.indexOf('\n', at)
  const lineEnd = end === -1 ? text.length : end
  const from = at + match.column - 1
  const to = from + match.length
  return to <= lineEnd ? { from, to } : null
}
