// MODULE: defaults-revisions.test.mjs - Immutable install evidence, refresh leases and retained skill dependencies
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'

const roots = []
const sha = text => createHash('sha256').update(text).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-defaults-revisions-')); roots.push(root)
  const path = join(root, 'ownership.json'), setupId = 'synthetic-revisions'
  const target = { kind: 'own-skills', app: 'source', path: join(root, 'backing/plan'), entry: 'plan' }
  const absent = { kind: 'absent', hash: null, parent: '1:100', object: null }
  const first = { kind: 'tree', hash: 'a'.repeat(64), parent: '1:100', object: '1:200' }
  const next = { kind: 'tree', hash: 'b'.repeat(64), parent: '1:100', object: '1:201' }
  const read = () => readDefaultsOwnership(setupId, { path })
  const initialize = () => initializeDefaultsOwnership(setupId, { path })
  const admitted = work => withDefaultsAdmission(work, { directory: root })
  return { root, path, setupId, target, absent, first, next, read, initialize, admitted }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function installed(f) {
  const journal = f.initialize()
  journal.beginInstall(f.target, 'backing-install', f.absent, f.first)
  journal.completeInstall(f.target, 'backing-install', f.first)
  return journal
}
const entry = (journal, target) => journal.snapshot().entries[defaultsTargetKey(target)]
function refresh(f, journal) {
  journal.beginRefresh(f.target, 'backing-install', { id: 'refresh-1', expectedRevision: 1, old: f.first, next: f.next,
    staging: join(f.root, 'backing/.bmn-stage-refresh-1'), holding: join(f.root, 'backing/.bmn-hold-refresh-1'), recordDigests: {} })
}
function link(f, app, viaSourceInstallId = null) {
  const target = { kind: 'skills', app, path: join(f.root, app, 'plan'), entry: 'plan' }
  const parent = app === 'source' ? '1:101' : '1:102', linkText = f.target.path
  const after = { kind: 'link', hash: sha(linkText), parent, object: app === 'source' ? '1:300' : '1:301' }
  const before = { kind: 'absent', hash: null, parent, object: null }
  const dependency = { backingInstallId: 'backing-install', backingPath: f.target.path, viaSourceInstallId,
    destinationPath: target.path, linkText, destinationFingerprint: after, status: 'pending' }
  return { target, before, after, dependency }
}

describe('setup current revisions and skill dependencies', () => {
  it('refreshes the checked current revision while original install evidence and Undo identity stay immutable', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), original = entry(journal, f.target)
      refresh(f, journal)
      assert.throws(() => journal.completeRefresh(f.target, 'backing-install', 'refresh-1', f.next), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      for (const phase of ['held', 'published', 'metadata']) journal.advanceRefresh(f.target, 'backing-install', 'refresh-1', phase)
      journal.completeRefresh(f.target, 'backing-install', 'refresh-1', f.next)
      const current = entry(f.read(), f.target)
      assert.deepEqual(current.before, original.before); assert.deepEqual(current.after, original.after)
      assert.equal(current.transaction, original.transaction)
      assert.deepEqual(current.current, { revision: 2, fingerprint: f.next })
      assert.equal(f.read().inspect(f.target, f.next), 'installed')
      assert.throws(() => f.read().beginUndo(f.target, 'backing-install', f.first), { code: 'REVISION_CONFLICT' })
      const undo = f.read(); undo.beginUndo(f.target, 'backing-install', f.next); undo.completeUndo(f.target, 'backing-install', f.absent)
      assert.equal(f.read().inspect(f.target, f.absent), 'opted-out')
    })
  })

  for (const at of ['intent', 'held', 'published', 'metadata']) it(`does not infer refresh completion after a restart at ${at}`, () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f); refresh(f, journal)
      for (const phase of ['held', 'published', 'metadata']) { if (at === 'intent') break; journal.advanceRefresh(f.target, 'backing-install', 'refresh-1', phase); if (phase === at) break }
      const restarted = f.read()
      for (const observed of [f.first, f.next, f.absent]) assert.throws(() => restarted.inspect(f.target, observed), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => restarted.completeRefresh(f.target, 'backing-install', 'refresh-1', f.next), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => restarted.beginUndo(f.target, 'backing-install', f.next), { code: 'REVISION_CONFLICT' })
    })
  })

  it('cannot finish a refresh through an object retained after its original admission ended', () => {
    const f = fixture(); let retained
    f.admitted(() => { retained = installed(f); refresh(f, retained); for (const phase of ['held', 'published', 'metadata']) retained.advanceRefresh(f.target, 'backing-install', 'refresh-1', phase) })
    f.admitted(() => assert.throws(() => retained.completeRefresh(f.target, 'backing-install', 'refresh-1', f.next), { code: 'DEFAULTS_STATE_UNAVAILABLE' }))
  })

  it('retains backing while pending links exist, with monotonic opt-out and no restart adoption', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), source = link(f, 'source')
      journal.beginInstall(source.target, 'source-install', source.before, source.after, { dependencies: [source.dependency] })
      assert.equal(journal.dependenciesFor(f.target, 'backing-install')[0].status, 'pending')
      assert.throws(() => journal.beginUndo(f.target, 'backing-install', f.first), { code: 'DEFAULTS_DEPENDENCIES' })
      assert.equal(entry(f.read(), f.target).stage, 'retained')
      assert.equal(f.read().inspect(f.target, f.first), 'opted-out')
      assert.throws(() => f.read().beginInstall(f.target, 'other-install', f.absent, f.first), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => f.read().completeInstall(source.target, 'source-install', source.after), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
    })
  })

  it('keeps source tombstones and app references until verified destination removal releases the last backing dependency', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), source = link(f, 'source'), app = link(f, 'codex', 'source-install')
      for (const [row, id] of [[source, 'source-install'], [app, 'app-install']]) {
        journal.beginInstall(row.target, id, row.before, row.after, { dependencies: [row.dependency] }); journal.completeInstall(row.target, id, row.after)
      }
      assert.throws(() => journal.beginUndo(f.target, 'backing-install', f.first), { code: 'DEFAULTS_DEPENDENCIES' })
      journal.beginUndo(source.target, 'source-install', source.after)
      assert.equal(journal.dependenciesFor(f.target, 'backing-install').length, 2)
      journal.completeUndo(source.target, 'source-install', source.before)
      assert.equal(journal.dependenciesFor(f.target, 'backing-install').length, 1)
      assert.equal(journal.dependenciesFor(f.target, 'backing-install')[0].viaSourceInstallId, 'source-install')
      assert.equal(entry(f.read(), source.target).dependencies[0].status, 'released')
      assert.throws(() => journal.beginUndo(f.target, 'backing-install', f.first), { code: 'DEFAULTS_DEPENDENCIES' })
      journal.beginUndo(app.target, 'app-install', app.after); journal.completeUndo(app.target, 'app-install', app.before)
      assert.deepEqual(journal.dependenciesFor(f.target, 'backing-install'), [])
      journal.beginUndo(f.target, 'backing-install', f.first); journal.completeUndo(f.target, 'backing-install', f.absent)
      assert.equal(entry(f.read(), f.target).stage, 'opted-out')
    })
  })

  it('keeps compatibility-record creation evidence and never completes an interrupted metadata write from matching bytes', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), path = join(f.root, 'skills-written.json'), wanted = 'c'.repeat(64)
      journal.bindCompatibility('skills-written', path, null)
      journal.beginCompatibilityWrite('skills-written', 'metadata-1', null, wanted)
      assert.throws(() => f.read().completeCompatibilityWrite('skills-written', 'metadata-1', wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      journal.completeCompatibilityWrite('skills-written', 'metadata-1', wanted)
      assert.equal(f.read().snapshot().compatibility['skills-written'].hash, wanted)
      assert.throws(() => journal.bindCompatibility('skills-written', path, null), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => journal.beginCompatibilityWrite('skills-written', 'metadata-2', null, wanted), { code: 'REVISION_CONFLICT' })
    })
  })

  it('refuses corrupt current revisions, unresolved operation shapes and dependency identities', () => {
    const f = fixture()
    f.admitted(() => {
      installed(f); const good = readFileSync(f.path, 'utf8')
      for (const mutate of [value => { value.current.revision = 0 }, value => { value.current.fingerprint.parent = 'other' }, value => { value.operation = { phase: 'complete' } },
        value => { value.dependencies = [{ backingInstallId: 'unknown' }] }]) {
        const state = JSON.parse(good); mutate(state.entries[defaultsTargetKey(f.target)]); writeFileSync(f.path, JSON.stringify(state))
        assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      }
    })
  })

  it('changes a qualified app link into a tree without changing its original install or releasing backing early', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), app = link(f, 'codex')
      journal.beginInstall(app.target, 'app-install', app.before, app.after, { dependencies: [app.dependency] }); journal.completeInstall(app.target, 'app-install', app.after)
      const next = { kind: 'tree', hash: 'd'.repeat(64), parent: app.after.parent, object: '1:900' }
      journal.beginRefresh(app.target, 'app-install', { id: 'app-refresh', expectedRevision: 1, old: app.after, next,
        staging: join(f.root, 'codex/.stage'), holding: join(f.root, 'codex/.hold'), recordDigests: {}, dependencies: [] })
      assert.equal(journal.dependenciesFor(f.target, 'backing-install').length, 1)
      for (const phase of ['held', 'published', 'metadata']) journal.advanceRefresh(app.target, 'app-install', 'app-refresh', phase)
      journal.completeRefresh(app.target, 'app-install', 'app-refresh', next)
      assert.equal(journal.dependenciesFor(f.target, 'backing-install').length, 0)
      assert.deepEqual(entry(journal, app.target).after, app.after)
      assert.deepEqual(entry(journal, app.target).current, { revision: 2, fingerprint: next })
      journal.beginUndo(app.target, 'app-install', next); journal.completeUndo(app.target, 'app-install', app.before)
    })
  })

  it('retains old active and next pending references through an interrupted dependent-copy refresh', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f), app = link(f, 'codex')
      const old = { kind: 'tree', hash: 'c'.repeat(64), parent: app.after.parent, object: '1:800' }
      const dependency = { ...app.dependency, destinationPath: join(app.target.path, 'alias'), destinationFingerprint: { ...app.after, parent: old.object } }
      journal.beginInstall(app.target, 'app-install', app.before, old, { dependencies: [dependency] }); journal.completeInstall(app.target, 'app-install', old)
      const next = { ...old, hash: 'd'.repeat(64), object: '1:900' }, nextDependency = { ...dependency, destinationFingerprint: { ...dependency.destinationFingerprint, parent: next.object, object: '1:901' } }
      journal.beginRefresh(app.target, 'app-install', { id: 'app-refresh', expectedRevision: 1, old, next,
        staging: join(f.root, 'codex/.stage'), holding: join(f.root, 'codex/.hold'), recordDigests: {}, dependencies: [nextDependency] })
      assert.deepEqual(journal.dependenciesFor(f.target, 'backing-install').map(row => row.status), ['active', 'pending'])
      const restarted = f.read()
      assert.throws(() => restarted.beginUndo(f.target, 'backing-install', f.first), { code: 'DEFAULTS_DEPENDENCIES' })
      assert.equal(entry(f.read(), f.target).stage, 'retained')
    })
  })
})
