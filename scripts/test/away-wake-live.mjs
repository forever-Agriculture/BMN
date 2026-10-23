// MODULE: away-wake-live.mjs - Story 90.6 on the running build: a real Claude Code and a real Codex session in a test-mode BMN, Away with the wake-up's 2 hours shortened; the line is typed once into each idle session and never into one with a draft, an open dialog or a shell in front
// Each app gets its own BMN in test mode with temporary BMN data, config, state and runtime folders (removed at the end); the agents
// keep their own sign-ins where they are (nothing is copied; a test-mode BMN installs no hooks, index.ts:641) and are typed into a
// shell in a scratch folder. Away and Back are said with the owner's CLI token over that BMN's socket. Evidence: BMN's app log
// (`away-wake.log` in its temporary state folder) and the agent's own transcript. Prints one JSON report.
// Usage: node scripts/test/away-wake-live.mjs <scratch-folder> [report.json] [claude,codex]   (needs `pnpm --filter @bmn/desktop build` first)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { testedApp } from '../lib/tested-app.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const tested = testedApp(appDirectory)
const scratch = resolve(tested.rest[0] ?? '')
const EVERY_MS = 120_000
/** BMN sweeps every 30 s (companion-service.ts ATTENTION_SWEEP_MS), so a tick's record can land up to 30 s after the tick. */
const SETTLE_MS = 40_000
const WAKE = 'BMN wake-up (the owner is away; every 2 hours)'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const phase = (label) => console.error(`[BMN away wake] ${label}`)
const report = { generatedAt: new Date().toISOString(), build: tested.build, commit: null, uncommitted: null, checks: [] }
const check = (name, ok, detail = {}) => {
  report.checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail })
  phase(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
  // Saved after every check, so a run stopped part-way keeps what it saw.
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
const reportPath = tested.rest[1] ? resolve(tested.rest[1]) : null
try {
  report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // The source build runs the working tree: its uncommitted files are named, so a report never passes for a clean commit.
  report.uncommitted = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch { /* no git */ }
mkdirSync(scratch, { recursive: true })
const runtime = process.env.XDG_RUNTIME_DIR
const wayland = runtime && process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY) ? join(runtime, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
const caller = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND' && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))
// Another BMN's own folder on the inherited PATH (the packaged one, when this runs inside a BMN session) holds a second
// `codex` wrapper; each wrapper skips only its own folder, so the two would hand Codex to each other forever.
const otherBmn = (folder) => { try { return readFileSync(join(folder, 'codex'), 'utf8').includes("Keep Codex's hooks in this BMN session") } catch { return false } }
caller.PATH = (process.env.PATH ?? '').split(':').filter((folder) => folder && !otherBmn(folder)).join(':')

/** How many user turns in the agent's own newest transcript for this folder carry the wake line. */
function wakesInTranscript(app, since) {
  const files = []
  const walk = (folder) => { for (const name of (() => { try { return readdirSync(folder) } catch { return [] } })()) {
    const path = join(folder, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else if (name.endsWith('.jsonl') && stat.mtimeMs >= since) files.push(path)
  } }
  walk(app === 'claude' ? join(homedir(), '.claude/projects', scratch.replace(/[^A-Za-z0-9]/gu, '-')) : join(homedir(), '.codex/sessions'))
  let count = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (app === 'codex' && !text.includes(scratch)) continue
    for (const line of text.split('\n')) {
      if (!line.includes(WAKE)) continue
      try {
        const entry = JSON.parse(line)
        const user = app === 'claude' ? entry.type === 'user' : entry.payload?.type === 'message' && entry.payload?.role === 'user'
        if (user) count += 1
      } catch { /* a partial line */ }
    }
  }
  return count
}

async function run(app) {
  const command = app === 'claude' ? 'claude' : `codex -c 'projects."${scratch}".trust_level="trusted"' -c 'model_reasoning_effort="low"'`
  await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ roots }) => {
    const environment = {
      ...caller, SHELL: '/bin/bash',
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_TEST_AWAY_WAKE_EVERY_MS: String(EVERY_MS), BMN_TEST_AWAY_WAKE_QUIET_MS: '5000',
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {})
    }
    const socket = join(roots.runtime, 'bmn/control/control.sock')
    const bmn = (...argv) => execFileSync(process.execPath, [cli, '--owner', '--socket', socket, ...argv], { encoding: 'utf8', env: environment, cwd: scratch })
    const logFile = () => {
      const found = []
      const walk = (folder) => { for (const name of (() => { try { return readdirSync(folder) } catch { return [] } })()) {
        const path = join(folder, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name === 'away-wake.log') found.push(path)
      } }
      walk(roots.state)
      return found
    }
    const logs = () => logFile().flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean))
    const application = await electron.launch({ executablePath: tested.executablePath, args: [...tested.appArgs, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'], cwd: scratch, env: environment })
    try {
      const page = await application.firstWindow()
      await page.waitForSelector('.session-row', { timeout: 60_000 })
      const input = page.locator('.session-terminal.selected .xterm-helper-textarea')
      // Codex reads an Enter that follows fast typing as a newline in a paste, so a typist's pause comes first.
      const type = async (text, enter = true) => { await input.focus(); await page.keyboard.type(text); if (enter) { await sleep(1_000); await page.keyboard.press('Enter') } }
      const screen = () => page.locator('.session-terminal.selected .xterm-rows').innerText()
      await sleep(3_000)
      await type(`cd '${scratch}' && ${command}`)
      const ready = app === 'claude' ? /^❯/mu : /^›/mu
      const shown = []
      for (let waited = 0; waited < 90_000 && !ready.test(await screen().catch(() => '')); waited += 5_000) {
        if (/trust/iu.test(await screen())) { await input.focus(); await page.keyboard.press('Enter') }
        shown.push((await screen()).split('\n').slice(-6))
        await sleep(5_000)
      }
      if (!ready.test(await screen())) { report[`${app}StartScreens`] = shown; if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw new Error(`${app} showed no prompt within 90 s`) }
      const started = Date.now()
      phase(`${app}: away`)
      bmn('away')
      const T = Date.now()
      await sleep(3_000)
      await type('Reply with the single word ok.')
      const ticks = (n) => logs().filter((line) => line.includes(`tick ${n})`))
      const state = {}
      // Each tick: arrange the session, wait until the 30 s sweep has certainly run, read BMN's app log and its snapshot.
      const tick = async (n, arrange, lead = 50_000) => {
        await sleep(Math.max(0, T + n * EVERY_MS - lead - Date.now()))
        if (arrange) await arrange()
        await sleep(Math.max(0, T + n * EVERY_MS + SETTLE_MS - Date.now()))
        state[`tick${n}`] = { logs: ticks(n), snapshot: (() => { try { return bmn('snapshot') } catch (error) { return String(error) } })(), screen: (await screen()).split('\n').slice(-8) }
        return ticks(n)
      }
      const skipped = (lines) => lines.length === 1 && lines[0].includes('skipped')
      const one = await tick(1)
      check(`${app}: tick 1 types the line once into the idle session`, one.filter((line) => line.includes('typed')).length === 1, { logs: one })
      check(`${app}: the agent received the wake line once`, wakesInTranscript(app, started) === 1, { count: wakesInTranscript(app, started) })
      // Typing into an idle session answers its turn notice (the owner is there), so the draft is typed ahead while the
      // agent still works, as it would be left by someone who then goes away; the turn ends after it.
      const two = await tick(2, async () => { await type('Reply with the single word ok.'); await sleep(300); await type('draft text', false) })
      check(`${app}: tick 2 skips a session with draft text`, skipped(two), { logs: two })
      await input.focus(); await page.keyboard.press('Control+U')
      const three = await tick(3, () => type('/model'))
      check(`${app}: tick 3 skips a session with an open dialog (/model)`, skipped(three), { logs: three })
      await input.focus(); await page.keyboard.press('Escape')
      const four = await tick(4, () => type(app === 'claude' ? '/exit' : '/quit'), 60_000)
      check(`${app}: tick 4 skips a session with a shell in front`, four.length <= 1 && !four.some((line) => line.includes('typed')), { logs: four })
      check(`${app}: the agent received the wake line only once overall`, wakesInTranscript(app, started) === 1, { count: wakesInTranscript(app, started) })
      report[`${app}State`] = state
      bmn('back')
      report[`${app}Logs`] = logs()
    } finally {
      // A close that hangs (seen once with a shell left in front) must not hold the run: give it 15 s, then end that Electron.
      const closed = await Promise.race([application.close().then(() => true, () => true), sleep(15_000).then(() => false)])
      if (!closed) application.process().kill('SIGKILL')
    }
  })
}

for (const app of (tested.rest[2] ?? 'claude,codex').split(',')) {
  try { await run(app) } catch (error) { check(`${app}: run completed`, false, { error: String(error).slice(0, 400) }) }
}
const failed = report.checks.filter((entry) => entry.result !== 'PASS')
report.result = failed.length === 0 ? 'PASS' : 'FAIL'
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.name) }))
process.exit(failed.length === 0 ? 0 : 1)
