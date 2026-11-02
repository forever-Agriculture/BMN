// MODULE: package-preflight.test.mjs - Story 102.9: a manual package cannot replace the live build of an open BMN; a source change stops the swap
import { describe, expect, it } from 'vitest'
import { packageRefusal } from '../install/package-preflight.mjs'
import { sourceChangeSince } from '../install/update-desktop.mjs'

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
  })
})
