/* global window */
// MODULE: auto-tests-live.mjs - Story 75.8: BMN tests each app by itself on a first install and after a version change, at most three times per test on disk, ten minutes apart, tells a stop once, and offers Test again only then
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end), on the unit-test roster, a
// synthetic rules master and stand-in `claude`, `codex` and `opencode` programs whose version is read from a file the
// script changes. The run names the tests BMN may start by itself (BMN_AUTO_TESTS); the fence test, whose stand-in is a
// provider of its own, is left to its unit and IPC tests. Time is moved by setting back when each try began in BMN's own
// file of tries, as ten minutes passing would. No agent runs, nothing leaves the machine, no file of the owner's is read,
// and BMN's desktop notices are counted in its main process instead of being shown. Prints one JSON report, PASS or FAIL per check.
// Usage: node scripts/test/auto-tests-live.mjs [report.json] [shots-folder]   (needs `pnpm --filter @bmn/desktop build` first)
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { testedApp } from '../lib/tested-app.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const fixtures = join(appDirectory, 'src/utility/test-fixtures')
const tested = testedApp(appDirectory)
console.log(`BMN build: ${tested.build}`)
const reportPath = tested.rest[0] ? resolve(tested.rest[0]) : null
const shots = tested.rest[1] ? resolve(tested.rest[1]) : null
const phase = (label) => console.error(`[BMN auto-tests] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const KINDS = 'skills,tools,rules,context'
const MASTER = '# Global rules\n\nPlain rule for everyone.\n'
const APPS = ['claude', 'codex', 'opencode']
const FIRST = { claude: '2.1.296', codex: '0.162.1', opencode: '2.0.29' }
const NEXT = { claude: '2.1.297', codex: '0.162.2', opencode: '2.0.30' }

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND'))

const report = { generatedAt: new Date().toISOString(), commit: null, kinds: KINDS, checks: [], tries: {}, records: {} }
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
  const versions = join(root, 'versions')
  const agentsDir = join(home, '.config/bmn/agents')
  const stateDir = join(agentsDir, 'state')
  for (const folder of [agentsDir, stateDir, work, stubs, versions]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  // The unit tests' made-up team; this home holds no OpenCode settings, so OpenCode's destination is the owner's word here.
  writeFileSync(join(agentsDir, 'roster.md'), readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8')
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}'))
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  mkdirSync(join(home, '.claude/skills/evidence-first'), { recursive: true })
  writeFileSync(join(home, '.claude/skills/evidence-first/SKILL.md'), '---\nname: evidence-first\ndescription: Check a claim first.\n---\n\nSynthetic.\n')
  mkdirSync(join(home, '.codex'))
  const setVersions = (map) => { for (const app of APPS) writeFileSync(join(versions, app), `${map[app]}\n`) }
  setVersions(FIRST)
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/sh\nv=$(cat '${join(versions, name)}')\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  const starts = join(root, 'starts.log')
  // Claude Code: its loading test passes when it quotes the rendered hash of the rules it was given; every other start says so in a line of its own.
  stub('claude', `echo "claude $*" >> '${starts}'
case "$1" in --version) echo "$v (Claude Code)";; *) grep -o 'master sha256 [0-9a-f]*' "$HOME/.claude/CLAUDE.md" 2>/dev/null | cut -d' ' -f3;; esac`)
  // Codex: names the skills it finds; a run asked for a context size leaves the session record a real run writes only once the script says so.
  const codexAnswers = join(root, 'codex-answers')
  stub('codex', `echo "codex $*" >> '${starts}'
case "$1" in
  --version) echo "codex-cli $v";;
  debug) for d in "$HOME"/.agents/skills/*/; do [ -f "\${d}SKILL.md" ] && echo "skill $(basename "$d")"; done; exit 0;;
  exec)
    if [ -f '${codexAnswers}' ]; then
      dir=""; prev=""; for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done
      mkdir -p "$HOME/.codex/sessions/2026/10/16"
      printf '{"payload":{"cwd":"%s"}}\\n{"payload":{"type":"task_started","model_context_window":116850}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/16/rollout-context-test.jsonl"
    fi;;
  *) exit 4;;
esac`)
  stub('opencode', `echo "opencode $*" >> '${starts}'
case "$1" in --version) echo "$v";; *) exit 1;; esac`)
  const startLines = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n') : [])
  const contextRuns = () => startLines().filter((line) => line.startsWith('codex exec') && line.includes('model_context_window=')).length
  const triesPath = join(stateDir, 'auto-tests.json')
  const tries = () => (existsSync(triesPath) ? JSON.parse(readFileSync(triesPath, 'utf8')).tries : {})
  const triesOf = (kind, app, version) => Object.entries(tries()).filter(([id]) => id.startsWith(`${kind} ${app} ${version}\n`)).map(([, entry]) => entry)
  /** Ten minutes and a second pass for the tries of one kind, as BMN reads them from its file. */
  const later = (kind) => {
    const kept = JSON.parse(readFileSync(triesPath, 'utf8'))
    for (const [id, entry] of Object.entries(kept.tries)) if (id.startsWith(`${kind} `)) entry.at = new Date(Date.parse(entry.at) - 601_000).toISOString()
    writeFileSync(triesPath, JSON.stringify(kept))
  }
  const records = (file) => (existsSync(join(stateDir, file)) ? readFileSync(join(stateDir, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const bmnRecords = (app, version) => [
    ...records('skills-tests.jsonl').map((entry) => ({ ...entry, test: 'skills' })), ...records('tools-tests.jsonl').map((entry) => ({ ...entry, test: 'tools' })),
    ...records('probes.jsonl').map((entry) => ({ ...entry, test: 'rules' })), ...records('context-tests.jsonl').map((entry) => ({ ...entry, test: 'context' }))
  ].filter((entry) => entry.harness === app && entry.version === version && entry.by === 'bmn')
  const bmn = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 120_000 })

  const launch = () => electron.launch({
    executablePath: tested.executablePath,
    args: [...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', BMN_AUTO_TESTS: KINDS,
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: work,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  /** BMN's notices are kept in its main process for the script to read, not shown on the desktop. */
  const countNotices = (application) => application.evaluate(({ Notification }) => {
    globalThis.__autoTestNotices = globalThis.__autoTestNotices ?? []
    Notification.prototype.show = function show() { globalThis.__autoTestNotices.push({ title: this.title, body: this.body }) }
  })
  const notices = (application) => application.evaluate(() => globalThis.__autoTestNotices ?? [])
  const close = async (application) => {
    // Sessions still running make BMN ask before it quits, so they are stopped first; a close that still hangs is cut short.
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
  /** Integrations › Health in Preferences (Story 75.10), found by text: a page's name carries its Needs-you mark. */
  const openHealth = async (page) => {
    const dialog = page.locator('dialog.preferences-dialog')
    if (await dialog.count() === 0) {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.locator('#palette-results').waitFor()
      await page.keyboard.type('Preferences')
      await page.keyboard.press('Enter')
      await dialog.waitFor()
    }
    const nav = dialog.locator('nav.preferences-nav')
    await nav.locator('.nav-item', { hasText: /^Integrations/ }).click()
    await dialog.locator('.page-views [role="radio"]', { hasText: /^Health$/ }).click()
    await dialog.locator('.page-views [role="radio"][aria-checked="true"]', { hasText: /^Health$/ }).waitFor()
    return dialog.locator('.preferences-main')
  }
  const focus = (page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  const settled = (page) => page.evaluate(() => window.aiTerminal.autoTests(false))
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
  const limitRow = (main, name) => main.locator('.limit-block', { has: main.page().locator('.health-row > span:first-child', { hasText: new RegExp(`^${name}$`) }) })

  let application = await launch()
  try {
    await countNotices(application)
    let page = await ready(application)

    // ---- A first install: BMN tests every app by itself, with nothing pressed -------------------------------------
    phase('first install')
    const approval = await page.evaluate(async () => {
      const snapshot = await window.aiTerminal.agentsSnapshot()
      return window.aiTerminal.approveAgents({ generation: null, fileHash: snapshot.file.hash, link: snapshot.file.link, directory: snapshot.file.directory })
    })
    if (!existsSync(join(stateDir, 'current'))) throw new Error(`the made-up team was not approved: ${JSON.stringify(approval)}`)
    // The rules are installed as the owner's Save does it; their loading test then waits for BMN.
    const installed = bmn('rules', 'install', '--yes', '--json')
    if (installed.status !== 0) throw new Error(`rules install failed: ${installed.stderr}`)
    let main = await openHealth(page)
    await until(() => APPS.every((app) => bmnRecords(app, FIRST[app]).length > 0), 'a test BMN ran by itself of every app', 120_000)
    await settled(page)
    await focus(page)
    await settled(page)
    const said = (entry) => `${entry.test} ${entry.kind ?? ''} ${entry.outcome ?? entry.limit}`.replace('  ', ' ')
    const firstRecords = Object.fromEntries(APPS.map((app) => [app, bmnRecords(app, FIRST[app]).map(said)]))
    report.records.first = firstRecords
    check('a first install: BMN tested each app by itself, every record marked as BMN\'s', APPS.every((app) => firstRecords[app].length > 0), { records: firstRecords })
    const firstTries = Object.fromEntries(Object.entries(tries()).map(([id, entry]) => [id.split('\n')[0], entry.count]))
    report.tries.first = firstTries
    check('each test BMN started is counted on disk, once per test so far', Object.keys(firstTries).length > 0 && Object.values(firstTries).every((count) => count === 1), { tries: firstTries })
    const html = await main.innerHTML()
    check('Health offers no Test… and no switch for BMN\'s own testing (AC3)', !/Test…|Loading test…|Test context limits after an app update/.test(html), {})
    const claudeRules = main.locator('.health-row[data-state]', { has: page.locator(':scope > span:first-child', { hasText: /^Claude Code$/ }) })
    const rulesLine = await claudeRules.locator('.faint').first().textContent()
    check('a test that sends a prompt says so, and that BMN ran it (AC2)', /· by BMN · one prompt sent$/.test(rulesLine ?? ''), { line: rulesLine })
    // The tools test and where an app reads skills send no prompt: their rows never say one was sent ("Checked" for a passed tools test is unit-tested).
    const quietLines = [...await main.locator('.health-row[data-tools] .faint').allTextContents(), ...await main.locator('.health-row[data-skills] .faint').allTextContents()]
    check('a check that sends no prompt never says it sent one (AC2)', quietLines.length >= 6 && quietLines.every((line) => !line.includes('prompt sent')), { lines: quietLines })
    await shot(page, 'health-first-install-1280.png')

    // ---- A new version of each app: one run per app by BMN, with nothing pressed -----------------------------------
    phase('version change')
    setVersions(NEXT)
    await focus(page)
    await until(() => APPS.every((app) => bmnRecords(app, NEXT[app]).length > 0), 'a test BMN ran by itself of each new version', 120_000)
    await settled(page)
    const nextRecords = Object.fromEntries(APPS.map((app) => [app, bmnRecords(app, NEXT[app]).map(said)]))
    report.records.next = nextRecords
    check('a new version of each app: BMN tested it by itself, in an isolated run per app (AC1)', APPS.every((app) => nextRecords[app].length > 0), { records: nextRecords })
    const leftovers = readdirSync(home).filter((name) => /^\.bmn-.*-test-/.test(name))
    check('every test removed its own folder (AC3)', leftovers.length === 0, { leftovers })

    // ---- Tries of a test that shows nothing: at most three, ten minutes apart, told once -----------------------------
    phase('bounded tries')
    const contextTries = () => triesOf('context', 'codex', NEXT.codex)[0]?.count ?? 0
    const contextAt = (label) => ({ label, tries: contextTries(), runs: contextRuns() })
    const steps = [contextAt('after the new version')]
    await focus(page)
    await settled(page)
    steps.push(contextAt('a look before ten minutes'))
    later('context')
    await focus(page)
    await until(async () => contextTries() >= 2 && (await settled(page), true), 'the second try')
    steps.push(contextAt('ten minutes later'))
    later('context')
    await focus(page)
    await until(async () => contextTries() >= 3 && (await settled(page), true), 'the third try')
    steps.push(contextAt('ten minutes after that'))
    later('context')
    await focus(page)
    await settled(page)
    await sleep(1500)
    steps.push(contextAt('another ten minutes'))
    report.tries.context = steps
    check('a test that showed nothing is tried again only after ten minutes, three times in all (AC2)',
      JSON.stringify(steps.map((step) => step.tries)) === '[1,1,2,3,3]' && steps.at(-1).runs === steps.at(-2).runs && steps[1].runs === steps[0].runs, { steps })
    const all = await notices(application)
    // Once per test: a notice names the app's version, so the same failure on the next version is a notice of its own.
    const toldLines = all.map((notice) => `${notice.title}: ${notice.body}`)
    check('each failure or stop is told once per version, however often BMN looked', toldLines.length > 0 && new Set(toldLines).size === toldLines.length, { told: toldLines })
    const told = all.filter((notice) => notice.title === 'Codex context test stopped')
    check('the stop is told once, naming the agent whose limit waits', told.length === 1 && told[0].body.startsWith("Sol's own context limit does not hold on Codex 0.162.2:"), { told })
    main = await openHealth(page)
    const codexLimit = limitRow(main, 'Codex')
    await codexLimit.getByText(`BMN stopped after 3 tries on ${NEXT.codex}`).waitFor()
    const againButton = codexLimit.getByRole('button', { name: 'Test the context limit of Codex again' })
    check('the row says where BMN stopped and offers Test again… (AC1, Fable 75.8)', await againButton.count() === 1, {})
    await codexLimit.scrollIntoViewIfNeeded()
    await shot(page, 'health-context-stopped-1280.png')

    // ---- A restart: the count on disk stands -------------------------------------------------------------------------
    phase('restart')
    const runsBefore = contextRuns()
    await close(application)
    application = await launch()
    await countNotices(application)
    page = await ready(application)
    await page.evaluate(() => window.aiTerminal.autoTests(true))
    main = await openHealth(page)
    await settled(page)
    await limitRow(main, 'Codex').getByText(`BMN stopped after 3 tries on ${NEXT.codex}`).waitFor()
    const toldAgain = (await notices(application)).filter((notice) => notice.title === 'Codex context test stopped')
    check('after a restart BMN starts no fourth try and says nothing again (AC2)', contextRuns() === runsBefore && contextTries() === 3 && toldAgain.length === 0, { runsBefore, runsAfter: contextRuns(), tries: contextTries(), toldAgain })

    // ---- Test again: the owner's own test, whose pass settles the row -----------------------------------------------
    phase('Test again')
    writeFileSync(codexAnswers, 'yes\n')
    await limitRow(main, 'Codex').getByRole('button', { name: 'Test the context limit of Codex again' }).click()
    const sheet = limitRow(main, 'Codex').locator('.sheet')
    await sheet.getByText('Starts Codex once in an empty folder', { exact: false }).waitFor()
    await sheet.getByRole('button', { name: 'Run test' }).click()
    await limitRow(main, 'Codex').getByText(`Setting tested on ${NEXT.codex} · one prompt sent`).waitFor({ timeout: 60_000 })
    const own = records('context-tests.jsonl').filter((entry) => entry.harness === 'codex' && entry.version === NEXT.codex).at(-1)
    const stillStopped = await limitRow(main, 'Codex').getByText(/BMN stopped after/).count()
    check('Test again runs the owner\'s own test; its pass ends the stop on the row (AC1)', own?.limit === 'pass' && own.by === undefined && stillStopped === 0
      && await limitRow(main, 'Codex').getByRole('button', { name: /again$/ }).count() === 0, { own: own && { limit: own.limit, by: own.by ?? null }, stillStopped })
    await limitRow(main, 'Codex').scrollIntoViewIfNeeded()
    await shot(page, 'health-context-tested-again-1280.png')
    report.tries.final = Object.fromEntries(Object.entries(tries()).map(([id, entry]) => [id.split('\n')[0], { count: entry.count, outcome: entry.outcome, told: entry.told ?? false }]))
  } catch (error) {
    check('the run completed', false, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await close(application)
  }
})

const failed = report.checks.filter((entry) => entry.result === 'FAIL')
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(failed.length === 0 ? 'AUTO-TESTS LIVE: PASS' : `AUTO-TESTS LIVE: FAIL (${failed.map((entry) => entry.name).join('; ')})`)
process.exitCode = failed.length === 0 ? 0 : 1
