// MODULE: turn-changes-diff.ts - the lines of two texts compared (Myers, linear space), with a time limit and a cancel
//
// Pure code: no file, no process. A text is split at "\n"; a last line without a line ending is a line
// of its own kind, so "a" and "a\n" differ, and the missing ending is reported as a mark, never counted
// as a line.

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

export interface LineDifference {
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

/** The lines of a text. An empty text has no line. */
export function splitLines(text: string): SplitText {
  if (text === '') return { lines: [], open: false }
  const lines = text.split('\n')
  const open = lines[lines.length - 1] !== ''
  if (!open) lines.pop()
  return { lines, open }
}

/** Line identities as numbers, shared by both sides; the open last line gets an identity of its own. */
function intern(a: SplitText, b: SplitText): [Int32Array, Int32Array] {
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
    split.lines.forEach((line, index) => {
      // "\n" cannot occur inside a line, so it marks the open last line without colliding with a real one.
      out[index] = idOf(index === split.lines.length - 1 && split.open ? `${line}\n` : line)
    })
    return out
  }
  return [side(a), side(b)]
}

/**
 * Myers' linear-space comparison. Marks in `removed` (indexes of a) and `added` (indexes of b) every
 * line that is not part of one longest common subsequence. `stop` is asked about every 2,048 steps.
 */
function compareIds(a: Int32Array, b: Int32Array, removed: Uint8Array, added: Uint8Array, stop: () => boolean): void {
  const offset = a.length + b.length + 3
  // Furthest x reached on each diagonal: `forward` from the near corner, `backward` from the far one
  // in coordinates counted back from it. Only entries written in the current call are ever read.
  const forward = new Int32Array(2 * offset + 2)
  const backward = new Int32Array(2 * offset + 2)
  let steps = 0
  const at = (cells: Int32Array, index: number): number => cells[index] as number

  /** The middle snake of a[aLow..aHigh) and b[bLow..bHigh), as two points in whole-text coordinates. */
  const middle = (aLow: number, aHigh: number, bLow: number, bHigh: number): [number, number, number, number] => {
    const n = aHigh - aLow
    const m = bHigh - bLow
    const delta = n - m
    const odd = (delta & 1) !== 0
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
  const a = splitLines(before)
  const b = splitLines(after)
  const [idsA, idsB] = intern(a, b)
  const removed = new Uint8Array(idsA.length)
  const added = new Uint8Array(idsB.length)
  compareIds(idsA, idsB, removed, added, stop)
  let removedCount = 0
  let addedCount = 0
  for (const flag of removed) removedCount += flag
  for (const flag of added) addedCount += flag
  return { a, b, removed, added, removedCount, addedCount }
}

interface Row {
  kind: ' ' | '-' | '+'
  a: number | null
  b: number | null
  text: string
  open: boolean
  i: number
  j: number
}

/**
 * A unified difference with `context` lines around each change. `added` and `removed` count whole
 * lines of the two texts; the mark for a missing last line ending counts as none.
 */
export function unified(
  before: string,
  after: string,
  { context = 3, stop = () => false }: { context?: number; stop?: () => boolean } = {}
): UnifiedDifference {
  const result = diffLines(before, after, stop)
  const { a, b, removed, added } = result
  const rows: Row[] = []
  let i = 0
  let j = 0
  while (i < a.lines.length || j < b.lines.length) {
    if (i < a.lines.length && removed[i] === 1) {
      rows.push({ kind: '-', a: i + 1, b: null, text: a.lines[i] as string, open: a.open && i === a.lines.length - 1, i, j })
      i += 1
    } else if (j < b.lines.length && added[j] === 1) {
      rows.push({ kind: '+', a: null, b: j + 1, text: b.lines[j] as string, open: b.open && j === b.lines.length - 1, i, j })
      j += 1
    } else {
      rows.push({ kind: ' ', a: i + 1, b: j + 1, text: a.lines[i] as string, open: a.open && i === a.lines.length - 1, i, j })
      i += 1
      j += 1
    }
  }
  const hunks: Hunk[] = []
  let index = 0
  while (index < rows.length) {
    if ((rows[index] as Row).kind === ' ') {
      index += 1
      continue
    }
    const start = Math.max(0, index - context)
    let end = index + 1
    for (let scan = index + 1; scan < rows.length; scan += 1) {
      if ((rows[scan] as Row).kind !== ' ') {
        end = scan + 1
        continue
      }
      // More unchanged lines than two contexts hold: the next change starts a hunk of its own.
      if (scan - end + 1 > context * 2) break
    }
    const stopAt = Math.min(rows.length, end + context)
    const slice = rows.slice(start, stopAt)
    const first = slice[0] as Row
    const lines: HunkLine[] = []
    let aLines = 0
    let bLines = 0
    for (const row of slice) {
      if (row.kind !== '+') aLines += 1
      if (row.kind !== '-') bLines += 1
      lines.push({ kind: row.kind, a: row.a, b: row.b, text: row.text })
      if (row.open) lines.push({ kind: '\\' })
    }
    // As `diff -u` counts: a side with no line in the hunk is named by the line before it.
    hunks.push({ aStart: first.i + (aLines > 0 ? 1 : 0), aLines, bStart: first.j + (bLines > 0 ? 1 : 0), bLines, lines })
    index = stopAt
  }
  return { added: result.addedCount, removed: result.removedCount, hunks }
}
