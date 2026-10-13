// MODULE: turn-changes-store.ts - BMN's own store of captured work trees: bytes by SHA-256 and one small list per folder, under the data root
//
// `<data root>/turn-changes/<session>/<work tree>/` holds `captures/<id>.json` (one published capture
// each), `objects/blobs` and `objects/trees` (bytes named by their SHA-256), `staging/<id>/` (a capture
// not yet published), `trash/<id>/` (a cancelled capture on its way out) and `cache.json` (what the
// newest published capture saw of each file, so that only new bytes are read). It is not a Git
// repository and borrows nothing from one, so a kept capture reads whole after the owner's repository
// is moved, deleted or garbage-collected (R69-NFR3).
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
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
  private stored: number | null = null
  private removing: Promise<void> = Promise.resolve()

  constructor(dataRoot: string, session: string, root: string) {
    if (!SEGMENT.test(session)) throw new Error('a session id that cannot name a folder')
    this.root = root
    this.directory = join(dataRoot, TURN_STORE_FOLDER, session, workTreeKey(root))
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
    this.stored = null
    try {
      const saved = JSON.parse(readFileSync(join(this.directory, 'cache.json'), 'utf8')) as {
        format: number; capture: string; startedAt: number; stored: number
        files: Array<[string, SeenFile]>; paths: string[]; trees: string[]; folders: Array<[string, [string, number]]>
      }
      if (saved.format === TURN_STORE_FORMAT && this.record(saved.capture)) {
        this.cache = {
          capture: saved.capture, startedAt: saved.startedAt, files: new Map(saved.files), paths: new Set(saved.paths),
          trees: new Set(saved.trees), folders: new Map(saved.folders)
        }
        this.stored = saved.stored
      }
    } catch {
      // No cache: every file is read.
    }
    return this.cache
  }

  saveCache(cache: TurnCache, stored: number): void {
    this.cache = cache
    this.stored = stored
    const path = join(this.directory, 'cache.json')
    writeFileSync(`${path}.new`, JSON.stringify({
      format: TURN_STORE_FORMAT, capture: cache.capture, startedAt: cache.startedAt, stored,
      files: [...cache.files], paths: [...cache.paths], trees: [...cache.trees], folders: [...cache.folders]
    }), { mode: 0o600 })
    renameSync(`${path}.new`, path)
  }

  /** Forget what is held in memory: something under the store was removed. */
  forget(): void {
    this.cache = null
    this.stored = null
  }

  /** Bytes of files and lists kept so far; counted from the disk when nobody wrote the number down. */
  storedBytes(): number {
    if (this.stored === null) this.stored = this.exists() ? this.size('objects') : 0
    return this.stored
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
