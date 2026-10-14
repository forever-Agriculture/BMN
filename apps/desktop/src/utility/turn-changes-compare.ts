// MODULE: turn-changes-compare.ts - what differs between two captures of one store: one state per path, lines for text, totals, and one file's difference
//
// The reading is "what differs between two scans of this work tree" (R69-NFR7). A path that is in
// only one capture is "added" or "removed" only where the later capture showed it: the file was made
// after the earlier scan began, or nothing has that name any more. Otherwise it entered or left what
// is covered, adds no lines and makes the totals partial; so does every entry that was not read, also
// one that reads the same in both scans: BMN cannot say whether a file it did not read changed.
import type { TurnShownDifference } from '@bmn/protocol'
import { TURN_LIMITS, refusal, type TurnRefusal } from './turn-changes-capture'
import { DiffStopped, countLines, decodeText, diffLines, unified, type Hunk } from './turn-changes-diff'
import { SHOWN_LIMITS, showDifference, type ShownLimits } from './turn-changes-shown'
import type { TreeRow, TurnCaptureRecord, TurnStore } from './turn-changes-store'

export type TurnFileState =
  | 'added'
  | 'removed'
  | 'changed'
  | 'mode only'
  | 'changed kind'
  | 'binary'
  | 'not read'
  | 'entered what is covered'
  | 'left what is covered'

export type TurnEntryKind = 'file' | 'link' | 'submodule'

/** One path's row of a comparison. `added` and `removed` are lines, present only where lines were counted. */
export interface TurnFileRow {
  path: string
  state: TurnFileState
  added?: number
  removed?: number
  /** Why an entry was not read, in fixed words. */
  why?: string
  /** For "changed kind": what it was and what it became. For an added or removed submodule: "submodule". */
  from?: TurnEntryKind | string | null
  to?: TurnEntryKind | string | null
  kind?: TurnEntryKind
  /** A binary file's sizes, or the size of a binary file that was added or removed. */
  sizeBefore?: number | null
  sizeAfter?: number | null
  executable?: boolean
  /** Whether a not-read entry is in only one capture. */
  onlyAfter?: boolean
  onlyBefore?: boolean
}

export interface TurnTotals {
  files: number
  added: number
  removed: number
  /** Some files added no lines: they were not read, or entered or left what is covered. */
  partial: boolean
  notCounted: number
}

export interface TurnComparison {
  state: 'compared'
  files: TurnFileRow[]
  totals: TurnTotals
  tookMs: number
}

export type TurnDifference =
  | { state: 'text'; added: number; removed: number; hunks: Hunk[] }
  | { state: 'binary'; sizeBefore: number | null; sizeAfter: number | null }

export interface CompareOptions {
  limitMs?: number
  cancelled?: () => boolean
}

const LIMIT_REACHED = 'Difference unavailable: limit reached'
const TOO_LARGE = 'too large, not read'
const KIND = { f: 'file', l: 'link', s: 'submodule', x: 'file', u: 'file' } as const

type Leaf = Exclude<TreeRow, [string, 'd', string]>
const isFolder = (row: TreeRow | null): row is [string, 'd', string] => row !== null && row[1] === 'd'

interface Pair {
  one: TurnCaptureRecord & { tree: string }
  other: TurnCaptureRecord & { tree: string }
}

function loadPair(store: TurnStore, a: string, b: string): Pair | TurnRefusal {
  const one = store.record(a)
  const other = store.record(b)
  if (!one || !other) return refusal('unavailable', 'a capture is gone')
  for (const record of [one, other]) {
    if (record.state !== 'whole' || record.tree === null) return { ...refusal('unavailable', 'a capture is incomplete'), bound: record.bound ?? '' }
  }
  if (one.objectFormat !== other.objectFormat) return refusal('unavailable', "the repository's object format changed")
  return { one, other } as Pair
}

/**
 * What a walk over stored trees calls so that it can be stopped where nothing differs and nothing is found:
 * `folder` before and after every folder's list is read, `entry` at every entry it meets. Either stops the walk by throwing.
 */
interface Walk {
  folder: () => void
  entry: () => void
}

/** Pairs of entries that differ between two trees; a side a path is not on is null. */
function* differing(store: TurnStore, a: string | null, b: string | null, walk: Walk, prefix = ''): Generator<{ path: string; a: Leaf | null; b: Leaf | null }> {
  if (a === b) return
  walk.folder()
  const one = a ? store.tree(a) : new Map<string, TreeRow>()
  const other = b ? store.tree(b) : new Map<string, TreeRow>()
  walk.folder()
  for (const name of [...new Set([...one.keys(), ...other.keys()])].sort()) {
    walk.entry()
    const ea = one.get(name) ?? null
    const eb = other.get(name) ?? null
    const path = `${prefix}${name}`
    const folderA = isFolder(ea)
    const folderB = isFolder(eb)
    if (folderA || folderB) {
      if (ea && !folderA) yield { path, a: ea as Leaf, b: null }
      if (eb && !folderB) yield { path, a: null, b: eb as Leaf }
      yield* differing(store, folderA ? ea[2] : null, folderB ? eb[2] : null, walk, `${path}/`)
    } else if (JSON.stringify(ea) !== JSON.stringify(eb)) {
      yield { path, a: ea as Leaf | null, b: eb as Leaf | null }
    }
  }
}

/** The text of a file or a link that can be compared by lines, or null when the file is binary. */
function textOf(store: TurnStore, row: Leaf): string | null {
  if (row[1] === 'l') return row[2]
  if (row[1] === 'f') return decodeText(store.blob(row[2], row[3]))
  return null
}

/** Every entry of a stored tree that was not read, with why. */
function* unread(store: TurnStore, hash: string, walk: Walk, prefix = ''): Generator<{ path: string; why: string }> {
  walk.folder()
  const rows = store.tree(hash)
  walk.folder()
  for (const [name, row] of rows) {
    walk.entry()
    if (row[1] === 'd') yield* unread(store, row[2], walk, `${prefix}${name}/`)
    else {
      const why = whyNotRead(row as Leaf)
      if (why !== null) yield { path: `${prefix}${name}`, why }
    }
  }
}

const whyNotRead = (row: Leaf): string | null => (row[1] === 'u' ? row[2] : row[1] === 'x' ? TOO_LARGE : null)
const sizeOf = (row: Leaf | null): number | null => (row !== null && row[1] === 'f' ? row[3] : null)

/**
 * When the work of a comparison or of one file's difference ends: a little before its limit. The stop is
 * asked between stretches of work that can take tens of milliseconds, so the answer "limit reached" is
 * given inside the limit and not after it.
 */
const workEnds = (limitMs: number): number => limitMs - Math.min(100, limitMs / 20)

/**
 * What differs between two captures of one store. `cancelled` is asked while lines are compared; a
 * comparison that is stopped or runs out of time is "unavailable", never zero.
 */
export function compareCaptures(store: TurnStore, a: string, b: string, options: CompareOptions = {}): TurnComparison | TurnRefusal {
  const pair = loadPair(store, a, b)
  if ('reason' in pair) return pair
  const { one, other } = pair
  const limitMs = options.limitMs ?? TURN_LIMITS.compareMs
  const cancelled = options.cancelled ?? (() => false)
  const began = performance.now()
  const stop = (): boolean => cancelled() || performance.now() - began > workEnds(limitMs)
  // Asked at every folder that is read and at every 256th entry met, whether or not anything differs there.
  let met = 0
  const walk: Walk = {
    folder: () => {
      if (stop()) throw new DiffStopped()
    },
    entry: () => {
      met += 1
      if ((met & 255) === 0 && stop()) throw new DiffStopped()
    }
  }
  // Only a capture taken to be compared with the earlier one looked at that one's paths.
  const decided = other.base === one.id
  const gone = new Set(decided ? other.gone : [])
  const entered = new Set(decided ? other.entered : [])
  const files: TurnFileRow[] = []
  const totals: TurnTotals = { files: 0, added: 0, removed: 0, partial: false, notCounted: 0 }
  const uncounted = (row: TurnFileRow): TurnFileRow => {
    totals.partial = true
    totals.notCounted += 1
    return row
  }
  try {
    for (const { path, a: ea, b: eb } of differing(store, one.tree, other.tree, walk)) {
      // At every file: one file may be 10 MiB to read and to count.
      if (stop()) throw new DiffStopped()
      let row: TurnFileRow
      if (ea && eb) {
        const why = whyNotRead(ea) ?? whyNotRead(eb)
        if (KIND[ea[1]] !== KIND[eb[1]]) row = { path, state: 'changed kind', from: KIND[ea[1]], to: KIND[eb[1]] }
        else if (why !== null) row = uncounted({ path, state: 'not read', why })
        else if (ea[1] === 's' && eb[1] === 's') row = { path, state: 'changed', from: ea[2], to: eb[2] }
        else if (ea[1] === 'f' && eb[1] === 'f' && ea[2] === eb[2]) row = { path, state: 'mode only', executable: eb[4] === 1 }
        else {
          const before = textOf(store, ea)
          const after = textOf(store, eb)
          if (before === null || after === null) row = { path, state: 'binary', sizeBefore: sizeOf(ea), sizeAfter: sizeOf(eb) }
          else {
            const lines = diffLines(before, after, stop)
            row = { path, state: 'changed', added: lines.addedCount, removed: lines.removedCount }
          }
        }
      } else if (eb) {
        const why = whyNotRead(eb)
        if (!decided || entered.has(path)) row = uncounted({ path, state: 'entered what is covered' })
        else if (why !== null) row = uncounted({ path, state: 'not read', why, onlyAfter: true })
        else if (eb[1] === 's') row = { path, state: 'added', kind: 'submodule' }
        else {
          const text = textOf(store, eb)
          row = text === null ? { path, state: 'added', kind: KIND[eb[1]], sizeBefore: null, sizeAfter: sizeOf(eb) } : { path, state: 'added', kind: KIND[eb[1]], added: countLines(text, stop), removed: 0 }
        }
      } else if (ea) {
        const why = whyNotRead(ea)
        if (!decided || !gone.has(path)) row = uncounted({ path, state: 'left what is covered' })
        else if (why !== null) row = uncounted({ path, state: 'not read', why, onlyBefore: true })
        else if (ea[1] === 's') row = { path, state: 'removed', kind: 'submodule' }
        else {
          const text = textOf(store, ea)
          row = text === null ? { path, state: 'removed', kind: KIND[ea[1]], sizeBefore: sizeOf(ea), sizeAfter: null } : { path, state: 'removed', kind: KIND[ea[1]], added: 0, removed: countLines(text, stop) }
        }
      } else continue
      files.push(row)
      totals.files += 1
      totals.added += row.added ?? 0
      totals.removed += row.removed ?? 0
    }
    // An entry that was not read and reads the same in both scans (a file over the limit with its size and
    // time unchanged, a file BMN may not open) did not come up above. The later scan counted how many it has;
    // only then is its tree walked for them.
    if (other.counts.tooLarge + other.counts.notRead > 0) {
      const listed = new Set(files.map((row) => row.path))
      for (const { path, why } of unread(store, other.tree as string, walk)) {
        if (listed.has(path)) continue
        files.push(uncounted({ path, state: 'not read', why }))
        totals.files += 1
      }
    }
    // A comparison that was stopped, or whose time passed, in its last stretch is not given as done.
    if (stop()) throw new DiffStopped()
  } catch (error) {
    if (error instanceof DiffStopped) return cancelled() ? refusal('cancelled', 'cancelled') : refusal('unavailable', LIMIT_REACHED)
    return refusal('unavailable', 'a stored capture cannot be read')
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { state: 'compared', files, totals, tookMs: performance.now() - began }
}

/** One path's entry in a capture's tree, or null. */
function entryAt(store: TurnStore, tree: string, path: string): Leaf | null {
  let hash = tree
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    const row = store.tree(hash).get(part)
    if (!row) return null
    if (index === parts.length - 1) return isFolder(row) ? null : (row as Leaf)
    if (!isFolder(row)) return null
    hash = row[2]
  }
  return null
}

/** One path's two texts and what to make of them, inside the comparison's limit; a binary file gives its sizes. */
function differenceAt<Made>(
  store: TurnStore,
  a: string,
  b: string,
  path: string,
  options: CompareOptions,
  make: (before: string, after: string, stop: () => boolean) => Made
): Made | Extract<TurnDifference, { state: 'binary' }> | TurnRefusal {
  const pair = loadPair(store, a, b)
  if ('reason' in pair) return pair
  const limitMs = options.limitMs ?? TURN_LIMITS.compareMs
  const cancelled = options.cancelled ?? (() => false)
  const began = performance.now()
  const stop = (): boolean => cancelled() || performance.now() - began > workEnds(limitMs)
  try {
    const ea = entryAt(store, pair.one.tree, path)
    const eb = entryAt(store, pair.other.tree, path)
    const readable = (row: Leaf | null): boolean => row === null || row[1] === 'f' || row[1] === 'l'
    if (!readable(ea) || !readable(eb)) return refusal('unavailable', 'not read')
    const before = ea ? textOf(store, ea) : ''
    const after = eb ? textOf(store, eb) : ''
    if (before === null || after === null) return { state: 'binary', sizeBefore: sizeOf(ea), sizeAfter: sizeOf(eb) }
    return make(before, after, stop)
  } catch (error) {
    if (error instanceof DiffStopped) return cancelled() ? refusal('cancelled', 'cancelled') : refusal('unavailable', LIMIT_REACHED)
    return refusal('unavailable', 'a stored capture cannot be read')
  }
}

/** One file's difference between two captures: unified, `context` lines around each change. */
export function fileDifference(
  store: TurnStore,
  a: string,
  b: string,
  path: string,
  options: CompareOptions & { context?: number } = {}
): TurnDifference | TurnRefusal {
  return differenceAt(store, a, b, path, options, (before, after, stop): TurnDifference =>
    ({ state: 'text', ...unified(before, after, { context: options.context ?? 3, stop }) }))
}

/**
 * One file's difference as the window may read it (Story 69.5): three lines of context, bounded, and with
 * every secret value already masked. Finding and laying the masks is inside the same limit as the comparison.
 */
export function shownFileDifference(
  store: TurnStore,
  a: string,
  b: string,
  path: string,
  options: CompareOptions & { shown?: ShownLimits } = {}
): TurnShownDifference | TurnRefusal {
  // No more lines are laid out than can be shown: the rest is counted.
  return differenceAt(store, a, b, path, options, (before, after, stop): TurnShownDifference =>
    showDifference(path, before, after, unified(before, after, { context: 3, stop, keep: (options.shown ?? SHOWN_LIMITS).lines + 1 }),
      { stop, ...(options.shown ? { limits: options.shown } : {}) }))
}
