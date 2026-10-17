// MODULE: quick-look.test.ts - Quick look's root rules, one-folder listing and bounded read on made-up folders (Story 67.1)
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QUICK_LOOK_READ_MAX_BYTES, sameQuickLookIdentity, type QuickLookIdentity } from '@bmn/protocol'
import { listQuickLookFolder, quickLookIdentity, quickLookRoot, quickLookSourceFolder, readQuickLookFile } from './quick-look'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-quick-look-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const file = (path: string, content: string | Buffer = 'text\n'): void => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

describe('Quick look root', () => {
  it('starts at a running session\'s launch folder, a stopped one\'s stored folder, or the workspace\'s folder', () => {
    expect(quickLookSourceFolder({ kind: 'session', liveLaunchDirectory: '/work/live', storedCwd: '/work/stored' })).toBe('/work/live')
    expect(quickLookSourceFolder({ kind: 'session', liveLaunchDirectory: null, storedCwd: '/work/stored' })).toBe('/work/stored')
    expect(quickLookSourceFolder({ kind: 'workspace', folder: '/work/space' })).toBe('/work/space')
    expect(quickLookSourceFolder({ kind: 'workspace', folder: null })).toBeNull()
  })

  it('offers the Git root only when the folder lies below it', async () => {
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true })
    const below = await quickLookRoot(join(root, 'apps', 'desktop'), { home: '/home/me', gitRoot: async () => root })
    expect(below).toEqual({ status: 'ready', sessionFolder: join(root, 'apps', 'desktop'), gitRoot: root, home: '/home/me' })
    const at = await quickLookRoot(root, { home: null, gitRoot: async () => root })
    expect(at).toMatchObject({ status: 'ready', gitRoot: null })
    const outside = await quickLookRoot(root, { home: null, gitRoot: async () => null })
    expect(outside).toMatchObject({ status: 'ready', gitRoot: null })
  })

  it('finds the work tree\'s root with Git itself', async () => {
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', root])
    mkdirSync(join(root, 'src'))
    const result = await quickLookRoot(join(root, 'src'), { home: null })
    expect(result).toMatchObject({ status: 'ready', gitRoot: (await import('node:fs')).realpathSync(root) })
  })

  it('says a missing, relative or unreadable folder is unavailable', async () => {
    expect(await quickLookRoot(join(root, 'gone'), { home: null })).toEqual({ status: 'unavailable', folder: join(root, 'gone'), home: null })
    expect(await quickLookRoot('relative/path', { home: null })).toMatchObject({ status: 'unavailable' })
    expect(await quickLookRoot(null, { home: null })).toMatchObject({ status: 'unavailable', folder: null })
    file('plain.txt')
    expect(await quickLookRoot(join(root, 'plain.txt'), { home: null })).toMatchObject({ status: 'unavailable' })
  })

  it('takes a root that is reached through a link', async () => {
    mkdirSync(join(root, 'real'))
    file('real/a.txt')
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    expect(await quickLookRoot(join(root, 'alias'), { home: null, gitRoot: async () => null })).toMatchObject({ status: 'ready', sessionFolder: join(root, 'alias') })
    expect(await listQuickLookFolder(join(root, 'alias'))).toMatchObject({ status: 'ready', entries: [{ name: 'a.txt', kind: 'file' }] })
  })
})

describe('Quick look listing', () => {
  it('lists folders first, then by name, with hidden entries, links marked and generated names dimmed', async () => {
    file('b.txt')
    file('A.md')
    file('.env')
    file('src/main.ts')
    file('node_modules/x/index.js')
    file('dist/out.js')
    symlinkSync(join(root, 'src'), join(root, 'link-to-src'))
    const result = await listQuickLookFolder(root)
    if (result.status !== 'ready') throw new Error('listing failed')
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}${entry.dimmed ? ':dim' : ''}`)).toEqual([
      'folder:dist:dim', 'folder:node_modules:dim', 'folder:src',
      'file:.env', 'file:A.md', 'file:b.txt', 'link:link-to-src'
    ])
    expect(result.more).toBe(0)
  })

  it('joins a chain of folders that each hold one folder only', async () => {
    file('apps/desktop/src/a.ts')
    file('apps/desktop/src/b.ts')
    file('single/only.txt')
    const result = await listQuickLookFolder(root)
    if (result.status !== 'ready') throw new Error('listing failed')
    expect(result.entries.find((entry) => entry.name === 'apps')?.joined).toEqual(['desktop', 'src'])
    expect(result.entries.find((entry) => entry.name === 'single')?.joined).toEqual([])
  })

  it('stops at the cap and counts the rest in one line', async () => {
    for (let index = 0; index < 12; index += 1) file(`f${String(index).padStart(2, '0')}.txt`)
    const result = await listQuickLookFolder(root, { maxEntries: 10 })
    if (result.status !== 'ready') throw new Error('listing failed')
    expect(result.entries).toHaveLength(10)
    expect(result.more).toBe(2)
    const exact = await listQuickLookFolder(root, { maxEntries: 12 })
    expect(exact).toMatchObject({ more: 0 })
  })

  it('says a folder that disappeared is unavailable', async () => {
    mkdirSync(join(root, 'gone'))
    rmSync(join(root, 'gone'), { recursive: true })
    expect(await listQuickLookFolder(join(root, 'gone'))).toEqual({ status: 'unavailable', folder: join(root, 'gone'), message: 'This folder is unavailable' })
    expect(await listQuickLookFolder('relative')).toMatchObject({ status: 'unavailable' })
  })
})

describe('Quick look read', () => {
  it('reads a file at the 2 MiB cap and refuses one byte over with its facts', async () => {
    file('at-cap.txt', Buffer.alloc(QUICK_LOOK_READ_MAX_BYTES, 0x61))
    file('over.txt', Buffer.alloc(QUICK_LOOK_READ_MAX_BYTES + 1, 0x61))
    const at = await readQuickLookFile(join(root, 'at-cap.txt'))
    expect(at).toMatchObject({ status: 'ready', byteLength: QUICK_LOOK_READ_MAX_BYTES, lineCount: 1 })
    const over = await readQuickLookFile(join(root, 'over.txt'))
    expect(over).toMatchObject({ status: 'unavailable', reason: 'too-large', facts: { byteLength: QUICK_LOOK_READ_MAX_BYTES + 1 } })
  })

  it('refuses binary and invalid UTF-8 text with the file\'s facts', async () => {
    file('archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(await readQuickLookFile(join(root, 'archive.zip'))).toMatchObject({ status: 'unavailable', reason: 'binary', facts: { byteLength: 5 } })
    expect(await readQuickLookFile(join(root, 'latin1.txt'))).toMatchObject({ status: 'unavailable', reason: 'binary', facts: { byteLength: 4 } })
  })

  it('reads an empty file, says a missing path or a folder in today\'s words, and follows a link to its file', async () => {
    file('empty.txt', '')
    expect(await readQuickLookFile(join(root, 'empty.txt'))).toMatchObject({ status: 'ready', content: '', byteLength: 0 })
    expect(await readQuickLookFile(join(root, 'missing.txt'))).toMatchObject({ status: 'unavailable', reason: 'missing', message: 'No file exists at this path.', facts: null })
    mkdirSync(join(root, 'folder'))
    expect(await readQuickLookFile(join(root, 'folder'))).toMatchObject({ status: 'unavailable', reason: 'not-a-file' })
    file('target.ts', 'export {}\n')
    symlinkSync(join(root, 'target.ts'), join(root, 'alias.ts'))
    expect(await readQuickLookFile(join(root, 'alias.ts'))).toMatchObject({ status: 'ready', path: join(root, 'alias.ts'), canonicalPath: join(root, 'target.ts') })
  })
})

describe('Quick look identity', () => {
  const readIdentity = async (path: string): Promise<QuickLookIdentity> => {
    const read = await readQuickLookFile(path)
    if (read.status !== 'ready') throw new Error('read failed')
    return read.identity
  }

  it('is the same while the file is untouched and matches the read\'s own (Story 67.2)', async () => {
    file('a.ts', 'one\n')
    const read = await readIdentity(join(root, 'a.ts'))
    const now = await quickLookIdentity(join(root, 'a.ts'))
    expect(now).toEqual({ status: 'ready', identity: read })
    expect(sameQuickLookIdentity(read, now)).toBe(true)
  })

  it('differs for a changed size, a changed time, a replaced file and a deleted file (Story 67.2)', async () => {
    file('a.ts', 'one\n')
    const read = await readIdentity(join(root, 'a.ts'))
    writeFileSync(join(root, 'a.ts'), 'one more\n')
    expect(sameQuickLookIdentity(read, await quickLookIdentity(join(root, 'a.ts')))).toBe(false)

    file('b.ts', 'same\n')
    const before = await readIdentity(join(root, 'b.ts'))
    utimesSync(join(root, 'b.ts'), new Date(2001, 0, 1), new Date(2001, 0, 1))
    expect(sameQuickLookIdentity(before, await quickLookIdentity(join(root, 'b.ts')))).toBe(false)

    file('c.ts', 'same\n')
    const original = await readIdentity(join(root, 'c.ts'))
    file('c.next', 'same\n')
    // Same size and, to the millisecond, the same time: only the inode tells the files apart.
    const at = new Date(Number(BigInt(original.modifiedNs) / 1_000_000n))
    utimesSync(join(root, 'c.next'), at, at)
    renameSync(join(root, 'c.next'), join(root, 'c.ts'))
    const replaced = await quickLookIdentity(join(root, 'c.ts'))
    expect(replaced).toMatchObject({ status: 'ready', identity: { byteLength: original.byteLength } })
    expect(sameQuickLookIdentity(original, replaced)).toBe(false)

    rmSync(join(root, 'c.ts'))
    expect(await quickLookIdentity(join(root, 'c.ts'))).toEqual({ status: 'gone' })
    mkdirSync(join(root, 'now-a-folder'))
    expect(await quickLookIdentity(join(root, 'now-a-folder'))).toEqual({ status: 'gone' })
    expect(await quickLookIdentity('relative.ts')).toEqual({ status: 'gone' })
  })
})
