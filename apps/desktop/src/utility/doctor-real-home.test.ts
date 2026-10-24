// MODULE: doctor-real-home.test.ts - Owner-shaped coverage, route provenance and shared publication regressions
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { locationRoots, observeTree, unchangedSince } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'

const folders: string[] = []
afterEach(() => { for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }) })
const fixture = (): string => { const p = mkdtempSync(join(tmpdir(), 'bmn-real-home-')); folders.push(p); return p }

it('reads a 462-entry memory tree within the measured headroom and locates it without searching the home', () => {
  const home = fixture()
  const folder = join(home, ...Array.from({ length: 18 }, (_, i) => `level-${i}`), 'memory')
  mkdirSync(folder, { recursive: true })
  for (let i = 0; i < 461; i += 1) writeFileSync(join(folder, `entry-${i}.md`), 'synthetic memory')
  const roots = locationRoots(selectedProfile({ HOME: home }))
  const observation = observeTree(folder, roots)
  expect(observation.files.size).toBe(461)
  expect(unchangedSince(observation)).toBe(true)
  expect(observation.locator).toMatchObject({ status: 'located', root: 'home' })
  expect(observation.locator.status === 'located' && 'route' in observation.locator && observation.locator.route?.length).toBe(18)
})

it('allows exactly 1024 observed tree entries and refuses the next entry', () => {
  const home = fixture(), folder = join(home, 'memory')
  mkdirSync(folder)
  for (let i = 0; i < 1023; i += 1) writeFileSync(join(folder, `entry-${i}`), 'synthetic')
  const roots = locationRoots(selectedProfile({ HOME: home }))
  expect(observeTree(folder, roots).files.size).toBe(1023)
  writeFileSync(join(folder, 'next'), 'synthetic')
  expect(() => observeTree(folder, roots)).toThrow(expect.objectContaining({ code: 'BOUND_EXCEEDED' }))
})

it('rejects a renamed entry rather than assigning its old coordinates to a replacement', () => {
  const home = fixture(), folder = join(home, 'selected')
  mkdirSync(folder)
  writeFileSync(join(folder, 'child'), 'synthetic')
  const roots = locationRoots(selectedProfile({ HOME: home }))
  const observed = observeTree(folder, roots)
  renameSync(folder, join(home, 'renamed'))
  expect(unchangedSince(observed)).toBe(false)
})
