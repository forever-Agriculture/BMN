// MODULE: setup-skill-defaults.test.mjs - Physical setup skills, original Undo, refresh revisions and backing retention
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { installSetupSkill, refreshSetupSkill } from '../../apps/desktop/bin/setup-skill-defaults.mjs'
import { setupSkillRecordPath } from '../../apps/desktop/bin/setup-skill-records.mjs'
import { treeHash } from '../../apps/desktop/bin/agents-skills.mjs'
import { agentsDirectory } from '../../apps/desktop/bin/agents-roster.mjs'
import { readSetupRecovery } from '../../apps/desktop/bin/setup-recovery.mjs'

let root, home, setupId, shipped, backing, source, app
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-skill-defaults-')); home = process.env.HOME; process.env.HOME = root; setupId = 'synthetic-skills'
  shipped = join(root, 'shipped/plan'); mkdirSync(shipped, { recursive: true }); writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v1')
  backing = { kind: 'own-skills', app: 'source', path: join(root, 'backing/plan'), entry: 'plan' }
  source = { kind: 'skills', app: 'source', path: join(root, 'source/plan'), entry: 'plan' }
  app = { kind: 'skills', app: 'codex', path: join(root, 'codex/plan'), entry: 'plan' }
  for (const target of [backing, source, app]) mkdirSync(dirname(target.path), { recursive: true })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
})
afterEach(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(root, { recursive: true, force: true }) })
const entry = target => readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(target)]
const install = (target, desired, options = {}) => installSetupSkill(target, desired, { setupId, ...options })

describe('setup skill transactions', () => {
  it('keeps backing readable after source Undo and after a dangling app link until that app Undo releases its dependency', async () => {
    const b = install(backing, { kind: 'tree', source: shipped }); assert.equal(b.code, 'OK', b.message)
    const s = install(source, { kind: 'link', text: backing.path }); assert.equal(s.code, 'OK', s.message)
    const a = install(app, { kind: 'link', text: source.path }); assert.equal(a.code, 'OK', a.message)
    const blocked = await restoreTransaction(b.transaction, { yes: true, asJson: true })
    assert.equal(blocked.code, 'DEFAULTS_DEPENDENCIES', JSON.stringify(blocked)); assert.equal(entry(backing).stage, 'retained')
    assert.equal((await restoreTransaction(s.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal(existsSync(source.path), false); assert.equal(readlinkSync(app.path), source.path)
    assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic v1')
    assert.equal((await restoreTransaction(b.transaction, { yes: true, asJson: true })).code, 'DEFAULTS_DEPENDENCIES')
    assert.equal((await restoreTransaction(a.transaction, { yes: true, asJson: true })).code, 'OK')
    const removed = await restoreTransaction(b.transaction, { yes: true, asJson: true })
    assert.equal(removed.code, 'OK', removed.message); assert.equal(existsSync(backing.path), false)
    assert.equal(readFileSync(join(removed.recovery.holdingPath, 'SKILL.md'), 'utf8'), 'synthetic v1')
    assert.equal(install(backing, { kind: 'tree', source: shipped }).state, 'opted-out')
    assert.equal(install(source, { kind: 'link', text: backing.path }).state, 'opted-out')
  })

  it('refreshes a tree and lets original Earlier installs Undo remove the checked current revision', async () => {
    const installed = install(backing, { kind: 'tree', source: shipped }); assert.equal(installed.code, 'OK', installed.message)
    const original = entry(backing)
    writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v2')
    const refreshed = refreshSetupSkill(backing, { kind: 'tree', source: shipped }, { setupId })
    assert.equal(refreshed.code, 'OK', refreshed.message)
    assert.deepEqual(entry(backing).before, original.before); assert.deepEqual(entry(backing).after, original.after)
    assert.equal(entry(backing).current.revision, 2)
    assert.equal(readFileSync(join(refreshed.recovery.holdingPath, 'SKILL.md'), 'utf8'), 'synthetic v1')
    assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic v2')
    writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v3')
    const again = refreshSetupSkill(backing, { kind: 'tree', source: shipped }, { setupId })
    assert.equal(again.code, 'OK', again.message)
    const undone = await restoreTransaction(installed.transaction, { yes: true, asJson: true })
    assert.equal(undone.code, 'OK', undone.message)
    assert.equal(readFileSync(join(undone.recovery.holdingPath, 'SKILL.md'), 'utf8'), 'synthetic v3')
    const history = readSetupRecovery(setupId)
    assert.equal(history.code, 'OK', JSON.stringify(history))
    const recovered = history.rows.flatMap(row => row.recoveryPaths)
    for (const result of [refreshed, again, undone]) assert(recovered.includes(result.recovery.holdingPath))
  })

  for (const seam of ['afterHold', 'afterPublish', 'afterBinding', 'afterMetadata']) it(`refuses restart adoption after refresh interruption at ${seam}`, async () => {
    const installed = install(backing, { kind: 'tree', source: shipped }); assert.equal(installed.code, 'OK', installed.message)
    writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v2')
    const failed = refreshSetupSkill(backing, { kind: 'tree', source: shipped }, { setupId, [seam]: () => { throw new Error('synthetic interruption') } })
    assert.notEqual(failed.code, 'OK'); assert(failed.recoveryPaths.length > 0, failed.message)
    assert.equal(entry(backing).stage, 'refreshing')
    assert.notEqual((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.notEqual(refreshSetupSkill(backing, { kind: 'tree', source: shipped }, { setupId }).code, 'OK')
  })

  it('refuses a competing publication and retains both revisions without overwriting the new occupant', () => {
    const installed = install(backing, { kind: 'tree', source: shipped }); assert.equal(installed.code, 'OK', installed.message)
    writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v2')
    const failed = refreshSetupSkill(backing, { kind: 'tree', source: shipped }, { setupId, afterHold: () => writeFileSync(backing.path, 'foreign file', { flag: 'wx' }) })
    assert.equal(failed.code, 'REVISION_CONFLICT', failed.message)
    assert.equal(readFileSync(backing.path, 'utf8'), 'foreign file')
    assert.equal(readFileSync(join(failed.recovery.holdingPath, 'SKILL.md'), 'utf8'), 'synthetic v1')
    assert.equal(readFileSync(join(failed.stagedPath, 'SKILL.md'), 'utf8'), 'synthetic v2')
  })

  it('refuses corrupt or vanished compatibility records before backing Undo, retaining readable backing', async () => {
    const installed = install(backing, { kind: 'tree', source: shipped }); assert.equal(installed.code, 'OK', installed.message)
    const s = install(source, { kind: 'link', text: backing.path }); assert.equal(s.code, 'OK', s.message)
    rmSync(setupSkillRecordPath('own-skills'))
    const failed = await restoreTransaction(installed.transaction, { yes: true, asJson: true })
    assert.notEqual(failed.code, 'OK'); assert.equal(existsSync(join(backing.path, 'SKILL.md')), true)
  })

  it('keeps an independent generated app copy readable after backing Undo and refreshes it through original Undo', async () => {
    const b = install(backing, { kind: 'tree', source: shipped }); assert.equal(b.code, 'OK', b.message)
    const desired = () => ({ kind: 'tree', source: shipped, header: { name: 'plan', sourceHash: treeHash(shipped) } })
    const a = install(app, desired()); assert.equal(a.code, 'OK', a.message)
    assert.equal(entry(app).dependencies.length, 0)
    assert.equal((await restoreTransaction(b.transaction, { yes: true, asJson: true })).code, 'OK')
    assert(readFileSync(join(app.path, 'SKILL.md'), 'utf8').includes('synthetic v1'))
    writeFileSync(join(shipped, 'SKILL.md'), 'synthetic v2')
    const changed = refreshSetupSkill(app, desired(), { setupId }); assert.equal(changed.code, 'OK', changed.message)
    const record = JSON.parse(readFileSync(setupSkillRecordPath('skills-written'), 'utf8'))[app.path]
    assert.equal(record.hash, entry(app).current.fingerprint.hash)
    assert.equal(record.source_hash, treeHash(shipped))
    assert.equal((await restoreTransaction(a.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal(existsSync(app.path), false)
  })

  it('refuses malformed generated-copy metadata before publishing its destination', () => {
    const invalid = install(app, { kind: 'tree', source: shipped })
    assert.notEqual(invalid.code, 'OK'); assert.equal(existsSync(app.path), false, JSON.stringify(invalid))
    const recovered = readSetupRecovery(setupId).rows.flatMap(row => row.recoveryPaths)
    assert(recovered.includes(invalid.stagedPath), 'the allocated skill stage was journaled before creation and survives a fresh reader')
  })

  it('retains backing when another recorded source was retargeted outside BMN, even through an unchanged app link', async () => {
    const b = install(backing, { kind: 'tree', source: shipped }), s = install(source, { kind: 'link', text: backing.path })
    assert.equal(b.code, 'OK', b.message); assert.equal(s.code, 'OK', s.message)
    const other = { ...backing, path: join(root, 'backing/other'), entry: 'other' }
    const otherSource = { ...source, path: join(root, 'source/other'), entry: 'other' }
    const otherApp = { ...app, path: join(root, 'codex/other'), entry: 'other' }
    for (const [target, desired] of [[other, { kind: 'tree', source: shipped }], [otherSource, { kind: 'link', text: other.path }], [otherApp, { kind: 'link', text: otherSource.path }]]) {
      const result = install(target, desired); assert.equal(result.code, 'OK', result.message)
    }
    assert.equal((await restoreTransaction(s.transaction, { yes: true, asJson: true })).code, 'OK')
    rmSync(otherSource.path); symlinkSync(backing.path, otherSource.path)
    const refused = await restoreTransaction(b.transaction, { yes: true, asJson: true })
    assert.equal(refused.code, 'DEFAULTS_DEPENDENCIES', JSON.stringify(refused))
    assert.equal(entry(backing).stage, 'retained')
    assert.equal(readFileSync(join(otherApp.path, 'SKILL.md'), 'utf8'), 'synthetic v1')
  })

  it('refreshes a copy containing a backing link without dropping either recorded dependency before completion', async () => {
    const b = install(backing, { kind: 'tree', source: shipped }); assert.equal(b.code, 'OK', b.message)
    const copySource = join(root, 'copy-source/plan'); mkdirSync(copySource, { recursive: true })
    writeFileSync(join(copySource, 'SKILL.md'), 'synthetic copy v1'); symlinkSync(backing.path, join(copySource, 'reference'))
    const desired = () => ({ kind: 'tree', source: copySource, header: { name: 'plan', sourceHash: treeHash(copySource) } })
    const a = install(app, desired()); assert.equal(a.code, 'OK', a.message)
    assert.equal(entry(app).dependencies.length, 1)
    writeFileSync(join(copySource, 'SKILL.md'), 'synthetic copy v2')
    let checked = false
    const refreshed = refreshSetupSkill(app, desired(), { setupId, afterHold: () => {
      const journal = readDefaultsOwnership(setupId)
      assert.deepEqual(journal.dependenciesFor(backing, b.transaction).map(row => row.status), ['active', 'pending']); checked = true
    } })
    assert.equal(refreshed.code, 'OK', refreshed.message); assert.equal(checked, true)
    assert.equal(entry(app).dependencies.length, 1); assert.equal(entry(app).dependencies[0].status, 'active')
    assert.equal((await restoreTransaction(b.transaction, { yes: true, asJson: true })).code, 'DEFAULTS_DEPENDENCIES')
    assert.equal((await restoreTransaction(a.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal((await restoreTransaction(b.transaction, { yes: true, asJson: true })).code, 'OK')
  })

  it('refuses a manifest whose metadata key was changed to another valid identical app record', async () => {
    assert.equal(install(backing, { kind: 'tree', source: shipped }).code, 'OK')
    assert.equal(install(source, { kind: 'link', text: backing.path }).code, 'OK')
    const first = install(app, { kind: 'link', text: source.path }); assert.equal(first.code, 'OK', first.message)
    const other = { ...app, path: join(root, 'codex-other/plan') }; mkdirSync(dirname(other.path))
    const second = install(other, { kind: 'link', text: source.path }); assert.equal(second.code, 'OK', second.message)
    const path = join(agentsDirectory(), 'state/rules/transactions', first.transaction, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.setup.metadata.key = other.path; writeFileSync(path, JSON.stringify(manifest))
    const refused = await restoreTransaction(first.transaction, { yes: true, asJson: true })
    assert.notEqual(refused.code, 'OK', JSON.stringify(refused))
    assert.equal(readlinkSync(app.path), source.path); assert.equal(readlinkSync(other.path), source.path)
    const records = JSON.parse(readFileSync(setupSkillRecordPath('skills-written'), 'utf8'))
    assert(records[app.path]); assert(records[other.path])
  })
})
