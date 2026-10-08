/* global window, document */
// Visible archive/Undo and real OSC output on a disposable Electron stack.
import { toggleSessionRequests } from './session-request-helpers.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baseline = process.argv.includes('--baseline')
const evidence = join(repo, '.dev-auto/evidence/epic-47', baseline ? 'baseline' : 'runtime')
mkdirSync(evidence, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const fixture = join(root, 'notices.mjs'), trigger = join(root, 'emit'), input = join(root, 'input')
  writeFileSync(fixture, `import {existsSync,appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);
process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
process.stdout.write('synthetic notice fixture ready\\r\\n');let sent=false;
setInterval(()=>{if(sent||!existsSync(${JSON.stringify(trigger)}))return;sent=true;
process.stdout.write('\\x1b]9;4;1;');setTimeout(()=>{process.stdout.write('50\\x07\\x1b]9;4;2\\x1b\\\\');
setTimeout(()=>process.stdout.write('\\x1b]9;Real synthetic notice\\x07'),150)},30)},30);`)
  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const app = await _electron.launch({ chromiumSandbox: true, executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  })
  const result = { baseline }
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const workspace = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'Archive fixture', defaultCwd: root })
    const created = await page.evaluate(p => window.aiTerminal.createSession(p), {
      workspaceId: workspace.workspaceId, name: 'Live notice fixture', cwd: root, executable: process.execPath,
      argv: [fixture], cols: 100, rows: 30, backgroundChoice: 'stop'
    })
    const sid = created.session.sessionId
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
    await page.waitForFunction(id => window.__aitermTest?.snapshot(id)?.bufferLines.some(l => l.includes('synthetic notice fixture ready')), sid)
    const before = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
    await page.evaluate(id => { window.bmnArchiveTerminal = document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm`) }, sid)
    writeFileSync(trigger, '')
    let notices = []
    const deadline = Date.now() + 15000
    do {
      notices = await page.evaluate(async id => (await window.aiTerminal.listAttention()).filter(r => r.sessionId === id), sid)
      if (notices.some(r => `${r.title}\n${r.body ?? ''}`.includes('Real synthetic notice'))) break
      if (Date.now() >= deadline) throw new Error('Real PTY notice did not arrive')
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (!notices.some(r => `${r.title}\n${r.body ?? ''}`.includes('Real synthetic notice')))
    result.notices = notices.map(r => ({ title: r.title, body: r.body, openedBy: r.openedBy }))
    result.progressSuppressed = notices.length === 1 && notices[0].title === 'Real synthetic notice'
    const archive = await page.evaluate(async ws => {
      try { return { archived: await window.aiTerminal.updateWorkspace({ workspaceId: ws.workspaceId, expectedRevision: ws.revision, archived: true }) } }
      catch (error) { return { refusal: error.message } }
    }, workspace)
    result.liveArchiveRefused = !!archive.refusal
    result.refusal = archive.refusal
    if (archive.archived) await page.evaluate(ws => window.aiTerminal.updateWorkspace({ workspaceId: ws.workspaceId, expectedRevision: ws.revision, archived: false }), archive.archived)
    if (baseline) { await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click() }
    const after = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
    if (!baseline) {
      assert.equal(before.cols, after.cols); assert.equal(before.rows, after.rows)
      assert.equal(await page.evaluate(id => window.bmnArchiveTerminal === document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm`), sid), true)
      assert.equal((await page.evaluate(ws => window.aiTerminal.listSessions(ws), workspace.workspaceId)).find(s => s.sessionId === sid).lastProcess.incarnationId, created.startup.incarnationId)
      await page.getByRole('button', { name: 'Actions for Archive fixture', exact: true }).click()
      assert.equal(await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).isDisabled(), true)
      await page.keyboard.press('Escape')
      await toggleSessionRequests(page)
      await page.locator('.attention-item').filter({ hasText: 'Real synthetic notice' }).waitFor()
      await page.keyboard.press('Escape')
    }
    assert.equal(readFileSync(input, 'utf8'), '')
    result.noInput = true
    await page.screenshot({ path: join(evidence, 'notices.png') })
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    assert.equal(result.progressSuppressed, true, 'OSC progress opened attention')
    assert.equal(result.liveArchiveRefused, true, 'Workspace archive hid a live session')
    assert.match(result.refusal, /Live notice fixture/)
    if (!baseline) {
      // Keep the live sibling selected: archive/Undo only changes list visibility.
      const stopped = await page.evaluate(p => window.aiTerminal.createSession(p), {
        workspaceId: workspace.workspaceId, name: 'Stopped Undo fixture', cwd: root, executable: '/bin/sh', argv: ['-c', 'sleep 60'], cols: 80, rows: 24
      })
      await page.evaluate(id => window.aiTerminal.stopSession(id), stopped.session.sessionId)
      await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
      const undoSid = stopped.session.sessionId
      const menu = () => page.getByRole('button', { name: 'Actions for Stopped Undo fixture', exact: true })
      await menu().click(); await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click()
      const undo = page.locator('.feedback-notice.brief').getByRole('button', { name: 'Undo', exact: true })
      await undo.waitFor(); await undo.focus()
      await page.waitForTimeout(6200)
      assert.equal(await undo.isVisible(), true, 'Focused Undo expired')
      await page.keyboard.press('Enter')
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Restored Stopped Undo fixture.' }).waitFor()
      const sessionRestored = (await page.evaluate(ws => window.aiTerminal.listSessions(ws), workspace.workspaceId)).find(s => s.sessionId === undoSid)
      assert.equal(sessionRestored.archivedAt, null)
      assert.equal(sessionRestored.lastProcess.state, 'exited')
      await page.locator(`.session-row > button[data-session-id="${undoSid}"]`).waitFor()
      assert.equal(await page.locator(`.session-terminal.selected[data-session-id="${sid}"]`).count(), 1)
      // A stale target must not override a rename or perform two restores.
      await menu().click(); await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click(); await undo.waitFor()
      const archivedSession = (await page.evaluate(ws => window.aiTerminal.listSessions(ws), workspace.workspaceId)).find(s => s.sessionId === undoSid)
      await page.evaluate(s => window.aiTerminal.updateSession({ sessionId: s.sessionId, expectedRevision: s.revision, name: 'Newer saved name' }), archivedSession)
      await undo.click()
      await page.locator('.feedback-notice.brief').filter({ hasText: 'That archive changed' }).waitFor()
      assert.ok((await page.evaluate(ws => window.aiTerminal.listSessions(ws), workspace.workspaceId)).find(s => s.sessionId === undoSid).archivedAt)
      const empty = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'Stopped workspace Undo', defaultCwd: root })
      await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
      await page.getByRole('button', { name: 'Actions for Stopped workspace Undo', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click(); await undo.waitFor()
      await undo.evaluate(el => { el.click(); el.click() })
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Restored Stopped workspace Undo.' }).waitFor()
      const restoredWorkspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces(true))).find(w => w.workspaceId === empty.workspaceId)
      assert.equal(restoredWorkspace.archivedAt, null); assert.equal(restoredWorkspace.revision, empty.revision + 2)
      const first = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'First Undo target', defaultCwd: root })
      const second = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'Second Undo target', defaultCwd: root })
      await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
      await page.getByRole('button', { name: 'Actions for First Undo target', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click(); await undo.waitFor()
      await app.evaluate(({ ipcMain }, id) => {
        const channel = 'aiterm:workspace:update', handler = ipcMain._invokeHandlers.get(channel)
        let release; const held = new Promise(resolve => { release = resolve })
        globalThis.bmnUndoDelay = { channel, handler, release }
        ipcMain._invokeHandlers.set(channel, async (event, params) => {
          const result = await handler(event, params)
          if (params.workspaceId === id && params.archived === true) await held
          return result
        })
      }, second.workspaceId)
      await page.getByRole('button', { name: 'Actions for Second Undo target', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click(); await undo.focus()
      await app.evaluate(({ ipcMain }) => { const delay = globalThis.bmnUndoDelay; ipcMain._invokeHandlers.set(delay.channel, delay.handler); delay.release() })
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Archived Second Undo target.' }).waitFor()
      await page.waitForTimeout(6200); assert.equal(await undo.isVisible(), true, 'Replacing Undo lost its focused expiry protection')
      await undo.press('Enter')
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Restored Second Undo target.' }).waitFor()
      const replacementTargets = await page.evaluate(() => window.aiTerminal.listWorkspaces(true))
      assert.ok(replacementTargets.find(w => w.workspaceId === first.workspaceId).archivedAt)
      assert.equal(replacementTargets.find(w => w.workspaceId === second.workspaceId).archivedAt, null)
      const sameFirst = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'Same Undo name', defaultCwd: root })
      const sameSecond = await page.evaluate(p => window.aiTerminal.createWorkspace(p), { name: 'Same Undo name', defaultCwd: root })
      await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
      const sameActions = page.getByRole('button', { name: 'Actions for Same Undo name', exact: true })
      await sameActions.first().click()
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click(); await undo.waitFor()
      await page.waitForTimeout(4500)
      await sameActions.last().click()
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click(); await undo.waitFor()
      // Neither action is focused: the newer identical message must get a fresh six seconds.
      await page.waitForTimeout(2200)
      assert.equal(await undo.isVisible(), true, 'Same-name replacement inherited the previous Undo deadline')
      await undo.click()
      const sameRecords = await page.evaluate(() => window.aiTerminal.listWorkspaces(true))
      assert.ok(sameRecords.find(w => w.workspaceId === sameFirst.workspaceId).archivedAt)
      assert.equal(sameRecords.find(w => w.workspaceId === sameSecond.workspaceId).archivedAt, null)
      // A menu opened before admission is a real stale owner path: the host must refuse it visibly.
      await page.getByRole('button', { name: 'Actions for Stopped workspace Undo', exact: true }).click()
      const blocker = await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: empty.workspaceId,
        name: 'Menu race blocker', cwd: root, executable: '/bin/sh', argv: ['-c', 'sleep 60'], cols: 80, rows: 24 })
      const beforeRefusal = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
      await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).focus(); await page.keyboard.press('Enter')
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Menu race blocker' }).waitFor()
      const afterRefusal = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
      assert.equal(afterRefusal.cols, beforeRefusal.cols); assert.equal(afterRefusal.rows, beforeRefusal.rows)
      const liveSessionRefusal = await page.evaluate(async s => {
        try { await window.aiTerminal.updateSession({ sessionId: s.sessionId, expectedRevision: s.revision, archived: true }); return null }
        catch (error) { return error.message }
      }, blocker.session)
      assert.match(liveSessionRefusal, /Menu race blocker/)
      // Seed legacy saved state directly in this disposable database, never through a bypassing API.
      const Db = createRequire(join(repo, 'apps/desktop/package.json'))('better-sqlite3')
      const legacyDb = new Db(join(roots.data, 'bmn/state.sqlite3'))
      try { legacyDb.prepare('UPDATE workspace SET archived_at = ?, revision = revision + 1 WHERE workspace_id = ?').run('2026-10-01T00:00:00.000Z', empty.workspaceId) }
      finally { legacyDb.close() }
      await page.reload(); await page.getByRole('checkbox', { name: 'Show archived' }).check()
      await page.getByRole('button', { name: 'Actions for Stopped workspace Undo', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Restore workspace', exact: true }).click()
      await page.locator('.feedback-notice.brief').filter({ hasText: 'Restored Stopped workspace Undo.' }).waitFor()
      assert.equal((await page.evaluate(id => window.aiTerminal.listSessions(id), empty.workspaceId)).find(s => s.sessionId === blocker.session.sessionId).lastProcess.incarnationId, blocker.startup.incarnationId)
      assert.equal(readFileSync(input, 'utf8'), '')
      result.undo = { session: true, workspace: true, keyboard: true, focusedExpiry: true, staleRefused: true, duplicateOnce: true, selectionPreserved: true, noInput: true }
      result.visibleHostRefusal = true; result.liveSessionArchiveRefused = true; result.legacyLiveWorkspaceRestored = true
      result.focusedUndoReplacement = true
      result.sameNameUndoReplacement = true
      await page.screenshot({ path: join(evidence, 'undo.png') })
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    }
  } finally {
    const page = (await app.windows())[0]
    if (page) await page.evaluate(async () => {
      for (const ws of await window.aiTerminal.listWorkspaces(true)) for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {})
    }).catch(() => {})
    await app.close()
  }
})
console.log('Safe archive / notices runtime PASS')
