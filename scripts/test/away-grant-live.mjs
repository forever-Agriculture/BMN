/* global document, getComputedStyle */
// MODULE: away-grant-live.mjs - Story 84.3 on the running build: a departure said with `bmn away --leaving`, two runs' cards and one "needs nothing", the gold count in the head, Before you go at both widths, an answer with the keyboard, a re-ask while open, and Not leaving withdrawing the rest
// The app runs in test mode with a temporary HOME and XDG folders (removed at the end) and stand-in `claude`, `codex` and
// `opencode` programs. The cards are asked with the owner's CLI token over the app's own socket; no agent runs, nothing leaves
// the machine, Telegram is off and no file of the owner's is read. Prints one JSON report, PASS or FAIL per check.
// Usage: node scripts/test/away-grant-live.mjs [report.json] [shots-folder]   (needs `pnpm --filter @bmn/desktop build` first)
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { testedApp } from '../lib/tested-app.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const tested = testedApp(appDirectory)
console.log(`BMN build: ${tested.build}`)
const reportPath = tested.rest[0] ? resolve(tested.rest[0]) : null
const shots = tested.rest[1] ? resolve(tested.rest[1]) : null
const phase = (label) => console.error(`[BMN away grant] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay
const callerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND' && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))

const report = { generatedAt: new Date().toISOString(), build: tested.build, commit: null, uncommitted: null, checks: [] }
const check = (name, ok, detail = {}) => {
  const result = ok === null ? 'UNVERIFIED' : ok ? 'PASS' : 'FAIL'
  report.checks.push({ name, result, ...detail })
  phase(`${result} ${name} ${JSON.stringify(detail)}`)
}
try {
  report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // The source build runs the working tree: its uncommitted files are named, so a report never passes for a clean commit.
  report.uncommitted = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch { /* no git */ }
if (shots) mkdirSync(shots, { recursive: true })

async function until(probe, what, timeout = 20_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

const TERMS = [
  { kind: 'rounds', proposed: 3, reason: '80.3\'s review took two rounds last night; two boundaries are ahead.' },
  { kind: 'merge', id: 'merge-12', repository: 'octo-probe/widgets', pr: 12, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'Its required checks were green at 22:20.' },
  { kind: 'push-default', id: 'push-81', repository: 'octo-probe/tools', branch: 'dev-auto/epic-81', proposed: 'yes', reason: '81.1 changes the tools\' SKILL.md, and tools takes no PRs.' }
]

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const stubs = join(root, 'stubs')
  const folder = join(root, 'widgets')
  for (const one of [home, stubs, folder]) mkdirSync(one, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.bashrc'), `export PATH="${stubs}:$PATH"\n`)
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  stub('claude', 'case "$1" in --version) echo "2.1.302 (Claude Code)";; *) exit 1;; esac')
  stub('codex', 'case "$1" in --version) echo "codex-cli 0.162.1";; *) exit 4;; esac')
  stub('opencode', 'case "$1" in --version) echo "2.0.29";; *) exit 1;; esac')
  const socket = join(roots.runtime, 'bmn/control/control.sock')
  const environment = {
    ...callerEnvironment, HOME: home, SHELL: '/bin/bash', PATH: `${stubs}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
    BMN_LAUNCH_CWD: folder,
    ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
  }
  const bmn = (args, input) => {
    // `bmn grant`, like `bmn policy`, takes its credentials after the command.
    const argv = args[0] === 'grant' ? [...args, '--owner', '--socket', socket] : ['--owner', '--socket', socket, ...args]
    try {
      return execFileSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env: { ...environment, PATH: `${stubs}:${process.env.PATH}` }, cwd: root, ...(input === undefined ? {} : { input }) })
    } catch (error) { return `exit ${error.status}: ${error.stderr}` }
  }
  const ask = (runId, title, terms, scope = 'Stories 80.2–80.6, then Epic 81') =>
    bmn(['grant', 'ask', '--run', runId, '--card-file', '-'], JSON.stringify({ title, scope, terms }))
  const application = await electron.launch({
    executablePath: tested.executablePath,
    args: [...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: environment
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(20_000)
  const resize = (width) => application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.show(); window.setContentSize(size, 860) }, width)
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
  const head = page.locator('.away-check button.away-grant')
  const dialog = page.locator('dialog.before-you-go-dialog')
  try {
    await page.waitForSelector('.session-row')
    await resize(1280)

    phase('leaving')
    const leaving = bmn(['away', '--leaving'])
    await until(async () => (await head.count()) > 0 && (await head.innerText()) === 'leaving', 'the head says leaving')
    const box = await page.locator('#away-check-box').getAttribute('aria-label')
    check('`bmn away --leaving` starts a departure: the head says "leaving" as a muted text button, the Away box stays unchecked (AC1, the notes §2)',
      leaving.startsWith('Leaving since ') && !(await head.getAttribute('class')).includes('cards') && box === 'Away; check it when you go'
        && !(await page.locator('#away-check-box').isChecked()), { leaving: leaving.trim(), box })
    await shot('head-leaving-1280.png')

    phase('cards')
    const first = ask('run-80', 'Epic 80 · clean up ai slop', TERMS)
    const second = ask('run-81', 'Epic 81 · harness doctor', [TERMS[0]], 'Story 81.2')
    const nothing = bmn(['grant', 'ask', '--run', 'run-79', '--nothing', '--title', 'Epic 79 · first-run setup'])
    await until(async () => (await head.innerText()) === '2 cards', 'the gold count')
    const gold = await head.evaluate((element) => ({ color: getComputedStyle(element).color, weight: getComputedStyle(element).fontWeight, identity: getComputedStyle(document.documentElement).getPropertyValue('--identity').trim() }))
    check('two cards make a gold "2 cards" beside the Away check, weight 600; a run that needs nothing adds none (AC1, owner card recommendations 2 and 4)',
      first.startsWith('Card revision 1 for run run-80 is open') && second.startsWith('Card revision 1 for run run-81') && nothing.startsWith('Recorded: run run-79 needs nothing')
        && gold.weight === '600' && (await head.getAttribute('class')).includes('cards'), { first: first.trim(), nothing: nothing.trim(), gold })

    phase('Before you go at 1280')
    await head.click()
    await dialog.waitFor()
    const headLine = await dialog.locator('.grant-head-line').innerText()
    const cards = await dialog.locator('article.grant-card.request').count()
    const focused = await page.evaluate(() => ({ text: document.activeElement?.textContent, role: document.activeElement?.getAttribute('role'), checked: document.activeElement?.getAttribute('aria-checked') }))
    const needs = await dialog.locator('.grant-nothing').innerText()
    check('Before you go lists both open cards oldest first and the run that needs nothing; focus starts on the first term at its proposal, never on No or Grant (the notes §2–§3)',
      headLine.startsWith('Leaving since ') && cards === 2 && needs === 'Epic 79 · first-run setup needs nothing.' && focused.role === 'radio' && focused.checked === 'true' && focused.text === '3',
      { headLine, cards, needs, focused })
    const rule = await dialog.locator('article.grant-card.request').first().locator('.grant-rule').count()
    const button = await dialog.locator('article.grant-card.request').first().locator('.actions button.primary').innerText()
    check('the three-term card carries the rule line and "Grant all" at its proposals', rule === 1 && button === 'Grant all', { rule, button })
    await shot('before-you-go-1280.png')

    phase('Before you go at 540')
    await resize(540)
    await sleep(300)
    const overflow = await dialog.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    const stacked = await dialog.locator('.grant-term').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    check('at 540 px the dialog fits without sideways scrolling and each choice sits on its own line under its label (the notes §3)', overflow.scroll <= overflow.client + 1 && stacked === 1, { overflow, stacked })
    await shot('before-you-go-540.png')
    await resize(1280)
    await sleep(300)

    phase('answer with the keyboard')
    const firstCard = dialog.locator('article.grant-card.request').first()
    await firstCard.locator('.segmented').nth(1).locator('[role="radio"]', { hasText: /^No$/ }).click()
    const words = await firstCard.locator('.actions button.primary').innerText()
    await firstCard.locator('.actions button.primary').click()
    await until(async () => (await dialog.locator('article.grant-card.request').count()) === 1, 'the first card answered')
    const answered = await dialog.locator('article.grant-card.cleared .grant-answered').allInnerTexts()
    const next = await page.evaluate(() => document.activeElement?.closest('article')?.getAttribute('data-run-id'))
    const status = bmn(['grant', '--run', 'run-80'])
    check('dropping one term reads "Grant 2 of 3"; the answer is stored, says what it granted, and focus moves to the next open card (AC2, the notes §1g, §3)',
      words === 'Grant 2 of 3' && answered.some((line) => line.startsWith('Granted here at ') && line.includes('3 rounds per boundary · push to the default branch in tools'))
        && answered.some((line) => line === 'Not granted: merge PR 12 at 3f2a9c1') && next === 'run-81'
        && status.includes('Grant for run run-80') && status.includes('Not granted: item merge-12'), { words, answered, next, status: status.trim() })
    await shot('before-you-go-answered-1280.png')

    phase('a re-ask while open')
    const again = ask('run-81', 'Epic 81 · harness doctor', [{ ...TERMS[0], proposed: 4 }], 'Story 81.2')
    await until(async () => (await dialog.locator('article.grant-card.request[data-card-revision="2"]').count()) === 1, 'revision 2 drawn')
    const seen = await dialog.locator('article.grant-card.request .seen').first().innerText()
    check('a second ask for the same run replaces the open card with a new revision that says what changed (AC1)',
      again.includes('Card revision 2 for run run-81 replaces the earlier one') && seen.includes('changed: rounds 3 → 4'), { again: again.trim(), seen })

    phase('not leaving')
    await dialog.locator('.grant-footer button', { hasText: 'Not leaving' }).click()
    await until(async () => (await head.count()) === 0, 'the head back to plain Away')
    const after = bmn(['grant'])
    const ended = bmn(['grant', '--run', 'run-80'])
    check('Not leaving withdraws the open card, ends the departure, and every grant with it (AC1, AC4)',
      after.startsWith('No departure') && ended.startsWith('No grant for run run-80'), { after: after.trim(), ended: ended.trim() })
  } catch (error) {
    check('the run completed', false, { error: error instanceof Error ? error.message : String(error) })
    await shot('failure.png').catch(() => undefined)
  } finally {
    await Promise.race([application.close().catch(() => undefined), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})

const failed = report.checks.filter((entry) => entry.result === 'FAIL')
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(failed.length === 0 ? 'AWAY GRANT LIVE: PASS' : `AWAY GRANT LIVE: FAIL (${failed.map((entry) => entry.name).join('; ')})`)
process.exitCode = failed.length === 0 ? 0 : 1
