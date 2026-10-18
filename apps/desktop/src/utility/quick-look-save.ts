// MODULE: quick-look-save.ts - Quick look's one writer: may this file be edited, and Save as compare, stage, flush, rename, read back (Story 68.1, R68-NFR1, R68-NFR2)
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import {
  QUICK_LOOK_EDIT_MAX_BYTES,
  quickLookEditableName,
  quickLookInside,
  type QuickLookEditState,
  type QuickLookSaveParams,
  type QuickLookSaveResult
} from '@bmn/protocol'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

export interface QuickLookSaveSeams {
  /** Runs with the new text staged, before the last check and the rename; tests change the target here. */
  beforeRename?: () => Promise<void> | void
  /** The user the file must belong to; the process's own otherwise. */
  uid?: number
}

export function quickLookDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null
}

/** A failure in words, never with the file's text: an errno names a condition, not content. */
function failureWords(error: unknown): string {
  switch (errorCode(error)) {
    case 'EACCES':
    case 'EPERM': return 'permission denied'
    case 'ENOSPC': return 'no space left on the disk'
    case 'EDQUOT': return 'the disk quota is full'
    case 'EROFS': return 'the file system is read-only'
    case 'ENOENT': return 'the file or its folder is gone'
    case 'EIO': return 'the disk reported an error'
    case 'BMN_GROUP': return "BMN cannot give the new file this file's group"
    default: return 'the file system refused the write'
  }
}

interface Editable {
  status: 'editable'
  /** The entry Save renames over: the file's real folder and its name. */
  target: string
  folder: string
  mode: number
  device: number
  inode: number
  gid: number
}

type EditCheck = Editable | { status: 'read-only'; message: string } | { status: 'not-editable' }

/**
 * Every condition of R68-NFR1 on the entry at `path` now, short of its bytes: a name on the list, inside the root's
 * real folder once the folders above it are resolved, a regular file and not a link, one hard link, the user's own,
 * at most 256 KiB, and writable with a writable folder.
 */
async function editCheck(path: string, root: string, uid: number): Promise<EditCheck> {
  if (!isAbsolute(path) || !isAbsolute(root) || !quickLookEditableName(basename(path))) return { status: 'not-editable' }
  const readOnly = (why: string): EditCheck => ({ status: 'read-only', message: `Read-only · ${why}` })
  let folder: string
  let realRoot: string
  try {
    folder = await realpath(dirname(normalize(path)))
    realRoot = await realpath(normalize(root))
  } catch {
    return readOnly('the file or its folder is gone')
  }
  const target = join(folder, basename(path))
  if (!quickLookInside(realRoot, target)) return readOnly('outside the root')
  const stats = await lstat(target).catch(() => null)
  if (!stats) return readOnly('the file is gone')
  if (stats.isSymbolicLink()) return readOnly('a link')
  if (!stats.isFile()) return readOnly('not a regular file')
  if (stats.nlink > 1) return readOnly('a second hard link')
  if (stats.uid !== uid) return readOnly("another user's file")
  if (stats.size > QUICK_LOOK_EDIT_MAX_BYTES) return readOnly('over 256 KB')
  const writable = await access(target, constants.W_OK).then(() => true, () => false)
  const folderWritable = writable && await access(folder, constants.W_OK | constants.X_OK).then(() => true, () => false)
  if (!writable || !folderWritable) return readOnly('not writable')
  return { status: 'editable', target, folder, mode: stats.mode & 0o7777, device: stats.dev, inode: stats.ino, gid: stats.gid }
}

/** Whether the file at `path` may be edited from the sheet whose root is `root`; null for a name that is never editable. */
export async function quickLookEditState(path: string, root: string | null, seams: Pick<QuickLookSaveSeams, 'uid'> = {}): Promise<QuickLookEditState | null> {
  if (!root) return null
  const check = await editCheck(path, root, seams.uid ?? process.getuid?.() ?? -1)
  if (check.status === 'not-editable') return null
  if (check.status === 'read-only') return { status: 'read-only', message: check.message }
  return { status: 'editable', mode: check.mode }
}

async function readAll(handle: FileHandle, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) return Buffer.concat(chunks, total)
    total += bytesRead
    if (total > cap) return null
    chunks.push(chunk.subarray(0, bytesRead))
  }
}

/** The bytes of the regular file at `target`, opened without following a link, with the handle's identity. */
async function readTarget(target: string): Promise<{ bytes: Buffer | null; device: number; inode: number; nlink: number } | null> {
  let handle: FileHandle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return null
    return { bytes: await readAll(handle, QUICK_LOOK_EDIT_MAX_BYTES), device: stats.dev, inode: stats.ino, nlink: stats.nlink }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** A JS string holds a lone surrogate when it is not valid UTF-8 text. */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
}

/**
 * Saves the sheet's text to the file it read (R68-NFR2): every condition of R68-NFR1 checked again; the bytes on
 * disk compared with the digest of the bytes read; the new text staged beside the target in a file created private,
 * given the target's mode and group and flushed; checked again with it staged; renamed over the target; the folder
 * flushed; read back. No backup is made and no second file is left. A write by another program between the last
 * check and the rename is lost; the docs say so. Errors carry conditions, never text.
 */
export async function saveQuickLookFile(params: Pick<QuickLookSaveParams, 'path' | 'root' | 'digest' | 'text'>, seams: QuickLookSaveSeams = {}): Promise<QuickLookSaveResult> {
  const uid = seams.uid ?? process.getuid?.() ?? -1
  const refused = (message: string): QuickLookSaveResult => ({ status: 'failed', message: `Could not save · ${message}` })
  const check = await editCheck(params.path, params.root, uid)
  if (check.status === 'not-editable') return refused('Quick look does not edit this kind of file')
  if (check.status === 'read-only') return refused(check.message.replace(/^Read-only · /, ''))
  if (!wellFormed(params.text)) return refused('the text is not valid UTF-8')
  const before = await readTarget(check.target)
  if (!before || before.device !== check.device || before.inode !== check.inode) return { status: 'changed' }
  if (!before.bytes || quickLookDigest(before.bytes) !== params.digest) return { status: 'changed' }
  // The digest comes from the renderer; the bytes on disk are held to UTF-8 here, as the read held them.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(before.bytes)
  } catch {
    return refused('the file is not valid UTF-8 text')
  }
  // A file that began with a byte order mark keeps it; the text read never shows one.
  const keepMark = before.bytes.subarray(0, 3).equals(BOM) && !params.text.startsWith('﻿')
  const bytes = keepMark ? Buffer.concat([BOM, Buffer.from(params.text, 'utf8')]) : Buffer.from(params.text, 'utf8')
  if (bytes.length > QUICK_LOOK_EDIT_MAX_BYTES) return refused('the new text is over 256 KB')
  const staged = join(check.folder, `.${basename(check.target)}.bmn-save-${randomUUID()}.tmp`)
  // The staged file stays open until it is renamed or removed, so it can be emptied wherever its folder went.
  let handle: FileHandle | null = null
  let renamed = false
  let outcome: QuickLookSaveResult | null = null
  try {
    handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    // The group first, while the file is still private: a group the file cannot keep must not see it.
    try {
      await handle.chown(uid, check.gid)
    } catch {
      if ((check.mode & 0o070) !== 0) throw Object.assign(new Error('group'), { code: 'BMN_GROUP' })
    }
    await handle.chmod(check.mode)
    await handle.sync()
    await seams.beforeRename?.()
    const again = await editCheck(params.path, params.root, uid)
    if (again.status !== 'editable' || again.target !== check.target) {
      outcome = again.status === 'read-only' ? refused(again.message.replace(/^Read-only · /, '')) : { status: 'changed' }
    } else if (again.mode !== check.mode || again.gid !== check.gid) {
      // A mode or group changed meanwhile is not put back to the one the staged file carries.
      outcome = { status: 'changed' }
    } else {
      const now = await readTarget(check.target)
      if (!now?.bytes || now.device !== check.device || now.inode !== check.inode || now.nlink > 1 || !now.bytes.equals(before.bytes)) {
        outcome = { status: 'changed' }
      } else {
        await rename(staged, check.target)
        renamed = true
        await syncFolder(check.folder)
      }
    }
  } catch (error) {
    outcome = refused(failureWords(error))
  } finally {
    if (handle && !renamed) {
      // Emptied through its own handle first: a folder moved or locked meanwhile cannot keep the new text.
      await handle.truncate(0).then(() => handle?.sync()).catch(() => undefined)
      await rm(staged, { force: true }).catch(() => undefined)
      const left = await handle.stat().then((stats) => stats.nlink > 0, () => true)
      if (left) {
        const reason = outcome?.status === 'failed' ? outcome.message : 'Could not save · the file changed on disk'
        outcome = { status: 'failed', message: `${reason} · an emptied staging file ${basename(staged)} could not be removed` }
      }
    }
    await handle?.close().catch(() => undefined)
  }
  if (outcome) return outcome
  const after = await readTarget(check.target)
  if (!after?.bytes || !after.bytes.equals(bytes)) return refused('the file does not hold what BMN wrote; check it')
  const stats = await lstat(check.target, { bigint: true })
  return {
    status: 'saved',
    digest: quickLookDigest(after.bytes),
    savedAt: new Date().toISOString(),
    identity: { byteLength: Number(stats.size), modifiedNs: stats.mtimeNs.toString(), inode: `${stats.dev}:${stats.ino}` }
  }
}
