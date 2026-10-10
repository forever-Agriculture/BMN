/* global document, window */
// MODULE: agents-rules-visual.mjs - Epic 60.5/60.6: Preferences › Team and Rules on a synthetic roster and master in a temporary HOME
// HOME points at a scratch folder holding the synthetic roster (the unit-test fixture), a synthetic rules master and stub
// app files; PATH holds only stub claude/codex binaries and the system folders, so no step reaches a provider or the
// owner's own rules. Screenshots land in .dev-auto/evidence/epic-60/shots/ (ignored).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  writeFileSync(rosterFile, EXAMPLE)
  writeFileSync(masterFile, MASTER)
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('codex', 'echo "codex-cli 0.161.0"')
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
      PATH: `${stubs}:/usr/bin:/bin`,
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
      ['Team', 'Agents', 'Roles', 'Changes', 'Rules', 'Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup'])
    assert.equal(await dialog.locator('.preferences-jump').count(), 0)
    for (const title of ['Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup']) {
      await go(null, title)
      await main.locator('h3', { hasText: new RegExp(`^${title}$`) }).waitFor()
      assert.equal(await main.count(), 1, `${title} shares the screen with another page`)
      assert.equal(await nav.locator('.nav-sub').count(), 0, 'sub-pages show although their parent is closed')
    }
    await shot('page-appearance-1280.png')
    await go('Rules')
    assert.deepEqual(await nav.locator('.nav-sub .nav-item').allTextContents(), ['Editor', 'Health'])
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
      ['Knight leads an epic/project', 'Queen does what she wants, in any role', 'Rook the Artist: designs what is not there yet', 'Bishop reviews and advises', 'Pawn does jobs a lead hands off'])
    assert.equal(await main.getByRole('checkbox', { name: /^Designer/ }).isDisabled(), true, 'a knight is offered the designer role')
    passed('an agent lists Identity, Model and Work rows; Advanced is closed and holds Paid by, Compact at, Host, Also called and the team file')
    await go('Team')

    phase('add an agent on a provider the team does not know')
    await main.getByRole('button', { name: 'New agent' }).click()
    await main.getByLabel('Model').fill('kimi-k3')
    await main.getByLabel('Host').fill('api.moonshot.test')
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
      const row = main.locator('.outside-row', { hasText: 'changed outside BMN' })
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
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await notice(/^Saved · not installed yet/)
    assert.equal(readFileSync(masterFile, 'utf8'), second)
    passed('the editor numbers lines, dims markers, inserts sections by name and saves the text its diff showed')

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
    await notice(/^Put back Claude Code, Codex, OpenCode, Cursor/)
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
    passed('Health shows each file with its state and rendering; the loading test says what it sends, is off for public-only apps and reports in words')

    phase('every installed app version is supported and marked; a changed destination still shows')
    const app = (name) => main.locator('.app-block', { has: page.locator('.health-row > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
    await app('Codex').getByText('· tested').waitFor()
    await app('Codex').getByText("Sends data to OpenAI's own servers").waitFor()
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
    await notice(/^Put back Claude Code, Codex/)
    assert.doesNotMatch(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), /Haiku|added outside BMN/)
    passed('Approve first lists each rules file with its path and diff, commits from there, updates exactly those files; Undo shows what it puts back and waits for the owner')

    phase('three sizes: no horizontal scrollbar, every control named')
    const pages = [
      ['team', () => go('Team')],
      ['agent', async () => { await go('Team'); await card('Sol').locator('.agent-open').click(); await main.locator('details.advanced > summary').click() }],
      ['new-agent', async () => { await go('Team'); await main.getByRole('button', { name: 'New agent' }).click() }],
      ['roles', async () => { await go('Team', 'Roles'); await main.getByRole('button', { name: 'Edit Lead' }).click() }],
      ['changes', () => go('Team', 'Changes')],
      ['rules', () => go('Rules')],
      ['health', () => go('Rules', 'Health')],
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
    passed('no horizontal scroll on eight pages at 800x500, 1000x700 and 1280x900; every control has a name (60.5 AC8, 60.6 AC5)')

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
