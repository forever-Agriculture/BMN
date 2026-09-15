// MODULE: artifact-files.ts - verified, immutable artifact originals: staged import, quota, integrity check and safe save-as
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

export const ARTIFACT_MAX_IMPORT_BYTES = 250 * 1024 * 1024
export const ARTIFACT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024

export type ArtifactFileErrorCode =
  | 'source-missing'
  | 'not-regular-file'
  | 'symlink-escape'
  | 'source-changed'
  | 'too-large'
  | 'quota-exceeded'
  | 'disk-full'
  | 'io-error'
  | 'destination-exists'
  | 'destination-denied'
  | 'missing'
  | 'corrupt'
  | 'cancelled'

export class ArtifactFileError extends Error {
  constructor(readonly code: ArtifactFileErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactFileError'
  }
}

export interface InstalledOriginal {
  artifactId: string
  sha256: string
  byteLength: number
  storedPath: string
  originalName: string
  mediaType: string
}

export interface ArtifactFileStoreOptions {
  root: string
  stagingRoot: string
  maxImportBytes?: number
  quotaBytes?: number
  usedBytes(): Promise<number>
  /** Runs after the staged copy is synced and before the source is re-checked. Tests only. */
  afterCopyForTest?: () => Promise<void>
}

const COPY_CHUNK_BYTES = 1024 * 1024
const HEAD_BYTES = 64
const MAX_NAME_BYTES = 255
const MAX_KEPT_EXTENSION_BYTES = 32
const FALLBACK_NAME = 'artifact'
const STAGING_SUFFIX = '.partial'
const STAGING_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const READ_SOURCE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT'])
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'])

interface CopyResult {
  sha256: string
  byteLength: number
  head: Uint8Array
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fileError(error: unknown, context: string): ArtifactFileError {
  if (error instanceof ArtifactFileError) return error
  if (DISK_FULL_CODES.has(errnoOf(error) ?? '')) {
    return new ArtifactFileError('disk-full', `${context}: ${messageOf(error)}`)
  }
  return new ArtifactFileError('io-error', `${context}: ${messageOf(error)}`)
}

function destinationError(error: unknown): ArtifactFileError {
  if (error instanceof ArtifactFileError) return error
  if (DENIED_CODES.has(errnoOf(error) ?? '')) {
    return new ArtifactFileError('destination-denied', `cannot write the destination: ${messageOf(error)}`)
  }
  return fileError(error, 'save failed')
}

function checkedArtifactId(artifactId: string): string {
  if (!ARTIFACT_ID.test(artifactId)) throw new TypeError('artifact id must be 1-128 safe filename characters')
  return artifactId
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (MISSING_CODES.has(errnoOf(error) ?? '')) return undefined
    throw error
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    offset += bytesWritten
  }
}

/** Reads from position 0 until EOF or `limit` bytes, hashing what it reads and writing it to `target`. */
async function copyAndHash(
  source: FileHandle,
  target: FileHandle | null,
  limit = Number.POSITIVE_INFINITY
): Promise<CopyResult> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  const hash = createHash('sha256')
  let head = Buffer.alloc(0)
  let position = 0
  while (position < limit) {
    const length = Math.min(buffer.byteLength, limit - position)
    const { bytesRead } = await source.read(buffer, 0, length, position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)
    if (head.byteLength < HEAD_BYTES) {
      head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.byteLength)])
    }
    if (target) await writeAll(target, chunk)
    position += bytesRead
  }
  return { sha256: hash.digest('hex'), byteLength: position, head }
}

async function hashFile(path: string): Promise<CopyResult> {
  const handle = await open(path, READ_SOURCE_FLAGS)
  try {
    return await copyAndHash(handle, null)
  } finally {
    await handle.close()
  }
}

/** Copies into a new file (never an existing one), syncs it, and re-reads it to prove the bytes landed. */
async function copyVerified(
  sourcePath: string,
  targetPath: string,
  sha256: string,
  mode: number
): Promise<{ sha256: string; byteLength: number }> {
  const source = await open(sourcePath, READ_SOURCE_FLAGS)
  try {
    const target = await open(targetPath, 'wx', mode)
    let copied: CopyResult
    try {
      copied = await copyAndHash(source, target)
      await target.sync()
    } finally {
      await target.close()
    }
    if (copied.sha256 !== sha256) {
      throw new ArtifactFileError('corrupt', 'stored original changed while it was being copied')
    }
    const written = await hashFile(targetPath)
    if (written.sha256 !== sha256 || written.byteLength !== copied.byteLength) {
      throw new ArtifactFileError('io-error', 'written copy failed verification')
    }
    return { sha256, byteLength: copied.byteLength }
  } finally {
    await source.close()
  }
}

async function isInsideAllowedRoots(realPath: string, allowedRoots: readonly string[]): Promise<boolean> {
  for (const root of allowedRoots) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      continue
    }
    const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    if (realPath === realRoot || realPath.startsWith(prefix)) return true
  }
  return false
}

export class ArtifactFileStore {
  private readonly root: string
  private readonly stagingRoot: string
  private readonly maxImportBytes: number
  private readonly quotaBytes: number
  private readonly usedBytes: () => Promise<number>
  private readonly afterCopyForTest: (() => Promise<void>) | undefined
  private readonly inFlightStaging = new Set<string>()
  private reservedBytes = 0

  constructor(options: ArtifactFileStoreOptions) {
    this.root = resolve(options.root)
    this.stagingRoot = resolve(options.stagingRoot)
    this.maxImportBytes = options.maxImportBytes ?? ARTIFACT_MAX_IMPORT_BYTES
    this.quotaBytes = options.quotaBytes ?? ARTIFACT_QUOTA_BYTES
    this.usedBytes = () => options.usedBytes()
    this.afterCopyForTest = options.afterCopyForTest
  }

  storedPathFor(artifactId: string, sha256: string): string {
    if (!SHA256_HEX.test(sha256)) throw new TypeError('sha256 must be 64 lowercase hex characters')
    return join(this.root, sha256.slice(0, 2), checkedArtifactId(artifactId))
  }

  async importFile(
    sourcePath: string,
    options: { artifactId: string; originalName?: string; allowedRoots?: readonly string[] }
  ): Promise<InstalledOriginal> {
    const artifactId = checkedArtifactId(options.artifactId)
    const originalName = sanitizeOriginalName(options.originalName ?? basename(sourcePath))
    const { realPath, before } = await this.inspectSource(sourcePath, options.allowedRoots)
    this.checkSize(before.size)
    return this.withReservation(before.size, () =>
      this.stageAndInstall(artifactId, originalName, async (staging) => {
        const source = await open(realPath, READ_SOURCE_FLAGS).catch((error: unknown) => {
          if (MISSING_CODES.has(errnoOf(error) ?? '') || errnoOf(error) === 'ELOOP') {
            throw new ArtifactFileError('source-changed', 'source was replaced before it could be read')
          }
          throw error
        })
        try {
          if (!sameFile(await source.stat(), before)) {
            throw new ArtifactFileError('source-changed', 'source was replaced before it could be read')
          }
          const copied = await copyAndHash(source, staging, before.size + 1)
          await staging.sync()
          await this.afterCopyForTest?.()
          const afterByPath = await stat(realPath).catch(() => undefined)
          const afterByHandle = await source.stat()
          if (
            copied.byteLength !== before.size ||
            !afterByPath ||
            !sameFile(afterByPath, before) ||
            !sameFile(afterByHandle, before)
          ) {
            throw new ArtifactFileError('source-changed', 'source changed while it was being imported')
          }
          return copied
        } finally {
          await source.close()
        }
      })
    )
  }

  async importBytes(
    bytes: Uint8Array,
    options: { artifactId: string; originalName: string }
  ): Promise<InstalledOriginal> {
    const artifactId = checkedArtifactId(options.artifactId)
    const originalName = sanitizeOriginalName(options.originalName)
    // Private snapshot: the caller's array cannot change between hashing and writing.
    const data = Buffer.from(bytes)
    this.checkSize(data.byteLength)
    return this.withReservation(data.byteLength, () =>
      this.stageAndInstall(artifactId, originalName, async (staging) => {
        await writeAll(staging, data)
        await staging.sync()
        if ((await staging.stat()).size !== data.byteLength) {
          throw new ArtifactFileError('io-error', 'staged bytes are incomplete')
        }
        return {
          sha256: createHash('sha256').update(data).digest('hex'),
          byteLength: data.byteLength,
          head: data.subarray(0, HEAD_BYTES)
        }
      })
    )
  }

  async verify(storedPath: string, sha256: string): Promise<'ok' | 'missing' | 'corrupt'> {
    let handle: FileHandle
    try {
      handle = await open(storedPath, READ_SOURCE_FLAGS)
    } catch (error) {
      if (MISSING_CODES.has(errnoOf(error) ?? '')) return 'missing'
      if (errnoOf(error) === 'ELOOP') return 'corrupt'
      throw fileError(error, 'verify failed')
    }
    try {
      if (!(await handle.stat()).isFile()) return 'corrupt'
      return (await copyAndHash(handle, null)).sha256 === sha256 ? 'ok' : 'corrupt'
    } catch (error) {
      throw fileError(error, 'verify failed')
    } finally {
      await handle.close()
    }
  }

  async saveAs(
    storedPath: string,
    sha256: string,
    destinationPath: string,
    options: { overwrite?: boolean } = {}
  ): Promise<{ sha256: string; byteLength: number }> {
    const state = await this.verify(storedPath, sha256)
    if (state !== 'ok') throw new ArtifactFileError(state, `stored original is ${state}`)
    const destination = resolve(destinationPath)
    const overwrite = options.overwrite === true
    const temporary = join(dirname(destination), `.aiterm-${randomUUID()}${STAGING_SUFFIX}`)
    try {
      const existing = await lstatOrUndefined(destination)
      if (existing && (!overwrite || existing.isDirectory())) {
        throw new ArtifactFileError('destination-exists', 'destination already exists')
      }
      const saved = await copyVerified(storedPath, temporary, sha256, 0o666)
      await this.placeFile(temporary, destination, overwrite)
      await syncDirectory(dirname(destination)).catch(() => undefined)
      return saved
    } catch (error) {
      throw destinationError(error)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Only names this store generates are removed, so a misconfigured stagingRoot cannot delete owner
   * files. Staging files of imports still running in this instance are skipped.
   */
  async reconcileStaging(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.stagingRoot)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return []
      throw fileError(error, 'staging scan failed')
    }
    const removed: string[] = []
    for (const name of names.sort()) {
      if (!STAGING_NAME.test(name) || this.inFlightStaging.has(name)) continue
      try {
        await unlink(join(this.stagingRoot, name))
        removed.push(name)
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') throw fileError(error, `cannot remove staging leftover ${name}`)
      }
    }
    return removed
  }

  async readPreview(storedPath: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer')
    let handle: FileHandle
    try {
      handle = await open(storedPath, READ_SOURCE_FLAGS)
    } catch (error) {
      if (MISSING_CODES.has(errnoOf(error) ?? '')) throw new ArtifactFileError('missing', 'stored original is missing')
      throw fileError(error, 'preview failed')
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new ArtifactFileError('corrupt', 'stored original is not a regular file')
      const bytes = Buffer.alloc(Math.min(maxBytes, stats.size))
      let offset = 0
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return { bytes: bytes.subarray(0, offset), truncated: stats.size > offset }
    } catch (error) {
      throw fileError(error, 'preview failed')
    } finally {
      await handle.close()
    }
  }

  private async inspectSource(
    sourcePath: string,
    allowedRoots: readonly string[] | undefined
  ): Promise<{ realPath: string; before: Stats }> {
    try {
      await lstat(sourcePath)
      const realPath = await realpath(sourcePath)
      if (allowedRoots && !(await isInsideAllowedRoots(realPath, allowedRoots))) {
        throw new ArtifactFileError('symlink-escape', 'source resolves outside the allowed roots')
      }
      const before = await lstat(realPath)
      if (!before.isFile()) throw new ArtifactFileError('not-regular-file', 'source is not a regular file')
      return { realPath, before }
    } catch (error) {
      if (error instanceof ArtifactFileError) throw error
      if (MISSING_CODES.has(errnoOf(error) ?? '')) {
        throw new ArtifactFileError('source-missing', 'source file does not exist')
      }
      if (errnoOf(error) === 'ELOOP') {
        throw new ArtifactFileError('not-regular-file', 'source is a symlink loop')
      }
      throw fileError(error, 'cannot inspect source')
    }
  }

  private checkSize(byteLength: number): void {
    if (byteLength > this.maxImportBytes) {
      throw new ArtifactFileError('too-large', `artifact is ${byteLength} bytes; the limit is ${this.maxImportBytes}`)
    }
  }

  /** Counts imports still in flight against the quota so parallel imports cannot jointly overshoot it. */
  private async withReservation<T>(byteLength: number, work: () => Promise<T>): Promise<T> {
    const used = await this.usedBytes()
    if (used + this.reservedBytes + byteLength > this.quotaBytes) {
      throw new ArtifactFileError('quota-exceeded', `artifact storage quota of ${this.quotaBytes} bytes is exhausted`)
    }
    this.reservedBytes += byteLength
    try {
      return await work()
    } finally {
      this.reservedBytes -= byteLength
    }
  }

  private async stageAndInstall(
    artifactId: string,
    originalName: string,
    write: (staging: FileHandle) => Promise<CopyResult>
  ): Promise<InstalledOriginal> {
    const name = `${randomUUID()}${STAGING_SUFFIX}`
    const stagingPath = join(this.stagingRoot, name)
    this.inFlightStaging.add(name)
    let staging: FileHandle | undefined
    try {
      await ensurePrivateDirectory(this.stagingRoot)
      staging = await open(stagingPath, 'wx', 0o600)
      const copied = await write(staging)
      await staging.close()
      await chmod(stagingPath, 0o400)
      const storedPath = await this.install(stagingPath, artifactId, copied.sha256)
      return {
        artifactId,
        sha256: copied.sha256,
        byteLength: copied.byteLength,
        storedPath,
        originalName,
        mediaType: detectMediaType(originalName, copied.head)
      }
    } catch (error) {
      throw fileError(error, 'import failed')
    } finally {
      await staging?.close().catch(() => undefined)
      await rm(stagingPath, { force: true }).catch(() => undefined)
      this.inFlightStaging.delete(name)
    }
  }

  private async install(stagingPath: string, artifactId: string, sha256: string): Promise<string> {
    const storedPath = this.storedPathFor(artifactId, sha256)
    const directory = dirname(storedPath)
    await ensurePrivateDirectory(this.root)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await lstatOrUndefined(storedPath)) {
      // A retried import of identical bytes is idempotent; anything else would replace an immutable original.
      if ((await this.verify(storedPath, sha256)) === 'ok') return storedPath
      throw new ArtifactFileError('destination-exists', 'a different original is already stored for this artifact')
    }
    try {
      await rename(stagingPath, storedPath)
    } catch (error) {
      if (errnoOf(error) !== 'EXDEV') throw error
      await this.installAcrossFilesystems(stagingPath, storedPath, sha256)
    }
    await syncDirectory(directory)
    await syncDirectory(this.root)
    return storedPath
  }

  /** stagingRoot and root may live on different filesystems (separate XDG state and data homes). */
  private async installAcrossFilesystems(stagingPath: string, storedPath: string, sha256: string): Promise<void> {
    const temporary = join(dirname(storedPath), `.${randomUUID()}${STAGING_SUFFIX}`)
    try {
      await copyVerified(stagingPath, temporary, sha256, 0o600)
      await chmod(temporary, 0o400)
      await rename(temporary, storedPath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /** Without overwrite, a hard link publishes the file only if the name is still free. */
  private async placeFile(temporary: string, destination: string, overwrite: boolean): Promise<void> {
    if (overwrite) {
      await rename(temporary, destination)
      return
    }
    try {
      await link(temporary, destination)
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') {
        throw new ArtifactFileError('destination-exists', 'destination already exists')
      }
      if (!LINK_UNSUPPORTED_CODES.has(errnoOf(error) ?? '')) throw error
      if (await lstatOrUndefined(destination)) {
        throw new ArtifactFileError('destination-exists', 'destination already exists')
      }
      await rename(temporary, destination)
    }
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

function hasBytes(head: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => head[offset + index] === value)
}

function hasText(head: Uint8Array, expected: string, offset = 0): boolean {
  return hasBytes(head, Array.from(expected, (character) => character.charCodeAt(0)), offset)
}

function sniffMediaType(head: Uint8Array): string | undefined {
  if (hasBytes(head, PNG_SIGNATURE)) return 'image/png'
  if (hasBytes(head, JPEG_SIGNATURE)) return 'image/jpeg'
  if (hasText(head, 'GIF87a') || hasText(head, 'GIF89a')) return 'image/gif'
  if (hasText(head, 'RIFF') && hasText(head, 'WEBP', 8)) return 'image/webp'
  if (hasText(head, '%PDF-')) return 'application/pdf'
  if (hasText(head, 'PK\x03\x04') || hasText(head, 'PK\x05\x06') || hasText(head, 'PK\x07\x08')) {
    return 'application/zip'
  }
  return undefined
}

/** Binary types come only from magic bytes; an extension alone never claims an image or archive. */
const EXTENSION_MEDIA_TYPES = new Map<string, string>([
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.ts', 'text/x-typescript'],
  ['.tsx', 'text/x-typescript'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.rs', 'text/x-rust'],
  ['.go', 'text/x-go'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.sql', 'application/sql'],
  ['.diff', 'text/x-diff'],
  ['.patch', 'text/x-diff'],
  ['.svg', 'image/svg+xml']
])

export function detectMediaType(name: string, head: Uint8Array): string {
  return (
    sniffMediaType(head) ??
    EXTENSION_MEDIA_TYPES.get(extname(name).toLowerCase()) ??
    'application/octet-stream'
  )
}

/** Control characters, bidi overrides (name spoofing), and lone surrogates. */
function isUnsafeNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xd800 && code <= 0xdfff)
  )
}

function takeUtf8Bytes(text: string, limit: number): string {
  let used = 0
  let kept = ''
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (used + size > limit) break
    kept += character
    used += size
  }
  return kept
}

export function sanitizeOriginalName(name: string): string {
  const segment = name.split('/').filter((part) => part.length > 0).pop() ?? ''
  const cleaned = Array.from(segment, (character) => (isUnsafeNameCharacter(character) ? '_' : character))
    .join('')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return FALLBACK_NAME
  if (Buffer.byteLength(cleaned) <= MAX_NAME_BYTES) return cleaned
  const extension = extname(cleaned)
  const suffix = extension.length > 1 && Buffer.byteLength(extension) <= MAX_KEPT_EXTENSION_BYTES ? extension : ''
  const stem = suffix ? cleaned.slice(0, -suffix.length) : cleaned
  return `${takeUtf8Bytes(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix))}${suffix}`
}
