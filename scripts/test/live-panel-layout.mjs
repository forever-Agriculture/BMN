/* global window, document */
// Drive launch editing on a real PTY: opening utility drawers must preserve a live TUI's grid.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-54/live-panels')
mkdirSync(evidence, { recursive: true })
const wayland = process.env.WAYLAND_DISPLAY && !isAbsolute(process.env.WAYLAND_DISPLAY)
  ? join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : process.env.WAYLAND_DISPLAY
const failures = []
const observations = []
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const application = await _electron.launch({
    executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'), BMN_LAUNCH_CWD: root,
      ...(wayland ? { WAYLAND_DISPLAY: wayland } : {}) }
  })
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const receiver = join(root, 'screen.mjs')
    // An inline TUI can leave old rows on screen while redrawing its prompt after SIGWINCH.
    writeFileSync(receiver, `process.stdin.setRawMode(true);process.stdin.resume();\nconst line='LIVE PANEL SCREEN '+ '0123456789 '.repeat(18);\nsetTimeout(()=>process.stdout.write('\\x1b[2J\\x1b[H'+Array.from({length:12},()=>line).join('\\r\\n')),500);\nprocess.on('SIGWINCH',()=>process.stdout.write('\\x1b[16;1HPROMPT '+String(process.stdout.columns)+' columns'));\nsetInterval(()=>{},1000);`)
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const session = await page.evaluate(params => window.aiTerminal.createSession(params), {
      workspaceId: workspace.workspaceId, name: 'Live panel audit', cwd: root,
      executable: process.execPath, argv: [receiver], cols: 80, rows: 24
    })
    const id = session.session.sessionId
    await page.reload()
    await page.locator(`.session-row button[data-session-id="${id}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(line => line.includes('LIVE PANEL SCREEN')), id)
    const snapshot = () => page.evaluate(id => {
      const pane = document.querySelector(`.session-terminal[data-session-id="${id}"]`)
      const box = pane.querySelector('.terminal-surface').getBoundingClientRect()
      const s = window.__aitermTest.snapshot(id)
      const panes = [...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')].map(el => {
        const snapshot = window.__aitermTest.snapshot(el.getAttribute('data-session-id'))
        const box = el.querySelector('.terminal-surface').getBoundingClientRect()
        return { id: el.getAttribute('data-session-id'), cols: snapshot.cols, rows: snapshot.rows,
          ptyCols: snapshot.ptyCols, ptyRows: snapshot.ptyRows, refits: snapshot.refits,
          inputEvents: snapshot.inputEvents, modes: snapshot.modes, surface: [box.x, box.y, box.width, box.height] }
      })
      return { ...s, surface: [box.x, box.y, box.width, box.height], panes }
    }, id)
    const settle = () => page.waitForTimeout(200)
    const openEdit = async () => {
      await page.getByRole('button', { name: 'More actions for Live panel audit', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: 'Edit launch settings', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('complementary', { name: 'Edit session', exact: true }).waitFor()
      await settle()
      if (!await page.getByRole('textbox', { name: 'Session name', exact: true }).evaluate(el => el === document.activeElement)) {
        failures.push('Opening Edit does not focus Session name')
      }
    }
    const check = async (before, stage, width, height) => {
      await settle()
      const after = await snapshot()
      const changed = ['cols', 'rows', 'ptyCols', 'ptyRows', 'refits', 'inputEvents'].filter(key => before[key] !== after[key])
      if (JSON.stringify(before.surface) !== JSON.stringify(after.surface)) changed.push('surface')
      if (JSON.stringify(before.modes) !== JSON.stringify(after.modes)) changed.push('modes')
      if (JSON.stringify(before.panes) !== JSON.stringify(after.panes)) changed.push('visible panes')
      observations.push({ width, height, stage, changed, before, after })
      if (changed.length) failures.push(`${width}×${height} ${stage}: ${changed.join(', ')}`)
    }
    for (const layout of process.argv.includes('--archive-only') ? [] : ['normal', 'focus', 'split']) {
      if (layout === 'focus') await page.keyboard.press('Control+Shift+Z')
      if (layout === 'split') {
        await page.keyboard.press('Control+Shift+Z')
        await page.keyboard.press('Control+Shift+Enter')
        await page.locator('dialog[open]').getByRole('option').first().click()
        await page.locator(`.session-terminal[data-session-id="${id}"] .pane-heading strong`).click()
        await settle()
        assert.equal(await page.locator('.session-terminal:not(.session-terminal-hidden)').count(), 2)
      }
    for (const [width, height] of [[1699, 1353], [1280, 900], [1000, 700], [800, 500]]) {
      await application.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(0, 0); win.setContentSize(...size)
      }, [width, height])
      await settle()
      const before = await snapshot()
      await openEdit()
      await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Unsaved edit')
      await check(before, `${layout} edit open and type`, width, height)
      await page.screenshot({ path: join(evidence, `${layout}-edit-open-${width}.png`) })
      await page.getByRole('button', { name: 'Close edit session', exact: true }).or(page.getByRole('button', { name: 'Close new session', exact: true })).click()
      await check(before, `${layout} edit close`, width, height)
      if (!await page.getByRole('button', { name: 'More actions for Live panel audit', exact: true }).evaluate(el => el === document.activeElement)) {
        failures.push(`${layout} edit close does not restore opener focus`)
      }
      await page.screenshot({ path: join(evidence, `${layout}-edit-closed-${width}.png`) })
      await openEdit()
      await page.getByRole('button', { name: 'Cancel edit', exact: true }).click()
      const closed = await page.locator('.session-launcher').count() === 0
      observations.push({ width, height, stage: 'cancel edit', closed })
      if (!closed) {
        failures.push(`${width}×${height} Cancel edit leaves the launcher open`)
        await page.getByRole('button', { name: 'Close new session', exact: true }).click()
      }
      await check(before, `${layout} cancel edit`, width, height)
      await page.getByRole('button', { name: 'More actions for Live panel audit', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Session details', exact: true }).click()
      await check(before, `${layout} details open`, width, height)
      await page.getByRole('button', { name: 'Close session details', exact: true }).click()
      await check(before, `${layout} details close`, width, height)
      await page.keyboard.press('Control+Shift+P')
      await page.locator('dialog[open] input').fill('New session')
      await page.getByRole('option').filter({ has: page.locator('.label', { hasText: /^New session…$/ }) }).click()
      await check(before, `${layout} new session open`, width, height)
      await page.getByRole('button', { name: 'Close new session', exact: true }).click()
      await check(before, `${layout} new session close`, width, height)
      await openEdit()
      await page.getByRole('button', { name: 'Save session', exact: true }).click()
      await page.locator('.session-launcher').waitFor({ state: 'hidden' })
      await check(before, `${layout} save edit`, width, height)
    }
    }
    if (await page.locator('.session-area.split').count()) await page.keyboard.press('Control+Shift+Enter')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900))
    const archiveWorkspace = await page.evaluate(params => window.aiTerminal.createWorkspace(params), {
      name: 'Archive selected audit', defaultCwd: root
    })
    const archiveSession = await page.evaluate(params => window.aiTerminal.createSession(params), {
      workspaceId: archiveWorkspace.workspaceId, name: 'Archive selected session', cwd: root,
      executable: '/bin/bash', argv: ['--noprofile', '--norc'], cols: 80, rows: 24
    })
    await page.evaluate(id => window.aiTerminal.stopSession(id), archiveSession.session.sessionId)
    await page.reload()
    await page.locator(`.session-row button[data-session-id="${archiveSession.session.sessionId}"]`).click()
    await page.locator('.stopped-session').waitFor()
    await page.getByRole('button', { name: 'Actions for Archive selected audit', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Archive workspace', exact: true }).click()
    await page.locator('.feedback-notice.brief').filter({ hasText: 'Archived Archive selected audit.' }).waitFor()
    await settle()
    if (await page.getByRole('heading', { name: 'Archive selected session', exact: true }).count()) failures.push('Archiving selected workspace leaves its hidden session selected')
    await page.getByRole('checkbox', { name: 'Show archived', exact: true }).check()
    await page.locator(`.session-row button[data-session-id="${archiveSession.session.sessionId}"]`).click()
    if (!await page.getByRole('button', { name: 'Start again', exact: true }).isDisabled()) failures.push('Archived workspace offers an enabled Start again')
    await page.getByRole('button', { name: 'Actions for Archive selected session', exact: true }).click()
    if (!await page.getByRole('menuitem', { name: 'Start again', exact: true }).isDisabled()) failures.push('Archived workspace session menu offers an enabled Start again')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Actions for Archive selected audit', exact: true }).click()
    if (!await page.getByRole('menuitem', { name: 'New session here', exact: true }).isDisabled()) failures.push('Archived workspace menu offers enabled New session here')
    await page.keyboard.press('Escape')
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ failures, observations }, null, 2))
    assert.deepEqual(failures, [], failures.join('\n'))
    console.log('PASS: Edit/New/Details keep every live pane stable in normal/focus/split at four sizes; keyboard focus, Save/Cancel and archive selection checked')
  } finally {
    const page = (await application.windows())[0]
    await page?.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces(true)) {
        for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) {
          await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
        }
      }
    }).catch(() => {})
    await application.close()
  }
})
