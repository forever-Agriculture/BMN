// MODULE: away-wake-live.mjs - Stories 90.6, 93.4 and 96.3 on the running build: real Claude Code and Codex sessions in a test-mode BMN, Away with the wake-up's 2 hours shortened; the line is typed once into each idle session and never into one with a draft, an open dialog, the owner's interrupt or a shell in front
// Each app gets its own BMN in test mode with temporary BMN data, config, state and runtime folders (removed at the end); the agents
// run on the tests' own home and profiles only (Epic 125 D2; start through scripts/test/native-test-home.mjs; nothing is copied
// or linked; a test-mode BMN installs no hooks, index.ts:641) and are typed into a
// shell in a scratch folder. Away and Back are said with the owner's CLI token over that BMN's socket. Evidence: BMN's app log
// (`away-wake.log` in its temporary state folder) and the agent's own transcript. Prints one JSON report.
// `claude-night` (Epic 111 F17-F19) replays the owner's night of 2026-11-06/07 in real Claude Code: a finished turn whose notice
// a look cleared, a compaction after a finished turn, and a turn a lost connection ended (a closed loopback port); each is woken once.
// Claude Code reports that error as StopFailure, which a profile gets from BMN's next hooks install; the run adds it with --settings.
// Usage: node scripts/test/away-wake-live.mjs <scratch-folder> [report.json] [claude,claude-night,codex] [--binary PATH]
// Every scenario ends by reading the night's account back after Back (`bmn away --night --json`, Story 113.6 AC4) and
// checks it against the wake's own log lines: woken where a line was typed, skipped or missed with the last reason, and
// no decided tick read as an unknown hour.
//   (needs `pnpm run build` first: the desktop build and @bmn/protocol's, whose reason codes the account check uses)
import { nativeTest } from './native-test-guard.mjs' // first: refuses his real home and profiles before anything else is evaluated
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { assertNativeTestEnvironment } from './native-test-home.mjs'
import { testedApp } from '../lib/tested-app.mjs'
import { AWAY_WAKE_REASONS, awayWakeReasonCode } from '../../shared/protocol/dist/away-night.js'
import { nightMismatches } from './away-night-check.mjs'
import { classifyMessageStartup, messageStartupStep, messageProcessIdentity } from './message-wake-startup.mjs'
import { visibleScreen } from './away-skills-startup.mjs'
import { processTree, stopTree } from './away-skills-processes.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const tested = testedApp(appDirectory)
const cli = tested.cliPath
const args = [...tested.rest]
const handoffAt = args.indexOf('--handoff')
const handoffPath = handoffAt < 0 ? null : resolve(args.splice(handoffAt, 2)[1])
const scratch = resolve(args[0] ?? '')
const EVERY_MS = 120_000
/** BMN sweeps every 30 s (companion-service.ts ATTENTION_SWEEP_MS), so a tick's record can land up to 30 s after the tick. */
const SETTLE_MS = 40_000
const WAKE = 'BMN wake-up (the owner is away; every 2 hours)'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shellQuote = value => "'"+String(value).replaceAll("'", "'\\''")+"'"
const phase = (label) => console.error(`[BMN away wake] ${label}`)
const report = { generatedAt: new Date().toISOString(), build: tested.build, commit: null, uncommitted: null, checks: [] }
const check = (name, ok, detail = {}) => {
  report.checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail })
  phase(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
  // Saved after every check, so a run stopped part-way keeps what it saw.
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
const reportPath = args[1] ? resolve(args[1]) : null
const recordProcess = (row, add) => {
  if (!handoffPath) return
  const before = readFileSync(handoffPath, 'utf8'), line = `- ${JSON.stringify(row)}\n`
  if (!before.includes('## Started\n')) throw new Error('Missing handoff process inventory')
  const after = add ? before.replace('## Started\n', `## Started\n\n${line}`) : before.replace(line, '')
  if (after.length > 9000) throw new Error('Handoff process inventory exceeds recovery bound')
  const temporary = `${handoffPath}.${process.pid}.new`
  writeFileSync(temporary, after); renameSync(temporary, handoffPath)
  if (readFileSync(handoffPath, 'utf8') !== after) throw new Error('Handoff inventory readback mismatch')
  execFileSync('python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'check', repoRoot])
}
try {
  report.commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // The source build runs the working tree: its uncommitted files are named, so a report never passes for a clean commit.
  report.uncommitted = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch { /* no git */ }
mkdirSync(scratch, { recursive: true })
const runtime = process.env.XDG_RUNTIME_DIR
const wayland = runtime && process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY) ? join(runtime, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
// The run's own roots are made below the tests' home (short name: a control socket's path has a length limit).
const runsFolder = join(nativeTest.home, 'r')
mkdirSync(runsFolder, { recursive: true, mode: 0o700 })
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
  // An isolated profile's records, when the caller set one (Story 110.1).
  walk(app === 'claude'
    ? join(nativeTest.claude, 'projects', scratch.replace(/[^A-Za-z0-9]/gu, '-'))
    : join(nativeTest.codex, 'sessions'))
  let count = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (app === 'codex' && !text.includes(scratch)) continue
    for (const line of text.split('\n')) {
      if (!line.includes(WAKE)) continue
      try {
        const entry = JSON.parse(line)
        // A compaction's summary is written as a user entry and may quote the line; it is no turn the agent received.
        const user = app === 'claude' ? entry.type === 'user' && entry.isCompactSummary !== true : entry.payload?.type === 'message' && entry.payload?.role === 'user'
        if (user) count += 1
      } catch { /* a partial line */ }
    }
  }
  return count
}


/**
 * The night's network (Epic 111 F17): a loopback CONNECT proxy Claude Code reaches its provider through. It relays the
 * encrypted tunnel only to Anthropic's and Claude's hosts, reads nothing inside it and records each host; `cut()` drops
 * every tunnel and refuses new ones, as a lost connection does, and `restore()` lets them through again.
 */
async function startNightProxy() {
  const hosts = new Map()
  const tunnels = new Set()
  let down = false
  const allowed = (host) => /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/u.test(host)
  const server = createServer((request, response) => { response.writeHead(403).end() })
  server.on('connect', (request, client, head) => {
    const [host, port] = String(request.url).split(':')
    hosts.set(host, (hosts.get(host) ?? 0) + 1)
    client.on('error', () => {})
    if (down || !allowed(host) || port !== '443') { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    const upstream = connectTcp(443, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
    upstream.on('error', () => client.destroy())
    tunnels.add(client); tunnels.add(upstream)
    const forget = () => { tunnels.delete(client); tunnels.delete(upstream) }
    client.on('close', forget); upstream.on('close', forget)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: server.address().port, hosts,
    cut: () => { down = true; for (const socket of tunnels) socket.destroy(); tunnels.clear() },
    restore: () => { down = false },
    // Closed without waiting: a tunnel Claude opened while the run ended would hold the close and the run's last await (run 4, exit 13).
    close: () => { down = true; for (const socket of tunnels) socket.destroy(); server.closeAllConnections(); server.close() }
  }
}

async function run(scenario) {
  const night = scenario === 'claude-night'
  const parked = night && args.includes('--parked')
  // The night's woken turns run on the profile's own model; four minutes let each end before the next step is arranged.
  const every = night ? 240_000 : EVERY_MS
  const app = night ? 'claude' : scenario
  const name = scenario
  const nightSettings = join(scratch, 'claude-night-settings.json')
  const proxy = night ? await startNightProxy() : null
  if (night) writeFileSync(nightSettings, `${JSON.stringify({ hooks: { StopFailure: [{ hooks: [{ type: 'command', command: 'bmn hook claude', timeout: 3600 }] }] } }, null, 2)}\n`)
  // Claude Code with his real profile installs itself into whatever XDG_DATA_HOME it sees and points his `claude` link there;
  // the run's data root is deleted at the end (Epic 111 F20): it starts with his own data folder and its updater off.
  const claudeData = process.env.XDG_DATA_HOME
  const through = proxy ? `HTTPS_PROXY='http://127.0.0.1:${proxy.port}' HTTP_PROXY='http://127.0.0.1:${proxy.port}' NO_PROXY='127.0.0.1,localhost' CLAUDE_CODE_MAX_RETRIES=2 ` : ''
  const command = app === 'claude' ? `env XDG_DATA_HOME='${claudeData}' DISABLE_AUTOUPDATER=1 ${through}claude --allowedTools 'Bash(sleep:*)'${parked ? " 'Bash(bmn grant report:*)'" : ''} --model haiku${night ? ` --settings '${nightSettings}'` : ''}` : `codex --no-alt-screen -c 'mcp_servers={}' -c 'projects."${scratch}".trust_level="trusted"' -c 'model_reasoning_effort="low"'`
  // Keep the same guarded test home and fit the Linux socket path, as the departure driver does.
  const contract = { ...temporaryRootContracts.electronDevelopment, prefix: 'd' }
  try { await withTemporaryRoot(contract, async ({ roots }) => {
    const environment = {
      ...caller, SHELL: '/bin/bash',
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_TEST_AWAY_WAKE_EVERY_MS: String(every), BMN_TEST_AWAY_WAKE_QUIET_MS: '5000',
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {})
    }
    // Epic 125.1 AC1: the run's roots are the ones this driver made, so they are checked again, as made, before anything starts.
    assertNativeTestEnvironment(environment)
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
    const identity = processTree(application.process().pid)[0]
    if (!identity) throw new Error('Isolated night application identity unavailable')
    const owned = { kind: 'process', pid: identity.pid, start_ticks: identity.start_ticks, command: `113.6 isolated ${name} test Electron`, evidence: reportPath }
    report[`${name}Process`] = owned
    try {
      recordProcess(owned, true)
      const page = await application.firstWindow()
      await page.waitForSelector('.session-row', { timeout: 60_000 })
      const input = page.locator('.session-terminal.selected .xterm-helper-textarea')
      // Codex reads an Enter that follows fast typing as a newline in a paste, so a typist's pause comes first.
      const type = async (text, enter = true) => { await input.focus(); await page.keyboard.type(text); if (enter) { await sleep(1_000); await page.keyboard.press('Enter') } }
      const screen = () => page.locator('.session-terminal.selected .xterm-rows').innerText()
      const sessionId = await page.locator('.session-terminal.selected').getAttribute('data-session-id')
      const nativeScreen = async () => visibleScreen(await page.evaluate(id => globalThis.__aitermTest.snapshot(id), sessionId)).join('\n')
      await sleep(3_000)
      if (parked) {
        const launcher = join(scratch, '.parked-native.sh')
        writeFileSync(launcher, `#!/bin/bash\ncd ${shellQuote(scratch)} || exit 1\nexec ${command}\n`, { mode: 0o700 })
        await type(shellQuote(launcher))
      } else await type(`cd '${scratch}' && ${command}`)
            const shown = [], startupHistory = [], startupUsed = { keys: 0 }
      const startupFrame = async () => {
        const text = await (parked ? nativeScreen() : screen()).catch(() => '')
        return { text, ...classifyMessageStartup(app, text.split('\n'), scratch) }
      }
      const atPrompt = async () => (await startupFrame()).state === 'composer'
      let promptReady = false
      for (let waited = 0; waited < 90_000 && !promptReady; waited += 1500) {
        const frame = await startupFrame()
        shown.push(frame.text.split('\n').slice(-6))
        if (frame.state === 'dialog') {
          report[`${name}StartScreens`] = shown
          throw new Error(`UNVERIFIED: ${name} startup: ${frame.detail ?? 'requires owner action'}; no dialog key sent`)
        }
        if (frame.state === 'composer') { promptReady = true; break }
        if (frame.state === 'trust' || frame.state === 'trust-negative') {
          startupHistory.push({ ...frame, at: Date.now() })
          const action = messageStartupStep(startupHistory, startupUsed)
          if (action.action === 'fail') throw new Error(`UNVERIFIED: ${action.reason}`)
          if (action.action === 'key') {
            if (parked && (await startupFrame()).state !== frame.state) continue
            await input.focus(); await page.keyboard.press(action.key)
            startupUsed.keys++; startupUsed[action.mark] = true
          }
        }
        await sleep(1500)
      }
      if (!promptReady) { report[`${name}StartScreens`] = shown; if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw new Error(`${name} showed no prompt within 90 s`) }
      const started = Date.now()
      report[`${name}StartScreens`] = shown
      report[`${name}ReadyScreen`] = (await screen()).split('\n').slice(-12)
      phase(`${name}: away`)
      bmn('away')
      const T = Date.now()
      await sleep(3_000)
      await type('Reply with the single word ok.')
      const ticks = (n) => logs().filter((line) => line.includes(`tick ${n})`))
      const state = {}
      // Each tick: arrange the session, wait until the 30 s sweep has certainly run, read BMN's app log and its snapshot.
      const tick = async (n, arrange, lead = 50_000) => {
        await sleep(Math.max(0, T + n * every - lead - Date.now()))
        if (arrange) await arrange()
        await sleep(Math.max(0, T + n * every + SETTLE_MS - Date.now()))
        state[`tick${n}`] = { logs: ticks(n), snapshot: (() => { try { return bmn('snapshot') } catch (error) { return String(error) } })(), screen: (await screen()).split('\n').slice(-8) }
        return ticks(n)
      }
      const skipped = (lines) => lines.length === 1 && lines[0].includes('skipped')
      const hookEvents = () => page.evaluate((id) => globalThis.aiTerminal.listHookEvents(id), sessionId)
      if (night) {
        const typedIn = (lines) => lines.filter((line) => line.includes('typed')).length === 1
        const cards = async () => (await page.evaluate(() => globalThis.aiTerminal.listAttention())).filter((row) => row.sessionId === sessionId)
          .map((row) => ({ key: row.requestKey, kind: row.kind, state: row.state, by: row.resolvedBy ?? null, resolution: row.resolution ?? null, title: row.title ?? null }))
        const idle = async () => { for (let waited = 0; waited < 90_000 && !(await atPrompt()); waited += 3_000) await sleep(3_000) }
        const latest = async () => (await hookEvents()).map((event) => ({ event: event.event, source: event.source ?? null })).slice(-4)
        // F19: his look at a session that finished clears its notice (main.tsx navigateAttention); the wake still comes.
        const one = await tick(1, async () => {
          await idle(); await page.locator('.session-row').first().click(); await sleep(3_000)
          state.afterLook = await cards()
        })
        check(`${name}: the look cleared the finished turn's notice ("Opened in BMN")`, (state.afterLook ?? []).some((row) => row.key === 'claude:turn' && row.state !== 'open' && /Opened in BMN/u.test(row.resolution ?? '')), { cards: state.afterLook })
        check(`${name}: tick 1 wakes the session whose notice a look cleared (F19)`, typedIn(one), { logs: one })
        // F18: a compaction after a finished turn reports SessionStart (source compact); the session still rests.
        const two = await tick(2, async () => {
          await idle(); await type('/compact'); await sleep(45_000)
          state.afterCompact = await latest()
        }, 150_000)
        check(`${name}: the compaction reported SessionStart from compact after the finished turn`, (state.afterCompact ?? []).some((event) => event.event === 'SessionStart' && event.source === 'compact'), { events: state.afterCompact })
        check(`${name}: tick 2 wakes the session after its compaction (F18)`, typedIn(two), { logs: two })
        // F17: a turn an API error ends (an unknown model) reports StopFailure and opens the notice; the wake still comes.
        const three = await tick(3, async () => {
          // A lost connection, as on his night (Pet-129): the running Claude Code's network is cut for its turn, then comes back
          // before the tick. Its provider stays the team's (a changed base URL is refused by BMN's provider check, run 2), and the
          // same Claude keeps running (a restart in the pane leaves the old prompt box on screen, which the wake rightly refuses, run 3).
          await idle(); proxy.cut()
          await type('Reply with the single word ok.'); await sleep(30_000)
          state.afterError = { events: await latest(), cards: await cards(), screen: (await screen()).split('\n').slice(-8) }
          proxy.restore()
        }, 150_000)
        check(`${name}: the API error ended the turn as StopFailure`, (state.afterError?.events ?? []).some((event) => event.event === 'StopFailure'), state.afterError)
        check(`${name}: the error opened the turn notice "stopped on an error"`, (state.afterError?.cards ?? []).some((row) => row.key === 'claude:turn' && /stopped on an error/u.test(row.title ?? '')), state.afterError)
        check(`${name}: tick 3 wakes the session an API error stopped (F17)`, typedIn(three), { logs: three })
        // The connection is back: the woken turn reaches the model and ends as a plain finished turn.
        for (let waited = 0; waited < 90_000 && !(await latest()).some((event, index, all) => index === all.length - 1 && event.event === 'Stop'); waited += 5_000) await sleep(5_000)
        state.afterWake = await latest()
        check(`${name}: the woken session reached its model again and finished its turn`, state.afterWake.at(-1)?.event === 'Stop' && state.afterWake.some((event) => event.event === 'UserPromptSubmit'), { events: state.afterWake })
        check(`${name}: the agent received the wake line only where a tick says it typed one`, wakesInTranscript(app, started) === logs().filter((line) => line.includes('typed the wake line')).length, { count: wakesInTranscript(app, started) })
        if (parked) {
          const sent = Date.now()
          await type('Synthetic test only. Run exactly: bmn grant report --run parked-fixture --stopped --cause access --text "Synthetic sign-in pending". Then finish this turn. Do not exit the session.')
          const deadline = Date.now() + 90_000
          for (;;) {
            if ((await hookEvents()).some(event => event.event === 'Stop' && Date.parse(event.observedAt) >= sent)) break
            if (Date.now() >= deadline) throw new Error('The parked fixture turn did not finish')
            await sleep(1000)
          }
        }
      } else {
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
        // Story 110.1 AC3: a question card opens while the turn runs, and stays open past the tick.
        const asking = app === 'claude' ? 'AskUserQuestion' : 'request_user_input'
        // Codex offers its blocking question only in Plan mode; Default has a non-blocking one that holds nothing open.
        const askedSince = Date.now()
        const four = await tick(4, async () => {
          if (app === 'codex') { await type('/plan'); await sleep(2_000) }
          await type(`Use your ${asking} tool to ask the owner one question: which colour, with the options Blue and Green. Then wait for the answer.`)
        })
        state.questionScreen = (await screen()).split('\n').slice(-14)
        // While he is away BMN refuses the app's blocking question, so the agent leaves its own `bmn ask` card and ends its turn.
        // That card does not hold the wake (his card, 2026-11-07, Epic 111 F19); the app's own open question does.
        const questions = (await page.evaluate(() => globalThis.aiTerminal.listAttention())).filter((row) => row.sessionId === sessionId && row.state === 'open' && row.kind === 'question')
        state.questionCards = questions.map((row) => ({ key: row.requestKey, openedBy: row.openedBy ?? null }))
        const ownOnly = questions.length > 0 && questions.every((row) => row.openedBy === 'cli')
        // The agent may also take the refusal and end its turn with no card of its own: then nothing is open, the session
        // rests and the wake is due. That reading needs the hook's own record that the app's question was called.
        const tickFourEvents = (await hookEvents()).filter((event) => Date.parse(event.observedAt) >= askedSince)
        state.questionEvents = tickFourEvents.map((event) => ({ event: event.event, source: event.source ?? null, toolName: event.toolName ?? null, effects: event.effects, observedAt: event.observedAt }))
        const called = tickFourEvents.some((event) => event.event === 'PreToolUse' && event.source !== 'subagent' && new RegExp(`(?:^|[.:/])${asking}(?:_async)?$`, 'u').test(event.toolName ?? ''))
        const refusedNoCard = questions.length === 0 && called && tickFourEvents.some((event) => event.event === 'Stop')
        if (questions.length === 0 && !refusedNoCard) check(`${app}: tick 4 has its question antecedent (the app's question was called)`, false, { logs: four, events: state.questionEvents, screen: state.questionScreen })
        else check(ownOnly ? `${app}: tick 4 wakes a session whose only open question is its own bmn ask card (F19)`
          : refusedNoCard ? `${app}: tick 4 wakes a session whose refused question left no card open`
            : `${app}: tick 4 skips a session with the app's question open`,
        ownOnly || refusedNoCard ? four.filter((line) => line.includes('typed')).length === 1 : skipped(four), { logs: four, cards: state.questionCards, events: state.questionEvents })
        await input.focus(); await page.keyboard.press('Escape'); await sleep(1_500); await page.keyboard.press('Control+U')
        // A stop: the owner's Escape during a long tool call, with the prompt empty afterwards.
        const five = await tick(5, async () => {
          const footer = async () => (await screen()).split('\n').filter(line => line.trim()).slice(-5).join('\n')
          const before = await footer()
          if (app === 'codex' && /Plan mode/u.test(before)) {
            // Codex 0.167 chatwidget/interaction.rs + settings.rs: Shift-Tab cycles Plan -> Default.
            await input.focus(); await page.keyboard.press('Shift+Tab')
            for (let waited = 0; waited < 5000 && /Plan mode/u.test(await footer()); waited += 250) await sleep(250)
            if (/Plan mode/u.test(await footer())) throw new Error('UNVERIFIED: Codex did not leave Plan mode before tick5')
          }
          const marker = join(scratch, `${name}-tick5-${Date.now()}.json`), program = marker+'.py'
          writeFileSync(program, `import json,os,time\nfrom pathlib import Path\np=Path(${JSON.stringify(marker)})\nidentity=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()[19]\ntemporary=Path(str(p)+'.new')\ntemporary.write_text(json.dumps({'pid':os.getpid(),'start_ticks':identity,'at':time.time()*1000}))\nos.replace(temporary,p)\ntime.sleep(300)\n`, { mode: 0o600 })
          const executionSince = Date.now()
          await type(`Run exactly this command in one foreground shell tool call, never in the background: python3 ${shellQuote(program)}`)
          let execution = null
          for (let waited = 0; waited < 60_000; waited += 250) {
            if (existsSync(marker)) {
              const observed = JSON.parse(readFileSync(marker, 'utf8'))
              const current = (await hookEvents()).at(-1)
              const resolved = messageProcessIdentity({ root: identity, marker: observed, argv: ['python3', program] })
              if (resolved.identity && current?.event === 'PreToolUse' && current.source !== 'subagent' && Date.parse(current.observedAt) >= executionSince) { execution = { ...observed, hostIdentity: resolved.identity, hook: current }; break }
            }
            await sleep(250)
          }
          if (!execution) throw new Error('UNVERIFIED: tick5 foreground command execution was not observed')
          state.tick5Execution = { marker, program, execution, modeBefore: before, modeAfter: await footer(), escapeAt: Date.now() }
          await input.focus(); await page.keyboard.press('Escape')
        })
        check(`${app}: tick 5 skips a session its owner stopped`, skipped(five) && five.every(line => Date.parse(line.slice(0, 24)) >= state.tick5Execution.escapeAt), { logs: five, execution: state.tick5Execution })
        await input.focus(); await page.keyboard.press('Control+U')
        // Typing starts at the check: a finished turn, then keys from a second before the sweep the first tick's log line predicts.
        const firstTyped = logs().find((line) => line.includes('typed the wake line'))
        const sweepAt = firstTyped ? Date.parse(firstTyped.slice(0, 24)) : T + EVERY_MS
        let keysAt = null
        const six = await tick(6, async () => {
          await type('Reply with the single word ok.')
          await sleep(15_000)
          const boundary = T + 6 * EVERY_MS
          const sweep = sweepAt + Math.ceil((boundary - sweepAt) / 30_000) * 30_000
          await sleep(Math.max(0, sweep - 1_000 - Date.now()))
          keysAt = new Date().toISOString()
          await input.focus()
          for (let key = 0; key < 14; key += 1) { await page.keyboard.type('x'); await sleep(150) }
        })
        const typedScreen = (await screen()).split('\n').slice(-8)
        // Either order is safe only if nothing was typed over the keys: a line typed after a key reached the prompt would stand in it.
        check(`${app}: tick 6 types nothing over keys that start at the check`, !six.some((line) => line.includes('typed')) || wakesInTranscript(app, started) === 2 && !typedScreen.join('\n').includes('xBMN'), { logs: six, keysAt, typedScreen })
        await input.focus(); await page.keyboard.press('Control+U'); await sleep(500)
        const seven = await tick(7, () => type(app === 'claude' ? '/exit' : '/quit'), 60_000)
        check(`${app}: tick 7 skips a session with a shell in front`, seven.length <= 1 && !seven.some((line) => line.includes('typed')), { logs: seven })
        check(`${app}: the agent received the wake line only where a tick says it typed one`, wakesInTranscript(app, started) === logs().filter((line) => line.includes('typed the wake line')).length, { count: wakesInTranscript(app, started) })
      }
      report[`${name}State`] = state
      bmn('back')
      report[`${name}Logs`] = logs()
      // Story 113.6 AC4: the account BMN keeps of this night, read back as an agent reads it, matches the log of its ticks.
      let account = null
      try { account = JSON.parse(bmn('away', '--night', '--json')) } catch (error) { report[`${name}NightError`] = String(error).slice(0, 400) }
      report[`${name}Night`] = account
      const mismatches = account === null ? null : nightMismatches(account, report[`${name}Logs`], awayWakeReasonCode, AWAY_WAKE_REASONS)
      check(`${name}: the night's account read back after Back matches the wake log (113.6)`, mismatches !== null && mismatches.length === 0 &&
        account.woken.length === report[`${name}Logs`].filter((line) => line.includes('typed the wake line')).map((line) => line.split(' into ')[1]?.split(' ')[0]).filter((id, index, all) => all.indexOf(id) === index).length,
      { mismatches, woken: account?.woken.length ?? null, unknownSpans: account?.unknownSpans ?? null })
      if (parked) {
        const row = account && [...account.woken, ...account.skipped, ...account.missed, ...account.unknown].find(item => item.sessionId === sessionId)
        check('131.6: the parked native run has observed rest and a separate cause report in the CLI',
          Number.isFinite(row?.restedMs) && row.restedMs >= 0 && row.restedFrom &&
          row.stopReport?.runId === 'parked-fixture' && row.stopReport.cause === 'access',
        { restedMs: row?.restedMs ?? null, cause: row?.stopReport?.cause ?? null })
      }
    } finally {
      const current = processTree(identity.pid)
      const identities = current[0]?.start_ticks === identity.start_ticks ? current : [identity]
      const inventory = handoffPath ? spawnSync('python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'leftovers', repoRoot], { encoding: 'utf8' }) : null
      await Promise.race([application.close().catch(() => {}), sleep(15_000)])
      // PID reuse cannot redirect cleanup to another application or one of the owner's sessions.
      const stopped = await stopTree(identities, { graceMs: 1000, afterKillMs: 1500, wait: sleep })
      report[`${name}Cleanup`] = { inventory: inventory && { status: inventory.status, stdout: inventory.stdout, stderr: inventory.stderr }, ...stopped }
      check(`${name}: owned process cleanup`, stopped.remaining.length === 0, { remaining: stopped.remaining, killed: stopped.killed })
      if (stopped.remaining.length === 0) recordProcess(owned, false)
    }
  }, runsFolder) } finally { if (proxy) { report[`${name}ProxyHosts`] = Object.fromEntries(proxy.hosts); proxy.close() } }
}

if (args.includes('--departure')) {
  const { departureLive } = await import('./departure-live.mjs')
  process.exit(await departureLive({ tested, args, recordProcess, caller }))
}

for (const app of (args[2] ?? 'claude,codex').split(',')) {
  // OpenCode was retired (Epic 123); its two scenarios are kept at the git tag opencode-support-final.
  if (!['claude', 'claude-night', 'codex'].includes(app)) { check(`${app}: run completed`, false, { error: 'no such scenario' }); continue }
  try { await run(app) } catch (error) { check(`${app}: run completed`, false, { error: String(error).slice(0, 400) }) }
}
const failed = report.checks.filter((entry) => entry.result !== 'PASS')
report.result = failed.length === 0 ? 'PASS' : 'FAIL'
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.name) }))
process.exit(failed.length === 0 ? 0 : 1)
