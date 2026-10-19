// MODULE: turn-changes-diff.ts - the lines of two texts compared (Myers, linear space), with a time limit and a cancel
//
// Pure code: no file, no process. A text is split at "\n"; a last line without a line ending is a line
// of its own kind, so "a" and "a\n" differ, and the missing ending is reported as a mark, never counted
// as a line. `stop` is asked in every step that can be long (splitting, numbering, comparing, laying out),
// so a text of millions of lines is stopped as quickly as a small one.

/** Thrown when the caller's `stop()` says the time is up or the work was cancelled. */
export class DiffStopped extends Error {
  constructor() {
    super('the difference was stopped')
    this.name = 'DiffStopped'
  }
}

export interface SplitText {
  /** Each line without its ending. */
  lines: string[]
  /** The last line has no ending. */
  open: boolean
}

interface LineDifference {
  a: SplitText
  b: SplitText
  /** 1 where a line of the earlier text is not in the later one. */
  removed: Uint8Array
  /** 1 where a line of the later text is not in the earlier one. */
  added: Uint8Array
  removedCount: number
  addedCount: number
}

/** A line of a hunk, numbered from 1 on each side it is on, or the mark after a last line with no ending. */
export type HunkLine =
  | { kind: ' ' | '-' | '+'; a: number | null; b: number | null; text: string }
  | { kind: '\\' }

export interface Hunk {
  aStart: number
  aLines: number
  bStart: number
  bLines: number
  lines: HunkLine[]
}

export interface UnifiedDifference {
  added: number
  removed: number
  hunks: Hunk[]
  /** Lines of hunks that were counted and not held, because the caller keeps only so many. Absent when all are held. */
  dropped?: number
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Valid UTF-8 without a NUL byte is text; everything else is binary. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

const never = (): boolean => false
/** How many lines pass between two questions to `stop`. */
const ASK_EVERY = 8_191

/** The lines of a text. An empty text has no line. */
export function splitLines(text: string, stop: () => boolean = never): SplitText {
  const lines: string[] = []
  let start = 0
  for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
    lines.push(text.slice(start, end))
    start = end + 1
    if ((lines.length & ASK_EVERY) === 0 && stop()) throw new DiffStopped()
  }
  const open = start < text.length
  if (open) lines.push(text.slice(start))
  return { lines, open }
}

/** How many lines a text has, counted without holding them. */
export function countLines(text: string, stop: () => boolean = never): number {
  let count = 0
  let start = 0
  for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
    count += 1
    start = end + 1
    if ((count & ASK_EVERY) === 0 && stop()) throw new DiffStopped()
  }
  return start < text.length ? count + 1 : count
}

/** Line identities as numbers, shared by both sides; the open last line gets an identity of its own. */
function intern(a: SplitText, b: SplitText, stop: () => boolean): [Int32Array, Int32Array] {
  const ids = new Map<string, number>()
  const idOf = (key: string): number => {
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    return id
  }
  const side = (split: SplitText): Int32Array => {
    const out = new Int32Array(split.lines.length)
    for (let index = 0; index < split.lines.length; index += 1) {
      if ((index & ASK_EVERY) === ASK_EVERY && stop()) throw new DiffStopped()
      const line = split.lines[index] as string
      // "\n" cannot occur inside a line, so it marks the open last line without colliding with a real one.
      out[index] = idOf(index === split.lines.length - 1 && split.open ? `${line}\n` : line)
    }
    return out
  }
  return [side(a), side(b)]
}

/**
 * Myers' linear-space comparison. Marks in `removed` (indexes of a) and `added` (indexes of b) every
 * line that is not part of one longest common subsequence. `stop` is asked about every 2,048 steps.
 */
function compareIds(a: Int32Array, b: Int32Array, removed: Uint8Array, added: Uint8Array, stop: () => boolean): void {
  // Sized by the first piece that needs them, which is the largest: every later piece lies inside it. Two
  // texts that differ in a few lines only need a few entries, whatever their length.
  let offset = 0
  // Furthest x reached on each diagonal: `forward` from the near corner, `backward` from the far one
  // in coordinates counted back from it. Only entries written in the current call are ever read.
  let forward = new Int32Array(0)
  let backward = new Int32Array(0)
  let steps = 0
  const at = (cells: Int32Array, index: number): number => cells[index] as number

  /** The middle snake of a[aLow..aHigh) and b[bLow..bHigh), as two points in whole-text coordinates. */
  const middle = (aLow: number, aHigh: number, bLow: number, bHigh: number): [number, number, number, number] => {
    const n = aHigh - aLow
    const m = bHigh - bLow
    const delta = n - m
    const odd = (delta & 1) !== 0
    if (forward.length === 0) {
      offset = n + m + 3
      forward = new Int32Array(2 * offset + 2)
      backward = new Int32Array(2 * offset + 2)
    }
    forward[offset + 1] = 0
    backward[offset + 1] = 0
    const half = Math.ceil((n + m) / 2)
    for (let d = 0; d <= half; d += 1) {
      for (let k = -d; k <= d; k += 2) {
        steps += 1
        if ((steps & 2047) === 0 && stop()) throw new DiffStopped()
        let x = k === -d || (k !== d && at(forward, offset + k - 1) < at(forward, offset + k + 1))
          ? at(forward, offset + k + 1)
          : at(forward, offset + k - 1) + 1
        let y = x - k
        const startX = x
        const startY = y
        while (x < n && y < m && a[aLow + x] === b[bLow + y]) {
          x += 1
          y += 1
        }
        forward[offset + k] = x
        const other = delta - k
        if (odd && other >= -(d - 1) && other <= d - 1 && x + at(backward, offset + other) >= n) {
          return [aLow + startX, bLow + startY, aLow + x, bLow + y]
        }
      }
      for (let k = -d; k <= d; k += 2) {
        steps += 1
        if ((steps & 2047) === 0 && stop()) throw new DiffStopped()
        let x = k === -d || (k !== d && at(backward, offset + k - 1) < at(backward, offset + k + 1))
          ? at(backward, offset + k + 1)
          : at(backward, offset + k - 1) + 1
        let y = x - k
        const startX = x
        const startY = y
        while (x < n && y < m && a[aHigh - 1 - x] === b[bHigh - 1 - y]) {
          x += 1
          y += 1
        }
        backward[offset + k] = x
        const other = delta - k
        if (!odd && other >= -d && other <= d && x + at(forward, offset + other) >= n) {
          return [aHigh - x, bHigh - y, aHigh - startX, bHigh - startY]
        }
      }
    }
    throw new Error('no middle snake: the comparison is broken')
  }

  // An explicit stack: a text of very many lines must not run out of call depth.
  const work: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    // Also before the first piece: a text that is all new or all gone has no step in which to ask.
    if (stop()) throw new DiffStopped()
    let [aLow, aHigh, bLow, bHigh] = next
    while (aLow < aHigh && bLow < bHigh && a[aLow] === b[bLow]) {
      aLow += 1
      bLow += 1
    }
    while (aLow < aHigh && bLow < bHigh && a[aHigh - 1] === b[bHigh - 1]) {
      aHigh -= 1
      bHigh -= 1
    }
    if (aLow === aHigh) {
      added.fill(1, bLow, bHigh)
      continue
    }
    if (bLow === bHigh) {
      removed.fill(1, aLow, aHigh)
      continue
    }
    const [x, y, u, v] = middle(aLow, aHigh, bLow, bHigh)
    work.push([aLow, x, bLow, y], [u, aHigh, v, bHigh])
  }
}

/** Which lines of two texts differ. */
export function diffLines(before: string, after: string, stop: () => boolean = () => false): LineDifference {
  const a = splitLines(before, stop)
  const b = splitLines(after, stop)
  const [idsA, idsB] = intern(a, b, stop)
  const removed = new Uint8Array(idsA.length)
  const added = new Uint8Array(idsB.length)
  compareIds(idsA, idsB, removed, added, stop)
  let removedCount = 0
  let addedCount = 0
  for (let index = 0; index < removed.length; index += 1) removedCount += removed[index] as number
  for (let index = 0; index < added.length; index += 1) addedCount += added[index] as number
  return { a, b, removed, added, removedCount, addedCount }
}

interface OpenHunk {
  /** Where its first row stands: lines of each text before it. */
  i: number
  j: number
  aLines: number
  bLines: number
  lines: HunkLine[]
}

/**
 * A unified difference with `context` lines around each change. `added` and `removed` count whole
 * lines of the two texts; the mark for a missing last line ending counts as none. It is laid out from
 * counters: nothing is held for a line outside a hunk, and of the hunks' lines at most `keep` are held,
 * the rest counted in `dropped`, so a text of millions of lines, changed or not, costs what is shown.
 */
export function unified(
  before: string,
  after: string,
  { context = 3, stop = never, keep = Number.POSITIVE_INFINITY }: { context?: number; stop?: () => boolean; keep?: number } = {}
): UnifiedDifference {
  const result = diffLines(before, after, stop)
  const { a, b, removed, added } = result
  const n = a.lines.length
  const m = b.lines.length
  const hunks: Hunk[] = []
  let kept = 0
  let dropped = 0
  let open: OpenHunk | null = null
  const put = (hunk: OpenHunk, kind: ' ' | '-' | '+', ai: number, bj: number): void => {
    if (kind !== '+') hunk.aLines += 1
    if (kind !== '-') hunk.bLines += 1
    if (kept >= keep) {
      dropped += 1
      return
    }
    kept += 1
    const fromA = kind !== '+'
    hunk.lines.push({ kind, a: fromA ? ai + 1 : null, b: kind !== '-' ? bj + 1 : null, text: (fromA ? a.lines[ai] : b.lines[bj]) as string })
    if (fromA ? a.open && ai === n - 1 : b.open && bj === m - 1) hunk.lines.push({ kind: '\\' })
  }
  const close = (hunk: OpenHunk): void => {
    // As `diff -u` counts: a side with no line in the hunk is named by the line before it.
    if (hunk.lines.length > 0) {
      hunks.push({ aStart: hunk.i + (hunk.aLines > 0 ? 1 : 0), aLines: hunk.aLines, bStart: hunk.j + (hunk.bLines > 0 ? 1 : 0), bLines: hunk.bLines, lines: hunk.lines })
    }
  }
  let i = 0
  let j = 0
  // Unchanged lines since the last change: they are lines i - run .. i - 1 of the earlier text and j - run .. j - 1 of the later.
  let run = 0
  let steps = 0
  while (i < n || j < m) {
    steps += 1
    if ((steps & ASK_EVERY) === 0 && stop()) throw new DiffStopped()
    const gone = i < n && removed[i] === 1
    const came = !gone && j < m && added[j] === 1
    if (!gone && !came) {
      i += 1
      j += 1
      run += 1
      if (open !== null && run > context * 2) {
        // More unchanged lines than two contexts hold: the hunk ends, and the next change starts one of its own.
        for (let k = 0; k < context; k += 1) put(open, ' ', i - run + k, j - run + k)
        close(open)
        open = null
      }
      continue
    }
    if (open === null) {
      const lead = Math.min(context, run)
      open = { i: i - lead, j: j - lead, aLines: 0, bLines: 0, lines: [] }
      for (let k = lead; k > 0; k -= 1) put(open, ' ', i - k, j - k)
    } else {
      for (let k = run; k > 0; k -= 1) put(open, ' ', i - k, j - k)
    }
    run = 0
    put(open, gone ? '-' : '+', i, j)
    if (gone) i += 1
    else j += 1
  }
  if (open !== null) {
    const tail = Math.min(context, run)
    for (let k = 0; k < tail; k += 1) put(open, ' ', i - run + k, j - run + k)
    close(open)
  }
  return { added: result.addedCount, removed: result.removedCount, hunks, ...(dropped > 0 ? { dropped } : {}) }
}
