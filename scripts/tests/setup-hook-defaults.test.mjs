// MODULE: setup-hook-defaults.test.mjs - Strict absent hook fragments, public Undo and interruption safety
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { initializeDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { setupHookGroups } from '../../apps/desktop/bin/bmn-hooks.mjs'
import { installSetupHook, restoreSetupHookTransaction, setupHookPath } from '../../apps/desktop/bin/setup-hook-defaults.mjs'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'

const setupId = 'synthetic-hooks-79'
const example = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
const keys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']
let root, environment, saved
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-hooks-')); saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.HOME = root; environment = { HOME: root, PATH: '/usr/bin:/bin' }
  for (const directory of ['.claude', '.codex', '.config/bmn/agents']) mkdirSync(join(root, directory), { recursive: true })
  writeFileSync(join(root, '.config/bmn/agents/roster.md'), example.replaceAll('private_work: allowed', 'private_work: public_only'))
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
})
afterEach(() => {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  rmSync(root, { recursive: true, force: true })
})
const install = (app = 'codex', event = 'Stop', options = {}) => installSetupHook(app, event, { setupId, environment, ...options })
const read = (app = 'codex') => JSON.parse(readFileSync(setupHookPath(app, environment), 'utf8'))
const put = (app, data) => writeFileSync(setupHookPath(app, environment), JSON.stringify(data))
function transaction(id) {
  const folder = join(root, '.config/bmn/agents/state/rules/transactions', id)
  return { folder, manifest: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}

describe('setup hook groups', () => {
  for (const operation of ['install', 'undo']) it(`preserves an independent replacement at the ${operation} shared-config commit`, () => {
    const result = JSON.parse(execFileSync(process.execPath, [new URL('./fixtures/setup-config-interference.mjs', import.meta.url).pathname, root, operation], { encoding: 'utf8', timeout: 15000 }))
    assert.equal(result.replaced, true, 'the independent writer reached the actual publication boundary')
    assert.notEqual(result.code, 'OK', JSON.stringify(result))
    assert([result.targetText, ...result.holdings].includes(result.foreign), 'independent config bytes survive')
  })

  for (const app of ['claude', 'codex']) {
    it(`adds one absent ${app} group and Undo preserves unrelated groups and settings`, async () => {
      put(app, { theme: 'original', hooks: { SessionEnd: [] } })
      const installed = install(app); assert.equal(installed.code, 'OK', installed.message)
      assert.equal(read(app).hooks.Stop.length, 1); assert.equal(install(app).state, 'installed')
      const data = read(app), foreign = { hooks: [{ type: 'command', command: 'synthetic-user-hook', timeout: 3 }] }
      data.theme = 'changed'; data.hooks.Stop.unshift(foreign); data.hooks.SessionEnd.push(foreign); put(app, data)
      const shown = await restoreTransaction(installed.transaction, { planOnly: true })
      assert.equal(shown.code, 'OK')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true, expectedPlanHash: shown.plan_hash })).code, 'OK')
      assert.deepEqual(read(app), { theme: 'changed', hooks: { SessionEnd: [foreign], Stop: [foreign] } })
      assert.equal(install(app).state, 'opted-out')
    })
  }

  it('keeps Codex session-end and interrupt entries within the 3 s Codex allows', () => {
    // Codex 0.163.0 warns "clamping SessionEnd hook timeout to 3s" at every start for a longer one (79.6 clean run).
    const groups = setupHookGroups('codex', '{}').groups
    assert.deepEqual(['SessionEnd', 'Interrupt'].map(event => groups[event].hooks[0].timeout), [3, 3])
    assert.equal(groups.Stop.hooks[0].timeout, 5)
    assert.equal(setupHookGroups('claude', '{}').groups.SessionEnd.hooks[0].timeout, 5)
  })

  it('does not install before team approval', () => {
    rmSync(join(root, '.config/bmn/agents/state/current'))
    assert.equal(install().code, 'NOT_APPROVED'); assert(!existsSync(setupHookPath('codex', environment)))
  })

  it('does not raise an existing timeout or widen an older matcher', () => {
    const original = setupHookGroups('claude', '').groups.PreToolUse
    original.matcher = 'AskUserQuestion'; original.hooks[0].timeout = 1
    put('claude', { hooks: { PreToolUse: [original] } })
    assert.equal(install('claude', 'Stop').code, 'OK')
    assert.deepEqual(read('claude').hooks.PreToolUse, [original])
    assert.equal(install('claude', 'PreToolUse').code, 'FOREIGN_TARGET')
    assert.deepEqual(read('claude').hooks.PreToolUse, [original])
  })

  it('leaves an unowned matching group unchanged', () => {
    const fragment = setupHookGroups('codex', '').groups.Stop
    put('codex', { hooks: { Stop: [fragment] } })
    assert.equal(install().code, 'FOREIGN_TARGET'); assert.deepEqual(read().hooks.Stop, [fragment])
  })

  it('appends beside an unrelated user hook and detects later removal against the original neighbors', () => {
    const foreign = { hooks: [{ type: 'command', command: 'synthetic-user-hook' }] }
    put('codex', { hooks: { Stop: [foreign] } })
    assert.equal(install().code, 'OK'); assert.equal(read().hooks.Stop.length, 2)
    put('codex', { hooks: { Stop: [foreign] } })
    assert.equal(install().state, 'opted-out'); assert.deepEqual(read().hooks.Stop, [foreign])
  })

  for (const change of ['edit', 'duplicate']) {
    it(`refuses a ${change} of the owned group without removing another group`, async () => {
      const installed = install(), data = read()
      if (change === 'edit') data.hooks.Stop[0].hooks[0].timeout += 1
      else data.hooks.Stop.push(data.hooks.Stop[0])
      put('codex', data)
      assert.equal((await restoreTransaction(installed.transaction, { yes: true })).code, 'REVISION_CONFLICT')
      assert.equal(install().code, 'REVISION_CONFLICT'); assert.deepEqual(read(), data)
    })
  }

  it('records a manual removal as an opt-out on its next read', () => {
    assert.equal(install().code, 'OK'); const data = read(); delete data.hooks.Stop; put('codex', data)
    assert.equal(install().state, 'opted-out'); assert.equal(install().state, 'opted-out'); assert(!read().hooks.Stop)
  })

  it('reports physical publication but never adopts an interrupted matching write', async () => {
    const result = install('codex', 'Stop', { afterPublish: () => { throw new Error('synthetic interruption') } })
    assert.equal(result.code, 'INSTALL_FAILED'); assert.equal(result.written.length, 1); assert.equal(read().hooks.Stop.length, 1)
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE')
    assert.equal((await restoreTransaction(result.transaction, { yes: true })).code, 'REVISION_CONFLICT')
  })

  for (const seam of ['beforeRemove', 'afterRemove']) {
    it(`keeps the opt-out after ${seam} interruption and blocks uncertain physical recovery`, async () => {
      const installed = install(), tx = transaction(installed.transaction)
      const undone = await restoreSetupHookTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
        [seam]: () => { throw new Error('synthetic interruption') } })
      assert.equal(undone.code, 'IO_ERROR'); assert.equal(undone.restored.length, seam === 'afterRemove' ? 1 : 0)
      assert.equal(install().state, 'opted-out')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, seam === 'afterRemove' ? 'REVISION_CONFLICT' : 'OK')
      assert(!read().hooks.Stop); assert.equal(install().state, 'opted-out')
    })
  }

  it('refuses replaced directories before publication', () => {
    const result = install('codex', 'Stop', { beforePublish: () => {
      renameSync(join(root, '.codex'), join(root, 'old-codex')); mkdirSync(join(root, '.codex'))
    } })
    assert.equal(result.code, 'REVISION_CONFLICT'); assert(!existsSync(setupHookPath('codex', environment)))
    assert(!existsSync(join(root, 'old-codex/hooks.json')))
  })

  it('keeps unrelated settings values out of setup transaction and ownership records', async () => {
    const secret = 'synthetic-unrelated-value-79-4-hook'
    put('claude', { env: { SYNTHETIC_KEY: secret } })
    const installed = install('claude'); assert.equal(installed.code, 'OK')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal(read('claude').env.SYNTHETIC_KEY, secret)
    const inspect = directory => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        if (lstatSync(path).isDirectory()) inspect(path)
        else assert(!readFileSync(path, 'utf8').includes(secret), path)
      }
    }
    inspect(join(root, '.config/bmn'))
  })
})
