// MODULE: quick-look-search.test.ts - Quick look's contents search on made-up folders: Git's scope and the walk's, each limit at and past its bound, case and whole word, masks, cancel, and the terminals' turn (Story 67.5)
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QUICK_LOOK_SEARCH_MAX_FILE_BYTES, SECRET_MASK } from '@bmn/protocol'
import { QuickLookSearches, contentsPattern, contentsQueryProblem, matchingLines, searchQuickLookContents } from './quick-look-search'

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await chmod(join(folder, 'locked.txt'), 0o600).catch(() => undefined)
    await rm(folder, { recursive: true, force: true })
  }
})

async function folder(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-quick-look-search-'))
  folders.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const git = (root: string, ...argv: string[]): void => {
  execFileSync('git', ['-C', root, ...argv], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
}

const search = (root: string, query: string, options: Partial<Parameters<typeof searchQuickLookContents>[1]> = {}, signal = new AbortController().signal) =>
  searchQuickLookContents(root, { query, matchCase: false, wholeWord: false, gitRoot: async () => null, ...options }, signal)

const names = (result: Awaited<ReturnType<typeof search>>, root: string): string[] => result.files.map((file) => file.path.slice(root.length + 1))

describe('what is searched', () => {
  it('inside a Git work tree: what Git tracks and untracked files it does not ignore, never an ignored .env', async () => {
    const root = await folder({ 'tracked.ts': 'needle\n', 'new.ts': 'needle\n', '.env': 'NEEDLE_NAME=needle\n', '.gitignore': '.env\nbuild-out/\n', 'build-out/x.ts': 'needle\n' })
    git(root, 'init', '-q')
    git(root, 'add', 'tracked.ts', '.gitignore')
    const result = await search(root, 'needle', { gitRoot: async () => root })
    expect(result.scope).toBe('git')
    expect(names(result, root)).toEqual(['new.ts', 'tracked.ts'])
    expect(result.filesRead).toBe(3)
  })

  it('in any other folder: the walk, without .git, node_modules, generated folders or links', async () => {
    const root = await folder({ 'a.ts': 'needle\n', 'node_modules/m/i.js': 'needle\n', 'dist/b.js': 'needle\n', 'deep/1/2/3/4/5/6/7/far.ts': 'needle\n', 'deep/1/2/3/4/5/near.ts': 'needle\n' })
    await symlink(join(root, 'a.ts'), join(root, 'link.ts'))
    const result = await search(root, 'needle')
    expect(result.scope).toBe('walk')
    expect(names(result, root).sort()).toEqual(['a.ts', 'deep/1/2/3/4/5/near.ts'])
  })

  it('skips a link Git tracks, a binary file, text that is not UTF-8 and a file one byte over 1 MiB, and counts one it cannot read', async () => {
    const atCap = `needle${'x'.repeat(QUICK_LOOK_SEARCH_MAX_FILE_BYTES - 7)}\n`
    const root = await folder({
      'at-cap.txt': atCap, 'over-cap.txt': `${atCap}x`, 'binary.bin': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]),
      'latin1.txt': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xe9]), 'locked.txt': 'needle\n'
    })
    await symlink(join(root, 'at-cap.txt'), join(root, 'link.txt'))
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    await chmod(join(root, 'locked.txt'), 0o000)
    const result = await search(root, 'needle', { gitRoot: async () => root })
    expect(Buffer.byteLength(atCap)).toBe(QUICK_LOOK_SEARCH_MAX_FILE_BYTES)
    expect(names(result, root)).toEqual(['at-cap.txt'])
    expect(result.unreadable).toBe(process.getuid?.() === 0 ? 0 : 1)
  })

  it('never shows lines of a file reached through a folder swapped for a link after Git listed it', async () => {
    const root = await folder({ 'sub/x.txt': 'needle inside\n', 'kept.txt': 'needle kept\n' })
    const outside = await folder({ 'x.txt': 'needle OUTSIDE\n' })
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    await rm(join(root, 'sub'), { recursive: true })
    await symlink(outside, join(root, 'sub'))
    const result = await search(root, 'needle', { gitRoot: async () => root })
    expect(names(result, root)).toEqual(['kept.txt'])
    expect(JSON.stringify(result)).not.toContain('OUTSIDE')
  })

  it('searches a root reached through a link, and still follows no link below it', async () => {
    const real = await folder({ 'a.ts': 'needle\n' })
    const outside = await folder({ 'x.ts': 'needle\n' })
    await symlink(outside, join(real, 'linked'))
    const holder = await folder({})
    await symlink(real, join(holder, 'alias'))
    const result = await search(join(holder, 'alias'), 'needle')
    expect(result.unavailable).toBeNull()
    expect(names(result, join(holder, 'alias'))).toEqual(['a.ts'])
  })

  it('says why when a folder cannot be searched or the text is too short, too long or not one line', async () => {
    expect((await search('/no/such/folder', 'needle')).unavailable).toBe('This folder is unavailable')
    expect(contentsQueryProblem('n')).toBe('Type at least 2 characters')
    expect(contentsQueryProblem('n'.repeat(256))).toBeNull()
    expect(contentsQueryProblem('n'.repeat(257))).toBe('Search text is at most 256 characters')
    expect(contentsQueryProblem('a\nb')).toBe('Search needs visible text on one line')
  })
})

describe('the limits, at and one past each bound', () => {
  it('reads every file at the limit and says "files" one past it', async () => {
    const at = await folder({ 'a.ts': 'needle', 'b.ts': 'needle', 'c.ts': 'needle' })
    expect(await search(at, 'needle', { maxFiles: 3 })).toMatchObject({ limit: null, filesRead: 3, matchCount: 3 })
    await writeFile(join(at, 'd.ts'), 'needle')
    expect(await search(at, 'needle', { maxFiles: 3 })).toMatchObject({ limit: 'files', filesRead: 3, matchCount: 3 })
  })

  it('returns every line at the limit and says "lines" one past it, keeping the first lines in path order', async () => {
    const root = await folder({ 'a.ts': 'needle 1\nneedle 2\n', 'b.ts': 'needle 3\n' })
    expect(await search(root, 'needle', { maxLines: 3 })).toMatchObject({ limit: null, matchCount: 3 })
    await writeFile(join(root, 'c.ts'), 'needle 4\n')
    const past = await search(root, 'needle', { maxLines: 3 })
    expect(past).toMatchObject({ limit: 'lines', matchCount: 3 })
    expect(past.files.flatMap((file) => file.lines.map((line) => line.text))).toEqual(['needle 1', 'needle 2', 'needle 3'])
  })

  it('cuts a long line to 240 characters around its match, and keeps a short one whole', () => {
    const long = `${'a'.repeat(500)}needle${'b'.repeat(500)}`
    const [line] = matchingLines('/p/x.ts', long, contentsPattern('needle', false, false), 10)
    expect(line).toMatchObject({ line: 1, column: 501, length: 6, cutBefore: true, cutAfter: true })
    expect(line!.text).toHaveLength(240)
    expect(line!.text.slice(line!.matchStart, line!.matchEnd)).toBe('needle')
    expect(matchingLines('/p/x.ts', 'one needle\r\nmore', contentsPattern('needle', false, false), 10)).toEqual([
      { line: 1, column: 5, length: 6, text: 'one needle', matchStart: 4, matchEnd: 10, cutBefore: false, cutAfter: false }
    ])
  })
})

describe('matching', () => {
  it('is literal, by case only when asked, and by whole word only when asked', () => {
    const text = 'Needle\nneedles\na.b\naxb\nneedle_x\n(needle)\n'
    const lines = (query: string, matchCase: boolean, wholeWord: boolean): number[] =>
      matchingLines('/p/x.txt', text, contentsPattern(query, matchCase, wholeWord), 100).map((line) => line.line)
    expect(lines('needle', false, false)).toEqual([1, 2, 5, 6])
    expect(lines('needle', true, false)).toEqual([2, 5, 6])
    expect(lines('needle', false, true)).toEqual([1, 6])
    expect(lines('a.b', false, false)).toEqual([3])
  })

  it('returns one row per line at its first match, with the line numbers of the file', () => {
    expect(matchingLines('/p/x.txt', 'x\nneedle needle\n\nneedle', contentsPattern('needle', false, false), 100).map((line) => [line.line, line.column])).toEqual([[2, 1], [4, 1]])
  })

  it('masks a line by the file view\'s rule and never finds a hidden value', async () => {
    const key = 'sk-madeupMADEUPmadeup0123456789abcdef'
    const root = await folder({ 'notes.md': `use key ${key} here\nkey made\n`, '.env': 'NAME=made-up\n' })
    const result = await search(root, 'made')
    const shown = result.files.flatMap((file) => file.lines.map((line) => line.text))
    expect(shown).toEqual(['key made'])
    const masked = await search(root, 'here')
    expect(masked.files[0]!.lines[0]!.text).toBe(`use key ${SECRET_MASK} here`)
    expect(masked.files[0]!.lines[0]!.text.slice(masked.files[0]!.lines[0]!.matchStart, masked.files[0]!.lines[0]!.matchEnd)).toBe('here')
    expect(JSON.stringify(await search(root, 'use key'))).not.toContain(key)
  })
})

describe('running searches', () => {
  it('stops when cancelled, and a newer search of the same window cancels the older', async () => {
    const root = await folder(Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`f${index}.ts`, 'needle\n'])))
    const searches = new QuickLookSearches()
    const first = searches.run('window-1', 'r1', (signal) => search(root, 'needle', {}, signal))
    const second = searches.run('window-1', 'r2', (signal) => search(root, 'needle', {}, signal))
    const other = searches.run('window-2', 'r3', (signal) => search(root, 'needle', {}, signal))
    const [older, newer, elsewhere] = await Promise.all([first, second, other])
    expect(older.cancelled).toBe(true)
    expect(newer).toMatchObject({ cancelled: false, filesRead: 400 })
    expect(elsewhere.cancelled).toBe(false)
    const stopped = searches.run('window-1', 'r4', (signal) => search(root, 'needle', {}, signal))
    searches.cancel('window-1', 'r-other')
    searches.cancel('window-1', 'r4')
    expect((await stopped).cancelled).toBe(true)
    expect(searches.running).toBe(0)
  })

  it('stops a search cancelled, or replaced by a newer one, while its root is still being checked', async () => {
    const root = await folder({ 'a.ts': 'needle\n' })
    const searches = new QuickLookSearches()
    let release = (): void => undefined
    const checking = new Promise<void>((resolve) => { release = resolve })
    const cancelled = searches.checkedRun('window-1', 'r1', () => checking, (signal) => search(root, 'needle', {}, signal))
    searches.cancel('window-1', 'r1')
    release()
    expect((await cancelled).cancelled).toBe(true)
    // The older request's check ends last; it is still the older one and stops, and the newer one is kept.
    let releaseOlder = (): void => undefined
    const older = searches.checkedRun('window-1', 'r2', () => new Promise<void>((resolve) => { releaseOlder = resolve }), (signal) => search(root, 'needle', {}, signal))
    const newer = searches.checkedRun('window-1', 'r3', async () => undefined, (signal) => search(root, 'needle', {}, signal))
    expect(await newer).toMatchObject({ cancelled: false, matchCount: 1 })
    releaseOlder()
    expect((await older).cancelled).toBe(true)
    expect(searches.running).toBe(0)
  })

  it('masks the lines of a big file of hidden values in one short step, not one scan of every value per line', () => {
    // Before: 2.9 s for 60,000 masked lines, 28.8 s for one 1 MiB line of base64 in a .env; now tens of ms.
    const cases: Array<[string, string, string]> = [
      ['/p/.env', 'NAME=madeup\n'.repeat(60_000), 'NAME'],
      ['/p/.env', `KEY=${'Ab0+/'.repeat(200_000)}\n`, 'ab'],
      ['/p/notes.md', 'ab\n'.repeat(300_000), 'ab']
    ]
    for (const [path, text, query] of cases) {
      const started = performance.now()
      matchingLines(path, text, contentsPattern(query, false, false), 2_001)
      expect(performance.now() - started).toBeLessThan(600)
    }
  })

  it('leaves the terminals\' process a turn at least every 100 ms while it searches 20,000 made-up files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-quick-look-timing-'))
    folders.push(root)
    for (let group = 0; group < 100; group += 1) {
      await mkdir(join(root, `g${group}`))
      await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(root, `g${group}`, `f${index}.ts`), `const value${index} = ${index}\n// needle ${group}\n`)))
    }
    git(root, 'init', '-q')
    // Both scopes: the walk, and Git's list of 20,000 untracked files it does not ignore.
    for (const [scope, gitRoot] of [['walk', async () => null], ['git', async () => root]] as const) {
      let last = performance.now()
      let longest = 0
      const ticker = setInterval(() => {
        const now = performance.now()
        longest = Math.max(longest, now - last)
        last = now
      }, 10)
      const result = await search(root, 'needle', { maxLines: 100_000, gitRoot })
      clearInterval(ticker)
      expect(result).toMatchObject({ scope, filesRead: 20_000, matchCount: 20_000, limit: null })
      expect(longest).toBeLessThan(100)
    }
  }, 60_000)
})
