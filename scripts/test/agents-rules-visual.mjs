/* global document, window */
// MODULE: agents-rules-visual.mjs - Epic 60.5/60.6: Preferences › Team and Rules on a synthetic roster and master in a temporary HOME
// HOME points at a scratch folder holding the synthetic roster (the unit-test fixture), a synthetic rules master and stub
// app files. BMN itself starts with the system folders only, as from the desktop; the stub claude/codex binaries are on
// the PATH the temporary home's shell settings add, as a version manager would, so every step that finds an app proves
// BMN looked where a session does. No step reaches a provider or the owner's own rules. Screenshots land in .dev-auto/evidence/epic-60/shots/ (ignored).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-60/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
// This temporary home holds no OpenCode configuration, so BMN reads its destination as unknown and an approval refuses to record it as inspected; here it is on the owner's word.
const EXAMPLE = readFileSync(join(appDirectory, 'src/utility/test-fixtures/agents/roster-example.md'), 'utf8')
  .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}')
const MASTER = `# Global rules

Plain rule for everyone.

<!-- bmn:public -->
## How to talk
Answer first, plainly.
<!-- /bmn:public -->

## Team
The team: <!-- bmn:team -->.

<!-- bmn:apps claude codex -->
PRIVATE-SENTINEL: a rule only apps that may see private work get.
<!-- /bmn:apps -->
`
const SIZES = [[800, 500], [1000, 700], [1280, 900]]
const phase = (label) => console.error(`[BMN team/rules visual] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const sha = (text) => createHash('sha256').update(text).digest('hex')

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

async function until(read, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`never saw ${label}`)
    await sleep(100)
  }
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const agentsDir = join(home, '.config/bmn/agents')
  const rosterFile = join(agentsDir, 'roster.md')
  const masterFile = join(agentsDir, 'global-rules.md')
  const stateDir = join(agentsDir, 'state')
  const stubs = join(root, 'stubs')
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(stubs)
  // BMN's own context testing starts switched off here, so no step before 63.1's own has a test running behind it.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, 'context-auto.json'), '{"version":1,"enabled":false,"told":{}}\n')
  writeFileSync(rosterFile, EXAMPLE)
  writeFileSync(masterFile, MASTER)
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('codex', 'echo "codex-cli 0.161.0"')
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  // A loading test asks the agent which rules it read; this stub has read nothing, so the test fails in words.
  stub('claude', 'case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; echo "I cannot tell";; esac')
  // Claude's rules file is a link to a file kept elsewhere; Codex's is hand-written; OpenCode and Cursor have none.
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, 'dotfiles'))
  writeFileSync(join(home, 'dotfiles/CLAUDE.md'), '# hand-kept rules\n')
  symlinkSync(join(home, 'dotfiles/CLAUDE.md'), join(home, '.claude/CLAUDE.md'))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/AGENTS.md'), '# written by hand\n')

  const rosterHash = () => sha(readFileSync(rosterFile, 'utf8'))
  const current = () => (existsSync(join(stateDir, 'current')) ? JSON.parse(readFileSync(join(stateDir, 'current'), 'utf8')) : null)
  const generation = (number) => JSON.parse(readFileSync(join(stateDir, 'generations', `${String(number).padStart(6, '0')}.json`), 'utf8'))
  const approved = () => generation(current().generation).data
  const stateHash = () => (existsSync(join(stateDir, 'current')) ? sha(readFileSync(join(stateDir, 'current'), 'utf8')) : null)

  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root,
      // Research reads each cited page itself; in the self-test the names under .test are served from this folder and nothing else is.
      BMN_SELF_TEST_PAGES: join(root, 'pages'),
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  const result = { checks: [] }
  const passed = (check) => { result.checks.push(check); phase(`PASS ${check}`) }
  let page
  const shot = async (name) => {
    await sleep(200)
    const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
  }
  try {
    page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    const resize = (width, height) => application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
    await resize(1280, 900)
    const dialog = page.locator('.preferences-dialog')
    const nav = dialog.locator('.preferences-nav')
    // The page on screen; the earlier sections stay mounted, hidden, so their state survives a visit elsewhere.
    const main = dialog.locator('.preferences-page:not([hidden])')
    const ledger = dialog.locator('.ledger')
    const line = ledger.locator('.ledger-line')
    const openPreferences = async () => {
      if (await dialog.count()) return
      await page.locator('.preferences-button').click()
      await dialog.waitFor()
    }
    const go = async (parent, sub) => {
      await nav.locator(parent === null ? '.nav-group .nav-item' : '.nav-parent > .nav-item', { hasText: new RegExp(`^${parent ?? sub}`) }).click()
      if (parent !== null && sub) await nav.locator('.nav-sub .nav-item', { hasText: new RegExp(`^${sub}$`) }).click()
    }
    const card = (name) => main.locator('.agent-card', { has: page.locator('.agent-open', { hasText: new RegExp(`^${name}$`) }) })
    const toast = dialog.locator('.toast')
    const notice = (pattern) => dialog.locator('.toast, .preferences-main [role="status"], .preferences-main [role="alert"]').filter({ hasText: pattern }).first().waitFor()
    const approve = async () => {
      const button = ledger.getByRole('button', { name: 'Approve', exact: true })
      await until(() => button.isEnabled(), 'Approve enabled')
      await button.click()
    }
    const outsideFocus = () => page.evaluate(() => { window.dispatchEvent(new Event('focus')) })

    await openPreferences()

    phase('60.5 AC1: the left navigation, and every earlier section as its own page')
    assert.deepEqual(await nav.locator('.nav-parent > .nav-item, .nav-group .nav-item, .nav-sub .nav-item').allTextContents().then((items) => items.map((item) => item.trim())),
      ['Team', 'Agents', 'Roles', 'Models', 'Changes', 'Rules', 'Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup'])
    assert.equal(await dialog.locator('.preferences-jump').count(), 0)
    for (const title of ['Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup']) {
      await go(null, title)
      await main.locator('h3', { hasText: new RegExp(`^${title}$`) }).waitFor()
      assert.equal(await main.count(), 1, `${title} shares the screen with another page`)
      assert.equal(await nav.locator('.nav-sub').count(), 0, 'sub-pages show although their parent is closed')
    }
    await shot('page-appearance-1280.png')
    await go('Rules')
    assert.deepEqual(await nav.locator('.nav-sub .nav-item').allTextContents(), ['Editor', 'Skills', 'Tools', 'Health'])
    await go('Team')
    passed('Team and Rules head the navigation with their sub-pages; the eight earlier sections are pages; no jump list (60.5 AC1)')

    phase('60.5 AC6: nothing approved yet; Team says so and offers the first approval')
    await main.getByText('Nothing here takes effect until you approve the team for the first time.').waitFor()
    await main.getByText('Nothing approved yet').waitFor()
    assert.equal(current(), null)
    await shot('team-unapproved-1280.png')

    phase('first approval with one proposed agent activated')
    await card('Sonnet').getByRole('button', { name: 'Activate' }).click()
    await ledger.getByText('First approval', { exact: true }).waitFor()
    await ledger.getByText('6 active agents and 10 roles take effect').waitFor()
    // Approve with Review never opened: nothing is approved yet; the sheet names the allowed folder first, and Cancel leaves it so.
    await approve()
    const firstSheet = ledger.locator('.ledger-sheet[role="group"]')
    await firstSheet.getByText('Approve the team for the first time').waitFor()
    assert.equal(stateHash(), null, 'a first approval committed from the footer before its sheet was shown')
    assert.match((await firstSheet.locator('.review-group').first().textContent()).replace(/\s+/g, ' '), /^Allowed workspaces.*Z\.ai · workspace.*\/synthetic\/EXCEPTION-SENTINEL-FOLDER/)
    await shot('team-first-approval-sheet-1280.png')
    await firstSheet.getByRole('button', { name: 'Cancel', exact: true }).click()
    await firstSheet.waitFor({ state: 'detached' })
    assert.equal(stateHash(), null)
    await ledger.getByRole('button', { name: 'Review' }).click()
    // One row per agent with what it could do, one per role with its chain; never a list of loose sentences.
    const review = ledger.locator('.ledger-sheet .review-group')
    await review.filter({ hasText: /^Sonnet/ }).getByText('Can be given work, may receive private work').waitFor()
    await review.filter({ hasText: /^Lead/ }).locator('.chain-step').first().waitFor()
    assert.equal(await review.count(), 17, 'six agents, ten roles and the allowed workspaces')
    // A first approval also allows private work in a folder: the folder is named in full before Approve.
    const allowed = review.filter({ hasText: /^Allowed workspaces/ })
    assert.match((await allowed.textContent()).replace(/\s+/g, ' '), /Z\.ai · workspace.*\/synthetic\/EXCEPTION-SENTINEL-FOLDER.*Z\.ai could receive private work in one more workspace/)
    assert.deepEqual(await ledger.locator('.ledger-sheet .review > .consequence').allTextContents(), [], 'no loose sentence is left over')
    await shot('team-first-approval-1280.png')
    await approve()
    await firstSheet.getByText('Approve the team for the first time').waitFor()
    assert.equal(stateHash(), null)
    await firstSheet.getByRole('button', { name: 'Approve', exact: true }).click()
    await notice(/^Approved · version 1$/)
    assert.equal(current()?.generation, 1)
    // The message floats over the page, takes no room from it and leaves by itself.
    assert.equal(await ledger.count(), 0, 'the footer stays after an approval')
    await toast.waitFor({ state: 'detached', timeout: 8_000 })
    assert.equal(approved().agents.find((agent) => agent.id === 'sonnet').status, 'active')
    await main.getByText(/^Approved \w+ \d+, \d\d:\d\d$/).waitFor()
    passed('first approval with one agent activated (60.5 AC6, AC7)')

    phase('60.5 AC2: a card shows piece, name, class, notes, app · model, public work only and the price')
    const sol = card('Sol')
    assert.equal(await sol.locator('.class-word').textContent(), 'Knight')
    assert.match(await sol.locator('.agent-app').textContent(), /^Codex · gpt-6\.1-sol$/)
    assert.equal(await sol.locator('.price').textContent(), '$1.25 / $10.00')
    assert.match(await sol.locator('.agent-notes').textContent(), /PROSE-SENTINEL-SOL/)
    assert.match(await card('GLM-5\\.3').locator('.agent-app').textContent(), /public work only$/)
    assert.equal(await card('GLM-5\\.3').locator('.agent-notes').textContent(), 'NOTE-SENTINEL-GLM')
    assert.equal(await card('Fable').locator('.class-word').textContent(), 'Rook')
    assert.deepEqual(await main.locator('.group-head').evaluateAll((heads) => heads.map((head) => head.firstChild.textContent)), ['Active', 'Proposed', 'Off'])
    passed('cards carry the class piece and word, notes, app · model, public work only, price; groups Active, Proposed, Off')

    phase('switch an agent off with a reason')
    await card('Opus').getByRole('switch', { name: 'Opus on' }).click()
    await main.getByLabel('Why Opus is off').fill('Subscription paused')
    await main.getByRole('button', { name: 'Turn off', exact: true }).click()
    await ledger.getByText('1 unapproved change', { exact: true }).waitFor()
    await line.getByText('Opus could no longer be given work').waitFor()
    await shot('team-staged-1280.png')
    await approve()
    await notice(/^Approved · version 2/)
    assert.deepEqual([approved().agents.find((agent) => agent.id === 'opus').enabled, approved().agents.find((agent) => agent.id === 'opus').enabled_note], [false, 'Subscription paused'])
    assert.equal(await card('Opus').locator('.agent-notes').textContent(), 'Subscription paused')
    passed('switching Opus off asks for the reason, counts as one change and approves version 2')

    phase('a provider answer changes for every agent on it; Discard and Escape leave file and state unchanged')
    const before = { roster: rosterHash(), state: stateHash() }
    await card('Astra').locator('.agent-open').click()
    await main.locator('.page-head', { hasText: /Team\s*›\s*Astra/ }).waitFor()
    await main.getByText('Set once for OpenAI; it covers every agent there: Sol, Astra, Luna.').waitFor()
    await shot('agent-1280.png')
    await main.getByRole('button', { name: 'Change private work for OpenAI' }).click()
    await main.getByRole('radio', { name: 'Public work only' }).click()
    await line.getByText('Changing OpenAI to Public work only stops Sol, Astra and Luna receiving private work').waitFor()
    await ledger.getByRole('button', { name: 'Review' }).click()
    await ledger.locator('.review-group', { hasText: 'Providers' }).waitFor()
    await shot('agent-review-1280.png')
    await ledger.getByRole('button', { name: 'Discard' }).click()
    await ledger.waitFor({ state: 'detached' })
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, before)
    await main.getByLabel('Context limit').fill('200 000')
    await line.getByText('Astra: context limit app default → 200 000').waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, before)
    await openPreferences()
    assert.equal(await ledger.count(), 0)
    passed('a provider answer names each agent it changes; Discard and Escape leave the file and state hashes unchanged (60.5 AC3, AC7, AC8)')

    phase('60.5 AC3: the agent page rows, with Advanced closed')
    await card('Sol').locator('.agent-open').click()
    assert.deepEqual(await main.locator('.group-head').allTextContents(), ['Identity', 'Model', 'Work'])
    assert.deepEqual(await main.locator(':scope > .preferences-row .preferences-row-label').allTextContents(),
      ['Name', 'Class', 'Notes', 'Agent app', 'Model', 'Private work', 'Price', 'Context limit', 'Roles', 'Efforts'])
    await main.getByText('of 400 000 tokens').waitFor()
    await main.getByText('prices.example.test, 2026-10-01').waitFor()
    assert.equal(await main.locator('details.advanced').evaluate((element) => element.open), false)
    await main.locator('details.advanced > summary').click()
    assert.deepEqual(await main.locator('details.advanced .preferences-row-label').allTextContents(), ['Paid by', 'Compact at', 'Host', 'Also called', 'Team file'])
    assert.deepEqual(await main.locator('[role="radiogroup"][aria-label="Class"] .choice').allTextContents().then((lines) => lines.map((line) => line.replace(/\s+/g, ' ').trim())),
      ['Knight leads an epic/project', 'Queen does whatever she wants', 'Rook the Artist: designs what is not there yet', 'Bishop reviews and advises', 'Pawn does jobs a lead hands off'])
    assert.equal(await main.getByRole('checkbox', { name: /^Designer/ }).isDisabled(), true, 'a knight is offered the designer role')
    passed('an agent lists Identity, Model and Work rows; Advanced is closed and holds Paid by, Compact at, Host, Also called and the team file')
    await go('Team')

    phase('60.5: the Model field offers the team\'s names and takes any other')
    await main.getByRole('button', { name: 'New agent' }).click()
    const model = main.getByRole('combobox', { name: 'Model', exact: true })
    const names = main.getByRole('listbox', { name: 'Model suggestions' })
    assert.equal(await names.count(), 0, 'the panel is closed until the owner opens it')
    await model.click()
    await names.waitFor()
    assert.equal(await names.getByRole('group').first().getAttribute('aria-label'), 'On your team')
    const offered = await names.getByRole('option').locator('.mono').allTextContents()
    assert.ok(offered.length > 0 && new Set(offered).size === offered.length, `each name is offered once: ${offered.join(', ')}`)
    await shot('new-agent-model-names-1280.png')
    // Typing narrows; a name the team does not have stays exactly as typed.
    await model.fill('zzz-no-such-name')
    await names.getByText('No suggestion matches. The name stays as you typed it.').waitFor()
    await main.getByText('Typed by you. BMN does not check that Claude Code takes this name.').waitFor()
    // Escape closes the panel and nothing else: Preferences stays open and the text stays.
    await model.press('Escape')
    await names.waitFor({ state: 'detached' })
    assert.equal(await dialog.count(), 1, 'Preferences is still open')
    assert.equal(await model.inputValue(), 'zzz-no-such-name')
    // Down opens on the first name, Enter takes it, and the field says where it came from.
    await model.fill('')
    await model.press('Escape')
    await model.press('ArrowDown')
    await names.locator('.model-option.active').waitFor()
    assert.equal(await model.getAttribute('aria-activedescendant'), await names.getByRole('option').first().getAttribute('id'))
    await model.press('Enter')
    assert.equal(await model.inputValue(), offered[0])
    await main.getByText(/^From your team: .+ uses? it\. BMN does not check that Claude Code takes this name\.$/).waitFor()
    // An agent on the same model already says which efforts it runs at: the draft takes them until the owner chooses.
    const effortsRow = main.locator('.preferences-row', { has: page.getByRole('group', { name: 'Efforts' }) })
    await effortsRow.getByText(/^Taken from .+, which uses the same model\.$/).waitFor()
    assert.ok(await effortsRow.locator('[aria-pressed="true"]').count() > 1, 'the draft did not take the efforts of the agent on the same model')
    // A press on a row picks it without the field losing the focus first.
    await model.click()
    await names.getByRole('option').last().click()
    assert.equal(await model.inputValue(), offered.at(-1))
    await names.waitFor({ state: 'detached' })
    passed('the Model field lists each team name once, narrows as the owner types, keeps any other text, closes on Escape without closing Preferences and picks by keys or by a press (60.5)')

    phase('add an agent on a provider the team does not know')
    await model.fill('kimi-k3')
    await main.getByLabel('Host').fill('api.moonshot.test')
    assert.equal(await main.getByText(/^Taken from .+, which uses the same model\.$/).count(), 0, 'a model nobody uses kept another agent\'s efforts or price')
    await main.getByRole('radio', { name: 'Public work only' }).and(main.locator('[aria-checked="true"]')).waitFor()
    await main.getByText('First agent on api.moonshot.test. This answer covers every agent there.').waitFor()
    await main.getByLabel('Name').fill('Kimi')
    await main.getByLabel('Notes').fill('Cheap helper for errands')
    await main.getByRole('checkbox', { name: /^Helper/ }).check()
    await main.getByText('Kimi gets public work only. Private work is refused for it until you allow api.moonshot.test.').waitFor()
    assert.equal(await ledger.count(), 0, 'the approval footer shows on New agent')
    await shot('new-agent-1280.png')
    await main.getByRole('button', { name: 'Add to team' }).click()
    await card('Kimi').waitFor()
    assert.equal(await card('Kimi').locator('.agent-notes').textContent(), 'Cheap helper for errands')
    await approve()
    await notice(/^Approved · version 3/)
    const kimi = approved().agents.find((agent) => agent.name === 'Kimi')
    assert.deepEqual([kimi.status, kimi.enabled, kimi.host, kimi.roles], ['active', true, 'api.moonshot.test', ['helper']])
    assert.equal(approved().providers.find((provider) => provider.id === kimi.provider).private_work, 'public_only')
    await until(() => readFileSync(rosterFile, 'utf8').includes('Cheap helper for errands'), 'the new agent notes in the team file')
    passed('New agent asks the provider question with Public work only preselected, states the consequence and stages the agent as active (60.5 AC4)')

    phase('60.5 AC5: roles as rows; reorder a chain')
    await go('Team', 'Roles')
    const role = (name) => main.locator('.role', { has: page.locator('.list-line b', { hasText: new RegExp(`^${name}$`) }) })
    assert.match((await role('Lead').locator('.chain').textContent()).replace(/\s+/g, ' '), /Sol\s*xhigh.*Opus, off\s*xhigh.*Ask me/)
    assert.match(await role('Helper').locator('.chain').textContent(), /Kimi.*public work only/)
    await main.getByText('For private work, public-only agents are skipped and the next one takes the job.').waitFor()
    await shot('roles-1280.png')
    await main.getByRole('button', { name: 'Edit Epic reviewer' }).click()
    await shot('roles-edit-1280.png')
    await main.getByRole('button', { name: 'Move Fable up' }).click()
    await line.getByText('Epic reviewer would start with Fable instead of Astra').waitFor()
    await approve()
    await notice(/^Approved · version 4/)
    assert.deepEqual(approved().roles.find((entry) => entry.id === 'epic-reviewer').candidates, ['fable@medium', 'astra@medium'])
    passed('each role is one row with its chain and fallback in words; moving Fable up is approved with its consequence')

    phase('an outside role-chain edit: keep it from its row, then revert another')
    await go('Team')
    const outside = async (edit, action, subject = 'Roles', sheetText = null) => {
      const before = readFileSync(rosterFile, 'utf8')
      const next = edit(before)
      assert.notEqual(next, before, 'the outside edit changes the team file')
      writeFileSync(rosterFile, next)
      await outsideFocus()
      const row = main.locator('.outside-row', { hasText: 'in the team file:' })
      await row.waitFor()
      // A changed order is drawn as steps; the file's own spelling never shows.
      if (action === 'Keep' && subject === 'Roles') {
        assert.equal(await row.locator('.chain').count(), 2, 'the order before and after')
        assert.doesNotMatch(await row.textContent(), /@/)
      }
      if (sheetText !== null && subject !== 'Roles') assert.ok(!(await row.textContent()).includes(sheetText), 'the row gives a new entry one word')
      await shot(`team-outside-${action.toLowerCase()}-${subject.toLowerCase().replace(/\s+/g, '-')}-1280.png`)
      await row.getByRole('button', { name: `${action} the change to ${subject}` }).click()
      if (sheetText !== null) {
        // The row hides what the change does or what a new entry carries: Keep commits from the sheet that says it.
        const sheet = ledger.locator('.ledger-sheet')
        await sheet.getByText(sheetText).first().waitFor()
        await shot(`team-outside-keep-sheet-${subject.toLowerCase().replace(/\s+/g, '-')}-1280.png`)
        await sheet.getByRole('button', { name: 'Keep', exact: true }).click()
      }
      await row.waitFor({ state: 'detached' })
    }
    await outside((text) => text.replace('focused-reviewer: {candidates: [luna@max, astra@low], then: lead}', 'focused-reviewer: {candidates: [astra@low, luna@max], then: lead}'), 'Keep', 'Roles', 'Focused reviewer would start with Astra instead of Luna')
    assert.deepEqual(approved().roles.find((entry) => entry.id === 'focused-reviewer').candidates, ['astra@low', 'luna@max'])
    const approvedText = readFileSync(rosterFile, 'utf8')
    await outside((text) => text.replace('browser: {candidates: [luna@max], then: lead}', 'browser: {candidates: [luna@max], then: skip}'), 'Revert')
    assert.equal(readFileSync(rosterFile, 'utf8'), approvedText)
    // A workspace allowed outside BMN: Keep names the folder before it commits.
    const exception = 'zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}'
    await outside((text) => text.replace(exception, `${exception}\nzai-more: {provider: zai, folder: /synthetic/another-folder}`), 'Keep', 'Allowed workspaces', '/synthetic/another-folder')
    assert.ok(approved().exceptions.some((entry) => entry.folder === '/synthetic/another-folder'))
    passed('an outside role-chain edit is kept from the sheet that says what it does; another is reverted to the approved bytes; a workspace allowed outside shows its folder before Keep commits (60.5 AC2)')

    phase('60.5 AC6: view and restore an earlier version')
    await go('Team', 'Changes')
    const versions = readdirSync(join(stateDir, 'generations')).length
    await main.getByRole('button', { name: 'View version 1' }).click()
    await main.locator('.version-view').getByText('Sonnet').first().waitFor()
    // Versions are summarised in the pages' words: a role goes by its name, never by the file's id.
    assert.doesNotMatch(await main.textContent(), /\b(focused|epic)-reviewer\b/)
    await shot('changes-1280.png')
    await main.getByRole('button', { name: 'Restore version 3' }).click()
    await ledger.locator('.ledger-sheet').getByText('Restore version 3').waitFor()
    await shot('changes-restore-1280.png')
    await ledger.getByRole('button', { name: 'Restore', exact: true }).click()
    await notice(/^Version 3 restored as version \d+$/)
    const restored = generation(current().generation)
    assert.deepEqual([restored.kind, restored.restored_from], ['restore', 3])
    assert.equal(readdirSync(join(stateDir, 'generations')).length, versions + 1)
    // The team file goes back with it, so nothing shows as changed outside BMN.
    assert.match(readFileSync(rosterFile, 'utf8'), /epic-reviewer: \{candidates: \[astra@medium, fable@medium\]/)
    await go('Team')
    assert.equal(await main.locator('.outside-row').count(), 0)
    passed('version 1 is viewed read-only; version 3 is restored as a new version after its confirmation, and the team file follows')

    phase('a conflicting outside save during review reloads without writing')
    await go('Team')
    const stable = current().generation
    await card('Luna').getByRole('switch', { name: 'Luna on' }).click()
    await main.getByLabel('Why Luna is off').fill('Paused')
    await main.getByRole('button', { name: 'Turn off', exact: true }).click()
    await ledger.getByRole('button', { name: 'Review' }).click()
    await ledger.locator('.ledger-sheet').getByText('Luna could no longer be given work').waitFor()
    writeFileSync(rosterFile, readFileSync(rosterFile, 'utf8').replace('PROSE-SENTINEL-SOL', 'changed meanwhile'))
    const conflictHash = rosterHash()
    await approve()
    await notice(/^The team file changed meanwhile\. Reloaded without saving\./)
    assert.equal(current().generation, stable)
    assert.equal(rosterHash(), conflictHash)
    await toast.getByRole('button', { name: 'Dismiss the message' }).click()
    await toast.waitFor({ state: 'detached' })
    passed('an approval after an outside change is refused and reloads; no version and no write')

    phase('60.6 AC1: the editor, its Insert menu and saving with a diff')
    await go('Rules')
    const editor = main.locator('.rules-editor textarea')
    await editor.waitFor()
    await main.getByText(/^Saved \w+ \d+, \d\d:\d\d · never installed$/).waitFor()
    await main.getByText('4 apps differ').waitFor()
    assert.equal(await main.locator('.rules-editor .line-number').last().textContent(), String(MASTER.split('\n').length))
    assert.deepEqual(await main.locator('.rules-editor .marker').allTextContents(),
      ['<!-- bmn:public -->', '<!-- /bmn:public -->', '<!-- bmn:team -->', '<!-- bmn:apps claude codex -->', '<!-- /bmn:apps -->'])
    const overlay = await page.evaluate(() => {
      const text = document.querySelector('.rules-editor-text').getBoundingClientRect()
      const area = document.querySelector('.rules-editor textarea').getBoundingClientRect()
      return [Math.abs(text.width - area.width), Math.abs(text.height - area.height), Math.abs(text.top - area.top)]
    })
    assert.ok(overlay.every((difference) => difference < 1), `the editor and its painted text differ in size: ${overlay}`)
    await shot('rules-1280.png')
    await editor.focus()
    await page.keyboard.press('Control+End')
    await main.getByRole('button', { name: 'Insert ▾' }).click()
    assert.deepEqual(await main.getByRole('menuitem').allTextContents(),
      ['Section for some appsOnly the apps you name read it', 'Public sectionAlso given to public-only agents', 'TeamYour approved agents, named by app'])
    await shot('rules-insert-1280.png')
    await main.getByRole('menuitem', { name: /^Public section/ }).click()
    assert.ok((await editor.inputValue()).endsWith('<!-- bmn:public -->\n\n<!-- /bmn:public -->\n'), 'Public section did not insert its two marker lines')
    await main.getByRole('button', { name: 'Discard' }).click()
    assert.equal(await editor.inputValue(), MASTER)
    const first = `${MASTER}\nA rule added in the panel.\n`
    await editor.fill(first)
    await main.getByText(/· unsaved$/).waitFor()
    await main.getByRole('button', { name: 'Save…' }).click()
    const sheet = main.locator('.sheet')
    await sheet.getByText('Save the rules · +2 −0').waitFor()
    assert.equal(await editor.isEditable(), false, 'the rules stayed editable under an open save')
    await shot('rules-save-1280.png')
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await notice(/^Saved · not installed yet/)
    assert.equal(readFileSync(masterFile, 'utf8'), first)
    const second = `${first}A second rule.\n`
    await editor.fill(second)
    await main.getByRole('button', { name: 'Save…' }).click()
    await sheet.getByText('Save the rules · +1 −0').waitFor()
    // Save and install… saves, then shows each app's file; no app file is written before Install is pressed there.
    const codexBefore = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')
    await sheet.getByRole('button', { name: 'Save and install…' }).click()
    await sheet.getByText(/^Install to \d agent apps?$/).waitFor()
    await notice(/^Saved$/)
    assert.equal(readFileSync(masterFile, 'utf8'), second)
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), true, 'Save and install… replaced an app file before Install')
    assert.equal(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'), codexBefore, 'Save and install… wrote an app file before Install')
    assert.deepEqual(await sheet.getByRole('button').allTextContents(), ['Install', 'Cancel'])
    await shot('rules-save-and-install-1280.png')
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    passed('the editor numbers lines, dims markers, inserts sections by name and saves the text its diff showed; Save and install… goes on to the install sheet and writes no app file by itself')

    phase('NFR2: rules swapped for a link to the same bytes after the diff was shown are not saved')
    await editor.fill(`${second}A third rule.\n`)
    await main.getByRole('button', { name: 'Save…' }).click()
    await sheet.getByText('Save the rules · +1 −0').waitFor()
    writeFileSync(join(home, 'master-copy.md'), second)
    rmSync(masterFile)
    symlinkSync(join(home, 'master-copy.md'), masterFile)
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await notice(/^Something changed since this was shown\. Reloaded without writing\./)
    assert.equal(lstatSync(masterFile).isSymbolicLink(), true)
    assert.equal(readFileSync(join(home, 'master-copy.md'), 'utf8'), second)
    rmSync(masterFile)
    writeFileSync(masterFile, second)
    await go('Rules', 'Health')
    await main.getByRole('button', { name: 'Check now' }).click()
    await go('Rules')
    await until(async () => (await editor.inputValue()) === second, 'the reloaded rules')
    passed('a link swapped in with the same bytes refuses the save; nothing is written')

    phase('rules an app could not read are not saved')
    await editor.fill(`${second}\n<!-- bmn:secret -->\n`)
    await main.getByText('An app could not read these rules as written:').waitFor()
    assert.equal(await main.getByRole('button', { name: 'Save…' }).isDisabled(), true)
    await main.getByRole('button', { name: 'Discard' }).click()
    passed('rules with an unknown marker show the line and cannot be saved')

    phase('60.6 AC2: what each app reads')
    const reads = main.locator('pre.reads')
    await main.getByText(/^Full rules · /).waitFor()
    assert.match(await reads.textContent(), /PRIVATE-SENTINEL/)
    assert.match(await reads.textContent(), /The team: Claude Code \(Fable, Sonnet, Kimi\), Codex \(Sol, Astra, Luna\) \(roles, efforts and limits: `bmn team`\)\./)
    await main.getByRole('radio', { name: 'OpenCode' }).click()
    await main.getByText(/^Public sections only: /).waitFor()
    assert.doesNotMatch(await reads.textContent(), /PRIVATE-SENTINEL/)
    assert.match(await reads.textContent(), /Answer first, plainly\./)
    await shot('rules-reads-1280.png')
    await main.getByRole('radio', { name: 'Claude Code' }).click()
    passed('Claude Code reads the full rules with the Team phrase; OpenCode reads public sections only, with the reason')

    phase('60.6 AC3: install over a link and a hand-written file, then undo it')
    const install = async () => {
      await main.getByRole('button', { name: 'Install…' }).click()
      await sheet.getByText(/^Install to \d agent apps?$/).waitFor()
    }
    await install()
    await sheet.locator('.target', { hasText: 'Claude Code' }).getByText(/^Replaces a link · \+\d+ −\d+$/).waitFor()
    await sheet.locator('.target', { hasText: 'Codex' }).getByText(/^Replaces a file BMN did not write · /).waitFor()
    await sheet.locator('.target', { hasText: 'OpenCode' }).getByText('New file').waitFor()
    assert.deepEqual(await sheet.locator('.target > summary > :last-child').allTextContents(), ['Full rules', 'Full rules', 'Public sections only', 'Public sections only'])
    await shot('rules-install-1280.png')
    await sheet.getByRole('button', { name: 'Install', exact: true }).click()
    await notice(/^Installed to 4 agent apps\./)
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), false)
    assert.equal(readFileSync(join(home, 'dotfiles/CLAUDE.md'), 'utf8'), '# hand-kept rules\n')
    await main.getByText(/· last installed \w+ \d+, \d\d:\d\d$/).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Install…' }).count(), 0, 'Install… shows although no app differs')
    const earlier = main.locator('details.advanced', { has: page.locator('summary', { hasText: 'Earlier versions' }) })
    await earlier.locator('summary').click()
    await earlier.locator('.list-line', { hasText: /^Installed .* · Claude Code, Codex, OpenCode, Cursor/ }).getByRole('button', { name: /^Undo the install of/ }).click()
    await sheet.getByText('Undo this install').waitFor()
    await sheet.locator('.target', { hasText: 'Claude Code' }).getByText('Becomes a link again').waitFor()
    await shot('rules-undo-1280.png')
    await sheet.getByRole('button', { name: 'Undo install', exact: true }).click()
    await notice(/^Put back the rules in Claude Code, Codex, OpenCode and Cursor/)
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), true)
    assert.equal(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'), '# written by hand\n')
    passed('one install replaces the link and the hand-written file and names both; Undo install puts them back')

    phase('restore the rules from an earlier save')
    await earlier.locator('.list-line', { hasText: /^Saved / }).last().getByRole('button', { name: /^Restore the version saved/ }).click()
    await sheet.getByText(/^Restore this version · /).waitFor()
    await sheet.getByRole('button', { name: 'Restore', exact: true }).click()
    await notice(/^Restored · not installed yet/)
    assert.ok([MASTER, first].includes(readFileSync(masterFile, 'utf8')), 'the rules were not put back to an earlier save')
    const restoredMaster = readFileSync(masterFile, 'utf8')
    passed('Restore… puts an earlier save back after showing its diff')

    phase('60.6 AC4: Health: each rules file, the loading test, and the agent apps')
    await go('Rules', 'Health')
    const fileRow = (name) => main.locator('.health-row[data-state]', { has: page.locator(':scope > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    assert.deepEqual(await Promise.all(['Claude Code', 'Codex', 'OpenCode', 'Cursor'].map((name) => fileRow(name).getAttribute('data-state'))), ['link', 'unmanaged', 'missing', 'missing'])
    assert.match(await fileRow('Claude Code').locator('.health-state').textContent(), /Link · Full rules/)
    assert.match(await fileRow('OpenCode').locator('.health-state').textContent(), /Missing · Public sections only/)
    assert.equal(await main.getByRole('button', { name: 'Test OpenCode' }).count(), 0, 'a loading test is offered for a public-only app')
    await main.getByText('It is off for OpenCode and Cursor, which get only the public sections.').waitFor()
    await shot('health-1280.png')
    await main.getByRole('button', { name: 'Test Claude Code' }).click()
    await sheet.getByText('Starts Claude Code once and sends the rules to its provider.', { exact: false }).waitFor()
    await sheet.getByRole('button', { name: 'Send test' }).click()
    await dialog.locator('.preferences-main [role="status"], .preferences-main [role="alert"]').filter({ hasText: /^Claude Code loading test (failed|was inconclusive): / }).waitFor({ timeout: 60_000 })
    await fileRow('Claude Code').getByText(/^Test (failed|inconclusive) /).waitFor()
    // The notice reports what was done on Health: it does not follow the owner to the editor and is not there on the way back.
    await go('Rules', 'Editor')
    await main.locator('.page-title', { hasText: /^Rules$/ }).waitFor()
    assert.equal(await dialog.locator('.preferences-main [role="status"], .preferences-main [role="alert"]').filter({ hasText: /loading test/ }).count(), 0, 'the loading test notice followed to the editor')
    await go('Rules', 'Health')
    await fileRow('Claude Code').getByText(/^Test (failed|inconclusive) /).waitFor()
    assert.equal(await dialog.locator('.preferences-main [role="status"], .preferences-main [role="alert"]').filter({ hasText: /loading test/ }).count(), 0, 'the loading test notice came back')
    passed('Health shows each file with its state and rendering; the loading test says what it sends, is off for public-only apps and reports in words')

    phase('every installed app version is supported and marked; a changed destination still shows')
    const app = (name) => main.locator('.app-block', { has: page.locator('.health-row > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    await app('Codex').getByText('· tested').waitFor()
    await app('Codex').getByText("Sends data to OpenAI's own servers").waitFor()
    // The apps are on the shell's PATH only: finding them means BMN asked the shell, and it says nothing about falling back.
    await app('Codex').locator('.path', { hasText: join(stubs, 'codex') }).waitFor()
    assert.equal(await main.getByText("BMN could not read your shell's settings", { exact: false }).count(), 0, 'BMN fell back to its own environment')
    await app('Cursor').getByText('Recorded: Cursor, on your word').waitFor()
    stub('codex', 'echo "codex-cli 0.170.0"')
    await main.getByRole('button', { name: 'Check now' }).click()
    await app('Codex').getByText('· newer than tested').waitFor()
    assert.equal(await app('Codex').getByText('· newer than tested').getAttribute('title'), 'Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.')
    assert.equal(await main.getByRole('button', { name: /^Accept version/ }).count(), 0, 'Health still offers to accept a version')
    await main.getByText('Every installed version is supported', { exact: false }).waitFor()
    await shot('health-newer-version-1280.png')
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.com/v1"\n')
    await main.getByRole('button', { name: 'Check now' }).click()
    await app('Codex').getByText('Sends data to a custom host, proxy.example.com').waitFor()
    rmSync(join(home, '.codex/config.toml'))
    stub('codex', 'echo "codex-cli 0.161.0"')
    await main.getByRole('button', { name: 'Check now' }).click()
    await app('Codex').getByText('· tested').waitFor()
    passed('a newer app version is marked and needs no acceptance; a destination set elsewhere still shows')

    phase('Set destination… stages the app on the owner\'s word')
    await app('Claude Code').getByRole('button', { name: 'Set the destination of Claude Code' }).click()
    await sheet.getByRole('radio', { name: /^Anthropic's own servers/ }).and(sheet.locator(':checked')).waitFor()
    assert.equal(await sheet.getByRole('radio', { name: /^Anthropic on your word/ }).count(), 0, 'the inspected provider is offered a second time on the owner\'s word')
    assert.equal(await sheet.getByRole('radio', { name: /^OpenAI on your word/ }).count(), 1)
    await shot('health-destination-1280.png')
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await app('Cursor').getByText('Where it sends data is unknown').waitFor()
    await app('Cursor').getByRole('button', { name: 'Set the destination of Cursor' }).click()
    await sheet.getByText("BMN can't confirm where Cursor sends data", { exact: false }).waitFor()
    await sheet.getByRole('radio', { name: /^OpenCode Go on your word/ }).check()
    await sheet.getByRole('button', { name: 'Set destination' }).click()
    await line.getByText('Cursor would count as sending data to OpenCode Go on your word, so it gets public work only').waitFor()
    await ledger.getByRole('button', { name: 'Discard' }).click()
    await ledger.waitFor({ state: 'detached' })
    passed('Set destination… offers the inspected provider or the owner\'s word and stages the change with its consequence')

    phase('60.6: Update… shows the program and the app\'s own command, starts nothing, and reads the version again')
    // A copy is the one thing here that reaches outside BMN: record it instead of touching the owner's clipboard.
    await application.evaluate(({ clipboard }) => {
      globalThis.__bmnClipboardWrites = []
      clipboard.writeText = (text) => { globalThis.__bmnClipboardWrites.push(text) }
    })
    // The stand-in program writes down how it was called, so a started updater would show.
    const calls = join(root, 'codex-calls.txt')
    stub('codex', `echo "$*" >> '${calls}'\necho "codex-cli 0.161.0"`)
    const program = join(stubs, 'codex')
    await app('Codex').locator('.path', { hasText: program }).waitFor()
    await app('Cursor').getByText('not found', { exact: true }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Update Cursor' }).isDisabled(), true, 'Update… is offered for an app with no program')
    const updateButton = main.getByRole('button', { name: 'Update Codex' })
    await updateButton.click()
    const update = main.getByRole('group', { name: 'Update Codex' })
    await update.waitFor()
    assert.equal(await update.evaluate((node) => node === document.activeElement), true, 'the Update sheet did not take the focus')
    await update.getByText("Codex's own updater does this, not BMN.", { exact: true }).waitFor()
    await update.getByText(`${program} update`, { exact: true }).waitFor()
    await update.getByText('BMN recognises no Codex session right now.', { exact: false }).waitFor()
    await update.getByText("it hands over to this program, and this is the one updated.", { exact: false }).waitFor()
    assert.deepEqual(await update.getByRole('button').allTextContents(), ['Update now', 'Copy command', 'Check now', 'Close'])
    await shot('health-update-1280.png')
    await update.getByRole('button', { name: 'Copy command' }).click()
    await update.getByText('Copied', { exact: true }).waitFor()
    assert.deepEqual(await application.evaluate(() => globalThis.__bmnClipboardWrites), [`${program} update`])
    // The owner runs the updater in a terminal of his own; here the stand-in simply reports a newer version from now on.
    stub('codex', `echo "$*" >> '${calls}'\necho "codex-cli 0.172.0"`)
    await update.getByRole('button', { name: 'Check now' }).click()
    await update.getByText('The program now reports 0.172.0; before it reported 0.161.0.', { exact: true }).waitFor()
    await app('Codex').getByText('· newer than tested').waitFor()
    await shot('health-update-checked-1280.png')
    const started = readFileSync(calls, 'utf8').split('\n').filter((entry) => entry !== '')
    assert.ok(started.length > 0, 'the stand-in program was never asked for its version')
    assert.deepEqual([...new Set(started)], ['--version'], 'BMN started the app with something other than a version question')
    await page.keyboard.press('Escape')
    await update.waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true, 'Escape on the Update sheet closed Preferences')
    assert.equal(await updateButton.evaluate((node) => node === document.activeElement), true, 'the focus did not return to Update…')
    // With the sheet closed the answer stays under the app's row, and Health reads the machine again by itself when the window comes back.
    await app('Codex').locator('.app-note').getByText('The program now reports 0.172.0; before it reported 0.161.0.', { exact: true }).waitFor()
    stub('codex', `echo "$*" >> '${calls}'\necho "codex-cli 0.173.0"`)
    await outsideFocus()
    await app('Codex').locator('.app-note').getByText('The program now reports 0.173.0; before it reported 0.161.0.', { exact: true }).waitFor()
    assert.deepEqual([...new Set(readFileSync(calls, 'utf8').split('\n').filter((entry) => entry !== ''))], ['--version'], 'reading again started the app with something other than a version question')
    await shot('health-update-note-1280.png')
    // Preferences opens where the owner left it; the answer was said on that visit and is not repeated on the next.
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await openPreferences()
    await main.locator('.page-title', { hasText: /^Health$/ }).waitFor()
    assert.equal(await main.locator('.app-note').count(), 0, 'the answer after an update was repeated on a later visit')
    stub('codex', 'echo "codex-cli 0.161.0"')
    await main.getByRole('button', { name: 'Check now' }).click()
    await app('Codex').getByText('· tested').waitFor()
    passed('Update… names the program past BMN\'s own command, copies the exact command, starts no updater without a press on Update now, says what the program reports after a check, and Health reads again when the window comes back')

    phase('60.13: Update now runs the command in a new session on that one press')
    rmSync(calls, { force: true })
    // A stand-in updater that runs until this script lets it end, and a program that reports a newer version only once it
    // has ended. Like an updater that draws an input line of its own, it first writes the very sign a shell gives at its
    // prompt, while it still runs. A question about the version asked while `held` is wanted waits past the updater's end
    // and still answers what it saw first: the read of Health that began before the end and answers after it (63.4).
    const updaterDone = join(root, 'codex-updated')
    const updaterRelease = join(root, 'codex-update-release')
    const readHold = join(root, 'codex-version-hold')
    const readHeld = join(root, 'codex-version-held')
    stub('codex', [`echo "$*" >> '${calls}'`,
      `if [ "$1" = "update" ]; then printf '\\033[?2004h'; i=0; while [ ! -f '${updaterRelease}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; printf '\\033[?2004l'; touch '${updaterDone}'; echo "updated"; exit 0; fi`,
      `if [ -f '${readHold}' ] && [ ! -f '${updaterDone}' ]; then touch '${readHeld}'; i=0; while [ ! -f '${updaterDone}' ] && [ $i -lt 60 ]; do sleep 0.1; i=$((i+1)); done; sleep 1.5; echo "codex-cli 0.161.0"; exit 0; fi`,
      `if [ -f '${updaterDone}' ]; then echo "codex-cli 0.174.0"; else echo "codex-cli 0.161.0"; fi`].join('\n'))
    const updateRuns = () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((entry) => entry === 'update').length : 0
    await updateButton.click()
    await update.getByText('Update now opens a new session and, once its shell shows its prompt, types the command there and presses Enter; you see what the updater does and answer what it asks.', { exact: false }).waitFor()
    await update.getByText("a question that one of your shell's start-up files asks with line editing gives the same sign and would get the command as its answer.", { exact: false }).waitFor()
    await shot('health-update-type-1280.png')
    // Opening the sheet starts nothing: only the press does.
    await sleep(500)
    assert.equal(updateRuns(), 0, 'the updater ran before the owner pressed Update now')
    // Pressed twice in a row, as a hurried hand does: one press counts, so one session opens and one updater runs.
    await update.getByRole('button', { name: 'Update now' }).dblclick()
    // Preferences steps aside for the session the command runs in.
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.session-row', { hasText: 'Update Codex' }).waitFor()
    await page.getByTitle('Typed the command in Update Codex and pressed Enter.').waitFor()
    await until(() => updateRuns() > 0, 'the stand-in program run with its update word after the press, with no key from the owner')
    await sleep(1500)
    assert.equal(updateRuns(), 1, 'the updater ran more than once')
    assert.equal(await page.locator('.session-row', { hasText: 'Update Codex' }).count(), 1, 'a second press opened a second update session')
    await shot('update-session-typed-1280.png')
    // The session is a plain shell: nothing about the update is part of how it starts, so a restart of BMN cannot run it again.
    const updateSession = await page.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces()) {
        const found = (await window.aiTerminal.listSessions(workspace.workspaceId)).find((entry) => entry.name === 'Update Codex')
        if (found) return found
      }
      return null
    })
    assert.deepEqual([updateSession.executable, updateSession.argv], ['/bin/bash', []])
    // Back on Health while the updater still runs: what is read now is the old version. The window keeps the focus and
    // nothing is pressed; when the shell is back at its prompt, Health reads again by itself and says what changed. The
    // updater's own sign, written when it started, was heard too and is not taken for the end of it all.
    await openPreferences()
    await main.locator('.page-title', { hasText: /^Health$/ }).waitFor()
    await app('Codex').locator('.app-note').getByText('The program still reports 0.161.0.', { exact: true }).waitFor()
    assert.equal(existsSync(updaterDone), false, 'the stand-in updater ended before Health was opened again, so this run shows nothing about a reading made while it ran')
    // Check now starts a read that is still asking the program its version when the updater ends, and that answers the
    // old version a moment later. It began before the end, so it is the older reading however late it answers: Health
    // reads once more and shows what the program reports now (63.4).
    writeFileSync(readHold, '')
    await main.getByRole('button', { name: 'Check now' }).click()
    await until(() => existsSync(readHeld), 'a read of Health held open while the updater still runs')
    writeFileSync(updaterRelease, '')
    await until(() => existsSync(updaterDone), 'the stand-in updater to end while that read is still open')
    await app('Codex').locator('.app-note').getByText('The program now reports 0.174.0; before it reported 0.161.0.', { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(updateRuns(), 1, 'the updater ran more than once')
    await shot('health-update-ended-1280.png')
    for (const file of [updaterDone, updaterRelease, readHold, readHeld]) rmSync(file, { force: true })
    stub('codex', `echo "$*" >> '${calls}'\necho "codex-cli 0.161.0"`)
    await main.getByRole('button', { name: 'Check now' }).click()
    await app('Codex').getByText('· tested').waitFor()
    passed('Update now runs the exact command once in a new plain shell session on the owner\'s one press, and Health reads again by itself when the command ends there and says what the program reports, also when a read begun before the end answers after it (60.13, 63.4)')

    phase('60.13: Update now types nothing into a shell that is not at its prompt')
    // A start-up file that asks a question holds the shell before its first prompt. Typed then, the command would be
    // taken for the answer and no updater would run. (BMN's own questions to the shell have no terminal, so they pass it.)
    // The question gives up after 20 seconds and writes down what it was answered, so the shell this step leaves
    // selected is at its prompt for the steps that follow.
    const bashrc = join(home, '.bashrc')
    const plainBashrc = readFileSync(bashrc, 'utf8')
    const answers = join(root, 'startup-answers.txt')
    writeFileSync(bashrc, `${plainBashrc}[ -t 0 ] && { read -t 20 -r -p "startup asks: " answer; echo "answer:$answer" >> '${answers}'; }\n`)
    rmSync(calls, { force: true })
    // Closing the sheet while BMN waits takes the press back: BMN says at once that nothing was typed, and nothing is later.
    await updateButton.click()
    await update.getByRole('button', { name: 'Update now' }).click()
    await update.getByText('Opening Update Codex and waiting for its shell…', { exact: true }).waitFor()
    assert.equal(await update.evaluate((node) => node === document.activeElement), true, 'the Update sheet lost the focus when its button turned off')
    await page.keyboard.press('Escape')
    await update.waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true, 'Escape on the Update sheet closed Preferences')
    await page.getByTitle('Nothing was typed in Update Codex: you closed the sheet first.').waitFor({ timeout: 5_000 })
    // And where the owner stays: BMN waits ten seconds for the shell, then says so on the sheet.
    await updateButton.click()
    await update.getByRole('button', { name: 'Update now' }).click()
    await update.getByText('Opening Update Codex and waiting for its shell…', { exact: true }).waitFor()
    await update.getByText('The shell in Update Codex did not get ready for a command, so BMN typed nothing there. Copy the command and run it yourself.', { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(await dialog.isVisible(), true, 'Preferences stepped aside though nothing runs')
    assert.equal(await update.getByRole('button', { name: 'Update now' }).isDisabled(), true, 'Update now can be pressed again into a shell that is not ready')
    assert.deepEqual(await update.locator('button.primary').allTextContents(), ['Copy command'], 'the copy is not the main action where nothing was typed')
    await sleep(1500)
    assert.equal(updateRuns(), 0, 'the updater ran in a shell that was not at its prompt')
    assert.equal(existsSync(answers), false, 'the command was typed into the question a start-up file asked')
    await shot('health-update-not-ready-1280.png')
    // Both questions time out unanswered, the shells reach their prompts, and still nothing was typed: no updater runs later either.
    await until(() => existsSync(answers) && readFileSync(answers, 'utf8').split('\n').length > 2, 'both start-up questions to give up', 40_000)
    assert.equal(readFileSync(answers, 'utf8'), 'answer:\nanswer:\n', 'something BMN typed was taken for an answer')
    await sleep(1500)
    assert.equal(updateRuns(), 0, 'the updater ran once the shell reached its prompt, after the owner was told nothing was typed')
    writeFileSync(bashrc, plainBashrc)
    await page.keyboard.press('Escape')
    await update.waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true, 'Escape on the Update sheet closed Preferences')
    passed('Update now types nothing into a shell whose start-up file asks a question, says so and leaves the copy as the main action; closing the sheet during the wait takes the press back (60.13)')

    phase('60.13: a start-up question asked with line editing gets the command, and BMN claims no more than it did')
    // The limit the sheet names: such a question gives the sign of a prompt. BMN types the command into it, says that it
    // typed it, no updater runs, and Health, reading again at the shell's own prompt, reports the version as it is.
    writeFileSync(bashrc, `${plainBashrc}[ -t 0 ] && { read -e -p "startup asks: " answer; echo "answer:$answer" >> '${answers}'; }\n`)
    rmSync(answers, { force: true })
    rmSync(calls, { force: true })
    await updateButton.click()
    await update.getByRole('button', { name: 'Update now' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByTitle('Typed the command in Update Codex and pressed Enter.').waitFor()
    await until(() => existsSync(answers), 'the start-up question to take its answer')
    assert.equal(readFileSync(answers, 'utf8'), `answer:${program} update\n`, 'the start-up question was answered with something other than the command shown')
    writeFileSync(bashrc, plainBashrc)
    await sleep(1500)
    assert.equal(updateRuns(), 0, 'the updater ran although a start-up question took the command')
    await openPreferences()
    await main.locator('.page-title', { hasText: /^Health$/ }).waitFor()
    await app('Codex').locator('.app-note').getByText('The program still reports 0.161.0.', { exact: true }).waitFor()
    passed('a start-up question asked with line editing gets the command, as the sheet says it would; BMN says only that it typed it, and Health reports the version unchanged (60.13)')

    phase('60.9: Health lists each app\'s default context limit; the owner\'s test proves the setting, then Change… shows the diff and writes only that line')
    const limitRow = (name) => main.locator('.limit-block', { has: page.locator('.health-row > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    const codexConfig = join(home, '.codex/config.toml')
    writeFileSync(codexConfig, '# mine\nmodel_context_window = 380000\n\n[projects."/synthetic"]\ntrust_level = "trusted"\n')
    await main.getByRole('button', { name: 'Check now' }).click()
    await limitRow('Codex').getByText('380 000 tokens', { exact: true }).waitFor()
    await limitRow('Codex').getByText('Not supported yet · not tested on 0.161.0').waitFor()
    await limitRow('Codex').getByText(/^Shared by /).waitFor()
    await limitRow('Claude Code').getByText('App default', { exact: true }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Change the default context limit of Codex' }).isDisabled(), true, 'Change… is offered before the setting was tested')
    await limitRow('Claude Code').scrollIntoViewIfNeeded()
    await shot('health-context-1280.png')
    // A stand-in Codex: it answers the version and, for a run, leaves the session record a real one writes.
    stub('codex', ['if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi', 'dir=""; prev=""', 'for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done',
      'cat > /dev/null', 'mkdir -p "$HOME/.codex/sessions/2026/10/10"',
      `printf '{"payload":{"cwd":"%s"}}\\n{"payload":{"type":"task_started","model_context_window":116850}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/10/rollout-context-test.jsonl"`].join('\n'))
    await main.getByRole('button', { name: 'Context test for Codex' }).click()
    const limitSheet = limitRow('Codex').locator('.sheet')
    await limitSheet.getByText('Starts Codex once in an empty folder under your home folder', { exact: false }).waitFor()
    await limitSheet.getByRole('button', { name: 'Run test' }).click()
    await notice(/^Codex context test passed: asked for 123000; the session record shows 116850/)
    await limitRow('Codex').getByText('Setting tested on 0.161.0').waitFor()
    assert.equal(readdirSync(home).filter((name) => name.startsWith('.bmn-context-test-')).length, 0, 'the test left its folder behind')
    await main.getByRole('button', { name: 'Change the default context limit of Codex' }).click()
    await limitSheet.getByRole('textbox', { name: 'Codex context limit' }).fill('999 999 999 999')
    assert.equal(await limitSheet.getByRole('button', { name: 'Change', exact: true }).isDisabled(), true, 'a size that is not a number of tokens can be written')
    await limitSheet.getByRole('textbox', { name: 'Codex context limit' }).fill('272 000')
    await limitSheet.locator('.diff').getByText('+model_context_window = 272000').waitFor()
    assert.equal(await limitSheet.getByRole('textbox', { name: 'Codex compact at' }).count(), 0, 'a setting that is not tested is offered')
    assert.match(readFileSync(codexConfig, 'utf8'), /= 380000/, 'the file changed before Change was pressed')
    await limitSheet.scrollIntoViewIfNeeded()
    await shot('health-context-change-1280.png')
    await limitSheet.getByRole('button', { name: 'Change', exact: true }).click()
    await notice(/^Codex's default context limit changed\./)
    assert.equal(readFileSync(codexConfig, 'utf8'), '# mine\nmodel_context_window = 272000\n\n[projects."/synthetic"]\ntrust_level = "trusted"\n')
    await limitRow('Codex').getByText('272 000 tokens', { exact: true }).waitFor()
    for (const name of readdirSync(join(home, '.codex'))) if (name.startsWith('config.toml')) rmSync(join(home, '.codex', name))
    stub('codex', 'echo "codex-cli 0.161.0"')
    await main.getByRole('button', { name: 'Check now' }).click()
    await limitRow('Codex').getByText('App default', { exact: true }).waitFor()
    passed('Health shows each app\'s default context limit; Change… is off until the owner\'s test passed on the installed version, then shows the diff and writes only that line (60.9)')

    phase('63.1: BMN tests a new app version by itself; one switch turns that off, and the check holds an agent to exactly its limit')
    // Sol has a context limit of its own (272 000). A stand-in Codex of one version: any start but the question about
    // its version leaves a line and, after a moment, the session record a real run writes.
    const contextStarts = join(root, 'codex-context-starts')
    const codexOf = (version) => stub('codex', [`if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`, `echo started >> '${contextStarts}'`,
      'dir=""; prev=""', 'for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done', 'cat > /dev/null', 'sleep 2', 'mkdir -p "$HOME/.codex/sessions/2026/10/10"',
      `printf '{"payload":{"cwd":"%s"}}\\n{"payload":{"type":"task_started","model_context_window":116850}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/10/rollout-context-test.jsonl"`].join('\n'))
    const contextRuns = () => (existsSync(contextStarts) ? readFileSync(contextStarts, 'utf8').trim().split('\n').length : 0)
    // The check as a lead runs it before a dispatch: BMN's command with the session's PATH, in a folder of the temporary home.
    const solWork = join(home, 'sol-work')
    mkdirSync(solWork, { recursive: true })
    const solCheck = (...limit) => {
      const run = spawnSync(process.execPath, [join(appDirectory, 'bin/bmn'), 'roster', 'check', '--agent', 'sol', '--role', 'lead', '--workspace', solWork, '--data', 'private', '--cwd', solWork, '--json', '--',
        'codex', 'exec', '--skip-git-repo-check', '-C', solWork, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', ...limit, '-'], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8' })
      const answer = JSON.parse(run.stdout)
      return { verdict: answer.verdict === 'PASS' ? 'PASS' : answer.code, text: run.stdout }
    }
    const SOL_LIMIT = ['-c', 'model_context_window=272000']
    const heldToItsLimit = (when) => {
      const [exact, none, other] = [solCheck(...SOL_LIMIT), solCheck(), solCheck('-c', 'model_context_window=271000')]
      assert.deepEqual([exact.verdict, none.verdict, other.verdict], ['PASS', 'CONTEXT_MISMATCH', 'CONTEXT_MISMATCH'], `${when}: ${exact.text}\n${none.text}\n${other.text}`)
    }
    const autoSwitch = main.getByRole('switch', { name: 'Test context limits after an app update' })
    assert.equal(await autoSwitch.getAttribute('aria-checked'), 'false')
    await limitRow('Codex').locator('.limit-note').getByText('Sol: its own limit of 272 000 is applied to each run.', { exact: true }).waitFor()
    heldToItsLimit('on the version the owner tested')
    // The app is updated. With the switch off BMN starts nothing: Health and the check both say the limit is not applied and why.
    codexOf('0.162.0')
    await main.getByRole('button', { name: 'Check now' }).click()
    await limitRow('Codex').getByText('Not supported yet · not tested on 0.162.0').waitFor()
    await limitRow('Codex').locator('.limit-note').getByText("Sol: its own limit of 272 000 is not applied, so a run gets the app's own size.", { exact: true }).waitFor()
    await sleep(1500)
    assert.equal(contextRuns(), 0, 'BMN started the app although its own testing is switched off')
    const unapplied = solCheck()
    assert.equal(unapplied.verdict, 'PASS', unapplied.text)
    assert.match(unapplied.text, /BMN's own test is switched off in Rules > Health/)
    assert.equal(contextRuns(), 0, 'bmn roster check started the app')
    await limitRow('Codex').scrollIntoViewIfNeeded()
    await shot('health-context-auto-off-1280.png')
    // Switched on, BMN runs the owner's own test for the version it finds, once, and says on Health that it did.
    await autoSwitch.click()
    await limitRow('Codex').getByText('BMN is testing Codex by itself now…', { exact: false }).waitFor()
    await limitRow('Codex').getByText(/^BMN tested 0\.162\.0 by itself .+ · it takes the setting$/).waitFor({ timeout: 30_000 })
    await limitRow('Codex').locator('.limit-note').getByText('Sol: its own limit of 272 000 is applied to each run.', { exact: true }).waitFor()
    assert.equal(await autoSwitch.getAttribute('aria-checked'), 'true')
    assert.equal(contextRuns(), 1)
    assert.equal(readdirSync(home).filter((name) => name.startsWith('.bmn-context-test-')).length, 0, 'the test BMN ran left its folder behind')
    heldToItsLimit('on the new version, after the test BMN ran')
    await limitRow('Codex').scrollIntoViewIfNeeded()
    await shot('health-context-auto-1280.png')
    // A test that passed is not run again, however often Health is read.
    await main.getByRole('button', { name: 'Check now' }).click()
    await limitRow('Codex').getByText(/^BMN tested 0\.162\.0 by itself/).waitFor()
    await sleep(1500)
    assert.equal(contextRuns(), 1, 'a version whose test passed was tested again')
    await autoSwitch.click()
    await notice(/^BMN no longer tests context limits by itself/)
    stub('codex', 'echo "codex-cli 0.161.0"')
    await main.getByRole('button', { name: 'Check now' }).click()
    await limitRow('Codex').getByText('Setting tested on 0.161.0').waitFor()
    passed('with the switch off a new app version starts no test and the limit is said not to be applied; switched on, BMN tests the version once and Health names its test; the check passes Sol only with exactly its limit, before and after (63.1)')

    phase('60.8: a prompt bound for a provider that may not see private work is stopped; Allow here records that workspace')
    // A stand-in agent app: each line typed into it is a prompt, and BMN's prompt hook answers before it "leaves".
    const guardAnswer = join(home, 'stand-in-answer.json')
    const guardSent = join(home, 'stand-in-sent.log')
    stub('kimi', `while IFS= read -r line; do
  printf '{"hook_event_name":"UserPromptSubmit","cwd":"%s","prompt":"%s"}' "$PWD" "$line" | '${process.execPath}' "$BMN_CLI_BIN_DIR/bmn" hook claude > '${guardAnswer}'
  if [ -s '${guardAnswer}' ]; then echo "stand-in: stopped"; else echo "stand-in: sent"; echo sent >> '${guardSent}'; fi
done`)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    const guardCard = page.locator('.session-guard-card')
    const guardMark = page.locator('[data-session-guard]')
    const typeLine = async (text) => {
      await page.locator('.session-terminal.selected .terminal-surface').click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    }
    const stoppedAnswer = () => (existsSync(guardAnswer) && readFileSync(guardAnswer, 'utf8') !== '' ? JSON.parse(readFileSync(guardAnswer, 'utf8')) : null)
    const beforeGuard = { roster: rosterHash(), state: stateHash() }
    await typeLine('cd ~ && ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic kimi')
    await sleep(500)
    await typeLine('PROMPT-SENTINEL first prompt')
    const answer = await until(stoppedAnswer, 'the hook\'s answer that stops the prompt')
    assert.deepEqual(answer, { decision: 'block', reason: "Z.ai can't see private work in ~. Allow it in BMN." })
    await guardCard.waitFor()
    assert.equal(await guardCard.locator('h3').textContent(), 'Allow GLM-5.3 (Z.ai) in this workspace?')
    assert.equal(await guardCard.locator('.guard-facts dd').first().getAttribute('title'), home)
    assert.deepEqual(await guardCard.locator('.actions button').allTextContents(), ['Allow here', 'Keep blocked'])
    assert.doesNotMatch(await guardCard.textContent(), /PROMPT-SENTINEL/, 'the card shows what was typed')
    assert.equal(existsSync(guardSent), false, 'the stopped prompt was sent')
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, beforeGuard, 'something was approved before Allow here')
    await shot('guard-card-1280.png')
    await resize(800, 500)
    await sleep(300)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the card makes the window scroll sideways at 800')
    await shot('guard-card-800.png')
    await resize(1280, 900)
    await sleep(300)
    // Keep blocked closes the card and leaves the session's own mark, which opens it again.
    await guardCard.getByRole('button', { name: 'Keep blocked' }).click()
    await guardCard.waitFor({ state: 'detached' })
    assert.equal(await guardMark.textContent(), 'Told to stop')
    // The mark turns quiet once the app has recorded that the card was kept, a moment after the card goes.
    await guardMark.and(page.locator('[data-cleared="true"]')).waitFor()
    await guardMark.click()
    await guardCard.waitFor()
    assert.deepEqual(await guardCard.locator('.actions button').allTextContents(), ['Allow here'])
    await page.keyboard.press('Escape')
    await guardCard.waitFor({ state: 'detached' })
    // The same prompt sent again is stopped again and brings its card back by itself.
    rmSync(guardAnswer, { force: true })
    await typeLine('PROMPT-SENTINEL second prompt')
    await until(stoppedAnswer, 'the second stop')
    await guardCard.getByRole('button', { name: 'Keep blocked' }).waitFor()
    await guardCard.getByRole('button', { name: 'Allow here' }).click()
    await guardCard.waitFor({ state: 'detached' })
    await page.getByTitle(/^Z\.ai allowed in this workspace · version \d+\. Send the prompt again\.$/).waitFor()
    assert.equal(approved().exceptions.filter((entry) => entry.provider === 'zai' && entry.folder === home).length, 1)
    assert.match(readFileSync(rosterFile, 'utf8'), new RegExp(`\\{provider: zai, folder: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`))
    assert.equal(await guardMark.count(), 0)
    await shot('guard-allowed-1280.png')
    // Sent again, the prompt now leaves, and nothing about it is kept anywhere under the home folder.
    await typeLine('PROMPT-SENTINEL third prompt')
    await until(() => existsSync(guardSent), 'the allowed prompt going through')
    assert.equal(readFileSync(guardAnswer, 'utf8'), '')
    const keepsPrompt = (folder) => readdirSync(folder, { withFileTypes: true }).some((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return keepsPrompt(path)
      return entry.isFile() && readFileSync(path).includes('PROMPT-SENTINEL')
    })
    assert.equal(keepsPrompt(agentsDir), false, 'the prompt was written into the team folder')
    await page.keyboard.press('Control+D')
    passed('A prompt for a public-only provider is stopped by the hook before it leaves; the card names the agent, provider and workspace; Keep blocked keeps the mark; Allow here approves exactly that workspace and the prompt then goes through (60.8)')
    await openPreferences()

    phase('60.8 AC5: the allowed workspace is listed on Changes and in the agent\'s Advanced; removing it is a staged change')
    await go('Team', 'Changes')
    const allowedHere = main.locator('.allowed-workspaces .list-line', { hasText: home })
    await allowedHere.waitFor()
    assert.match(await allowedHere.textContent(), /^Z\.ai/)
    await shot('changes-allowed-1280.png')
    await go('Team')
    await main.locator('.agent-open', { hasText: /^GLM-5\.3$/ }).click()
    await main.locator('details.advanced > summary').click()
    await main.locator('.allowed-workspaces .list-line', { hasText: home }).waitFor()
    await main.locator('.allowed-workspaces').scrollIntoViewIfNeeded()
    await shot('agent-allowed-1280.png')
    const beforeRemoval = { roster: rosterHash(), state: stateHash() }
    await main.getByRole('button', { name: `Stop allowing Z.ai in ${home}` }).click()
    await line.getByText(/could no longer receive private work in/).waitFor()
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, beforeRemoval, 'removing an allowed workspace wrote before it was approved')
    await approve()
    await notice(/^Approved · version \d+/)
    assert.equal(approved().exceptions.some((entry) => entry.provider === 'zai' && entry.folder === home), false)
    passed('An allowed workspace shows on Team › Changes and in the agent\'s Advanced section; Remove stages it with its consequence and takes effect only on Approve (60.8 AC5)')

    phase('60.5 AC7 / 60.4 AC6: an approval that changes the Team phrase lists the rules files first')
    await go('Rules')
    await install()
    await sheet.getByRole('button', { name: 'Install', exact: true }).click()
    await notice(/^Installed to 4 agent apps\./)
    assert.equal(readFileSync(masterFile, 'utf8'), restoredMaster)
    assert.doesNotMatch(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), /Haiku/)
    await go('Team')
    await card('Haiku').getByRole('button', { name: 'Activate' }).click()
    await ledger.getByRole('button', { name: 'Review' }).click()
    await ledger.locator('.ledger-sheet').getByText('Also updates the Team line in 2 rules files').waitFor()
    const beforeTeamLine = { roster: rosterHash(), state: stateHash() }
    await approve()
    const confirmation = ledger.locator('.ledger-sheet[role="group"]')
    await confirmation.getByText('Approve these changes').waitFor()
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, beforeTeamLine, 'the approval ran before its rules files were shown')
    assert.deepEqual(await confirmation.locator('.rules-target > summary').allTextContents().then((lines) => lines.map((line) => line.replace(/\s+/g, ' ').trim())),
      ['Claude Code ~/.claude/CLAUDE.md Full rules', 'Codex ~/.codex/AGENTS.md Full rules'])
    await confirmation.locator('.rules-target > summary').first().click()
    assert.match(await confirmation.locator('.rules-target pre.diff').first().textContent(), /\+The team: Claude Code \(Fable, Sonnet, Haiku, Kimi\)/)
    assert.doesNotMatch(await confirmation.locator('.rules-target pre.diff').first().textContent(), /^(---|\+\+\+|@@) /m, 'the sheet names the file; the diff format\'s own headers stay out')
    await shot('team-rules-files-1280.png')
    await confirmation.getByRole('button', { name: 'Approve', exact: true }).click()
    await notice(/^Approved · version \d+ · Rules updated in 2 appsUndo/)
    assert.match(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), /Claude Code \(Fable, Sonnet, Haiku, Kimi\)/)
    assert.match(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'), /Claude Code \(Fable, Sonnet, Haiku, Kimi\)/)
    await shot('team-rules-updated-1280.png')
    // An edit made outside BMN after the update: Undo must show that it would go, before anything is written.
    appendFileSync(join(home, '.claude/CLAUDE.md'), 'A line added outside BMN after the update.\n')
    const updated = { claude: readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), codex: readFileSync(join(home, '.codex/AGENTS.md'), 'utf8') }
    await toast.getByRole('button', { name: 'Undo' }).click()
    const undoSheet = ledger.locator('.ledger-sheet[role="group"]')
    await undoSheet.getByText('Undo the rules update', { exact: true }).waitFor()
    assert.deepEqual({ claude: readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), codex: readFileSync(join(home, '.codex/AGENTS.md'), 'utf8') }, updated, 'Undo wrote before its files were shown')
    assert.deepEqual(await undoSheet.locator('.rules-target > summary').allTextContents().then((lines) => lines.map((line) => line.replace(/\s+/g, ' ').trim().replace(/ · .*$/, ''))),
      ['Claude Code ~/.claude/CLAUDE.md Put back', 'Codex ~/.codex/AGENTS.md Put back'])
    await undoSheet.locator('.rules-target > summary').first().click()
    assert.match(await undoSheet.locator('.rules-target pre.diff').first().textContent(), /^-A line added outside BMN after the update\.$/m)
    await undoSheet.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
    await shot('team-rules-undo-1280.png')
    await undoSheet.getByRole('button', { name: 'Undo update', exact: true }).click()
    await notice(/^Put back the rules in Claude Code and Codex/)
    assert.doesNotMatch(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), /Haiku|added outside BMN/)
    passed('Approve first lists each rules file with its path and diff, commits from there, updates exactly those files; Undo shows what it puts back and waits for the owner')

    phase('60.11: Skills lists each skill with its apps and state; the owner\'s test finds where Codex reads skills; Install… links them after showing the list, and Undo puts the folder back')
    const skillsDir = join(home, '.claude/skills')
    const codexSkills = join(home, '.agents/skills')
    const writeSkill = (folder, name, text) => {
      mkdirSync(join(folder, name), { recursive: true })
      writeFileSync(join(folder, name, 'SKILL.md'), text)
    }
    writeSkill(skillsDir, 'evidence-first', '---\nname: evidence-first\ndescription: Check a claim against the files before saying it.\n---\n\nSynthetic skill text.\n')
    writeSkill(skillsDir, 'small-steps', '---\nname: small-steps\ndescription: Change one thing, then check it.\n---\n\nSynthetic skill text.\n')
    // Codex already holds a folder of its own under one skill's name.
    writeSkill(codexSkills, 'small-steps', '---\nname: small-steps\n---\n\nKept by hand.\n')
    writeFileSync(join(codexSkills, 'small-steps/own.md'), 'own\n')
    // A stand-in Codex that names the skills in ~/.agents/skills of whatever home folder it is started in.
    stub('codex', ['if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi', '[ "$1 $2" = "debug prompt-input" ] || exit 4',
      'for d in "$HOME"/.agents/skills/*/; do [ -f "${d}SKILL.md" ] && echo "skill $(basename "$d")"; done', 'exit 0'].join('\n'))
    const skillRow = (name) => main.locator(`.skill-row[data-skill="${name}"]`)
    const skillsApp = (name) => main.locator('.skills-block', { has: page.locator('.health-row[data-skills] > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    await go('Rules', 'Skills')
    await main.getByRole('button', { name: 'Check now' }).click()
    await skillRow('evidence-first').getByText('Check a claim against the files before saying it.', { exact: true }).waitFor()
    await skillRow('evidence-first').getByRole('button', { name: 'evidence-first in Codex: Not yet' }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Install…' }).count(), 0, 'Install… is offered before any app was tested')
    await go('Rules', 'Health')
    await skillsApp('Codex').getByText('Not tested on 0.161.0').waitFor()
    assert.equal(await main.getByRole('button', { name: 'Skills test for Cursor' }).isDisabled(), true, 'a test is offered for an app BMN cannot ask')
    await main.getByRole('button', { name: 'Skills test for Codex' }).click()
    const skillsSheet = skillsApp('Codex').locator('.sheet')
    await skillsSheet.getByText('BMN sends no prompt and no sign-in is there', { exact: false }).waitFor()
    await skillsSheet.getByRole('button', { name: 'Run test' }).click()
    await notice(/^Codex skills test passed: Codex reads skills from ~\/\.agents\/skills; Codex lists a test skill placed in /)
    await skillsApp('Codex').locator('.path', { hasText: '~/.agents/skills' }).waitFor()
    await skillsApp('Codex').getByText('Differs').waitFor()
    await skillsApp('Codex').getByText(/^Listing test passed /).waitFor()
    assert.deepEqual(readdirSync(codexSkills), ['small-steps'], 'the test left a test skill behind')
    assert.equal(readdirSync(home).filter((name) => name.startsWith('.bmn-skills-test-')).length, 0, 'the test left its folder behind')
    // The loading test is another test: it sends one prompt, and passes only when Codex's own record shows the skill's
    // words given to the model before any tool ran, in a run that came to its end. The stand-in answers the way such a
    // run would be recorded.
    await skillsApp('Codex').getByText(/ · loading never tested$/).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Skill loading test for Cursor' }).count(), 0, 'a loading test is offered where no prompt may go')
    stub('codex', ['if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi', '[ "$1" = "exec" ] || exit 4', 'cat > /dev/null',
      'token=$(grep -ho "BMN-[0-9a-f]*" "$HOME"/.agents/skills/bmn-loading-test-*/SKILL.md | head -n 1)', 'mkdir -p "$HOME/.codex/sessions/2026/10/11"',
      `printf '%s\\n' "{\\"type\\":\\"session_meta\\",\\"payload\\":{\\"id\\":\\"s\\",\\"cwd\\":\\"$4\\"}}" "{\\"type\\":\\"response_item\\",\\"payload\\":{\\"type\\":\\"message\\",\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"input_text\\",\\"text\\":\\"$token\\"}]}}" "{\\"type\\":\\"response_item\\",\\"payload\\":{\\"type\\":\\"message\\",\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"output_text\\",\\"text\\":\\"$token\\"}]}}" "{\\"type\\":\\"event_msg\\",\\"payload\\":{\\"type\\":\\"task_complete\\"}}" > "$HOME/.codex/sessions/2026/10/11/rollout-2026-10-11T00-00-00-s.jsonl"`,
      'exit 0'].join('\n'))
    await main.getByRole('button', { name: 'Skill loading test for Codex' }).click()
    const loadingSheet = skillsApp('Codex').locator('.sheet')
    await loadingSheet.getByText('sends one prompt that calls the skill by name', { exact: false }).waitFor()
    await loadingSheet.scrollIntoViewIfNeeded()
    await shot('health-skills-loading-sheet-1280.png')
    await loadingSheet.getByRole('button', { name: 'Run test' }).click()
    await notice(/^Codex skill loading test passed: Codex gave the model the test skill's words itself, before any tool ran$/)
    await skillsApp('Codex').getByText(/^Loading test passed /).waitFor()
    assert.deepEqual(readdirSync(codexSkills), ['small-steps'], 'the loading test left a test skill behind')
    rmSync(join(home, '.codex/sessions'), { recursive: true, force: true })
    stub('codex', ['if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi', '[ "$1 $2" = "debug prompt-input" ] || exit 4',
      'for d in "$HOME"/.agents/skills/*/; do [ -f "${d}SKILL.md" ] && echo "skill $(basename "$d")"; done', 'exit 0'].join('\n'))
    await skillsApp('Codex').scrollIntoViewIfNeeded()
    await shot('health-skills-1280.png')

    await go('Rules', 'Skills')
    await skillRow('evidence-first').getByRole('button', { name: 'evidence-first in Codex: Missing' }).waitFor()
    await skillRow('small-steps').getByRole('button', { name: 'small-steps in Codex: Differs' }).waitFor()
    // Kept away from Claude Code: a staged change, said in the footer with the app it reaches, in effect only once approved.
    const beforeScope = { roster: rosterHash(), state: stateHash() }
    await skillRow('small-steps').getByRole('button', { name: /^small-steps in Claude Code: / }).click()
    await ledger.getByText('1 unapproved change', { exact: true }).waitFor()
    await line.getByText('Skill small-steps would no longer reach Claude Code').waitFor()
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, beforeScope, 'a scope change was written before it was approved')
    await skillRow('small-steps').getByText('Only', { exact: true }).waitFor()
    await shot('skills-staged-1280.png')
    await approve()
    await notice(/^Approved · version \d+/)
    assert.deepEqual(approved().skills, [{ id: 'small-steps', only: ['codex', 'opencode', 'cursor'] }])
    await main.getByText('2 to install', { exact: true }).waitFor()
    await main.getByRole('button', { name: 'Install…' }).click()
    const skillsInstall = main.getByRole('group', { name: 'Change 2 skill entries' })
    await skillsInstall.waitFor()
    const entries = await skillsInstall.locator('.target > summary').allTextContents()
    assert.match(entries[0], /^Codex.*evidence-first.*adds the skill/)
    assert.match(entries[1], /^Codex.*small-steps.*takes over an entry BMN did not write \(unmanaged\)/)
    await skillsInstall.locator('.target > summary').nth(1).click()
    await skillsInstall.getByText('the folder there differs from the skill in SKILL.md; holds own.md, which the skill does not', { exact: true }).waitFor()
    assert.equal(existsSync(join(codexSkills, 'evidence-first')), false, 'an entry was written before Install was pressed')
    await skillsInstall.scrollIntoViewIfNeeded()
    await shot('skills-install-1280.png')
    await skillsInstall.getByRole('button', { name: 'Install', exact: true }).click()
    await notice(/^Changed 2 skill entries\. Sessions started before this keep the skills they had\./)
    assert.equal(readlinkSync(join(codexSkills, 'evidence-first')), join(skillsDir, 'evidence-first'))
    assert.equal(readlinkSync(join(codexSkills, 'small-steps')), join(skillsDir, 'small-steps'))
    await skillRow('small-steps').getByRole('button', { name: 'small-steps in Codex: Linked' }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Install…' }).count(), 0)
    await main.locator('details.advanced > summary', { hasText: 'Earlier installs' }).click()
    await main.getByRole('button', { name: /^Undo the skills install of / }).click()
    const skillsUndo = main.getByRole('group', { name: 'Undo this install' })
    await skillsUndo.locator('.target > summary').first().waitFor()
    assert.equal(readlinkSync(join(codexSkills, 'small-steps')), join(skillsDir, 'small-steps'), 'Undo wrote before its entries were shown')
    await skillsUndo.getByRole('button', { name: 'Undo install', exact: true }).click()
    await notice(/^Put back the skills in Codex/)
    assert.equal(readFileSync(join(codexSkills, 'small-steps/own.md'), 'utf8'), 'own\n')
    assert.equal(existsSync(join(codexSkills, 'evidence-first')), false)
    stub('codex', 'echo "codex-cli 0.161.0"')
    passed('Skills lists each skill with its apps and state; the owner\'s test finds where Codex reads skills; a scope change is approved first; Install… shows each entry, replaces a folder BMN did not write only then, and Undo puts it back (60.11)')

    phase('60.12: Tools lists what the apps hold; the owner\'s test finds where Codex keeps its tools; a tool is added, approved, installed as one entry and undone, and a value an entry held is never shown')
    const toolsConfig = join(home, '.codex/config.toml')
    const TOOL_SECRET = 'sk-SYNTHETIC-SECRET-9f8e7d6c5b4a'
    const ownTools = `model = "gpt-6.1-sol"\n\n[mcp_servers.search]\ncommand = "search-tool"\nenv = { SEARCH_KEY = "${TOOL_SECRET}" }\n`
    writeFileSync(toolsConfig, ownTools, { mode: 0o600 })
    // A stand-in Codex: its list repeats its settings file. BMN has no test of a Codex run, so none is asked of it.
    stub('codex', ['if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi', 'alone=""; own=""',
      'while [ "$1" = "-c" ]; do case "$2" in "mcp_servers={}") alone=1;; mcp_servers.*.command=*) own="${2#mcp_servers.}"; own="${own%%.*}";; esac; shift 2; done',
      '[ "$1 $2" = "mcp list" ] || exit 4', '[ -n "$alone" ] || cat "$HOME/.codex/config.toml" 2>/dev/null', '[ -z "$own" ] || echo "$own"', 'exit 0'].join('\n'))
    const toolRow = (id) => main.locator(`.tool-row[data-tool="${id}"]`)
    const toolsApp = (name) => main.locator('.skills-block', { has: page.locator('.health-row[data-tools] > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    await go('Rules', 'Tools')
    await main.getByRole('button', { name: 'Check now' }).click()
    await main.getByText('No tools on your list yet.', { exact: true }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Install…' }).count(), 0, 'Install… is offered while no tool is on the list')
    await go('Rules', 'Health')
    await toolsApp('Codex').getByText('Not tested on 0.161.0').waitFor()
    await toolsApp('Codex').locator('.path', { hasText: '~/.codex/config.toml' }).waitFor()
    await main.getByRole('button', { name: 'Tools test for Codex' }).click()
    const toolsSheet = toolsApp('Codex').locator('.sheet')
    await toolsSheet.getByText('in an empty home folder with no sign-in, so no prompt can be answered there', { exact: false }).waitFor()
    await toolsSheet.getByRole('button', { name: 'Run test' }).click()
    await notice(/^Codex tools test passed: Codex reads its tools from ~\/\.codex\/config\.toml; its own list names the environment variable a tool is given \(the tool was not started\); BMN has no test yet that shows which tools a run of Codex starts with, so a run cannot be kept to its own tools$/)
    await toolsApp('Codex').getByText(/^Tested .* · passes variables · no run seen kept to its tools$/).waitFor()
    assert.equal(readFileSync(toolsConfig, 'utf8'), ownTools, 'the test changed the settings file')
    assert.equal(readdirSync(home).filter((name) => name.startsWith('.bmn-tools-test-')).length, 0, 'the test left its folder behind')
    await toolsApp('Codex').scrollIntoViewIfNeeded()
    await shot('health-tools-1280.png')

    await go('Rules', 'Tools')
    await main.locator('[data-unlisted="search"]').getByText('Codex', { exact: false }).waitFor()
    // What Codex holds joins the list as a tool kept to Codex, without the value its entry held.
    await main.getByRole('button', { name: 'From your apps…' }).click()
    const proposals = main.getByRole('group', { name: 'Add 1 tool from your apps' })
    await proposals.getByText('Codex · will be added without the value it holds', { exact: true }).waitFor()
    await proposals.getByText('holds a value inline (Codex env.SEARCH_KEY)', { exact: false }).waitFor()
    await shot('tools-from-apps-1280.png')
    const beforeTools = { roster: rosterHash(), state: stateHash() }
    await proposals.getByRole('button', { name: 'Add to your list' }).click()
    await ledger.getByText('1 unapproved change', { exact: true }).waitFor()
    await line.getByText('Tool Search would reach Codex').waitFor()
    // Add tool: plain rows; what a row cannot take is said under it, and nothing is staged until it reads.
    await main.getByRole('button', { name: 'Add tool', exact: true }).click()
    const toolEditor = main.getByRole('group', { name: 'Add a tool' })
    await toolEditor.getByLabel('Tool name').fill('Docs')
    assert.equal(await toolEditor.getByLabel('Tool id').inputValue(), 'docs')
    await toolEditor.getByRole('radio', { name: 'An address' }).click()
    await toolEditor.getByRole('button', { name: 'Add tool', exact: true }).click()
    await toolEditor.getByText('An address that starts with https://', { exact: true }).waitFor()
    await toolEditor.getByLabel('Address').fill('https://docs.example.test/mcp')
    await toolEditor.getByRole('switch', { name: 'The tool is public' }).click()
    assert.equal(await toolEditor.locator('select').count(), 0, 'the editor uses a list of the browser\'s own')
    await toolEditor.scrollIntoViewIfNeeded()
    await shot('tools-add-1280.png')
    await toolEditor.getByRole('button', { name: 'Add tool', exact: true }).click()
    await toolRow('docs').getByText('docs.example.test', { exact: true }).waitFor()
    await line.getByText(/^Tool Docs would reach /).waitFor()
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, beforeTools, 'a tool was written before it was approved')
    await main.locator('.page-head').scrollIntoViewIfNeeded()
    await shot('tools-staged-1280.png')
    // The first tool on a list changes what the check asks of every run: Review says so before it is approved.
    await ledger.getByRole('button', { name: 'Review', exact: true }).click()
    await ledger.getByText('With a tool on the list, the check keeps every Claude Code run to exactly its own tools, once its tools test passed there; it does not judge the tools of a Codex run', { exact: false }).waitFor()
    await shot('tools-first-consequence-1280.png')
    await ledger.getByRole('button', { name: 'Review', exact: true }).click()
    await approve()
    await notice(/^Approved · version \d+/)
    assert.deepEqual(approved().tools, [{ id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', public: true }, { id: 'search', name: 'Search', command: 'search-tool', apps: ['codex'] }])
    await toolRow('docs').getByRole('button', { name: 'Docs in Codex: Missing' }).waitFor()
    await toolRow('search').getByRole('button', { name: 'Search in Codex: Differs' }).waitFor()
    await main.getByText('1 to install', { exact: true }).waitFor()
    await toolRow('search').getByText('In Codex: it holds a value inline (env.SEARCH_KEY): move it into an environment variable, then name the variable in the tool', { exact: true }).waitFor()
    await main.getByRole('button', { name: 'Install…' }).click()
    const toolsInstall = main.getByRole('group', { name: 'Change 1 tool entry' })
    await toolsInstall.waitFor()
    assert.match((await toolsInstall.locator('.target > summary').allTextContents())[0], /^Codex.*~\/\.codex\/config\.toml.*docs · adds the tool/)
    await toolsInstall.locator('.target > summary').first().click()
    assert.equal(await toolsInstall.locator('.target pre.diff').first().textContent(), '+[mcp_servers.docs]\n+url = "https://docs.example.test/mcp"')
    await toolsInstall.getByText('Codex, search: it holds a value inline (env.SEARCH_KEY)', { exact: false }).waitFor()
    assert.equal(readFileSync(toolsConfig, 'utf8'), ownTools, 'an entry was written before Install was pressed')
    await toolsInstall.scrollIntoViewIfNeeded()
    await shot('tools-install-1280.png')
    await toolsInstall.getByRole('button', { name: 'Install', exact: true }).click()
    await notice(/^Changed 1 tool entry\. Sessions started before this keep the tools they had\. 1 could not be changed\./)
    // Only the one entry was added: every byte the file held is still there.
    assert.equal(readFileSync(toolsConfig, 'utf8'), `${ownTools}\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n`)
    await toolRow('docs').getByRole('button', { name: 'Docs in Codex: Set up' }).waitFor()
    assert.equal(await main.getByRole('button', { name: 'Install…' }).count(), 0)
    await main.locator('.page-head').scrollIntoViewIfNeeded()
    await shot('tools-1280.png')
    await main.locator('details.advanced > summary', { hasText: 'Earlier installs' }).click()
    await main.getByRole('button', { name: /^Undo the tools install of / }).click()
    const toolsUndo = main.getByRole('group', { name: 'Undo this install' })
    await toolsUndo.locator('.target > summary').first().waitFor()
    assert.match((await toolsUndo.locator('.target > summary').allTextContents())[0], /^Codex.*docs · Removed again/)
    assert.match(readFileSync(toolsConfig, 'utf8'), /\[mcp_servers\.docs\]/, 'Undo wrote before its entries were shown')
    await toolsUndo.getByRole('button', { name: 'Undo install', exact: true }).click()
    await notice(/^Put back the tools in Codex/)
    assert.equal(readFileSync(toolsConfig, 'utf8'), ownTools)
    await toolRow('docs').getByRole('button', { name: 'Docs in Codex: Missing' }).waitFor()
    // The value Codex's own entry held was on no page and in no file BMN keeps.
    assert.equal((await dialog.innerHTML()).includes(TOOL_SECRET), false, 'a value an entry held reached the page')
    const kept = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? kept(join(folder, entry.name)) : [join(folder, entry.name)]))
    assert.deepEqual(kept(agentsDir).filter((path) => readFileSync(path, 'utf8').includes(TOOL_SECRET)), [], 'a value an entry held is in a file BMN keeps')
    stub('codex', 'echo "codex-cli 0.161.0"')
    passed('Tools shows what the apps hold; the owner\'s test finds where Codex keeps its tools; an entry of the app\'s own and a new tool are approved first; Install… shows the one entry it adds and the one it leaves, keeps the file\'s other bytes, and Undo takes the entry out again; a value is never shown or kept (60.12)')

    phase('60.10: Models researches the team\'s models through a stand-in app, keeps what a stopped run found, stages verified prices and fills New agent')
    assert.equal(await ledger.count(), 0, 'a change is still staged before the Models phase')
    const today = new Date().toISOString().slice(0, 10)
    const pricePage = 'https://prices.anthropic.test/pricing'
    const windowPage = 'https://prices.anthropic.test/models'
    const openaiPage = 'https://prices.openai.test/api/pricing'
    mkdirSync(join(root, 'pages/prices.anthropic.test'), { recursive: true })
    mkdirSync(join(root, 'pages/prices.openai.test/api'), { recursive: true })
    // Each amount stands with its own word: a bare row of a table is never counted, whatever its order.
    writeFileSync(join(root, 'pages/prices.anthropic.test/pricing'), ['<h1>Pricing</h1><p>Prices are in US dollars per million tokens.</p><table>',
      '<tr><td>claude-opus-5-5</td><td>Input $15.00</td><td>Cached input $1.50</td><td>Output $75.00</td></tr>',
      '<tr><td>claude-opus-5-6</td><td>Input $15</td><td>Output $75</td></tr>',
      '<tr><td>claude-sonnet-5-9</td><td>Input $3</td><td>Output $15</td></tr></table>'].join('\n'))
    writeFileSync(join(root, 'pages/prices.anthropic.test/models'), '<h1>Models</h1><p>claude-opus-5-5: context window 1,000,000 tokens.</p><p>claude-opus-5-6: context window 1,000,000 tokens.</p>')
    writeFileSync(join(root, 'pages/prices.openai.test/api/pricing'), '<h1>API pricing</h1><p>Per 1M tokens.</p><p>gpt-6.1-sol input $2.00 output $8.00</p><p>gpt-6.1-nova input $0.50 output $4.00</p><p>gpt-6-astra input $5.00 output $25.00</p>')
    const priced = (input, output, source, cached) => ({ input, output, ...(cached === undefined ? {} : { cached_input: cached }), source, as_of: today })
    const facts = {
      'claude-opus-5-5': { price: priced(15, 75, pricePage, 1.5), context_window: { tokens: 1_000_000, source: windowPage, as_of: today } },
      'gpt-6.1-sol': { price: priced(2, 8, openaiPage) },
      // The page shows another price beside this model: BMN keeps the answer apart and never offers it.
      'gpt-6-astra': { price: priced(9, 90, openaiPage) },
      'claude-sonnet-5-9': { price: priced(3, 15, pricePage) }
    }
    const listed = {
      'claude-opus-5-5': [{ id: 'claude-opus-5-6', price: priced(15, 75, pricePage), context_window: { tokens: 1_000_000, source: windowPage, as_of: today } }],
      'gpt-6.1-sol': [{ id: 'gpt-6.1-nova', price: priced(0.5, 4, openaiPage) }]
    }
    const planFile = join(home, 'research-plan.json')
    const researchCalls = join(root, 'research-calls.log')
    const plan = (entries) => writeFileSync(planFile, JSON.stringify(entries))
    // A stand-in Claude Code that answers a research prompt from the plan and anything else as the loading test's stand-in does.
    writeFileSync(join(stubs, 'claude'), `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === '--version') { console.log('2.1.295 (Claude Code)'); process.exit(0) }
const prompt = fs.readFileSync(0, 'utf8')
if (!prompt.startsWith('Look up published facts')) { console.log('I cannot tell'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(researchCalls)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), cwd: process.cwd(), files: fs.readdirSync('.'), prompt }) + '\\n')
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, 'utf8'))
const asked = prompt.slice(prompt.indexOf('Models:\\n') + 8, prompt.indexOf('\\n\\nSources')).split('\\n').map((line) => line.slice(2))
const entry = (id, found, isListed) => ({ id, provider: 'Synthetic', listed: isListed, price: found.price ?? 'unavailable', context_window: found.context_window ?? 'unavailable' })
const models = asked.map((id) => entry(id, plan.facts[id] ?? {}, false))
if (prompt.includes('Then list up to')) for (const id of asked) for (const extra of plan.listed[id] ?? []) models.push(entry(extra.id, extra, true))
setTimeout(() => console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ version: 1, models }) })), asked.includes(plan.slow) ? plan.delayMs : 0)
`)
    const researchRuns = () => (existsSync(researchCalls) ? readFileSync(researchCalls, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry)) : [])
    const teamBefore = approved()
    const teamModels = new Set(teamBefore.agents.map((agent) => `${agent.provider}|${agent.model}`)).size
    const head = main.locator('.page-head')
    const modelLine = (id) => main.locator(`.model-line[data-model="${id}"]`)

    await go('Team', 'Models')
    await head.getByText('Not researched yet').waitFor()
    assert.equal(await main.getByText('Not researched yet').count(), 1, 'before any research the page says so more than once')
    // Who may research: active agents on Claude Code whose provider may see private work (Codex only once its research limits were tested); the others are named, not offered.
    const who = main.getByRole('radiogroup', { name: 'Researcher' })
    await who.waitFor()
    const able = await who.getByRole('radio').allTextContents()
    // The first one offered is chosen until the owner picks: pick another where there is one, so the choice is seen kept.
    const mayResearch = teamBefore.agents.filter((agent) => agent.harness === 'claude' && able.includes(agent.name))
    const researcher = mayResearch.find((agent) => agent.name !== able[0]) ?? mayResearch[0]
    assert.ok(researcher, `no Claude Code agent is offered as the researcher: ${able.join(', ')}`)
    for (const name of able) {
      const agent = teamBefore.agents.find((entry) => entry.name === name)
      assert.equal(teamBefore.providers.find((provider) => provider.id === agent.provider).private_work, 'allowed', `${name} is offered although its provider gets public work only`)
      assert.ok(agent.harness === 'claude' && agent.enabled && agent.status === 'active', `${name} is offered although it is not an active Claude Code agent`)
    }
    await main.getByText(/Kimi cannot research: its provider gets public work only\./).waitFor()
    // Two agents may share a name, so each button carries its class's piece and is named by it: "Knight Opus", "Queen Opus".
    assert.equal(await who.locator('[role="radio"] svg.piece[role="img"]').count(), able.length, 'a researcher is offered without its class piece')
    const classWord = (agent) => `${agent.class[0].toUpperCase()}${agent.class.slice(1)}`
    const radioOf = (agent) => who.getByRole('radio', { name: new RegExp(`^${classWord(agent)} ?${agent.name}$`) })
    assert.equal(await radioOf(researcher).locator('svg.piece').getAttribute('aria-label'), classWord(researcher))
    await radioOf(researcher).click()
    await radioOf(researcher).and(main.locator('[aria-checked="true"]')).waitFor()
    if (researcher.name !== able[0]) assert.equal(JSON.parse(readFileSync(join(stateDir, 'research/settings.json'), 'utf8')).researcher, researcher.id)
    await main.getByText('Gets only your model names and the source list, never your files. Runs in an empty folder with web tools only.', { exact: false }).waitFor()
    assert.deepEqual(await main.locator('.sources li').allTextContents(), ['Provider pages', 'Other sites'])
    await shot('models-empty-1280.png')

    // A run that the owner stops keeps what the finished providers answered and says it did not finish.
    plan({ facts, listed: {}, slow: 'gpt-6.1-sol', delayMs: 120_000 })
    const hashesBefore = { roster: rosterHash(), state: stateHash() }
    await head.getByRole('button', { name: 'Research now' }).click()
    await head.getByText(new RegExp(`^${researcher.name} is researching · [1-9]\\d* of ${teamModels} models$`)).waitFor()
    assert.equal(await who.getByRole('radio').first().isDisabled(), true, 'the researcher can be changed while it researches')
    await shot('models-running-1280.png')
    await head.getByRole('button', { name: 'Stop' }).click()
    await head.getByText(/ · not finished$/).waitFor()
    // How it ended is said once, in a plain line: he stopped it himself, so nothing reads as a failure.
    await main.getByText('The last research did not finish: Stopped before it finished.', { exact: true }).waitFor()
    assert.equal(await main.getByText(/Stopped before it finished/).count(), 1, 'how the run ended is said twice')
    assert.equal(await dialog.locator('.preferences-page:not([hidden]) [role="alert"]').count(), 0, 'a run the owner stopped reads as a failure')
    await modelLine('claude-opus-5-5').getByText('$15.00 / $75.00').waitFor()
    await modelLine('gpt-6.1-sol').getByText('Not found yet').waitFor()
    await shot('models-stopped-1280.png')

    // The whole research: every provider answers, and each lists what else it publishes.
    plan({ facts, listed, slow: null, delayMs: 0 })
    await head.getByRole('button', { name: 'Research now' }).click()
    await head.getByText(new RegExp(`by ${researcher.name} · ${teamModels + 2} models$`)).waitFor()
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, hashesBefore, 'a research changed the team')
    // What the stand-in app was started with: an empty folder of its own, the home folder and the program path only, web tools only, no agent names and no prices.
    const ran = researchRuns()
    assert.ok(ran.length >= 2 && ran.every((call) => call.files.length === 0 && call.cwd.includes('/state/research/')), 'a research run did not start in an empty folder of its own')
    assert.ok(ran.every((call) => call.env.every((key) => ['HOME', 'PATH', '__CF_USER_TEXT_ENCODING'].includes(key))), `a research run saw more of the environment: ${ran[0].env.join(', ')}`)
    assert.ok(ran.every((call) => call.argv.includes('--safe-mode') && call.argv[call.argv.indexOf('--tools') + 1] === 'WebSearch,WebFetch'), 'a research run was not held to the web tools')
    const prompts = ran.map((call) => call.prompt).join('\n')
    for (const agent of teamBefore.agents) assert.ok(!new RegExp(`\\b${agent.name}\\b`).test(prompts) || agent.model.toLowerCase().includes(agent.name.toLowerCase()), `the prompt names the agent ${agent.name}`)
    assert.doesNotMatch(prompts, /PROSE-SENTINEL|PRICE-SENTINEL|1\.25|Cheap helper/)
    // Listed models the team does not have, first seen now.
    // Both researches ran today, so the head says it once.
    await main.getByRole('heading', { name: 'New in this research', exact: true }).waitFor()
    await modelLine('claude-opus-5-6').getByText('$15.00 / $75.00').waitFor()
    await modelLine('claude-opus-5-6').getByText('1 000 000 tokens').waitFor()
    await modelLine('gpt-6.1-nova').getByText('$0.50 / $4.00').waitFor()
    // The provider is named as the team names it, not as the researcher worded it.
    assert.match(await modelLine('claude-opus-5-6').locator('.model-text > div').first().textContent(), /^claude-opus-5-6 Anthropic$/)
    assert.equal(await modelLine('claude-opus-5-6').locator('.source').first().getAttribute('title'), pricePage)
    assert.equal(await modelLine('claude-opus-5-6').locator('.source').first().textContent(), 'prices.anthropic.test')
    // A price the cited page does not show is kept apart and never counts as a difference.
    const astra = modelLine('gpt-6-astra')
    await astra.getByText('unverified', { exact: true }).waitFor()
    assert.equal(await astra.getByText('unverified', { exact: true }).getAttribute('title'), 'BMN could not confirm this on the cited page: the page does not show this price beside the model.')
    assert.equal(await astra.getByText(/your team has/).count(), 0)
    await modelLine('kimi-k3').getByText('No price found').waitFor()
    // Apply prices offers each verified price that differs, with the page it was read on, and stages nothing but prices.
    const expected = teamBefore.agents.filter((agent) => {
      const found = agent.provider === 'anthropic' ? facts[agent.model] : agent.provider === 'openai' && agent.model !== 'gpt-6-astra' ? facts[agent.model] : undefined
      return found?.price && (agent.price?.input !== found.price.input || agent.price?.output !== found.price.output)
    })
    assert.ok(expected.some((agent) => agent.id === 'sol'), 'the synthetic team no longer has Sol on gpt-6.1-sol')
    await main.getByText(expected.length === 1 ? "One price differs from your team's." : `${expected.length} prices differ from your team's.`).waitFor()
    await modelLine('gpt-6.1-sol').getByText('· your team has $1.25 / $10.00').waitFor()
    await shot('models-found-1280.png')
    await main.getByRole('button', { name: 'Apply prices…' }).click()
    const stageTitle = expected.length === 1 ? 'Apply one price' : `Apply ${expected.length} prices`
    const applySheet = main.getByRole('group', { name: stageTitle })
    await applySheet.waitFor()
    assert.deepEqual(await applySheet.locator('.price-change').evaluateAll((rows) => rows.map((row) => row.dataset.agent)), expected.map((agent) => agent.id))
    assert.match(await applySheet.locator('.price-change[data-agent="sol"]').textContent(), /Sol gpt-6\.1-sol\$1\.25 \/ \$10\.00 → \$2\.00 \/ \$8\.00https:\/\/prices\.openai\.test\/api\/pricing/)
    assert.equal(await ledger.count(), 0, 'opening the review staged something')
    await shot('models-apply-1280.png')
    await applySheet.getByRole('button', { name: 'Cancel', exact: true }).click()
    await applySheet.waitFor({ state: 'detached' })
    assert.equal(await ledger.count(), 0)
    await main.getByRole('button', { name: 'Apply prices…' }).click()
    await applySheet.getByRole('button', { name: stageTitle, exact: true }).click()
    await notice(expected.length === 1 ? /^One price changed\. Approve below to keep it\.$/ : new RegExp(`^${expected.length} prices changed\\. Approve below to keep them\\.$`))
    // The footer says a price as the pages do, with where it was read, not as the file's fields.
    await line.getByText(/Sol: .*\$1\.25 \/ \$10\.00 .*→ \$2\.00 \/ \$8\.00 · prices\.openai\.test, /).first().waitFor()
    assert.equal(await main.getByRole('button', { name: 'Apply prices…' }).count(), 0, 'staged prices are offered again')
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, hashesBefore, 'staging wrote the team')
    await shot('models-staged-1280.png')
    await approve()
    await notice(/^Approved · version \d+/)
    const teamAfter = approved()
    assert.deepEqual(teamAfter.agents.find((agent) => agent.id === 'sol').price, { input: 2, output: 8, source: openaiPage, as_of: today })
    const withoutPrice = (data) => data.agents.map((agent) => ({ ...agent, price: null }))
    assert.deepEqual(withoutPrice(teamAfter), withoutPrice(teamBefore), 'approving prices changed something else of an agent')
    assert.deepEqual(teamAfter.agents.filter((agent, index) => JSON.stringify(agent.price) !== JSON.stringify(teamBefore.agents[index].price)).map((agent) => agent.id), expected.map((agent) => agent.id))
    await until(() => readFileSync(rosterFile, 'utf8').includes(openaiPage), 'the researched price in the team file')

    // Add to team… opens New agent with what BMN verified, says so once, and one Undo takes it all back.
    await go('Team', 'Models')
    await main.getByRole('button', { name: 'Add claude-opus-5-6 to team' }).click()
    await main.locator('.page-head', { hasText: /Team\s*›\s*New agent/ }).waitFor()
    const newModel = main.getByRole('combobox', { name: 'Model', exact: true })
    assert.equal(await newModel.inputValue(), 'claude-opus-5-6')
    await main.getByRole('radio', { name: 'Claude Code', exact: true }).and(main.locator('[aria-checked="true"]')).waitFor()
    await main.getByText(/^Name, price and capacity from research on .+\. Check Agent app and Host\.$/).waitFor()
    const priceRow = main.locator('.preferences-row', { hasText: /^Price/ })
    await priceRow.getByText('$15.00 / $75.00').waitFor()
    await priceRow.getByText(/^Read on prices\.anthropic\.test, [A-Z][a-z]+ \d+$/).waitFor()
    await main.getByText(/Capacity 1 000 000 tokens, from research\./).waitFor()
    assert.equal(await main.locator('input[name="class-new"]:checked').count() <= 1, true)
    await shot('new-agent-from-research-1280.png')
    await main.getByRole('button', { name: 'Undo', exact: true }).click()
    assert.equal(await newModel.inputValue(), '')
    assert.equal(await priceRow.count(), 0, 'Undo left the researched price')
    // The Model field offers what research found, under its own heading.
    await newModel.click()
    const foundGroup = main.getByRole('listbox', { name: 'Model suggestions' }).getByRole('group', { name: /^Found in research, / })
    await foundGroup.getByRole('option', { name: /claude-opus-5-6/ }).waitFor()
    await newModel.press('Escape')
    // Look up asks the researcher about the one name typed and fills only what BMN could confirm.
    plan({ facts, listed: {}, slow: null, delayMs: 0 })
    const runsBefore = researchRuns().length
    await newModel.fill('claude-sonnet-5-9')
    await newModel.press('Escape')
    await main.getByRole('button', { name: 'Look up this model' }).click()
    await main.getByText(/^Price from research on .+\.$/).waitFor()
    await priceRow.getByText('$3.00 / $15.00').waitFor()
    assert.equal(researchRuns().length, runsBefore + 1, 'a Look up is one run')
    assert.match(researchRuns().at(-1).prompt, /Models:\n- claude-sonnet-5-9\n\n/)
    assert.match(researchRuns().at(-1).prompt, /List no other models\./)
    // The filled agent is staged with its price and capacity like any other; nothing is approved here.
    await main.getByLabel('Name').fill('Nova')
    await main.getByRole('button', { name: 'Add to team' }).click()
    await card('Nova').waitFor()
    assert.equal(await card('Nova').locator('.price').textContent(), '$3.00 / $15.00')
    assert.match(await card('Nova').locator('.agent-app').textContent(), /^Claude Code · claude-sonnet-5-9$/)
    await ledger.getByText('1 unapproved change', { exact: true }).waitFor()
    await ledger.getByRole('button', { name: 'Discard' }).click()
    await ledger.waitFor({ state: 'detached' })
    assert.equal(approved().agents.some((agent) => agent.name === 'Nova'), false)
    // The earlier stand-in comes back for the pages that follow.
    stub('claude', 'case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; echo "I cannot tell";; esac')
    passed('Models offers only agents that may research, shows progress, keeps a stopped run\'s finished providers, marks a price its page does not show, stages verified prices behind a review and approval, and fills New agent from Add to team… and Look up (60.10 first release)')

    phase('three sizes: no horizontal scrollbar, every control named')
    const pages = [
      ['team', () => go('Team')],
      ['agent', async () => { await go('Team'); await card('Sol').locator('.agent-open').click(); await main.locator('details.advanced > summary').click() }],
      ['new-agent', async () => { await go('Team'); await main.getByRole('button', { name: 'New agent' }).click() }],
      ['roles', async () => { await go('Team', 'Roles'); await main.getByRole('button', { name: 'Edit Lead' }).click() }],
      ['models', () => go('Team', 'Models')],
      ['changes', () => go('Team', 'Changes')],
      ['rules', () => go('Rules')],
      ['skills', () => go('Rules', 'Skills')],
      // With Add tool open, so its rows are measured at each size.
      ['tools', async () => { await go('Rules', 'Tools'); if (await main.locator('.tool-editor').count() === 0) await main.getByRole('button', { name: 'Add tool', exact: true }).click() }],
      ['health', () => go('Rules', 'Health')],
      // The sheet closes when the owner leaves Health, so each size opens it again.
      ['health-update', async () => { await go('Rules', 'Health'); await main.getByRole('button', { name: 'Update Claude Code' }).click(); await main.getByRole('group', { name: 'Update Claude Code' }).waitFor() }],
      ['telegram', () => go(null, 'Telegram')]
    ]
    for (const [width, height] of SIZES) {
      await resize(width, height)
      await sleep(300)
      for (const [name, open] of pages) {
        await open()
        await sleep(200)
        const overflow = await page.evaluate(() => {
          const body = document.querySelector('.preferences-dialog .preferences-main')
          const frame = document.querySelector('.preferences-dialog').getBoundingClientRect()
          const wide = [...document.querySelectorAll('.preferences-dialog *')]
            .filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().right > frame.right + 1)
            .filter((element) => !element.closest('pre, .rules-editor, details:not([open])'))
            .slice(0, 5).map((element) => `${element.tagName}.${element.className}`)
          return { scroll: body.scrollWidth > body.clientWidth + 1, wide }
        })
        assert.equal(overflow.scroll, false, `${name} scrolls sideways at ${width}x${height}`)
        assert.deepEqual(overflow.wide, [], `${name} runs past the dialog at ${width}x${height}`)
        await shot(`${name}-${width}.png`)
      }
    }
    await go('Team')
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('.preferences-nav, .team-page, .rules-page, .ledger, .toast')]
      .flatMap((region) => [...region.querySelectorAll('button, input, textarea, [role="radio"], [role="switch"]')])
      .filter((element) => {
        const labelledBy = element.getAttribute('aria-labelledby')
        const name = element.getAttribute('aria-label') || (labelledBy && document.getElementById(labelledBy)?.textContent)
          || element.closest('label')?.textContent || element.textContent
        return !name || name.trim() === ''
      }).map((element) => element.outerHTML.slice(0, 120)))
    assert.deepEqual(unnamed, [])
    passed('no horizontal scroll on twelve pages at 800x500, 1000x700 and 1280x900; every control has a name (60.5 AC8, 60.6 AC5)')

    phase('keyboard: the navigation and a card open from the keyboard')
    await resize(1280, 900)
    await nav.locator('.nav-sub .nav-item', { hasText: 'Roles' }).focus()
    await page.keyboard.press('Enter')
    await main.locator('.page-title', { hasText: /^Roles$/ }).waitFor()
    await go('Team')
    await card('Sol').locator('.agent-open').focus()
    await page.keyboard.press('Enter')
    await main.locator('.page-head', { hasText: /Team\s*›\s*Sol/ }).waitFor()
    passed('the navigation and an agent card open with Enter')

    phase('narrow: the navigation is one horizontal strip')
    await resize(540, 700)
    await sleep(300)
    const strip = await page.evaluate(() => {
      const element = document.querySelector('.preferences-nav')
      const tops = [...element.querySelectorAll('.nav-item')].map((item) => Math.round(item.getBoundingClientRect().top))
      return { rows: new Set(tops).size, above: element.getBoundingClientRect().bottom <= document.querySelector('.preferences-main').getBoundingClientRect().top + 1 }
    })
    assert.deepEqual(strip, { rows: 1, above: true })
    await shot('team-540.png')
    passed('at a narrow width the navigation is one strip above the page (60.5 AC1)')
    console.log(JSON.stringify({ agentsRulesVisual: 'PASS', directory: evidenceDirectory, ...result }))
  } catch (error) {
    try { await shot('failure.png') } catch { /* the window is gone */ }
    throw error
  } finally {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
