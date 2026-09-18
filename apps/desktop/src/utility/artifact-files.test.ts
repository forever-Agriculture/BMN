// MODULE: artifact-files.test.ts - staged import, source-change detection, quota, integrity and no-clobber save-as of artifact originals
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactFileError,
  ArtifactFileStore,
  detectMediaType,
  sanitizeOriginalName,
  type ArtifactFileErrorCode,
  type ArtifactFileStoreOptions
} from './artifact-files'

const createdRoots = new Set<string>()
const runningAsRoot = process.getuid?.() === 0
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

interface Fixture {
  base: string
  root: string
  stagingRoot: string
  workspace: string
  store: ArtifactFileStore
}

async function fixture(overrides: Partial<ArtifactFileStoreOptions> = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'bmn-artifact-files-test-'))
  createdRoots.add(base)
  const root = join(base, 'data', 'artifacts')
  const stagingRoot = join(base, 'state', 'artifact-staging')
  const workspace = join(base, 'workspace')
  await mkdir(workspace, { recursive: true })
  const store = new ArtifactFileStore({ root, stagingRoot, usedBytes: async () => 0, ...overrides })
  return { base, root, stagingRoot, workspace, store }
}

function sha256Of(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => !entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function expectCode(promise: Promise<unknown>, code: ArtifactFileErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ArtifactFileError)
  expect((error as ArtifactFileError).code).toBe(code)
}

async function installed(store: ArtifactFileStore, workspace: string, content = 'artifact body') {
  const source = join(workspace, 'report.md')
  await writeFile(source, content)
  return store.importFile(source, { artifactId: `artifact-${randomUUID()}` })
}

describe('artifact file import', () => {
  it('installs an immutable, hashed original without touching the source', async () => {
    const { root, stagingRoot, workspace, store } = await fixture()
    const source = join(workspace, 'report.md')
    const content = '# Findings\n\nall green\n'
    await writeFile(source, content)
    await chmod(source, 0o640)
    const sourceBefore = await stat(source)

    const result = await store.importFile(source, { artifactId: 'artifact-1', allowedRoots: [workspace] })

    const sha256 = sha256Of(content)
    expect(result).toEqual({
      artifactId: 'artifact-1',
      sha256,
      byteLength: Buffer.byteLength(content),
      storedPath: join(root, sha256.slice(0, 2), 'artifact-1'),
      originalName: 'report.md',
      mediaType: 'text/markdown'
    })
    expect(store.storedPathFor('artifact-1', sha256)).toBe(result.storedPath)
    await expect(readFile(result.storedPath, 'utf8')).resolves.toBe(content)
    expect(await modeOf(result.storedPath)).toBe(0o400)
    expect(await modeOf(root)).toBe(0o700)
    expect(await modeOf(stagingRoot)).toBe(0o700)
    await expect(readdir(stagingRoot)).resolves.toEqual([])
    const sourceAfter = await stat(source)
    await expect(readFile(source, 'utf8')).resolves.toBe(content)
    expect(sourceAfter.mode).toBe(sourceBefore.mode)
    expect(sourceAfter.mtimeMs).toBe(sourceBefore.mtimeMs)
    await expect(store.verify(result.storedPath, sha256)).resolves.toBe('ok')
  })

  it('treats a retried import of identical bytes as already installed', async () => {
    const { workspace, store } = await fixture()
    const source = join(workspace, 'notes.txt')
    await writeFile(source, 'same bytes')

    const first = await store.importFile(source, { artifactId: 'artifact-retry' })
    const second = await store.importFile(source, { artifactId: 'artifact-retry' })

    expect(second).toEqual(first)
  })

  it('follows symlinks that stay inside the allowed roots and rejects ones that escape', async () => {
    const { base, root, stagingRoot, workspace, store } = await fixture()
    const outside = join(base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'owner secret')
    await writeFile(join(workspace, 'inside.txt'), 'shareable')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'))
    await symlink(join(workspace, 'inside.txt'), join(workspace, 'alias.txt'))

    await expectCode(
      store.importFile(join(workspace, 'escape.txt'), { artifactId: 'a1', allowedRoots: [workspace] }),
      'symlink-escape'
    )
    await expectCode(
      store.importFile(join(workspace, '..', 'outside', 'secret.txt'), { artifactId: 'a2', allowedRoots: [workspace] }),
      'symlink-escape'
    )
    await expectCode(
      store.importFile(join(workspace, 'inside.txt'), { artifactId: 'a3', allowedRoots: [] }),
      'symlink-escape'
    )
    await expect(listFiles(root)).resolves.toEqual([])
    await expect(listFiles(stagingRoot)).resolves.toEqual([])

    const alias = await store.importFile(join(workspace, 'alias.txt'), { artifactId: 'a4', allowedRoots: [workspace] })
    expect(alias).toMatchObject({ sha256: sha256Of('shareable'), originalName: 'alias.txt' })
  })

  it('rejects directories, FIFOs, devices and missing sources before opening them', async () => {
    const { workspace, store } = await fixture()
    const fifo = join(workspace, 'pipe')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)

    await expectCode(store.importFile(workspace, { artifactId: 'dir' }), 'not-regular-file')
    await expectCode(store.importFile('/dev/null', { artifactId: 'device' }), 'not-regular-file')
    await expectCode(store.importFile(join(workspace, 'absent.txt'), { artifactId: 'absent' }), 'source-missing')
    await symlink(join(workspace, 'nowhere.txt'), join(workspace, 'dangling.txt'))
    await expectCode(store.importFile(join(workspace, 'dangling.txt'), { artifactId: 'dangling' }), 'source-missing')
    // A blocking open of a FIFO would hang this test instead of failing it.
    await expectCode(store.importFile(fifo, { artifactId: 'fifo' }), 'not-regular-file')
  })

  it('refuses oversized files and bytes before staging anything', async () => {
    const { root, stagingRoot, workspace, store } = await fixture({ maxImportBytes: 10 })
    const source = join(workspace, 'big.log')
    await writeFile(source, '01234567890')

    await expectCode(store.importFile(source, { artifactId: 'big-file' }), 'too-large')
    await expectCode(store.importBytes(new Uint8Array(11), { artifactId: 'big-bytes', originalName: 'x.bin' }), 'too-large')
    await expect(store.importBytes(new Uint8Array(10), { artifactId: 'fits', originalName: 'x.bin' })).resolves.toMatchObject({
      byteLength: 10
    })
    await expect(listFiles(stagingRoot)).resolves.toEqual([])
    await expect(listFiles(root)).resolves.toHaveLength(1)
  })

  it('enforces the quota against owned bytes and imports still in flight', async () => {
    let used = 95
    const { workspace, store } = await fixture({ quotaBytes: 100, usedBytes: async () => used })
    const source = join(workspace, 'ten.txt')
    await writeFile(source, '0123456789')

    await expectCode(store.importFile(source, { artifactId: 'over' }), 'quota-exceeded')
    used = 90
    await expect(store.importFile(source, { artifactId: 'exact' })).resolves.toMatchObject({ byteLength: 10 })

    used = 80
    const results = await Promise.allSettled([
      store.importBytes(new Uint8Array(15).fill(1), { artifactId: 'parallel-1', originalName: 'one.bin' }),
      store.importBytes(new Uint8Array(15).fill(2), { artifactId: 'parallel-2', originalName: 'two.bin' })
    ])
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((result) => result.status === 'rejected')
    expect((rejected?.reason as ArtifactFileError).code).toBe('quota-exceeded')
  })

  it('detects a source that changes mid-copy and removes the staged copy', async () => {
    let stagedDuringCopy: string[] = []
    const context: { source?: string; stagingRoot?: string } = {}
    const { root, stagingRoot, workspace, store } = await fixture({
      afterCopyForTest: async () => {
        stagedDuringCopy = await readdir(context.stagingRoot as string)
        await appendFile(context.source as string, ' and more')
      }
    })
    const source = join(workspace, 'growing.log')
    await writeFile(source, 'first line')
    context.source = source
    context.stagingRoot = stagingRoot

    await expectCode(store.importFile(source, { artifactId: 'growing' }), 'source-changed')

    expect(stagedDuringCopy).toHaveLength(1)
    expect(stagedDuringCopy[0]).toMatch(/\.partial$/)
    await expect(readdir(stagingRoot)).resolves.toEqual([])
    await expect(listFiles(root)).resolves.toEqual([])
    await expect(readFile(source, 'utf8')).resolves.toBe('first line and more')
  })

  it('imports in-memory bytes with a sanitized name and sniffed media type', async () => {
    const { store } = await fixture()
    const bytes = Uint8Array.from([...PNG_HEAD, 1, 2, 3])

    const pending = store.importBytes(bytes, { artifactId: 'clip', originalName: '../../evil shot.png' })
    bytes.fill(0)
    const result = await pending

    const expected = Uint8Array.from([...PNG_HEAD, 1, 2, 3])
    expect(result).toMatchObject({
      sha256: sha256Of(expected),
      byteLength: expected.byteLength,
      originalName: 'evil_shot.png',
      mediaType: 'image/png'
    })
    await expect(readFile(result.storedPath)).resolves.toEqual(Buffer.from(expected))
    expect(await modeOf(result.storedPath)).toBe(0o400)
  })

  it('reconciles only staging leftovers this store could have written', async () => {
    const { stagingRoot, store } = await fixture()
    await expect(store.reconcileStaging()).resolves.toEqual([])
    await mkdir(stagingRoot, { recursive: true })
    const leftovers = [`${randomUUID()}.partial`, `${randomUUID()}.partial`].sort()
    for (const name of leftovers) await writeFile(join(stagingRoot, name), 'half written')
    await chmod(join(stagingRoot, leftovers[0] as string), 0o400)
    await writeFile(join(stagingRoot, 'owner-notes.txt'), 'not ours')

    await expect(store.reconcileStaging()).resolves.toEqual(leftovers)
    await expect(readdir(stagingRoot)).resolves.toEqual(['owner-notes.txt'])
  })
})

describe('artifact file integrity and export', () => {
  it('verifies stored originals as ok, missing or corrupt', async () => {
    const { workspace, store } = await fixture()
    const original = await installed(store, workspace)

    await expect(store.verify(original.storedPath, original.sha256)).resolves.toBe('ok')
    await expect(store.verify(`${original.storedPath}-gone`, original.sha256)).resolves.toBe('missing')
    await expect(store.verify(original.storedPath, sha256Of('something else'))).resolves.toBe('corrupt')
    await chmod(original.storedPath, 0o600)
    await writeFile(original.storedPath, 'tampered')
    await expect(store.verify(original.storedPath, original.sha256)).resolves.toBe('corrupt')
  })

  it('saves a verified copy and reports its hash', async () => {
    const { base, workspace, store } = await fixture()
    const original = await installed(store, workspace, 'export me')
    const exportDirectory = join(base, 'exports')
    await mkdir(exportDirectory)
    const destination = join(exportDirectory, 'report.md')

    await expect(store.saveAs(original.storedPath, original.sha256, destination)).resolves.toEqual({
      sha256: original.sha256,
      byteLength: 9
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('export me')
    await expect(readdir(exportDirectory)).resolves.toEqual(['report.md'])
    await expect(store.verify(original.storedPath, original.sha256)).resolves.toBe('ok')
  })

  it('refuses an existing destination unless overwrite is requested', async () => {
    const { base, workspace, store } = await fixture()
    const original = await installed(store, workspace, 'new content')
    const destination = join(base, 'existing.md')
    await writeFile(destination, 'owner content')

    await expectCode(store.saveAs(original.storedPath, original.sha256, destination), 'destination-exists')
    await expect(readFile(destination, 'utf8')).resolves.toBe('owner content')
    await expectCode(
      store.saveAs(original.storedPath, original.sha256, destination, { overwrite: false }),
      'destination-exists'
    )
    await expectCode(store.saveAs(original.storedPath, original.sha256, base, { overwrite: true }), 'destination-exists')

    await store.saveAs(original.storedPath, original.sha256, destination, { overwrite: true })
    await expect(readFile(destination, 'utf8')).resolves.toBe('new content')
    await expect(readdir(base)).resolves.not.toContainEqual(expect.stringMatching(/\.partial$/))
  })

  it.skipIf(runningAsRoot)('reports a non-writable destination directory without creating a file', async () => {
    const { base, workspace, store } = await fixture()
    const original = await installed(store, workspace)
    const locked = join(base, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    try {
      await expectCode(
        store.saveAs(original.storedPath, original.sha256, join(locked, 'report.md')),
        'destination-denied'
      )
      await expect(readdir(locked)).resolves.toEqual([])
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('refuses to export a missing or corrupt original', async () => {
    const { base, workspace, store } = await fixture()
    const original = await installed(store, workspace)
    const destination = join(base, 'copy.md')

    await expectCode(store.saveAs(original.storedPath, sha256Of('other'), destination), 'corrupt')
    await expectCode(store.saveAs(`${original.storedPath}-gone`, original.sha256, destination), 'missing')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads a bounded preview', async () => {
    const { workspace, store } = await fixture()
    const original = await installed(store, workspace, 'abcdefghij')

    const partial = await store.readPreview(original.storedPath, 4)
    expect(Buffer.from(partial.bytes).toString('utf8')).toBe('abcd')
    expect(partial.truncated).toBe(true)
    await expect(store.readPreview(original.storedPath, 64)).resolves.toMatchObject({ truncated: false })
    await expectCode(store.readPreview(`${original.storedPath}-gone`, 4), 'missing')
  })
})

describe('artifact media type and name rules', () => {
  const ascii = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'))

  it('sniffs magic bytes before trusting the extension', () => {
    expect(detectMediaType('photo.txt', PNG_HEAD)).toBe('image/png')
    expect(detectMediaType('x', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectMediaType('x', ascii('GIF89a....'))).toBe('image/gif')
    expect(detectMediaType('x', ascii('RIFF    WEBPVP8 '))).toBe('image/webp')
    expect(detectMediaType('x', ascii('%PDF-1.7'))).toBe('application/pdf')
    expect(detectMediaType('x', ascii('PKrest'))).toBe('application/zip')
  })

  it('falls back to text extensions, then octet-stream', () => {
    const plain = ascii('hello')
    expect(detectMediaType('README.MD', plain)).toBe('text/markdown')
    expect(detectMediaType('data.json', plain)).toBe('application/json')
    expect(detectMediaType('run.log', plain)).toBe('text/plain')
    expect(detectMediaType('main.py', plain)).toBe('text/x-python')
    expect(detectMediaType('diagram.svg', plain)).toBe('image/svg+xml')
    expect(detectMediaType('fake.png', plain)).toBe('application/octet-stream')
    expect(detectMediaType('noext', new Uint8Array())).toBe('application/octet-stream')
  })

  it('keeps a safe basename within 255 bytes', () => {
    expect(sanitizeOriginalName('/home/owner/project/report.pdf')).toBe('report.pdf')
    expect(sanitizeOriginalName('logs/')).toBe('logs')
    expect(sanitizeOriginalName('')).toBe('artifact')
    expect(sanitizeOriginalName('.')).toBe('artifact')
    expect(sanitizeOriginalName('a/..')).toBe('artifact')
    expect(sanitizeOriginalName('bad name‮txt.exe')).toBe('bad_name_txt.exe')

    const long = sanitizeOriginalName(`${'€'.repeat(100)}.txt`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long.endsWith('.txt')).toBe(true)
    expect(long).toBe(`${'€'.repeat(83)}.txt`)
  })
})
