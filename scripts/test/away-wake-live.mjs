// MODULE: away-wake-live.mjs - Stories 90.6, 93.4 and 96.3 on the running build: real Claude Code, Codex and pinned OpenCode sessions in a test-mode BMN, Away with the wake-up's 2 hours shortened; the line is typed once into each idle session and never into one with a draft, an open dialog, the owner's interrupt or a shell in front
// Each app gets its own BMN in test mode with temporary BMN data, config, state and runtime folders (removed at the end); the agents
// run on the tests' own home and profiles only (Epic 125 D2; start through scripts/test/native-test-home.mjs; nothing is copied
// or linked; a test-mode BMN installs no hooks, index.ts:641) and are typed into a
// shell in a scratch folder. Away and Back are said with the owner's CLI token over that BMN's socket. Evidence: BMN's app log
// (`away-wake.log` in its temporary state folder) and the agent's own transcript. Prints one JSON report.
// OpenCode (Epic 93) runs once per `--opencode PATH`, a pinned 2.0.29 or 2.0.32 binary, in a disposable profile under the scratch
// folder whose plugin the tested BMN's own `bmn hooks install` writes, against a loopback stand-in model with synthetic replies:
// no account and no external or paid call. Its evidence is what the stand-in was asked.
// `opencode-upgrade` (Story 96.3) starts the same OpenCode on BMN's October 14 plugin, read from this repository's history:
// its stop is left alone, BMN's start-up install upgrades the file while that OpenCode still runs and the earlier stop
// stays alone, the finished turn of the plugin OpenCode 2.0.29 reloads by itself is woken once, a turn after the copy of
// the October 14 file is put back (a rollback) is left alone, and after the next start-up install and a restart one
// finished turn (with three tool calls) is woken once while the owner's stop and quitting are not.
// `claude-night` (Epic 111 F17-F19) replays the owner's night of 2026-11-06/07 in real Claude Code: a finished turn whose notice
// a look cleared, a compaction after a finished turn, and a turn a lost connection ended (a closed loopback port); each is woken once.
// Claude Code reports that error as StopFailure, which a profile gets from BMN's next hooks install; the run adds it with --settings.
// Usage: node scripts/test/away-wake-live.mjs <scratch-folder> [report.json] [claude,claude-night,codex,opencode,opencode-upgrade] [--opencode PATH]... [--binary PATH]
// Every scenario ends by reading the night's account back after Back (`bmn away --night --json`, Story 113.6 AC4) and
// checks it against the wake's own log lines: woken where a line was typed, skipped or missed with the last reason, and
// no decided tick read as an unknown hour.
//   (needs `pnpm run build` first: the desktop build and @bmn/protocol's, whose reason codes the account check uses)
import { nativeTest } from './native-test-guard.mjs' // first: refuses his real home and profiles before anything else is evaluated
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
import { processTree, stopTree } from './away-skills-processes.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const cli = join(appDirectory, 'bin/bmn')
const tested = testedApp(appDirectory)
const args = [...tested.rest]
const handoffAt = args.indexOf('--handoff')
const handoffPath = handoffAt < 0 ? null : resolve(args.splice(handoffAt, 2)[1])
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

/** BMN's OpenCode plugin text as a commit of this repository shipped it, its template literal evaluated (Story 96.3). */
function shippedPlugin(commit, file) {
  const source = execFileSync('git', ['-C', repoRoot, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const declaration = 'const OPENCODE_PLUGIN = `'
  let body = ''
  for (let at = source.indexOf(declaration) + declaration.length; at < source.length; at += 1) {
    if (source[at] === '\\') { body += source[at] + source[at + 1]; at += 1; continue }
    if (source[at] === '`') return new Function(`return \`${body}\``)()
    body += source[at]
  }
  throw new Error(`no OPENCODE_PLUGIN at ${commit}`)
}
/** The plugin OpenCode still loaded on the owner's computer on 2026-10-26, and its SHA-256 (EARLIER_OPENCODE_PLUGINS). */
const OCTOBER_14 = { commit: '033eb7d88f', file: 'apps/desktop/bin/bmn', sha256: '4cebff68da6edb803b706447ca3ce2de3f5976f6c0db466d1b6cee8db0d99fde' }

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

/**
 * OpenCode's model for the run: a loopback Chat Completions stand-in that records each prompt and answers "ok". A prompt
 * with SYNTHETIC-HOLD is held until OpenCode drops it (the owner's interrupt), one with SYNTHETIC-SLOW is answered after
 * 4 s (time to leave a draft or a dialog behind while it works), one with SYNTHETIC-TOOL calls the read tool on the
 * profile's README three times before it answers (Story 96.3: tool events and the repeat watch). Any other route or a
 * tunnel is recorded and fails the run.
 */
async function startStandIn(readme = () => '') {
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
      const lastUser = messages.findLastIndex((message) => message.role === 'user')
      const toolResults = messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length
      requests.push({ at: Date.now(), agent, user: user.slice(0, 400), ...(toolResults > 0 ? { toolResults } : {}) })
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
      if (agent && user.includes('SYNTHETIC-TOOL') && toolResults < 3) {
        send({ tool_calls: [{ index: 0, id: `call_synthetic_${requests.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: readme() }) } }] })
        send({}, 'tool_calls')
        response.end('data: [DONE]\n\n')
        return
      }
      setTimeout(finish, agent && user.includes('SYNTHETIC-SLOW') ? 4_000 : 0)
    })
  })
  server.on('connect', (request, socket) => { refused.push(`CONNECT ${request.url}`); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { port: server.address().port, requests, refused, close: () => { server.closeAllConnections(); return new Promise((done) => server.close(done)) } }
}

/**
 * A fresh OpenCode profile under the scratch folder for one pinned binary, and the script the session's shell runs to start
 * it. With `earlier`, the profile holds BMN's October 14 plugin and its cli.json entry, and the script installs nothing.
 */
function openCodeProfile(binary, port, earlier = false) {
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
    agents: { 'bmn-probe': { mode: 'primary', system: 'Synthetic fixture', model: 'fixture/synthetic',
      permissions: [{ action: '*', resource: '*', effect: 'deny' }, ...(earlier ? [{ action: 'read', resource: '*', effect: 'allow' }] : [])] } },
    default_agent: 'bmn-probe'
  }, null, 2)}\n`)
  const proxy = `http://127.0.0.1:${port}`
  const exports = {
    HOME: join(profile, 'home'), XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'), XDG_STATE_HOME: join(profile, 'state'),
    XDG_CACHE_HOME: join(profile, 'cache'), OPENCODE_CONFIG_DIR: join(profile, 'config/opencode'), OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', SYNTHETIC_API_KEY: 'synthetic-only', HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'
  }
  const plugin = join(profile, 'config/opencode/bmn/tui.ts')
  if (earlier) {
    const text = shippedPlugin(OCTOBER_14.commit, OCTOBER_14.file)
    if (createHash('sha256').update(text).digest('hex') !== OCTOBER_14.sha256) throw new Error('the October 14 plugin read back with other bytes')
    mkdirSync(dirname(plugin), { mode: 0o700 })
    writeFileSync(plugin, text, { mode: 0o600 })
    writeFileSync(join(profile, 'config/opencode/cli.json'), `${JSON.stringify({ plugins: [dirname(plugin)] }, null, 2)}\n`, { mode: 0o600 })
  }
  // The session's own `bmn` is the tested build's, so the plugin OpenCode loads is the one that build installs.
  writeFileSync(join(profile, 'start.sh'), [
    `# MODULE: start.sh - starts one pinned OpenCode in its disposable profile, ${earlier ? 'on the plugin already there' : 'with the tested BMN\'s plugin installed'}`,
    `cd '${join(profile, 'work')}' || exit 1`,
    ...Object.entries(exports).map(([name, value]) => `export ${name}='${value}'`),
    ...(earlier ? [] : [`bmn hooks install --yes opencode > '${join(profile, 'install.txt')}' 2>&1 || exit 1`]),
    `exec '${binary}' --standalone`, ''
  ].join('\n'))
  return { version, profile, plugin, exports, readme: join(profile, 'work/README.md') }
}

async function run(scenario, binary) {
  const upgrade = scenario === 'opencode-upgrade'
  const night = scenario === 'claude-night'
  // The night's woken turns run on the profile's own model; four minutes let each end before the next step is arranged.
  const every = night ? 240_000 : EVERY_MS
  const app = upgrade ? 'opencode' : night ? 'claude' : scenario
  let readme = ''
  const standIn = app === 'opencode' ? await startStandIn(() => readme) : null
  const openCode = standIn ? openCodeProfile(binary, standIn.port, upgrade) : null
  if (openCode) readme = openCode.readme
  const name = openCode ? `opencode${upgrade ? '-upgrade' : ''} ${openCode.version}` : scenario
  const nightSettings = join(scratch, 'claude-night-settings.json')
  const proxy = night ? await startNightProxy() : null
  if (night) writeFileSync(nightSettings, `${JSON.stringify({ hooks: { StopFailure: [{ hooks: [{ type: 'command', command: 'bmn hook claude', timeout: 3600 }] }] } }, null, 2)}\n`)
  if (openCode) report[`${scenario}-${openCode.version}`] = { binary, profile: openCode.profile }
  // Claude Code with his real profile installs itself into whatever XDG_DATA_HOME it sees and points his `claude` link there;
  // the run's data root is deleted at the end (Epic 111 F20): it starts with his own data folder and its updater off.
  const claudeData = process.env.XDG_DATA_HOME
  const through = proxy ? `HTTPS_PROXY='http://127.0.0.1:${proxy.port}' HTTP_PROXY='http://127.0.0.1:${proxy.port}' NO_PROXY='127.0.0.1,localhost' CLAUDE_CODE_MAX_RETRIES=2 ` : ''
  const command = app === 'claude' ? `env XDG_DATA_HOME='${claudeData}' DISABLE_AUTOUPDATER=1 ${through}claude --allowedTools 'Bash(sleep:*)' --model haiku${night ? ` --settings '${nightSettings}'` : ''}` : app === 'codex' ? `codex --no-alt-screen -c 'mcp_servers={}' -c 'projects."${scratch}".trust_level="trusted"' -c 'model_reasoning_effort="low"'`
    : `bash '${join(openCode.profile, 'start.sh')}'`
  try { await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ roots }) => {
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
      await sleep(3_000)
      await type(`cd '${scratch}' && ${command}`)
      const ready = app === 'claude' ? /^❯/mu : app === 'codex' ? /^›/mu : /Ask anything/u
      const shown = [], startupHistory = [], startupUsed = { keys: 0 }
      const startupFrame = async () => {
        const text = await screen().catch(() => '')
        if (app === 'claude' || app === 'codex') return { text, ...classifyMessageStartup(app, text.split('\n'), scratch) }
        if (/Hooks need review|permission|authenticat|sign in|log in|onboarding|Update available|Choose the text style|Press Enter to continue/iu.test(text)) return { text, state: 'dialog' }
        return { text, state: ready.test(text) ? 'composer' : 'loading' }
      }
      const atPrompt = async () => (await startupFrame()).state === 'composer'
      let promptReady = false
      for (let waited = 0; waited < 90_000 && !promptReady; waited += 1500) {
        const frame = await startupFrame()
        shown.push(frame.text.split('\n').slice(-6))
        if (frame.state === 'dialog') {
          report[`${name}StartScreens`] = shown
          throw new Error(`UNVERIFIED: ${name} requires owner startup/permission action; zero keys sent`)
        }
        if (frame.state === 'composer') { promptReady = true; break }
        if (frame.state === 'trust' || frame.state === 'trust-negative') {
          startupHistory.push({ ...frame, at: Date.now() })
          const action = messageStartupStep(startupHistory, startupUsed)
          if (action.action === 'fail') throw new Error(`UNVERIFIED: ${action.reason}`)
          if (action.action === 'key') {
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
      const sessionId = await page.locator('.session-terminal.selected').getAttribute('data-session-id')
      const hookEvents = () => page.evaluate((id) => globalThis.aiTerminal.listHookEvents(id), sessionId)
      if (upgrade) {
        const wakes = () => standIn.requests.filter((request) => request.agent && request.user === `${WAKE_LINE} `).length
        const because = (lines, reason) => skipped(lines) && lines[0].endsWith(`: ${reason}`)
        const earlier = 'its OpenCode runs an earlier BMN plugin, which reports the owner\'s stop as a finished turn'
        const stop = async () => {
          await type('Wait for me. SYNTHETIC-HOLD'); await sleep(3_000)
          await input.focus(); await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape')
        }
        const quit = async () => { await input.focus(); await page.keyboard.press('Control+X'); await sleep(300); await page.keyboard.press('q') }
        // The fixture's agent, which the stand-in answers as one: run 2 (evidence 96.3) once found OpenCode's own Build agent
        // selected after a restart that followed two reloads. Tab moves to the next primary agent; the report says if it was needed.
        // xterm's DOM rows draw a blank cell as a no-break space, so the composer's name row is read with plain spaces.
        const fixtureAgent = async () => {
          const shown = async () => (await screen().catch(() => '')).replace(/\u00a0/gu, ' ').split('\n').find((line) => /^ {2}┃ {2}\S.* · /u.test(line)) ?? ''
          const first = await shown()
          for (let turn = 0; turn < 4 && !/┃ {2}Bmn-Probe · /u.test(await shown()); turn += 1) { await input.focus(); await page.keyboard.press('Tab'); await sleep(700) }
          return { first: first.trim(), now: (await shown()).trim() }
        }
        const exits = async () => (await hookEvents()).filter((event) => event.event === 'tui.exit').length
        // The owner's stop, reported by the October 14 plugin as a plain finished turn.
        const one = await tick(1, stop)
        const oldIdle = (await hookEvents()).filter((event) => event.event === 'session.idle').at(-1)
        check(`${name}: the October 14 plugin reports the owner's stop as a plain session.idle`, oldIdle !== undefined && oldIdle.source === null, { latest: oldIdle })
        check(`${name}: tick 1 leaves the stop of a session running the earlier plugin alone`, because(one, earlier), { logs: one })
        // BMN's start-up install, while that OpenCode still runs with the old plugin loaded.
        const exitsBefore = await exits()
        const print = execFileSync(process.execPath, [cli, 'hooks', 'print', 'opencode'], { encoding: 'utf8', env: environment })
        let upgraded
        try {
          upgraded = JSON.parse(execFileSync(process.execPath, [cli, 'hooks', 'install', 'opencode', '--absent', '--yes', '--file', openCode.plugin, '--json'],
            { encoding: 'utf8', env: { ...environment, ...openCode.exports } })).agents[0]
        } catch (error) { upgraded = { error: String(error).slice(0, 400) } }
        const copy = (upgraded.backups ?? [])[0]
        const copied = copy ? createHash('sha256').update(readFileSync(copy)).digest('hex') : null
        check(`${name}: the start-up install upgrades the October 14 plugin byte for byte, with a copy, while OpenCode runs`,
          upgraded.state === 'installed' && (upgraded.upgraded ?? []).join() === 'plugin' && copied === OCTOBER_14.sha256 && readFileSync(openCode.plugin, 'utf8') === print,
          { report: upgraded, copied })
        // The owner's stop from before the upgrade stays a stop: the file on disk is now BMN's current plugin, and OpenCode
        // 2.0.29 reloads a changed plugin file by itself, but neither speaks for the turn the earlier plugin reported.
        const two = await tick(2, async () => undefined)
        check(`${name}: tick 2 leaves the owner's earlier stop alone after the upgrade`, skipped(two), { logs: two })
        // The October 14 plugin says nothing as it unloads, so OpenCode's reload of the upgraded file withdraws nothing of BMN's.
        check(`${name}: OpenCode's reload of the upgraded file reached BMN as no quit`, await exits() === exitsBefore, { exits: await exits() })
        // A turn after OpenCode's own reload carries the current plugin's mark: the line is typed once, without a restart.
        const three = await tick(3, () => type('Reply with the single word ok.'))
        check(`${name}: tick 3 types the line once into the root whose OpenCode reloaded the upgraded plugin by itself`, three.filter((line) => line.includes('typed')).length === 1, { logs: three })
        check(`${name}: OpenCode submitted the whole line once, as its own prompt`, wakes() === 1, { wakes: wakes() })
        // A rollback: the owner puts the copy of the October 14 file back; OpenCode reloads it and its turns are unmarked again.
        let exitsAtRollback = null
        const four = await tick(4, async () => {
          exitsAtRollback = await exits()
          if (copy) copyFileSync(copy, openCode.plugin)
          await sleep(3_000)
          await type('Reply with the single word ok.')
        })
        check(`${name}: tick 4 leaves alone a finished turn once the October 14 copy is put back`,
          createHash('sha256').update(readFileSync(openCode.plugin)).digest('hex') === OCTOBER_14.sha256 && because(four, earlier), { logs: four })
        // Known limit (docs/agent-control.md): the current plugin reports its own unloading as tui.exit, so a reload that replaces
        // it reaches BMN as a quit followed by the next plugin's events. It withdraws that session's open requests; the wake stays safe.
        check(`${name}: replacing the current plugin while OpenCode runs reaches BMN as one tui.exit, then the next plugin's events`,
          await exits() === (exitsAtRollback ?? 0) + 1 && (await hookEvents()).at(-1)?.event !== 'tui.exit', { exits: await exits() })
        // BMN's next start upgrades the rolled-back file again; quit and start OpenCode again in the same terminal.
        let again
        const five = await tick(5, async () => {
          try {
            again = JSON.parse(execFileSync(process.execPath, [cli, 'hooks', 'install', 'opencode', '--absent', '--yes', '--file', openCode.plugin, '--json'],
              { encoding: 'utf8', env: { ...environment, ...openCode.exports } })).agents[0]
          } catch (error) { again = { error: String(error).slice(0, 400) } }
          // OpenCode reloads the rewritten file by itself; quitting waits until that has settled.
          await sleep(5_000)
          await quit(); await sleep(5_000)
          await type(`bash '${join(openCode.profile, 'start.sh')}'`)
          for (let waited = 0; waited < 60_000 && !/Ask anything/u.test(await screen().catch(() => '')); waited += 2_000) await sleep(2_000)
          report[`${name}AgentAfterRestart`] = await fixtureAgent()
          await type('Read the README three times. SYNTHETIC-TOOL')
        }, 100_000)
        const secondCopy = (again?.backups ?? [])[0]
        check(`${name}: the next start-up install upgrades the rolled-back file again, with a new copy`,
          again?.state === 'installed' && (again.upgraded ?? []).join() === 'plugin' && secondCopy !== copy &&
          (secondCopy ? createHash('sha256').update(readFileSync(secondCopy)).digest('hex') : null) === OCTOBER_14.sha256 && readFileSync(openCode.plugin, 'utf8') === print,
          { report: again })
        check(`${name}: tick 5 types the line once into the root restarted on the upgraded plugin`, five.filter((line) => line.includes('typed')).length === 1, { logs: five })
        check(`${name}: OpenCode submitted the second line whole too`, wakes() === 2, { wakes: wakes() })
        const tools = (await hookEvents()).filter((event) => event.event === 'tool.execute.after')
        check(`${name}: the upgraded plugin's three identical tool calls reach the repeat watch`, tools.length >= 3 && tools.slice(-3).map((event) => event.repeat).join() === '1,2,3',
          { tools: tools.map((event) => ({ toolName: event.toolName, repeat: event.repeat })) })
        const six = await tick(6, stop)
        check(`${name}: tick 6 leaves the owner's stop alone on the upgraded plugin`,
          because(six, 'its latest event is session.idle from interrupted, not its own finished turn'), { logs: six })
        const seven = await tick(7, quit, 60_000)
        check(`${name}: tick 7 skips the session once OpenCode quit and a shell is in front`, because(seven, 'its latest event is tui.exit, not a finished turn'), { logs: seven })
        const last = (await hookEvents()).at(-1)
        check(`${name}: quitting reached BMN as tui.exit`, last?.event === 'tui.exit', { last })
        check(`${name}: OpenCode received the wake line only at ticks 3 and 5`, wakes() === 2, { wakes: wakes() })
        check(`${name}: OpenCode reached nothing but the stand-in model`, standIn.refused.length === 0, { refused: standIn.refused })
        report[`${name}Asked`] = standIn.requests
        report[`${name}HookEvents`] = await hookEvents()
      } else if (standIn) {
        // OpenCode submits a summarized paste (the line passes 150 characters) whole, with one space after it, as Story 93.1
        // recorded for every paste on both pins; anything else (cut, doubled, not submitted) does not count.
        const wakes = () => standIn.requests.filter((request) => request.agent && request.user === `${WAKE_LINE} `).length
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
      } else if (night) {
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
  }, runsFolder) } finally { await standIn?.close(); if (proxy) { report[`${name}ProxyHosts`] = Object.fromEntries(proxy.hosts); proxy.close() } }
}

for (const app of (args[2] ?? 'claude,codex').split(',')) {
  if (app.startsWith('opencode') && openCodeBinaries.length === 0) check(`${app}: run completed`, false, { error: 'no --opencode binary given' })
  for (const binary of app.startsWith('opencode') ? openCodeBinaries : [undefined]) {
    try { await run(app, binary) } catch (error) { check(`${app}${binary ? ` ${binary}` : ''}: run completed`, false, { error: String(error).slice(0, 400) }) }
  }
}
const failed = report.checks.filter((entry) => entry.result !== 'PASS')
report.result = failed.length === 0 ? 'PASS' : 'FAIL'
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ result: report.result, failed: failed.map((entry) => entry.name) }))
process.exit(failed.length === 0 ? 0 : 1)
