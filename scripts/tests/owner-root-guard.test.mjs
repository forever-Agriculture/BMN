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
      statSync: (path) => ({ isDirectory: () => tree[path] !== null, size: 7, mtimeMs: 1 })
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
})
