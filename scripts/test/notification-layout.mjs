/* global window, document, innerWidth, innerHeight */
// Exercise long confirmations and real Archive Undo in narrow isolated Electron windows.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = process.env.BMN_NOTIFICATION_EVIDENCE ?? join(repo, '.dev-auto/evidence/cursor-launch/notifications')
mkdirSync(evidence, { recursive: true })
assert.ok(process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Use a private X display')
const failures = [], observations = []
let completed = false
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const fixture = join(root, 'notice-fixture.mjs')
  writeFileSync(fixture, `import {spawnSync} from 'node:child_process';
process.stdin.setRawMode(true);process.stdin.resume();
setTimeout(()=>spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(repo, 'apps/desktop/bin/bmn'))},'ask','notice-probe','Synthetic response'],{stdio:'ignore'}),200);
setInterval(()=>{},1000);`)
  const app = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), '--ozone-platform=x11', '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const ws = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const live = await page.evaluate(p => window.aiTerminal.createSession(p), {
      workspaceId: ws.workspaceId, name: 'Notification probe', cwd: root, executable: process.execPath,
      argv: [fixture], cols: 80, rows: 24
    })
    const longName = 'W'.repeat(120)
    const stopped = await page.evaluate(p => window.aiTerminal.createSession(p), {
      workspaceId: ws.workspaceId, name: 'Z'.repeat(120), cwd: root, executable: '/bin/bash',
      argv: ['--noprofile', '--norc'], cols: 80, rows: 24
    })
    await page.evaluate(id => window.aiTerminal.stopSession(id), stopped.session.sessionId)
    await page.reload()
    const select = async id => page.locator(`.session-row button[data-session-id="${id}"]`).click()
    const openEdit = async () => {
      await page.keyboard.press('Control+Shift+P')
      await page.locator('.command-palette input').fill('edit launch')
      await page.locator('.command-palette input').press('Enter')
      await page.getByRole('textbox', { name: 'Session name', exact: true }).waitFor()
    }
    const closePopover = async () => {
      if (await page.locator('.needs-you-popover').count()) {
        await page.locator('.needs-you-button').click()
        await page.locator('.needs-you-popover').waitFor({ state: 'detached' })
      }
    }
    const measure = async (width, stage, overlay) => {
      const observation = await page.evaluate(({ width, stage, overlay }) => {
        const brief = document.querySelector('.feedback-notice.brief'), text = brief.querySelector('span')
        const panel = document.querySelector(overlay), undo = brief.querySelector('button')
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } }
        const box = rect(brief), target = rect(panel), span = rect(text)
        const range = document.createRange(); range.selectNodeContents(text)
        const textRects = [...range.getClientRects()].map(r => ({ x: r.x, right: r.right }))
        const undoBox = undo ? rect(undo) : null
        const undoHit = !undo || undo.contains(document.elementFromPoint((undoBox.x + undoBox.right) / 2, (undoBox.y + undoBox.bottom) / 2))
        const inside = r => r.x >= -0.5 && r.right <= innerWidth + 0.5 && r.y >= -0.5 && r.bottom <= innerHeight + 0.5
        return { width, stage, box, target, span, textRects, undoBox, undoHit,
          viewport: inside(box) && (!undoBox || inside(undoBox)),
          overlayViewport: inside(target),
          fullTextPreserved: text.textContent.length >= 120 && text.title === text.textContent,
          textContained: textRects.every(r => r.x >= box.x - 0.5 && r.right <= box.right + 0.5) && span.bottom <= box.bottom + 0.5,
          noOverlap: box.right <= target.x || box.x >= target.right || box.bottom <= target.y || box.y >= target.bottom }
      }, { width, stage, overlay })
      observations.push(observation)
      for (const key of ['viewport', 'overlayViewport', 'fullTextPreserved', 'textContained', 'noOverlap', 'undoHit']) {
        if (!observation[key]) failures.push(`${width} ${stage}: ${key}`)
      }
      await page.screenshot({ path: join(evidence, `${width}-${stage}.png`) })
    }
    const stoppedRecord = async () => (await page.evaluate(id => window.aiTerminal.listSessions(id), ws.workspaceId))
      .find(s => s.sessionId === stopped.session.sessionId)
    const archived = async () => (await stoppedRecord()).archivedAt
    const waitForRestore = async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await archived() === null) return true
        await page.waitForTimeout(50)
      }
      return false
    }
    for (const width of [320, 400, 480, 800]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(0, 0); win.setContentSize(width, 500)
      }, width)
      await select(live.session.sessionId)
      await openEdit()
      await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(longName)
      await page.getByRole('button', { name: 'Save session', exact: true }).click()
      await page.locator('.feedback-notice.brief').waitFor()
      await page.locator('.needs-you-button').click()
      await measure(width, 'save-popover', '.needs-you-popover')
      await closePopover()
      await openEdit()
      await measure(width, 'save-drawer', '.session-launcher')
      await page.getByRole('button', { name: 'Cancel edit', exact: true }).click()
      for (const method of ['pointer', 'keyboard']) {
        // The sidebar's row menu is hidden in its narrow rail; create the real notice wide,
        // then test the notification and Undo at the requested narrow size.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 500))
        const row = page.locator('.session-row').filter({ has: page.locator(`button[data-session-id="${stopped.session.sessionId}"]`) })
        await row.locator('.row-menu-button').click()
        await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click()
        const undo = page.getByRole('button', { name: 'Undo', exact: true })
        await undo.waitFor(); await undo.focus()
        assert.ok(await archived(), 'Archive fixture did not archive')
        const beforeUndo = await stoppedRecord()
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 500), width)
        await page.locator('.needs-you-button').click()
        await measure(width, `undo-${method}`, '.needs-you-popover')
        // On a RED layout, report inaccessible Undo rather than blocking the other cases.
        if (observations.at(-1).viewport && observations.at(-1).undoHit) {
          if (method === 'pointer') {
            const before = await undo.boundingBox()
            const x = before.x + before.width / 2, y = before.y + before.height / 2
            await page.mouse.move(x, y); await page.mouse.down()
            await page.waitForTimeout(100)
            const after = await undo.boundingBox()
            observations.at(-1).pointerSequence = { before, after }
            if (Math.abs(before.x - after.x) > 0.5 || Math.abs(before.y - after.y) > 0.5) {
              failures.push(`${width} undo-pointer: button moved between pointer-down and pointer-up`)
            }
            await page.mouse.up()
          }
          else {
            await undo.focus()
            if (width === 400) {
              await page.waitForTimeout(6500)
              assert.equal(await undo.count(), 1, 'Focused Undo expired')
            }
            await page.keyboard.press('Enter')
          }
        } else {
          await closePopover()
          await undo.focus(); await page.keyboard.press('Enter')
        }
        const restoredByAction = await waitForRestore()
        observations.at(-1).restoredByAction = restoredByAction
        if (!restoredByAction) {
          failures.push(`${width} undo-${method}: archive was not restored`)
          // Keep RED evidence, then recover through the real keyboard action for later cases.
          await closePopover()
          await undo.focus(); await page.keyboard.press('Enter')
          assert.ok(await waitForRestore(), 'Could not restore the synthetic archive after the failed Undo probe')
        }
        const afterUndo = await stoppedRecord()
        assert.equal(afterUndo.revision, beforeUndo.revision + 1, 'Undo must restore exactly once')
        assert.deepEqual(afterUndo.lastProcess, beforeUndo.lastProcess, 'Undo changed the stopped process')
        await closePopover()
        const restoredView = await page.evaluate(async ({ workspaceId, sessionId }) => ({
          width: innerWidth, sessionId,
          restored: (await window.aiTerminal.listSessions(workspaceId)).find(s => s.sessionId === sessionId),
          rows: [...document.querySelectorAll('.session-row button[data-session-id]')].map(el => el.dataset.sessionId),
          tree: document.querySelector('.workspace-tree')?.outerHTML,
          notice: document.querySelector('.feedback-notice.brief')?.textContent
        }), { workspaceId: ws.workspaceId, sessionId: stopped.session.sessionId })
        writeFileSync(join(evidence, `${width}-${method}-restored.json`), JSON.stringify(restoredView, null, 2))
      }
    }
    await page.locator('.needs-you-button').click()
    await page.waitForTimeout(200)
    const terminal = () => page.evaluate(id => {
      const s = window.__aitermTest.snapshot(id)
      const r = document.querySelector(`.session-terminal[data-session-id="${id}"]`).getBoundingClientRect()
      return { cols: s.cols, rows: s.rows, ptyCols: s.ptyCols, ptyRows: s.ptyRows, refits: s.refits,
        inputEvents: s.inputEvents, modes: s.modes, rect: [r.x, r.y, r.width, r.height] }
    }, live.session.sessionId)
    const beforeExpiry = await terminal()
    await page.locator('.feedback-notice.brief').waitFor({ state: 'detached', timeout: 8000 })
    assert.deepEqual(await terminal(), beforeExpiry, 'Notice expiry changed terminal geometry or input')
    completed = true
    assert.deepEqual(failures, [])
    console.log('PASS: long confirmations remain contained; notices and pointer/keyboard Undo accessible at 320/400/480/800px')
  } finally {
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ completed, failures, observations }, null, 2))
    const page = (await app.windows())[0]
    await page?.evaluate(async () => { for (const ws of await window.aiTerminal.listWorkspaces(true)) for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {}) }).catch(() => {})
    await app.close()
  }
})
