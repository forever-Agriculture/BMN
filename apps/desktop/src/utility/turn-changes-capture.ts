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
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, type Stats
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { decodeText } from './turn-changes-diff'
import { runTurnGit, turnGitExecutable, type TurnGitCall, type TurnGitContext } from './turn-changes-git'
import {
  TURN_STORE_FORMAT, TurnStore, privateFolder, sha256,
  type NotReadEntry, type NotReadReason, type SeenFile, type TreeRow, type TurnCache, type TurnCaptureCounts, type TurnCaptureRecord, type TurnEntry
} from './turn-changes-store'

const MiB = 1024 * 1024

/** R69-NFR5. */
export const TURN_LIMITS = Object.freeze({
  entries: 20_000,
  fileBytes: 10 * MiB,
  readBytes: 100 * MiB,
  /** One session's stores, all its work trees together. */
  storeBytes: 1024 * MiB,
  /** Every session's stores together. */
  allStoresBytes: 5 * 1024 * MiB,
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
  | 'the root is no longer the folder that was scanned'
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
  /** After the entries, before the earlier capture's paths are looked at. */
  beforeProbes?: () => void | Promise<void>
  /** After the last Git command, before the lists are written. */
  beforeLists?: () => void | Promise<void>
  /** After the lists, before the capture's record and its cache are made. */
  beforeRecord?: () => void | Promise<void>
  /** Before a staged file or list is moved into the store, with how many were moved so far. */
  beforeMove?: (moved: number) => void | Promise<void>
  /** After everything was moved in and the cache was written, before the last look at the clock. */
  beforeLastLook?: () => void | Promise<void>
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
  /**
   * The root an earlier capture of the same turn established. When the root found now is not that very folder
   * (the same path, device and file number), nothing is read: a folder put in its place is not the turn's.
   */
  expect?: TurnRootIdentity | null
  limits?: Partial<TurnLimits>
  signal?: AbortSignal
  seams?: CaptureSeams
  /** Reuse a store, with what it holds in memory. */
  store?: TurnStore
  /** The same, for a caller that learns the root only from the capture. */
  storeFor?: (root: string) => TurnStore
  /**
   * How many more bytes this capture may put on disk, as the caller counted them there: what is left of
   * the session's bound and of the bound of all stores. Its files, its lists, its own record and what its
   * cache grows by all count. Without it, only this one store is counted.
   */
  room?: number
  /**
   * Called whenever staged bytes of this capture leave `staging/` without being kept: how many, and a promise
   * that says whether they are gone (true) or could not be removed and are still on disk (false).
   */
  dropped?: (bytes: number, gone: Promise<boolean>) => void
  observeGit?: (call: TurnGitCall) => void
}

/** A root as a capture established it: its path, and the device and file number of the folder it opened. */
export interface TurnRootIdentity {
  root: string
  device: number
  inode: number
}

/** A capture as it was published: its record as it stands on disk, what the store really grew by, and its whole time. */
export interface PublishedCapture {
  record: TurnCaptureRecord
  /** Bytes the store grew by: files and lists moved in, the record, and the new cache less the old one (so it can be negative). */
  added: number
  /** From the capture's start through the step that published it, the wait between staging and publishing left out. */
  tookMs: number
  /** Something failed after the record appeared: the capture is real, and `added` may not be what the disk holds. The store is to be counted from the disk. */
  recount?: boolean
}

/** A capture that is whole or incomplete and not yet real: `publish` makes it so in one step, `discard` removes its bytes at once. */
export interface StagedCapture {
  state: 'whole' | 'incomplete'
  record: TurnCaptureRecord
  tookMs: number
  phases: Record<string, number>
  /**
   * The most publishing it needs on disk: its staged files and lists, its record, and its whole new cache,
   * because the old cache is still there while the new one is written.
   */
  adds: number
  /**
   * Moves the staged files and lists in, a few at a time, and then makes the capture real in one step: its
   * record appears under `captures/`. `stop` is asked between the slices: a publication that is stopped
   * takes out again what it moved in and resolves null. The capture's time goes on counting: when it passes
   * while files are moved, what was moved is kept, the rest is dropped and the record reads incomplete; when
   * it has passed at the last step, the record reads incomplete too.
   */
  publish: (stop?: () => boolean) => Promise<PublishedCapture | null>
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

/**
 * Stores in which a stopped publication is still taking out what it moved in, by the store's folder, each
 * with the promise that says when that is done. Until then nothing in that store may be taken for stored:
 * a file that is about to go would be named by a capture that stays.
 */
const takingOut = new Map<string, Promise<void>>()

/** Resolves when the signal says stop; never without a signal. */
const stopped = (signal: AbortSignal | undefined): Promise<void> => new Promise((resolve) => {
  if (!signal) return
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', () => resolve(), { once: true })
})
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
  // Reading ends a little before the capture's time, so that what was read is still listed and written
  // inside it. A capture is whole only when everything, its last Git command and its lists included, was
  // done in its time.
  const closing = Math.min(250, limits.captureMs / 8)
  const readingOver = (): boolean => performance.now() - startedClock > limits.captureMs - closing
  // Everything done in slices after the reading (looking at an earlier capture's paths, the lists, moving
  // staged files in) ends this much before the capture's time. What is left for after it is not sliced and
  // is bounded by the limit of entries: making the record and the cache, writing them, the renames.
  const tail = Math.min(100, limits.captureMs / 20)
  const slicedOver = (): boolean => performance.now() - startedClock > limits.captureMs - tail
  /** The signal of one Git command: the caller's cancel, and what is left of the time for the capture's sliced work, so that what follows the command fits in the capture's time too. */
  const gitSignal = (): AbortSignal => {
    const left = limits.captureMs - tail - (performance.now() - startedClock)
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
  const expect = options.expect
  if (expect && (root !== expect.root || established.device !== expect.device || established.inode !== expect.inode)) {
    closeSync(rootFd)
    return refusal('unavailable', 'the root is no longer the folder that was scanned')
  }
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
  // Bytes of this capture that lie in `staging/` now.
  let inStaging = 0
  // Bytes this capture dropped from `staging/`: their removal was started and may not be done.
  let droppedBytes = 0
  const drop = (): void => {
    if (staged) {
      // The removal starts whether or not anybody counts its bytes.
      const gone = store.discardStaging(id)
      options.dropped?.(inStaging, gone)
      droppedBytes += inStaging
    }
    staged = false
    inStaging = 0
  }
  const end = (state: TurnRefusal['state'], reason: TurnRefusalReason): TurnRefusal => {
    drop()
    release()
    return refusal(state, reason)
  }
  const git = (signal: AbortSignal): TurnGitContext => ({ git: gitProgram, home: options.home, signal, observe: options.observeGit })
  const prefix = `${root}/`

  try {
    // A stopped publication of this store may still be taking out what it moved in. Nothing of that may be
    // taken for stored, so this capture waits until it is done. A cancel is heard meanwhile. The wait is
    // part of the capture's time: when that passes first the capture lists and reads nothing, like one
    // whose listing was cut, and so names nothing in the store.
    let waitedOut = false
    for (let going = takingOut.get(store.directory); going !== undefined && !waitedOut; going = takingOut.get(store.directory)) {
      let timer: NodeJS.Timeout | undefined
      const passed = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, limits.captureMs - tail - (performance.now() - startedClock)))
      })
      await Promise.race([going, stopped(caller), passed])
      clearTimeout(timer)
      if (cancelled()) return end('cancelled', 'cancelled')
      waitedOut = slicedOver()
    }
    const cache = store.loadCache()
    const base = options.base ? store.record(options.base) : null
    const basePaths = base?.tree ? (cache?.capture === base.id ? cache.paths : new Set(leaves(store, base.tree))) : null
    const room = options.room ?? limits.storeBytes - store.keptBytes()
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
    // A folder below the root that holds an entry named `.git` is a repository of its own: one entry, never
    // walked (R69-NFR4), also when Git lists files below it as the outer repository's, which it does for
    // files that were tracked there before. Every folder a listed path lies in is looked at once, from the
    // top down, before anything below it is counted, read or taken from the cache. `boundaryOf` gives the
    // topmost such folder at or above a folder. It only looks (`lstat`), as the listing does for every
    // path: a folder swapped meanwhile can at worst hide a boundary, and what is then read below it is
    // read through the confined reader, which refuses a swapped folder.
    const boundaries = new Map<string, string | null>([['', null]])
    const boundaryOf = (folder: string): string | null => {
      const known = boundaries.get(folder)
      if (known !== undefined) return known
      const cut = folder.lastIndexOf('/')
      let found = boundaryOf(cut < 0 ? '' : folder.slice(0, cut))
      if (found === null) {
        try {
          if (lstatSync(`${prefix}${folder}/.git`, { throwIfNoEntry: false })) found = folder
        } catch (error) {
          // A folder that cannot be looked into is not walked either. What is no folder has nothing below it.
          if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') found = folder
        }
      }
      boundaries.set(folder, found)
      return found
    }
    const folderOf = (path: string): string => {
      const cut = path.lastIndexOf('/')
      return cut < 0 ? '' : path.slice(0, cut)
    }
    /** Entries that stand for a whole folder (a submodule, a repository of its own), each placed once. */
    const standing = new Set<string>()
    // What the earlier capture held, for a change of what is covered: the folders its paths lay in, and
    // which of its entries stood for a whole folder. Neither is worked out unless a path asks.
    let baseFolders: Set<string> | null = null
    const hadBelow = (folder: string): boolean => {
      if (!basePaths) return false
      if (!baseFolders) {
        baseFolders = new Set()
        for (const path of basePaths) {
          for (let at = folderOf(path); at !== '' && !baseFolders.has(at); at = folderOf(at)) baseFolders.add(at)
        }
      }
      return baseFolders.has(folder)
    }
    const stoodBefore = new Map<string, boolean>([['', false]])
    /** Whether a folder was, or lay below, one entry that stood for a whole folder in the earlier capture. */
    const stoodFor = (folder: string): boolean => {
      const known = stoodBefore.get(folder)
      if (known !== undefined) return known
      let stood = stoodFor(folderOf(folder))
      if (!stood && base?.tree && basePaths?.has(folder)) {
        try {
          let rows = store.tree(base.tree)
          const parts = folder.split('/')
          for (const part of parts.slice(0, -1)) rows = store.tree((rows.get(part) as TreeRow)[2] as string)
          stood = rows.get(parts.at(-1) as string)?.[1] === 's'
        } catch {
          // The earlier capture's lists cannot be read: nothing is said about it.
        }
      }
      stoodBefore.set(folder, stood)
      return stood
    }
    /** Whether a path that the earlier capture did not hold came into what is covered, as against was made since. */
    const cameIn = (path: string, stat: Stats, standsForFolder: boolean): boolean => {
      if (!base || !basePaths || basePaths.has(path)) return false
      // What is covered changed around it: files below what was one entry, or one entry where files were. Its birth says nothing then.
      if (stoodFor(folderOf(path)) || (standsForFolder && hadBelow(path))) return true
      // Made after the earlier scan began: added. Older, or with no birth time: it was there and not covered.
      // The scan's start is a whole millisecond, rounded down, so a file made in that same millisecond counts as older.
      return !(stat.birthtimeMs > 0 && stat.birthtimeMs >= base.startedAt + 1)
    }
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
      let { path } = parsed
      if (parsed.tag === 'M') {
        if (unmerged.has(path)) return true
        unmerged.add(path)
      }
      const top = boundaryOf(folderOf(path))
      let boundary = false
      if (top !== null) {
        // Below a repository of its own: that folder is the entry, once, and this path is nothing.
        if (standing.has(top)) return true
        path = top
        boundary = true
      } else if (standing.has(path)) return true
      if (parsed.unreadableName && !boundary) {
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
      if (stat.isDirectory() && !boundary && !parsed.folder && parsed.mode !== '160000') return true
      if (count >= limits.entries) {
        met.bound = entriesBound
        return false
      }
      count += 1
      if (boundary || stat.isDirectory()) standing.add(path)
      if (cameIn(path, stat, boundary || stat.isDirectory())) entered.push(path)
      if (boundary) {
        waiting.push({ path, stat, gitlink: false })
        return true
      }
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
    let listingCut = waitedOut
    if (waitedOut) met.bound = timeBound
    const listing = waitedOut ? null : await runTurnGit(git(gitSignal()), root, 'list', (chunk) => {
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
    if (listing !== null && met.bound === null) {
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
    // What this capture staged, by kind: a file's bytes and a folder's list may hash alike and are still two things.
    const stagedSizes = { blobs: new Map<string, number>(), trees: new Map<string, number>() }
    let bytesRead = 0
    let bytesStored = 0
    let slice = performance.now()
    const stage = (kind: 'blobs' | 'trees', hash: string, bytes: Uint8Array): boolean => {
      if (bytesStored + bytes.length > room) return false
      if (!staged) {
        privateFolder(join(staging, 'blobs'))
        privateFolder(join(staging, 'trees'))
        staged = true
      }
      writeFileSync(join(staging, kind, hash), bytes, { mode: 0o600 })
      bytesStored += bytes.length
      inStaging += bytes.length
      stagedSizes[kind].set(hash, bytes.length)
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
        if (readingOver()) {
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
      let stopped = false
      try {
        if (stat.isSymbolicLink()) {
          const text = decodeText(confined.readLink(path))
          entry = text === null ? notRead('not read') : ['l', text]
        } else if (stat.isDirectory()) {
          const nested = await nestedHead(git(gitSignal()), confined, root, path)
          stopped = nested.stopped
          entry = ['s', nested.commit, item.gitlink ? 0 : 1]
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
            if (!stagedSizes.blobs.has(hash) && !store.hasObject('blobs', hash) && !stage('blobs', hash, read.bytes)) {
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
      if (stopped) {
        // Git did not say which commit it holds before the capture's time was up: nothing is written down for it.
        if (cancelled()) return end('cancelled', 'cancelled')
        met.bound = timeBound
        break
      }
      place(path, entry)
    }
    await options.seams?.beforeProbes?.()
    if (cancelled()) return end('cancelled', 'cancelled')
    phase('entries')

    // 3. Paths of the capture this one is compared with that are no longer listed: gone, or still there.
    const gone: string[] = []
    const left: string[] = []
    if (basePaths && met.bound === null) {
      for (const path of basePaths) {
        if (performance.now() - slice > 4) {
          await yieldNow()
          slice = performance.now()
          if (cancelled()) return end('cancelled', 'cancelled')
          if (slicedOver()) {
            met.bound = timeBound
            break
          }
        }
        if (paths.has(path)) continue
        // Below a repository of its own nothing is looked at: what was there is no longer covered, and that is all BMN can say.
        if (boundaryOf(folderOf(path)) !== null) {
          left.push(path)
          continue
        }
        // Looking only: a path that still names something was not removed, whatever it now is.
        if (lstatSync(prefix + path, { throwIfNoEntry: false }) === undefined) gone.push(path)
        else left.push(path)
      }
    }
    phase('probes')

    const head = await runTurnGit(git(gitSignal()), root, 'head')
    if (cancelled()) return end('cancelled', 'cancelled')
    if (!sameFolder(root, { dev: established.device, ino: established.inode })) return end('unavailable', 'the root changed while it was captured')
    if (met.bound === null && (head.stopped || slicedOver())) met.bound = timeBound
    phase('head')
    await options.seams?.beforeLists?.()
    if (cancelled()) return end('cancelled', 'cancelled')

    // 4. One list per folder, the deepest first, each named by the SHA-256 of its text. A folder in which
    // every entry is as it was, with as many entries as before, keeps the list it had. A capture that
    // met the limit of entries, a cut listing or a full store keeps nothing: it could never be compared.
    // A capture whose time passed keeps the files it read and no list of them (`treeless`): the lists are
    // sliced work, and no sliced work goes on past the capture's time. Its cache names those files, so the
    // next capture has that much less to read.
    let hollow = listingCut || met.bound === STORE_FULL || met.bound === entriesBound
    let treeless = met.bound === timeBound
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
      for (const relative of treeless ? [] : [...folders.keys()].sort((one, other) => other.length - one.length)) {
        if (performance.now() - slice > 4) {
          await yieldNow()
          slice = performance.now()
          if (cancelled()) return end('cancelled', 'cancelled')
          if (slicedOver()) {
            met.bound = timeBound
            treeless = true
            break
          }
        }
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
          if (!cache?.trees.has(hash) && !stagedSizes.trees.has(hash) && !store.hasObject('trees', hash) && !stage('trees', hash, text)) {
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
    const nothingKept = (): void => {
      hollow = true
      Object.assign(counts, { entries: count, files: 0, links: 0, submodules: 0, tooLarge: 0, notRead: 0 })
      drop()
      bytesStored = 0
    }
    if (!hollow) {
      const kinds = { f: 'files', l: 'links', s: 'submodules', x: 'tooLarge', u: 'notRead' } as const
      for (const rows of folders.values()) for (const entry of rows.values()) if (entry !== null) counts[kinds[entry[0]]] += 1
      counts.entries = counts.files + counts.links + counts.submodules + counts.tooLarge + counts.notRead
    } else nothingKept()
    phase('lists')
    await options.seams?.beforeRecord?.()
    if (cancelled()) return end('cancelled', 'cancelled')

    const headEnd = head.stdout.trim()
    const endedAt = Date.now()
    // A capture without lists keeps no list it staged before its time passed: they stay in `staging/` and go with it.
    const keeps = (): number => (hollow ? 0 : treeless ? [...stagedSizes.blobs.values()].reduce((sum, size) => sum + size, 0) : bytesStored)
    const describe = (stored: number): TurnCaptureRecord => ({
      format: TURN_STORE_FORMAT, id, root, rootDevice: established.device, rootInode: established.inode, objectFormat: established.objectFormat,
      startedAt, endedAt, headStart: established.head, headEnd: head.code === 0 && COMMIT.test(headEnd) ? headEnd : null,
      state: met.bound === null ? 'whole' : 'incomplete', bound: met.bound, tree: hollow || treeless ? null : (hashes.get('') ?? null), counts, bytesRead,
      bytesStored: stored,
      base: met.bound === null ? (base?.id ?? null) : null, gone: met.bound === null ? gone : [], left: met.bound === null ? left : [],
      entered: met.bound === null ? entered : []
    })
    const cached = (): TurnCache => ({ capture: id, startedAt, files, paths, trees: treeless ? new Set() : trees, folders: treeless ? new Map() : lists })
    if (met.bound === null && slicedOver()) {
      met.bound = timeBound
      treeless = true
    }
    // A record can still become "incomplete: <time>" at the last look at the clock, and a few bytes longer: a whole
    // one is written as long as that from the start, so what was counted for it is what it takes on disk.
    const recordText = (made: TurnCaptureRecord): string => {
      const text = JSON.stringify(made)
      if (made.bound !== null) return text
      return text.padEnd(Buffer.byteLength(JSON.stringify({ ...made, state: 'incomplete', bound: timeBound })) - (Buffer.byteLength(text) - text.length))
    }
    let record = describe(keeps())
    let cacheText = hollow ? null : store.cacheText(cached())
    const beside = (): number => Buffer.byteLength(recordText(record)) + (cacheText === null ? 0 : Buffer.byteLength(cacheText))
    // What publishing has on disk at its most: every byte it staged, kept or not, because the lists of a capture
    // that keeps none stay in `staging/` until after the record; the record itself; the whole new cache, because
    // the old one is still there while the new one is written; and what it dropped, until its removal is done.
    // All of it counts against the room, so the store's bound is a bound on what is on disk.
    const most = (): number => bytesStored + beside() + droppedBytes
    if (!hollow && most() > room) {
      met.bound = STORE_FULL
      nothingKept()
      cacheText = null
      record = describe(0)
    }
    // A store with no room even for the few bytes of this record gets nothing: the caller still has the record.
    const written = most() <= room
    const adds = written ? bytesStored + beside() : 0
    phase('record')
    const stagedTook = performance.now() - startedClock
    let settled = false
    return {
      state: record.state,
      record,
      tookMs: stagedTook,
      phases,
      adds,
      async publish(stop?: () => boolean): Promise<PublishedCapture | null> {
        if (settled) throw new Error('this capture was already published or discarded')
        settled = true
        // The capture's clock goes on from where staging left it; a wait between the two is nobody's work.
        const began = performance.now()
        const spent = (): number => stagedTook + (performance.now() - began)
        const moved: string[] = []
        let movedBytes = 0
        let real = false
        // Exactly what was moved in is taken out again, and the folder in `staging/` stays until that is done:
        // should BMN end meanwhile, the next start finds it and removes every byte no published capture needs.
        const undo = (): void => {
          store.dropWritten(id)
          const gone = store.undoMoves(id, moved)
          // Until all of it is out, no capture of this store reads anything: see `takingOut`.
          const key = store.directory
          const done = Promise.all([takingOut.get(key), gone]).then(() => undefined, () => undefined)
          takingOut.set(key, done)
          void done.then(() => {
            if (takingOut.get(key) === done) takingOut.delete(key)
          })
          options.dropped?.(inStaging + movedBytes, gone)
          staged = false
          inStaging = 0
        }
        try {
          // Stopped before it began, or its caller's time already over: nothing of it is kept.
          if (stop?.()) {
            undo()
            return null
          }
          if (!written) return { record, added: 0, tookMs: spent() }
          privateFolder(join(store.directory, 'captures'))
          // 1. The staged files and lists are moved in, a few at a time. Until the record appears nothing names them.
          const landed = new Set<string>()
          let cut = false
          const beforeMove = options.seams?.beforeMove
          if (staged) {
            const made = new Set<string>()
            let turn = performance.now()
            moving: for (const kind of treeless ? (['blobs'] as const) : (['blobs', 'trees'] as const)) {
              for (const [hash, size] of stagedSizes[kind]) {
                if (beforeMove) await beforeMove(moved.length)
                if (performance.now() - turn > 4) {
                  await yieldNow()
                  turn = performance.now()
                }
                if (stop?.()) {
                  undo()
                  return null
                }
                if (spent() > limits.captureMs - tail) {
                  cut = true
                  break moving
                }
                const target = store.objectPath(kind, hash)
                // Already in the store: nothing is moved and nothing is new. Its staged copy goes with the folder.
                if (!existsSync(target)) {
                  if (!made.has(dirname(target))) {
                    privateFolder(dirname(target))
                    made.add(dirname(target))
                  }
                  renameSync(join(staging, kind, hash), target)
                  moved.push(target)
                  movedBytes += size
                  inStaging -= size
                }
                if (kind === 'blobs') landed.add(hash)
              }
            }
          }
          if (cut) {
            // The capture's time passed while its files were moved in: what is in the store stays and is named
            // by the cache, the rest is dropped, and without its lists the capture is not whole.
            if (met.bound === null) met.bound = timeBound
            treeless = true
            for (const [path, seen] of files) if (stagedSizes.blobs.has(seen[6]) && !landed.has(seen[6])) files.delete(path)
            cacheText = store.cacheText(cached())
          }
          // 2. The cache is written beside its place; it takes that place once the record is there.
          const cacheBefore = cacheText === null ? 0 : store.cacheBytes()
          if (cacheText !== null) store.writeCache(cacheText)
          record = describe(movedBytes)
          let text = recordText(record)
          await options.seams?.beforeLastLook?.()
          // Writing the cache held the event loop: a stop that was sent meanwhile is heard in its next turn, before the record appears.
          if (stop) await yieldNow()
          if (stop?.()) {
            undo()
            return null
          }
          // 3. The last look at the clock, and then the one step that makes the capture real: its record appears under `captures/`.
          if (met.bound === null && spent() > limits.captureMs) {
            met.bound = timeBound
            record = describe(movedBytes)
            text = recordText(record)
          }
          const recordPath = store.capturePath(id)
          writeFileSync(`${recordPath}.new`, text, { mode: 0o600 })
          renameSync(`${recordPath}.new`, recordPath)
          real = true
          // From here the capture is real whatever fails: nothing is thrown, and the caller is told to count the store from the disk.
          let cacheAdded = 0
          let recount = false
          try {
            // What is left in `staging/` (a list of a capture that keeps none, a copy of what the store had) goes now, not before.
            if (staged) {
              if (inStaging > 0) drop()
              else rmSync(staging, { recursive: true, force: true })
              staged = false
            }
            if (cacheText !== null) {
              if (store.adoptCache(cached())) cacheAdded = Buffer.byteLength(cacheText) - cacheBefore
              else recount = true
            }
          } catch {
            recount = true
          }
          return { record, added: movedBytes + Buffer.byteLength(text) + cacheAdded, tookMs: spent(), ...(recount ? { recount } : {}) }
        } catch (error) {
          // Before the record appeared nothing may stay of it; once it is there the capture is real, whatever failed after.
          if (!real) undo()
          throw error
        } finally {
          release()
        }
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

/**
 * The commit a submodule's or nested repository's own HEAD names, as Git reports it; null when it has none.
 * `stopped`: Git was stopped before it answered, by a cancel or by the capture's time.
 */
async function nestedHead(git: TurnGitContext, confined: Confined, root: string, path: string): Promise<{ commit: string | null; stopped: boolean }> {
  // Its folder is opened under the root like any other; Git is started in that very folder and may not look above it.
  const fd = confined.folder(path)
  if (!lstatSync(`/proc/self/fd/${fd}/.git`, { throwIfNoEntry: false })) return { commit: null, stopped: false }
  const real = readlinkSync(`/proc/self/fd/${fd}`)
  if (!within(real, root) || real === root) return { commit: null, stopped: false }
  const answer = await runTurnGit(git, real, 'nested')
  const commit = answer.stdout.trim()
  return { commit: answer.code === 0 && COMMIT.test(commit) ? commit : null, stopped: answer.stopped }
}
