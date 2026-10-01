// MODULE: file-reference-search.test.ts - bounded, cancellable filename search against a synthetic tree
import { mkdtemp, mkdir, rm, symlink, writeFile, opendir } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchFileReferences } from './file-reference-search'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof filesystem>()
  return { ...original, opendir: vi.fn(original.opendir) }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-file-search-'))
  roots.push(root)
  return root
}

describe('searchFileReferences', () => {
  it('finds source after generated entries would exhaust the original default cap', async () => {
    const root = await fixture()
    await mkdir(join(root, 'build')); await mkdir(join(root, 'src'))
    for (let i = 0; i < 20_010; i++) await writeFile(join(root, 'build', `generated-${i}.js`), '')
    await writeFile(join(root, 'src', 'target-source.ts'), '')
    // Fix only the root's enumeration order so the regression cannot pass by visiting src first.
    const rootHandle = await opendir(root)
    const entries: Dirent[] = []
    for await (const entry of rootHandle) entries.push(entry)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const { opendir: openDirectory } = await vi.importActual<typeof filesystem>('node:fs/promises')
    vi.mocked(filesystem.opendir).mockImplementation(async (...args) => args[0] === root
      ? { async *[Symbol.asyncIterator]() { yield* entries } } as Awaited<ReturnType<typeof opendir>>
      : openDirectory(...args))
    const found = await searchFileReferences(root, 'target-source.ts', new AbortController().signal)
    expect(found.files.map(row => row.path)).toEqual([join(root, 'src', 'target-source.ts')])
    expect(found.scanned).toBe(3)
    expect(found.capped).toBe(false)
  }, 15_000)
  it('reaches source without spending the entry budget inside generated directories', async () => {
    const root = await fixture()
    // Every sibling tree has a source target, so directory enumeration order cannot decide the result.
    for (const name of ['dist', 'build', 'out', 'coverage', '.next', '.cache', 'src']) {
      await mkdir(join(root, name))
      if (name !== 'src') for (let i = 0; i < 32; i++) await writeFile(join(root, name, `generated-${i}.js`), '')
      await writeFile(join(root, name, 'target.ts'), '')
    }
    const found = await searchFileReferences(root, 'target.ts', new AbortController().signal, { maxEntries: 30 })
    expect(found.files.map(row => row.path)).toEqual([join(root, 'src', 'target.ts')])
    expect(found.scanned).toBe(8); expect(found.capped).toBe(false)
  })
  it.each(['dist', 'build', 'out', 'coverage', '.next', '.cache'])('searches a context root named %s and exact-named regular files', async name => {
    const parent = await fixture(); const root = join(parent, name); await mkdir(root)
    await writeFile(join(root, 'target.ts'), '')
    expect((await searchFileReferences(root, 'target', new AbortController().signal)).files).toHaveLength(1)
    await writeFile(join(parent, 'src-file'), '')
    const regular = join(root, name); await writeFile(regular, '')
    expect((await searchFileReferences(root, name, new AbortController().signal)).files.map(row => row.path)).toContain(regular)
  })
  it('keeps .git and node_modules excluded when they are regular files', async () => {
    const root = await fixture()
    await writeFile(join(root, '.git'), 'gitdir: elsewhere'); await writeFile(join(root, 'node_modules'), '')
    expect((await searchFileReferences(root, 'git', new AbortController().signal)).files).toEqual([])
    expect((await searchFileReferences(root, 'node_modules', new AbortController().signal)).files).toEqual([])
  })
  it('matches names and directories, skips known trees and symlinks, and stops at depth six', async () => {
    const root = await fixture()
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, '.git', 'match.ts'), 'x')
    await writeFile(join(root, 'node_modules', 'match.ts'), 'x')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'match.ts'), 'x')
    await symlink(join(root, 'src'), join(root, 'linked'))
    await symlink(root, join(root, 'linked-root'))
    let folder = root
    for (let depth = 1; depth <= 7; depth += 1) {
      folder = join(folder, `level${depth}`)
      await mkdir(folder)
      await writeFile(join(folder, 'match.ts'), 'x')
    }
    const result = await searchFileReferences(root, 'match', new AbortController().signal)
    expect(result.unavailable).toBe(false)
    expect(result.files.map((file) => file.path)).toContain(join(root, 'src', 'match.ts'))
    expect(result.files.map((file) => file.path)).toContain(join(root, 'level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'match.ts'))
    expect(result.files.map((file) => file.path)).not.toContain(join(folder, 'match.ts'))
    expect(result.files).toHaveLength(7)
    expect((await searchFileReferences(join(root, 'linked-root'), 'match', new AbortController().signal)).unavailable)
      .toBe(true)
  })

  it('caps results and scanned entries without reading an unavailable root', async () => {
    const root = await fixture()
    for (let index = 0; index < 120; index += 1) await writeFile(join(root, `match-${index}.ts`), 'x')
    const matches = await searchFileReferences(root, 'match', new AbortController().signal)
    expect(matches.files).toHaveLength(50)
    expect(matches.capped).toBe(true)
    const entries = await searchFileReferences(root, 'missing', new AbortController().signal, { maxEntries: 10 })
    expect(entries.scanned).toBe(10)
    expect(entries.capped).toBe(true)
    expect((await searchFileReferences(join(root, 'not-here'), 'x', new AbortController().signal)).unavailable).toBe(true)
  })

  it('honors cancellation before and during a scan', async () => {
    const root = await fixture()
    const cancelled = new AbortController()
    cancelled.abort()
    expect((await searchFileReferences(root, 'x', cancelled.signal)).cancelled).toBe(true)
    for (let index = 0; index < 2_000; index += 1) await writeFile(join(root, `file-${index}.ts`), 'x')
    const running = new AbortController()
    const read = searchFileReferences(root, 'absent', running.signal)
    setTimeout(() => running.abort(), 0)
    expect((await read).cancelled).toBe(true)
  })
})
