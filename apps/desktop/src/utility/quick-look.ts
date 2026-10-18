// MODULE: quick-look.ts - Quick look's root, one-folder listing and bounded file read; nothing indexed, watched or stored
import { homedir } from 'node:os'
import { opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import {
  QUICK_LOOK_DIMMED_NAMES,
  QUICK_LOOK_JOIN_DEPTH,
  QUICK_LOOK_LIST_MAX_ENTRIES,
  QUICK_LOOK_READ_MAX_BYTES,
  quickLookInside,
  type QuickLookEntry,
  type QuickLookEntryKind,
  type QuickLookIdentityResult,
  type QuickLookListResult,
  type QuickLookReadResult,
  type QuickLookRootResult
} from '@bmn/protocol'
import { readLocalTextFile, type FileReferenceReaderOptions } from './file-reference-reader'
import { repositoryGit } from './repository-git'

const DIMMED = new Set(QUICK_LOOK_DIMMED_NAMES)
/** At most this many names are held while a folder is read; past it they are cut to the first rows in the tree's order. */
const LIST_READ_LIMIT = 200_000
/** The walk lets the terminals' process breathe this often. */
const YIELD_EVERY = 256

export interface QuickLookOptions {
  home?: string | null
  /** Test seam for the work tree's root; Git otherwise. */
  gitRoot?: (folder: string) => Promise<string | null>
}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function gitTopLevel(folder: string): Promise<string | null> {
  try {
    const output = (await repositoryGit(folder, ['rev-parse', '--show-toplevel'], 16 * 1024)).trim()
    return output && isAbsolute(output) ? output : null
  } catch {
    return null
  }
}

/** Where Quick look starts for a source: a running session's launch folder, a stopped one's stored folder, or a workspace's folder. */
export function quickLookSourceFolder(source: { kind: 'session'; liveLaunchDirectory: string | null; storedCwd: string } | { kind: 'workspace'; folder: string | null }): string | null {
  return source.kind === 'session' ? source.liveLaunchDirectory ?? source.storedCwd : source.folder
}

/**
 * The root for one opening: the given folder when it is a readable folder, and the Git work tree's root above it
 * when there is one. Nothing moves the root by itself; the sheet offers the Git root as a plate.
 */
export async function quickLookRoot(folder: string | null, options: QuickLookOptions = {}): Promise<QuickLookRootResult> {
  const home = options.home === undefined ? homedir() : options.home
  if (!folder || !isAbsolute(folder)) return { status: 'unavailable', folder, home }
  const sessionFolder = normalize(folder)
  const stats = await stat(sessionFolder).catch(() => null)
  if (!stats?.isDirectory()) return { status: 'unavailable', folder: sessionFolder, home }
  const reading = await opendir(sessionFolder).then((handle) => handle.close().then(() => true), () => false)
  if (!reading) return { status: 'unavailable', folder: sessionFolder, home }
  const top = await (options.gitRoot ?? gitTopLevel)(sessionFolder)
  let gitRoot: string | null = null
  if (top) {
    // Git names the real path; the session folder may reach it through a link.
    const real = await realpath(sessionFolder).catch(() => sessionFolder)
    if (real !== top && quickLookInside(top, real)) gitRoot = top
  }
  return { status: 'ready', sessionFolder, gitRoot, home }
}

function kindOf(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): QuickLookEntryKind {
  if (entry.isSymbolicLink()) return 'link'
  return entry.isDirectory() ? 'folder' : 'file'
}

/** Folders first, then by name, as the tree shows them. */
function compareEntries(left: { name: string; kind: QuickLookEntryKind }, right: { name: string; kind: QuickLookEntryKind }): number {
  const leftFolder = left.kind === 'folder' ? 0 : 1
  const rightFolder = right.kind === 'folder' ? 0 : 1
  if (leftFolder !== rightFolder) return leftFolder - rightFolder
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/** The one folder `folder` holds when it holds nothing else; links are not followed. */
async function onlyFolder(folder: string): Promise<string | null> {
  let handle
  try {
    handle = await opendir(folder)
  } catch {
    return null
  }
  try {
    const first = await handle.read()
    if (!first || !first.isDirectory() || first.isSymbolicLink() || DIMMED.has(first.name)) return null
    return (await handle.read()) ? null : first.name
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Lists one folder: name and kind, folders first and then by name, at most `maxEntries` and a count of the rest.
 * Hidden entries are listed; links are marked and never entered; the generated names are dimmed, not hidden. A
 * folder whose only entry is a folder carries that chain, so the tree can show `apps/desktop` as one row.
 */
export async function listQuickLookFolder(folder: string, limits: { maxEntries?: number; readLimit?: number } = {}): Promise<QuickLookListResult> {
  if (!isAbsolute(folder)) return { status: 'unavailable', folder, message: 'This folder is unavailable' }
  const path = normalize(folder)
  // The root itself may be reached through a link (a session started in one); links below it are never entered.
  const stats = await stat(path).catch(() => null)
  if (!stats?.isDirectory()) return { status: 'unavailable', folder: path, message: 'This folder is unavailable' }
  const maxEntries = limits.maxEntries ?? QUICK_LOOK_LIST_MAX_ENTRIES
  const readLimit = Math.max(limits.readLimit ?? LIST_READ_LIMIT, maxEntries + 1)
  const found: Array<{ name: string; kind: QuickLookEntryKind }> = []
  let total = 0
  let handle
  try {
    handle = await opendir(path)
  } catch {
    return { status: 'unavailable', folder: path, message: 'This folder is unavailable' }
  }
  try {
    for await (const entry of handle) {
      total += 1
      found.push({ name: entry.name, kind: kindOf(entry) })
      // A huge folder keeps only the first names in the tree's order, so memory stays bounded and the rows shown are
      // the first of the whole folder, not of the part read first.
      if (found.length >= readLimit) {
        found.sort(compareEntries)
        found.length = maxEntries
      }
      if (total % YIELD_EVERY === 0) await pause()
    }
  } catch {
    // A folder removed while it is read lists what was read before; its rows open as missing.
  }
  found.sort(compareEntries)
  const shown = found.slice(0, maxEntries)
  const entries: QuickLookEntry[] = []
  for (const [index, entry] of shown.entries()) {
    const dimmed = DIMMED.has(entry.name)
    const joined: string[] = []
    if (entry.kind === 'folder' && !dimmed) {
      let below = join(path, entry.name)
      while (joined.length < QUICK_LOOK_JOIN_DEPTH) {
        const next = await onlyFolder(below)
        if (!next) break
        joined.push(next)
        below = join(below, next)
      }
    }
    entries.push({ name: entry.name, kind: entry.kind, dimmed, joined })
    if ((index + 1) % YIELD_EVERY === 0) await pause()
  }
  return { status: 'ready', folder: path, entries, more: total - entries.length }
}

/**
 * Reads one file for the sheet with the reference reader's opens and checks at Quick look's cap. A file that is
 * not shown as text keeps its size and modified time, so the sheet can say what it is.
 */
export async function readQuickLookFile(path: string, options: FileReferenceReaderOptions = {}): Promise<QuickLookReadResult> {
  if (!isAbsolute(path)) {
    return { status: 'unavailable', path, canonicalPath: null, reason: 'missing', message: 'No file exists at this path.', facts: null }
  }
  const requested = normalize(path)
  const read = await readLocalTextFile(requested, { maxBytes: QUICK_LOOK_READ_MAX_BYTES, ...options })
  if (read.status === 'unavailable') {
    return { status: 'unavailable', path: requested, canonicalPath: read.canonicalPath, reason: read.reason, message: read.message, facts: read.facts }
  }
  return {
    status: 'ready',
    path: requested,
    canonicalPath: read.canonicalPath,
    content: read.content,
    byteLength: read.byteLength,
    lineCount: read.lineCount,
    modifiedAt: read.modifiedAt,
    identity: read.identity
  }
}

/**
 * The shown file's identity now, through its links as the read follows them: one `stat`, never a watcher. A path
 * with nothing readable at it, or no longer a regular file, is `gone`.
 */
export async function quickLookIdentity(path: string): Promise<QuickLookIdentityResult> {
  if (!isAbsolute(path)) return { status: 'gone' }
  const stats = await stat(normalize(path), { bigint: true }).catch(() => null)
  if (!stats?.isFile()) return { status: 'gone' }
  return { status: 'ready', identity: { byteLength: Number(stats.size), modifiedNs: stats.mtimeNs.toString(), inode: `${stats.dev}:${stats.ino}` } }
}
