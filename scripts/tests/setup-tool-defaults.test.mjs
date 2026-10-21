// MODULE: setup-tool-defaults.test.mjs - Qualified MCP setup ownership, entry-only Undo and interrupted recovery
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { initializeDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { checkTools, readAppTools, TOOL_APPS, toolsTestsPath } from '../../apps/desktop/bin/agents-tools.mjs'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { installSetupTool, restoreSetupToolTransaction } from '../../apps/desktop/bin/setup-tool-defaults.mjs'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'

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
      outcome: 'pass', variable: 'pass', argument: 'pass', header: 'pass', detail: 'synthetic qualification' }) + '\n')
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
