// MODULE: setup-opencode-hooks.test.mjs - Plugin-first setup, registration-first Undo and partial publication safety
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { initializeDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { installSetupOpenCodeHooks, restoreSetupOpenCodeHooks } from '../../apps/desktop/bin/setup-opencode-hooks.mjs'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'

const setupId = 'synthetic-opencode-hooks-79'
const example = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
const keys = ['HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR']
let root, environment, saved, reference, plugin, cli
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-opencode-hooks-')); saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.HOME = root; environment = { HOME: root, PATH: '/usr/bin:/bin' }
  reference = join(root, '.config/opencode/bmn'); plugin = join(reference, 'tui.ts'); cli = join(root, '.config/opencode/cli.json')
  for (const directory of ['.config/opencode', '.config/bmn/agents']) mkdirSync(join(root, directory), { recursive: true })
  writeFileSync(join(root, '.config/bmn/agents/roster.md'), example.replaceAll('private_work: allowed', 'private_work: public_only'))
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
})
afterEach(() => {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  rmSync(root, { recursive: true, force: true })
})
const install = options => installSetupOpenCodeHooks({ setupId, environment, ...options })
const read = () => JSON.parse(readFileSync(cli, 'utf8'))
function transaction(id) {
  const folder = join(root, '.config/bmn/agents/state/rules/transactions', id)
  return { folder, manifest: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}

describe('setup OpenCode hook pair', () => {
  it('refuses a completed plugin holding with corrupt provenance', async () => {
    const installed = install()
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    const tx = transaction(installed.transaction)
    tx.manifest.setup.pluginRemoval.holdingPath = join(root, 'foreign')
    assert.equal((await restoreSetupOpenCodeHooks(tx.manifest, tx.folder, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    assert(!existsSync(plugin)); assert.equal(install().state, 'opted-out')
  })

  it('publishes plugin first and removes registration first through existing Undo', async () => {
    writeFileSync(cli, JSON.stringify({ theme: 'original', plugins: ['user-plugin'] }))
    const installed = install({ afterPlugin: () => { assert(existsSync(plugin)); assert.deepEqual(read().plugins, ['user-plugin']) } })
    assert.equal(installed.code, 'OK', installed.message); assert.equal(installed.written.length, 2)
    assert.equal(install().state, 'installed')
    writeFileSync(cli, JSON.stringify({ ...read(), theme: 'changed', plugins: [...read().plugins, 'later-user-plugin'] }))
    const tx = transaction(installed.transaction)
    const undone = await restoreSetupOpenCodeHooks(tx.manifest, tx.folder, { yes: true, asJson: true,
      beforePluginRemoval: () => { assert(!read().plugins.includes(reference)); assert(existsSync(plugin)) } })
    assert.equal(undone.code, 'OK', undone.message); assert(!existsSync(plugin))
    assert.deepEqual(read(), { theme: 'changed', plugins: ['user-plugin', 'later-user-plugin'] })
    assert.equal(install().state, 'opted-out'); assert(!existsSync(plugin))
  })

  it('supports the public Earlier installs plan and Undo', async () => {
    const installed = install(); assert.equal(installed.code, 'OK')
    const shown = await restoreTransaction(installed.transaction, { planOnly: true })
    assert.equal(shown.code, 'OK'); assert.equal(shown.targets.length, 2)
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true, expectedPlanHash: shown.plan_hash })).code, 'OK')
    assert(!existsSync(plugin)); assert.deepEqual(read().plugins, [])
  })

  it('refuses a foreign plugin and never registers it', () => {
    mkdirSync(reference); writeFileSync(plugin, 'foreign plugin')
    assert.equal(install().code, 'FOREIGN_TARGET'); assert.equal(readFileSync(plugin, 'utf8'), 'foreign plugin'); assert(!existsSync(cli))
  })

  it('refuses an unowned registration and never publishes a plugin', () => {
    writeFileSync(cli, JSON.stringify({ plugins: [reference] }))
    assert.equal(install().code, 'FOREIGN_TARGET'); assert(!existsSync(plugin)); assert.deepEqual(read().plugins, [reference])
  })

  for (const change of ['registration', 'duplicate-registration', 'plugin-replacement']) {
    it(`retains the plugin and registration after ${change}`, async () => {
      const installed = install(); assert.equal(installed.code, 'OK')
      if (change === 'registration') writeFileSync(cli, JSON.stringify({ plugins: ['foreign-replacement'] }))
      else if (change === 'duplicate-registration') writeFileSync(cli, JSON.stringify({ plugins: [reference, reference] }))
      else { writeFileSync(join(reference, 'replacement'), readFileSync(plugin)); renameSync(join(reference, 'replacement'), plugin) }
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
      assert(existsSync(plugin))
    })
  }

  it('reports a plugin-only interruption, blocks automatic retry and can Undo the proven partial write', async () => {
    const installed = install({ afterPlugin: () => { throw new Error('synthetic interruption') } })
    assert.equal(installed.code, 'INSTALL_FAILED'); assert.equal(installed.written.length, 1); assert(existsSync(plugin)); assert(!existsSync(cli))
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE')
    const undone = await restoreTransaction(installed.transaction, { yes: true, asJson: true })
    assert.equal(undone.code, 'OK', undone.message); assert(!existsSync(plugin)); assert.equal(install().state, 'opted-out')
  })

  it('does not infer registration ownership from an interrupted matching publication', async () => {
    const installed = install({ afterRegistration: () => { throw new Error('synthetic interruption') } })
    assert.equal(installed.code, 'INSTALL_FAILED'); assert.equal(installed.written.length, 2)
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true })).code, 'REVISION_CONFLICT')
    assert(existsSync(plugin)); assert(read().plugins.includes(reference))
  })

  it('retains the plugin if another writer registers it again before plugin removal', async () => {
    const installed = install(), tx = transaction(installed.transaction)
    const undone = await restoreSetupOpenCodeHooks(tx.manifest, tx.folder, { yes: true, asJson: true,
      beforePluginRemoval: () => writeFileSync(cli, JSON.stringify({ plugins: [reference] })) })
    assert.equal(undone.code, 'REVISION_CONFLICT'); assert(existsSync(plugin)); assert(read().plugins.includes(reference))
  })

  for (const seam of ['afterRegistrationRemoval', 'beforePluginRemoval']) {
    it(`keeps the pair opted out after ${seam} interruption and blocks uncertain physical recovery`, async () => {
      const installed = install(), tx = transaction(installed.transaction)
      const undone = await restoreSetupOpenCodeHooks(tx.manifest, tx.folder, { yes: true, asJson: true,
        [seam]: () => { throw new Error('synthetic interruption') } })
      assert.equal(undone.code, 'IO_ERROR'); assert(existsSync(plugin)); assert(!read().plugins.includes(reference))
      assert.equal(install().state, 'opted-out')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, seam === 'afterRegistrationRemoval' ? 'REVISION_CONFLICT' : 'OK')
      assert.equal(existsSync(plugin), seam === 'afterRegistrationRemoval'); assert.equal(install().state, 'opted-out')
    })
  }
})
