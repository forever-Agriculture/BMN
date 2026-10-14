// MODULE: turn-changes-capture.test.ts - captures of made-up repositories against contents known beforehand: the root, what belongs, each kind of entry, each bound at and one past it, its time in every phase, swaps under a running capture, and a publication that was interrupted
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capture, isCapturing, isRefusal, type CaptureOptions, type CaptureOutcome, type StagedCapture } from './turn-changes-capture'
import { compareCaptures, fileDifference } from './turn-changes-compare'
import { TurnStore, type TreeRow } from './turn-changes-store'
import { around, filesUnder, holds, published, rows, scratch, sleep, snapshot, unequal, write, type Place } from './test-fixtures/turn-changes/fixtures'

const places: Place[] = []
const place = (name: string, options?: { commit?: boolean; init?: string[] }): Place => {
  const made = scratch(name, options)
  places.push(made)
  return made
}
afterEach(() => {
  for (const made of places.splice(0)) made.done()
})

const commit = (at: Place, message = 'more'): void => {
  at.git(at.repo, 'add', '-A')
  at.git(at.repo, 'commit', '-qm', message)
}
const staged = (outcome: CaptureOutcome): StagedCapture => {
  if (isRefusal(outcome)) throw new Error(`refused: ${outcome.state}: ${outcome.reason}`)
  return outcome
}
/** One path's stored row in a capture's tree. */
const rowAt = (store: TurnStore, tree: string | null, path: string): TreeRow | undefined => {
  let rows = store.tree(tree as string)
  const parts = path.split('/')
  for (const part of parts.slice(0, -1)) rows = store.tree((rows.get(part) as TreeRow)[2] as string)
  return rows.get(parts.at(-1) as string)
}

describe('the root BMN establishes by itself', () => {
  const refused = async (at: Place, folder: string, extra: Partial<CaptureOptions>, state: string, reason: string): Promise<void> => {
    const options = { ...at.options, ...extra }
    expect(await capture(folder, options)).toEqual({ state, reason })
    // Decided before a byte is written to the store.
    expect(filesUnder(join(options.dataRoot, 'turn-changes'))).toBe(0)
    expect(isCapturing(at.repo)).toBe(false)
  }

  it('is the nearest folder at or above that holds a .git, also from a folder below', async () => {
    const at = place('root')
    write(at.repo, 'deep/er/file.txt', 'x\n')
    commit(at)
    const outcome = staged(await capture(join(at.repo, 'deep/er'), { ...at.options, named: join(at.repo, 'deep') }))
    expect(outcome.record).toMatchObject({ root: at.repo, state: 'whole', objectFormat: 'sha1' })
    outcome.discard()
  })

  it('is unavailable when no folder at or above holds a .git, or the folder cannot be reached', async () => {
    const at = place('none')
    mkdirSync(join(at.base, 'plain'))
    await refused(at, join(at.base, 'plain'), {}, 'unavailable', 'no folder at or above it holds a .git')
    await refused(at, join(at.base, 'missing'), {}, 'unavailable', 'the folder cannot be reached')
    await refused(at, join(at.repo, 'keep.txt'), {}, 'unavailable', 'the folder is not a folder')
  })

  it('is unavailable when the folder a caller names lies in another root', async () => {
    const at = place('named')
    const other = place('other')
    await refused(at, at.repo, { named: other.repo }, 'unavailable', 'the named folder does not lie in this work tree')
    await refused(at, at.repo, { named: at.base }, 'unavailable', 'the named folder does not lie in this work tree')
    await refused(at, at.repo, { named: join(at.repo, 'gone') }, 'unavailable', 'the named folder cannot be reached')
  })

  it('does not support a repository whose settings name another work tree', async () => {
    const at = place('redirected')
    mkdirSync(join(at.base, 'elsewhere'))
    write(join(at.base, 'elsewhere'), 'stolen.txt', 'x\n')
    at.git(at.repo, 'config', 'core.worktree', join(at.base, 'elsewhere'))
    await refused(at, at.repo, {}, 'not-supported', "the repository's settings name another work tree")
  })

  it('does not support a root that is replaced while it is being established', async () => {
    const at = place('swapped-root')
    await refused(at, at.repo, {
      seams: {
        afterRootOpened: (root) => {
          renameSync(root, `${root}.moved`)
          mkdirSync(root)
          at.git(root, 'init', '-q', '-b', 'main')
          write(root, 'other.txt', 'o\n')
          at.git(root, 'add', '-A')
          at.git(root, 'commit', '-qm', 'other')
        }
      }
    }, 'not-supported', 'the root changed while it was being established')
  })

  it("does not support a work tree that holds BMN's data folder, or one that lies in it", async () => {
    const at = place('data-inside')
    await refused(at, at.repo, { dataRoot: join(at.repo, '.bmn-data') }, 'not-supported', "this work tree holds BMN's data folder")
    await refused(at, at.repo, { dataRoot: at.base }, 'not-supported', "this work tree lies in BMN's data folder")
  })

  it('does not support a sparse checkout', async () => {
    const at = place('sparse')
    write(at.repo, 'src/in.txt', 'in\n')
    write(at.repo, 'docs/out.txt', 'out\n')
    commit(at, 'two folders')
    at.git(at.repo, 'sparse-checkout', 'set', '--cone', 'src')
    await refused(at, at.repo, {}, 'not-supported', 'a sparse checkout')
  })

  it('does not support a bare repository, and a folder inside a .git is unavailable', async () => {
    const at = place('bare')
    at.git(at.base, 'clone', '-q', '--bare', at.repo, join(at.base, 'bare.git'))
    await refused(at, join(at.base, 'bare.git'), {}, 'not-supported', 'a bare repository')
    await refused(at, join(at.base, 'bare.git', 'refs'), {}, 'not-supported', 'a bare repository')
    await refused(at, join(at.repo, '.git', 'refs'), {}, 'unavailable', 'the folder lies inside a .git folder')
    at.git(at.repo, 'config', 'core.bare', 'true')
    await refused(at, at.repo, {}, 'not-supported', 'a bare repository')
  })

  it('keeps a repository Git refuses as unsafe refused, and says so', async () => {
    // What Git prints when the folder belongs to somebody else (measured for real in Story 69.1); BMN passes no exception.
    const at = place('unsafe')
    const git = join(at.base, 'git-refusing')
    writeFileSync(git, "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '$PWD'\" >&2\nexit 128\n", { mode: 0o755 })
    await refused(at, at.repo, { git }, 'not-supported', 'Git refuses this repository as unsafe')
  })

  it('is unavailable without Git, and when Git cannot read the repository or does not answer in time', async () => {
    const at = place('no-git')
    await refused(at, at.repo, { git: null }, 'unavailable', 'Git is not installed')
    const failing = join(at.base, 'git-failing')
    writeFileSync(failing, '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n', { mode: 0o755 })
    await refused(at, at.repo, { git: failing }, 'unavailable', 'Git cannot read this repository')
    const hanging = join(at.base, 'git-hanging')
    writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const began = Date.now()
    await refused(at, at.repo, { git: hanging, limits: { captureMs: 150 } }, 'unavailable', 'Git did not answer in time')
    expect(Date.now() - began).toBeLessThan(1500)
  })
})

describe('what a capture holds, against known contents', () => {
  it('reads a known change: files, lines, one file\'s difference and HEAD at both ends', async () => {
    const at = place('known')
    write(at.repo, 'a.txt', 'one\ntwo\nthree\n')
    write(at.repo, 'gone.txt', 'g1\ng2\n')
    commit(at, 'files')
    const run = await around(at, () => {
      write(at.repo, 'a.txt', 'one\n2\nthree\nfour\n')
      unlinkSync(join(at.repo, 'gone.txt'))
      write(at.repo, 'new.txt', 'n1\nn2')
    })
    expect(rows(run.compared)).toEqual({
      'a.txt': { state: 'changed', added: 2, removed: 1 },
      'gone.txt': { state: 'removed', kind: 'file', added: 0, removed: 2 },
      'new.txt': { state: 'added', kind: 'file', added: 2, removed: 0 }
    })
    expect(run.compared.totals).toEqual({ files: 3, added: 4, removed: 3, partial: false, notCounted: 0 })
    expect(fileDifference(run.store, run.one.id, run.two.id, 'a.txt')).toEqual({
      state: 'text', added: 2, removed: 1,
      hunks: [{ aStart: 1, aLines: 3, bStart: 1, bLines: 4, lines: [
        { kind: ' ', a: 1, b: 1, text: 'one' }, { kind: '-', a: 2, b: null, text: 'two' }, { kind: '+', a: null, b: 2, text: '2' },
        { kind: ' ', a: 3, b: 3, text: 'three' }, { kind: '+', a: null, b: 4, text: 'four' }
      ] }]
    })
    // A missing last line ending is a marked line of its own and counts as no line.
    expect(fileDifference(run.store, run.one.id, run.two.id, 'new.txt')).toMatchObject({ added: 2, hunks: [{ lines: [{ kind: '+' }, { kind: '+' }, { kind: '\\' }] }] })
    for (const head of [run.one.headStart, run.one.headEnd, run.two.headStart, run.two.headEnd]) expect(head).toMatch(/^[0-9a-f]{40}$/)
    // Only new bytes were read the second time.
    expect(run.two.bytesRead).toBe('one\n2\nthree\nfour\n'.length + 'n1\nn2'.length)
  })

  it('keeps covering a tracked file that becomes ignored', async () => {
    const at = place('tracked-ignored')
    write(at.repo, 't.log', 'v1\n')
    write(at.repo, '.gitignore', '')
    commit(at)
    const run = await around(at, () => {
      write(at.repo, '.gitignore', '*.log\n')
      write(at.repo, 't.log', 'v1\nv2\n')
    })
    expect(rows(run.compared)).toEqual({ '.gitignore': { state: 'changed', added: 1, removed: 0 }, 't.log': { state: 'changed', added: 1, removed: 0 } })
    expect(run.compared.totals.partial).toBe(false)
  })

  it('says an ignored file that becomes tracked entered what is covered: no lines, totals partial', async () => {
    const at = place('ignored-tracked')
    write(at.repo, '.gitignore', 'secret.cfg\n')
    commit(at)
    write(at.repo, 'secret.cfg', 's\n')
    const run = await around(at, () => {
      at.git(at.repo, 'add', '-f', 'secret.cfg')
    })
    expect(rows(run.compared)).toEqual({ 'secret.cfg': { state: 'entered what is covered' } })
    expect(run.compared.totals).toEqual({ files: 1, added: 0, removed: 0, partial: true, notCounted: 1 })
  })

  it('says a file captured while untracked and ignored later left what is covered', async () => {
    const at = place('untracked-ignored')
    write(at.repo, '.gitignore', '')
    commit(at)
    write(at.repo, 'notes.txt', 'n\n')
    const run = await around(at, () => write(at.repo, '.gitignore', 'notes.txt\n'))
    expect(rows(run.compared)).toEqual({ '.gitignore': { state: 'changed', added: 1, removed: 0 }, 'notes.txt': { state: 'left what is covered' } })
    expect(run.compared.totals).toEqual({ files: 2, added: 1, removed: 0, partial: true, notCounted: 1 })
  })

  it('cannot say added or removed between two captures that were not taken to be compared', async () => {
    const at = place('undecided')
    const first = await published(staged(await capture(at.repo, at.options)))
    await sleep(25)
    write(at.repo, 'new.txt', 'n\n')
    unlinkSync(join(at.repo, 'keep.txt'))
    const second = await published(staged(await capture(at.repo, at.options)))
    const compared = compareCaptures(new TurnStore(at.dataRoot, 's-case', at.repo), first.id, second.id)
    expect(compared).toMatchObject({ files: [{ path: 'keep.txt', state: 'left what is covered' }, { path: 'new.txt', state: 'entered what is covered' }], totals: { partial: true, notCounted: 2, added: 0, removed: 0 } })
  })

  it('stores a link as its text and never follows it', async () => {
    const at = place('link')
    const outside = join(at.base, 'outside.txt')
    writeFileSync(outside, `OUTSIDE-${randomBytes(6).toString('hex')}\n`)
    write(at.repo, 'a.txt', 'a\n')
    symlinkSync('a.txt', join(at.repo, 'link'))
    symlinkSync(outside, join(at.repo, 'out-link'))
    commit(at, 'links')
    const run = await around(at, () => {
      unlinkSync(join(at.repo, 'link'))
      symlinkSync('keep.txt', join(at.repo, 'link'))
    })
    expect(rows(run.compared)).toEqual({ link: { state: 'changed', added: 1, removed: 1 } })
    expect(rowAt(run.store, run.two.tree, 'out-link')).toEqual(['out-link', 'l', outside])
    expect(rowAt(run.store, run.two.tree, 'link')).toEqual(['link', 'l', 'keep.txt'])
    expect(holds(at.dataRoot, readFileSync(outside))).toBe(false)
  })

  it('reads a change of the executable bit only as "mode only"', async () => {
    const at = place('mode')
    write(at.repo, 'run.sh', '#!/bin/sh\n')
    commit(at, 'script')
    const run = await around(at, () => chmodSync(join(at.repo, 'run.sh'), 0o755))
    expect(rows(run.compared)).toEqual({ 'run.sh': { state: 'mode only', executable: true } })
    expect(run.compared.totals).toEqual({ files: 1, added: 0, removed: 0, partial: false, notCounted: 0 })
    expect(rowAt(run.store, run.two.tree, 'run.sh')?.slice(3)).toEqual(['#!/bin/sh\n'.length, 1])
  })

  it('reads a file that became a link, and a link that became a file, as "changed kind"', async () => {
    const at = place('kind')
    write(at.repo, 'was-file', 'f\n')
    symlinkSync('keep.txt', join(at.repo, 'was-link'))
    commit(at, 'kinds')
    const run = await around(at, () => {
      unlinkSync(join(at.repo, 'was-file'))
      symlinkSync('keep.txt', join(at.repo, 'was-file'))
      unlinkSync(join(at.repo, 'was-link'))
      write(at.repo, 'was-link', 'now a file\n')
    })
    expect(rows(run.compared)).toEqual({
      'was-file': { state: 'changed kind', from: 'file', to: 'link' },
      'was-link': { state: 'changed kind', from: 'link', to: 'file' }
    })
    expect(run.compared.totals).toEqual({ files: 2, added: 0, removed: 0, partial: false, notCounted: 0 })
  })

  it('reads a file with a NUL byte, and text that is not UTF-8, as binary with both sizes', async () => {
    const at = place('binary')
    write(at.repo, 'data.bin', Buffer.from([1, 0, 2, 3]))
    write(at.repo, 'latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    commit(at, 'bytes')
    const run = await around(at, () => {
      write(at.repo, 'data.bin', Buffer.from([1, 0, 2, 3, 4, 5]))
      write(at.repo, 'latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x73, 0x0a]))
      write(at.repo, 'new.bin', Buffer.from([0, 0, 0]))
    })
    expect(rows(run.compared)).toEqual({
      'data.bin': { state: 'binary', sizeBefore: 4, sizeAfter: 6 },
      'latin.txt': { state: 'binary', sizeBefore: 5, sizeAfter: 6 },
      'new.bin': { state: 'added', kind: 'file', sizeBefore: null, sizeAfter: 3 }
    })
    expect(fileDifference(run.store, run.one.id, run.two.id, 'data.bin')).toEqual({ state: 'binary', sizeBefore: 4, sizeAfter: 6 })
  })

  it('captures a repository with no commit yet, HEAD recorded as none', async () => {
    const at = place('unborn', { commit: false })
    write(at.repo, 'first.txt', 'f\n')
    const run = await around(at, () => write(at.repo, 'first.txt', 'f\ng\n'))
    expect([run.one.headStart, run.two.headEnd]).toEqual([null, null])
    expect(rows(run.compared)).toEqual({ 'first.txt': { state: 'changed', added: 1, removed: 0 } })
  })

  it('takes a linked work tree for a root of its own and leaves the main one untouched', async () => {
    const at = place('linked')
    write(at.repo, 'a.txt', 'a\n')
    commit(at, 'a')
    const tree = join(at.base, 'linked-tree')
    at.git(at.repo, 'worktree', 'add', '-q', '-b', 'side', tree)
    const before = snapshot(at.repo)
    const run = await around(at, () => write(tree, 'a.txt', 'a\nb\n'), { folder: tree })
    expect(run.one.root).toBe(tree)
    expect(rows(run.compared)).toEqual({ 'a.txt': { state: 'changed', added: 1, removed: 0 } })
    expect(unequal(before, snapshot(at.repo))).toEqual([])
  })

  it('captures a file a filter would rewrite as its bytes in the folder, and runs no filter', async () => {
    const at = place('lfs')
    const marker = join(at.base, 'filter-ran')
    const script = join(at.base, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 })
    write(at.repo, '.gitattributes', '*.lfs filter=lfs diff=lfs merge=lfs -text\n')
    commit(at, 'attributes')
    write(at.repo, 'small.lfs', 'real bytes v1\n')
    write(at.repo, 'huge.lfs', Buffer.alloc(4097, 0x61))
    for (const key of ['clean', 'smudge', 'process']) at.git(at.repo, 'config', `filter.lfs.${key}`, script)
    at.git(at.repo, 'config', 'filter.lfs.required', 'true')
    at.options.limits = { fileBytes: 4096 }
    const run = await around(at, () => {
      write(at.repo, 'small.lfs', 'real bytes v2\n')
      write(at.repo, 'huge.lfs', Buffer.alloc(4098, 0x62))
    })
    expect(existsSync(marker)).toBe(false)
    expect(rows(run.compared)).toEqual({ 'huge.lfs': { state: 'not read', why: 'too large, not read' }, 'small.lfs': { state: 'changed', added: 1, removed: 1 } })
    expect(run.compared.totals).toEqual({ files: 2, added: 1, removed: 1, partial: true, notCounted: 1 })
  })

  it('holds a submodule and a nested repository as one entry each, with the commit Git reports, never walked', async () => {
    const at = place('nested')
    const source = join(at.base, 'sub-source')
    mkdirSync(source)
    at.git(source, 'init', '-q', '-b', 'main')
    write(source, 'inside.txt', `INSIDE-${randomBytes(6).toString('hex')}\n`)
    at.git(source, 'add', '-A')
    at.git(source, 'commit', '-qm', 'sub')
    at.git(at.repo, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', source, 'sub')
    at.git(at.repo, 'commit', '-qm', 'submodule')
    const nested = join(at.repo, 'nested')
    mkdirSync(nested)
    at.git(nested, 'init', '-q', '-b', 'main')
    write(nested, 'deep.txt', 'd\n')
    at.git(nested, 'add', '-A')
    at.git(nested, 'commit', '-qm', 'nested')
    const head = (folder: string): string => at.git(folder, 'rev-parse', 'HEAD').trim()
    const before = { sub: head(join(at.repo, 'sub')), nested: head(nested) }
    const run = await around(at, () => {
      write(join(at.repo, 'sub'), 'inside.txt', 'i\nj\n')
      at.git(join(at.repo, 'sub'), 'commit', '-qam', 'sub 2')
      write(nested, 'deep.txt', 'd\ne\n')
      at.git(nested, 'commit', '-qam', 'nested 2')
    })
    expect(rows(run.compared)).toEqual({
      nested: { state: 'changed', from: before.nested, to: head(nested) },
      sub: { state: 'changed', from: before.sub, to: head(join(at.repo, 'sub')) }
    })
    expect(run.two.counts).toMatchObject({ submodules: 2, entries: 4 })
    expect(holds(at.dataRoot, readFileSync(join(source, 'inside.txt')))).toBe(false)
  })

  // R69-NFR4: a nested repository is one entry that is never walked. Git 2.53 lists the files of a folder the outer
  // repository tracked before as that repository's own, also once the folder holds a `.git` of its own. BMN does
  // not follow it there: every folder below the root that holds a `.git` is one entry.
  it('holds a tracked folder that got a .git of its own as one entry with its own commit and reads nothing below it, on a first and on a later capture', async () => {
    const at = place('tracked-nested')
    const marker = `INSIDE-${randomBytes(6).toString('hex')}`
    write(at.repo, 'vendor/a.txt', `${marker}\n`)
    write(at.repo, 'vendor/deep/b.txt', `${marker} deep\n`)
    commit(at, 'vendor')
    const vendor = join(at.repo, 'vendor')
    const head = (): string => at.git(vendor, 'rev-parse', 'HEAD').trim()
    at.git(vendor, 'init', '-q', '-b', 'main')
    at.git(vendor, 'add', '-A')
    at.git(vendor, 'commit', '-qm', 'inner')
    write(at.repo, 'vendor/untracked.txt', `${marker} untracked\n`)
    // Git goes on listing its files as the outer repository's.
    expect(at.git(at.repo, 'ls-files', '--cached', '--others', '--exclude-standard').trim().split('\n').sort())
      .toEqual(['keep.txt', 'vendor/a.txt', 'vendor/deep/b.txt', 'vendor/untracked.txt'])
    const seen: string[] = []
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const options = { ...at.options, store, seams: { beforeEntry: (path: string) => void seen.push(path) } }
    const cold = await published(staged(await capture(at.repo, options)))
    const first = head()
    expect(rowAt(store, cold.tree, 'vendor')?.slice(1)).toEqual(['s', first, 1])
    expect(cold.counts).toMatchObject({ entries: 2, files: 1, submodules: 1 })
    expect(seen.sort()).toEqual(['keep.txt', 'vendor'])
    expect(holds(at.dataRoot, marker)).toBe(false)
    // A later capture, with what the first one saw at hand: the same, and a change below is a change of its commit only.
    await sleep(25)
    write(at.repo, 'vendor/a.txt', `${marker} changed\n`)
    at.git(vendor, 'commit', '-qam', 'inner 2')
    seen.length = 0
    const warm = await published(staged(await capture(at.repo, { ...options, base: cold.id })))
    expect(seen).toEqual(['vendor'])
    expect(warm.counts).toMatchObject({ entries: 2, files: 1, submodules: 1 })
    const compared = compareCaptures(store, cold.id, warm.id)
    if (compared.state !== 'compared') throw new Error(compared.reason)
    expect(rows(compared)).toEqual({ vendor: { state: 'changed', from: first, to: head() } })
    expect(holds(at.dataRoot, marker)).toBe(false)
  })

  it('says of files that came to lie in a repository of their own that they left what is covered, and of that repository that it entered, and the other way round: without a look below, whatever their age', async () => {
    const at = place('nested-transition')
    write(at.repo, 'vendor/a.txt', 'one\n')
    commit(at, 'vendor')
    await sleep(25)
    const vendor = join(at.repo, 'vendor')
    // The folder is made anew in the turn, as a repository of its own: its old file is in fact gone, and BMN does not look.
    const into = await around(at, () => {
      rmSync(vendor, { recursive: true })
      mkdirSync(vendor)
      at.git(vendor, 'init', '-q', '-b', 'main')
      write(at.repo, 'vendor/new.txt', 'made in the turn\n')
    })
    expect(rows(into.compared)).toEqual({ vendor: { state: 'entered what is covered' }, 'vendor/a.txt': { state: 'left what is covered' } })
    expect(into.compared.totals).toMatchObject({ added: 0, removed: 0, partial: true })
    expect(rowAt(into.store, into.two.tree, 'vendor')?.slice(1)).toEqual(['s', null, 1])
    // And back: it is a plain folder again, with a file made in this very turn.
    const back = await around(at, () => {
      rmSync(join(vendor, '.git'), { recursive: true })
      write(at.repo, 'vendor/fresh.txt', 'made in this turn\n')
    })
    expect(rows(back.compared)).toEqual({
      vendor: { state: 'left what is covered' },
      'vendor/fresh.txt': { state: 'entered what is covered' },
      'vendor/new.txt': { state: 'entered what is covered' }
    })
    expect(back.compared.totals).toMatchObject({ added: 0, removed: 0, partial: true })
  })

  it('reads nothing below a folder whose .git is no repository or which is a link to elsewhere, and takes no commit for it from the repository around it', async () => {
    const at = place('nested-odd')
    const marker = `INSIDE-${randomBytes(6).toString('hex')}`
    write(at.repo, 'empty/a.txt', `${marker} one\n`)
    write(at.repo, 'file/b.txt', `${marker} two\n`)
    write(at.repo, 'linked/c.txt', `${marker} three\n`)
    commit(at, 'folders')
    // An empty folder named `.git`, and a file named `.git` that points nowhere.
    mkdirSync(join(at.repo, 'empty', '.git'))
    writeFileSync(join(at.repo, 'file', '.git'), 'gitdir: /nowhere\n')
    // A folder put aside for a link to a repository outside the work tree; Git still lists the file it tracked below it.
    const outside = join(at.base, 'outside')
    mkdirSync(outside)
    at.git(outside, 'init', '-q', '-b', 'main')
    write(outside, 'c.txt', `${marker} outside\n`)
    rmSync(join(at.repo, 'linked'), { recursive: true })
    symlinkSync(outside, join(at.repo, 'linked'))
    expect(at.git(at.repo, 'ls-files', '--cached').trim().split('\n').sort()).toEqual(['empty/a.txt', 'file/b.txt', 'keep.txt', 'linked/c.txt'])
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const one = await published(staged(await capture(at.repo, { ...at.options, store })))
    expect(rowAt(store, one.tree, 'empty')?.slice(1)).toEqual(['s', null, 1])
    expect(rowAt(store, one.tree, 'file')?.slice(1)).toEqual(['s', null, 1])
    expect(rowAt(store, one.tree, 'linked')?.slice(1)).toEqual(['l', outside])
    expect(one.counts).toMatchObject({ entries: 4, files: 1, submodules: 2, links: 1 })
    expect(holds(at.dataRoot, marker)).toBe(false)
  })

  it('lists a file it did not read as "not read" and calls the totals partial, also when the file reads the same in both captures', async () => {
    const at = place('unread-same')
    write(at.repo, 'huge.bin', 'h'.repeat(200))
    write(at.repo, 'a.txt', 'a\n')
    commit(at, 'files')
    at.options.limits = { fileBytes: 100 }
    const changed = await around(at, () => write(at.repo, 'a.txt', 'a\nb\n'))
    expect(rows(changed.compared)).toEqual({
      'a.txt': { state: 'changed', added: 1, removed: 0 },
      'huge.bin': { state: 'not read', why: 'too large, not read' }
    })
    expect(changed.compared.totals).toEqual({ files: 2, added: 1, removed: 0, partial: true, notCounted: 1 })
    // Nothing else differs: still not a complete "0 files".
    const same = await around(at, () => undefined)
    expect(same.one.tree).toBe(same.two.tree)
    expect(rows(same.compared)).toEqual({ 'huge.bin': { state: 'not read', why: 'too large, not read' } })
    expect(same.compared.totals).toEqual({ files: 1, added: 0, removed: 0, partial: true, notCounted: 1 })
  })

  it.skipIf(process.getuid?.() === 0)('does the same for a file BMN may not open in either capture', async () => {
    const at = place('unread-locked')
    write(at.repo, 'deep/locked.txt', 'l\n')
    chmodSync(join(at.repo, 'deep/locked.txt'), 0)
    const run = await around(at, () => undefined)
    expect(rowAt(run.store, run.two.tree, 'deep/locked.txt')?.slice(1)).toEqual(['u', 'not read'])
    expect(rows(run.compared)).toEqual({ 'deep/locked.txt': { state: 'not read', why: 'not read' } })
    expect(run.compared.totals).toEqual({ files: 1, added: 0, removed: 0, partial: true, notCounted: 1 })
  })

  for (const [name, prepare, init] of [
    ['a split index', (at: Place) => at.git(at.repo, 'update-index', '--split-index'), []],
    ['a SHA-256 repository', () => undefined, ['--object-format=sha256']]
  ] as const) {
    it(`supports ${name}`, async () => {
      const at = place('format', { init: [...init] })
      write(at.repo, 'a.txt', 'one\ntwo\n')
      commit(at, 'files')
      prepare(at)
      const run = await around(at, () => write(at.repo, 'a.txt', 'one\n2\n'))
      expect(rows(run.compared)).toEqual({ 'a.txt': { state: 'changed', added: 1, removed: 1 } })
      expect(run.two.objectFormat).toBe(init.length > 0 ? 'sha256' : 'sha1')
    })
  }

  it('supports a partial clone with a missing object, and fetches nothing', async () => {
    const at = place('partial')
    write(at.repo, 'a.txt', 'one\n')
    write(at.repo, 'old.txt', 'only in history\n')
    commit(at, 'old')
    at.git(at.repo, 'rm', '-q', 'old.txt')
    at.git(at.repo, 'commit', '-qm', 'drop old')
    at.git(at.repo, 'config', 'uploadpack.allowFilter', 'true')
    const clone = join(at.base, 'partial')
    at.git(at.base, '-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=blob:none', `file://${at.repo}`, clone)
    const missing = (): number => at.git(clone, 'rev-list', '--objects', '--all', '--missing=print').split('\n').filter((line) => line.startsWith('?')).length
    expect(missing()).toBeGreaterThan(0)
    const before = missing()
    const run = await around(at, () => write(clone, 'a.txt', 'one\ntwo\n'), { folder: clone })
    expect(rows(run.compared)).toEqual({ 'a.txt': { state: 'changed', added: 1, removed: 0 } })
    expect(missing()).toBe(before)
  }, 20_000)

  it('still reads a kept difference after the repository is moved, and after it is deleted', async () => {
    const at = place('moved')
    write(at.repo, 'a.txt', 'one\n')
    commit(at)
    const run = await around(at, () => write(at.repo, 'a.txt', 'one\ntwo\n'))
    const read = (): string => JSON.stringify([compareCaptures(run.store, run.one.id, run.two.id), fileDifference(run.store, run.one.id, run.two.id, 'a.txt')].map((part) => ({ ...part, tookMs: 0 })))
    const expected = read()
    expect(expected).toContain('"added":1')
    renameSync(at.repo, `${at.repo}.moved`)
    expect(read()).toBe(expected)
    rmSync(`${at.repo}.moved`, { recursive: true, force: true })
    expect(read()).toBe(expected)
  })
})

describe('a capture while something is swapped under it', () => {
  const swapped = async (path: string, swap: (repo: string, outside: string) => void): Promise<void> => {
    const at = place('swap')
    const marker = `OUTSIDE-${randomBytes(8).toString('hex')}`
    const outside = join(at.base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'file.txt'), `${marker}\n`)
    write(at.repo, path, 'inside v1\n')
    commit(at, 'victim')
    let done = false
    const run = await around(at, () => write(at.repo, path, 'inside v2\n'), {
      secondOptions: {
        seams: {
          beforeEntry: (entry) => {
            if (entry !== path || done) return
            done = true
            swap(at.repo, outside)
          }
        }
      }
    })
    expect(done).toBe(true)
    expect(rowAt(run.store, run.two.tree, path)?.slice(1)).toEqual(['u', 'not read'])
    expect(rows(run.compared)[path]).toEqual({ state: 'not read', why: 'not read' })
    expect(run.compared.totals.partial).toBe(true)
    expect(holds(at.dataRoot, marker)).toBe(false)
  }

  it('marks a last link swapped in for one that points outside the root "not read"', () =>
    swapped('victim.txt', (repo, outside) => {
      unlinkSync(join(repo, 'victim.txt'))
      symlinkSync(join(outside, 'file.txt'), join(repo, 'victim.txt'))
    }))

  it('marks a file below a folder swapped the same way "not read"', () =>
    swapped('dir/sub/file.txt', (repo, outside) => {
      renameSync(join(repo, 'dir/sub'), join(repo, 'dir/sub.real'))
      symlinkSync(outside, join(repo, 'dir/sub'))
    }))

  it('marks a file below a swapped top folder of its path "not read"', () =>
    swapped('dir/sub/file.txt', (repo, outside) => {
      renameSync(join(repo, 'dir'), join(repo, 'dir.real'))
      mkdirSync(join(outside, 'sub'), { recursive: true })
      renameSync(join(outside, 'file.txt'), join(outside, 'sub/file.txt'))
      symlinkSync(outside, join(repo, 'dir'))
    }))

  it('reads a file once more when it changed while read, and then marks it "changed while read"', async () => {
    const at = place('growing')
    write(at.repo, 'once.txt', 'a\n')
    write(at.repo, 'always.txt', 'a\n')
    let grewOnce = false
    const outcome = staged(await capture(at.repo, {
      ...at.options,
      seams: {
        duringRead: (path) => {
          if (path === 'always.txt' || (path === 'once.txt' && !grewOnce)) appendFileSync(join(at.repo, path), 'more\n')
          if (path === 'once.txt') grewOnce = true
        }
      }
    }))
    const record = await published(outcome)
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    expect(rowAt(store, record.tree, 'always.txt')).toEqual(['always.txt', 'u', 'changed while read'])
    expect(rowAt(store, record.tree, 'once.txt')?.slice(1, 2)).toEqual(['f'])
    expect(rowAt(store, record.tree, 'once.txt')?.[3]).toBe('a\nmore\n'.length)
    expect(record.counts.notRead).toBe(1)
  })

  it('is unavailable when the root is replaced while it is captured', async () => {
    const at = place('root-later')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const outcome = await capture(at.repo, {
      ...at.options,
      store,
      seams: {
        afterList: (root) => {
          renameSync(root, `${root}.moved`)
          mkdirSync(root)
        }
      }
    })
    expect(outcome).toEqual({ state: 'unavailable', reason: 'the root changed while it was captured' })
    await store.settled()
    expect(filesUnder(at.dataRoot)).toBe(0)
  })
})

describe('the bounds of a capture, at and one past', () => {
  const four = (at: Place): void => {
    // With keep.txt: five entries, 10 bytes each but keep.txt (2).
    for (const name of ['a', 'b', 'c', 'd']) write(at.repo, `${name}.txt`, '123456789\n')
  }

  it('holds as many entries as the limit, and keeps nothing of a work tree with one more', async () => {
    const at = place('entries')
    four(at)
    const atLimit = staged(await capture(at.repo, { ...at.options, limits: { entries: 5 } }))
    expect(atLimit.record).toMatchObject({ state: 'whole', bound: null, counts: { entries: 5 } })
    atLimit.discard()
    const past = staged(await capture(at.repo, { ...at.options, limits: { entries: 4 } }))
    expect(past.record).toMatchObject({ state: 'incomplete', bound: '4 entries', tree: null, bytesRead: 0, bytesStored: 0 })
    await published(past)
    expect(new TurnStore(at.dataRoot, 's-case', at.repo).size('objects')).toBe(0)
  })

  it('reads as many bytes as the limit, and stops one byte past it naming the bound', async () => {
    const at = place('bytes')
    four(at)
    const atLimit = staged(await capture(at.repo, { ...at.options, limits: { readBytes: 42 } }))
    expect(atLimit.record).toMatchObject({ state: 'whole', bytesRead: 42 })
    atLimit.discard()
    const past = staged(await capture(at.repo, { ...at.options, limits: { readBytes: 41 } }))
    expect(past.record).toMatchObject({ state: 'incomplete', bound: '41 bytes read' })
    expect(past.record.bytesRead).toBeLessThanOrEqual(41)
    // What it read is kept, so the next capture goes on from there and is whole.
    await published(past)
    const next = staged(await capture(at.repo, { ...at.options, limits: { readBytes: 41 } }))
    expect(next.record).toMatchObject({ state: 'whole' })
    expect(next.record.bytesRead).toBeLessThan(42)
    next.discard()
  })

  it('names the bound in MiB when it is whole MiB', async () => {
    const at = place('mib')
    write(at.repo, 'big.bin', Buffer.alloc(1024 * 1024 + 1, 7))
    const past = staged(await capture(at.repo, { ...at.options, limits: { readBytes: 1024 * 1024 } }))
    expect(past.record).toMatchObject({ state: 'incomplete', bound: '1 MiB read' })
    past.discard()
  })

  it('counts bytes while they are read, so a file that grows cannot pass the bound', async () => {
    const at = place('grows')
    write(at.repo, 'grows.txt', 'x'.repeat(60))
    const outcome = staged(await capture(at.repo, {
      ...at.options,
      limits: { readBytes: 100 },
      seams: { duringRead: (path) => { if (path === 'grows.txt') appendFileSync(join(at.repo, path), 'y'.repeat(5000)) } }
    }))
    expect(outcome.record).toMatchObject({ state: 'incomplete', bound: '100 bytes read' })
    expect(outcome.record.bytesRead).toBeLessThanOrEqual(101)
    outcome.discard()
  })

  it('reads a file of exactly the size limit, and holds a larger one as "too large, not read" with its size and time', async () => {
    const at = place('file-size')
    write(at.repo, 'at.bin', Buffer.alloc(64, 1))
    write(at.repo, 'past.bin', Buffer.alloc(65, 1))
    const record = await published(staged(await capture(at.repo, { ...at.options, limits: { fileBytes: 64 } })))
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    expect(rowAt(store, record.tree, 'at.bin')?.slice(1, 2)).toEqual(['f'])
    const past = rowAt(store, record.tree, 'past.bin') as TreeRow
    expect(past.slice(0, 3)).toEqual(['past.bin', 'x', 65])
    expect(past[3]).toBeGreaterThan(Date.now() - 60_000)
    expect(record).toMatchObject({ state: 'whole', counts: { tooLarge: 1 }, bytesRead: 64 + 2 })
  })

  it('ends as incomplete when its time is up, naming the time, keeps what it read without a list, and the next capture goes on from there', async () => {
    const at = place('time')
    four(at)
    // A file is taken as read before only when it had been still for a moment when it was read.
    await sleep(25)
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const began = performance.now()
    let seen = 0
    // The third entry is held back until the reading's time is over (the last 75 of 600 ms): nothing after it is read.
    const slow = staged(await capture(at.repo, {
      ...at.options, store, limits: { captureMs: 600 },
      seams: {
        beforeEntry: async () => {
          seen += 1
          if (seen === 3) await sleep(Math.max(0, began + 535 - performance.now()))
        }
      }
    }))
    expect(slow.record).toMatchObject({ state: 'incomplete', bound: '0.6 s', tree: null })
    expect(slow.tookMs).toBeLessThan(600)
    const kept = await published(slow)
    // What it read is in the store and its cache names it; no list was written once its time had passed.
    expect(kept).toMatchObject({ state: 'incomplete', bound: '0.6 s', tree: null })
    expect(kept.bytesStored).toBeGreaterThan(0)
    expect(filesUnder(join(store.directory, 'objects', 'trees'))).toBe(0)
    const next = staged(await capture(at.repo, { ...at.options, store }))
    expect(next.record.state).toBe('whole')
    expect(next.record.bytesRead).toBeGreaterThan(0)
    expect(next.record.bytesRead).toBeLessThan(42)
    next.discard()
    // A sweep keeps the files a kept capture's cache names, though no list of that capture does.
    const before = filesUnder(join(store.directory, 'objects', 'blobs'))
    expect(store.removeCaptures([])).toBe(1)
    expect(filesUnder(join(store.directory, 'objects', 'blobs'))).toBe(before)
  })

  it('is never whole when its time passes while its record is made, while its files are moved in or before its last step', async () => {
    // 1. While the record is made: the sliced work must be through a little before the capture's time.
    const first = place('time-record')
    four(first)
    await sleep(25)
    const late = staged(await capture(first.repo, { ...first.options, limits: { captureMs: 300 }, seams: { beforeRecord: () => sleep(320) } }))
    expect(late.record).toMatchObject({ state: 'incomplete', bound: '0.3 s', tree: null })
    late.discard()

    // 2. While files are moved in: what was moved stays and is named by the cache, the rest is dropped.
    const second = place('time-moves')
    for (let n = 0; n < 20; n += 1) write(second.repo, `f${String(n).padStart(2, '0')}.txt`, `content ${String(n).padStart(2, '0')}\n`)
    await sleep(25)
    const store = new TurnStore(second.dataRoot, 's-case', second.repo)
    const drops: number[] = []
    const cut = staged(await capture(second.repo, {
      ...second.options, store, limits: { captureMs: 400 }, dropped: (bytes) => drops.push(bytes),
      seams: { beforeMove: (moved) => (moved === 5 ? sleep(420) : undefined) }
    }))
    expect(cut.record.state).toBe('whole')
    const done = await cut.publish()
    expect(done?.record).toMatchObject({ state: 'incomplete', bound: '0.4 s', tree: null, base: null })
    expect(done?.tookMs).toBeGreaterThan(400)
    await store.settled()
    expect(filesUnder(join(store.directory, 'objects', 'blobs'))).toBe(5)
    expect(filesUnder(join(store.directory, 'objects', 'trees'))).toBe(0)
    expect(filesUnder(join(store.directory, 'staging'))).toBe(0)
    expect(filesUnder(join(store.directory, 'trash'))).toBe(0)
    // What it added and what it dropped are, together, what it had staged.
    expect(done?.record.bytesStored).toBe(5 * 'content 00\n'.length)
    expect((done?.record.bytesStored ?? 0) + drops.reduce((sum, bytes) => sum + bytes, 0)).toBe(cut.record.bytesStored)
    const next = staged(await capture(second.repo, { ...second.options, store }))
    expect(next.record).toMatchObject({ state: 'whole', bytesRead: cut.record.bytesRead - 5 * 'content 00\n'.length })
    next.discard()

    // 3. Before the last step, with everything moved in: the record says so and keeps its lists.
    const third = place('time-last')
    four(third)
    await sleep(25)
    const last = staged(await capture(third.repo, { ...third.options, limits: { captureMs: 300 }, seams: { beforeLastLook: () => sleep(320) } }))
    expect(last.record.state).toBe('whole')
    const ended = await last.publish()
    expect(ended?.record).toMatchObject({ state: 'incomplete', bound: '0.3 s', base: null })
    expect(ended?.record.tree).not.toBeNull()
    expect(ended?.tookMs).toBeGreaterThan(300)
    const after = staged(await capture(third.repo, third.options))
    expect(after.record).toMatchObject({ state: 'whole', bytesRead: 0 })
    after.discard()
  })

  it('stops a publication between two files within 100 ms: no record appears and what it moved in goes again', async () => {
    const at = place('publish-stop')
    for (let n = 0; n < 2_000; n += 1) write(at.repo, `many/f${n}.txt`, `content ${n}\n`)
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const drops: Array<{ bytes: number; gone: Promise<boolean> }> = []
    let stopAt = 0
    const one = staged(await capture(at.repo, {
      ...at.options, store, dropped: (bytes, gone) => drops.push({ bytes, gone }),
      seams: {
        beforeMove: (moved) => {
          if (moved === 1_000 && stopAt === 0) stopAt = performance.now()
        }
      }
    }))
    expect(one.record.state).toBe('whole')
    const done = await one.publish(() => stopAt !== 0)
    expect(done).toBeNull()
    expect(performance.now() - stopAt).toBeLessThan(100)
    expect(store.captures()).toEqual([])
    expect(isCapturing(at.repo)).toBe(false)
    // Every byte it had staged is on its way out, and then gone.
    expect(drops.map((drop) => drop.bytes)).toEqual([one.record.bytesStored])
    expect(await drops[0]?.gone).toBe(true)
    expect(filesUnder(at.dataRoot)).toBe(0)
    const again = staged(await capture(at.repo, { ...at.options, store }))
    expect((await published(again)).state).toBe('whole')
  })

  /** Git that does not answer the last question of a capture (which commit HEAD names at its end, and in a nested repository). */
  const slowHead = (at: Place): string => {
    const path = join(at.base, 'git-slow-head')
    writeFileSync(path, '#!/bin/sh\ncase "$*" in *"--verify --quiet"*) exec sleep 30;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    return path
  }

  it('gives its last Git command no time of its own: a capture whose time passes there is incomplete, inside its time', async () => {
    const at = place('time-head')
    four(at)
    // A file is taken as read before only when it had been still for a moment when it was read.
    await sleep(25)
    const began = performance.now()
    const late = staged(await capture(at.repo, { ...at.options, git: slowHead(at), limits: { captureMs: 300 } }))
    expect(performance.now() - began).toBeLessThan(300 + 80)
    expect(late.tookMs).toBeLessThan(300 + 50)
    expect(late.record).toMatchObject({ state: 'incomplete', bound: '0.3 s', headEnd: null, base: null, tree: null })
    // Its time is over: nothing more is moved in, and its record says so.
    expect(await published(late)).toMatchObject({ state: 'incomplete', bound: '0.3 s', tree: null, bytesStored: 0 })
    const next = staged(await capture(at.repo, at.options))
    expect(next.record).toMatchObject({ state: 'whole' })
    next.discard()
  })

  it('writes down no commit for a nested repository whose Git did not answer in the capture\'s time', async () => {
    const at = place('time-nested')
    mkdirSync(join(at.repo, 'nested'))
    at.git(join(at.repo, 'nested'), 'init', '-q', '-b', 'main')
    write(at.repo, 'nested/deep.txt', 'd\n')
    const began = performance.now()
    const late = staged(await capture(at.repo, { ...at.options, git: slowHead(at), limits: { captureMs: 300 } }))
    expect(performance.now() - began).toBeLessThan(300 + 150)
    expect(late.record).toMatchObject({ state: 'incomplete', bound: '0.3 s', counts: { submodules: 0 } })
    late.discard()
  })

  it('is not whole when its time passes while the earlier capture\'s paths are looked at or its lists are written, and is cancelled there too', async () => {
    const at = place('time-late')
    four(at)
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const base = await published(staged(await capture(at.repo, { ...at.options, store })))
    unlinkSync(join(at.repo, 'a.txt'))
    for (const seam of ['beforeProbes', 'beforeLists'] as const) {
      const late = staged(await capture(at.repo, { ...at.options, store, base: base.id, limits: { captureMs: 80 }, seams: { [seam]: () => sleep(120) } }))
      expect(late.record, seam).toMatchObject({ state: 'incomplete', bound: '0.08 s', base: null, gone: [], left: [] })
      late.discard()
      const controller = new AbortController()
      const cancelled = await capture(at.repo, { ...at.options, store, base: base.id, signal: controller.signal, seams: { [seam]: () => controller.abort() } })
      expect(cancelled, seam).toEqual({ state: 'cancelled', reason: 'cancelled' })
      await store.settled()
      expect(filesUnder(join(store.directory, 'staging')) + filesUnder(join(store.directory, 'trash')), seam).toBe(0)
      expect(isCapturing(at.repo)).toBe(false)
    }
    const whole = staged(await capture(at.repo, { ...at.options, store, base: base.id }))
    expect(whole.record).toMatchObject({ state: 'whole', gone: ['a.txt'] })
    whole.discard()
  })

  it('ends as "store full" when what it would put on disk passes the bound by one byte, and removes nothing that is kept', async () => {
    const at = place('full')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const first = staged(await capture(at.repo, { ...at.options, store }))
    const firstAdds = first.adds
    await published(first)
    // What a capture adds is its files and lists, its own record and what the cache grows by: all of it is on disk.
    const kept = store.keptBytes()
    expect(kept).toBe(firstAdds)
    expect(kept).toBeGreaterThan(store.size('objects'))
    write(at.repo, 'big.txt', 'z'.repeat(500))
    const probe = staged(await capture(at.repo, { ...at.options, store }))
    const adds = probe.adds
    expect(adds).toBeGreaterThan(500)
    probe.discard()
    await store.settled()
    const full = staged(await capture(at.repo, { ...at.options, store, limits: { storeBytes: kept + adds - 1 } }))
    expect(full.record).toMatchObject({ state: 'incomplete', bound: 'store full', tree: null, bytesStored: 0 })
    await published(full)
    await store.settled()
    // Only the few bytes of its record are new; they were counted and fit.
    expect(store.keptBytes()).toBe(kept + full.adds)
    expect(full.adds).toBeLessThan(adds - 500)
    expect(store.record(first.record.id)?.state).toBe('whole')
    const fits = staged(await capture(at.repo, { ...at.options, store, limits: { storeBytes: store.keptBytes() + adds } }))
    expect(fits.record.state).toBe('whole')
    fits.discard()
    await store.settled()
    // A store with no room even for a record gets nothing at all, however often a capture is taken.
    const before = store.keptBytes()
    for (let round = 0; round < 3; round += 1) {
      const none = staged(await capture(at.repo, { ...at.options, store, limits: { storeBytes: before + 10 } }))
      expect(none.record).toMatchObject({ state: 'incomplete', bound: 'store full', tree: null })
      expect(none.adds).toBe(0)
      const record = await published(none)
      await store.settled()
      expect(store.record(record.id)).toBeNull()
      expect(store.keptBytes()).toBe(before)
    }
  })

  it('does not let a capture of an unchanged work tree pass the bound with its record', async () => {
    const at = place('full-unchanged')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    await published(staged(await capture(at.repo, { ...at.options, store })))
    const kept = store.keptBytes()
    const again = staged(await capture(at.repo, { ...at.options, store, limits: { storeBytes: kept + 10 } }))
    expect(again.record).toMatchObject({ state: 'incomplete', bound: 'store full', bytesStored: 0 })
    await published(again)
    expect(store.keptBytes()).toBe(kept)
  })

  it('stops a listing that does not end in time, and keeps nothing of it', async () => {
    const at = place('slow-list')
    const slow = join(at.base, 'git-slow-list')
    writeFileSync(slow, '#!/bin/sh\ncase "$*" in *ls-files*) exec sleep 30;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    const outcome = staged(await capture(at.repo, { ...at.options, git: slow, limits: { captureMs: 200 } }))
    expect(outcome.record).toMatchObject({ state: 'incomplete', bound: '0.2 s', tree: null })
    expect(outcome.tookMs).toBeLessThan(1500)
    outcome.discard()
  })
})

describe('a capture that is cancelled, or discarded', () => {
  it('stops within 100 ms, publishes nothing and leaves no staged byte and no lock', async () => {
    const at = place('cancel')
    for (let n = 0; n < 40; n += 1) write(at.repo, `f${n}.txt`, `content ${n}\n`)
    const before = snapshot(at.repo)
    const controller = new AbortController()
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    let cancelledAt = 0
    let seen = 0
    const outcome = await capture(at.repo, {
      ...at.options,
      store,
      signal: controller.signal,
      seams: {
        beforeEntry: async () => {
          seen += 1
          if (seen === 10) {
            cancelledAt = performance.now()
            controller.abort()
          }
          if (seen >= 10) await sleep(6)
        }
      }
    })
    expect(outcome).toEqual({ state: 'cancelled', reason: 'cancelled' })
    expect(performance.now() - cancelledAt).toBeLessThan(100)
    // The bytes leave `staging/` in the same step and are gone right after.
    expect(filesUnder(join(store.directory, 'staging'))).toBe(0)
    await store.settled()
    expect(filesUnder(at.dataRoot)).toBe(0)
    expect(store.captures()).toEqual([])
    expect(isCapturing(at.repo)).toBe(false)
    expect(unequal(before, snapshot(at.repo))).toEqual([])
    expect(existsSync(join(at.repo, '.git', 'index.lock'))).toBe(false)
  })

  it('is cancelled before it starts when the signal is already raised', async () => {
    const at = place('cancel-early')
    expect(await capture(at.repo, { ...at.options, signal: AbortSignal.abort() })).toEqual({ state: 'cancelled', reason: 'cancelled' })
    expect(filesUnder(at.dataRoot)).toBe(0)
  })

  it('answers "busy" for a root whose capture is not yet published or discarded, and never publishes a discarded one', async () => {
    const at = place('busy')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const first = staged(await capture(at.repo, { ...at.options, store }))
    expect(isCapturing(at.repo)).toBe(true)
    expect(await capture(at.repo, { ...at.options, session: 's-other' })).toEqual({ state: 'busy', reason: 'busy' })
    first.discard()
    await expect(first.publish()).rejects.toThrow()
    await store.settled()
    expect(store.captures()).toEqual([])
    expect(filesUnder(at.dataRoot)).toBe(0)
    const again = staged(await capture(at.repo, { ...at.options, session: 's-other' }))
    expect(again.record.state).toBe('whole')
    again.discard()
  })

  /** The data root as it is at this moment, copied: what BMN would find at its next start had it ended right now. */
  const crashed = (at: Place, name: string): string => {
    const copy = join(at.base, name)
    cpSync(at.dataRoot, copy, { recursive: true })
    return copy
  }
  /** One kept capture, and a second one whose publication ended after its file was moved in and before its lists and record. */
  const interrupted = async (name: string): Promise<{ at: Place; root: string; first: Awaited<ReturnType<typeof published>>; marker: string }> => {
    const at = place(name)
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    write(at.repo, 'kept.txt', 'KEPT-CONTENT\n')
    const first = await published(staged(await capture(at.repo, { ...at.options, store })))
    const marker = `MARKER-${randomBytes(8).toString('hex')}`
    write(at.repo, 'secret.txt', `${marker}\n`)
    let root = ''
    const second = staged(await capture(at.repo, {
      ...at.options, store,
      seams: {
        beforeMove: (moved) => {
          if (moved === 1) root = crashed(at, 'data-crashed')
        }
      }
    }))
    await second.publish()
    expect(root).not.toBe('')
    return { at, root, first, marker }
  }

  it('removes at the next start what a publication left that was interrupted before its record appeared, and nothing a kept capture needs', async () => {
    const { at, root, first, marker } = await interrupted('interrupted')
    const restarted = new TurnStore(root, 's-case', at.repo)
    expect(restarted.captures()).toEqual([first.id])
    expect(holds(join(restarted.directory, 'objects'), marker)).toBe(true)
    expect(filesUnder(join(restarted.directory, 'staging'))).toBeGreaterThan(0)
    // The next start.
    expect(restarted.clearLeftovers()).toBe(true)
    expect(holds(root, marker)).toBe(false)
    expect(filesUnder(join(restarted.directory, 'staging'))).toBe(0)
    expect(holds(join(restarted.directory, 'objects'), 'KEPT-CONTENT')).toBe(true)
    const again = await published(staged(await capture(at.repo, { ...at.options, dataRoot: root, store: restarted, base: first.id })))
    expect(compareCaptures(restarted, first.id, again.id)).toMatchObject({ state: 'compared', files: [{ path: 'secret.txt', state: 'added' }] })
  })

  it('keeps the folder that says a publication was interrupted until all it left is gone: a clearing that could not finish is done again at the next start', async () => {
    const { at, root, first, marker } = await interrupted('interrupted-twice')
    const restarted = new TurnStore(root, 's-case', at.repo)
    // A list of the kept capture cannot be read: what it needs is not known, so nothing is taken and the folder stays.
    const list = restarted.objectPath('trees', first.tree as string)
    const text = readFileSync(list)
    writeFileSync(list, 'not a list')
    expect(restarted.clearLeftovers()).toBe(false)
    expect(filesUnder(join(restarted.directory, 'staging'))).toBeGreaterThan(0)
    expect(holds(root, marker)).toBe(true)
    // A second start finds the same and leaves the same.
    expect(new TurnStore(root, 's-case', at.repo).clearLeftovers()).toBe(false)
    expect(filesUnder(join(restarted.directory, 'staging'))).toBeGreaterThan(0)
    expect(holds(join(restarted.directory, 'objects'), 'KEPT-CONTENT')).toBe(true)
    // Once the list can be read the next start finishes the work.
    writeFileSync(list, text)
    const third = new TurnStore(root, 's-case', at.repo)
    expect(third.clearLeftovers()).toBe(true)
    expect(holds(root, marker)).toBe(false)
    expect(filesUnder(join(third.directory, 'staging'))).toBe(0)
    expect(holds(join(third.directory, 'objects'), 'KEPT-CONTENT')).toBe(true)
    expect(third.captures()).toEqual([first.id])
  })

  it('takes out again what a publication moved in when its record cannot appear, and keeps what was there', async () => {
    const at = place('publication-fails')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    write(at.repo, 'kept.txt', 'KEPT-CONTENT\n')
    const first = await published(staged(await capture(at.repo, { ...at.options, store })))
    const marker = `MARKER-${randomBytes(8).toString('hex')}`
    write(at.repo, 'secret.txt', `${marker}\n`)
    const second = staged(await capture(at.repo, { ...at.options, store }))
    // The record's place cannot be taken.
    mkdirSync(store.capturePath(second.record.id), { recursive: true })
    await expect(second.publish()).rejects.toThrow()
    rmSync(store.capturePath(second.record.id), { recursive: true })
    await store.settled()
    expect(store.captures()).toEqual([first.id])
    expect(holds(at.dataRoot, marker)).toBe(false)
    expect(filesUnder(join(store.directory, 'staging'))).toBe(0)
    expect(readdirSync(join(store.directory, 'captures'))).toEqual([`${first.id}.json`])
    expect(existsSync(join(store.directory, 'cache.json.new'))).toBe(false)
    expect(holds(join(store.directory, 'objects'), 'KEPT-CONTENT')).toBe(true)
    expect(isCapturing(at.repo)).toBe(false)
    const again = await published(staged(await capture(at.repo, { ...at.options, store, base: first.id })))
    expect(compareCaptures(store, first.id, again.id)).toMatchObject({ state: 'compared', files: [{ path: 'secret.txt', state: 'added' }] })
  })

  it.skipIf(process.getuid?.() === 0)('removes the whole store at the next start when its very first publication was interrupted, also when that start is interrupted itself', async () => {
    const at = place('interrupted-first')
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const marker = `MARKER-${randomBytes(8).toString('hex')}`
    write(at.repo, 'secret.txt', `${marker}\n`)
    let root = ''
    const only = staged(await capture(at.repo, {
      ...at.options, store,
      seams: {
        beforeMove: (moved) => {
          if (moved === 1) root = crashed(at, 'data-crashed')
        }
      }
    }))
    await only.publish()
    expect(holds(root, marker)).toBe(true)
    const restarted = new TurnStore(root, 's-case', at.repo)
    expect(restarted.captures()).toEqual([])
    // The start cannot remove one folder of stored files: it ends with the folder in `staging/` still there.
    const blobs = join(restarted.directory, 'objects', 'blobs')
    const locked = join(blobs, readdirSync(blobs)[0] as string)
    chmodSync(locked, 0o500)
    expect(restarted.clearLeftovers()).toBe(false)
    expect(filesUnder(join(restarted.directory, 'staging'))).toBeGreaterThan(0)
    chmodSync(locked, 0o700)
    // The start after it finishes the work.
    expect(new TurnStore(root, 's-case', at.repo).clearLeftovers()).toBe(true)
    expect(holds(root, marker)).toBe(false)
    expect(filesUnder(root)).toBe(0)
    // A start with nothing interrupted leaves a store as it is.
    const kept = await published(staged(await capture(at.repo, { ...at.options, store: new TurnStore(at.dataRoot, 's-case', at.repo) })))
    const later = new TurnStore(at.dataRoot, 's-case', at.repo)
    const before = snapshot(later.directory)
    later.clearLeftovers()
    // Only the empty folders for staged and discarded captures go.
    expect(unequal(before, snapshot(later.directory)).filter((name) => !name.endsWith('/'))).toEqual([])
    expect(later.record(kept.id)?.state).toBe('whole')
  })

  it('keeps every folder of the store private, and no path of the work tree in a folder name', async () => {
    const at = place('private')
    write(at.repo, 'named-like-a-secret.txt', 's\n')
    const record = await published(staged(await capture(at.repo, at.options)))
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const walk = snapshot(at.dataRoot)
    for (const [path, told] of Object.entries(walk)) {
      if (path.endsWith('/')) expect(told, path).toMatch(/^folder 40700 /)
      else expect(told, path).toMatch(/^file 100600 /)
      expect(path).not.toContain('named-like-a-secret')
    }
    expect(store.record(record.id)?.root).toBe(at.repo)
  })
})

describe('a comparison that cannot be made', () => {
  it('is unavailable with the reason when a capture is incomplete or gone, never zero', async () => {
    const at = place('unavailable')
    write(at.repo, 'a.txt', 'a\n')
    const whole = await published(staged(await capture(at.repo, at.options)))
    const incomplete = await published(staged(await capture(at.repo, { ...at.options, limits: { entries: 1 } })))
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    expect(compareCaptures(store, whole.id, incomplete.id)).toEqual({ state: 'unavailable', reason: 'a capture is incomplete', bound: '1 entries' })
    expect(compareCaptures(store, whole.id, 'no-such-capture')).toEqual({ state: 'unavailable', reason: 'a capture is gone' })
    expect(fileDifference(store, 'no-such-capture', whole.id, 'a.txt')).toEqual({ state: 'unavailable', reason: 'a capture is gone' })
    expect(compareCaptures(store, whole.id, '../../escape')).toEqual({ state: 'unavailable', reason: 'a capture is gone' })
  })

  it('ends as "Difference unavailable: limit reached" when its time is up, and as cancelled when it is cancelled', async () => {
    const at = place('limit')
    const long = (prefix: string): string => `${Array.from({ length: 60000 }, (_, n) => `${prefix}${n}`).join('\n')}\n`
    write(at.repo, 'long.txt', long('a'))
    const one = await published(staged(await capture(at.repo, at.options)))
    write(at.repo, 'long.txt', long('b'))
    const two = await published(staged(await capture(at.repo, { ...at.options, base: one.id })))
    const run = { one, two, store: new TurnStore(at.dataRoot, 's-case', at.repo) }
    const began = performance.now()
    expect(compareCaptures(run.store, run.one.id, run.two.id, { limitMs: 20 })).toEqual({ state: 'unavailable', reason: 'Difference unavailable: limit reached' })
    expect(fileDifference(run.store, run.one.id, run.two.id, 'long.txt', { limitMs: 20 })).toEqual({ state: 'unavailable', reason: 'Difference unavailable: limit reached' })
    expect(performance.now() - began).toBeLessThan(400)
    const cancelAt = performance.now() + 30
    const cancelledAt = performance.now()
    expect(compareCaptures(run.store, run.one.id, run.two.id, { cancelled: () => performance.now() > cancelAt })).toEqual({ state: 'cancelled', reason: 'cancelled' })
    expect(performance.now() - cancelledAt).toBeLessThan(130)
  }, 30_000)

  it('can be stopped, and runs out of time, where nothing differs and one entry was not read: every folder and entry it walks is a place to stop', async () => {
    const at = place('walk-stop')
    for (let n = 0; n < 2_000; n += 1) write(at.repo, `d${n % 50}/f${n}.txt`, `content ${n}\n`)
    write(at.repo, 'large.bin', 'x'.repeat(200))
    await sleep(25)
    const limits = { fileBytes: 64 }
    const store = new TurnStore(at.dataRoot, 's-case', at.repo)
    const one = await published(staged(await capture(at.repo, { ...at.options, store, limits })))
    const two = await published(staged(await capture(at.repo, { ...at.options, store, limits, base: one.id })))
    // Nothing changed: the two trees are one, and the one file over the limit reads the same in both.
    expect(two.tree).toBe(one.tree)
    expect(compareCaptures(store, one.id, two.id)).toMatchObject({ state: 'compared', files: [{ path: 'large.bin', state: 'not read' }], totals: { partial: true } })
    // Stopped before it began.
    expect(compareCaptures(store, one.id, two.id, { cancelled: () => true })).toEqual({ state: 'cancelled', reason: 'cancelled' })
    // Its time passes while folder lists are read: it stops at the next folder and is never given as done.
    let reads = 0
    const slow = new (class extends TurnStore {
      override tree(hash: string): ReturnType<TurnStore['tree']> {
        reads += 1
        const until = performance.now() + 4
        while (performance.now() < until) {
          // A folder list that takes 4 ms to read.
        }
        return super.tree(hash)
      }
    })(at.dataRoot, 's-case', at.repo)
    expect(compareCaptures(slow, one.id, two.id, { limitMs: 40 })).toEqual({ state: 'unavailable', reason: 'Difference unavailable: limit reached' })
    // 51 folders of 4 ms each would be 204 ms: it read about ten of them.
    expect(reads).toBeLessThan(20)
    // Stopped at the very last place it asks, after the last folder: not given as done either.
    let places = 0
    expect(compareCaptures(store, one.id, two.id, { cancelled: () => (places += 1) < 0 }).state).toBe('compared')
    expect(places).toBeGreaterThan(100)
    let asked = 0
    expect(compareCaptures(store, one.id, two.id, { cancelled: () => (asked += 1) >= places })).toEqual({ state: 'cancelled', reason: 'cancelled' })
    // It was asked once more, to tell a stop from a time that passed.
    expect(asked).toBe(places + 1)
  }, 30_000)

  it('refuses to compare across a change of the repository\'s object format', async () => {
    const at = place('format-changed')
    const first = await published(staged(await capture(at.repo, at.options)))
    rmSync(join(at.repo, '.git'), { recursive: true, force: true })
    at.git(at.repo, 'init', '-q', '-b', 'main', '--object-format=sha256')
    const second = await published(staged(await capture(at.repo, { ...at.options, base: first.id })))
    expect(second.objectFormat).toBe('sha256')
    expect(compareCaptures(new TurnStore(at.dataRoot, 's-case', at.repo), first.id, second.id)).toEqual({ state: 'unavailable', reason: "the repository's object format changed" })
  })
})
