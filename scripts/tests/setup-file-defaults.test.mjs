// MODULE: setup-file-defaults.test.mjs - Real no-replace files, stable inode ownership and public Earlier installs Undo
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { installSetupFile, restoreSetupFileTransaction } from '../../apps/desktop/bin/setup-file-defaults.mjs'
import { checkTargets, listTransactions, masterHistory, readMaster, render, restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'

let root, target, oldHome
const setupId = 'synthetic-file-setup-79', text = '# Synthetic rules\n'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-file-')); oldHome = process.env.HOME; process.env.HOME = root
  mkdirSync(join(root, '.codex'), { recursive: true })
  target = { kind: 'rules', app: 'codex', path: join(root, '.codex/AGENTS.md'), entry: 'rules' }
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
})
afterEach(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }) })
const install = options => installSetupFile(target, text, { setupId, ...options })
function transaction(id) {
  const folder = join(root, '.config/bmn/agents/state/rules/transactions', id)
  return { folder, manifest: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}

describe('whole-file setup defaults', () => {
  it('registers setup rules in Health and restores the prior cache binding on Undo', async () => {
    const master = { kind: 'master', app: 'master', path: join(root, '.config/bmn/agents/global-rules.md'), entry: 'master' }
    const result = installSetupFile(master, '<!-- bmn:public -->\n# Synthetic pointers\n<!-- /bmn:public -->\n', { setupId })
    assert.equal(result.code, 'OK')
    const rendered = render(readMaster(), 'codex', null)
    const cache = join(root, '.config/bmn/agents/state/rules/last-written.json')
    const prior = 'a'.repeat(64)
    writeFileSync(cache, JSON.stringify({ [target.path]: prior }))
    const rules = installSetupFile(target, rendered.text, { setupId })
    assert.equal(rules.code, 'OK')
    assert.equal(checkTargets().find(row => row.harness === 'codex').state, 'current')
    assert.equal(JSON.parse(readFileSync(cache, 'utf8'))[target.path], rendered.hash)
    assert.equal((await restoreTransaction(rules.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal(JSON.parse(readFileSync(cache, 'utf8'))[target.path], prior)
    assert.equal(masterHistory().length, 1)
    assert.equal(masterHistory()[0].hash, readMaster().hash)
  })

  it('refuses Undo after a foreign rules metadata change', async () => {
    const result = install()
    const cache = join(root, '.config/bmn/agents/state/rules/last-written.json')
    writeFileSync(cache, JSON.stringify({ [target.path]: 'b'.repeat(64) }))
    assert.equal((await restoreTransaction(result.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(target.path, 'utf8'), text)
    assert.equal(install().code, 'REVISION_CONFLICT')
  })

  it('publishes only absence, lists its own transaction and uses existing Undo with a durable opt-out', async () => {
    const result = install()
    assert.equal(result.code, 'OK'); assert(result.transaction)
    assert.equal(readFileSync(target.path, 'utf8'), text)
    assert.equal(install().state, 'installed')
    assert.equal(listTransactions().find(entry => entry.id === result.transaction)?.reason, 'setup rules')
    const plan = await restoreTransaction(result.transaction, { planOnly: true })
    assert.equal(plan.code, 'OK'); assert.equal(plan.targets[0].path, target.path)
    const undone = await restoreTransaction(result.transaction, { yes: true, asJson: true, expectedPlanHash: plan.plan_hash })
    assert.equal(undone.code, 'OK'); assert(!existsSync(target.path))
    assert.equal(install().state, 'opted-out'); assert(!existsSync(target.path))
    assert.equal(readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(target)].optOut, true)
  })

  it('leaves a foreign file or link untouched', () => {
    writeFileSync(target.path, 'foreign')
    assert.equal(install().code, 'FOREIGN_TARGET'); assert.equal(readFileSync(target.path, 'utf8'), 'foreign')
    rmSync(target.path); const foreign = join(root, 'foreign'); writeFileSync(foreign, 'foreign target'); symlinkSync(foreign, target.path)
    assert.equal(install().code, 'FOREIGN_TARGET'); assert.equal(readFileSync(foreign, 'utf8'), 'foreign target')
    assert.equal(listTransactions().length, 0)
  })

  it('never overwrites a competing file appearing immediately before publication', () => {
    const result = install({ beforePublish: () => writeFileSync(target.path, 'competing writer') })
    assert.equal(result.code, 'EEXIST'); assert.equal(result.written.length, 0)
    assert.equal(readFileSync(target.path, 'utf8'), 'competing writer')
    rmSync(target.path)
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE'); assert(!existsSync(target.path))
  })

  it('refuses edited files and a replaced file with identical bytes', async () => {
    const result = install()
    writeFileSync(target.path, 'edited')
    assert.equal((await restoreTransaction(result.transaction, { yes: true })).code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(target.path, 'utf8'), 'edited')
    writeFileSync(target.path, text)
    const replaced = join(root, '.codex/replaced'); writeFileSync(replaced, text); renameSync(replaced, target.path)
    assert.equal((await restoreTransaction(result.transaction, { yes: true })).code, 'REVISION_CONFLICT')
    assert.equal(install().code, 'REVISION_CONFLICT'); assert.equal(readFileSync(target.path, 'utf8'), text)
  })

  it('reports a published file on interruption, but never adopts its matching bytes after restart', async () => {
    const result = install({ afterPublish: () => { throw new Error('synthetic interruption') } })
    assert.equal(result.code, 'INSTALL_FAILED'); assert.equal(result.written.length, 1)
    assert.equal(readFileSync(target.path, 'utf8'), text)
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE')
    assert.equal((await restoreTransaction(result.transaction, { yes: true })).code, 'REVISION_CONFLICT')
  })

  for (const seam of ['beforeRemove', 'afterRemove']) {
    it(`keeps the opt-out after interruption at ${seam} and does not adopt an unresolved holding`, async () => {
      const result = install(), tx = transaction(result.transaction)
      const first = await restoreSetupFileTransaction(tx.manifest, tx.folder, { yes: true, [seam]: () => { throw new Error('synthetic interruption') } })
      assert.equal(first.code, 'IO_ERROR')
      assert.deepEqual(first.restored, seam === 'afterRemove' ? ['codex'] : [])
      assert(first.message.includes(target.path))
      assert.equal(readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(target)].optOut, true)
      assert.equal(install().state, 'opted-out')
      const retried = await restoreTransaction(result.transaction, { yes: true, asJson: true })
      assert.equal(retried.code, seam === 'afterRemove' ? 'REVISION_CONFLICT' : 'OK')
      if (seam === 'afterRemove') {
        assert.match(retried.message, /holding operation needs inspection/)
        assert.equal(readFileSync(first.recovery.holdingPath, 'utf8'), text)
      }
      assert(!existsSync(target.path)); assert.equal(install().state, 'opted-out')
    })
  }

  it('preserves successfully removed content at the explicit recovery path', async () => {
    const result = install()
    const undone = await restoreTransaction(result.transaction, { yes: true, asJson: true })
    assert.equal(undone.code, 'OK')
    assert.equal(undone.recovery.phase, 'complete')
    assert.match(undone.message, /content preserved at/)
    assert.equal(readFileSync(undone.recovery.holdingPath, 'utf8'), text)
    assert(!existsSync(target.path))
    const again = await restoreTransaction(result.transaction, { yes: true, asJson: true })
    assert.equal(again.code, 'OK')
    assert.equal(again.recovery.holdingPath, undone.recovery.holdingPath)
  })

  for (const occupied of [false, true]) {
    it(`preserves a changed holding when the original name is ${occupied ? 'occupied' : 'absent'}`, async () => {
      const installed = install(), tx = transaction(installed.transaction)
      const undone = await restoreSetupFileTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
        afterMove: ({ holdingPath }) => {
          const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import {writeFileSync,renameSync} from 'node:fs';
            const [holding,path,occupied]=process.argv.slice(1);
            writeFileSync(holding+'.foreign','foreign held replacement');renameSync(holding+'.foreign',holding);
            if(occupied==='true')writeFileSync(path,'new original-name occupant')
          `, holdingPath, target.path, String(occupied)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000 })
          assert.equal(writer.status, 0, writer.stderr)
        } })
      assert.equal(undone.code, 'REVISION_CONFLICT')
      assert.match(undone.message, /recovery path/)
      assert.equal(readFileSync(occupied ? undone.recovery.holdingPath : target.path, 'utf8'), 'foreign held replacement')
      if (occupied) assert.equal(readFileSync(target.path, 'utf8'), 'new original-name occupant')
      assert.equal(install().state, 'opted-out')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    })
  }

  it('blocks restart completion after a move whose validation was interrupted', async () => {
    const installed = install(), tx = transaction(installed.transaction)
    const undone = await restoreSetupFileTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
      afterMove: () => { throw new Error('synthetic interruption after move') } })
    assert.equal(undone.code, 'IO_ERROR')
    assert.equal(readFileSync(undone.recovery.holdingPath, 'utf8'), text)
    assert(!existsSync(target.path))
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    assert.equal(install().state, 'opted-out')
  })

  it('refuses corrupt completed holding records instead of silently completing Undo', async () => {
    const installed = install()
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    const tx = transaction(installed.transaction), original = JSON.stringify(tx.manifest)
    const changes = [
      value => { value.version = 2 }, value => { value.sourcePath = join(root, 'foreign') },
      value => { value.holdingPath = join(root, 'foreign') }, value => { value.expected.hash = 'a'.repeat(64) },
      value => { value.extra = true }
    ]
    for (const change of changes) {
      const manifest = JSON.parse(original); change(manifest.setup.removal)
      const result = await restoreSetupFileTransaction(manifest, tx.folder, { yes: true, asJson: true })
      assert.equal(result.code, 'REVISION_CONFLICT')
    }
    assert(!existsSync(target.path)); assert.equal(install().state, 'opted-out')
  })

  it('pins the real parent and refuses a replaced directory', () => {
    const result = install({ beforePublish: () => {
      renameSync(join(root, '.codex'), join(root, 'old-codex')); mkdirSync(join(root, '.codex'))
    } })
    assert.equal(result.code, 'REVISION_CONFLICT')
    assert(!existsSync(target.path)); assert(!existsSync(join(root, 'old-codex/AGENTS.md')))
    assert.equal(install().code, 'DEFAULTS_STATE_UNAVAILABLE')
  })

  it('can undo a setup master without changing another app file', async () => {
    const master = { kind: 'master', app: 'master', path: join(root, '.config/bmn/agents/global-rules.md'), entry: 'master' }
    const result = installSetupFile(master, text, { setupId })
    const plan = await restoreTransaction(result.transaction, { planOnly: true })
    assert.equal(plan.targets.length, 0); assert.equal(plan.master.path, master.path)
    assert.equal((await restoreTransaction(result.transaction, { yes: true, asJson: true, expectedPlanHash: plan.plan_hash })).code, 'OK')
    assert(!existsSync(master.path))
    assert.equal(installSetupFile(master, text, { setupId }).state, 'opted-out')
  })

  for (const first of ['automatic-read', 'Undo']) {
    it(`keeps final absence and opt-out with ${first} admitted first, using the public Undo in another process`, async () => {
      const installed = install(), tx = transaction(installed.transaction)
      const fileModule = new URL('../../apps/desktop/bin/setup-file-defaults.mjs', import.meta.url).href
      const rulesModule = new URL('../../apps/desktop/bin/agents-rules.mjs', import.meta.url).href
      const child = action => spawnSync(process.execPath, ['--input-type=module', '-e', `
        import {installSetupFile} from ${JSON.stringify(fileModule)};
        import {restoreTransaction} from ${JSON.stringify(rulesModule)};
        try {
          const result=process.argv[1]==='Undo'?await restoreTransaction(process.argv[2],{yes:true,asJson:true}):installSetupFile(${JSON.stringify(target)},${JSON.stringify(text)},{setupId:${JSON.stringify(setupId)}});
          process.stdout.write(JSON.stringify({code:result.code,state:result.state})+'\\n');process.exit(result.code==='OK'?0:result.code==='REVISION_CONFLICT'?75:1)
        }catch(error){process.stderr.write(String(error.code));process.exit(error.code==='REVISION_CONFLICT'?75:1)}
      `, action, installed.transaction], { env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 5000 })
      if (first === 'automatic-read') {
        withDefaultsAdmission(() => {
          assert.equal(install().state, 'installed')
          assert.equal(child('Undo').status, 75, 'conflicted Undo stays pending for an explicit retry')
          assert(existsSync(target.path))
        })
        assert.equal(child('Undo').status, 0)
      } else {
        const undone = await restoreSetupFileTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
          beforeRemove: () => assert.equal(child('automatic-read').status, 75) })
        assert.equal(undone.code, 'OK')
      }
      for (let i = 0; i < 2; i++) {
        const reread = child('automatic-read')
        assert.equal(reread.status, 0, reread.stderr); assert.match(reread.stdout, /opted-out/)
        assert(!existsSync(target.path))
      }
    })
  }
})
