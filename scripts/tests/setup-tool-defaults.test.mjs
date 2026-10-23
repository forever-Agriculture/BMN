// MODULE: setup-tool-defaults.test.mjs - Qualified MCP setup ownership, entry-only Undo and interrupted recovery
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { checkTools, readAppTools, TOOL_APPS, toolsTestsPath } from '../../apps/desktop/bin/agents-tools.mjs'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { installSetupTool, restoreSetupToolTransaction } from '../../apps/desktop/bin/setup-tool-defaults.mjs'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'
import { readSetupRecovery } from '../../apps/desktop/bin/setup-recovery.mjs'

const setupId = 'synthetic-tools-79', versions = { claude: '2.1.303', codex: '0.163.0', opencode: '2.0.32' }
const example = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
const keys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']
let root, saved, environment
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-tools-')); saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.HOME = root; environment = { HOME: root, PATH: '/usr/bin:/bin' }
  const directory = join(root, '.config/bmn/agents'); mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'roster.md'), example.replaceAll('private_work: allowed', 'private_work: public_only') + '\n## tools\n\n```yaml\nplaywright: {name: Playwright, command: npx, args: ["-y", "@playwright/mcp@0.0.55"], public: true}\n```\n')
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
  for (const [harness, version] of Object.entries(versions)) {
    mkdirSync(dirname(TOOL_APPS[harness].file(environment)), { recursive: true })
    appendFileSync(toolsTestsPath(), JSON.stringify({ harness, kind: 'capability', at: '2026-10-20T12:00:00.000Z', version,
      outcome: 'pass', variable: 'pass', argument: 'pass', header: 'pass', detail: 'synthetic qualification', ...(harness === 'opencode' ? { entry_layout: 'mcp.servers' } : {}) }) + '\n')
  }
})
afterEach(() => {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  rmSync(root, { recursive: true, force: true })
})
const install = (app = 'codex', options = {}) => installSetupTool(app, 'playwright', { setupId, environment, versions, ...options })
function transaction(id) {
  const folder = join(root, '.config/bmn/agents/state/rules/transactions', id)
  return { folder, manifest: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}
function put(app, text) { writeFileSync(TOOL_APPS[app].file(environment), text) }
const entry = app => readAppTools(app, environment).entries.get('playwright')

describe('setup MCP defaults', () => {
  for (const app of ['claude', 'codex', 'opencode']) {
    it(`installs qualified ${app} once and Undo removes only its entry, preserving unrelated changes`, async () => {
      const initial = app === 'codex' ? '# user comment\nmodel = "synthetic-model"\n' : '{"theme":"synthetic"}\n'
      put(app, initial)
      const installed = await install(app)
      assert.equal(installed.code, 'OK', installed.message); assert(installed.transaction); assert(entry(app))
      assert.equal((await install(app)).state, 'installed')
      assert.equal(checkTools({ environment, versions }).apps.find(row => row.harness === app).tools[0].state, 'current')
      const path = TOOL_APPS[app].file(environment)
      const published = readFileSync(path, 'utf8')
      const externallyChanged = app === 'codex' ? published + '\n# later unrelated change\n' : published.replace('synthetic', 'later unrelated change')
      writeFileSync(path, externallyChanged)
      const shown = await restoreTransaction(installed.transaction, { planOnly: true })
      assert.equal(shown.code, 'OK')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true, expectedPlanHash: shown.plan_hash })).code, 'OK')
      assert(!entry(app)); assert(readFileSync(path, 'utf8').includes('later unrelated change'))
      assert.equal((await install(app)).state, 'opted-out'); assert(!entry(app))
    })
  }

  it('leaves a foreign entry, even matching approved bytes, unowned', async () => {
    const first = await install(); assert.equal(first.code, 'OK')
    const journal = join(root, '.config/bmn/agents/state/setup-defaults.json')
    const state = JSON.parse(readFileSync(journal, 'utf8')); state.entries = {}; writeFileSync(journal, JSON.stringify(state))
    const result = await install()
    assert.equal(result.code, 'FOREIGN_TARGET'); assert(entry('codex'))
  })

  it('requires the installed version to have passed its tools test', async () => {
    assert.equal((await install('codex', { versions: { codex: '0.164.0' } })).code, 'TOOLS_UNSUPPORTED')
    assert(!entry('codex'))
  })

  it('refuses a changed entry without deleting it or reclassifying it as owned', async () => {
    const installed = await install(); const path = TOOL_APPS.codex.file(environment)
    writeFileSync(path, readFileSync(path, 'utf8').replace('@0.0.55', '@9.9.9'))
    assert.equal((await restoreTransaction(installed.transaction, { yes: true })).code, 'REVISION_CONFLICT')
    assert.equal((await install()).code, 'REVISION_CONFLICT'); assert(entry('codex'))
  })

  it('reports physical publication and blocks matching-byte adoption after an interruption', async () => {
    const installed = await install('codex', { afterPublish: () => { throw new Error('synthetic interruption') } })
    assert.equal(installed.code, 'INSTALL_FAILED'); assert.equal(installed.written.length, 1); assert(entry('codex'))
    assert.equal((await install()).code, 'DEFAULTS_STATE_UNAVAILABLE')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true })).code, 'REVISION_CONFLICT')
  })

  for (const seam of ['beforeRemove', 'afterRemove']) {
    it(`persists the opt-out before ${seam} interruption and blocks uncertain physical recovery`, async () => {
      const installed = await install(), tx = transaction(installed.transaction)
      const undone = await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
        [seam]: () => { throw new Error('synthetic interruption') } })
      assert.equal(undone.code, 'IO_ERROR'); assert.equal(undone.restored.length, seam === 'afterRemove' ? 1 : 0)
      assert.equal((await install()).state, 'opted-out')
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, seam === 'afterRemove' ? 'REVISION_CONFLICT' : 'OK')
      assert(!entry('codex')); assert.equal((await install()).state, 'opted-out')
    })
  }

  it('refuses a replaced parent before publication', async () => {
    const installed = await install('codex', { beforePublish: () => {
      renameSync(join(root, '.codex'), join(root, 'old-codex')); mkdirSync(join(root, '.codex'))
    } })
    assert.equal(installed.code, 'REVISION_CONFLICT'); assert(!entry('codex'))
    assert(!existsSync(join(root, 'old-codex/config.toml')))
  })

  for (const first of ['automatic-read', 'Undo']) {
    it(`keeps the entry absent after ${first} admits first against a separate process`, async () => {
      const installed = await install(), tx = transaction(installed.transaction)
      const toolModule = new URL('../../apps/desktop/bin/setup-tool-defaults.mjs', import.meta.url).href
      const rulesModule = new URL('../../apps/desktop/bin/agents-rules.mjs', import.meta.url).href
      const child = action => spawnSync(process.execPath, ['--input-type=module', '-e', `
        import {installSetupTool} from ${JSON.stringify(toolModule)};
        import {restoreTransaction} from ${JSON.stringify(rulesModule)};
        try {
          const result=process.argv[1]==='Undo'?await restoreTransaction(process.argv[2],{yes:true,asJson:true}):await installSetupTool('codex','playwright',${JSON.stringify({ setupId, environment, versions })});
          process.stdout.write(JSON.stringify({code:result.code,state:result.state})+'\\n');process.exit(result.code==='OK'?0:result.code==='REVISION_CONFLICT'?75:1)
        }catch(error){process.stderr.write(String(error.code));process.exit(error.code==='REVISION_CONFLICT'?75:1)}
      `, action, installed.transaction], { env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 5000 })
      if (first === 'automatic-read') {
        await withDefaultsAdmission(async () => {
          assert.equal((await install()).state, 'installed')
          assert.equal(child('Undo').status, 75); assert(entry('codex'))
        })
        assert.equal(child('Undo').status, 0)
      } else {
        const undone = await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
          beforeRemove: () => assert.equal(child('automatic-read').status, 75) })
        assert.equal(undone.code, 'OK')
      }
      for (let i = 0; i < 2; i++) {
        const result = child('automatic-read')
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /opted-out/); assert(!entry('codex'))
      }
    })
  }
})

// Epic85 full review: drive Setup's production coordinator and shared-config publication.
describe('Epic 85 Setup OpenCode exact undo', () => {
  for (const [filename, original] of [
    ['opencode.json', '{"theme":"synthetic"}'],
    ['opencode.jsonc', '// original comment\n{\n  "theme": "synthetic",\n}\n'],
    ['opencode.json', ''],
    ['opencode.jsonc', '// comment-only\n'],
    ['opencode.jsonc', '{"mcp":{"sibling":{"type":"local","command":["synthetic-missing"]}}}\n'],
    ['opencode.json', '{"mcp":{"servers":{"sibling":{"type":"local","command":["synthetic-missing"]}}}}\n']
  ]) {
    it(`restores exact ${filename} bytes after unchanged Setup install/undo (${original.length} bytes)`, async () => {
      const path = join(dirname(TOOL_APPS.opencode.file(environment)), filename)
      writeFileSync(path, original)
      const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
      const undone = await restoreTransaction(installed.transaction, { yes: true, asJson: true })
      assert.equal(undone.code, 'OK', undone.message)
      assert(existsSync(path)); assert.equal(readFileSync(path, 'utf8'), original)
      assert.equal((await install('opencode')).state, 'opted-out')
    })
  }
  it('restores original absence after unchanged Setup install/undo', async () => {
    const path = TOOL_APPS.opencode.file(environment); assert(!existsSync(path))
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const undone = await restoreTransaction(installed.transaction, { yes: true, asJson: true })
    assert.equal(undone.code, 'OK', undone.message); assert(!existsSync(path))
    assert.equal((await install('opencode')).state, 'opted-out')
  })
  it('keeps unrelated changes while undoing the Setup entry', async () => {
    put('opencode', '{"theme":"synthetic"}\n')
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment)
    writeFileSync(path, readFileSync(path, 'utf8').replace('synthetic', 'later-unrelated'))
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    assert(!entry('opencode')); assert(readFileSync(path, 'utf8').includes('later-unrelated'))
  })
  it('refuses an externally changed Setup entry', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), changed = readFileSync(path, 'utf8').replace('@0.0.55', '@9.9.9')
    writeFileSync(path, changed)
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(path, 'utf8'), changed)
  })
  it('does not remove a recreated postimage after interrupted absence restoration', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), postimage = readFileSync(path, 'utf8'), tx = transaction(installed.transaction)
    const undone = await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
      afterRemove: () => { writeFileSync(path, postimage); throw new Error('synthetic interruption') } })
    assert.notEqual(undone.code, 'OK'); assert.equal(readFileSync(path, 'utf8'), postimage)
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(path, 'utf8'), postimage); assert.equal((await install('opencode')).state, 'opted-out')
  })
})

describe('Epic 85 Setup recovery boundaries', () => {
  it('retains the whole installed file and exposes its holding after absence undo', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), postimage = readFileSync(path, 'utf8')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    const tx = transaction(installed.transaction), operation = tx.manifest.setup.configUndo
    assert.equal(operation.stagedPath, null); assert.equal(operation.after.kind, 'absent'); assert(!existsSync(path))
    const holding = tx.manifest.setup.configUndoHolding.holdingPath
    assert.equal(readFileSync(holding, 'utf8'), postimage)
    const recovery = readSetupRecovery(setupId)
    assert.equal(recovery.code, 'OK'); assert(recovery.rows.some(row => row.recoveryPaths.includes(holding)))
  })
  it('resumes only metadata after a completed physical absence undo', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), tx = transaction(installed.transaction)
    const interrupted = await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true,
      afterPhysical: () => { throw new Error('synthetic metadata interruption') } })
    assert.notEqual(interrupted.code, 'OK'); assert(!existsSync(path))
    assert.equal(transaction(installed.transaction).manifest.setup.configUndo.phase, 'complete')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    assert(!existsSync(path)); assert.equal((await install('opencode')).state, 'opted-out')
  })
  for (const recreated of ['empty', 'unrelated', 'postimage', 'link']) it(`refuses ${recreated} recreation before metadata-only completion`, async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), postimage = readFileSync(path, 'utf8'), tx = transaction(installed.transaction)
    const foreign = join(root, 'synthetic-foreign.json'); writeFileSync(foreign, '{}')
    const bytes = recreated === 'empty' ? '' : recreated === 'unrelated' ? '{"theme":"foreign"}' : postimage
    const interrupted = await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true, afterPhysical: () => {
      if (recreated === 'link') symlinkSync(foreign, path); else writeFileSync(path, bytes)
      throw new Error('synthetic metadata interruption')
    } })
    assert.notEqual(interrupted.code, 'OK')
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
    if (recreated === 'link') assert.equal(readlinkSync(path), foreign); else assert.equal(readFileSync(path, 'utf8'), bytes)
    assert.equal(readFileSync(foreign, 'utf8'), '{}')
    const journal = withDefaultsAdmission(() => readDefaultsOwnership(setupId).snapshot())
    assert.equal(journal.entries[defaultsTargetKey(tx.manifest.setup.target)].optOut, true)
    const next = await install('opencode')
    if (recreated === 'link') assert.equal(next.code, 'REVISION_CONFLICT'); else assert.equal(next.state, 'opted-out')
  })
  it('refuses missing or corrupt new inverse bindings without touching the installed file', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), postimage = readFileSync(path, 'utf8'), tx = transaction(installed.transaction)
    for (const mutate of [
      value => { delete value.setup.inverse },
      value => { value.setup.inverse.edit.after = 'a'.repeat(64) },
      value => { value.setup.inverse.file_kind = 'file' }
    ]) {
      const altered = structuredClone(tx.manifest); mutate(altered); writeFileSync(join(tx.folder, 'manifest.json'), JSON.stringify(altered))
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
      assert.equal(readFileSync(path, 'utf8'), postimage)
    }
  })
  it('refuses malformed completed absence operations and undo notes', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), tx = transaction(installed.transaction)
    await restoreSetupToolTransaction(tx.manifest, tx.folder, { yes: true, asJson: true, afterPhysical: () => { throw new Error('synthetic metadata interruption') } })
    const complete = transaction(installed.transaction).manifest
    for (const mutate of [
      value => { value.setup.configUndo.version = 1 },
      value => { value.setup.configUndo.stagedPath = join(root, 'synthetic-stage') },
      value => { value.setup.configUndo.after.kind = 'file' },
      value => { delete value.setup.configUndoHolding },
      value => { value.setup.configUndo.phase = 'intent' },
      value => { value.setup.undo.file_missing = false },
      value => { value.setup.undo.before = 'a'.repeat(64) },
      value => { value.setup.undo.file_witness.file.ino = '1' }
    ]) {
      const altered = structuredClone(complete); mutate(altered); writeFileSync(join(tx.folder, 'manifest.json'), JSON.stringify(altered))
      assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'REVISION_CONFLICT')
      assert(!existsSync(path))
    }
  })
  it('keeps legacy receipt-free undo entry-only without inferring original file absence', async () => {
    const installed = await install('opencode'); assert.equal(installed.code, 'OK', installed.message)
    const path = TOOL_APPS.opencode.file(environment), tx = transaction(installed.transaction)
    delete tx.manifest.setup.inverseVersion; delete tx.manifest.setup.inverse
    writeFileSync(join(tx.folder, 'manifest.json'), JSON.stringify(tx.manifest))
    assert.equal((await restoreTransaction(installed.transaction, { yes: true, asJson: true })).code, 'OK')
    assert(existsSync(path)); assert(!entry('opencode'))
  })
})
