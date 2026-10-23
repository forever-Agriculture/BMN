// MODULE: setup-config-write.test.mjs - Real setup shared-file publication, retained recovery and strict restart boundaries
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { newTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { assertSetupConfigRecovery, replaceSetupConfig, setupConfigRecovery } from '../../apps/desktop/bin/setup-config-write.mjs'
import { pathState } from '../../apps/desktop/bin/safe-config-write.mjs'

let root, path, savedHome, manifest, folder
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-config-')); savedHome = process.env.HOME; process.env.HOME = root
  mkdirSync(join(root, 'config')); path = join(root, 'config/shared.json')
  withDefaultsAdmission(() => {
    const allocated = newTransaction(new Date()); folder = allocated.folder
    manifest = { id: allocated.id, kind: 'setup-hook', state: 'started', setup: {} }
  })
})
afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }) })
const write = options => withDefaultsAdmission(() => replaceSetupConfig(path, pathState(path), 'synthetic next', { manifest, folder, ...options }))
const stored = () => JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))

describe('setup shared-config preservation', () => {
  for (const before of [null, 'synthetic old']) it(`publishes into absence after preserving ${before === null ? 'no previous file' : 'the whole previous file'}`, () => {
    if (before !== null) { writeFileSync(path, before); chmodSync(path, 0o660) }
    write()
    assert.equal(readFileSync(path, 'utf8'), 'synthetic next')
    assertSetupConfigRecovery(stored(), path)
    const paths = setupConfigRecovery(stored()).recoveryPaths ?? []
    assert.equal(paths.length, before === null ? 0 : 1)
    if (before !== null) {
      assert.equal(readFileSync(paths[0], 'utf8'), before)
      assert.equal(lstatSync(path).mode & 0o777, lstatSync(paths[0]).mode & 0o777)
    }
  })

  it('preserves a new independent file occupying the gap between holding and publication', () => {
    writeFileSync(path, 'synthetic old')
    assert.throws(() => write({ afterHold: () => writeFileSync(path, 'synthetic foreign', { flag: 'wx' }) }), error => {
      assert.equal(error.code, 'REVISION_CONFLICT'); assert(error.recovery.stagedPath); return true
    })
    assert.equal(readFileSync(path, 'utf8'), 'synthetic foreign')
    const state = stored()
    assert.equal(readFileSync(state.setup.configInstallHolding.holdingPath, 'utf8'), 'synthetic old')
    assert.equal(readFileSync(state.setup.configInstall.stagedPath, 'utf8'), 'synthetic next')
    assert.throws(() => assertSetupConfigRecovery(state, path), /inspection/)
    assert.throws(() => write(), /inspection/)
  })

  for (const seam of ['afterHold', 'afterCommit']) it(`retains both whole files and refuses restart adoption after ${seam}`, () => {
    writeFileSync(path, 'synthetic old')
    assert.throws(() => write({ [seam]: () => { throw new Error('synthetic interruption') } }), error => {
      assert.match(error.message, /synthetic interruption/)
      assert.equal(error.recovery.physicalPublication, seam === 'afterCommit' ? 'reported' : 'none')
      return true
    })
    const state = stored(), operation = state.setup.configInstall
    assert.equal(readFileSync(state.setup.configInstallHolding.holdingPath, 'utf8'), 'synthetic old')
    assert.equal(readFileSync(seam === 'afterHold' ? operation.stagedPath : path, 'utf8'), 'synthetic next')
    assert.equal(existsSync(path), seam === 'afterCommit')
    assert.throws(() => assertSetupConfigRecovery(state, path), /inspection/)
  })

  it('rejects corrupt completed records rather than granting recovery from matching live bytes', () => {
    writeFileSync(path, 'synthetic old'); write()
    const mutations = [
      state => { state.setup.configInstall.version = 2 },
      state => { state.setup.configInstall.stagedPath = join(root, 'elsewhere') },
      state => { state.setup.configInstall.after.object = null },
      state => { state.setup.configInstallHolding.expected.hash = 'a'.repeat(64) },
      state => { state.setup.configInstallHolding.holdingPath = join(root, 'elsewhere') },
      state => { delete state.setup.configInstallHolding }
    ]
    for (const mutate of mutations) { const state = stored(); mutate(state); assert.throws(() => assertSetupConfigRecovery(state, path), /inspection/) }
    assert.equal(readFileSync(path, 'utf8'), 'synthetic next')
  })

  it('binds a symlinked parent to its physical directory without losing completed recovery provenance', () => {
    symlinkSync(join(root, 'config'), join(root, 'linked-config')); path = join(root, 'linked-config/shared.json')
    writeFileSync(path, 'synthetic old'); write()
    assert.equal(readFileSync(path, 'utf8'), 'synthetic next')
    assertSetupConfigRecovery(stored(), path)
  })
})

describe('Epic 85 guarded absence publication', () => {
  for (const seam of ['afterHold', 'afterCommit']) it(`retains the installed file and blocks restart after ${seam}`, () => {
    manifest.kind = 'setup-tool'; manifest.setup.target = { app: 'opencode', path }
    writeFileSync(path, 'synthetic installed config')
    assert.throws(() => withDefaultsAdmission(() => replaceSetupConfig(path, pathState(path), null, {
      manifest, folder, key: 'configUndo', [seam]: () => { throw new Error('synthetic interruption') }
    })), error => { assert.equal(error.recovery.physicalPublication, 'reported'); return true })
    const state = stored(); assert.equal(state.setup.configUndo.stagedPath, null)
    assert.equal(readFileSync(state.setup.configUndoHolding.holdingPath, 'utf8'), 'synthetic installed config')
    assert(!existsSync(path)); assert.throws(() => assertSetupConfigRecovery(state, path), /inspection/)
  })
  it('preserves a foreign recreation in the holding gap', () => {
    manifest.kind = 'setup-tool'; manifest.setup.target = { app: 'opencode', path }
    writeFileSync(path, 'synthetic installed config')
    assert.throws(() => withDefaultsAdmission(() => replaceSetupConfig(path, pathState(path), null, {
      manifest, folder, key: 'configUndo', afterHold: () => writeFileSync(path, 'synthetic foreign', { flag: 'wx' })
    })), /recreated/)
    const state = stored(); assert.equal(readFileSync(path, 'utf8'), 'synthetic foreign')
    assert.equal(readFileSync(state.setup.configUndoHolding.holdingPath, 'utf8'), 'synthetic installed config')
    assert.throws(() => assertSetupConfigRecovery(state, path), /inspection/)
  })
})
