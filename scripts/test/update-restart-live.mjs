/* global window */
// MODULE: update-restart-live.mjs - Epic 125 (125.4 AC6, 125.5 AC7): the whole restart once with a real Claude Code and a real Codex session, on the tests' own home and sign-in
//
// Usage: node scripts/test/native-test-home.mjs -- node scripts/test/update-restart-live.mjs --claude-folder DIR --codex-folder DIR --out DIR
// Each folder is one its app already trusts in the test profile. The driver types only what the owner would (the launch
// command and one prompt per session, before the press). After the press it only reads: BMN's record, the two apps' own
// conversation records in the test profiles, and the test host's record of what BMN itself wrote to each terminal.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { assertNativeTestEnvironment, assertNativeTestSignIn } from './native-test-home.mjs'
import { classifyScreen } from './away-skills-startup.mjs'
import { createUpdateRestartFixture } from './update-restart-fixture.mjs'
import { useProductionRestartLauncher } from './update-restart-launcher-fixture.mjs'

assertNativeTestEnvironment(process.env)
for (const app of ['claude', 'codex']) assertNativeTestSignIn(app)
const flag = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1] }
const folders = { claude: realpathSync(flag('--claude-folder')), codex: realpathSync(flag('--codex-folder')) }
const evidence = resolve(flag('--out')); mkdirSync(evidence, { recursive: true })
const BUILD = '1234567890abcdef'
const pause = ms => new Promise(done => setTimeout(done, ms))
const until = async (probe, timeout, what, step = 500) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`UNVERIFIED: ${what}`)
    await pause(step)
  }
}
const freePort = async () => {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address(); await new Promise(done => server.close(done)); return port
}
// Another BMN's command folder on the caller's PATH (a lead working inside BMN) would make the two Codex wrappers start each other forever.
process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry && !entry.includes('/resources/bin')).join(':')
const f = createUpdateRestartFixture({ base: join(process.env.HOME, 'restart-live'), runtimeBase: process.env.XDG_RUNTIME_DIR })
const stateHome = join(f.roots.state, 'bmn')
Object.assign(f.env, { BMN_TEST_HOST_WRITES: join(f.out, 'host-writes.jsonl'), BMN_TEST_RESTART_IO_RECORD: join(stateHome, 'restart-pty-io.jsonl') })
assertNativeTestEnvironment(f.env)
const port = await freePort()
useProductionRestartLauncher(f, port)
const { UPDATE_RESTART_CONTINUE, UPDATE_RESTART_CHECK, updateRestartNotice } = await import(pathToFileURL(join(f.repo, 'shared/protocol/dist/update-restart.js')).href)
const receipt = () => JSON.parse(readFileSync(join(f.roots.data, 'bmn/update-restart.json'), 'utf8'))
const rows = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const report = { result: 'UNVERIFIED', out: f.out, evidence, folders, timeline: [] }
const mark = (name, extra = {}) => { report.timeline.push({ at: new Date().toISOString(), name, ...extra }); console.log(`  [${new Date().toISOString().slice(11, 19)}] ${name}`) }
const LAUNCH = {
  claude: "claude --model haiku --permission-mode dontAsk --allowedTools 'Bash(echo:*)' 'Bash(sleep:*)' 'Read' 'Write' 'Edit'",
  codex: "codex --no-alt-screen -c 'mcp_servers={}'"
}
const PROMPT = 'Do ten steps, one shell call per step and nothing else in a step: for N from 1 to 10 run exactly `sleep 12` and then, as a separate call, `echo step-N`. Do not combine steps. After step 10 answer DONE.'
let current = null, browser = null, page = null

const screen = id => page.evaluate(session => { const s = window.__aitermTest.snapshot(session); return s.bufferLines.slice(-s.rows).map(line => line.trimEnd()) }, id)
const select = async id => { await page.locator(`.session-row > button[data-session-id="${id}"]`).click({ timeout: 8000 }); await pause(600) }
const type = async (id, text) => {
  await select(id)
  await page.locator(`[data-session-id="${id}"] .terminal-surface`).first().click({ timeout: 8000 })
  await page.keyboard.type(text, { delay: 20 }); await pause(1000); await page.keyboard.press('Enter')
}
/** A shell command, typed and read back before Enter: under a file trace a key is sometimes dropped. */
const typeCommand = async (id, text) => {
  const typed = new RegExp(text.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'u')
  await select(id)
  await page.locator(`[data-session-id="${id}"] .terminal-surface`).first().click({ timeout: 8000 })
  for (let attempt = 1; ; attempt++) {
    await page.keyboard.type(text, { delay: 40 }); await pause(1000)
    const lines = await screen(id)
    if (typed.test(lines.join('')) || typed.test(lines.join(' '))) break
    if (attempt === 3) throw new Error('UNVERIFIED: the launch command did not reach the shell as typed')
    await page.keyboard.press('Control+U'); await pause(500)
  }
  await page.keyboard.press('Enter')
}
/** The app's composer, seen twice two seconds apart with the same screen; a dialog is never answered here. */
const composer = (app, id, folder, timeout) => until(async () => {
  // The typed launch command stays on the screen and holds the word "permission": only what the app drew after it is read.
  const first = await screen(id), from = first.findLastIndex(line => line.includes(LAUNCH[app].slice(-12)))
  const state = classifyScreen(app, first.slice(from + 1), folder)
  if (state.state === 'dialog' || state.state === 'trust' || state.state === 'trust-negative') throw new Error(`UNVERIFIED: ${app} shows a dialog at start (${state.detail}); the folder must already be trusted`)
  if (state.state !== 'composer') return false
  await pause(2000)
  return (await screen(id)).join('\n') === first.join('\n')
}, timeout, `${app} never reached its composer`, 1500)

try {
  current = await f.launch(['--', '/bin/bash', '--noprofile', '--norc'])
  page = current.page
  let app = current.app
  await page.waitForSelector('.session-row', { timeout: 30_000 })
  const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
  const sessions = {}
  for (const kind of ['claude', 'codex']) {
    const created = await page.evaluate(params => window.aiTerminal.createSession(params), { workspaceId: workspace.workspaceId, name: `Live ${kind}`, cwd: folders[kind], executable: '/bin/bash', argv: ['--noprofile', '--norc'], cols: 110, rows: 30 })
    sessions[kind] = created.session.sessionId
  }
  await page.reload(); await page.waitForSelector('.session-row', { timeout: 30_000 })
  for (const kind of ['codex', 'claude']) {
    await typeCommand(sessions[kind], LAUNCH[kind]); await composer(kind, sessions[kind], folders[kind], 120_000); mark(`${kind} at its composer`)
  }
  for (const kind of ['codex', 'claude']) { await type(sessions[kind], PROMPT); mark(`${kind} prompted`) }
  writeFileSync(join(f.stateDir, 'latest.json'), JSON.stringify({ phase: 'waiting-for-exit', commit: BUILD, updatedAt: new Date().toISOString() }))
  const status = () => page.evaluate(() => window.aiTerminal.updateRestart('status'))
  // Both are working by BMN's own hook record (a tool call seen) before the press.
  const offered = await until(async () => {
    const snapshot = await status(), mine = Object.values(sessions).map(id => snapshot.sessions.find(m => m.sessionId === id))
    return snapshot.waitingBuild === BUILD && mine.every(m => m?.atPress === 'working' && m.conversation) ? mine : null
  }, 180_000, 'both sessions working with a bound conversation')
  report.atPress = offered.map(m => ({ name: m.name, agent: m.agent, atPress: m.atPress, conversation: m.conversation }))
  await page.evaluate(() => window.aiTerminal.quitApplication())
  const preview = page.getByRole('dialog', { name: 'Restart for the update?', exact: true }); await preview.waitFor()
  await page.screenshot({ path: join(evidence, 'offer-680.png') })
  const oldPid = app.process().pid
  const exited = new Promise(done => app.process().once('exit', done))
  const pressedAt = Date.now()
  await preview.getByRole('button', { name: 'Restart', exact: true }).click(); mark('Restart pressed')
  // Read only from here: every change of a row, as BMN's record and the dialog show it, until BMN closes.
  let last = '', shots = 0
  const watch = (async () => {
    for (;;) {
      if (!existsSync(`/proc/${oldPid}`)) return
      try {
        const run = receipt(), line = run.members.filter(m => Object.values(sessions).includes(m.sessionId)).map(m => `${m.name}=${m.ready ? 'Ready' : m.notice === 'printed' ? 'Reaching a safe point' : 'Not told yet'}(${m.notice})`).join(' ')
        if (line !== last) { last = line; mark(`rows: ${line}`, { phase: run.phase }); await page.screenshot({ path: join(evidence, `waiting-${++shots}-680.png`) }).catch(() => {}) }
      } catch { /* the record is being replaced */ }
      await pause(400)
    }
  })()
  let exitTimer
  try { await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('UNVERIFIED: BMN did not close within the limit')), 320_000) })]) } finally { clearTimeout(exitTimer) }
  await watch
  report.closedAfterMs = Date.now() - pressedAt; mark('BMN closed', { afterMs: report.closedAfterMs }); current = null
  const closing = receipt()
  writeFileSync(join(evidence, 'record-at-close.json'), JSON.stringify(closing, null, 2))
  await until(async () => existsSync(join(f.out, 'reopened-pid')), 90_000, 'the launcher did not reopen BMN')
  const reopenedAt = Date.now()
  const reopenedPid = Number(readFileSync(join(f.out, 'reopened-pid'), 'utf8').trim()); f.record(reopenedPid, 'update restart live run, reopened', port)
  await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 }); return true } catch { return false } }, 30_000, `no reopened BMN on port ${port}`)
  page = await until(async () => browser.contexts()[0]?.pages().find(p => p.url().includes('index.html')), 30_000, 'the reopened window is missing')
  await page.setViewportSize({ width: 680, height: 720 }); mark('BMN reopened')
  const after = page.getByRole('dialog', { name: 'Restarted on 1234567', exact: true }); await after.waitFor({ timeout: 60_000 })
  // Every row has its final words: resumed or not, told or not.
  const done = await until(async () => { const run = receipt(); return run.phase === 'complete' && run.members.every(m => !['pending', 'claimed'].includes(m.tell) && !['pending', 'claimed'].includes(m.resume)) ? run : null }, 240_000, 'recovery did not finish')
  await pause(1500); await page.screenshot({ path: join(evidence, 'after-680.png') })
  report.rows = Object.fromEntries(await Promise.all((await after.locator('li').all()).map(async li => [await li.locator('.name').innerText(), await li.locator('.detail').innerText()])))
  writeFileSync(join(evidence, 'record-final.json'), JSON.stringify(done, null, 2)); mark('recovery complete', { rows: report.rows })
  await pause(20_000) // time for anything BMN might still type, which must not happen for Codex

  // ---- the evidence, read from three independent records ----
  const member = Object.fromEntries(['claude', 'codex'].map(kind => [kind, done.members.find(m => m.sessionId === sessions[kind])]))
  const closed = Object.fromEntries(['claude', 'codex'].map(kind => [kind, closing.members.find(m => m.sessionId === sessions[kind])]))
  const findFile = (root, part) => { for (const entry of readdirSync(root, { recursive: true })) if (String(entry).includes(part) && String(entry).endsWith('.jsonl')) return join(root, String(entry)); return null }
  const own = { claude: findFile(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), member.claude.conversation), codex: findFile(join(process.env.CODEX_HOME, 'sessions'), member.codex.conversation) }
  const text = Object.fromEntries(Object.entries(own).map(([kind, path]) => [kind, path ? readFileSync(path, 'utf8') : '']))
  const count = (haystack, needle) => haystack.split(JSON.stringify(needle).slice(1, -1)).length - 1
  const noticeHead = 'Reach a safe point, write your handoff and end your turn.'
  const hostWrites = rows(f.env.BMN_TEST_HOST_WRITES)
  const io = rows(f.env.BMN_TEST_RESTART_IO_RECORD)
  // Every byte that reached each terminal's input after BMN reopened, whoever wrote it (the driver types nothing then).
  const resumedInput = kind => io.filter(row => row.sessionId === sessions[kind] && row.direction === 'input' && row.at >= reopenedAt).map(row => Buffer.from(row.hex, 'hex').toString())
  const check = {
    claudeNoticeInItsOwnRecord: count(text.claude, noticeHead) >= 1 && text.claude.includes('BMN will resume this session and tell you to continue'),
    codexNoticeInItsOwnRecord: count(text.codex, noticeHead) >= 1 && text.codex.includes('BMN will resume this session and type nothing into it'),
    claudeReadyObserved: closed.claude.notice === 'printed' && closed.claude.ready === true && closed.claude.atClose === 'ready',
    codexAtClose: closed.codex.atClose, codexNotice: closed.codex.notice,
    bothResumed: member.claude.resume === 'resumed' && member.codex.resume === 'resumed',
    claudeTold: member.claude.tell === 'told',
    // The app keeps a prompt in several kinds of entry (the turn itself, its last-prompt note, its request copy): a turn is its `user` entry.
    claudeLineOnceInItsOwnRecord: text.claude.split('\n').filter(line => line.includes(closed.claude.atClose === 'ready' ? UPDATE_RESTART_CONTINUE : UPDATE_RESTART_CHECK) && JSON.parse(line).type === 'user').length,
    codexNotTold: member.codex.tell === 'not-told',
    codexLinesFromBmnInItsOwnRecord: count(text.codex, 'BMN update restart:'),
    hostWritesAfterReopen: { claude: hostWrites.filter(w => w.sessionId === sessions.claude).length, codex: hostWrites.filter(w => w.sessionId === sessions.codex).length },
    terminalInputAfterResume: { claude: resumedInput('claude'), codex: resumedInput('codex') }
  }
  report.ownRecords = own; report.check = check; report.notices = { claude: updateRestartNotice('claude', closing.closesAt), codex: updateRestartNotice('codex', closing.closesAt) }
  assert(check.claudeNoticeInItsOwnRecord, "Claude Code's own record lacks its notice")
  assert(check.codexNoticeInItsOwnRecord, "Codex's own record lacks its notice")
  assert(check.claudeReadyObserved, 'the Claude Code row did not go to Ready on an observed turn end')
  assert(['ready', 'not-ready'].includes(check.codexAtClose))
  assert(check.bothResumed, 'a session was not resumed')
  assert(check.claudeTold && check.claudeLineOnceInItsOwnRecord === 1, `the Claude Code session's record shows the typed line ${check.claudeLineOnceInItsOwnRecord} times`)
  assert(check.codexNotTold && check.codexLinesFromBmnInItsOwnRecord === 0 && check.hostWritesAfterReopen.codex === 0, 'BMN wrote to the resumed Codex session')
  assert.equal(report.rows['Live claude'], 'Resumed · told to continue')
  assert.equal(report.rows['Live codex'], check.codexAtClose === 'ready' ? 'Resumed · not told, type continue' : 'Resumed · not told, not ready at close')
  report.result = 'PASS'
} catch (error) {
  report.problem = error.message; process.exitCode = 1
  if (page) { await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {}); try { report.failureState = await page.evaluate(() => window.aiTerminal.updateRestart('status')) } catch { /* window gone */ } }
} finally {
  // Stop what the run started: every session through BMN, then BMN itself by its recorded process.
  if (page) { try { for (const s of await page.evaluate(async () => (await Promise.all((await window.aiTerminal.listWorkspaces()).map(w => window.aiTerminal.listSessions(w.workspaceId)))).flat())) await page.evaluate(id => window.aiTerminal.stopSession(id), s.sessionId).catch(() => {}) } catch { /* window gone */ } }
  if (browser) await browser.close().catch(() => {})
  if (current) { await current.app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await current.app.close().catch(() => {}) }
  report.cleanup = f.cleanup()
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ result: report.result, problem: report.problem ?? null, rows: report.rows ?? null, check: report.check ?? null, cleanup: report.cleanup.result }, null, 2))
}
