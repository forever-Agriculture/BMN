// MODULE: turn-changes-shown.ts - what the window may read of one file's difference: masks laid over the original lines, the display bounds, and the hunk whose only difference is a secret value (Story 69.5)
//
// Pure code: no file, no process. The lines, their numbers and the counts are the original texts'. Secret
// ranges are found over both whole texts by the rule that goes by the file's name (R67-NFR7) and laid over
// those lines, so a value is the same plate in an added, a removed and a context line, and a key block of
// many lines stays that many lines. Nothing here can be asked to show a value. The search for values is
// stopped by the same `stop` as the comparison and looks at each line only as far as it can be shown.
import type { TurnShownDifference, TurnShownHunk, TurnShownLine } from '@bmn/protocol'
import { secretRanges, type SecretRange } from './secret-ranges'
import { DiffStopped, type UnifiedDifference } from './turn-changes-diff'

export interface ShownLimits {
  lines: number
  bytes: number
  lineCharacters: number
}

// The worker thread's files take types only from the protocol package: a test starts the worker with plain
// Node, which cannot load that package. A test holds these two equal to `TURN_SHOWN_LIMITS` and
// `TURN_SECRET_PLATE`, which the window reads.
export const SHOWN_LIMITS: Readonly<ShownLimits> = Object.freeze({ lines: 5_000, bytes: 256 * 1024, lineCharacters: 2_000 })
export const SECRET_PLATE = '••••••••••'

/** Where each line of a text begins; the line numbered n begins at index n - 1. */
function lineStarts(text: string, check: () => void): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1)
    if ((starts.length & 8_191) === 0) check()
  }
  return starts
}

/** The secret ranges of one text, asked line by line in rising order. */
class Laid {
  private at = 0
  private readonly ranges: readonly SecretRange[]
  private readonly starts: readonly number[]

  constructor(path: string, text: string, shown: number, check: () => void) {
    this.ranges = secretRanges(path, text, { shown, check })
    this.starts = lineStarts(text, check)
  }

  /** The parts of the line numbered `line` that a range covers, in the line's own offsets. */
  over(line: number, length: number): SecretRange[] {
    const start = this.starts[line - 1] ?? 0
    const end = start + length
    while (this.at < this.ranges.length && (this.ranges[this.at] as SecretRange)[1] <= start) this.at += 1
    const covered: SecretRange[] = []
    for (let index = this.at; index < this.ranges.length; index += 1) {
      const [from, to] = this.ranges[index] as SecretRange
      if (from >= end) break
      if (to > start) covered.push([Math.max(from, start) - start, Math.min(to, end) - start])
    }
    return covered
  }
}

/** Two lists of covered parts as one: a context line is hidden where either text hides it. */
function either(one: SecretRange[], other: SecretRange[]): SecretRange[] {
  if (other.length === 0) return one
  const all = [...one, ...other].sort((a, b) => a[0] - b[0])
  const joined: SecretRange[] = []
  for (const [from, to] of all) {
    const last = joined.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else joined.push([from, to])
  }
  return joined
}

/** The line as it may be read: cut at the limit, every covered part replaced by the one plate. */
function readable(text: string, covered: SecretRange[], limit: number): Pick<TurnShownLine, 'text' | 'masks' | 'cut'> {
  const cut = text.length > limit
  // Never half of a character that takes two code units.
  const end = cut ? limit - (/[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? 1 : 0) : text.length
  const masks: Array<[number, number]> = []
  let shown = ''
  let at = 0
  for (const [from, to] of covered) {
    if (from >= end) break
    if (to <= from) continue
    shown += text.slice(at, from)
    masks.push([shown.length, shown.length + SECRET_PLATE.length])
    shown += SECRET_PLATE
    at = Math.min(to, end)
  }
  return { text: shown + text.slice(at, end), masks, cut }
}

/**
 * A file's difference as the window shows it. At most `limits.lines` lines or `limits.bytes` bytes are given;
 * `more` counts the rest. A hunk is marked `secret` when its removed and added lines read the same once the
 * values are masked: then the only thing that changed is a value nobody is shown.
 */
export function showDifference(
  path: string,
  before: string,
  after: string,
  difference: UnifiedDifference,
  options: { limits?: ShownLimits; stop?: () => boolean } = {}
): Extract<TurnShownDifference, { state: 'text' }> {
  const limits = options.limits ?? SHOWN_LIMITS
  const stop = options.stop ?? (() => false)
  const check = (): void => {
    if (stop()) throw new DiffStopped()
  }
  check()
  const a = new Laid(path, before, limits.lineCharacters, check)
  const b = new Laid(path, after, limits.lineCharacters, check)
  check()
  const hunks: TurnShownHunk[] = []
  let shown = 0
  let bytes = 0
  let total = 0
  let full = false
  for (const hunk of difference.hunks) {
    if (full) {
      for (const line of hunk.lines) if (line.kind !== '\\') total += 1
      continue
    }
    if (stop()) throw new DiffStopped()
    const lines: TurnShownHunk['lines'] = []
    const removed: string[] = []
    const added: string[] = []
    let masked = false
    for (const line of hunk.lines) {
      if (line.kind === '\\') {
        if (!full) lines.push({ kind: '\\' })
        continue
      }
      total += 1
      if ((total & 255) === 0) check()
      if (full) continue
      const covered = either(line.a === null ? [] : a.over(line.a, line.text.length), line.b === null ? [] : b.over(line.b, line.text.length))
      const made = readable(line.text, covered, limits.lineCharacters)
      const size = Buffer.byteLength(made.text) + 1
      if (shown + 1 > limits.lines || bytes + size > limits.bytes) {
        full = true
        continue
      }
      shown += 1
      bytes += size
      if (made.masks.length > 0) masked = true
      if (line.kind === '-') removed.push(made.text)
      else if (line.kind === '+') added.push(made.text)
      lines.push({ kind: line.kind, a: line.a, b: line.b, ...made })
    }
    const secret = !full && masked && removed.length > 0 && removed.length === added.length && removed.every((text, index) => text === added[index])
    if (lines.length > 0) hunks.push({ aStart: hunk.aStart, aLines: hunk.aLines, bStart: hunk.bStart, bLines: hunk.bLines, secret, lines })
  }
  return { state: 'text', added: difference.added, removed: difference.removed, hunks, more: total - shown + (difference.dropped ?? 0) }
}
