// MODULE: windows-self-test-diagnostic.mjs - observation-only native runs that locate where the packaged --self-test stops
// The installed smoke and a 120 s run of `BMN.exe --self-test` printed nothing:
// stderr 0 bytes even with Chromium logging, stdout one CRLF, no phase markers
// (runs 37296438394, 37299667758). Each run here attaches the Node inspector
// early, without waiting for Electron readiness, and records whether main is
// ready and responsive, what it is doing, and whether a stderr sentinel written
// through the inspector reaches the pipe. The runs adapt: a minimal-environment
// self-test first and a short control in the smoke profile's old layout, whose
// LOCALAPPDATA was the BMN data root; then a full-environment self-test and a
// minimal-environment normal start only while the first run stays silent. All
// runs use the same flags. It never changes the gate's result.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

const RUN_BUDGET_MS = 80000

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function inspectorUrl(port, until, exited) {
  while (Date.now() < until && !exited()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      const target = (await response.json()).find(entry => entry.webSocketDebuggerUrl)
      if (target) return target.webSocketDebuggerUrl
    } catch { /* Not listening yet. */ }
    await delay(250)
  }
  return null
}

/** A bounded DevTools protocol client; every call resolves, with `timedOut` when main does not answer. */
function connect(url) {
  return new Promise(resolve => {
    const socket = new WebSocket(url), pending = new Map(), listeners = new Map()
    let next = 0
    const opening = setTimeout(() => { try { socket.close() } catch { /* Reported unavailable. */ } resolve(null) }, 5000)
    socket.onerror = () => { clearTimeout(opening); resolve(null) }
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data))
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
      else listeners.get(message.method)?.(message.params)
    }
    socket.onopen = () => {
      clearTimeout(opening)
      resolve({
        send: (method, params = {}, timeoutMs = 5000) => new Promise(done => {
          const id = ++next
          const timer = setTimeout(() => { pending.delete(id); done({ timedOut: true }) }, timeoutMs)
          pending.set(id, message => { clearTimeout(timer); done(message) })
          socket.send(JSON.stringify({ id, method, params }))
        }),
        once: (method, timeoutMs) => new Promise(done => {
          const timer = setTimeout(() => { listeners.delete(method); done(null) }, timeoutMs)
          listeners.set(method, params => { clearTimeout(timer); listeners.delete(method); done(params) })
        }),
        close: () => { try { socket.close() } catch { /* Already closed. */ } }
      })
    }
  })
}

// Runs in the main process. URLs are reduced to their scheme; no paths or page content leave it.
const probeExpression = sentinel => `(() => {
  const load = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)
  const { app, BrowserWindow, webContents } = load('electron')
  process.stderr.write(${JSON.stringify(`${sentinel}\n`)})
  return JSON.stringify({ ready: app.isReady(), uptimeMs: Math.round(process.uptime() * 1000),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), loading: window.webContents.isLoading(),
      crashed: window.webContents.isCrashed(), scheme: window.webContents.getURL().split(':')[0] })),
    webContents: webContents.getAllWebContents().length, processTypes: app.getAppMetrics().map(metric => metric.type),
    handles: process._getActiveHandles().map(handle => handle?.constructor?.name ?? typeof handle).slice(0, 40),
    requests: process._getActiveRequests().length })
})()`

async function sample(client, sentinel) {
  const answer = await client.send('Runtime.evaluate', { expression: probeExpression(sentinel), includeCommandLineAPI: true, returnByValue: true }, 5000)
  if (answer.timedOut) return { responsive: false }
  if (answer.result?.exceptionDetails) return { responsive: true, error: String(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text).slice(0, 300) }
  try { return { responsive: true, sentinelWritten: true, ...JSON.parse(answer.result.result.value) } } catch { return { responsive: true, error: 'unreadable probe result' } }
}

/** The JavaScript main is executing when paused; an idle main pauses only when it next runs JS. */
const answered = response => response.timedOut ? 'timed-out' : response.error ? `error ${response.error.code ?? 'unknown'}` : 'ok'

async function stack(client) {
  const enable = answered(await client.send('Debugger.enable', {}, 5000))
  const paused = client.once('Debugger.paused', 5000)
  const pause = answered(await client.send('Debugger.pause', {}, 5000))
  const state = await paused
  if (!state) return { paused: false, enable, pause }
  const frames = state.callFrames.slice(0, 12).map(frame => ({ functionName: frame.functionName || '(anonymous)',
    script: String(frame.url).split(/[\\/]/u).at(-1).slice(0, 80), line: frame.location.lineNumber + 1 }))
  await client.send('Debugger.resume', {}, 5000)
  return { paused: true, enable, pause, reason: state.reason, frames }
}

// eslint-disable-next-line no-control-regex
const printable = (text, limit) => text.slice(-limit).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')

function fileState(path) {
  if (!existsSync(path)) return { state: 'missing' }
  const bytes = statSync(path).size
  return bytes === 0 ? { state: 'empty' } : { state: 'written', bytes, tail: printable(readFileSync(path, 'utf8'), 3000) }
}

async function observeRun(binary, { name, environment, selfTest, budgetMs = RUN_BUDGET_MS }) {
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-self-test-diagnostic-'))
  const profile = join(temporary, 'profile'), started = Date.now(), sentinel = `[BMN diagnostic sentinel ${randomUUID()}]`
  try {
    ensurePrivateDirectories([profile])
    const minimal = windowsInstallerSmokeEnvironment(profile)
    // The old layout is the installed smoke's former profile, whose LOCALAPPDATA was the BMN data root.
    const base = environment === 'full' ? { ...process.env, ...minimal }
      : environment === 'old-layout' ? { ...minimal, LOCALAPPDATA: minimal.BMN_DATA_HOME } : minimal
    delete base.ELECTRON_RUN_AS_NODE
    const chromiumLog = join(profile, 'chromium.log')
    const env = { ...base, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: chromiumLog }
    const port = await freePort()
    const child = spawn(binary, [`--inspect=127.0.0.1:${port}`, ...(selfTest ? ['--self-test'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    let exitedAt = null
    const exited = new Promise(resolve => {
      child.once('error', error => { exitedAt = Date.now(); resolve({ spawnError: error.code ?? 'unknown' }) })
      child.once('exit', (code, signal) => { exitedAt = Date.now(); resolve({ code, signal }) })
    })
    const deadline = started + budgetMs
    const url = await inspectorUrl(port, Math.min(deadline, started + 20000), () => exitedAt !== null)
    const inspector = { listening: url !== null, listeningAfterMs: url ? Date.now() - started : null, samples: [], stack: null }
    // Node holds an exiting process while a debugger is attached, so each look attaches briefly.
    const look = async read => {
      const client = await connect(url)
      if (!client) return { attached: false }
      try { return await read(client) } finally { client.close() }
    }
    if (url) {
      for (const at of [15000, 55000].filter(at => at < budgetMs - 10000)) {
        while (exitedAt === null && Date.now() < started + at) await delay(250)
        if (exitedAt !== null) break
        inspector.samples.push({ atMs: Date.now() - started, ...(await look(client => sample(client, sentinel))) })
      }
      if (exitedAt === null) inspector.stack = await look(stack)
    }
    while (exitedAt === null && Date.now() < deadline - 5000) await delay(250)
    let outcome
    if (exitedAt === null) { child.kill(); outcome = { ...(await exited), stoppedAfterMs: Date.now() - started } }
    else outcome = await exited
    await delay(500)
    const markers = [...stderr.matchAll(/\[BMN\] self-test phase: ([^\r\n]*)/gu)].map(match => match[1])
    // Startup markers only instrument the run; the self-test's own phases show it progressed.
    const startup = markers.filter(marker => marker.startsWith('startup ')), phases = markers.filter(marker => !marker.startsWith('startup '))
    const acknowledged = inspector.samples.some(entry => entry.sentinelWritten)
    return { name, environment, selfTest, budgetMs, durationMs: Date.now() - started, outcome, inspector,
      environmentNames: Object.keys(env).sort(), startupMarkers: startup.slice(0, 100), phases: phases.slice(0, 300),
      stderrTransport: { debuggerBanner: stderr.includes('Debugger listening on'), sentinelAcknowledged: acknowledged,
        sentinelReceived: stderr.includes(sentinel) },
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), phaseCount: phases.length, lastPhase: phases.at(-1) ?? null,
      failure: /\[BMN\] session self-test failed: ([^\r\n]*)/u.exec(stderr)?.[1] ?? null,
      receipt: stdout.split(/\r?\n/u).some(line => line.includes('"selfTest":"session-roundtrip"')),
      chromiumLog: fileState(chromiumLog),
      stdoutTail: printable(stdout, 1000), stderrTail: printable(stderr.replaceAll(sentinel, '[sentinel]'), 4000) }
  } catch (error) {
    return { name, environment, selfTest, unavailable: true, error: String(error?.message ?? error).slice(0, 500) }
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* A stopped run can still hold files; the runner image is discarded. */ }
  }
}

const privateDirectoryModule = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/src/utility/private-directory.ts')

// Runs in a child Node process: startup's folder call with its own roots, after recording which roots equal a protected folder.
const privateDirectoryProbe = (roots, dataRoot) => `import { win32 } from 'node:path'
import { homedir } from 'node:os'
import { ensurePrivateDirectories } from ${JSON.stringify(pathToFileURL(privateDirectoryModule).href)}
const roots = ${JSON.stringify(roots)}
const resolved = path => path ? win32.resolve(path).toLowerCase() : null
const protectedFolders = { driveRoot: resolved(win32.parse(roots[0]).root), userProfile: resolved(homedir()),
  localAppData: resolved(process.env.LOCALAPPDATA), systemRoot: resolved(process.env.SystemRoot) }
const equalsRoot = Object.fromEntries(Object.entries(protectedFolders).map(([name, path]) => [name, roots.some(root => resolved(root) === path)]))
process.stdout.write(JSON.stringify({ entered: true, equalsRoot }) + '\\n')
const started = performance.now()
let outcome = 'returned', message = null
try { ensurePrivateDirectories(roots, 'win32', ${JSON.stringify(dataRoot)}) } catch (error) {
  message = String(error?.message ?? error)
  outcome = message.includes('dedicated absolute') ? 'root-refused' : message.includes('Chromium data folder') ? 'chromium-folder-refused'
    : message.includes('SystemRoot') ? 'system-root-unavailable' : message.includes('could not secure') ? 'securing-failed' : 'other'
}
process.stdout.write(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), outcome, message: outcome === 'other' ? message.slice(0, 160) : null }) + '\\n')`

/** A bounded child: its own 15 s PowerShell bound stays inside; the parent stops it after 45 s. */
async function observePrivateDirectoryChild(env, roots, dataRoot) {
  const started = Date.now()
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', privateDirectoryProbe(roots, dataRoot)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  let parentTimeout = false
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => { parentTimeout = true; child.kill() }, 45000)
    child.once('error', error => { clearTimeout(timer); resolve({ spawnError: error.code ?? 'unknown' }) })
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  const lines = stdout.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  return { totalMs: Date.now() - started, ...outcome, parentTimeout, entered: lines.some(line => line.entered),
    equalsRoot: lines.find(line => line.entered)?.equalsRoot ?? null, call: lines.find(line => line.outcome) ?? null,
    stderrTail: printable(stderr, 500) }
}

/**
 * Startup refuses a BMN root equal to LOCALAPPDATA, the user profile, a drive root or SystemRoot, then secures
 * the roots with a PowerShell run bounded at 15 s (private-directory.ts). The same function runs here with the
 * roots and Chromium data folder startup resolves from the smoke environment (the BMN_*_HOME values on Windows,
 * roots.ts), under environments that differ only in LOCALAPPDATA and USERPROFILE: the smoke profile, its old
 * layout (LOCALAPPDATA was the data root) and the runner's own folders, which are only named, never written.
 */
async function observePrivateDirectories() {
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-private-observation-'))
  try {
    const profile = join(temporary, 'profile')
    ensurePrivateDirectories([profile])
    const smoke = windowsInstallerSmokeEnvironment(profile)
    const roots = [smoke.BMN_CONFIG_HOME, smoke.BMN_DATA_HOME, smoke.BMN_STATE_HOME, smoke.BMN_RUNTIME_HOME]
    const variants = [['smoke-profile', {}], ['old-layout', { LOCALAPPDATA: smoke.BMN_DATA_HOME }],
      ['runner-profile', { LOCALAPPDATA: windowsEnvironmentValue(process.env, 'LOCALAPPDATA'), USERPROFILE: windowsEnvironmentValue(process.env, 'USERPROFILE') }]]
    const results = []
    for (const [variant, change] of variants) results.push({ variant, changed: Object.keys(change), ...(await observePrivateDirectoryChild({ ...smoke, ...change }, roots, smoke.BMN_DATA_HOME)) })
    return results
  } catch (error) {
    return [{ unavailable: true, error: String(error?.message ?? error).slice(0, 300) }]
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* The runner image is discarded. */ }
  }
}

// Startup markers alone do not count as progress: a run is silent until a self-test phase, failure or receipt appears.
const silent = run => !run.unavailable && run.phaseCount === 0 && !run.failure && !run.receipt

export async function observeWindowsPackagedSelfTest(binary) {
  const privateDirectories = await observePrivateDirectories()
  const runs = [await observeRun(binary, { name: 'minimal-self-test', environment: 'minimal', selfTest: true })]
  // The old layout is a short control: its startup should now report the refused root and exit.
  runs.push(await observeRun(binary, { name: 'old-layout-self-test', environment: 'old-layout', selfTest: true, budgetMs: 30000 }))
  if (silent(runs[0])) {
    runs.push(await observeRun(binary, { name: 'full-self-test', environment: 'full', selfTest: true }))
    // A full environment that progresses already implicates the environment; otherwise check a normal start.
    if (silent(runs.at(-1))) runs.push(await observeRun(binary, { name: 'minimal-normal-start', environment: 'minimal', selfTest: false }))
  }
  return { nativeDiagnostic: 'packaged-self-test', observationOnly: true, runBudgetMs: RUN_BUDGET_MS, privateDirectories, runs }
}

export async function recordWindowsPackagedSelfTest(binary) {
  const result = await observeWindowsPackagedSelfTest(binary)
  writeFileSync(join(process.cwd(), 'test-results/windows-self-test-diagnostic.json'), JSON.stringify(result, null, 2))
  return { observationOnly: true, privateDirectories: result.privateDirectories.map(entry => ({ variant: entry.variant, outcome: entry.call?.outcome ?? null,
    elapsedMs: entry.call?.elapsedMs ?? null, equalsRoot: entry.equalsRoot ?? null, parentTimeout: entry.parentTimeout ?? null })),
  runs: result.runs.map(run => ({ name: run.name, durationMs: run.durationMs, phaseCount: run.phaseCount ?? null, lastPhase: run.lastPhase ?? null,
    lastStartupMarker: run.startupMarkers?.at(-1) ?? null, failure: run.failure ?? null,
    ready: run.inspector?.samples?.at(-1)?.ready ?? null, sentinelReceived: run.stderrTransport?.sentinelReceived ?? null })) }
}
