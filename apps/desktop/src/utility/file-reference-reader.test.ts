// MODULE: file-reference-reader.test.ts - bounded read-only snapshots of referenced files and their refusals
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, realpath, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReferenceReadResult, FileReferenceSnapshot, FileReferenceUnavailable } from '@bmn/protocol'
import { readFileReference, type FileReferenceReadRequest } from './file-reference-reader'
import { HostControlError } from './session-manager'
import { replaceWindowsFixtureFile } from './windows-fixture-io.test-support'
import { readFileReference as originalReadFileReference } from '../../../../scripts/test/fixtures/file-reference-reader-baseline.mjs'

vi.mock('node:fs/promises', { spy: true })

let root: string
let launch: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bmn-file-reference-')))
  launch = join(root, 'launch')
  await mkdir(join(launch, 'src'), { recursive: true })
  await writeFile(join(launch, 'src', 'parser.ts'), Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')
})

afterEach(async () => {
  vi.mocked(realpath).mockReset()
  vi.mocked(stat).mockReset()
  vi.mocked(open).mockReset()
  await rm(root, { recursive: true, force: true })
})

function request(reference: unknown, extra: Partial<FileReferenceReadRequest> = {}): FileReferenceReadRequest {
  return { sessionId: 'session-1', reference, baseDirectory: null, launchDirectory: launch, ...extra }
}

function ready(result: FileReferenceReadResult): FileReferenceSnapshot {
  if (result.status !== 'ready') throw new Error(`expected a snapshot, got ${result.reason}: ${result.message}`)
  return result
}

function refused(result: FileReferenceReadResult): FileReferenceUnavailable {
  if (result.status !== 'unavailable') throw new Error(`expected a refusal, got ${result.canonicalPath}`)
  return result
}

async function rejection(promise: Promise<unknown>): Promise<HostControlError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  if (!(error instanceof HostControlError)) throw new Error(`expected a HostControlError, got ${String(error)}`)
  return error
}

describe('readFileReference', () => {
  it('reads a relative reference against the labelled launch directory with its position', async () => {
    const result = ready(await readFileReference(request('  src/parser.ts:42:7 '), {
      now: () => new Date('2026-09-19T12:00:00.000Z')
    }))
    expect(result).toMatchObject({
      sessionId: 'session-1',
      reference: 'src/parser.ts:42:7',
      line: 42,
      column: 7,
      base: { kind: 'launch-directory', path: launch },
      resolvedPath: join(launch, 'src', 'parser.ts'),
      canonicalPath: join(launch, 'src', 'parser.ts'),
      lineCount: 50,
      readAt: '2026-09-19T12:00:00.000Z'
    })
    expect(result.content.split('\n')[41]).toBe('line 42')
  })

  it('uses a chosen folder only when given one, and needs no base for an absolute path', async () => {
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'notes.md'), 'chosen\n')
    const chosen = ready(await readFileReference(request('notes.md', { baseDirectory: other })))
    expect(chosen.base).toEqual({ kind: 'chosen-directory', path: other })
    expect(chosen.content).toBe('chosen\n')
    const launched = refused(await readFileReference(request('notes.md')))
    expect(launched).toMatchObject({ reason: 'missing', base: { kind: 'launch-directory', path: launch } })
    const absolute = ready(await readFileReference(request(join(other, 'notes.md'), { baseDirectory: launch })))
    expect(absolute.base).toBeNull()
  })

  it('reads quoted paths with spaces and Unicode names', async () => {
    await mkdir(join(launch, 'My Notes'))
    await writeFile(join(launch, 'My Notes', 'план чернетка.md'), 'привіт\n')
    const result = ready(await readFileReference(request('"My Notes/план чернетка.md":1')))
    expect(result.content).toBe('привіт\n')
    expect(result.line).toBe(1)
  })

  it('follows symlinks, including out of the base, and reports the real file', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(launch, 'link.txt'))
    const result = ready(await readFileReference(request('link.txt')))
    expect(result.resolvedPath).toBe(join(launch, 'link.txt'))
    expect(result.canonicalPath).toBe(outside)
    const escaped = ready(await readFileReference(request('../outside.txt')))
    expect(escaped.canonicalPath).toBe(outside)
  })

  it('explains missing files, folders, devices, pipes and a missing launch directory', async () => {
    expect(refused(await readFileReference(request('src/absent.ts'))).reason).toBe('missing')
    expect(refused(await readFileReference(request('./src'))).reason).toBe('not-a-file')
    if (process.platform === 'win32') {
      // Windows device/pipe namespaces are refused by the typed path boundary.
      for (const path of ['\\\\.\\NUL', '\\\\.\\pipe\\bmn-file-reference-fixture']) {
        expect((await rejection(readFileReference(request(path)))).code).toBe('INVALID_ARGUMENT')
      }
    } else {
      const device = refused(await readFileReference(request('/dev/null')))
      expect(device).toMatchObject({ reason: 'not-a-file', canonicalPath: '/dev/null' })
      expect(device.message).toMatch(/device/)
    }
    const loop = join(launch, 'loop.txt')
    await symlink(loop, loop)
    expect(refused(await readFileReference(request('loop.txt'))).reason).toBe('missing')
    const gone = refused(await readFileReference(request('src/parser.ts', { launchDirectory: join(root, 'deleted') })))
    expect(gone).toMatchObject({ reason: 'missing', message: 'The launch directory no longer exists.' })
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on it', async () => {
    const fifo = join(launch, 'queue.txt')
    const made = spawnSync('mkfifo', [fifo])
    if (made.status !== 0) throw new Error('mkfifo is unavailable')
    const result = refused(await readFileReference(request('queue.txt')))
    expect(result.reason).toBe('not-a-file')
    expect(result.message).toMatch(/pipe/)
  })

  it('refuses binary, non-UTF-8 and oversized files', async () => {
    await writeFile(join(launch, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    await writeFile(join(launch, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    await writeFile(join(launch, 'big.log'), 'x'.repeat(65))
    expect(refused(await readFileReference(request('image.png'))).reason).toBe('binary')
    expect(refused(await readFileReference(request('latin.txt'))).message).toMatch(/UTF-8/)
    const big = refused(await readFileReference(request('big.log'), { maxBytes: 64 }))
    expect(big).toMatchObject({ reason: 'too-large', canonicalPath: join(launch, 'big.log') })
    expect(ready(await readFileReference(request('big.log'), { maxBytes: 65 })).byteLength).toBe(65)
  })

  it('bounds the read when the file grows after it was checked', async () => {
    const path = join(launch, 'growing.log')
    await writeFile(path, 'start\n')
    const result = refused(await readFileReference(request('growing.log'), {
      maxBytes: 64,
      afterCheck: () => appendFile(path, 'y'.repeat(10_000))
    }))
    expect(result).toMatchObject({ reason: 'too-large' })
    expect(result.message).toMatch(/grew/)
  })

  it('reports a change when the shown path stops naming the file that was read', async () => {
    const path = join(launch, 'src', 'parser.ts')
    await writeFile(join(launch, 'replacement.ts'), 'other bytes\n')
    let replacementFailure: unknown
    const replaced = refused(await readFileReference(request('src/parser.ts'), {
      afterCheck: async () => {
        const replacement = join(launch, 'replacement.ts')
        try {
          if (process.platform === 'win32') replaceWindowsFixtureFile(root, replacement, path)
          else await rename(replacement, path)
        } catch (error) { replacementFailure = error; throw error }
      }
    }))
    // Preserve the native fixture's actual error in the unit JSON receipt.
    if (replacementFailure) throw replacementFailure
    expect(replaced).toMatchObject({ reason: 'changed', canonicalPath: path })

    // Windows refuses this physical-parent rename while the child handle is
    // open (native EPERM, replacement incomplete). Its live ancestor-path swap
    // uses the directory-junction discriminator below instead.
    if (process.platform === 'win32') return

    // A folder on the path becomes a symlink to another tree holding the same name.
    await mkdir(join(root, 'elsewhere', 'src'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'src', 'parser.ts'), 'elsewhere\n')
    const beforeSwap = await stat(path)
    let swapStage = 'callback-not-run', swapFailure: { code?: string; syscall?: string; name: string } | undefined
    const swapped = refused(await readFileReference(request('src/parser.ts'), {
      afterCheck: async () => {
        try {
          swapStage = 'folder-rename'
          await rename(join(launch, 'src'), join(launch, 'src-old'))
          swapStage = 'symlink-create'
          await symlink(join(root, 'elsewhere', 'src'), join(launch, 'src'))
          swapStage = 'replacement-complete'
        } catch (error) {
          const native = error as NodeJS.ErrnoException
          swapFailure = { ...(native.code ? { code: native.code } : {}), ...(native.syscall ? { syscall: native.syscall } : {}), name: native.name }
          throw error
        }
      }
    }))
    const afterSwap = await stat(path).catch(() => undefined)
    expect(swapped.reason, JSON.stringify({ stage: swapStage, failure: swapFailure,
      message: swapped.message, replacementComplete: swapStage === 'replacement-complete',
      canonicalPathEqual: swapped.canonicalPath === path,
      sameFileIdentity: afterSwap ? beforeSwap.dev === afterSwap.dev && beforeSwap.ino === afterSwap.ino : null })).toBe('changed')
  })

  it('detects a retargeted directory link while the original physical file remains open, original RED/current GREEN', async () => {
    const baseline = readFileSync(new URL('../../../../scripts/test/fixtures/file-reference-reader-baseline.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    expect(createHash('sha256').update(baseline).digest('hex')).toBe('7ae3b5bc518feaf23d9a3631e92b298d4bf2a5aa4624801127b4032213d16438')
    const alias = join(launch, 'linked-src'), first = join(launch, 'src'), second = join(root, 'second-src')
    await mkdir(second)
    await writeFile(join(second, 'parser.ts'), 'second physical tree\n')
    const originalBytes = await readFile(join(first, 'parser.ts'), 'utf8')
    const linkKind = process.platform === 'win32' ? 'junction' : 'dir'
    for (const [name, read] of [['original', originalReadFileReference], ['current', readFileReference]] as const) {
      await symlink(first, alias, linkKind)
      let completed = false
      const observed = await read(request('linked-src/parser.ts'), { afterCheck: async () => {
        // Remove only our directory link; both physical trees stay intact.
        await rm(alias, { recursive: true })
        await symlink(second, alias, linkKind)
        expect(await realpath(join(alias, 'parser.ts'))).toBe(join(second, 'parser.ts'))
        completed = true
      } })
      expect(completed, `${name}: native directory-link replacement must complete`).toBe(true)
      expect(await readFile(join(first, 'parser.ts'), 'utf8')).toBe(originalBytes)
      if (name === 'original') expect(observed).toMatchObject({ status: 'ready', content: originalBytes })
      else expect(observed).toMatchObject({ status: 'unavailable', reason: 'changed', canonicalPath: join(first, 'parser.ts') })
      await rm(alias, { recursive: true })
    }
  })

  it.each(['realpath', 'stat'] as const)('reports unreadable when final %s metadata is inaccessible, original RED/current GREEN', async (operation) => {
    const error = Object.assign(new Error('synthetic inaccessible metadata'), { code: 'EACCES' })
    for (const [name, read] of [['original', originalReadFileReference], ['current', readFileReference]] as const) {
      const observed = await read(request('src/parser.ts'), { afterCheck: async () => {
        if (operation === 'realpath') vi.mocked(realpath).mockRejectedValueOnce(error)
        else vi.mocked(stat).mockRejectedValueOnce(error)
      } })
      expect(observed).toMatchObject({ status: 'unavailable', reason: name === 'original' ? 'changed' : 'unreadable' })
    }
  })

  it('keeps an unchanged file unreadable when its actual open-handle read fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    for (const read of [originalReadFileReference, readFileReference]) {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args)
        vi.spyOn(handle, 'read').mockRejectedValueOnce(Object.assign(new Error('synthetic read denial'), { code: 'EACCES' }))
        return handle
      })
      expect(await read(request('src/parser.ts'))).toMatchObject({ status: 'unavailable', reason: 'unreadable' })
    }
  })

  it('rejects malformed references and folders before touching the filesystem', async () => {
    for (const reference of ['$HOME/x.txt', 'https://example.com/a.ts', 'src/*.ts', '~/x.txt', 'src/a.ts:0', '']) {
      const error = await rejection(readFileReference(request(reference, { launchDirectory: join(root, 'absent') })))
      expect(error.code).toBe('INVALID_ARGUMENT')
    }
    expect((await rejection(readFileReference(request(42)))).code).toBe('INVALID_ARGUMENT')
    expect((await rejection(readFileReference(request('a.txt', { baseDirectory: 'relative/folder' })))).message)
      .toMatch(/absolute/)
    expect((await rejection(readFileReference(request('a.txt', { baseDirectory: '/tmp/\u0007' })))).code)
      .toBe('INVALID_ARGUMENT')
  })

  it('counts lines the way the preview shows them', async () => {
    await writeFile(join(launch, 'empty.txt'), '')
    await writeFile(join(launch, 'crlf.txt'), 'a\r\nb\r\n')
    expect(ready(await readFileReference(request('empty.txt'))).lineCount).toBe(0)
    expect(ready(await readFileReference(request('crlf.txt'))).lineCount).toBe(2)
  })
})
