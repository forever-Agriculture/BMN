/* global window */
// MODULE: update-restart-paths.mjs - Epic 125 (125.4 AC4-5, 125.5 AC1, AC2, AC6): every path of the restart on an isolated instance with shell sessions, reopened by the production launcher against a synthetic update service
//
// Usage: node scripts/test/native-test-home.mjs -- node scripts/test/update-restart-paths.mjs [--limit] [--only FLOW]
// Flows: cancel, all-ready, now, failed-update, and with --limit the five-minute limit. No agent is started: a shell session has
// no conversation, so every reopened row is a resume that fails and names its reason, which is the fifth path of 125.5 AC6.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createUpdateRestartFixture } from './update-restart-fixture.mjs'
import { useProductionRestartLauncher } from './update-restart-launcher-fixture.mjs'

const BUILD = '1234567890abcdef'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (probe, timeout, what) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(what)
    await pause(250)
  }
}
const freePort = async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port
}
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const flows = ['cancel', 'all-ready', 'now', 'failed-update', ...(process.argv.includes('--limit') ? ['limit'] : [])].filter(flow => !only || flow === only)
const report = { result: 'UNVERIFIED', paths: [] }

for (const flow of flows) {
  const f = createUpdateRestartFixture()
  const port = await freePort()
  useProductionRestartLauncher(f, port, flow === 'failed-update')
  const receipt = () => JSON.parse(readFileSync(join(f.roots.data, 'bmn/update-restart.json'), 'utf8'))
  const status = page => page.evaluate(() => window.aiTerminal.updateRestart('status'))
  let current = null, browser = null
  const item = { flow, out: f.out }
  try {
    current = await f.launch(['--', '/bin/bash', '--noprofile', '--norc'])
    let { app, page } = current
    await page.waitForSelector('.session-row', { timeout: 30_000 })
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    // A shell that keeps printing is working by BMN's own terminal record; one at its prompt has ended.
    const busy = flow === 'all-ready' ? null : await page.evaluate(({ workspaceId, cwd }) => window.aiTerminal.createSession({ workspaceId, name: 'Shell working', cwd, executable: '/bin/bash',
      argv: ['--noprofile', '--norc', '-c', 'while true; do echo synthetic-path-output; sleep 0.3; done'], cols: 80, rows: 24 }), { workspaceId: workspace.workspaceId, cwd: f.out })
    await page.reload(); await page.waitForSelector('.session-row', { timeout: 30_000 })
    writeFileSync(join(f.stateDir, 'latest.json'), JSON.stringify({ phase: 'waiting-for-exit', commit: BUILD, updatedAt: new Date().toISOString() }))
    await until(async () => (await status(page)).waitingBuild === BUILD, 15_000, 'the waiting update was not seen')
    if (flow === 'all-ready') await until(async () => { const s = (await status(page)).sessions; return s.length > 0 && s.every(m => m.atPress === 'ended') }, 60_000, 'the idle shell was never seen at rest')
    const sessions = (await status(page)).sessions
    item.atPress = sessions.map(m => `${m.name}: ${m.atPress}`)
    await page.evaluate(() => window.aiTerminal.quitApplication())
    const preview = page.getByRole('dialog', { name: 'Restart for the update?', exact: true }); await preview.waitFor()
    await page.screenshot({ path: join(f.out, `${flow}-offer-680.png`) })
    const oldPid = app.process().pid
    const exited = new Promise(resolve => app.process().once('exit', resolve))
    const pressed = Date.now()
    await preview.getByRole('button', { name: 'Restart', exact: true }).click()

    if (flow === 'cancel') {
      const waiting = page.getByRole('dialog', { name: /^Restarting · closes by \d\d:\d\d$/u }); await waiting.waitFor()
      await page.screenshot({ path: join(f.out, 'cancel-waiting-680.png') })
      assert.deepEqual(await waiting.locator('.detail').allInnerTexts(), sessions.map(m => m.atPress === 'ended' ? 'Ready' : 'Not told yet'))
      await waiting.getByRole('button', { name: 'Cancel', exact: true }).click()
      // A shell gets no notice and no line, so nobody is listed and the dialog closes by itself (D4).
      await page.locator('dialog[open]').first().waitFor({ state: 'hidden', timeout: 15_000 })
      const run = receipt(); assert.equal(run.phase, 'cancelled'); assert(run.members.every(m => m.tell === 'unnecessary' && m.atClose === null))
      assert(existsSync(`/proc/${oldPid}`), 'BMN must stay open after Cancel')
      await pause(17_000) // longer than the launcher's own wait for the old process
      assert(!existsSync(join(f.out, 'reopened-pid')), 'a cancelled restart must not open a second BMN')
      const live = await page.evaluate(id => window.aiTerminal.listSessions(id), workspace.workspaceId)
      assert(live.every(s => !s.lastProcess?.detail?.includes('update restart')), 'Cancel must stop no session')
      item.result = 'PASS'; report.paths.push(item); continue
    }

    if (flow === 'now' || flow === 'failed-update') {
      const waiting = page.getByRole('dialog', { name: /^Restarting · closes by \d\d:\d\d$/u }); await waiting.waitFor()
      await waiting.getByRole('button', { name: 'Restart now', exact: true }).click()
    }
    // all-ready: every row is Ready at the press, so BMN closes with no second press. limit: it closes at the limit.
    let exitTimer
    try { await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('isolated BMN did not exit')), flow === 'limit' ? 310_000 : 30_000) })]) } finally { clearTimeout(exitTimer) }
    item.exitElapsedMs = Date.now() - pressed
    if (flow === 'limit') assert(item.exitElapsedMs >= 290_000 && item.exitElapsedMs <= 305_000, `the limit is five minutes: ${item.exitElapsedMs} ms`)
    current = null
    const closing = receipt()
    assert.equal(closing.phase, 'closing')
    for (const m of closing.members) assert.equal(m.atClose, m.ready ? 'ready' : 'not-ready', 'each row is recorded as it was at close')
    if (flow === 'all-ready') assert(closing.members.every(m => m.atClose === 'ready'))
    if (flow === 'limit') assert(closing.members.some(m => m.atClose === 'not-ready'))

    await until(async () => existsSync(join(f.out, 'reopened-pid')), 60_000, 'the launcher did not reopen BMN')
    const reopenedPid = Number(readFileSync(join(f.out, 'reopened-pid'), 'utf8').trim()); f.record(reopenedPid, `update restart path ${flow}`, port)
    assert(!existsSync(`/proc/${oldPid}`), 'the old BMN was still alive at reopen')
    await until(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 }); return true } catch { return false } }, 30_000, `no reopened BMN on port ${port}`)
    page = await until(async () => browser.contexts()[0]?.pages().find(p => p.url().includes('index.html')), 30_000, 'the reopened window is missing')
    await page.setViewportSize({ width: 680, height: 720 })
    const title = flow === 'failed-update' ? 'Update failed · previous build opened' : 'Restarted on 1234567'
    const after = page.getByRole('dialog', { name: title, exact: true }); await after.waitFor({ timeout: 30_000 })
    const done = await until(async () => { const run = receipt(); return run.phase === 'complete' ? run : null }, 30_000, 'recovery did not complete')
    await page.screenshot({ path: join(f.out, `${flow}-after-680.png`) })
    if (flow === 'failed-update') assert(readFileSync(join(f.out, 'launcher-dialog-arguments'), 'utf8').includes('Open BMN'), "the launcher's own failed-update dialog was not shown")
    else assert(!existsSync(join(f.out, 'launcher-dialog-arguments')) || !readFileSync(join(f.out, 'launcher-dialog-arguments'), 'utf8').includes('BMN update failed'))
    const rows = await after.locator('.detail').allInnerTexts()
    for (const m of done.members) {
      assert.equal(m.stop, 'confirmed'); assert.equal(m.capture, 'saved'); assert.equal(m.resume, 'failed'); assert.equal(m.reason, 'not an agent session'); assert.equal(m.tell, 'not-told', 'nothing is typed into a session that was not resumed')
      const output = await page.evaluate(id => window.aiTerminal.getSavedOutput(id), m.sessionId)
      assert(output.current || output.history.length, `the output of ${m.name} is gone`)
    }
    assert.deepEqual(rows, done.members.map(() => 'Not resumed · not an agent session'))
    const listed = await page.evaluate(id => window.aiTerminal.listSessions(id), workspace.workspaceId)
    for (const m of done.members) assert(listed.find(s => s.sessionId === m.sessionId)?.lastProcess?.detail?.includes('update restart'), 'the stop is not recorded as an update restart')
    const cohort = await page.evaluate(() => window.aiTerminal.listInterruptedCohort())
    item.cohortCause = cohort?.cause ?? null
    await after.getByRole('button', { name: 'Close', exact: true }).click(); await after.waitFor({ state: 'hidden' })
    // Quit and Resume work as before: a stopped shell is started again by hand, and the app still answers.
    if (busy) await page.evaluate(id => window.aiTerminal.relaunchSession(id), busy.session.sessionId)
    assert.equal((await status(page)).run?.dismissed ?? true, true)
    item.rows = rows; item.result = 'PASS'; report.paths.push(item)
  } catch (error) {
    item.result = 'FAIL'; item.problem = error.message; report.paths.push(item); process.exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (current) { await current.app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await current.app.close().catch(() => {}) }
    item.cleanup = f.cleanup().result
    if (item.cleanup !== 'PASS') { item.result = 'FAIL'; process.exitCode = 1 }
  }
}
report.result = report.paths.length === flows.length && report.paths.every(path => path.result === 'PASS') ? 'PASS' : 'FAIL'
console.log(JSON.stringify(report, null, 2))
