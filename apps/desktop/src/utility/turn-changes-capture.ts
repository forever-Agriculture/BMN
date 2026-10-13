// MODULE: turn-changes-capture.ts - captures the Git work tree a folder lies in into BMN's own store, touching nothing in it and running nothing it names
//
// BMN establishes the root by its own walk, asks Git whether it accepts the repository and which paths
// belong, and reads every file's bytes itself. How a read stays under the root: the root is opened
// once and every folder on the way to a file is opened by name inside the folder already held, never
// following a link (`/proc/self/fd/<held>/<name>` with O_NOFOLLOW). No path from the top is resolved
// again, so a link or a folder swapped in while the capture runs cannot lead anywhere; such an entry
// ends as "not read". Measured in Story 69.1 (`docs/turn-changes.md`).
import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, type Stats
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { decodeText } from './turn-changes-diff'
import { runTurnGit, turnGitExecutable, type TurnGitCall, type TurnGitContext } from './turn-changes-git'
import {
  TURN_STORE_FORMAT, TurnStore, privateFolder, sha256,
  type NotReadEntry, type NotReadReason, type SeenFile, type TreeRow, type TurnCaptureCounts, type TurnCaptureRecord, type TurnEntry
} from './turn-changes-store'

const MiB = 1024 * 1024

/** R69-NFR5. */
export const TURN_LIMITS = Object.freeze({
  entries: 20_000,
  fileBytes: 10 * MiB,
  readBytes: 100 * MiB,
  storeBytes: 1024 * MiB,
  captureMs: 2_000,
  compareMs: 2_000
})
export type TurnLimits = { -readonly [Name in keyof typeof TURN_LIMITS]: number }

export type TurnRefusalState = 'unavailable' | 'not-supported' | 'cancelled' | 'busy'

/** Every reason a capture or a comparison is refused with. A closed list: none can carry a file's name. */
export type TurnRefusalReason =
  | 'the terminal has no foreground process'
  | 'the folder cannot be reached'
  | 'the folder is not a folder'
  | 'no folder at or above it holds a .git'
  | 'the folder lies inside a .git folder'
  | 'the named folder cannot be reached'
  | 'the named folder does not lie in this work tree'
  | 'the root cannot be opened'
  | 'Git is not installed'
  | 'Git cannot read this repository'
  | 'Git did not answer in time'
  | 'Git listed a path BMN cannot use'
  | 'Git could not list this work tree'
  | 'the root changed while it was captured'
  | 'a bare repository'
  | 'Git refuses this repository as unsafe'
  | "the repository's settings name another work tree"
  | 'the root changed while it was being established'
  | "this work tree holds BMN's data folder"
  | "this work tree lies in BMN's data folder"
  | 'a sparse checkout'
  | 'a capture is gone'
  | 'a capture is incomplete'
  | "the repository's object format changed"
  | 'a stored capture cannot be read'
  | 'not read'
  | 'Difference unavailable: limit reached'
  | 'cancelled'
  | 'busy'

export interface TurnRefusal {
  state: TurnRefusalState
  reason: TurnRefusalReason
  /** The limit an incomplete capture met, when that is why a comparison is refused. */
  bound?: string
}

export const refusal = (state: TurnRefusalState, reason: TurnRefusalReason): TurnRefusal => ({ state, reason })

/** Hooks for tests: moments at which a test swaps something under the capture. Never set by the app. */
export interface CaptureSeams {
  afterRootOpened?: (root: string) => void | Promise<void>
  afterList?: (root: string) => void | Promise<void>
  beforeEntry?: (path: string, root: string) => void | Promise<void>
  duringRead?: (path: string) => void
}

export interface CaptureOptions {
  /** The Git program; the first fixed candidate that exists when left out. */
  git?: string | null | undefined
  home: string
  dataRoot: string
  session: string
  /** A folder a caller names. It says where to look and is never permission to read: it must lie in the root. */
  named?: string | null
  /** The capture this one will be compared with first: its paths that are no longer listed are looked at, to tell "gone" from "no longer covered". */
  base?: string | null
  limits?: Partial<TurnLimits>
  signal?: AbortSignal
  seams?: CaptureSeams
  /** Reuse a store, with what it holds in memory. */
  store?: TurnStore
  /** The same, for a caller that learns the root only from the capture. */
  storeFor?: (root: string) => TurnStore
  observeGit?: (call: TurnGitCall) => void
}

/** A capture that is whole or incomplete and not yet real: `publish` makes it so in one step, `discard` removes its bytes at once. */
export interface StagedCapture {
  state: 'whole' | 'incomplete'
  record: TurnCaptureRecord
  tookMs: number
  phases: Record<string, number>
  publish: () => TurnCaptureRecord
  discard: () => void
}

export type CaptureOutcome = StagedCapture | TurnRefusal

export const isRefusal = (outcome: CaptureOutcome | EstablishedRoot | TurnRefusal): outcome is TurnRefusal =>
  outcome.state === 'unavailable' || outcome.state === 'not-supported' || outcome.state === 'cancelled' || outcome.state === 'busy'

const COMMIT = /^[0-9a-f]{40,64}$/
const STORE_FULL = 'store full'

// ---- reads that stay under the root ---------------------------------------------------------------

/**
 * Folders and files opened by name inside a folder already held, never through a link. Only the
 * folders on the way to the last path stay open, so paths walked in order open each folder once.
 */
class Confined {
  private names: string[] = []
  private fds: number[] = []
  private last = ''
  private readonly rootFd: number

  constructor(rootFd: number) {
    this.rootFd = rootFd
  }

  /** The held folder of a path relative to the root ('' is the root). Throws when a part of it is a link or no folder. */
  folder(relative: string): number {
    if (relative === this.last) return this.fds.at(-1) ?? this.rootFd
    const parts = relative === '' ? [] : relative.split('/')
    let keep = 0
    while (keep < this.names.length && keep < parts.length && this.names[keep] === parts[keep]) keep += 1
    while (this.names.length > keep) {
      closeSync(this.fds.pop() as number)
      this.names.pop()
    }
    this.last = this.names.join('/')
    for (let index = keep; index < parts.length; index += 1) {
      const name = parts[index] as string
      this.fds.push(openSync(`/proc/self/fd/${this.fds.at(-1) ?? this.rootFd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
      this.names.push(name)
      this.last = this.names.join('/')
    }
    return this.fds.at(-1) ?? this.rootFd
  }

  private inside(relative: string): string {
    const cut = relative.lastIndexOf('/')
    return `/proc/self/fd/${this.folder(cut < 0 ? '' : relative.slice(0, cut))}/${cut < 0 ? relative : relative.slice(cut + 1)}`
  }

  openFile(relative: string): number {
    return openSync(this.inside(relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  }

  readLink(relative: string): Buffer {
    return readlinkSync(this.inside(relative), { encoding: 'buffer' })
  }

  closeFolders(): void {
    for (let fd = this.fds.pop(); fd !== undefined; fd = this.fds.pop()) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
    this.names = []
    this.last = ''
  }
}

// ---- the root --------------------------------------------------------------------------------------

export interface EstablishedRoot {
  state: 'established'
  root: string
  rootFd: number
  device: number
  inode: number
  objectFormat: string
  head: string | null
}

interface RootContext {
  git: string
  home: string
  dataRoot: string
  named?: string | null | undefined
  /** The signal for the one Git command of this step: the caller's cancel and the capture's time. */
  signal: AbortSignal
  cancelled: () => boolean
  seams?: CaptureSeams | undefined
  observeGit?: ((call: TurnGitCall) => void) | undefined
}

const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`)

function holdsRepository(folder: string): boolean {
  const marker = lstatSync(join(folder, '.git'), { throwIfNoEntry: false })
  if (!marker) return false
  if (marker.isFile()) return true
  return marker.isDirectory() && existsSync(join(folder, '.git', 'HEAD'))
}

/** What Git itself takes for a repository's own folder: a HEAD beside `objects` and `refs`. */
function looksLikeGitFolder(folder: string): boolean {
  const is = (name: string, folderWanted: boolean): boolean => {
    const stat = statSync(join(folder, name), { throwIfNoEntry: false })
    return stat !== undefined && (folderWanted ? stat.isDirectory() : stat.isFile())
  }
  return is('HEAD', false) && is('objects', true) && is('refs', true)
}

/** The path still names, without a link, the folder that was opened. */
function sameFolder(root: string, held: { dev: number; ino: number }): boolean {
  try {
    const now = lstatSync(root)
    return now.isDirectory() && now.dev === held.dev && now.ino === held.ino && realpathSync(root) === root
  } catch {
    return false
  }
}

/**
 * The root BMN establishes by itself (R69-NFR4): the nearest folder at or above `folder`, links
 * resolved, that holds a `.git`. It is opened and held; Git is then asked whether it accepts the
 * repository and which work tree it names, and the answer must be that same folder. The caller closes
 * `rootFd`. Nothing is read or written before this has succeeded.
 */
export async function establishRoot(folder: string, context: RootContext): Promise<EstablishedRoot | TurnRefusal> {
  let start: string
  try {
    start = realpathSync(folder)
    if (!statSync(start).isDirectory()) return refusal('unavailable', 'the folder is not a folder')
  } catch {
    return refusal('unavailable', 'the folder cannot be reached')
  }
  let root = start
  for (;;) {
    if (holdsRepository(root)) break
    if (looksLikeGitFolder(root)) {
      return root.split(sep).includes('.git')
        ? refusal('unavailable', 'the folder lies inside a .git folder')
        : refusal('not-supported', 'a bare repository')
    }
    const parent = dirname(root)
    if (parent === root) return refusal('unavailable', 'no folder at or above it holds a .git')
    root = parent
  }
  if (context.named !== undefined && context.named !== null) {
    let named: string
    try {
      named = realpathSync(context.named)
    } catch {
      return refusal('unavailable', 'the named folder cannot be reached')
    }
    if (!within(named, root)) return refusal('unavailable', 'the named folder does not lie in this work tree')
  }
  let dataRoot = context.dataRoot
  try {
    dataRoot = realpathSync(context.dataRoot)
  } catch {
    // Not made yet: compared as written.
  }
  if (within(dataRoot, root)) return refusal('not-supported', "this work tree holds BMN's data folder")
  if (within(root, dataRoot)) return refusal('not-supported', "this work tree lies in BMN's data folder")

  let rootFd: number
  try {
    rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch {
    return refusal('unavailable', 'the root cannot be opened')
  }
  const fail = (state: TurnRefusal['state'], reason: TurnRefusalReason): TurnRefusal => {
    closeSync(rootFd)
    return refusal(state, reason)
  }
  try {
    const held = fstatSync(rootFd)
    await context.seams?.afterRootOpened?.(root)

    const git: TurnGitContext = { git: context.git, home: context.home, signal: context.signal, observe: context.observeGit }
    const identity = await runTurnGit(git, root, 'identity')
    if (identity.stopped) return context.cancelled() ? fail('cancelled', 'cancelled') : fail('unavailable', 'Git did not answer in time')
    const facts = identity.stdout.trimEnd().split('\n')
    // A repository its settings call bare answers this much and then fails: it has no work tree to name.
    if (facts[0] === 'true') return fail('not-supported', 'a bare repository')
    if (facts.length < 5 || (identity.code !== 0 && facts.length !== 6)) {
      if (/dubious ownership/.test(identity.stderr)) return fail('not-supported', 'Git refuses this repository as unsafe')
      return fail('unavailable', 'Git cannot read this repository')
    }
    const [bare, insideWorkTree, topLevel, , objectFormat, head] = facts
    if (bare === 'true') return fail('not-supported', 'a bare repository')
    let named: string | null = null
    try {
      named = realpathSync(topLevel ?? '')
    } catch {
      // Compared as missing.
    }
    if (insideWorkTree !== 'true' || named !== root) return fail('not-supported', "the repository's settings name another work tree")
    if (!sameFolder(root, held)) return fail('not-supported', 'the root changed while it was being established')
    return {
      state: 'established', root, rootFd, device: held.dev, inode: held.ino, objectFormat: objectFormat ?? 'unknown',
      head: identity.code === 0 && COMMIT.test(head ?? '') ? (head as string) : null
    }
  } catch (error) {
    closeSync(rootFd)
    throw error
  }
}

// ---- a capture ---------------------------------------------------------------------------------------

const busy = new Set<string>()

/** Whether a capture of this root is running or staged in this process. */
export function isCapturing(root: string): boolean {
  return busy.has(root)
}

const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const strict = new TextDecoder('utf-8', { fatal: true })
const lossy = new TextDecoder('utf-8')
/** A path Git may list: no empty part, no `.` and no `..`, not from the top. */
const UNUSABLE = /(^|\/)(\.{1,2})?(\/|$)/
const executableBit = (stat: Stats): 0 | 1 => ((stat.mode & 0o100) !== 0 ? 1 : 0)
const notRead = (why: NotReadReason): NotReadEntry => ['u', why]
const sizeWords = (bytes: number): string => (bytes % MiB === 0 ? `${bytes / MiB} MiB` : `${bytes.toLocaleString('en-US')} bytes`)

interface Listed {
  tag: string
  path: string
  mode: string | null
  folder: boolean
  unreadableName: boolean
}

/** One record of `git ls-files -z -t --stage --cached --others --exclude-standard`. */
function parseListed(record: Buffer): Listed | null {
  if (record.length < 3 || record[1] !== 0x20) return null
  const tag = String.fromCharCode(record[0] as number)
  let from = 2
  let mode: string | null = null
  if (tag !== '?') {
    const tab = record.indexOf(0x09)
    // "<mode> <object> <stage>" stands between the tag and the tab.
    if (tab < 12 || record[8] !== 0x20) return null
    mode = record.toString('latin1', 2, 8)
    from = tab + 1
  }
  let to = record.length
  const folder = to > from && record[to - 1] === 0x2f
  if (folder) to -= 1
  let path: string
  let unreadableName = false
  try {
    path = strict.decode(record.subarray(from, to))
  } catch {
    path = lossy.decode(record.subarray(from, to))
    unreadableName = true
  }
  if (path === '' || UNUSABLE.test(path)) return null
  return { tag, path, mode, folder, unreadableName }
}

interface Waiting {
  path: string
  stat: Stats | null
  gitlink: boolean
}

/** Every path of a stored tree that is not a folder. */
export function* leaves(store: TurnStore, hash: string, prefix = ''): Generator<string> {
  for (const [name, row] of store.tree(hash)) {
    if (row[1] === 'd') yield* leaves(store, row[2], `${prefix}${name}/`)
    else yield `${prefix}${name}`
  }
}

/**
 * Captures the work tree that holds `folder` into the session's store, staged. Nothing is read and
 * nothing is written before the root is established and the listing is whole. One capture of a root
 * runs at a time in this process: a second one is answered "busy", until the first is published or
 * discarded.
 */
export async function capture(folder: string, options: CaptureOptions): Promise<CaptureOutcome> {
  const limits: TurnLimits = { ...TURN_LIMITS, ...options.limits }
  const gitProgram = options.git === undefined ? turnGitExecutable() : options.git
  if (!gitProgram) return refusal('unavailable', 'Git is not installed')
  const startedAt = Date.now()
  const startedClock = performance.now()
  const phases: Record<string, number> = {}
  let mark = startedClock
  const phase = (name: string): void => {
    const now = performance.now()
    phases[name] = Math.round((now - mark) * 10) / 10
    mark = now
  }
  const caller = options.signal
  const cancelled = (): boolean => caller?.aborted === true
  const overtime = (): boolean => performance.now() - startedClock > limits.captureMs
  /** The signal of one Git command: the caller's cancel, and what is left of the capture's time (never less than `least`). */
  const gitSignal = (least = 0): AbortSignal => {
    const left = Math.max(least, limits.captureMs - (performance.now() - startedClock))
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(left)))
    return caller ? AbortSignal.any([caller, timeout]) : timeout
  }
  const timeBound = `${limits.captureMs / 1000} s`

  const established = await establishRoot(folder, {
    git: gitProgram, home: options.home, dataRoot: options.dataRoot, named: options.named, signal: gitSignal(), cancelled,
    seams: options.seams, observeGit: options.observeGit
  })
  if (isRefusal(established)) return established
  phase('root')
  const { root, rootFd } = established
  if (busy.has(root)) {
    closeSync(rootFd)
    return refusal('busy', 'busy')
  }
  busy.add(root)
  const confined = new Confined(rootFd)
  let store: TurnStore
  try {
    store = options.store ?? options.storeFor?.(root) ?? new TurnStore(options.dataRoot, options.session, root)
  } catch (error) {
    closeSync(rootFd)
    busy.delete(root)
    throw error
  }
  const id = `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`
  const staging = store.stagingPath(id)
  let staged = false
  const release = (): void => {
    confined.closeFolders()
    try {
      closeSync(rootFd)
    } catch {
      // Closed.
    }
    busy.delete(root)
  }
  const drop = (): void => {
    if (staged) store.discardStaging(id)
    staged = false
  }
  const end = (state: TurnRefusal['state'], reason: TurnRefusalReason): TurnRefusal => {
    drop()
    release()
    return refusal(state, reason)
  }
  const git = (signal: AbortSignal): TurnGitContext => ({ git: gitProgram, home: options.home, signal, observe: options.observeGit })
  const prefix = `${root}/`

  try {
    const cache = store.loadCache()
    const base = options.base ? store.record(options.base) : null
    const basePaths = base?.tree ? (cache?.capture === base.id ? cache.paths : new Set(leaves(store, base.tree))) : null
    const stored = store.storedBytes()
    phase('cache')

    // 1. What belongs, listed anew. Each record is looked at (lstat) as it arrives. A file that is as it
    // was when it was last read takes its place at once; everything else waits until the listing is
    // whole, so nothing is read and nothing is written before the last refusal can have been made.
    const folders = new Map<string, Map<string, TurnEntry | null>>([['', new Map()]])
    const shadowed = new Set<string>()
    const dirty = new Set<string>()
    const files = new Map<string, SeenFile>()
    const paths = new Set<string>()
    let lastFolder = ''
    let lastRows = folders.get('') as Map<string, TurnEntry | null>
    const rowsOf = (relative: string): Map<string, TurnEntry | null> => {
      if (relative === lastFolder) return lastRows
      let rows = folders.get(relative)
      if (!rows) {
        rows = new Map()
        folders.set(relative, rows)
        const cut = relative.lastIndexOf('/')
        const parent = rowsOf(cut < 0 ? '' : relative.slice(0, cut))
        const name = cut < 0 ? relative : relative.slice(cut + 1)
        // A path that is an entry and also the folder of others (a link below which Git still lists
        // files): the entry stands, as Git sees it, and what is listed below it is left out.
        if (parent.get(name)) shadowed.add(relative)
        else parent.set(name, null)
      }
      lastFolder = relative
      lastRows = rows
      return rows
    }
    const place = (path: string, entry: TurnEntry): void => {
      const cut = path.lastIndexOf('/')
      const rows = rowsOf(cut < 0 ? '' : path.slice(0, cut))
      const name = cut < 0 ? path : path.slice(cut + 1)
      if (rows.get(name) === null) shadowed.add(path)
      rows.set(name, entry)
      paths.add(path)
    }
    const entered: string[] = []
    const waiting: Waiting[] = []
    const unmerged = new Set<string>()
    let pending: Buffer = Buffer.alloc(0)
    // What the listing met. One object, because `take` writes it from inside a callback.
    const met: { refused: TurnRefusal | null; bound: string | null } = { refused: null, bound: null }
    let count = 0
    const entriesBound = `${limits.entries.toLocaleString('en-US')} entries`
    const take = (record: Buffer): boolean => {
      const parsed = parseListed(record)
      if (parsed === null) {
        met.refused = refusal('unavailable', 'Git listed a path BMN cannot use')
        return false
      }
      if (parsed.tag === 'S') {
        met.refused = refusal('not-supported', 'a sparse checkout')
        return false
      }
      const { path } = parsed
      if (parsed.tag === 'M') {
        if (unmerged.has(path)) return true
        unmerged.add(path)
      }
      if (parsed.unreadableName) {
        if (count >= limits.entries) {
          met.bound = entriesBound
          return false
        }
        count += 1
        waiting.push({ path, stat: null, gitlink: false })
        return true
      }
      const stat = lstatSync(prefix + path, { throwIfNoEntry: false })
      if (!stat) return true
      if (stat.isDirectory() && !parsed.folder && parsed.mode !== '160000') return true
      if (count >= limits.entries) {
        met.bound = entriesBound
        return false
      }
      count += 1
      // Made after the earlier scan began: added. Older, or with no birth time: it was there and not covered.
      // The scan's start is a whole millisecond, rounded down, so a file made in that same millisecond counts as older.
      if (base && basePaths && !basePaths.has(path) && !(stat.birthtimeMs > 0 && stat.birthtimeMs >= base.startedAt + 1)) entered.push(path)
      if (stat.isFile()) {
        const known = cache?.files.get(path)
        // A file is taken as read before only when everything Linux tells of it is the same and it had
        // been still for a moment when it was read, so a write in the same clock tick cannot hide.
        if (known && known[0] === stat.size && known[1] === stat.mtimeMs && known[2] === stat.ctimeMs && known[3] === stat.ino && known[4] === stat.dev && known[2] + 10 < known[5]) {
          files.set(path, known)
          place(path, ['f', known[6], stat.size, executableBit(stat)])
          return true
        }
      }
      waiting.push({ path, stat, gitlink: parsed.mode === '160000' })
      return true
    }
    let listingCut = false
    const listing = await runTurnGit(git(gitSignal()), root, 'list', (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      let from = 0
      for (;;) {
        const at = pending.indexOf(0, from)
        if (at < 0) break
        if (!take(pending.subarray(from, at))) return false
        from = at + 1
      }
      pending = pending.subarray(from)
      return true
    })
    if (cancelled()) return end('cancelled', 'cancelled')
    if (met.refused) return end(met.refused.state, met.refused.reason)
    if (met.bound === null) {
      if (listing.stopped) {
        // The listing ran out of the capture's time: what was listed is not the work tree, so nothing is kept.
        met.bound = timeBound
        listingCut = true
      } else if (listing.code !== 0 || pending.length > 0) {
        return end('unavailable', 'Git could not list this work tree')
      }
    }
    phase('list')
    await options.seams?.afterList?.(root)

    // 2. The rest: links as their text, submodules and nested repositories as one entry, files by their bytes.
    const stagedObjects = new Set<string>()
    let bytesRead = 0
    let bytesStored = 0
    let slice = performance.now()
    const stage = (kind: 'blobs' | 'trees', hash: string, bytes: Uint8Array): boolean => {
      if (stored + bytesStored + bytes.length > limits.storeBytes) return false
      if (!staged) {
        privateFolder(join(staging, 'blobs'))
        privateFolder(join(staging, 'trees'))
        staged = true
      }
      writeFileSync(join(staging, kind, hash), bytes, { mode: 0o600 })
      bytesStored += bytes.length
      stagedObjects.add(hash)
      return true
    }
    const beforeEntry = options.seams?.beforeEntry
    const readBound = `${sizeWords(limits.readBytes)} read`
    // A work tree past the limit of entries, or one whose listing was cut, can never be whole: nothing of it is read.
    for (const item of met.bound === null ? waiting : []) {
      if (performance.now() - slice > 4) {
        await yieldNow()
        slice = performance.now()
        if (cancelled()) return end('cancelled', 'cancelled')
        if (overtime()) {
          met.bound = timeBound
          break
        }
      }
      const { path, stat } = item
      const cut = path.lastIndexOf('/')
      dirty.add(cut < 0 ? '' : path.slice(0, cut))
      if (stat === null) {
        place(path, notRead('its name is not valid UTF-8'))
        continue
      }
      if (beforeEntry) await beforeEntry(path, root)
      let entry: TurnEntry
      try {
        if (stat.isSymbolicLink()) {
          const text = decodeText(confined.readLink(path))
          entry = text === null ? notRead('not read') : ['l', text]
        } else if (stat.isDirectory()) {
          entry = ['s', await nestedHead(git(gitSignal(250)), confined, root, path), item.gitlink ? 0 : 1]
        } else if (!stat.isFile()) {
          entry = notRead('not a regular file')
        } else if (stat.size > limits.fileBytes) {
          entry = ['x', stat.size, stat.mtimeMs, executableBit(stat)]
        } else {
          if (bytesRead + stat.size > limits.readBytes) {
            met.bound = readBound
            break
          }
          const read = readStill(confined, path, limits, limits.readBytes - bytesRead, options.seams)
          bytesRead += read.counted
          if (read.over || bytesRead > limits.readBytes) {
            met.bound = readBound
            break
          }
          if (read.entry) entry = read.entry
          else {
            const hash = sha256(read.bytes)
            if (!stagedObjects.has(hash) && !store.hasObject('blobs', hash) && !stage('blobs', hash, read.bytes)) {
              met.bound = STORE_FULL
              break
            }
            files.set(path, [read.stat.size, read.stat.mtimeMs, read.stat.ctimeMs, read.stat.ino, read.stat.dev, Date.now(), hash])
            entry = ['f', hash, read.bytes.length, executableBit(read.stat)]
          }
        }
      } catch {
        // A link or a folder in the way, a file that went away, a file BMN may not open: not read.
        entry = notRead('not read')
      }
      place(path, entry)
    }
    if (cancelled()) return end('cancelled', 'cancelled')
    phase('entries')

    // 3. Paths of the capture this one is compared with that are no longer listed: gone, or still there.
    const gone: string[] = []
    const left: string[] = []
    if (basePaths && met.bound === null) {
      for (const path of basePaths) {
        if (paths.has(path)) continue
        // Looking only: a path that still names something was not removed, whatever it now is.
        if (lstatSync(prefix + path, { throwIfNoEntry: false }) === undefined) gone.push(path)
        else left.push(path)
      }
    }
    phase('probes')

    const head = await runTurnGit(git(gitSignal(250)), root, 'head')
    if (cancelled()) return end('cancelled', 'cancelled')
    if (!sameFolder(root, { dev: established.device, ino: established.inode })) return end('unavailable', 'the root changed while it was captured')
    phase('head')

    // 4. One list per folder, the deepest first, each named by the SHA-256 of its text. A folder in which
    // every entry is as it was, with as many entries as before, keeps the list it had. A capture that
    // met the limit of entries, a cut listing or a full store keeps nothing: it could never be compared.
    let hollow = listingCut || met.bound === STORE_FULL || met.bound === entriesBound
    const trees = new Set<string>()
    const hashes = new Map<string, string>()
    const lists = new Map<string, [string, number]>()
    const counts: TurnCaptureCounts = { entries: 0, files: 0, links: 0, submodules: 0, tooLarge: 0, notRead: 0 }
    if (!hollow) {
      if (shadowed.size > 0) {
        const below = (path: string): boolean => {
          for (const top of shadowed) if (path.startsWith(`${top}/`)) return true
          return false
        }
        for (const relative of [...folders.keys()]) if (shadowed.has(relative) || below(relative)) folders.delete(relative)
        for (const path of [...paths]) {
          if (below(path)) {
            paths.delete(path)
            files.delete(path)
          }
        }
      }
      for (const relative of [...folders.keys()].sort((one, other) => other.length - one.length)) {
        const rows = folders.get(relative) as Map<string, TurnEntry | null>
        const kept = cache?.folders.get(relative)
        let hash: string
        if (kept && kept[1] === rows.size && !dirty.has(relative)) {
          hash = kept[0]
        } else {
          const list: TreeRow[] = []
          for (const [name, entry] of rows) {
            list.push(entry === null ? [name, 'd', hashes.get(relative === '' ? name : `${relative}/${name}`) as string] : ([name, ...entry] as TreeRow))
          }
          list.sort((one, other) => (one[0] < other[0] ? -1 : one[0] > other[0] ? 1 : 0))
          const text = Buffer.from(JSON.stringify(list))
          hash = sha256(text)
          if (!cache?.trees.has(hash) && !stagedObjects.has(hash) && !store.hasObject('trees', hash) && !stage('trees', hash, text)) {
            met.bound = STORE_FULL
            hollow = true
            break
          }
          if (relative !== '') {
            const cut = relative.lastIndexOf('/')
            dirty.add(cut < 0 ? '' : relative.slice(0, cut))
          }
        }
        hashes.set(relative, hash)
        lists.set(relative, [hash, rows.size])
        trees.add(hash)
      }
    }
    if (!hollow) {
      const kinds = { f: 'files', l: 'links', s: 'submodules', x: 'tooLarge', u: 'notRead' } as const
      for (const rows of folders.values()) for (const entry of rows.values()) if (entry !== null) counts[kinds[entry[0]]] += 1
      counts.entries = counts.files + counts.links + counts.submodules + counts.tooLarge + counts.notRead
    } else {
      counts.entries = count
      drop()
      bytesStored = 0
    }
    phase('lists')

    const headEnd = head.stdout.trim()
    const record: TurnCaptureRecord = {
      format: TURN_STORE_FORMAT, id, root, rootDevice: established.device, rootInode: established.inode, objectFormat: established.objectFormat,
      startedAt, endedAt: Date.now(), headStart: established.head, headEnd: head.code === 0 && COMMIT.test(headEnd) ? headEnd : null,
      state: met.bound === null ? 'whole' : 'incomplete', bound: met.bound, tree: hollow ? null : (hashes.get('') ?? null), counts, bytesRead, bytesStored,
      base: met.bound === null ? (base?.id ?? null) : null, gone, left, entered: met.bound === null ? entered : []
    }
    let settled = false
    return {
      state: record.state,
      record,
      tookMs: performance.now() - startedClock,
      phases,
      /** One step makes the capture real: its record appears under `captures/`. */
      publish(): TurnCaptureRecord {
        if (settled) throw new Error('this capture was already published or discarded')
        settled = true
        try {
          privateFolder(join(store.directory, 'captures'))
          if (staged) {
            const made = new Set<string>()
            for (const kind of ['blobs', 'trees'] as const) {
              for (const hash of readdirSync(join(staging, kind))) {
                const target = store.objectPath(kind, hash)
                if (!made.has(dirname(target))) {
                  privateFolder(dirname(target))
                  made.add(dirname(target))
                }
                renameSync(join(staging, kind, hash), target)
              }
            }
          } else privateFolder(staging)
          writeFileSync(join(staging, 'capture.json'), JSON.stringify(record), { mode: 0o600 })
          renameSync(join(staging, 'capture.json'), store.capturePath(id))
          rmSync(staging, { recursive: true, force: true })
          staged = false
          if (!hollow) store.saveCache({ capture: id, startedAt, files, paths, trees, folders: lists }, stored + bytesStored)
        } finally {
          release()
        }
        return record
      },
      /** A capture that was cancelled or not confirmed: its staged bytes go at once. */
      discard(): void {
        if (settled) return
        settled = true
        drop()
        release()
      }
    }
  } catch (error) {
    drop()
    release()
    throw error
  }
}

type StillRead =
  | { counted: number; over?: undefined; entry: TurnEntry; bytes?: undefined; stat?: undefined }
  | { counted: number; over?: undefined; entry?: undefined; bytes: Buffer; stat: Stats }
  | { counted: number; over: true; entry?: undefined; bytes?: undefined; stat?: undefined }

/**
 * A file read whole, once more when it changed under the read, and then given up as "changed while
 * read". Bytes are counted while they are read, against `allowance`: a file that grows is `over`
 * before it can pass the capture's bound.
 */
function readStill(confined: Confined, path: string, limits: TurnLimits, allowance: number, seams: CaptureSeams | undefined): StillRead {
  let counted = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fd = confined.openFile(path)
    try {
      const before = fstatSync(fd)
      if (!before.isFile()) return { counted, entry: notRead('not a regular file') }
      if (before.size > limits.fileBytes) return { counted, entry: ['x', before.size, before.mtimeMs, executableBit(before)] }
      if (counted + before.size > allowance) return { counted, over: true }
      // One byte more than the size seen: a file that grows fills it and is read again, never past the limit.
      const bytes = Buffer.allocUnsafe(before.size + 1)
      let filled = 0
      seams?.duringRead?.(path)
      for (;;) {
        const got = readSync(fd, bytes, filled, bytes.length - filled, filled)
        if (got === 0) break
        filled += got
        counted += got
        if (filled === bytes.length) break
      }
      const after = fstatSync(fd)
      if (filled === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs) {
        return { counted, bytes: bytes.subarray(0, filled), stat: before }
      }
    } finally {
      closeSync(fd)
    }
  }
  return { counted, entry: notRead('changed while read') }
}

/** The commit a submodule's or nested repository's own HEAD names, as Git reports it; null when it has none. */
async function nestedHead(git: TurnGitContext, confined: Confined, root: string, path: string): Promise<string | null> {
  // Its folder is opened under the root like any other; Git is started in that very folder and may not look above it.
  const fd = confined.folder(path)
  if (!lstatSync(`/proc/self/fd/${fd}/.git`, { throwIfNoEntry: false })) return null
  const real = readlinkSync(`/proc/self/fd/${fd}`)
  if (!within(real, root) || real === root) return null
  const answer = await runTurnGit(git, real, 'nested')
  const commit = answer.stdout.trim()
  return answer.code === 0 && COMMIT.test(commit) ? commit : null
}
