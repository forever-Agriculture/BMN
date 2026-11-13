/* global window */
// MODULE: update-restart.mjs - the restart owner path on an isolated Electron instance and a stub launcher
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createUpdateRestartFixture } from './update-restart-fixture.mjs'
const { out, roots, stateDir, launch, launches } = createUpdateRestartFixture()
let current
try {
  current = await launch(['--', '/bin/bash', '--noprofile', '--norc'])
  let { app, page } = current
  await page.waitForSelector('.session-row', { timeout: 30_000 })
  assert.equal((await page.evaluate(() => window.aiTerminal.updateRestart('status'))).waitingBuild, null)
  writeFileSync(join(stateDir, 'latest.json'), JSON.stringify({ phase: 'waiting-for-exit', commit: '1234567890abcdef', updatedAt: new Date().toISOString() }))
  await page.evaluate(() => window.aiTerminal.quitApplication())
  const preview = page.getByRole('dialog', { name: 'Restart for the update?', exact: true })
  await preview.waitFor(); await page.screenshot({ path: join(out, 'preview-680.png') })
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await preview.waitFor({ state: 'hidden' })
  const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
  const created = await page.evaluate(({ workspaceId, cwd }) => window.aiTerminal.createSession({ workspaceId, name: 'Synthetic working', cwd, executable: '/bin/bash', argv: ['--noprofile', '--norc', '-c', 'while true; do echo synthetic-restart-output; sleep 0.2; done'], cols: 80, rows: 24 }), { workspaceId: workspace.workspaceId, cwd: out })
  if (process.argv.includes('--deadline')) {
    for (let i = 0; i < 10; i++) await page.evaluate(({ workspaceId, cwd, name }) => window.aiTerminal.createSession({ workspaceId, name, cwd, executable: '/bin/bash', argv: ['--noprofile', '--norc', '-c', 'while true; do echo synthetic-deadline; sleep 0.5; done'], cols: 80, rows: 24 }), { workspaceId: workspace.workspaceId, cwd: out, name: `Synthetic worker ${i}` })
  }
  // Test-created sessions are normally adopted by the UI create flow; recover its renderer through its ordinary reload.
  await page.reload(); await page.waitForSelector('.session-row', { timeout: 30_000 })
  await page.evaluate(() => window.aiTerminal.quitApplication()); await preview.waitFor()
  await preview.getByRole('button', { name: 'Restart', exact: true }).click()
  const waiting = page.getByRole('dialog', { name: /Restarting · closes by/ })
  await waiting.waitFor(); await page.screenshot({ path: join(out, 'waiting-680.png') })
  await waiting.getByRole('button', { name: 'Cancel', exact: true }).click()
  // Shell sessions get no notice, so Cancel leaves nobody to list and the dialog closes by itself (Epic 125 D4).
  await waiting.waitFor({ state: 'hidden' })
  await page.locator('dialog[open]').first().waitFor({ state: 'hidden' })
  assert.equal((await page.evaluate(() => window.aiTerminal.updateRestart('status'))).run?.phase ?? 'cancelled', 'cancelled')
  await page.reload(); await page.waitForSelector('.session-row', { timeout: 30_000 })
  await page.evaluate(() => window.aiTerminal.quitApplication()); await preview.waitFor()
  const restartPressedAt = Date.now()
  await preview.getByRole('button', { name: 'Restart', exact: true }).click(); await waiting.waitFor()
  const deadlineCase = process.argv.includes('--deadline')
  const pressed = restartPressedAt
  const exited = new Promise(resolve => app.process().once('exit', resolve))
  if (!deadlineCase) await waiting.getByRole('button', { name: 'Restart now', exact: true }).click()
  let exitTimer
  try { await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('isolated BMN did not exit')), deadlineCase ? 305_000 : 30_000) })]) } finally { clearTimeout(exitTimer) }
  const exitElapsedMs = Date.now() - pressed
  if (deadlineCase) assert(exitElapsedMs <= 300_000, `deadline exceeded: ${exitElapsedMs}ms`)
  writeFileSync(join(out, 'exit-timing.json'), JSON.stringify({ deadlineCase, exitElapsedMs, limitMs: 300_000 }))
  current = null
  assert(existsSync(join(out, 'launcher-armed')))
  const receipt = JSON.parse(readFileSync(join(roots.data, 'bmn/update-restart.json'), 'utf8'))
  assert.equal(receipt.phase, 'closing'); assert(receipt.members.some(m => m.sessionId === created.session.sessionId))
  writeFileSync(join(stateDir, 'latest.json'), JSON.stringify({ phase: 'complete', commit: '1234567890abcdef' }))
  current = await launch(); ({ app, page } = current)
  const after = page.getByRole('dialog', { name: 'Restarted on 1234567', exact: true })
  await after.waitFor({ timeout: 30_000 }); await page.screenshot({ path: join(out, 'after-680.png') })
  const sessions = await page.evaluate(id => window.aiTerminal.listSessions(id), workspace.workspaceId)
  const stopped = sessions.find(s => s.sessionId === created.session.sessionId)
  assert(stopped?.lastProcess?.detail?.includes('update restart'))
  await after.getByRole('button', { name: 'Close', exact: true }).click()
  await page.evaluate(id => window.aiTerminal.relaunchSession(id), created.session.sessionId)
  const result = { result: 'PASS', scope: `isolated Electron preview, Cancel, ${deadlineCase ? 'twelve-session five-minute deadline' : 'Restart now'}, persisted update interruption and manual recovery; stub launcher arming and PID wait; automatic relaunch/real-agent proof remains separate`, out, launches }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} finally {
  if (current) { await current.app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await current.app.close().catch(() => {}) }
}
