// MODULE: package-preflight.test.mjs - Story 102.9: a manual package cannot replace the live build of an open BMN; a source change stops the swap
import { describe, expect, it } from 'vitest'
import { packageRefusal } from '../install/package-preflight.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceChangeSince, trackedFilesStamp } from '../install/update-desktop.mjs'

const clean = { branch: 'main', head: 'a'.repeat(40), originHead: 'a'.repeat(40), status: '' }

describe('pnpm run package while BMN is open (102.9 AC3)', () => {
  it('refuses in the main checkout and says to queue the update', () => {
    expect(packageRefusal({ linkedWorktree: false, staged: false, runningPids: [41, 42] })).toContain('Queue `pnpm run update:desktop`')
    expect(packageRefusal({ linkedWorktree: false, staged: false, runningPids: [41] })).toContain('process 41')
  })

  it('runs as today with BMN closed, in a linked worktree and from the updater', () => {
    expect(packageRefusal({ linkedWorktree: false, staged: false, runningPids: [] })).toBeNull()
    expect(packageRefusal({ linkedWorktree: true, staged: false, runningPids: [41] })).toBeNull()
    expect(packageRefusal({ linkedWorktree: false, staged: true, runningPids: [41] })).toBeNull()
  })
})

describe('source between the build\'s start and the swap (102.9 AC1, AC2)', () => {
  it('says what changed', () => {
    expect(sourceChangeSince(clean, { ...clean, status: ' M docs/x.md' })).toBe('working tree is not clean')
    expect(sourceChangeSince(clean, { ...clean, head: 'b'.repeat(40), originHead: 'b'.repeat(40) })).toContain('HEAD moved')
    expect(sourceChangeSince(clean, { ...clean, originHead: 'b'.repeat(40) })).toContain('does not match origin/main')
    expect(sourceChangeSince(clean, clean)).toBeNull()
    expect(sourceChangeSince(clean, { ...clean, touched: 'other' })).toContain('written during the build')
  })

  it('tells a file changed for the compiler and put back, though its bytes are the same again', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-source-stamp-'))
    try {
      const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(root, 'a.ts'), 'one\n')
      git('add', '.')
      const before = trackedFilesStamp(root)
      expect(trackedFilesStamp(root)).toBe(before)
      writeFileSync(join(root, 'a.ts'), 'two\n')
      writeFileSync(join(root, 'a.ts'), 'one\n')
      expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\n')
      expect(git('status', '--porcelain').stdout.includes('M a.ts')).toBe(false)
      expect(trackedFilesStamp(root)).not.toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
