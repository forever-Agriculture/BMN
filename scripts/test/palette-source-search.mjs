/* global window, document */
// Source search and abbreviated commands, driven through real owner IPC and keyboard actions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { waitForAsyncState } from './session-request-helpers.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-48/runtime'); mkdirSync(evidence, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const input = join(root, 'input'), trigger = join(root, 'emit'), fixture = join(root, 'fixture.mjs')
  mkdirSync(join(root, 'build')); mkdirSync(join(root, 'src/deep'), { recursive: true })
  for (let i = 0; i < 20100; i++) writeFileSync(join(root, 'build', `generated-${i}.js`), '')
  const target = join(root, 'src/deep/target-source-nxtreq.ts'); writeFileSync(target, 'export const syntheticSource = true\n')
  writeFileSync(fixture, `import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
process.stdout.write('palette fixture ready\\r\\n');let sent=false;setInterval(()=>{if(!sent&&existsSync(${JSON.stringify(trigger)})){sent=true;process.stdout.write('\\x1b]9;Palette synthetic request\\x07')}},50);`)
  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const app = await _electron.launch({ chromiumSandbox: true, executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.session-row')
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const created = await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: workspace.workspaceId,
      name: 'Palette fixture', cwd: root, executable: process.execPath, argv: [fixture], cols: 100, rows: 30 })
    const sid = created.session.sessionId
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(l => l.includes('palette fixture ready')), sid)
    await page.keyboard.type('partial synthetic input')
    await page.waitForTimeout(100)
    const before = await page.evaluate(id => {
      window.bmnPaletteTerminal = document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm`)
      return window.__aitermTest.snapshot(id)
    }, sid)
    const beforeInput = readFileSync(input, 'utf8')
    assert.equal(beforeInput, 'partial synthetic input')
    const openPalette = async () => { await page.keyboard.press('Control+Shift+P'); await page.waitForSelector('.command-palette') }
    await openPalette()
    const search = page.locator('.command-palette input')
    await search.fill('target-source')
    const file = page.locator('.palette-results [data-group="Files"]').filter({ hasText: 'target-source-nxtreq.ts' })
    await file.waitFor()
    assert.match(await page.locator('.palette-file-status').innerText(), /1 found/)
    assert.ok((await page.locator('.palette-file-status').innerText()).includes(root))
    await page.screenshot({ path: join(evidence, 'source-match.png') })
    await file.click()
    await page.waitForSelector('.file-reference-dialog')
    assert.ok((await page.locator('.file-reference-dialog').innerText()).includes('syntheticSource'))
    await page.keyboard.press('Escape')
    writeFileSync(trigger, '')
    await waitForAsyncState(page, async () => (await window.aiTerminal.listAttention()).filter(r => r.state === 'open').length === 1)
    await openPalette(); await search.fill('nxt req')
    const command = page.locator('#palette-next-attention')
    await command.waitFor()
    assert.equal(await search.getAttribute('aria-activedescendant'), 'palette-next-attention')
    await page.locator('.palette-results [data-group="Files"]').filter({ hasText: 'target-source-nxtreq.ts' }).waitFor()
    assert.equal(await search.getAttribute('aria-activedescendant'), 'palette-next-attention', 'Late files replaced command selection')
    assert.equal(await page.evaluate(async () => (await window.aiTerminal.listAttention()).filter(r => r.state === 'open').length), 1, 'Search executed a command before Enter')
    await page.screenshot({ path: join(evidence, 'abbreviation.png') })
    await search.press('Enter')
    await page.waitForSelector('.command-palette', { state: 'detached' })
    await waitForAsyncState(page, async () => (await window.aiTerminal.listAttention()).every(r => r.state !== 'open'))
    const after = await page.evaluate(id => ({ snapshot: window.__aitermTest.snapshot(id), same: window.bmnPaletteTerminal === document.querySelector(`.session-terminal[data-session-id="${id}"] .xterm`), focused: document.activeElement?.classList.contains('xterm-helper-textarea') }), sid)
    assert.equal(after.same, true); assert.equal(after.focused, true)
    for (const key of ['cols', 'rows', 'ptyCols', 'ptyRows', 'inputEvents']) assert.equal(after.snapshot[key], before[key])
    assert.deepEqual(after.snapshot.modes, before.modes); assert.equal(readFileSync(input, 'utf8'), beforeInput)
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ generatedEntries: 20100, sourceMatch: target, exactPreview: true,
      abbreviation: true, commandIdPreserved: true, explicitEnter: true, terminalIdentity: true, gridModesInputPreserved: true }, null, 2))
  } finally {
    const page = (await app.windows())[0]
    await page?.evaluate(async () => { for (const ws of await window.aiTerminal.listWorkspaces(true)) for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {}) }).catch(() => {})
    await app.close()
  }
})
console.log('Palette source search runtime PASS')
