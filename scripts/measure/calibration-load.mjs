#!/usr/bin/env node
// MODULE: calibration-load.mjs - Story 91.1 AC3: this checkout's build in throwaway folders under agent-like load, measured by bmn-cpu.mjs with nothing attached
/* global window, document */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { random, styledLine } from './agent-replay.mjs'
import { connect, profileAll, targets } from './cpu-profiles.mjs'

const USAGE = `Usage: node scripts/measure/calibration-load.mjs [--sessions claude=3,codex=1,shell=1] [--scale N[,N...]]
  [--warmup S] [--minutes N] [--width W --height H] [--pane COLSxROWS] [--appearance MODE,FONT,IDENTITY]
  [--sidebar 9,5,2] [--idle | --working N] [--steady] [--status-ms MS[,MS...]] [--tick MS] [--history N]
  [--saved-output COUNT,KB]
  [--profile DIR [--profile-only renderer,main,utility,gpu,window-trace]] --out FILE
Starts this checkout's built BMN (pnpm run build first) with temporary data, config, state, cache and runtime folders,
opens the sessions (each claude or codex one replays agent-like output with scripts/measure/agent-replay.mjs and reports
its hook events, so BMN opens its screen mirror; shell sessions replay a quiet shell), shows one pane and hides the rest,
resizes the window, then lets go of the window's debugging connection. --scale gives one scale per session in order (the
last one repeats). --pane resizes the window until the shown pane has that many columns and rows; --appearance sets the
colour mode, terminal font size and identity; --sidebar gives each workspace that many sessions, the extra ones stopped
(the first workspace holds the running ones). --idle leaves every session's app waiting at its prompt, --working N lets
only the first N sessions work, --steady leaves no long wait between a session's turns, --status-ms gives working sessions (one value
each, in order, the last repeating; 0 for none) Claude Code's small status writes every MS milliseconds between full
redraws, and --tick redraws each waiting
session's status every MS milliseconds. --history fills each session's scrollback with N lines first, and --saved-output
starts BMN with COUNT saved terminal outputs of about KB kilobytes each, as a BMN used for weeks keeps (at most 100,
TERMINAL_SAVED_OUTPUT_RETENTION). After --warmup seconds (60)
it runs scripts/measure/bmn-cpu.mjs for --minutes (5) and writes its JSON, with the load's settings, to --out. With
--profile DIR it starts BMN with its main inspector listening and, instead of the long measurement, takes Story 91.1
AC4's four 60-second profiles into DIR, then Story 91.2's timeline trace of the window, each beside a /proc measurement of the
same minute (--profile-only takes some). BMN is stopped and the
folders removed at the end.`

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const app = join(repo, 'apps/desktop')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function option(argv, name, fallback) {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}

/** `claude=3,codex=1,shell=1` as the list of session agents, in that order. */
export function sessionPlan(text) {
  return text.split(',').filter(Boolean).flatMap((part) => {
    const [agent, count] = part.split('=')
    if (!['claude', 'codex', 'shell'].includes(agent) || !(Number(count) >= 0)) throw new Error(`--sessions: ${part} is not agent=count`)
    return Array.from({ length: Number(count) }, () => agent)
  })
}

const freePort = () => new Promise((done, fail) => {
  const server = createServer()
  server.once('error', fail)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)) })
})

/**
 * `count` saved terminal outputs of other, finished sessions, about `kilobytes` each and older than any this run makes,
 * in the store's own format (apps/desktop/src/utility/saved-output-store.ts), so every save reads a full store.
 */
export function seedSavedOutput(directory, count, kilobytes) {
  mkdirSync(directory, { recursive: true })
  const next = random(count)
  for (let index = 0; index < count; index += 1) {
    const lines = []
    for (let size = 0; size < kilobytes * 1024;) { const line = styledLine(next, 160); lines.push(line); size += line.length + 1 }
    const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    const snapshot = {
      formatVersion: 2, sessionId: randomUUID(), incarnationId: randomUUID(), viewEpoch: randomUUID(), capturedAt: at,
      content: lines.join('\n'), retainedLines: lines.length, snapshotTruncated: false, snapshotDroppedLines: 0,
      snapshotDroppedBytes: 0, transportDroppedBytes: 0, captureStartedAt: at, lineLimit: 10_000, snapshotLimitBytes: 64 * 1024 * 1024,
      processState: 'exited'
    }
    const name = [snapshot.sessionId, snapshot.incarnationId, snapshot.viewEpoch].map(encodeURIComponent).join('--')
    writeFileSync(join(directory, `${name}.snapshot.json`), JSON.stringify(snapshot))
  }
}

/** Its start time in ticks since boot (`/proc/PID/stat` field 22), the identity a reused PID does not share. */
const startTicks = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /su, '').split(' ')[19]

async function main(argv) {
  if (argv.includes('--help') || !option(argv, '--out')) { console.log(USAGE); return argv.includes('--help') ? 0 : 2 }
  if (!existsSync(join(app, 'out/main/index.js'))) throw new Error('no build: run pnpm run build first')
  const out = resolve(option(argv, '--out'))
  const plan = sessionPlan(option(argv, '--sessions', 'claude=3,codex=1,shell=1'))
  const scales = option(argv, '--scale', '1').split(',').map(Number)
  const scale = (index) => scales[Math.min(index, scales.length - 1)]
  const steady = argv.includes('--steady')
  const warmup = Number(option(argv, '--warmup', '60'))
  const minutes = option(argv, '--minutes', '5')
  const profileDir = option(argv, '--profile', null) === null ? null : resolve(option(argv, '--profile'))
  const size = { width: Number(option(argv, '--width', '1600')), height: Number(option(argv, '--height', '1000')) }
  const pane = option(argv, '--pane', null)?.split('x').map(Number) ?? null
  const appearance = option(argv, '--appearance', null)?.split(',') ?? null
  const sidebar = option(argv, '--sidebar', null)?.split(',').map(Number) ?? null
  const working = argv.includes('--idle') ? 0 : Number(option(argv, '--working', 'Infinity'))
  const tick = option(argv, '--tick', null)
  const statusMs = option(argv, '--status-ms', null)?.split(',') ?? null
  const history = option(argv, '--history', null)
  const savedOutput = option(argv, '--saved-output', null)?.split(',').map(Number) ?? null
  const electronPath = createRequire(join(app, 'package.json'))('electron')
  const report = { settings: { sessions: plan, scale: scales, steady, warmup, minutes: Number(minutes), size, pane, appearance, sidebar, working: Number.isFinite(working) ? working : 'all', statusMs, tick, history, savedOutput, profile: profileDir !== null }, steps: [] }
  const step = (name, detail = {}) => { report.steps.push({ at: new Date().toISOString(), name, ...detail }); console.error(`calibration: ${name}${detail.pid ? ` pid ${detail.pid} start ticks ${detail.startTicks}` : ''}`) }
  await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
    const bin = join(root, 'agents')
    mkdirSync(bin)
    for (const name of ['claude', 'codex', 'shell']) symlinkSync(join(repo, 'scripts/measure/agent-replay.mjs'), join(bin, name))
    const runtime = process.env.XDG_RUNTIME_DIR
    const wayland = runtime && process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY) ? join(runtime, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
    const caller = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PROMPT_COMMAND' && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))
    const environment = {
      ...caller, SHELL: '/bin/bash',
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'), OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
      BMN_LAUNCH_CWD: root,
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {})
    }
    if (savedOutput) seedSavedOutput(join(roots.state, 'bmn/saved-output'), savedOutput[0], savedOutput[1])
    const port = await freePort()
    const inspectPort = await freePort()
    // Not BMN's test mode: its background services run as in his use. Both debugging ports listen in every run, so a
    // calibration and a profile run start alike; nothing is attached to them while BMN is measured.
    const flags = [`--remote-debugging-port=${port}`, `--inspect=${inspectPort}`]
    const child = spawn(electronPath, [...flags, app], { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    child.stderr.on('data', (chunk) => { log = `${log}${chunk}`.slice(-20_000) })
    report.launch = { pid: child.pid, startTicks: startTicks(child.pid), executable: electronPath, root }
    step('started', report.launch)
    try {
      let browser
      for (let tries = 0; !browser; tries += 1) {
        try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch (error) { if (tries > 60) throw error; await sleep(1_000) }
      }
      let page
      for (let tries = 0; !page; tries += 1) {
        page = browser.contexts().flatMap((context) => context.pages()).find((one) => !one.url().startsWith('devtools:'))
        if (!page) { if (tries > 60) throw new Error('no BMN window'); await sleep(1_000) }
      }
      page.setDefaultTimeout(60_000)
      // A fresh profile opens with no session ("Add a session"), so the bridge is waited for rather than a session row.
      await page.waitForFunction(() => typeof window.aiTerminal?.listWorkspaces === 'function')
      const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
      const ids = []
      const open = (workspaceId, agent, index, flags = []) => page.evaluate((params) => window.aiTerminal.createSession(params), {
        workspaceId, name: `${agent} ${index + 1}`, cwd: root, executable: process.execPath,
        argv: [join(bin, agent), '--scale', String(scale(index)), '--seed', String(index + 1), '--size-file', join(root, `size-${index + 1}`),
          ...(history ? ['--history', history] : []), ...flags], cols: 120, rows: 40
      })
      for (const [index, agent] of plan.entries()) ids.push((await open(workspace.workspaceId, agent, index, index < working ? [...(steady ? ['--steady'] : []), ...(statusMs ? ['--status-ms', statusMs[Math.min(index, statusMs.length - 1)]] : [])] : ['--idle', ...(tick ? ['--tick', tick] : [])])).session.sessionId)
      // Only the planned sessions run, as in his BMN: any other a profile opened with is stopped.
      const extra = (await page.evaluate((id) => window.aiTerminal.listSessions(id), workspace.workspaceId)).map((one) => one.sessionId).filter((id) => !ids.includes(id))
      for (const id of extra) await page.evaluate((one) => window.aiTerminal.stopSession(one), id).catch(() => undefined)
      // His sidebar's shape: more workspaces and stopped sessions, listed but not running.
      const stopped = []
      for (const [at, count] of (sidebar ?? []).entries()) {
        const target = at === 0 ? workspace : await page.evaluate((name) => window.aiTerminal.createWorkspace({ name }), `Workspace ${at + 1}`)
        for (let made = (at === 0 ? ids.length + extra.length : 0); made < count; made += 1) {
          const created = await open(target.workspaceId, 'claude', 100 + stopped.length, ['--idle'])
          stopped.push(created.session.sessionId)
        }
      }
      await sleep(stopped.length > 0 ? 2_000 : 0)
      for (const id of stopped) await page.evaluate((one) => window.aiTerminal.stopSession(one), id)
      if (appearance) {
        const [colorMode, font, identity] = appearance
        await page.evaluate((value) => window.aiTerminal.putSettings('appearance', value), { colorMode, terminalFontSize: Number(font), identity })
      }
      step('sessions', { ids, others: extra, stopped })
      await page.reload()
      await page.waitForSelector('.session-row')
      // One pane shows, as in his layout; the others are hidden. The row is pressed in the page itself, since a header
      // can lie over it in a small window.
      await page.evaluate(({ id, name }) => {
        if (!document.querySelector(`.session-row button[data-session-id="${id}"]`)) document.querySelector(`.workspace-group[aria-label="${name}"] .workspace-row button`)?.click()
      }, { id: ids[0], name: workspace.name })
      await page.waitForSelector(`.session-row button[data-session-id="${ids[0]}"]`)
      await page.evaluate((id) => document.querySelector(`.session-row button[data-session-id="${id}"]`)?.click(), ids[0])
      const visible = await page.waitForFunction((id) => document.querySelector(`.session-terminal[data-session-id="${id}"]:not(.session-terminal-hidden)`) !== null, ids[0], { timeout: 20_000 }).then(() => true, () => false)
      step('shown', { visible: await page.evaluate(() => [...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')].map((pane) => pane.getAttribute('data-session-id'))) })
      if (!visible) {
        await page.screenshot({ path: `${out}.shown.png` })
        throw new Error(`the first session's pane did not show: ${await page.evaluate(() => [...document.querySelectorAll('.session-row')].map((row) => row.className).join(', '))}`)
      }
      // The window is resized by the main process (an Electron window is not one DevTools can size), twice.
      const before = await page.evaluate(() => [window.innerWidth, window.innerHeight])
      const main = await connect((await targets(inspectPort))[0].webSocketDebuggerUrl)
      const resize = (width, height) => main.send('Runtime.evaluate', { expression: `require('electron').BrowserWindow.getAllWindows().forEach((one) => one.setSize(${width}, ${height}))`, includeCommandLineAPI: true })
      const shown = async () => { await sleep(1_500); return readFileSync(join(root, 'size-1'), 'utf8').split('x').map(Number) }
      let at = [size.width - 200, size.height - 100]
      await resize(size.width, size.height)
      const first = await shown()
      await resize(...at)
      let fitted = await shown()
      if (pane) {
        // The two sizes give a cell's size; the window then changes until the shown pane has the asked columns and rows.
        const cell = [200 / (first[0] - fitted[0]), 100 / (first[1] - fitted[1])]
        if (!cell.every(Number.isFinite)) throw new Error(`the pane did not change with the window: ${first} and ${fitted}`)
        for (let tries = 0; tries < 4 && fitted.join('x') !== pane.join('x'); tries += 1) {
          at = [Math.round(at[0] + (pane[0] - fitted[0]) * cell[0]), Math.round(at[1] + (pane[1] - fitted[1]) * cell[1])]
          await resize(...at)
          fitted = await shown()
        }
      }
      main.close()
      const after = await page.evaluate(() => [window.innerWidth, window.innerHeight])
      step('resized', { before, after, window: at, pane: fitted, changed: before.join() !== after.join() })
      await browser.close()
      step('debugging connection closed')
      await sleep(warmup * 1_000)
      if (child.exitCode !== null) throw new Error(`BMN exited during the warm-up: ${log.slice(-2_000)}`)
      const measure = async (span, file) => {
        const code = await new Promise((done) => {
          const run = spawn(process.execPath, ['--no-warnings', join(repo, 'scripts/measure/bmn-cpu.mjs'), '--exe', electronPath, '--main-pid', String(child.pid),
            '--db', join(roots.data, 'bmn/state.sqlite3'), '--minutes', String(span), '--out', file], { stdio: ['ignore', 'ignore', 'inherit'] })
          run.on('exit', done)
        })
        return code !== null && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
      }
      if (profileDir) {
        mkdirSync(profileDir, { recursive: true })
        report.profiles = await profileAll({ port, inspectPort, mainPid: child.pid, dir: profileDir, measure, only: option(argv, '--profile-only', null)?.split(',') ?? null })
        step('profiled', { dir: profileDir })
      } else {
        report.cpu = await measure(minutes, join(dirname(out), `${out.split('/').at(-1)}.cpu.json`))
        step('measured', { valid: report.cpu?.valid ?? false })
      }
    } finally {
      child.kill('SIGTERM')
      for (let waited = 0; child.exitCode === null && child.signalCode === null && waited < 15_000; waited += 500) await sleep(500)
      // BMN asks before it closes with sessions running, so a SIGTERM may leave it up; then it is killed.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)))
      }
      step('stopped', { exit: child.exitCode, signal: child.signalCode })
      report.log = log.slice(-4_000)
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    }
  })
  return report.cpu?.valid || report.profiles ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
