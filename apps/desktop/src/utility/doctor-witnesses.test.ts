// MODULE: doctor-witnesses.test.ts - Complete traversal, absence and access witnesses for private continuity
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as locations from '../../bin/doctor-locations.mjs'

const folders: string[] = []
const fixture = (): string => { const path = mkdtempSync(join(tmpdir(), 'bmn-private-witness-')); folders.push(path); return path }
afterEach(() => { for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }) })

it('tracks intermediate relative link targets even when the final object stays identical', () => {
  const root = fixture(); mkdirSync(join(root, 'target')); writeFileSync(join(root, 'target/file'), 'synthetic')
  symlinkSync('target', join(root, 'pivot')); symlinkSync('pivot/file', join(root, 'alias'))
  const observation = locations.observeRoute(join(root, 'alias'))
  expect(locations.routeUnchanged(observation)).toBe(true)
  symlinkSync('target', join(root, 'other')); rmSync(join(root, 'pivot')); symlinkSync('other', join(root, 'pivot'))
  expect(locations.routeUnchanged(observation)).toBe(false)
})

it('interprets parent traversal after the followed link and permits unrelated siblings', () => {
  const root = fixture(); mkdirSync(join(root, 'links')); mkdirSync(join(root, 'target/inner'), { recursive: true })
  writeFileSync(join(root, 'target/file'), 'synthetic'); symlinkSync('../target/inner', join(root, 'links/alias'))
  const observation = locations.observeRoute(join(root, 'links/alias') + '/../file')
  expect(locations.routeUnchanged(observation)).toBe(true)
  writeFileSync(join(root, 'unrelated'), 'synthetic')
  expect(locations.routeUnchanged(observation)).toBe(true)
})

it('distinguishes absent and blocked routes, and rejects a missing target appearing', () => {
  const root = fixture(); symlinkSync('missing/deep', join(root, 'link'))
  const missing = locations.observeAbsent(join(root, 'link'))
  expect(missing.outcome).toBe('absent'); expect(locations.absenceUnchanged(missing)).toBe(true)
  mkdirSync(join(root, 'missing/deep'), { recursive: true })
  expect(locations.absenceUnchanged(missing)).toBe(false)
  writeFileSync(join(root, 'file'), 'synthetic')
  const blocked = locations.observeAbsent(join(root, 'file/child'))
  expect(blocked.outcome).toBe('blocked'); expect(locations.absenceUnchanged(blocked)).toBe(true)
})

it('records actual execution access and refuses a changed permission or missing route', () => {
  const root = fixture(); const path = join(root, 'program'); writeFileSync(path, 'synthetic'); chmodSync(path, 0o700)
  const executable = locations.observeAccess(path)
  expect(executable.outcome).toBe(true); expect(locations.accessUnchanged(executable)).toBe(true)
  chmodSync(path, 0o600)
  expect(locations.accessUnchanged(executable)).toBe(false)
  expect(locations.observeAccess(path).outcome).toBe(false)
  expect(locations.observeAccess(join(root, 'missing')).outcome).toBe(false)
})
