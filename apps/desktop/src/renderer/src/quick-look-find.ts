// MODULE: quick-look-find.ts - find in the open file: literal text, an optional case match, a count and wrap-around (Story 67.2 AC1)

export interface FindMatch {
  from: number
  to: number
}

/** More matches than this are counted as "10,000+" and not marked one by one. */
const FIND_MAX_MATCHES = 10_000

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Every place the literal query occurs in the text, left to right and never overlapping. Without the case switch
 * letters match in either case; the text is never lowered, so each match's offsets are the text's own.
 */
export function findMatches(text: string, query: string, matchCase: boolean, max = FIND_MAX_MATCHES): FindMatch[] {
  if (!query) return []
  const pattern = new RegExp(escapeRegExp(query), matchCase ? 'gu' : 'giu')
  const matches: FindMatch[] = []
  for (const found of text.matchAll(pattern)) {
    if (found[0].length === 0) break
    matches.push({ from: found.index, to: found.index + found[0].length })
    if (matches.length >= max) break
  }
  return matches
}

/** The first match at or after a position, wrapping to the first; -1 when there are none. */
export function matchAt(matches: readonly FindMatch[], position: number): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.from >= position)
  return index === -1 ? 0 : index
}

/** The next or the previous match, wrapping around both ends. */
export function stepMatch(matches: readonly FindMatch[], current: number, direction: 1 | -1): number {
  if (matches.length === 0) return -1
  if (current < 0) return direction === 1 ? 0 : matches.length - 1
  return (current + direction + matches.length) % matches.length
}

/** "3 of 12", "No matches", or nothing before anything is typed. */
export function findCountLabel(matches: readonly FindMatch[], current: number, query: string, max = FIND_MAX_MATCHES): string {
  if (!query) return ''
  if (matches.length === 0) return 'No matches'
  const total = matches.length >= max ? `${max.toLocaleString('en-US')}+` : matches.length.toLocaleString('en-US')
  return `${(current + 1).toLocaleString('en-US')} of ${total}`
}
