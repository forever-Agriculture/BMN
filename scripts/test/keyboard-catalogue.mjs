/* global window, document */
// Epic 55: real Electron catalogue, addressed editing and response-card keyboard navigation.
// Run on a private X display after building; all sessions and requests are synthetic.
import { sessionRequestControl } from './session-request-helpers.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-55/runtime')
mkdirSync(evidence, { recursive: true })
assert.ok(process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Use a private X display')
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const fixture = join(root, 'fixture.mjs')
  const cli = join(repo, 'apps/desktop/bin/bmn')
  writeFileSync(fixture, `import {appendFileSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const base=process.argv[2];writeFileSync(base+'.input','');process.stdin.setRawMode(true);
process.stdin.on('data',b=>appendFileSync(base+'.input',b));process.stdout.write('keyboard fixture ready\\r\\n');
setInterval(()=>{if(!existsSync(base+'.command'))return;const command=JSON.parse(readFileSync(base+'.command','utf8'));unlinkSync(base+'.command');
const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...command.args],{encoding:'utf8',input:command.input});
writeFileSync(base+'.result',JSON.stringify({key:command.key,status:r.status,error:r.stderr}));},25);`)
  const app = await _electron.launch({ chromiumSandbox: true, executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), '--ozone-platform=x11', '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root }
  })
  const result = { catalogue: false, editing: [], details: [], attention: false }
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const north = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const south = await page.evaluate(cwd => window.aiTerminal.createWorkspace({ name: 'Q-Automations South', defaultCwd: cwd }), root)
    const create = async (workspaceId, name, key) => page.evaluate(p => window.aiTerminal.createSession(p), {
      workspaceId, name, cwd: root, executable: process.execPath, argv: [fixture, join(root, key)], cols: 100, rows: 30
    })
    const a = await create(north.workspaceId, 'Q-Automations', 'north')
    const b = await create(south.workspaceId, 'Q-Automations', 'south')
    // The isolated cwd itself includes "bmn", a valid literal context match for every row.
    const incidental = await create(north.workspaceId, 'Quick Test Map', 'incidental')
    const exact = await create(north.workspaceId, 'QTM', 'exact')
    for (let i = 0; i < 21; i++) {
      const row = await create(i % 2 ? south.workspaceId : north.workspaceId, `Stopped catalogue ${i}`, `stopped-${i}`)
      await page.evaluate(id => window.aiTerminal.stopSession(id), row.session.sessionId)
    }
    await page.reload()
    const select = async id => page.locator(`.session-row > button[data-session-id="${id}"]`).click()
    await select(a.session.sessionId)
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(line => line.includes('keyboard fixture ready')), a.session.sessionId)
    const openPalette = async () => { await page.keyboard.press('Control+Shift+P'); await page.waitForSelector('.command-palette') }
    const search = page.locator('.command-palette input')
    const selected = () => search.getAttribute('aria-activedescendant')
    await openPalette(); await search.fill('qat')
    const sessionRows = page.locator('.palette-results [data-group="Sessions"]')
    assert.equal(await sessionRows.count(), 2)
    assert.ok((await sessionRows.nth(1).innerText()).includes('Q-Automations South'))
    assert.equal(await page.locator('.palette-results [data-group="Workspaces"]').count(), 1)
    await search.press('ArrowDown')
    assert.equal(await selected(), `palette-session-${b.session.sessionId}`)
    await search.fill('automations')
    assert.equal(await selected(), `palette-session-${b.session.sessionId}`, 'Filtering lost surviving selected ID')
    const update = async (id, changes) => page.evaluate(async ({ id, changes }) => {
      const workspaces = await window.aiTerminal.listWorkspaces(true)
      for (const workspace of workspaces) {
        const session = (await window.aiTerminal.listSessions(workspace.workspaceId)).find(s => s.sessionId === id)
        if (session) return window.aiTerminal.updateSession({ sessionId: id, expectedRevision: session.revision, ...changes })
      }
      throw new Error('Missing fixture session')
    }, { id, changes })
    await update(b.session.sessionId, { name: 'Q-Automations renamed' })
    await page.locator(`#palette-session-${b.session.sessionId}`).filter({ hasText: 'renamed' }).waitFor()
    assert.equal(await selected(), `palette-session-${b.session.sessionId}`)
    await search.fill('qtm')
    const ranked = await sessionRows.evaluateAll(rows => rows.map(row => row.id))
    assert.equal(ranked[0], `palette-session-${exact.session.sessionId}`)
    assert.ok(ranked.indexOf(`palette-session-${incidental.session.sessionId}`) > 0)
    await search.fill('stopped catalogue')
    assert.equal(await sessionRows.count(), 21)
    const removedId = (await sessionRows.first().getAttribute('id')).replace('palette-session-', '')
    const successorId = await sessionRows.nth(1).getAttribute('id')
    await sessionRows.first().hover()
    await update(removedId, { archived: true })
    await page.locator(`#palette-session-${removedId}`).waitFor({ state: 'detached' })
    assert.equal(await selected(), successorId, 'Removed highlight did not select its surviving successor')
    await search.fill('zero-result-xyz'); assert.equal(await sessionRows.count(), 0)
    await page.keyboard.press('Escape')
    assert.equal(readFileSync(join(root, 'north.input'), 'utf8'), '')
    assert.equal(readFileSync(join(root, 'south.input'), 'utf8'), '')
    result.catalogue = true

    const snapshot = () => page.evaluate(() => [...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')].map(pane => {
      const id = pane.dataset.sessionId, s = window.__aitermTest.snapshot(id), r = pane.querySelector('.terminal-surface').getBoundingClientRect()
      return { id, cols: s.cols, rows: s.rows, ptyCols: s.ptyCols, ptyRows: s.ptyRows,
        inputEvents: s.inputEvents, refits: s.refits, modes: s.modes, rect: [r.x, r.y, r.width, r.height] }
    }))
    for (const mode of ['normal', 'focus', 'split']) {
      if (mode === 'focus') await page.keyboard.press('Control+Shift+Z')
      if (mode === 'split') {
        await page.keyboard.press('Control+Shift+Z')
        await page.keyboard.press('Control+Shift+Enter')
        await page.locator(`#palette-split-${b.session.sessionId}`).click()
        await page.locator(`.session-terminal[data-session-id="${b.session.sessionId}"] .pane-heading`).click()
      }
      for (const [width, height] of [[1280, 900], [800, 500]]) {
        await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(0, 0); win.setContentSize(...size) }, [width, height])
        await page.waitForTimeout(250)
        const target = mode === 'split' ? b : a
        const before = await snapshot()
        if (mode === 'split' && width === 1280) {
          const title = await page.title()
          const row = page.locator('.session-row').filter({ has: page.locator(`button[data-session-id="${target.session.sessionId}"]`) })
          await row.locator('.row-menu-button').click()
          await page.getByRole('menuitem', { name: 'Session details', exact: true }).click()
          await page.getByRole('button', { name: 'Close session details', exact: true }).waitFor()
          await page.waitForTimeout(250)
          assert.deepEqual(await snapshot(), before, 'Sidebar Details disturbed the cross-workspace split')
          assert.equal(await page.title(), title, 'Sidebar Details changed the active workspace')
          await page.getByRole('button', { name: 'Close session details', exact: true }).click()
          assert.deepEqual(await snapshot(), before, 'Closing sidebar Details disturbed the split')
          result.details.push({ crossWorkspaceSidebar: true, gridsInputModesWorkspacePreserved: true })
        }
        const opener = page.getByRole('button', { name: 'Command palette', exact: true }); await opener.focus()
        await openPalette(); await search.fill('edit launch')
        const action = page.locator(`#palette-edit-launch-${target.session.sessionId}`)
        assert.ok((await action.innerText()).includes(mode === 'split' ? south.name : north.name))
        await search.press('Enter')
        const name = page.getByRole('textbox', { name: 'Session name', exact: true })
        await name.waitFor(); assert.ok(await name.evaluate(el => el === document.activeElement))
        if (width === 800) await page.screenshot({ path: join(evidence, `editor-open-${mode}.png`) })
        const savedName = await name.inputValue()
        await name.fill('Cancelled synthetic edit')
        await page.getByRole('button', { name: 'Cancel edit', exact: true }).click()
        assert.ok(await opener.evaluate(el => el === document.activeElement), 'Cancel lost palette opener')
        await openPalette(); await search.fill('edit launch'); await search.press('Enter')
        assert.equal(await name.inputValue(), savedName)
        await name.fill(`${savedName} saved`)
        await page.getByRole('button', { name: 'Save session', exact: true }).click()
        await page.waitForSelector('.session-launcher', { state: 'detached' })
        assert.ok(await opener.evaluate(el => el === document.activeElement), 'Save lost palette opener')
        assert.deepEqual(await snapshot(), before, 'Palette editing disturbed visible terminal grids/input')
        const stored = await page.evaluate(async ({ ws, id }) => (await window.aiTerminal.listSessions(ws)).find(s => s.sessionId === id), { ws: target.session.workspaceId, id: target.session.sessionId })
        assert.equal(stored.lastProcess.incarnationId, target.startup.incarnationId)
        assert.equal(stored.name, `${savedName} saved`)
        await page.screenshot({ path: join(evidence, `edit-${mode}-${width}.png`) })
        result.editing.push({ mode, width, height, sessionId: target.session.sessionId, gridsInputIncarnationFocus: true })
      }
    }
    const emit = async (base, key, args, input) => {
      writeFileSync(join(root, `${base}.command`), JSON.stringify({ key, args, input }))
      for (let i = 0; i < 200; i++) {
        try {
          const response = JSON.parse(readFileSync(join(root, `${base}.result`), 'utf8'))
          if (response.key === key) { assert.equal(response.status, 0, response.error); return }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        await page.waitForTimeout(25)
      }
      throw new Error(`Fixture did not publish ${key}`)
    }
    const choices = JSON.stringify({ options: [{ label: 'First', description: null }, { label: 'Second', description: null }] })
    for (let i = 0; i < 12; i++) await emit(i % 2 ? 'south' : 'north', `manual-${i}`, ['ask', `manual-${i}`, `Synthetic decision ${i}`, '--choices-json', choices])
    await emit('north', 'native', ['hook', 'codex'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'functions.request_user_input_async', tool_use_id: 'synthetic-native',
      tool_input: { questions: [{ title: 'Synthetic native choice', options: ['First', 'Second'] }] } }))
    // Produce a fresh real confirmation, then prove it leaves the response actions readable.
    await openPalette(); await search.fill('edit launch'); await search.press('Enter')
    await page.getByRole('button', { name: 'Save session', exact: true }).click()
    await page.locator('.feedback-notice.brief').waitFor()
    await select(a.session.sessionId)
    const opener = await sessionRequestControl(page, a.session.sessionId)
    await opener.focus(); await page.keyboard.press('Enter')
    const card = page.locator('.session-request-card')
    await card.waitFor()
    const toast = await page.locator('.feedback-notice.brief').boundingBox()
    const bounds = await card.boundingBox()
    assert.ok(toast.x + toast.width <= bounds.x || toast.y >= bounds.y + bounds.height ||
      toast.y + toast.height <= bounds.y, 'Confirmation covers response actions')
    const nav = card.locator('article .actions button.primary')
    assert.equal(await nav.count(), 7) // six north manual requests and its native question
    await nav.nth(4).focus()
    const identity = await nav.nth(4).evaluate(button => button.closest('article').dataset.requestId)
    await emit('north', 'incoming', ['ask', 'incoming', 'New synthetic request'])
    assert.equal(await page.evaluate(() => document.activeElement.closest('article').dataset.requestId), identity, 'Arrival stole focus')
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement.textContent === 'Mark answered'))
    const request = (await page.evaluate(() => window.aiTerminal.listAttention())).find(row => row.requestId === identity)
    await page.evaluate(r => window.aiTerminal.resolveAttention(r.requestId, 'Synthetic removal', { kind: r.kind, revision: r.revision }, 'owner', 'withdrawn'), request)
    await page.waitForFunction(id => document.activeElement.closest('article')?.dataset.requestId !== id && !!document.activeElement.closest('.session-request-card'), identity)
    const revisable = (await page.evaluate(() => window.aiTerminal.listAttention())).find(row => row.requestKey === 'manual-4')
    const revised = card.locator(`article[data-request-id="${revisable.requestId}"]`)
    await revised.getByRole('button', { name: 'Dismiss', exact: true }).focus()
    await emit('north', 'revised', ['ask', 'manual-4', 'Revised synthetic decision', '--choices-json', choices])
    await page.waitForFunction(({id,revision}) => document.querySelector(`article[data-request-id="${id}"]`)?.dataset.requestRevision !== String(revision), { id: revisable.requestId, revision: revisable.revision })
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('.session-request-card')))
    assert.equal(await card.locator('input,textarea').count(), 0)
    assert.equal(readFileSync(join(root, 'north.input'), 'utf8'), '')
    assert.equal(readFileSync(join(root, 'south.input'), 'utf8'), '')
    await page.screenshot({ path: join(evidence, 'attention-narrow.png') })
    await page.keyboard.press('Escape')
    assert.ok(await opener.evaluate(el => el === document.activeElement))
    const before = (await page.evaluate(() => window.aiTerminal.listAttention())).filter(row => row.state === 'open').length
    await page.keyboard.press('Control+Shift+U')
    assert.equal((await page.evaluate(() => window.aiTerminal.listAttention())).filter(row => row.state === 'open').length, before)
    for (const r of (await page.evaluate(() => window.aiTerminal.listAttention())).filter(row => row.state === 'open')) {
      await page.evaluate(row => window.aiTerminal.resolveAttention(row.requestId, 'Fixture cleanup', { kind: row.kind, revision: row.revision }, 'owner', 'withdrawn'), r)
    }
    // An intentionally visible archived session remains inspectable but has no palette Edit action.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900))
    await page.evaluate(id => window.aiTerminal.stopSession(id), exact.session.sessionId)
    await update(exact.session.sessionId, { archived: true })
    await page.getByLabel('Show archived', { exact: true }).check()
    await select(exact.session.sessionId)
    await openPalette(); await search.fill('edit launch')
    assert.equal(await page.locator('.palette-results [data-group="Commands"]').count(), 0)
    await page.keyboard.press('Escape')
    result.attention = true
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  } finally {
    const page = (await app.windows())[0]
    await page?.evaluate(async () => { for (const ws of await window.aiTerminal.listWorkspaces(true)) for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {}) }).catch(() => {})
    await app.close()
  }
})
console.log('PASS: catalogue abbreviations, addressed editing and response-card keyboard navigation')
