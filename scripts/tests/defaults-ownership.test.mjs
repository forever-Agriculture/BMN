// MODULE: defaults-ownership.test.mjs - Synthetic crash points, changed-target refusals and durable opt-outs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'

const roots = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bmn-defaults-ownership-')); roots.push(directory)
  const path = join(directory, 'ownership.json'), setupId = 'synthetic-setup-79'
  const target = { kind: 'rules', app: 'codex', path: join(directory, 'AGENTS.md'), entry: 'rules' }
  const absent = { kind: 'absent', hash: null, parent: '1:100', object: null }
  const wanted = { kind: 'file', hash: 'a'.repeat(64), parent: '1:100', object: '1:999' }
  const initialize = () => initializeDefaultsOwnership(setupId, { path })
  const read = () => readDefaultsOwnership(setupId, { path })
  const admitted = work => withDefaultsAdmission(work, { directory })
  return { directory, path, setupId, target, absent, wanted, initialize, read, admitted }
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function installed(f) {
  const journal = f.initialize()
  journal.beginInstall(f.target, 'transaction-1', f.absent, f.wanted)
  journal.completeInstall(f.target, 'transaction-1', f.wanted)
  return journal
}

describe('setup defaults ownership', () => {
  it('requires explicit fresh initialization; missing or corrupt state never becomes empty', () => {
    const f = fixture()
    assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
    assert.throws(f.initialize, { code: 'REVISION_CONFLICT' })
    f.admitted(() => {
      f.initialize()
      assert.throws(f.initialize, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => readDefaultsOwnership('other-setup', { path: f.path }), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      writeFileSync(f.path, '{broken')
      assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(f.initialize, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
    })
  })

  it('records intent before completion and refuses every ambiguous restart point, even matching bytes', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = f.initialize()
      journal.beginInstall(f.target, 'transaction-1', f.absent, f.wanted)
      assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).entries[defaultsTargetKey(f.target)].stage, 'publishing')
      const restarted = f.read()
      for (const observed of [f.absent, f.wanted, { ...f.wanted, hash: 'b'.repeat(64) }]) {
        assert.throws(() => restarted.inspect(f.target, observed), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      }
      assert.throws(() => restarted.completeInstall(f.target, 'transaction-1', f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      journal.completeInstall(f.target, 'transaction-1', f.wanted)
      assert.equal(f.read().inspect(f.target, f.wanted), 'installed')
    })
  })

  it('does not adopt a foreign, edited or replaced target; each logical entry has its own identity', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f)
      assert.throws(() => journal.inspect(f.target, { ...f.wanted, hash: 'b'.repeat(64) }), { code: 'REVISION_CONFLICT' })
      assert.throws(() => journal.inspect(f.target, { ...f.wanted, parent: '1:200' }), { code: 'REVISION_CONFLICT' })
      assert.throws(() => journal.inspect(f.target, { ...f.wanted, object: '1:1000' }), { code: 'REVISION_CONFLICT' })
      assert.throws(() => journal.beginUndo(f.target, 'transaction-1', { ...f.wanted, hash: 'b'.repeat(64) }), { code: 'REVISION_CONFLICT' })
      assert.throws(() => journal.beginInstall({ ...f.target, entry: 'other' }, 'transaction-2', f.wanted, f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.equal(journal.inspect({ ...f.target, entry: 'other' }, f.absent), 'new')
      assert.notEqual(defaultsTargetKey(f.target), defaultsTargetKey({ ...f.target, app: 'claude' }))
    })
  })

  it('cannot complete a publication through an object retained after its admission ended', () => {
    const f = fixture()
    let retained
    f.admitted(() => {
      retained = f.initialize()
      retained.beginInstall(f.target, 'transaction-1', f.absent, f.wanted)
    })
    f.admitted(() => {
      assert.throws(() => retained.completeInstall(f.target, 'transaction-1', f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => f.read().inspect(f.target, f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
    })
  })

  it('observes a removed owned default as a durable opt-out across rereads and restart', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f)
      assert.equal(journal.inspect(f.target, f.absent), 'opted-out')
      assert.equal(f.read().inspect(f.target, f.absent), 'opted-out')
      assert.throws(() => f.read().beginInstall(f.target, 'transaction-2', f.absent, f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
    })
  })

  it('persists opt-out before Undo, survives interruption before/after removal and permits only matching retry', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f)
      journal.beginUndo(f.target, 'transaction-1', f.wanted)
      let restarted = f.read()
      assert.equal(restarted.inspect(f.target, f.wanted), 'opted-out')
      assert.equal(restarted.inspect(f.target, f.absent), 'opted-out')
      assert.throws(() => restarted.beginInstall(f.target, 'transaction-2', f.absent, f.wanted), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.throws(() => restarted.beginUndo(f.target, 'wrong-transaction', f.wanted), { code: 'REVISION_CONFLICT' })
      assert.throws(() => restarted.beginUndo(f.target, 'transaction-1', { ...f.wanted, hash: 'b'.repeat(64) }), { code: 'REVISION_CONFLICT' })
      restarted.beginUndo(f.target, 'transaction-1', f.wanted)
      restarted = f.read()
      restarted.completeUndo(f.target, 'transaction-1', f.absent)
      assert.equal(f.read().inspect(f.target, f.absent), 'opted-out')
      assert.equal(f.read().snapshot().entries[defaultsTargetKey(f.target)].stage, 'opted-out')
    })
  })

  it('rejects malformed ownership, a symlink, a missing journal and concurrent external replacement', () => {
    const f = fixture()
    f.admitted(() => {
      const journal = installed(f)
      const good = readFileSync(f.path, 'utf8')
      const bad = JSON.parse(good); bad.entries[defaultsTargetKey(f.target)].optOut = true
      writeFileSync(f.path, JSON.stringify(bad)); assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      const replaced = join(f.directory, 'replacement.json'); writeFileSync(replaced, good); renameSync(replaced, f.path)
      assert.throws(() => journal.beginUndo(f.target, 'transaction-1', f.wanted), { code: 'REVISION_CONFLICT' })
      rmSync(f.path); assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      const destination = join(f.directory, 'foreign.json'); writeFileSync(destination, good); symlinkSync(destination, f.path)
      assert.throws(f.read, { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      assert.equal(readFileSync(destination, 'utf8'), good)
    })
  })
})
