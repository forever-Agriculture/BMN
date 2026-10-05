// MODULE: windows-self-test-diagnostic.mjs - observation-only native runs that locate where the packaged --self-test stops
// The installed smoke and a 120 s run of `BMN.exe --self-test` printed nothing:
// stderr 0 bytes even with Chromium logging, stdout one CRLF, no phase markers
// (runs 37296438394, 37299667758). Each run here attaches the Node inspector
// early, without waiting for Electron readiness, and records whether main is
// ready and responsive, what it is doing, and whether a stderr sentinel written
// through the inspector reaches the pipe. The runs adapt: a minimal-environment
// self-test first, then a full-environment self-test and a minimal-environment
// normal start only while the earlier runs stay silent. All runs use the same
// flags. It never changes the gate's result.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'

const RUN_BUDGET_MS = 80000

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function inspectorUrl(port, until) {
  while (Date.now() < until) {
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
async function stack(client) {
  await client.send('Debugger.enable', {}, 5000)
  const paused = client.once('Debugger.paused', 5000)
  await client.send('Debugger.pause', {}, 5000)
  const state = await paused
  if (!state) return { paused: false }
  const frames = state.callFrames.slice(0, 12).map(frame => ({ functionName: frame.functionName || '(anonymous)',
    script: String(frame.url).split(/[\\/]/u).at(-1).slice(0, 80), line: frame.location.lineNumber + 1 }))
  await client.send('Debugger.resume', {}, 5000)
  return { paused: true, reason: state.reason, frames }
}

// eslint-disable-next-line no-control-regex
const printable = (text, limit) => text.slice(-limit).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')

function fileState(path) {
  if (!existsSync(path)) return { state: 'missing' }
  const bytes = statSync(path).size
  return bytes === 0 ? { state: 'empty' } : { state: 'written', bytes, tail: printable(readFileSync(path, 'utf8'), 3000) }
}

async function observeRun(binary, { name, environment, selfTest }) {
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-self-test-diagnostic-'))
  const profile = join(temporary, 'profile'), started = Date.now(), sentinel = `[BMN diagnostic sentinel ${randomUUID()}]`
  try {
    ensurePrivateDirectories([profile])
    const minimal = windowsInstallerSmokeEnvironment(profile)
    const base = environment === 'full' ? { ...process.env, ...minimal } : minimal
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
    const deadline = started + RUN_BUDGET_MS
    const url = await inspectorUrl(port, Math.min(deadline, started + 20000))
    const inspector = { listening: url !== null, listeningAfterMs: url ? Date.now() - started : null, samples: [], stack: null }
    // Node holds an exiting process while a debugger is attached, so each look attaches briefly.
    const look = async read => {
      const client = await connect(url)
      if (!client) return { attached: false }
      try { return await read(client) } finally { client.close() }
    }
    if (url) {
      for (const at of [15000, 55000]) {
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
    const phases = [...stderr.matchAll(/\[BMN\] self-test phase: ([^\r\n]*)/gu)].map(match => match[1])
    const acknowledged = inspector.samples.some(entry => entry.sentinelWritten)
    return { name, environment, selfTest, durationMs: Date.now() - started, outcome, inspector,
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

const silent = run => !run.unavailable && run.phaseCount === 0 && !run.failure && !run.receipt

export async function observeWindowsPackagedSelfTest(binary) {
  const runs = [await observeRun(binary, { name: 'minimal-self-test', environment: 'minimal', selfTest: true })]
  if (silent(runs[0])) {
    runs.push(await observeRun(binary, { name: 'full-self-test', environment: 'full', selfTest: true }))
    // A full environment that progresses already implicates the environment; otherwise check a normal start.
    if (silent(runs[1])) runs.push(await observeRun(binary, { name: 'minimal-normal-start', environment: 'minimal', selfTest: false }))
  }
  return { nativeDiagnostic: 'packaged-self-test', observationOnly: true, runBudgetMs: RUN_BUDGET_MS, runs }
}

export async function recordWindowsPackagedSelfTest(binary) {
  const result = await observeWindowsPackagedSelfTest(binary)
  writeFileSync(join(process.cwd(), 'test-results/windows-self-test-diagnostic.json'), JSON.stringify(result, null, 2))
  return { observationOnly: true, runs: result.runs.map(run => ({ name: run.name, durationMs: run.durationMs, phaseCount: run.phaseCount ?? null,
    ready: run.inspector?.samples?.at(-1)?.ready ?? null, sentinelReceived: run.stderrTransport?.sentinelReceived ?? null })) }
}
