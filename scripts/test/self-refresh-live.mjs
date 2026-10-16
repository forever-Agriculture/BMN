/* global window, document */
// MODULE: self-refresh-live.mjs - Story 75.7: every view that lost its Refresh or Check now shows a change without a press, and reads no more often than stated
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end), on the unit-test roster, a
// synthetic rules master and a stand-in `codex` and `claude`. One session runs a stand-in agent named `claude` that
// reports its start through `bmn hook claude` and then runs, on the script's word, the `bmn` commands and hook reports
// an agent would. Each change is made outside the window (a file written, a command run in the session, the window's
// focus) and the view is watched until it shows it; nothing on screen is pressed to read. BMN's own main process counts
// how often each view's read arrives, so the bounds are measured, not assumed. No agent runs, nothing leaves the machine
// and no file of the owner's is read. Prints one JSON report, and PASS or FAIL per check.
// Usage: node scripts/test/self-refresh-live.mjs [report.json]   (needs `pnpm --filter @bmn/desktop build` first)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const phase = (label) => console.error(`[BMN self-refresh] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const CONVERSATION = '7e7e7e7e-1b1b-2c2c-3d3d-4e4e4e4e4e4e'
// The bounds Story 75.7 states: a timer of 30 s while shown in a visible window (self-refresh.ts SELF_REFRESH_MS).
const EVERY_MS = 30_000
const WATCH_MS = 65_000

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND'))
const MASTER = '# Global rules\n\nPlain rule for everyone.\n\n## Team\nThe team: <!-- bmn:team -->.\n'
const CHANNELS = ['aiterm:progress:list', 'aiterm:dev-auto:runs', 'aiterm:repository:inspect', 'aiterm:hook-observation:get',
  'aiterm:telegram:status', 'aiterm:rules:snapshot', 'aiterm:agents:snapshot']

const report = { generatedAt: new Date().toISOString(), commit: null, checks: [], reads: {} }
/** Records one check; `ok` null means this run could not observe it (UNVERIFIED), which fails nothing. */
const check = (name, ok, detail) => {
  const result = ok === null ? 'UNVERIFIED' : ok ? 'PASS' : 'FAIL'
  report.checks.push({ name, result, ...detail })
  phase(`${result} ${name} ${JSON.stringify(detail)}`)
}
try { report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* no git */ }

async function until(probe, what, timeout = 20_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const work = join(root, 'work')
  const stubs = join(root, 'stubs')
  const queue = join(root, 'queue')
  const backups = join(root, 'backups')
  const agentsDir = join(home, '.config/bmn/agents')
  for (const folder of [agentsDir, join(agentsDir, 'state'), work, stubs, queue, backups]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  const roster = readFileSync(join(fixtures, 'agents/roster-example.md'), 'utf8')
  writeFileSync(join(agentsDir, 'roster.md'), roster)
  writeFileSync(join(agentsDir, 'global-rules.md'), MASTER)
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  mkdirSync(join(home, '.claude/skills/evidence-first'), { recursive: true })
  writeFileSync(join(home, '.claude/skills/evidence-first/SKILL.md'), '---\nname: evidence-first\ndescription: Check a claim first.\n---\n\nSynthetic.\n')
  mkdirSync(join(home, '.codex'))
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  stub('claude', 'case "$1" in --version) echo "2.1.296 (Claude Code)";; *) echo "synthetic claude";; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) echo "synthetic codex";; esac')
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' }).trim()
  git('init', '-qb', 'main')
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base')

  // The stand-in agent: named `claude` so its hook reports count (a shell's do not); it runs each queued script once.
  const agent = join(root, 'agent-bin', 'claude')
  mkdirSync(dirname(agent))
  writeFileSync(agent, `#!/bin/bash
B() { if command -v bmn >/dev/null; then bmn "$@"; else '${process.execPath}' '${cli}' "$@"; fi; }
H() { printf '%s' "$1" | B hook claude; }
H '${JSON.stringify({ session_id: CONVERSATION, hook_event_name: 'SessionStart', source: 'startup' })}'
echo "stand-in agent ready"
while :; do
  # The run's folder is gone once the script has ended: so is this stand-in.
  [ -d '${queue}' ] || exit 0
  for job in '${queue}'/*.sh; do
    [ -e "$job" ] || continue
    source "$job" > "$job.out" 2>&1
    mv "$job" "$job.done"
  done
  sleep 0.2
done
`)
  chmodSync(agent, 0o755)
  let jobs = 0
  const run = async (body) => {
    jobs += 1
    const job = join(queue, `${String(jobs).padStart(3, '0')}.sh`)
    writeFileSync(job, `${body}\n`)
    await until(() => existsSync(`${job}.done`), `the session to run job ${jobs}`)
    return readFileSync(`${job}.out`, 'utf8')
  }
  const hookLine = (payload) => `H '${JSON.stringify({ session_id: CONVERSATION, ...payload })}'`

  const application = await electron.launch({
    executablePath: tested.executablePath,
    args: [...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: work,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.setContentSize(1280, 860) })

    // Each view's read is counted where it arrives: BMN's own handler of that channel, wrapped for this run only.
    const wrapped = await application.evaluate(({ ipcMain }, channels) => {
      const handlers = ipcMain._invokeHandlers
      if (!(handlers instanceof Map)) return []
      globalThis.__selfRefreshReads = {}
      const done = []
      for (const channel of channels) {
        const handler = handlers.get(channel)
        if (typeof handler !== 'function') continue
        globalThis.__selfRefreshReads[channel] = 0
        handlers.set(channel, (...args) => { globalThis.__selfRefreshReads[channel] += 1; return handler(...args) })
        done.push(channel)
      }
      return done
    }, CHANNELS)
    assert.deepEqual(wrapped.sort(), [...CHANNELS].sort(), 'BMN\'s read handlers could not be counted')
    const reads = () => application.evaluate(() => ({ ...globalThis.__selfRefreshReads }))
    const readsDuring = async (channel, ms) => {
      const before = (await reads())[channel]
      await sleep(ms)
      return (await reads())[channel] - before
    }
    const focus = () => page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    const noButton = async (scope, names) => {
      for (const name of names) assert.equal(await scope.getByRole('button', { name, exact: true }).count(), 0, `a ${name} button is still offered`)
    }
    const timed = async (what, probe, timeout) => {
      const started = Date.now()
      await until(probe, what, timeout)
      return Date.now() - started
    }

    const workspace = await page.evaluate(async () => (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt))
    const created = await page.evaluate(async ({ workspaceId, cwd, executable }) =>
      (await window.aiTerminal.createSession({ workspaceId, name: 'Builder', cwd, executable, argv: [], cols: 100, rows: 24, backgroundChoice: 'stop' })).session,
    { workspaceId: workspace.workspaceId, cwd: work, executable: agent })
    const sessionId = created.sessionId
    await page.reload()
    await page.waitForSelector('.session-row')
    await page.locator('button[aria-label="Dismiss notice"]').click({ timeout: 3_000 }).catch(() => undefined)
    await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await until(async () => (await page.evaluate((id) => window.aiTerminal.getHookObservation(id), sessionId)).state === 'observed', 'the stand-in agent to report its start', 30_000)
    await sleep(1_500)
    const palette = async (text) => {
      await page.locator('button[aria-label="Command palette"]').click()
      await page.locator('#palette-results').waitFor()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    }

    // ---- Review results: an agent's report shows while the view is open (topic progress) -------------------------
    phase('Review results')
    // Story 75.10: Review results opens from the palette, for the active workspace.
    await palette('Review results')
    const results = page.locator('dialog.workspace-results-dialog').first()
    await results.waitFor()
    await sleep(1_000)
    await noButton(results, ['Refresh results', 'Refresh'])
    const progressBefore = (await reads())['aiterm:progress:list']
    const progressStarted = Date.now()
    await run(`B progress claimed-done 'Story 9.9 live refresh' --detail 'Synthetic: the view updates by itself.' --source synthetic`)
    await until(async () => (await results.textContent()).includes('Story 9.9 live refresh'), 'the report in Review results', 10_000)
    const resultsMs = Date.now() - progressStarted
    check('Review results shows an agent report without a press', resultsMs < 5_000, { ms: resultsMs, reads: (await reads())['aiterm:progress:list'] - progressBefore })
    const idleProgress = await readsDuring('aiterm:progress:list', 35_000)
    check('Review results reads nothing on a timer while nothing changes', idleProgress === 0, { readsIn35s: idleProgress })

    // ---- dev-auto runs: a handoff written outside BMN shows within the 30 s bound, and nothing while hidden ----
    phase('dev-auto runs')
    await results.getByRole('button', { name: 'dev-auto runs…' }).click()
    const runs = page.locator('dialog.dev-auto-dialog')
    await runs.waitFor()
    await noButton(runs, ['Refresh'])
    mkdirSync(join(work, '.dev-auto'), { recursive: true })
    writeFileSync(join(work, '.dev-auto/handoff.md'), `- Project / selected epics: Live fixture; epic 9\n- Owning checkout and branch: ${work} / main\n- Explicit user stop: none\n## Resume\n- Next safe action: synthetic step\n- Status: ACTIVE\n`)
    const runsMs = await timed('the handoff in dev-auto runs', async () => (await runs.textContent()).includes('Live fixture'), EVERY_MS + 10_000)
    check('dev-auto runs shows a handoff written outside BMN within its 30 s bound', runsMs <= EVERY_MS + 3_000, { ms: runsMs })
    const shownRuns = await readsDuring('aiterm:dev-auto:runs', WATCH_MS)
    check('dev-auto runs reads at most once per 30 s while shown', shownRuns >= 1 && shownRuns <= Math.ceil(WATCH_MS / EVERY_MS) + 1, { readsIn65s: shownRuns })
    // Hidden rather than minimised: a compositor may keep a minimised window's page visible.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await until(() => page.evaluate(() => document.visibilityState === 'hidden'), 'the hidden window\'s page to be hidden', 10_000)
      .catch(() => null)
    const hiddenState = await page.evaluate(() => document.visibilityState)
    const hiddenRuns = await readsDuring('aiterm:dev-auto:runs', 40_000)
    check('dev-auto runs reads nothing while the window is hidden', hiddenState !== 'hidden' ? null : hiddenRuns === 0, { visibilityState: hiddenState, readsIn40s: hiddenRuns })
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus() })
    await sleep(1_000)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await sleep(300)

    // ---- Messages: an open list recovers from a failed read and lets a pause go, with no press and no message -----
    phase('Messages')
    // BMN's own list handler, for this run only: the next read fails once, and a pause is shown while armed.
    const armed = await application.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const handler = handlers instanceof Map ? handlers.get('aiterm:messages:list') : undefined
      if (typeof handler !== 'function') return false
      globalThis.__messages = { fail: 1, pauseUntil: 0, reads: 0 }
      handlers.set('aiterm:messages:list', async (...args) => {
        const state = globalThis.__messages
        state.reads += 1
        if (state.fail > 0) {
          state.fail -= 1
          throw new Error('Synthetic: this read failed')
        }
        const listing = await handler(...args)
        if (Date.now() >= state.pauseUntil || listing?.ok === false) return listing
        const workspacePause = { at: new Date(Date.now() - 60_000).toISOString(), until: new Date(state.pauseUntil).toISOString() }
        // BMN's handlers answer in an envelope, { ok, result }.
        return listing?.ok === true && listing.result ? { ...listing, result: { ...listing.result, workspacePause } } : listing
      })
      return true
    })
    assert.equal(armed, true, 'BMN\'s Messages handler could not be wrapped')
    await palette('Messages…')
    const messagesDialog = page.locator('dialog.session-messages-dialog')
    await messagesDialog.waitFor()
    await noButton(messagesDialog, ['Refresh'])
    await messagesDialog.getByRole('alert').waitFor({ timeout: 10_000 })
    const recoveredMs = await timed('the list after a failed read', async () => (await messagesDialog.getByRole('alert').count()) === 0 &&
      (await messagesDialog.textContent()).includes('Accepted'), EVERY_MS + 10_000)
    check('Messages reads again by itself after a failed read, within its 30 s bound', recoveredMs <= EVERY_MS + 3_000, { ms: recoveredMs })
    await application.evaluate(() => { globalThis.__messages.pauseUntil = Date.now() + 8_000 })
    await focus()
    await until(async () => (await messagesDialog.textContent()).includes('Paused by the limit until'), 'the pause in Messages', 10_000)
    const pauseReads = (await application.evaluate(() => globalThis.__messages.reads))
    const liftedMs = await timed('the pause to go', async () => (await messagesDialog.textContent()).includes('Accepted'), EVERY_MS + 15_000)
    check('Messages lets a pause go by itself, within 30 s of its time, with no message and no press', liftedMs <= 8_000 + EVERY_MS + 3_000, { ms: liftedMs, readsAfterPause: (await application.evaluate(() => globalThis.__messages.reads)) - pauseReads })
    const idleMessages = await application.evaluate(() => globalThis.__messages.reads)
    await sleep(35_000)
    check('Messages reads nothing on a timer while its list is read and no pause is ahead', (await application.evaluate(() => globalThis.__messages.reads)) === idleMessages, {})
    await page.keyboard.press('Escape')
    await sleep(300)

    // ---- Session details: repository identity on focus, harness events as they arrive --------------------------
    phase('Session details')
    await palette('Session details')
    const identity = page.locator('section.repository-identity')
    const harness = page.locator('section.hook-observation')
    await identity.waitFor()
    await harness.waitFor()
    await noButton(page.locator('body'), ['Refresh identity', 'Refresh observation'])
    await until(async () => (await identity.textContent()).includes('main'), 'the identity to name main')
    git('checkout', '-qb', 'feature/live-refresh')
    const identityBefore = (await reads())['aiterm:repository:inspect']
    await focus()
    const identityMs = await timed('the new branch in Session details', async () => (await identity.textContent()).includes('feature/live-refresh'), 10_000)
    check('Repository identity shows a branch changed outside BMN when the window gets the focus', identityMs < 5_000, { ms: identityMs, reads: (await reads())['aiterm:repository:inspect'] - identityBefore })
    const harnessText = async () => (await harness.textContent()) ?? ''
    const before = await harnessText()
    const harnessStarted = Date.now()
    await run(hookLine({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'true' } }))
    await until(async () => (await harnessText()) !== before, 'the harness section to show the new event', 20_000)
    const harnessMs = Date.now() - harnessStarted
    // BMN publishes a harness change only when the agent, model or origin changes (companion-service.ts), so a busy
    // agent's every tool call does not re-read; the latest event follows the panel's 15 s re-read (main.tsx).
    check('Harness shows a hook event without a press within its 15 s bound', harnessMs <= 15_000 + 3_000, { ms: harnessMs, before: before.slice(0, 120), after: (await harnessText()).slice(0, 120) })
    const harnessReads = await readsDuring('aiterm:hook-observation:get', 31_000)
    check('Harness reads at most once per 15 s while nothing changes', harnessReads <= 3, { readsIn31s: harnessReads })

    // ---- Preferences: Telegram's status on its 30 s bound only while shown; Health, Skills, Team on focus ------
    phase('Preferences')
    await palette('Preferences')
    const dialog = page.locator('dialog.preferences-dialog')
    await dialog.waitFor()
    const nav = dialog.locator('nav.preferences-nav')
    // A page's button carries its Needs-you mark in its name, so pages are found by their text; Agents and Integrations
    // show their views in the control under the page head (Story 75.10).
    const go = async (label, view = null) => {
      await nav.locator('.nav-item', { hasText: new RegExp(`^${label}`) }).click()
      if (view !== null) await dialog.locator('.preferences-page:not([hidden]) .page-views [role="radio"]', { hasText: new RegExp(`^${view}$`) }).click()
      await sleep(400)
    }
    await go('Notifications')
    await noButton(dialog, ['Refresh'])
    const telegramShown = await readsDuring('aiterm:telegram:status', WATCH_MS)
    check('Telegram status reads at most once per 30 s while its page is shown', telegramShown >= 1 && telegramShown <= Math.ceil(WATCH_MS / EVERY_MS) + 1, { readsIn65s: telegramShown })
    await go('General')
    const telegramHidden = await readsDuring('aiterm:telegram:status', 40_000)
    check('Telegram status reads nothing while another page is shown', telegramHidden === 0, { readsIn40s: telegramHidden })

    await go('Integrations', 'Health')
    await noButton(dialog, ['Check now'])
    await until(async () => (await dialog.textContent()).includes('0.162.1'), 'Health to read Codex 0.162.1')
    const healthIdle = await readsDuring('aiterm:rules:snapshot', 35_000)
    check('Health reads nothing on a timer', healthIdle === 0, { readsIn35s: healthIdle })
    stub('codex', 'case "$1" in --version) echo "codex-cli 0.170.0";; *) echo "synthetic codex";; esac')
    await focus()
    const healthMs = await timed('Health to show Codex 0.170.0', async () => (await dialog.textContent()).includes('0.170.0'), 30_000)
    check('Health shows an app version changed outside BMN when the window gets the focus', healthMs < 20_000, { ms: healthMs })

    await go('Integrations', 'Skills')
    await noButton(dialog, ['Check now'])
    mkdirSync(join(home, '.claude/skills/small-steps'), { recursive: true })
    writeFileSync(join(home, '.claude/skills/small-steps/SKILL.md'), '---\nname: small-steps\ndescription: One change, then check it.\n---\n\nSynthetic.\n')
    await focus()
    const skillsMs = await timed('Skills to show small-steps', async () => (await dialog.textContent()).includes('small-steps'), 30_000)
    check('Skills shows a skill added outside BMN when the window gets the focus', skillsMs < 20_000, { ms: skillsMs })

    await go('Integrations', 'Tools')
    await noButton(dialog, ['Check now'])
    check('Tools offers no Check now', true, {})

    await go('Agents', 'Team')
    writeFileSync(join(agentsDir, 'roster.md'), roster.replace('schema_version: 2', 'schema_version: [2'))
    await focus()
    const brokenMs = await timed('Team to say its file needs fixing', async () => (await dialog.textContent()).includes('The team file needs fixing'), 15_000)
      .catch(() => null)
    await noButton(dialog, ['Check now'])
    writeFileSync(join(agentsDir, 'roster.md'), roster)
    await focus()
    const fixedMs = brokenMs === null ? null : await timed('Team to read the fixed file', async () => !(await dialog.textContent()).includes('The team file needs fixing'), 15_000)
    check('Team reads its file again when the window gets the focus, broken then fixed', brokenMs !== null && fixedMs !== null, { brokenMs, fixedMs })

    // ---- Backup: Export checks its copy at once ----------------------------------------------------------------
    phase('Backup')
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, backups)
    await go('Data')
    await noButton(dialog, ['Verify a backup…'])
    await dialog.getByRole('button', { name: 'Export backup…' }).click()
    const outcome = dialog.locator('.preferences-success, .preferences-error').last()
    await outcome.waitFor({ timeout: 30_000 })
    const said = ((await outcome.textContent()) ?? '').replace(/\s+/g, ' ')
    const written = readdirSync(backups)
    check('Export says at once that the copy checked out', /verified, \d+ files? checked/.test(said) && written.length === 1, { said, folders: written })

    report.reads = await reads()
  } finally {
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
})

const failed = report.checks.filter((entry) => entry.result === 'FAIL')
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(failed.length === 0 ? 'SELF-REFRESH LIVE: PASS' : `SELF-REFRESH LIVE: FAIL (${failed.map((entry) => entry.name).join('; ')})`)
process.exitCode = failed.length === 0 ? 0 : 1
