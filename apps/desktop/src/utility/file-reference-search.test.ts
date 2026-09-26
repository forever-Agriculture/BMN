// MODULE: file-reference-search.test.ts - bounded, cancellable filename search against a synthetic tree
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchFileReferences } from './file-reference-search'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-file-search-'))
  roots.push(root)
  return root
}

describe('searchFileReferences', () => {
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
