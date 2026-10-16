/* global window */
// MODULE: start-installs-live.mjs - Story 75.9: what BMN installs by itself. At its start it adds the hook entries each app set up here lacks and leaves a changed or foreign one, which Integrations › Health lists; a skill reaches an app once BMN's own test of it passed; Save writes the rules and every app's file at once and Undo puts both back; a second start changes nothing
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end), on the unit-test roster, a
// synthetic rules master, a Claude Code settings file holding a gated BMN entry, a foreign one and a setting of its own,
// an empty Codex folder, an empty OpenCode folder, two synthetic skills (one of which Codex already holds a folder of its
// own for) and stand-in `claude`, `codex` and `opencode` programs. The run names what BMN may install by itself at
// start (BMN_START_INSTALLS) and the one test it may run (BMN_AUTO_TESTS=skills). No agent runs, nothing leaves the
// machine and no file of the owner's is read. Prints one JSON report, PASS or FAIL per check.
// Usage: node scripts/test/start-installs-live.mjs [report.json] [shots-folder]   (needs `pnpm --filter @bmn/desktop build` first)
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const fixtures = join(appDirectory, 'src/utility/test-fixtures')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const reportPath = process.argv[2] ? resolve(process.argv[2]) : null
const shots = process.argv[3] ? resolve(process.argv[3]) : null
const phase = (label) => console.error(`[BMN start installs] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const MASTER = '# Global rules\n\nPlain rule for everyone.\n'
const DOCUMENTED_CLAUDE = '[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0'
const CLAUDE_EVENTS = ['Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt']

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND'))

const report = { generatedAt: new Date().toISOString(), commit: null, checks: [] }
/** Records one check; `ok` null means this run could not observe it (UNVERIFIED), which fails nothing. */
const check = (name, ok, detail = {}) => {
  const result = ok === null ? 'UNVERIFIED' : ok ? 'PASS' : 'FAIL'
  report.checks.push({ name, result, ...detail })
  phase(`${result} ${name} ${JSON.stringify(detail)}`)
}
try { report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* no git */ }
if (shots) mkdirSync(shots, { recursive: true })

async function until(probe, what, timeout = 60_000) {
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
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const agentsDir = join(home, '.config/bmn/agents')
  const stateDir = join(agentsDir, 'state')
  for (const folder of [agentsDir, stateDir, work, stubs]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentsDir, 'roster.md'), readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8')
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}'))
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  // Claude Code: a setting of its own, BMN's entry inside a matcher, and an entry naming the hook that BMN did not write.
  const gated = { matcher: 'Bash', hooks: [{ type: 'command', command: DOCUMENTED_CLAUDE, timeout: 5 }] }
  const foreign = { hooks: [{ type: 'command', command: 'bmn hook claude --verbose' }] }
  const claudeSettings = join(home, '.claude/settings.json')
  mkdirSync(dirname(claudeSettings), { recursive: true })
  writeFileSync(claudeSettings, `${JSON.stringify({ model: 'synthetic-kept', hooks: { PostToolUse: [gated], Stop: [foreign] } }, null, 2)}\n`)
  // Codex and OpenCode were set up here but hold no hook file yet.
  mkdirSync(join(home, '.codex'))
  const openCodeConfig = join(roots.config, 'opencode')
  mkdirSync(openCodeConfig, { recursive: true })
  const skill = (folder, name, text) => { mkdirSync(join(folder, name), { recursive: true }); writeFileSync(join(folder, name, 'SKILL.md'), text) }
  const skillsDir = join(home, '.claude/skills')
  const codexSkills = join(home, '.agents/skills')
  skill(skillsDir, 'evidence-first', '---\nname: evidence-first\ndescription: Check a claim first.\n---\n\nSynthetic.\n')
  skill(skillsDir, 'small-steps', '---\nname: small-steps\ndescription: One thing at a time.\n---\n\nSynthetic.\n')
  skill(codexSkills, 'small-steps', '---\nname: small-steps\n---\n\nKept by hand.\n')
  writeFileSync(join(codexSkills, 'small-steps/own.md'), 'own\n')
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) exit 1;; esac')
  stub('codex', `case "$1" in
  --version) echo "codex-cli 0.162.1";;
  debug) for d in "$HOME"/.agents/skills/*/; do [ -f "\${d}SKILL.md" ] && echo "skill $(basename "$d")"; done; exit 0;;
  *) exit 4;;
esac`)
  stub('opencode', 'case "$1" in --version) echo "2.0.29";; *) exit 1;; esac')

  const files = {
    claude: claudeSettings, codex: join(home, '.codex/hooks.json'),
    plugin: join(openCodeConfig, 'bmn/tui.ts'), cli: join(openCodeConfig, 'cli.json')
  }
  const hash = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null)
  const backups = (path) => (existsSync(dirname(path)) ? readdirSync(dirname(path)).filter((name) => name.includes('.bmn-backup-')).length : 0)
  const transactions = () => {
    const folder = join(stateDir, 'rules/transactions')
    return existsSync(folder) ? readdirSync(folder).length : 0
  }
  const state = () => ({
    files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, hash(path)])),
    backups: backups(claudeSettings) + backups(files.codex) + backups(files.cli),
    skills: readdirSync(codexSkills).sort().map((name) => `${name}:${lstatSync(join(codexSkills, name)).isSymbolicLink() ? 'link' : 'folder'}`),
    transactions: transactions()
  })

  const launch = () => electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', BMN_START_INSTALLS: 'all', BMN_AUTO_TESTS: 'skills',
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: work,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
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
  const ready = async (application) => {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.setContentSize(1280, 860) })
    return page
  }
  const openRules = async (page, sub) => {
    const dialog = page.locator('dialog.preferences-dialog')
    if (await dialog.count() === 0) {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.locator('#palette-results').waitFor()
      await page.keyboard.type('Preferences')
      await page.keyboard.press('Enter')
      await dialog.waitFor()
    }
    // Story 75.10: Integrations shows Health, Rules (the editor), Skills and Tools as views under its head.
    const nav = dialog.locator('nav.preferences-nav')
    await nav.locator('.nav-item', { hasText: /^Integrations/ }).click()
    await dialog.locator('.page-views [role="radio"]', { hasText: new RegExp(`^${sub === 'Editor' ? 'Rules' : sub}$`) }).click()
    return dialog.locator('.preferences-main')
  }
  const focus = (page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  const settled = (page) => page.evaluate(() => window.aiTerminal.autoTests(false))
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
  const hookRow = (main, name) => main.locator('.health-row[data-hooks]', { has: main.page().locator(':scope > span:first-child', { hasText: new RegExp(`^${name}$`) }) })
  const rowText = async (row) => (await row.locator('.health-state').innerText()).split('\n').map((line) => line.trim()).filter(Boolean)

  let application = await launch()
  try {
    let page = await ready(application)

    // ---- The first start: hooks at once, skills once BMN's own test of Codex passed --------------------------------
    phase('first start')
    await until(() => existsSync(files.codex) && existsSync(files.cli), 'the hook entries BMN installs at start')
    const claude = JSON.parse(readFileSync(claudeSettings, 'utf8'))
    const codex = JSON.parse(readFileSync(files.codex, 'utf8'))
    const added = CLAUDE_EVENTS.filter((event) => !['PostToolUse', 'Stop'].includes(event))
    check('at start BMN adds every hook entry an app set up here lacks, beside what the file held (AC3)',
      added.every((event) => JSON.stringify(claude.hooks[event]).includes('bmn hook claude')) && claude.model === 'synthetic-kept'
        && JSON.stringify(Object.keys(codex.hooks)) === JSON.stringify(CODEX_EVENTS) && readFileSync(files.plugin, 'utf8').includes('// Shipped by BMN')
        && JSON.parse(readFileSync(files.cli, 'utf8')).plugins.includes(dirname(files.plugin)),
      { claudeEvents: Object.keys(claude.hooks), codexEvents: Object.keys(codex.hooks), cli: JSON.parse(readFileSync(files.cli, 'utf8')) })
    check('a gated and a foreign entry are left exactly as they were, with nothing added beside them (AC3)',
      JSON.stringify(claude.hooks.PostToolUse) === JSON.stringify([gated]) && JSON.stringify(claude.hooks.Stop) === JSON.stringify([foreign]),
      { PostToolUse: claude.hooks.PostToolUse, Stop: claude.hooks.Stop })
    check('the Claude Code file was copied before it changed; the new Codex file needed no copy', backups(claudeSettings) === 1 && backups(files.codex) === 0,
      { claude: backups(claudeSettings), codex: backups(files.codex) })
    const approval = await page.evaluate(async () => {
      const snapshot = await window.aiTerminal.agentsSnapshot()
      return window.aiTerminal.approveAgents({ generation: null, fileHash: snapshot.file.hash, link: snapshot.file.link, directory: snapshot.file.directory })
    })
    if (!existsSync(join(stateDir, 'current'))) throw new Error(`the made-up team was not approved: ${JSON.stringify(approval)}`)
    await until(() => existsSync(join(codexSkills, 'evidence-first')), 'the skill BMN installs once its test of Codex passed', 120_000)
    await settled(page)
    check('once BMN\'s own test of Codex passed, the skill it lacked is linked, and the folder BMN did not write is left (75.9)',
      readlinkSync(join(codexSkills, 'evidence-first')) === join(skillsDir, 'evidence-first') && readFileSync(join(codexSkills, 'small-steps/own.md'), 'utf8') === 'own\n',
      { skills: state().skills })

    // ---- Integrations › Health › Hooks ------------------------------------------------------------------------------------
    phase('Health › Hooks')
    let main = await openRules(page, 'Health')
    await main.locator('h4.group-head', { hasText: /^Hooks/ }).waitFor()
    await hookRow(main, 'Claude Code').waitFor()
    const order = await main.locator('.health-row[data-hooks] > span:first-child').allTextContents()
    const claudeRow = await rowText(hookRow(main, 'Claude Code'))
    const codexRow = await rowText(hookRow(main, 'Codex'))
    const openCodeRow = await rowText(hookRow(main, 'OpenCode'))
    check('Health lists each app\'s hooks, the one left first, what was left and why, and Codex\'s own question (fable notes 75.9)',
      order[0] === 'Claude Code' && claudeRow[0] === '7 entries in place · 2 left as they are' && claudeRow.includes('PostToolUse · inside a matcher') && claudeRow.includes('Stop · not BMN\'s')
        && codexRow[0] === '7 entries in place' && codexRow.some((line) => line.endsWith('· Codex asks you once, in /hooks, before it runs them')) && openCodeRow[0] === '2 entries in place'
        && await hookRow(main, 'Claude Code').getAttribute('data-hooks') === 'left',
      { order, claudeRow, codexRow, openCodeRow })
    const checkedLine = await main.getByText(/^Checked at start, \d\d:\d\d\./).count()
    const hookButtons = await main.locator('.health-row[data-hooks] button').count()
    const anyHookButton = await main.getByRole('button', { name: /hook/i }).count()
    check('Health says when it checked and offers no button for it', checkedLine === 1 && hookButtons === 0 && anyHookButton === 0, { checkedLine, hookButtons, anyHookButton })
    await main.locator('h4.group-head', { hasText: /^Hooks/ }).scrollIntoViewIfNeeded()
    await shot(page, 'health-hooks-1280.png')

    // ---- Integrations › Rules: Save writes every app's file, Undo puts both back --------------------------------------------
    phase('Save and Undo')
    main = await openRules(page, 'Editor')
    const editor = main.locator('.rules-editor textarea')
    await editor.waitFor()
    const head = main.locator('.preferences-page:not([hidden]) .page-head')
    await head.getByText(/^Saved \w+ \d+, \d\d:\d\d · Claude Code, Codex and OpenCode not written$/).waitFor()
    const headText = (await head.innerText()).replace(/\s+/g, ' ')
    check('the head says which apps the saved rules are not written to, with the dot', await head.locator('.needs-dot').count() === 1, { headText })
    const next = `${MASTER}A rule added live.\n`
    await editor.fill(next)
    await main.getByRole('button', { name: 'Save…' }).click()
    const sheet = main.locator('.sheet')
    await sheet.getByText('Save the rules · +1 −0').waitFor()
    const targets = await sheet.locator('.target > summary > span:first-child').allTextContents()
    await shot(page, 'rules-save-sheet-1280.png')
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    const notice = main.locator('.preferences-success')
    await notice.getByText(/^Saved and installed to Claude Code, Codex and OpenCode/).waitFor()
    const written = ['.claude/CLAUDE.md', '.codex/AGENTS.md'].every((path) => readFileSync(join(home, path), 'utf8').includes('A rule added live.'))
    await head.getByText(/^Saved and installed \w+ \d+, \d\d:\d\d$/).waitFor()
    check('Save lists each app\'s file, then writes the rules and every file at once (AC1)', written && targets.join(',') === 'Claude Code,Codex,OpenCode'
      && readFileSync(join(agentsDir, 'global-rules.md'), 'utf8') === next && await head.locator('.needs-dot').count() === 0, { targets, notice: await notice.innerText() })
    await shot(page, 'rules-saved-1280.png')
    await notice.getByRole('button', { name: 'Undo', exact: true }).click()
    await sheet.getByText('Undo this save').waitFor()
    await shot(page, 'rules-undo-sheet-1280.png')
    const transactionsBefore = transactions()
    await sheet.getByRole('button', { name: 'Undo', exact: true }).click()
    await notice.getByText(/^Put back the rules and their files in Claude Code, Codex and OpenCode/).waitFor()
    await until(async () => (await editor.inputValue()) === MASTER, 'the rules put back')
    check('Undo puts the rules and every file back together and installs nothing again (AC2)',
      readFileSync(join(agentsDir, 'global-rules.md'), 'utf8') === MASTER && !existsSync(join(home, '.codex/AGENTS.md')) && !existsSync(join(home, '.claude/CLAUDE.md'))
        && transactions() === transactionsBefore, { transactions: transactions() })
    await focus(page)
    await settled(page)
  } catch (error) {
    check('the first start completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }

  // ---- A second start changes nothing ----------------------------------------------------------------------------
  const before = state()
  report.before = before
  application = await launch()
  try {
    phase('second start')
    const page = await ready(application)
    const main = await openRules(page, 'Health')
    await hookRow(main, 'Codex').waitFor({ timeout: 60_000 })
    await settled(page)
    await sleep(2_000)
    const after = state()
    report.after = after
    const codexRow = await rowText(hookRow(main, 'Codex'))
    check('a second start writes nothing: the same files, no new copy, no new transaction (AC3)', JSON.stringify(after) === JSON.stringify(before), { before, after })
    check('on the second start nothing was added, and Health says so', codexRow.length === 1 && codexRow[0] === '7 entries in place', { codexRow })
    await main.locator('h4.group-head', { hasText: /^Hooks/ }).scrollIntoViewIfNeeded()
    await shot(page, 'health-hooks-second-start-1280.png')
  } catch (error) {
    check('the second start completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }
})

const failed = report.checks.filter((entry) => entry.result === 'FAIL')
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(failed.length === 0 ? 'START INSTALLS LIVE: PASS' : `START INSTALLS LIVE: FAIL (${failed.map((entry) => entry.name).join('; ')})`)
process.exitCode = failed.length === 0 ? 0 : 1
