import { describe, expect, it } from 'vitest'
import { assertOwnerRootsAbsent, assertOwnerRootsUnchanged, fingerprintOwnerRoots } from '../lib/owner-root-guard.mjs'

describe('owner root guard', () => {
  it('allows a run only when every real root is absent', () => {
    expect(() =>
      assertOwnerRootsAbsent(['/owner/config', '/owner/data'], 'before test', () => false)
    ).not.toThrow()
  })

  it('refuses before launch when any real root already exists', () => {
    expect(() =>
      assertOwnerRootsAbsent(
        ['/owner/config', '/owner/data'],
        'before test',
        (path) => path === '/owner/data'
      )
    ).toThrow(/must be absent before test.*\/owner\/data/i)
  })

  it('fingerprints existing roots recursively and skips absent ones', () => {
    const tree = { '/owner/config': ['db'], '/owner/config/db': null }
    const fs = {
      existsSync: (path) => path in tree,
      readdirSync: (path) => tree[path],
      lstatSync: (path) => ({ isDirectory: () => tree[path] !== null, size: 7, mtimeMs: 1 })
    }
    expect(fingerprintOwnerRoots(['/owner/config', '/owner/data'], fs)).toEqual([
      '/owner/config\tdir\t1',
      '/owner/config/db\t7\t1'
    ])
  })

  it('refuses when a run changed anything under the real roots', () => {
    const before = ['/owner/config\tdir\t1', '/owner/config/db\t7\t1']
    expect(() => assertOwnerRootsUnchanged(before, [...before], 'after test')).not.toThrow()
    expect(() => assertOwnerRootsUnchanged(before, ['/owner/config\tdir\t1', '/owner/config/db\t9\t2'], 'after test'))
      .toThrow(/changed after test.*\/owner\/config\/db/i)
    expect(() => assertOwnerRootsUnchanged([], ['/owner/data\tdir\t3'], 'after test')).toThrow(/\/owner\/data/)
  })

  it('leaves out writes inside a team ask run that was there before, and still refuses a new run', () => {
    const runs = '/owner/config/runs'
    const before = [`${runs}\tdir\t1`, `${runs}/old\tdir\t1`, `${runs}/old/events.jsonl\t7\t1`]
    const grown = [`${runs}\tdir\t1`, `${runs}/old\tdir\t2`, `${runs}/old/events.jsonl\t9\t2`, `${runs}/old/stderr.txt\t3\t2`]
    expect(() => assertOwnerRootsUnchanged(before, grown, 'during smoke', { runFolders: [runs] })).not.toThrow()
    expect(() => assertOwnerRootsUnchanged(before, grown, 'during smoke')).toThrow(/\/owner\/config\/runs\/old/)
    const added = [`${runs}\tdir\t3`, ...before.slice(1), `${runs}/new\tdir\t3`]
    expect(() => assertOwnerRootsUnchanged(before, added, 'during smoke', { runFolders: [runs] })).toThrow(/runs\/new/)
    // Only direct children of a run folder count as runs: a deeper folder that existed before excuses nothing beside it.
    const nested = [...before, `${runs}/old/inputs\tdir\t1`]
    expect(() => assertOwnerRootsUnchanged(nested, [...nested, '/owner/config/db\t1\t1'], 'during smoke', { runFolders: [runs] }))
      .toThrow(/\/owner\/config\/db/)
  })
})
