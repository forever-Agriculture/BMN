// MODULE: quick-look-secrets.ts - what Quick look hides in a file and how a hidden value behaves: copied as "[secret hidden]", never found, shown one at a time for ten seconds (Story 67.3)
import { SECRET_MASK, secretFileKind, secretRanges, type SecretFileKind, type SecretRange } from '@bmn/protocol'
import type { FindMatch } from './quick-look-find'

/** How long a value stays shown after Ctrl+R or the eye. */
export const REVEAL_SECONDS = 10

/**
 * The text as the file view holds it: every line ending one `\n`, as CodeMirror splits lines, so that a range
 * found in it is the same stretch in the view, in find and in a copy.
 */
export function viewText(content: string): string {
  return content.includes('\r') ? content.replace(/\r\n?/gu, '\n') : content
}

const KIND_RANK: Record<SecretFileKind, number> = { text: 0, lock: 1, config: 2, env: 3 }

/**
 * The stretches to hide in a shown file. A file reached through a link goes by whichever of its two names hides
 * more, so a link named `.env` and a `.env` behind a plain name are both masked as `.env` files.
 */
export function quickLookSecretRanges(path: string, canonicalPath: string, text: string): SecretRange[] {
  const name = KIND_RANK[secretFileKind(canonicalPath)] > KIND_RANK[secretFileKind(path)] ? canonicalPath : path
  return secretRanges(name, text)
}

/** The text of `[from, to)` with each hidden stretch in it, except the shown one, read as "[secret hidden]". */
export function maskedSlice(text: string, ranges: readonly SecretRange[], from: number, to: number, revealed: number | null = null): string {
  let out = ''
  let at = from
  ranges.forEach(([start, end], index) => {
    if (index === revealed || end <= from || start >= to) return
    out += `${text.slice(at, Math.max(at, start))}${SECRET_MASK}`
    at = Math.max(at, Math.min(end, to))
  })
  return `${out}${text.slice(at, to)}`
}

/** Find's matches with every one that touches a hidden stretch taken out, so a hidden value is neither found nor counted. */
export function outsideSecrets(matches: readonly FindMatch[], ranges: readonly SecretRange[], revealed: number | null = null): FindMatch[] {
  if (ranges.length === 0) return [...matches]
  const kept: FindMatch[] = []
  let index = 0
  for (const match of matches) {
    while (index < ranges.length && ranges[index]![1] <= match.from) index += 1
    let hidden = false
    for (let each = index; each < ranges.length && ranges[each]![0] < match.to; each += 1) {
      if (each !== revealed) {
        hidden = true
        break
      }
    }
    if (!hidden) kept.push(match)
  }
  return kept
}

/** The hidden stretch on a line (the first one that touches it), or null. */
export function secretOnLine(ranges: readonly SecretRange[], lineFrom: number, lineTo: number): number | null {
  const index = ranges.findIndex(([start, end]) => start <= lineTo && end >= lineFrom && end > start)
  return index === -1 ? null : index
}

export interface Reveal {
  index: number
  /** When it hides again, in milliseconds since the epoch. */
  until: number
}

/** Shows one value for ten seconds; any value shown before hides. */
export function reveal(index: number, now: number): Reveal {
  return { index, until: now + REVEAL_SECONDS * 1000 }
}

/** Whole seconds left, counting down from ten; zero once it has hidden. A clock read before the reveal still says ten. */
export function revealSecondsLeft(shown: Reveal | null, now: number): number {
  return shown ? Math.min(REVEAL_SECONDS, Math.max(0, Math.ceil((shown.until - now) / 1000))) : 0
}
