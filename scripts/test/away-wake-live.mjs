// MODULE: away-wake-live.mjs - Stories 90.6 and 93.4 on the running build: real Claude Code, Codex and pinned OpenCode sessions in a test-mode BMN, Away with the wake-up's 2 hours shortened; the line is typed once into each idle session and never into one with a draft, an open dialog, the owner's interrupt or a shell in front
// Each app gets its own BMN in test mode with temporary BMN data, config, state and runtime folders (removed at the end); the agents
// keep their own sign-ins where they are (nothing is copied; a test-mode BMN installs no hooks, index.ts:641) and are typed into a
// shell in a scratch folder. Away and Back are said with the owner's CLI token over that BMN's socket. Evidence: BMN's app log
// (`away-wake.log` in its temporary state folder) and the agent's own transcript. Prints one JSON report.
// OpenCode (Epic 93) runs once per `--opencode PATH`, a pinned 2.0.29 or 2.0.32 binary, in a disposable profile under the scratch
// folder whose plugin the tested BMN's own `bmn hooks install` writes, against a loopback stand-in model with synthetic replies:
// no account and no external or paid call. Its evidence is what the stand-in was asked.
// Usage: node scripts/test/away-wake-live.mjs <scratch-folder> [report.json] [claude,codex,opencode] [--opencode PATH]... [--binary PATH]
//   (needs `pnpm --filter @bmn/desktop build` first)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
const args = [...tested.rest]
const openCodeBinaries = []
for (let at = args.indexOf('--opencode'); at >= 0; at = args.indexOf('--opencode')) openCodeBinaries.push(resolve(args.splice(at, 2)[1] ?? ''))
const scratch = resolve(args[0] ?? '')
const EVERY_MS = 120_000
/** BMN sweeps every 30 s (companion-service.ts ATTENTION_SWEEP_MS), so a tick's record can land up to 30 s after the tick. */
const SETTLE_MS = 40_000
const WAKE = 'BMN wake-up (the owner is away; every 2 hours)'
/** The whole line, read from the product, so the stand-in can tell an exact submission from a cut or doubled one. */
const WAKE_LINE = readFileSync(join(appDirectory, 'src/utility/away-wake.ts'), 'utf8').match(/AWAY_WAKE_LINE = '([^']+)'/u)[1]
/** The OpenCode builds Epic 93 measured (SHA256 as Epic 85 recorded them); any other binary is refused. */
const OPENCODE_PINS = {
  '7e23471f4ebe2313d78baacc9ac96fe9e197ce26d808de4b0fcc37efbe473dad': '2.0.29',
  '489b51816a77809e841310e80c88e834c28c19ad1639e12ba8a19f08b47ab607': '2.0.32'
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const phase = (label) => console.error(`[BMN away wake] ${label}`)
const report = { generatedAt: new Date().toISOString(), build: tested.build, commit: null, uncommitted: null, checks: [] }
const check = (name, ok, detail = {}) => {
  report.checks.push({ name, result: ok ? 'PASS' : 'FAIL', ...detail })
  phase(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
  // Saved after every check, so a run stopped part-way keeps what it saw.
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
const reportPath = args[1] ? resolve(args[1]) : null
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

/**
 * OpenCode's model for the run: a loopback Chat Completions stand-in that records each prompt and answers "ok". A prompt
 * with SYNTHETIC-HOLD is held until OpenCode drops it (the owner's interrupt), one with SYNTHETIC-SLOW is answered after
 * 4 s (time to leave a draft or a dialog behind while it works). Any other route or a tunnel is recorded and fails the run.
 */
async function startStandIn() {
  const requests = []
  const refused = []
  const text = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : ''
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk; if (body.length > 1_048_576) request.destroy() })
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { refused.push(String(request.url)); response.writeHead(403).end(); return }
      let data
      try { data = JSON.parse(body) } catch { refused.push('invalid JSON'); response.writeHead(400).end(); return }
      const messages = Array.isArray(data.messages) ? data.messages : []
      // The fixture agent's own turns; OpenCode's title requests carry another system prompt.
      const agent = messages[0]?.role === 'system' && text(messages[0].content).startsWith('Synthetic fixture')
      const user = text(messages.filter((message) => message.role === 'user').at(-1)?.content)
      requests.push({ at: Date.now(), agent, user: user.slice(0, 400) })
      const base = { id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: data.model }
      const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      send({ role: 'assistant', content: '' })
      const finish = () => {
        if (response.writableEnded || response.destroyed) return
        send({ content: agent ? 'ok' : 'Synthetic title' })
        send({}, 'stop')
        response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      }
      if (agent && user.includes('SYNTHETIC-HOLD')) return
      setTimeout(finish, agent && user.includes('SYNTHETIC-SLOW') ? 4_000 : 0)
    })
  })
  server.on('connect', (request, socket) => { refused.push(`CONNECT ${request.url}`); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, requests, refused, close: () => { server.closeAllConnections(); return new Promise((done) => server.close(done)) } }
}

/** A fresh OpenCode profile under the scratch folder for one pinned binary, and the script the session's shell runs to start it. */
function openCodeProfile(binary, port) {
  const version = OPENCODE_PINS[createHash('sha256').update(readFileSync(binary)).digest('hex')]
  if (!version) throw new Error(`${binary} is not a pinned OpenCode build`)
  const profile = join(scratch, `opencode-${version}-${Date.now()}`)
  for (const name of ['home', 'config/opencode', 'data', 'state', 'cache', 'work']) mkdirSync(join(profile, name), { recursive: true, mode: 0o700 })
  // Its own repository, so OpenCode never takes the folder around the scratch folder (this checkout, say) for its project.
  execFileSync('/usr/bin/git', ['init', '--quiet', '--template=', '-b', 'master', join(profile, 'work')], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  writeFileSync(join(profile, 'work/README.md'), 'Synthetic OpenCode Away wake check only.\n')
  const model = { name: 'Synthetic', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32768, output: 8192 } }
  writeFileSync(join(profile, 'config/opencode/opencode.json'), `${JSON.stringify({
    update: 'disable', model: 'fixture/synthetic',
    providers: { fixture: { name: 'Synthetic loopback', package: '@opencode/ai/providers/openai-compatible', env: ['SYNTHETIC_API_KEY'],
      settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { synthetic: model } } },
    agents: { 'bmn-probe': { mode: 'primary', system: 'Synthetic fixture', permissions: [{ action: '*', resource: '*', effect: 'deny' }], model: 'fixture/synthetic' } },
    default_agent: 'bmn-probe'
  }, null, 2)}\n`)
  const proxy = `http://127.0.0.1:${port}`
  const exports = {
    HOME: join(profile, 'home'), XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'), XDG_STATE_HOME: join(profile, 'state'),
    XDG_CACHE_HOME: join(profile, 'cache'), OPENCODE_CONFIG_DIR: join(profile, 'config/opencode'), OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', SYNTHETIC_API_KEY: 'synthetic-only', HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'
  }
  // The session's own `bmn` is the tested build's, so the plugin OpenCode loads is the one that build installs.
  writeFileSync(join(profile, 'start.sh'), [
    '# MODULE: start.sh - starts one pinned OpenCode in its disposable profile, with the tested BMN\'s plugin installed',
    `cd '${join(profile, 'work')}' || exit 1`,
    ...Object.entries(exports).map(([name, value]) => `export ${name}='${value}'`),
    `bmn hooks install --yes opencode > '${join(profile, 'install.txt')}' 2>&1 || exit 1`,
    `exec '${binary}' --standalone`, ''
  ].join('\n'))
  return { version, profile }
}

async function run(app, binary) {
  const standIn = app === 'opencode' ? await startStandIn() : null
  const openCode = standIn ? openCodeProfile(binary, standIn.port) : null
  const name = openCode ? `opencode ${openCode.version}` : app
  if (openCode) report[`${app}-${openCode.version}`] = { binary, profile: openCode.profile }
  const command = app === 'claude' ? 'claude' : app === 'codex' ? `codex -c 'projects."${scratch}".trust_level="trusted"' -c 'model_reasoning_effort="low"'`
    : `bash '${join(openCode.profile, 'start.sh')}'`
  try { await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ roots }) => {
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
      const ready = app === 'claude' ? /^❯/mu : app === 'codex' ? /^›/mu : /Ask anything/u
      const shown = []
      for (let waited = 0; waited < 90_000 && !ready.test(await screen().catch(() => '')); waited += 5_000) {
        if (/trust/iu.test(await screen())) { await input.focus(); await page.keyboard.press('Enter') }
        shown.push((await screen()).split('\n').slice(-6))
        await sleep(5_000)
      }
      if (!ready.test(await screen())) { report[`${name}StartScreens`] = shown; if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw new Error(`${name} showed no prompt within 90 s`) }
      const started = Date.now()
      phase(`${name}: away`)
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
      if (standIn) {
        const wakes = () => standIn.requests.filter((request) => request.agent && request.user === WAKE_LINE).length
        const because = (lines, reason) => skipped(lines) && lines[0].endsWith(`: ${reason}`)
        const one = await tick(1)
        check(`${name}: tick 1 types the line once into the idle root`, one.filter((line) => line.includes('typed')).length === 1, { logs: one })
        check(`${name}: OpenCode submitted the whole line once, as its own prompt`, wakes() === 1,
          { wakes: wakes(), asked: standIn.requests.filter((request) => request.agent).map((request) => request.user.slice(0, 80)) })
        // Each refusal is left behind while a slow turn still works, so the turn ends with it on screen.
        const slow = 'Reply with the single word ok. SYNTHETIC-SLOW'
        const two = await tick(2, async () => { await type(slow); await sleep(1_000); await type('draft text', false) })
        check(`${name}: tick 2 skips a root with draft text`, because(two, 'its prompt is not empty and idle'), { logs: two })
        const three = await tick(3, async () => {
          await input.focus(); await page.keyboard.press('Control+C'); await sleep(500)
          await type(slow); await sleep(1_000); await input.focus(); await page.keyboard.press('Control+P')
        })
        check(`${name}: tick 3 skips a root with the command palette open`, because(three, 'its prompt is not empty and idle'), { logs: three })
        await input.focus(); await page.keyboard.press('Escape')
        // OpenCode 2 interrupts a run on Escape pressed twice; the stand-in holds this turn until then.
        const four = await tick(4, async () => {
          await type('Wait for me. SYNTHETIC-HOLD'); await sleep(3_000)
          await input.focus(); await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape')
        })
        check(`${name}: tick 4 skips a root the owner interrupted, its prompt empty`,
          because(four, 'its latest event is session.idle from interrupted, not its own finished turn'), { logs: four })
        // <leader>q quits (leader Ctrl+X); OpenCode waits for BMN's plugin, which reports tui.exit.
        const five = await tick(5, async () => { await input.focus(); await page.keyboard.press('Control+X'); await sleep(300); await page.keyboard.press('q') }, 60_000)
        check(`${name}: tick 5 skips the session once OpenCode quit and a shell is in front`, because(five, 'its latest event is tui.exit, not a finished turn'), { logs: five })
        check(`${name}: OpenCode received the wake line only once overall`, wakes() === 1, { wakes: wakes() })
        check(`${name}: OpenCode reached nothing but the stand-in model`, standIn.refused.length === 0, { refused: standIn.refused })
        report[`${name}Asked`] = standIn.requests
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
        const four = await tick(4, () => type(app === 'claude' ? '/exit' : '/quit'), 60_000)
        check(`${app}: tick 4 skips a session with a shell in front`, four.length <= 1 && !four.some((line) => line.includes('typed')), { logs: four })
        check(`${app}: the agent received the wake line only once overall`, wakesInTranscript(app, started) === 1, { count: wakesInTranscript(app, started) })
      }
      report[`${name}State`] = state
      bmn('back')
      report[`${name}Logs`] = logs()
    } finally {
      // A close that hangs (seen once with a shell left in front) must not hold the run: give it 15 s, then end that Electron.
      const closed = await Promise.race([application.close().then(() => true, () => true), sleep(15_000).then(() => false)])
      if (!closed) application.process().kill('SIGKILL')
    }
  }) } finally { await standIn?.close() }
}

for (const app of (args[2] ?? 'claude,codex').split(',')) {
  if (app === 'opencode' && openCodeBinaries.length === 0) check('opencode: run completed', false, { error: 'no --opencode binary given' })
  for (const binary of app === 'opencode' ? openCodeBinaries : [undefined]) {
    try { await run(app, binary) } catch (error) { check(`${app}${binary ? ` ${binary}` : ''}: run completed`, false, { error: String(error).slice(0, 400) }) }
  }
}
const failed = report.checks.filter((entry) => entry.result !== 'PASS')
report.result = failed.length === 0 ? 'PASS' : 'FAIL'
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.name) }))
process.exit(failed.length === 0 ? 0 : 1)
