/* global window */
// MODULE: browser-accounts-switch.mjs - Isolated real Tools confirmation, browser-only takeover, and exact Undo.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { parseRoster, rewriteRoster, sha256, starterRoster } from '../../apps/desktop/bin/agents-roster.mjs'
import { buildGeneration } from '../../apps/desktop/bin/agents-state.mjs'
import { atomicJson } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { readAppTools } from '../../apps/desktop/bin/agents-tools.mjs'
import { isolatedMain, recordProcess, result, stopProcess } from './browser-accounts-fixture.mjs'

const out = resolve(process.argv[2] || '.dev-auto/evidence/browser-switch')
isolatedMain(out)
recordProcess(process.pid, '97 isolated Tools browser-switch driver')
const home = process.env.HOME, state = join(home, '.config/bmn/agents/state'), stubs = join(home, 'stubs')
const environment = { ...process.env, XDG_CONFIG_HOME: join(home, '.config'), BMN_CONFIG_HOME: join(home, '.config/bmn'),
  BMN_STATE_HOME: join(home, 'state/bmn'), BMN_RUNTIME_HOME: join(process.env.XDG_RUNTIME_DIR, 'bmn'),
  BMN_LAUNCH_CWD: home, PATH: `${stubs}:${process.env.PATH}`, SHELL: '/bin/bash' }
mkdirSync(join(state, 'generations'), { recursive: true }); mkdirSync(stubs)
const data = { schema_version: 3, agents: [], roles: [], exceptions: [],
  providers: [{ id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' },
    { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' }],
  harness_routes: [{ harness: 'codex', provider: 'openai', basis: 'observed-default' }, { harness: 'claude', provider: 'anthropic', basis: 'observed-default' }],
  tools: [{ id: 'playwright', name: 'Playwright', command: 'bmn', args: ['browser', 'server'], public: true },
    { id: 'notes', name: 'Notes', command: 'approved-notes', apps: ['claude'] }] }
const roster = rewriteRoster(starterRoster(), data)
const parsed = parseRoster(roster)
assert.deepEqual(parsed.errors, [], 'synthetic roster must satisfy the real schema')
writeFileSync(join(state, '../roster.md'), roster)
const generation = buildGeneration({ number: 1, parent: null, data: parsed.data, rosterFileHash: sha256(roster) })
atomicJson(join(state, 'generations/000001.json'), generation)
atomicJson(join(state, 'current'), { generation: 1, hash: generation.hash })
const versions = { claude: '2.1.295', codex: '0.161.0', opencode: '2.0.29' }
for (const [app, version] of Object.entries(versions)) {
  const file = join(stubs, app)
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${app} ${version}'; else exit 1; fi\n`); chmodSync(file, 0o755)
}
writeFileSync(join(state, 'tools-tests.jsonl'), Object.entries(versions).map(([harness, version]) => JSON.stringify({
  harness, version, at: '2026-10-28T00:00:00.000Z', detail: 'synthetic capability fixture', outcome: 'pass', variable: 'pass', argument: 'pass', own_command: 'pass',
  ...(harness === 'opencode' ? { entry_layout: 'mcp.servers' } : {})
})).join('\n') + '\n')
const paths = [join(home, '.claude.json'), join(home, '.codex/config.toml'), join(home, '.config/opencode/opencode.jsonc')]
const originals = ['{"mcpServers":{"playwright":{"command":"owner-browser"},"notes":{"command":"owner-notes"}},"tips":{}}\n',
  '# owner\n[mcp_servers.playwright]\ncommand = "owner-browser"\n', '{"mcp":{"servers":{"playwright":{"type":"local","command":["owner-browser"],"enabled":true}}}}\n']
paths.forEach((path, i) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, originals[i]) })
const unchanged = () => paths.forEach((path, i) => assert.equal(readFileSync(path, 'utf8'), originals[i], 'an unconfirmed or undone switch changed settings'))
const require = createRequire(resolve('apps/desktop/package.json'))
let application, identity
const checks = []
try {
  application = await electron.launch({ executablePath: require('electron'), chromiumSandbox: true,
    args: ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', resolve('apps/desktop'), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'], cwd: home, env: environment })
  identity = recordProcess(application.process().pid, '97 disposable Tools browser-switch Electron')
  const page = await application.firstWindow()
  await page.locator('.preferences-button').click()
  const dialog = page.locator('.preferences-dialog'), main = dialog.locator('.preferences-page:not([hidden])')
  await dialog.locator('.preferences-nav .nav-item', { hasText: /^Integrations/ }).click()
  await main.locator('.page-views [role=radio]', { hasText: /^Tools$/ }).click()
  const apply = main.getByRole('button', { name: 'Apply browser switch…', exact: true })
  await apply.waitFor()
  unchanged()
  assert.equal(await main.locator('[data-unlisted]').count(), 0, 'this flow must work without the unrelated removal section')
  for (const width of [1440, 900]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, 1000), { width })
    await page.waitForFunction(w => window.innerWidth === w, width)
    await apply.scrollIntoViewIfNeeded()
    await main.locator('.browser-accounts').screenshot({ path: join(out, `${width}-apply.png`) })
    const bounds = await apply.boundingBox()
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'browser action outside viewport')
  }
  await apply.click()
  const sheet = main.getByRole('group', { name: 'Change 3 tool entries', exact: true })
  await sheet.waitFor()
  assert.equal(await sheet.locator('details.target').count(), 3)
  assert(!(await sheet.textContent()).includes('notes'), 'the browser confirmation includes an unrelated tool')
  await sheet.screenshot({ path: join(out, 'confirmation.png') })
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
  unchanged()
  checks.push('approved browser takeover is visible at 1440/900 with no unlisted entries; exact three-entry preview; Cancel changes nothing')
  await apply.click()
  await sheet.getByRole('button', { name: 'Change', exact: true }).click()
  await apply.waitFor({ state: 'detached' })
  for (const harness of ['claude', 'codex']) assert.deepEqual(readAppTools(harness, environment).entries.get('playwright').value.args, ['browser', 'server', harness])
  assert.equal(readAppTools('codex', environment).entries.get('playwright').value.required, true)
  assert.equal(readAppTools('claude', environment).entries.get('notes').value.command, 'owner-notes')
  assert.equal(readAppTools('opencode', environment).entries.get('playwright').value.command[0], 'npx')
  checks.push('actual renderer/preload/IPC/CLI install scopes only Playwright; private Claude/Codex entries and anonymous public OpenCode; unrelated approved unmanaged Notes untouched')
  await main.getByText('Earlier installs', { exact: true }).click()
  await main.getByRole('button', { name: /^Undo the tools install/ }).click()
  const undo = main.getByRole('group', { name: 'Undo this install', exact: true })
  await undo.waitFor()
  await undo.screenshot({ path: join(out, 'undo.png') })
  assert(!(await undo.textContent()).includes('notes'), 'Undo includes an unrelated entry')
  await undo.getByRole('button', { name: 'Undo', exact: true }).click()
  await apply.waitFor()
  unchanged()
  checks.push('actual Tools Undo restores all three original files byte for byte and offers the browser switch again')
  result(out, 'browser-switch', checks, ['synthetic version/capability fixtures; native client contract covered separately; installed owner Save still required'])
} catch (error) {
  atomicJson(join(out, 'result.json'), { result: 'FAIL', checks, name: error.name, message: error.message })
  throw error
} finally {
  if (application) {
    const child = application.process()
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(ok => child.once('exit', ok))
      let timer
      const ended = await Promise.race([exited.then(() => true), new Promise(ok => { timer = setTimeout(() => ok(false), 5000) })])
      clearTimeout(timer)
      if (!ended) { assert(identity); stopProcess(identity); await exited }
    }
  }
}
