// MODULE: turn-changes-store.ts - BMN's own store of captured work trees: bytes by SHA-256 and one small list per folder, under the data root
//
// `<data root>/turn-changes/<session>/<work tree>/` holds `captures/<id>.json` (one published capture
// each), `objects/blobs` and `objects/trees` (bytes named by their SHA-256), `staging/<id>/` (a capture
// not yet published), `trash/<id>/` (a cancelled capture on its way out) and `cache.json` (what the
// newest published capture saw of each file, so that only new bytes are read). It is not a Git
// repository and borrows nothing from one, so a kept capture reads whole after the owner's repository
// is moved, deleted or garbage-collected (R69-NFR3).
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export const TURN_STORE_FORMAT = 1
export const TURN_STORE_FOLDER = 'turn-changes'

/** A file's bytes by hash, its size and whether it may be executed. */
export type FileEntry = ['f', hash: string, size: number, executable: 0 | 1]
/** A link, kept as its text. */
export type LinkEntry = ['l', text: string]
/** A submodule or nested repository: the commit Git reports for it, never walked. */
export type SubmoduleEntry = ['s', commit: string | null, nested: 0 | 1]
/** A file over the size limit: "too large, not read". */
export type TooLargeEntry = ['x', size: number, modifiedMs: number, executable: 0 | 1]
/** An entry BMN could not read, with the fixed reason. */
export type NotReadEntry = ['u', why: NotReadReason]
export type TurnEntry = FileEntry | LinkEntry | SubmoduleEntry | TooLargeEntry | NotReadEntry
export type NotReadReason = 'not read' | 'changed while read' | 'not a regular file' | 'its name is not valid UTF-8'

/** One row of a folder's stored list: a name with its entry, or with the hash of the folder below. */
export type TreeRow =
  | [string, ...FileEntry]
  | [string, ...LinkEntry]
  | [string, ...SubmoduleEntry]
  | [string, ...TooLargeEntry]
  | [string, ...NotReadEntry]
  | [string, 'd', string]

/** What a file looked like when it was last read: size, times, file number, device, when it was read, its hash. */
export type SeenFile = [size: number, modifiedMs: number, changedMs: number, inode: number, device: number, readAt: number, hash: string]

export interface TurnCaptureCounts {
  entries: number
  files: number
  links: number
  submodules: number
  tooLarge: number
  notRead: number
}

/** A capture's record. It names the root and commits, never a file. */
export interface TurnCaptureRecord {
  format: number
  id: string
  root: string
  rootDevice: number
  rootInode: number
  objectFormat: string
  startedAt: number
  endedAt: number
  headStart: string | null
  headEnd: string | null
  state: 'whole' | 'incomplete'
  /** The limit an incomplete capture met, in the words shown to the owner. */
  bound: string | null
  tree: string | null
  counts: TurnCaptureCounts
  bytesRead: number
  bytesStored: number
  /** The capture this one was taken to be compared with; `gone`, `left` and `entered` speak of its paths. */
  base: string | null
  gone: string[]
  left: string[]
  entered: string[]
}

export interface TurnCache {
  capture: string
  startedAt: number
  files: Map<string, SeenFile>
  paths: Set<string>
  trees: Set<string>
  folders: Map<string, [hash: string, rows: number]>
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const WORK_TREE_KEY = /^[0-9a-f]{24}$/

/** Whether a session id or a capture id can name a folder or a file of the store, and nothing above it. */
export const isStoreSegment = (name: string): boolean => SEGMENT.test(name)

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
export const privateFolder = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

/** The folder name of a work tree's store: a hash of the root, so no path of his appears under the data root. */
export const workTreeKey = (root: string): string => sha256(root).slice(0, 24)

export class TurnStore {
  readonly directory: string
  readonly root: string
  private cache: TurnCache | null = null
  private removing: Promise<void> = Promise.resolve()

  /** `key` names the store's folder directly, for a store found on disk whose root is not known. */
  constructor(dataRoot: string, session: string, root: string, key: string = workTreeKey(root)) {
    if (!SEGMENT.test(session)) throw new Error('a session id that cannot name a folder')
    if (!WORK_TREE_KEY.test(key)) throw new Error('a work tree key that cannot name a folder')
    this.root = root
    this.directory = join(dataRoot, TURN_STORE_FOLDER, session, key)
  }

  exists(): boolean {
    return existsSync(this.directory)
  }

  objectPath(kind: 'blobs' | 'trees', hash: string): string {
    return join(this.directory, 'objects', kind, hash.slice(0, 2), hash.slice(2))
  }

  hasObject(kind: 'blobs' | 'trees', hash: string): boolean {
    return existsSync(this.objectPath(kind, hash))
  }

  capturePath(id: string): string {
    return join(this.directory, 'captures', `${id}.json`)
  }

  stagingPath(id: string): string {
    return join(this.directory, 'staging', id)
  }

  /** A published capture's record, or null when it is gone or cannot be read. */
  record(id: string): TurnCaptureRecord | null {
    if (!SEGMENT.test(id)) return null
    try {
      const record = JSON.parse(readFileSync(this.capturePath(id), 'utf8')) as TurnCaptureRecord
      return record.format === TURN_STORE_FORMAT && record.id === id ? record : null
    } catch {
      return null
    }
  }

  /** When a published capture's scan ended, as its own record says; the time its file was written when the record cannot be read. */
  captureTime(id: string): number {
    const record = this.record(id)
    if (record) return record.endedAt
    try {
      return lstatSync(this.capturePath(id)).mtimeMs
    } catch {
      return 0
    }
  }

  captures(): string[] {
    try {
      return readdirSync(join(this.directory, 'captures')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    } catch {
      return []
    }
  }

  tree(hash: string): Map<string, TreeRow> {
    const rows = JSON.parse(readFileSync(this.objectPath('trees', hash), 'utf8')) as TreeRow[]
    return new Map(rows.map((row) => [row[0], row]))
  }

  blob(hash: string, size: number): Buffer {
    const bytes = readFileSync(this.objectPath('blobs', hash))
    if (bytes.length !== size) throw new Error('a stored file has the wrong size')
    return bytes
  }

  /** What the newest published capture saw; dropped when that capture is no longer kept. */
  loadCache(): TurnCache | null {
    if (this.cache && this.record(this.cache.capture)) return this.cache
    this.cache = null
    try {
      const saved = JSON.parse(readFileSync(join(this.directory, 'cache.json'), 'utf8')) as {
        format: number; capture: string; startedAt: number
        files: Array<[string, SeenFile]>; paths: string[]; trees: string[]; folders: Array<[string, [string, number]]>
      }
      if (saved.format === TURN_STORE_FORMAT && this.record(saved.capture)) {
        this.cache = {
          capture: saved.capture, startedAt: saved.startedAt, files: new Map(saved.files), paths: new Set(saved.paths),
          trees: new Set(saved.trees), folders: new Map(saved.folders)
        }
      }
    } catch {
      // No cache: every file is read.
    }
    return this.cache
  }

  /** The cache as it is written to disk. Made before a capture is published, so that its size can be counted first. */
  cacheText(cache: TurnCache): string {
    return JSON.stringify({
      format: TURN_STORE_FORMAT, capture: cache.capture, startedAt: cache.startedAt,
      files: [...cache.files], paths: [...cache.paths], trees: [...cache.trees], folders: [...cache.folders]
    })
  }

  /** How many bytes the cache on disk has now; 0 when there is none. */
  cacheBytes(): number {
    return lstatSync(join(this.directory, 'cache.json'), { throwIfNoEntry: false })?.size ?? 0
  }

  saveCache(cache: TurnCache, text: string = this.cacheText(cache)): void {
    this.cache = cache
    const path = join(this.directory, 'cache.json')
    writeFileSync(`${path}.new`, text, { mode: 0o600 })
    renameSync(`${path}.new`, path)
  }

  /** Forget what is held in memory: something under the store was removed. */
  forget(): void {
    this.cache = null
  }

  /**
   * Bytes on disk of everything this store keeps: files, lists, the records of its captures and its cache.
   * What is staged and what is on its way out is not kept; whoever stages or discards counts that.
   */
  keptBytes(): number {
    return this.exists() ? this.size('objects') + this.size('captures') + this.cacheBytes() : 0
  }

  /**
   * A capture that will not be published. One rename takes it out of `staging/` at once; its files
   * are then unlinked without holding anything up (20,000 small files take a moment to unlink).
   */
  discardStaging(id: string): void {
    const from = this.stagingPath(id)
    if (!existsSync(from)) return
    privateFolder(join(this.directory, 'trash'))
    const to = join(this.directory, 'trash', id)
    renameSync(from, to)
    this.removing = this.removing.then(() => rm(to, { recursive: true, force: true })).catch(() => undefined)
  }

  /**
   * Removes published captures and every stored byte no remaining capture needs. With no capture left
   * the whole folder goes. Nothing may be staged for this store meanwhile: the caller sees to that.
   * Returns how many captures are still kept. Throws when something could not be removed.
   */
  removeCaptures(ids: readonly string[]): number {
    for (const id of ids) if (SEGMENT.test(id)) rmSync(this.capturePath(id), { force: true })
    this.forget()
    const kept = this.captures()
    if (kept.length === 0) {
      rmSync(this.directory, { recursive: true, force: true })
      return 0
    }
    // What the kept captures need: every folder list and every file's bytes reachable from their trees.
    const trees = new Set<string>()
    const blobs = new Set<string>()
    const walk = (hash: string): void => {
      if (trees.has(hash)) return
      trees.add(hash)
      for (const row of this.tree(hash).values()) {
        if (row[1] === 'd') walk(row[2])
        else if (row[1] === 'f') blobs.add(row[2])
      }
    }
    try {
      for (const id of kept) {
        const record = this.record(id)
        if (!record) return kept.length
        if (record.tree) walk(record.tree)
      }
    } catch {
      // A kept capture or one of its lists cannot be read: what it needs is not known, so no byte is taken from under it.
      return kept.length
    }
    for (const [kind, needed] of [['trees', trees], ['blobs', blobs]] as const) {
      const base = join(this.directory, 'objects', kind)
      for (const prefix of existsSync(base) ? readdirSync(base) : []) {
        for (const rest of readdirSync(join(base, prefix))) {
          if (!needed.has(`${prefix}${rest}`)) unlinkSync(join(base, prefix, rest))
        }
      }
    }
    // What the newest capture saw is of no use once that capture is gone: the next one reads every file.
    const cachePath = join(this.directory, 'cache.json')
    try {
      const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as { capture?: unknown }
      if (typeof saved.capture !== 'string' || !kept.includes(saved.capture)) rmSync(cachePath, { force: true })
    } catch {
      rmSync(cachePath, { force: true })
    }
    return kept.length
  }

  /**
   * What a crash left behind: captures that were never published, and cancelled ones on their way out. Only
   * when none is being taken. A folder still in `staging/` may be a publication that was interrupted after
   * some of its files and lists were moved in and before its record appeared: no record names those bytes,
   * so every byte no published capture needs is removed with it, and a store that has no capture goes whole.
   */
  clearLeftovers(): void {
    let interrupted = false
    try {
      interrupted = readdirSync(join(this.directory, 'staging')).length > 0
    } catch {
      // No staging folder: nothing was being published.
    }
    for (const part of ['staging', 'trash']) rmSync(join(this.directory, part), { recursive: true, force: true })
    if (interrupted) this.removeCaptures([])
  }

  /** Resolves when every discarded capture's bytes are gone. */
  settled(): Promise<void> {
    return this.removing
  }

  /** Bytes on disk under the store (or one folder of it), every file once. */
  size(part = ''): number {
    let total = 0
    const walk = (folder: string): void => {
      let names
      try {
        names = readdirSync(folder, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of names) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) walk(path)
        else total += lstatSync(path).size
      }
    }
    walk(join(this.directory, part))
    return total
  }
}

/** Every store under the data root, as its two folder names; a name that is not one of BMN's own is left alone. */
export function listTurnStores(dataRoot: string): Array<{ session: string; key: string }> {
  const found: Array<{ session: string; key: string }> = []
  const base = join(dataRoot, TURN_STORE_FOLDER)
  const folders = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }
  for (const session of folders(base)) {
    if (!SEGMENT.test(session)) continue
    for (const key of folders(join(base, session))) if (WORK_TREE_KEY.test(key)) found.push({ session, key })
  }
  return found
}
