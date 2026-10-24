// MODULE: doctor-database-count.test.ts - Physical SQLite source attribution retains the complete acquisition vector
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { locationRoots, observeDatabases, unchangedSince } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'
// This internal session intentionally has no public product API.
// @ts-expect-error private scanner session has no published declarations
import { createInspectionSession, inspectionResult } from '../../bin/doctor-inspection.mjs'

const homes: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture(missing = false) {
  const home = mkdtempSync(join(tmpdir(), 'bmn-db-inputs-')); homes.push(home); mkdirSync(join(home, '.codex'))
  const paths = ['memories_1.sqlite', 'state_5.sqlite'].map(p => join(home, '.codex', p))
  const open = (path: string): DatabaseSync => { const db = new DatabaseSync(path); databases.push(db); db.exec('create table synthetic(value integer)'); return db }
  const dbs = paths.map((path, i) => missing && i === 1 ? null : open(path))
  const profile = selectedProfile({ HOME: home }), session = createInspectionSession(profile, { item: 'a'.repeat(64), context: 'b'.repeat(64) }, Date.now() + 59000)
  return { home, paths, dbs, open, profile, session }
}

it.each(['quiet', 'memories', 'state', 'both', 'wal', 'journal', 'appearance', 'disappearance', 'route', 'siblings'])('counts only changed physical inputs: %s', mutation => {
  const f = fixture(mutation === 'appearance')
  if (mutation === 'wal') f.dbs[0]!.exec('pragma journal_mode=WAL; pragma wal_autocheckpoint=0')
  const source = f.session.databases(f.paths)
  expect(source.known).toBe(true)
  if (mutation === 'memories' || mutation === 'both' || mutation === 'wal') f.dbs[0]!.exec('insert into synthetic values(1)')
  if (mutation === 'state' || mutation === 'both') f.dbs[1]!.exec('insert into synthetic values(1)')
  if (mutation === 'journal') writeFileSync(f.paths[0] + '-journal', 'synthetic journal')
  if (mutation === 'appearance') f.open(f.paths[1]!)
  if (mutation === 'disappearance') rmSync(f.paths[1]!)
  if (mutation === 'siblings') { writeFileSync(join(f.home, '.codex/unrelated.sqlite'), 'unrelated'); writeFileSync(f.paths[0] + '-shm', 'unrelated') }
  if (mutation === 'route') {
    renameSync(join(f.home, '.codex'), join(f.home, 'old')); mkdirSync(join(f.home, '.codex'))
    for (const name of ['memories_1.sqlite', 'state_5.sqlite']) copyFileSync(join(f.home, 'old', name), join(f.home, '.codex', name))
  }
  const expected = ['quiet', 'siblings'].includes(mutation) ? 0 : ['both', 'route'].includes(mutation) ? 2 : 1
  expect(source.stable()).toBe(expected === 0)
  expect(source.changedPaths).toHaveLength(expected)
  if (expected) f.session.gap(source.key, source.kind, { code: 'SOURCE_CHANGED', observationPaths: source.changedPaths }, 'revalidate')
  const result = inspectionResult([], f.session.finish().gaps)
  expect(result.problems).toEqual(expected ? [{ code: 'leftover-source-changed', item: 1, count: expected }] : [])
  expect(JSON.stringify(result)).not.toContain(f.home)
})

it('keeps each part in the shared vector and witnesses, including a missing input', () => {
  const f = fixture(true), observations = observeDatabases(f.paths, locationRoots(f.profile))
  expect(observations.parts.flatMap(p => p.revisions)).toEqual(observations[0]!.revisions)
  expect(observations.parts.flatMap(p => p.routes)).toEqual(observations[0]!.routes)
  expect(observations[0]!.locator.status).toBe('located')
  expect(unchangedSince(observations[0])).toBe(true)
  f.open(f.paths[1]!)
  expect(unchangedSince(observations[0])).toBe(false)
})
