// MODULE: setup-defaults.test.mjs - Automatic fresh-profile approval, later-read, restart and preservation boundaries
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { masterPath, restoreTransaction, targetPath } from '../../apps/desktop/bin/agents-rules.mjs'
import { agentsDirectory } from '../../apps/desktop/bin/agents-roster.mjs'
import { defaultsOwnershipPath, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { skillsTestsPath } from '../../apps/desktop/bin/agents-skills.mjs'
import { toolsTestsPath } from '../../apps/desktop/bin/agents-tools.mjs'
import { coordinateSetupDefaults, setupSkillsSource, validSetupDefaultsRequest } from '../../apps/desktop/bin/setup-defaults.mjs'

const setupId = 'synthetic-coordinator-79'
const versions = { claude: '2.1.303', codex: '0.163.0', opencode: '2.0.32' }
const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'BMN_SHIPPED_SKILLS', 'PATH']
let root, saved
const request = (mode = 'apply', apps = ['codex'], initialize = false) => ({ mode, claim: { setupId, initialize }, ready: apps.map(app => ({ app, version: versions[app] })) })
const apply = apps => coordinateSetupDefaults(request('apply', apps))
const prepare = () => coordinateSetupDefaults(request('prepare', [], true))
function approve(source = setupSkillsSource(), scope = '') {
  const example = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
  writeFileSync(join(agentsDirectory(), 'roster.md'), example.replaceAll('private_work: allowed', 'private_work: public_only') +
    `\n## skills\n\n\`\`\`yaml\nsource: ${source}\npublic: [plan]\n\`\`\`\n\n## tools\n\n` +
    `\`\`\`yaml\nplaywright: {name: Playwright, command: npx, args: ["-y", "@playwright/mcp@0.0.55"], public: true${scope}}\n\`\`\`\n`)
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}
function qualify(app) {
  appendFileSync(skillsTestsPath(), JSON.stringify({ harness: app, kind: 'capability', version: versions[app], outcome: 'pass',
    roots: [{ root: app === 'codex' ? '.agents/skills' : app === 'claude' ? '.claude/skills' : '.config/opencode/skills', folder: true, link: true }] }) + '\n')
  appendFileSync(toolsTestsPath(), JSON.stringify({ harness: app, kind: 'capability', version: versions[app], outcome: 'pass',
    at: '2026-10-20T22:00:00.000Z', variable: 'pass', argument: 'pass', header: 'pass' }) + '\n')
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-coordinator-'))
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]])); for (const key of keys) delete process.env[key]
  process.env.HOME = root; process.env.PATH = `${root}/bin:/usr/bin:/bin`; process.env.BMN_SHIPPED_SKILLS = join(root, 'shipped')
  mkdirSync(join(root, 'shipped/plan'), { recursive: true }); mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'shipped/manifest.json'), JSON.stringify({ skills: ['plan'] }))
  writeFileSync(join(root, 'shipped/plan/SKILL.md'), '---\nname: plan\ndescription: Synthetic plan\n---\nSynthetic coordinator skill')
  for (const [app, version] of Object.entries(versions)) writeFileSync(join(root, 'bin', app), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${app} ${version}"; exit 0; fi\nexit 64\n`, { mode: 0o755 })
  mkdirSync(agentsDirectory(), { recursive: true })
})
afterEach(() => {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  rmSync(root, { recursive: true, force: true })
})

describe('fresh setup defaults coordinator', () => {
  it('prepares an empty source for every app set without a Claude folder or pre-approval assets', async () => {
    const result = await prepare(); assert.equal(result.code, 'OK'); assert.deepEqual(result.names, ['plan'])
    assert.equal(result.source, join(agentsDirectory(), 'skills')); assert(existsSync(result.source))
    assert(!existsSync(join(root, '.claude'))); assert(!existsSync(masterPath())); assert(!existsSync(join(result.source, 'plan')))
  })

  it('requires approval before assets or even a first apply claim are initialized', async () => {
    const result = await coordinateSetupDefaults(request('apply', ['codex'], true))
    assert.equal(result.code, 'NOT_APPROVED'); assert(!existsSync(defaultsOwnershipPath())); assert(!existsSync(masterPath()))
  })

  it('never recreates missing or corrupt ownership after the durable claim was used', async () => {
    await prepare(); approve(); rmSync(defaultsOwnershipPath())
    assert.equal((await apply()).code, 'DEFAULTS_STATE_UNAVAILABLE'); assert(!existsSync(masterPath()))
    writeFileSync(defaultsOwnershipPath(), '{bad synthetic state')
    assert.equal((await apply()).code, 'DEFAULTS_STATE_UNAVAILABLE'); assert(!existsSync(masterPath()))
  })

  for (const app of ['codex', 'opencode']) it(`installs ${app}-only rules, skills, hooks and qualified tools from the approved portable source`, async () => {
    await prepare(); approve(); qualify(app)
    const result = await apply([app]); assert.equal(result.code, 'OK', JSON.stringify(result))
    assert(existsSync(targetPath(app))); assert(!existsSync(join(root, '.claude')))
    const entries = Object.values(readDefaultsOwnership(setupId).snapshot().entries)
    for (const kind of ['rules', 'skills', 'hooks', 'tools']) assert(entries.some(row => row.target.app === app && row.target.kind === kind), kind)
    assert(result.rows.filter(row => row.app === app).every(row => row.code === 'OK'))
    assert(!readFileSync(targetPath(app), 'utf8').includes('Synthetic personal data'))
  })

  it('reports skills an app already holds as current on the next read, not waiting', async () => {
    await prepare(); approve(); qualify('codex')
    const first = await apply(['codex']); assert.equal(first.code, 'OK', JSON.stringify(first))
    assert.equal(first.rows.find(row => row.kind === 'skills' && row.app === 'codex').state, 'installed')
    const next = await apply(['codex']); assert.equal(next.code, 'OK', JSON.stringify(next))
    assert.equal(next.rows.find(row => row.kind === 'skills' && row.app === 'codex').state, 'current')
  })

  it('adds a later ready app on the next read while keeping an undone rules file absent after restart', async () => {
    await prepare(); approve(); qualify('codex'); qualify('claude')
    const first = await apply(['codex']); assert.equal(first.code, 'OK', JSON.stringify(first))
    const rules = first.rows.find(row => row.kind === 'rules' && row.app === 'codex')
    assert.equal((await restoreTransaction(rules.transaction, { yes: true, asJson: true })).code, 'OK')
    const next = await apply(['codex', 'claude']); assert.equal(next.code, 'OK', JSON.stringify(next))
    assert(!existsSync(targetPath('codex'))); assert(existsSync(targetPath('claude')))
    assert.equal(next.rows.find(row => row.kind === 'rules' && row.app === 'codex').state, 'opted-out')
    const restart = await coordinateSetupDefaults(request('apply', ['codex', 'claude']))
    assert.equal(restart.code, 'OK', JSON.stringify(restart)); assert(!existsSync(targetPath('codex')))
  })

  it('refuses Undo without mutation while refresh holds admission, then accepts a fresh plan after release', async () => {
    await prepare(); approve(); qualify('codex')
    const first = await apply(['codex']); assert.equal(first.code, 'OK')
    const rules = first.rows.find(row => row.kind === 'rules' && row.app === 'codex')
    const shown = await restoreTransaction(rules.transaction, { planOnly: true, asJson: true })
    assert.equal(shown.code, 'OK')
    const beforeTarget = readFileSync(targetPath('codex')), beforeOwnership = readFileSync(defaultsOwnershipPath())
    const admission = new URL('../../apps/desktop/bin/defaults-admission.mjs', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {withDefaultsAdmission} from ${JSON.stringify(admission)};
      await withDefaultsAdmission(async()=>{
        process.stdout.write('ADMITTED\\n');
        await new Promise(resolve=>process.stdin.once('data',resolve));
      },{directory:process.argv[1]});
    `, join(agentsDirectory(), 'state')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const ended = once(child, 'exit')
    try {
      const [bytes] = await Promise.race([once(child.stdout, 'data'), ended.then(() => { throw Error('admission child exited early') })])
      assert.match(bytes.toString(), /ADMITTED/)
      const refused = await restoreTransaction(rules.transaction, { yes: true, asJson: true, expectedPlanHash: shown.plan_hash })
      assert.equal(refused.code, 'REVISION_CONFLICT')
      assert.deepEqual(refused.restored, [])
      assert.deepEqual(readFileSync(targetPath('codex')), beforeTarget)
      assert.deepEqual(readFileSync(defaultsOwnershipPath()), beforeOwnership)
    } finally { child.stdin.end('release\n'); assert.equal((await ended)[0], 0) }
    const fresh = await restoreTransaction(rules.transaction, { planOnly: true, asJson: true })
    assert.equal(fresh.code, 'OK'); assert.equal(fresh.plan_hash, shown.plan_hash)
    assert.equal((await restoreTransaction(rules.transaction, { yes: true, asJson: true, expectedPlanHash: fresh.plan_hash })).code, 'OK')
    assert(!existsSync(targetPath('codex')))
    assert(Object.values(readDefaultsOwnership(setupId).snapshot().entries).find(row => row.transaction === rules.transaction).optOut)
    assert.equal((await apply(['codex'])).code, 'OK'); assert(!existsSync(targetPath('codex')))
  })

  it('leaves a foreign master and every absent app rules file unchanged', async () => {
    await prepare(); approve(); qualify('codex'); writeFileSync(masterPath(), '# Synthetic personal data\n')
    const result = await apply(); assert.equal(result.code, 'DEFAULTS_PARTIAL')
    assert.equal(readFileSync(masterPath(), 'utf8'), '# Synthetic personal data\n'); assert(!existsSync(targetPath('codex')))
    assert.equal(result.rows.find(row => row.kind === 'rules').code, 'DEFAULTS_MASTER_UNAVAILABLE')
  })

  it('settles an app that no approved tool reaches without running or writing its tools', async () => {
    await prepare(); approve(setupSkillsSource(), ', apps: [claude, codex]')
    appendFileSync(skillsTestsPath(), JSON.stringify({ harness: 'opencode', kind: 'capability', version: versions.opencode, outcome: 'pass',
      roots: [{ root: '.config/opencode/skills', folder: true, link: true }] }) + '\n')
    const result = await apply(['opencode']); assert.equal(result.code, 'OK', JSON.stringify(result))
    const tools = result.rows.filter(row => row.kind === 'tools')
    assert.deepEqual(tools.map(row => [row.app, row.code, row.state, row.paths.length]), [['opencode', 'OK', 'excluded', 0]])
    assert(!Object.values(readDefaultsOwnership(setupId).snapshot().entries).some(row => row.target.kind === 'tools'))
    assert(!existsSync(join(root, '.config/opencode/opencode.jsonc')))
  })

  it('installs a tool kept to some agents into no app', async () => {
    await prepare(); approve(setupSkillsSource(), ', agents: [sol]'); qualify('codex')
    const result = await apply(['codex']); assert.equal(result.code, 'OK', JSON.stringify(result))
    assert.deepEqual(result.rows.filter(row => row.kind === 'tools').map(row => [row.app, row.code, row.state]), [['codex', 'OK', 'excluded']])
    assert(!existsSync(join(root, '.codex/config.toml')))
  })

  it('reports completed rules separately from a tools test that has not passed', async () => {
    await prepare(); approve()
    const result = await apply(); assert.equal(result.code, 'DEFAULTS_PARTIAL')
    assert(result.rows.find(row => row.kind === 'rules').paths.includes(targetPath('codex')))
    const tools = result.rows.find(row => row.kind === 'tools'); assert.notEqual(tools.code, 'OK'); assert.equal(tools.paths.length, 0)
    assert(!JSON.stringify(result).includes('Synthetic coordinator skill'))
  })

  it('refuses a changed rules file on later reads and leaves its exact bytes intact', async () => {
    await prepare(); approve(); qualify('codex'); assert.equal((await apply()).code, 'OK')
    writeFileSync(targetPath('codex'), 'Synthetic foreign rules\n')
    const result = await apply(); assert.equal(result.code, 'DEFAULTS_PARTIAL')
    assert.equal(result.rows.find(row => row.kind === 'rules').code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(targetPath('codex'), 'utf8'), 'Synthetic foreign rules\n')
  })

  it('reports the whole previous shared file holding after initial hook publication', async () => {
    await prepare(); approve(); qualify('codex')
    mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/hooks.json'), '{"theme":"synthetic"}\n')
    const result = await apply(); assert.equal(result.code, 'OK', JSON.stringify(result))
    const recovery = result.rows.filter(row => row.kind === 'hooks').flatMap(row => row.recoveryPaths)
    assert(recovery.length > 0); assert(recovery.every(path => existsSync(path)))
    assert.equal(readFileSync(recovery[0], 'utf8'), '{"theme":"synthetic"}\n')
    const reread = await apply()
    const repeated = reread.rows.flatMap(row => row.recoveryPaths)
    assert(recovery.every(path => repeated.includes(path)), 'later reads retain every original hook holding')
    const unavailable = await apply([])
    assert(recovery.every(path => unavailable.rows.flatMap(row => row.recoveryPaths).includes(path)), 'an unavailable app does not hide its recovery history')
  })

  it('keeps Undo holdings visible across later reads without reinstating the removed default', async () => {
    await prepare(); approve(); qualify('codex')
    const first = await apply()
    const rules = first.rows.find(row => row.kind === 'rules' && row.app === 'codex')
    assert.equal((await restoreTransaction(rules.transaction, { yes: true, asJson: true })).code, 'OK')
    const manifest = JSON.parse(readFileSync(join(agentsDirectory(), 'state/rules/transactions', rules.transaction, 'manifest.json'), 'utf8'))
    const path = manifest.setup.removal.holdingPath
    assert(existsSync(path))
    const next = await apply()
    assert(next.rows.flatMap(row => row.recoveryPaths).includes(path), 'whole-file Undo holding remains discoverable')
    assert(!existsSync(targetPath('codex')))
  })

  it('does not redirect defaults into an edited or owner-shaped approved source', async () => {
    await prepare(); approve(join(root, 'personal-skills'))
    assert.equal((await apply()).code, 'DEFAULTS_SOURCE_CHANGED'); assert(!existsSync(masterPath()))
  })

  it('rejects malformed requests without reflecting their payload or writing a journal', async () => {
    for (const value of [null, {}, { ...request(), privateText: 'synthetic-secret-canary' },
      { ...request(), ready: [{ app: 'codex', version: '0.163.0' }, { app: 'codex', version: '0.163.0' }] }]) {
      assert.equal(validSetupDefaultsRequest(value), false)
      const result = await coordinateSetupDefaults(value); assert.equal(result.code, 'INVALID_ARGUMENT')
      assert(!JSON.stringify(result).includes('synthetic-secret-canary'))
    }
    assert(!existsSync(defaultsOwnershipPath()))
  })
})
