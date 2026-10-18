/* global window, document, getComputedStyle */
// MODULE: push-policy-live.mjs - Story 83.3 (and 83.5's Save and Undo): Health › Pushes and merges on the running build. A fresh profile starts with no owner allowed; the owner allows an account with its switch and raises a repository with the keyboard; `bmn policy` reads what Health stored, through the app's own socket; the rules Save that adds the policy pointer puts it in force and Undo takes it out; a restart keeps the rows; denying every owner is the off switch; a store that cannot be read shows as unknown, denied, and is not written over
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end), on the unit-test roster, a synthetic
// rules master, two made-up Git folders whose origin names a made-up GitHub repository, and stand-in `claude`, `codex`,
// `opencode` and `gh` programs (the `gh` stand-in answers for the two made-up repositories and nothing else). No agent runs,
// nothing leaves the machine and no file of the owner's is read. Prints one JSON report, PASS or FAIL per check.
// Usage: node scripts/test/push-policy-live.mjs [report.json] [shots-folder]   (needs `pnpm --filter @bmn/desktop build` first)
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { testedApp } from '../lib/tested-app.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const fixtures = join(appDirectory, 'src/utility/test-fixtures')
const cli = join(appDirectory, 'bin/bmn')
const tested = testedApp(appDirectory)
console.log(`BMN build: ${tested.build}`)
const reportPath = tested.rest[0] ? resolve(tested.rest[0]) : null
const shots = tested.rest[1] ? resolve(tested.rest[1]) : null
const phase = (label) => console.error(`[BMN push policy] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const MASTER = '# Global rules\n\nPlain rule for everyone.\n'
// The pointer line the owner approved for his master (Story 83.5's text card, 2026-10-18), here in a made-up master.
const POINTER = 'Pushes, merges and pull requests follow BMN\'s policy: before each push, merge or PR write, read `bmn policy --repo` and act only within what it authorizes.\n'

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND' && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))

const report = { generatedAt: new Date().toISOString(), commit: null, checks: [] }
const check = (name, ok, detail = {}) => {
  const result = ok === null ? 'UNVERIFIED' : ok ? 'PASS' : 'FAIL'
  report.checks.push({ name, result, ...detail })
  phase(`${result} ${name} ${JSON.stringify(detail)}`)
}
try { report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* no git */ }
if (shots) mkdirSync(shots, { recursive: true })

async function until(probe, what, timeout = 30_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const stubs = join(root, 'stubs')
  const agentsDir = join(home, '.config/bmn/agents')
  for (const folder of [agentsDir, join(agentsDir, 'state'), stubs]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentsDir, 'roster.md'), readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8'))
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  const repository = (name, remote) => {
    const folder = join(root, name)
    mkdirSync(folder, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', folder])
    execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', remote])
    return folder
  }
  const widgets = repository('widgets', 'git@github.com:octo-probe/widgets.git')
  const api = repository('api', 'https://github.com/acme-probe/api.git')
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  stub('claude', 'case "$1" in --version) echo "2.1.302 (Claude Code)";; *) exit 1;; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) exit 4;; esac')
  stub('opencode', 'case "$1" in --version) echo "2.0.29";; *) exit 1;; esac')
  stub('gh', `case "$1 $2" in
  "auth status") echo "  ✓ Logged in to github.com account octo-probe (keyring)" >&2;;
  "repo view") case "$3" in
    octo-probe/widgets) echo '{"owner":{"login":"octo-probe"},"isInOrganization":false,"defaultBranchRef":{"name":"main"},"name":"widgets"}';;
    acme-probe/api) echo '{"owner":{"login":"acme-probe"},"isInOrganization":true,"defaultBranchRef":{"name":"trunk"},"name":"api"}';;
    *) echo "HTTP 404" >&2; exit 1;;
  esac;;
  *) exit 1;;
esac`)
  const socket = join(roots.runtime, 'bmn/control/control.sock')
  const environment = {
    ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: `${stubs}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
    BMN_LAUNCH_CWD: widgets,
    ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
  }
  const policy = (...args) => {
    try {
      return execFileSync(process.execPath, [cli, 'policy', ...args, '--owner', '--socket', socket], { encoding: 'utf8', env: { ...environment, PATH: `${stubs}:${process.env.PATH}` }, cwd: root })
    } catch (error) { return `exit ${error.status}: ${error.stderr}` }
  }
  const launch = () => electron.launch({
    executablePath: tested.executablePath,
    args: [...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: environment
  })
  const close = async (application) => {
    const page = await application.firstWindow().catch(() => null)
    await page?.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces()) {
        for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => undefined)
      }
    }).catch(() => undefined)
    await Promise.race([application.close().catch(() => undefined), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
  const ready = async (application, width = 1280) => {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.show(); window.setContentSize(size, 860) }, width)
    return page
  }
  const openHealth = async (page) => {
    const dialog = page.locator('dialog.preferences-dialog')
    if (await dialog.count() === 0) {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.locator('#palette-results').waitFor()
      await page.keyboard.type('Preferences')
      await page.keyboard.press('Enter')
      await dialog.waitFor()
    }
    await dialog.locator('nav.preferences-nav .nav-item', { hasText: /^Integrations/ }).click()
    await dialog.locator('.page-views [role="radio"]', { hasText: /^Health$/ }).click()
    const main = dialog.locator('.preferences-main')
    await main.locator('#health-push-policy').waitFor()
    await main.locator('#health-push-policy').scrollIntoViewIfNeeded()
    return main
  }
  const openEditor = async (page) => {
    const dialog = page.locator('dialog.preferences-dialog')
    await dialog.locator('.page-views [role="radio"]', { hasText: /^Rules$/ }).click()
    return dialog.locator('.preferences-main')
  }
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
  const owner = (main, login) => main.locator('.policy-owner', { has: main.page().locator('.mono', { hasText: new RegExp(`^${login}$`) }) })
  const ownerText = async (main, login) => (await owner(main, login).innerText()).replace(/\s+/g, ' ').trim()
  const repositories = async (main) => main.locator('.policy-repository').evaluateAll((rows) => rows.map((row) => ({
    name: row.querySelector('.mono')?.textContent, level: row.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? row.querySelector('.faint')?.textContent
  })))
  const note = async (main) => (await main.locator('#health-push-policy ~ .page-note').first().innerText().catch(() => '')).trim()

  let application = await launch()
  try {
    let page = await ready(application)
    await page.evaluate((folder) => window.aiTerminal.createWorkspace({ name: 'api', defaultCwd: folder }), api)

    phase('a fresh profile')
    let main = await openHealth(page)
    await owner(main, 'acme-probe').waitFor()
    const caption = await main.locator('#health-push-policy .caption').innerText()
    check('Health shows Pushes and merges with every owner the sessions work in and each signed-in account, all denied, no repository row yet (AC3, AC1 design)',
      caption === 'what your sessions may merge or push, by owner' && await ownerText(main, 'octo-probe') === 'octo-probe Account Denied · 1 repository'
        && await ownerText(main, 'acme-probe') === 'acme-probe Org Denied · 1 repository' && (await repositories(main)).length === 0
        && await note(main) === 'Not in force yet: no owner is allowed in Health.',
      { caption, octo: await ownerText(main, 'octo-probe'), acme: await ownerText(main, 'acme-probe'), note: await note(main) })
    const fresh = policy('--repo', 'octo-probe/widgets')
    check('`bmn policy` on a fresh profile authorizes nothing and says why (AC4)', fresh.includes('Push policy: authorizes nothing: no owner is allowed in Health.')
      && fresh.includes('Repository octo-probe/widgets: PRs only (default branch main).'), { fresh })
    await shot(page, 'health-policy-fresh-1280.png')

    phase('allow an owner, raise a repository with the keyboard')
    await owner(main, 'octo-probe').getByRole('switch', { name: 'Allow octo-probe' }).click()
    await until(async () => (await ownerText(main, 'octo-probe')) === 'octo-probe Account Allowed', 'the owner allowed')
    await until(async () => (await note(main)).includes('pointer'), 'the store\'s answer')
    const listed = await repositories(main)
    check('allowing an owner stores it and lists its repository at PRs only; the policy is not in force without the master\'s pointer (AC2, AC5)',
      JSON.stringify(listed) === JSON.stringify([{ name: 'widgets', level: 'PRs only' }]) && await note(main) === 'Not in force yet: the rules master does not carry the policy pointer.',
      { listed, note: await note(main) })
    await main.locator('.policy-repository [role="radio"][aria-checked="true"]').focus()
    await page.keyboard.press('ArrowRight')
    await until(async () => (await repositories(main))[0]?.level === 'Merge when green', 'Merge when green')
    await page.keyboard.press('ArrowRight')
    await until(async () => (await repositories(main))[0]?.level === 'Merge and push main', 'Merge and push main')
    const focused = await page.evaluate(() => document.activeElement?.textContent)
    const raised = policy('--repo', 'octo-probe/widgets')
    check('the arrow keys move the level and the focus together; `bmn policy --repo` prints the stored level (AC5)',
      focused === 'Merge and push main' && raised.includes('Repository octo-probe/widgets: Merge and push main (default branch main).')
        && raised.includes('Not authorized here: the rules master does not carry the policy pointer.'), { focused, raised })
    const unlisted = policy('--repo', 'octo-probe/elsewhere')
    check('a repository GitHub cannot read prints PRs only with the reason (AC5)', unlisted.includes('Repository octo-probe/elsewhere: PRs only.')
      && unlisted.includes('GitHub could not be read for this repository with your gh'), { unlisted })
    await shot(page, 'health-policy-allowed-1280.png')

    phase('Save the pointer, then Undo')
    let editor = (await openEditor(page)).locator('.rules-editor textarea')
    await editor.waitFor()
    await editor.fill(`${MASTER}${POINTER}`)
    const rules = page.locator('dialog.preferences-dialog .preferences-main')
    await rules.getByRole('button', { name: 'Save…' }).click()
    await rules.locator('.sheet').getByRole('button', { name: 'Save', exact: true }).click()
    await rules.locator('.preferences-success').getByText(/^Saved and installed/).waitFor()
    main = await openHealth(page)
    await until(async () => (await main.locator('#health-push-policy .caption').innerText()).endsWith('· in force'), 'in force')
    const inForce = policy('--repo', 'octo-probe/widgets')
    const inForceNote = await note(main)
    check('the rules Save that adds the pointer puts the policy in force, in Health and in `bmn policy` (83.5 AC1)',
      inForceNote === '' && inForce.includes('Push policy: in force (revision 3).') && inForce.includes('- push main, never forced'), { inForce, inForceNote })
    await shot(page, 'health-policy-in-force-1280.png')
    editor = (await openEditor(page)).locator('.rules-editor textarea')
    const earlier = rules.locator('details.advanced', { has: page.locator('summary', { hasText: 'Earlier versions' }) })
    await earlier.locator('summary').click()
    await earlier.getByRole('button', { name: /^Undo the save of/ }).first().click()
    await rules.locator('.sheet').getByRole('button', { name: 'Undo', exact: true }).click()
    await until(async () => (await editor.inputValue()) === MASTER, 'the rules put back')
    const undone = policy('--repo', 'octo-probe/widgets')
    check('after Rules Undo the next read authorizes nothing (Decisions, Undo)', undone.includes('authorizes nothing: the rules master does not carry the policy pointer'), { undone })
  } catch (error) {
    check('the first start completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }

  application = await launch()
  try {
    phase('restart, narrow, deny')
    const page = await ready(application, 520)
    const main = await openHealth(page)
    await owner(main, 'octo-probe').waitFor()
    check('a restart keeps the allowed owner and the raised level (AC3)', await ownerText(main, 'octo-probe') === 'octo-probe Account Allowed'
      && (await repositories(main))[0]?.level === 'Merge and push main', { octo: await ownerText(main, 'octo-probe'), rows: await repositories(main) })
    const narrow = await main.locator('.policy-repository').evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length)
    const width = await page.evaluate(() => window.innerWidth)
    // The page's own older rows may scroll sideways here (an unrelated `.preferences-row`); the policy's rows must fit.
    const overflow = await main.evaluate((element) => {
      const edge = element.getBoundingClientRect().right
      return [...element.querySelectorAll('.policy-owner, .policy-owner *, .policy-repository, .policy-repository *')]
        .filter((child) => child.getBoundingClientRect().right > edge + 0.5).length
    })
    check('at the narrow width the level goes under the name, full width (AC1 design)', width <= 560 && narrow === 1 && overflow === 0, { width, columns: narrow, overflow })
    await shot(page, 'health-policy-narrow-520.png')
    await owner(main, 'octo-probe').getByRole('switch', { name: 'Allow octo-probe' }).focus()
    await page.keyboard.press('Space')
    await until(async () => (await ownerText(main, 'octo-probe')).startsWith('octo-probe Account Denied'), 'the owner denied')
    const off = policy('--repo', 'octo-probe/widgets')
    check('denying every owner is the off switch: its rows go, and the next read authorizes nothing (Decisions, Off switch)',
      (await repositories(main)).length === 0 && off.includes('authorizes nothing: no owner is allowed in Health'), { off })
  } catch (error) {
    check('the second start completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }

  // A store that cannot be read: BMN shows it as unknown, counts everyone denied, and leaves the row as it is.
  const testRequire = createRequire(join(appDirectory, 'package.json'))
  const Database = testRequire('better-sqlite3')
  const databasePath = join(roots.data, 'bmn/state.sqlite3')
  const broken = JSON.stringify({ version: 1, revision: 9, owners: [{ login: 'octo-probe', allowed: 'yes' }], levels: [] })
  const writeBroken = () => { const database = new Database(databasePath); database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run(broken, 'push-policy-v1'); database.close() }
  const readStored = () => { const database = new Database(databasePath, { readonly: true }); const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get('push-policy-v1'); database.close(); return row?.value_json }
  try {
    writeBroken()
  } catch (error) {
    check('the store could be made unreadable for the test', false, { error: error instanceof Error ? error.message : String(error) })
  }
  application = await launch()
  try {
    phase('an unreadable store')
    const page = await ready(application)
    const main = await openHealth(page)
    const alert = await main.locator('#health-push-policy ~ .preferences-error').first().innerText()
    const disabled = await owner(main, 'octo-probe').getByRole('switch').isDisabled()
    const unknown = policy('--repo', 'octo-probe/widgets')
    check('an unreadable store shows as unknown with the switches off, `bmn policy` authorizes nothing, and the row is left as it was (AC3)',
      alert.startsWith('The policy could not be read: the stored policy has an owner it cannot read. Everything counts as denied.') && disabled
        && (await ownerText(main, 'octo-probe')).includes('Unknown') && unknown.includes('authorizes nothing: the policy could not be read') && readStored() === broken,
      { alert, disabled, unknown })
    await shot(page, 'health-policy-unknown-1280.png')
  } catch (error) {
    check('the third start completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }
})

const failed = report.checks.filter((entry) => entry.result === 'FAIL')
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(failed.length === 0 ? 'PUSH POLICY LIVE: PASS' : `PUSH POLICY LIVE: FAIL (${failed.map((entry) => entry.name).join('; ')})`)
process.exitCode = failed.length === 0 ? 0 : 1
