/* global window, document, requestAnimationFrame */
// Epics51/52 and manual desktop choices: isolated owner UI → store → host/PTY acceptance.
import { toggleSessionRequests } from './session-request-helpers.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = process.env.BMN_REFINEMENTS_EVIDENCE ?? join(repo, '.dev-auto/evidence/epics-50-52/runtime')
mkdirSync(evidence, { recursive: true })
assert.ok(process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Use a private X display')
const waitFile = async path => {
  const until = Date.now() + 15000
  while (!existsSync(path)) { if (Date.now() > until) throw new Error(`Timed out: ${path}`); await new Promise(resolve => setTimeout(resolve, 25)) }
}
const fingerprintFiles = [...new Set([
  ...execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim().split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).trim().split('\n'),
  'apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.js', 'apps/desktop/out/renderer/index.html'
])].filter(path => path && existsSync(join(repo, path)))
const fingerprint = Object.fromEntries(fingerprintFiles.map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]))
const result = { fingerprint, states: [], checks: [], status: 'running' }
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const dirA = join(root, 'project-a'), dirB = join(root, 'project-b')
  mkdirSync(dirA); mkdirSync(dirB)
  writeFileSync(join(dirA, 'AGENTS.md'), 'SYNTHETIC WORKSPACE A\n')
  writeFileSync(join(dirB, 'AGENTS.md'), 'SYNTHETIC WORKSPACE B\n')
  writeFileSync(join(dirA, 'large.txt'), 'L'.repeat(1024 * 1024 + 1))
  writeFileSync(join(dirA, 'binary.dat'), Buffer.from([0, 255, 0]))
  const link = join(dirA, 'chosen.md'); symlinkSync(join(dirA, 'AGENTS.md'), link)
  const input = name => join(root, `input-${name}`)
  const command = join(root, 'command.json'), ready = join(root, 'asked.json'), producer = join(root, 'receiver.mjs')
  const cli = join(repo, 'apps/desktop/bin/bmn')
  writeFileSync(producer, `import {appendFileSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createConnection} from 'node:net';
const name=process.argv[2];writeFileSync(${JSON.stringify(root)}+'/input-'+name,'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(root)}+'/input-'+name,b));
process.stdout.write('MATCH_TOP '+name+'\\r\\n'+Array.from({length:18},(_,i)=>'row '+i+' '+name).join('\\r\\n')+'\\r\\nMATCH_BOTTOM '+name+'\\r\\n');
function observe(method='conversation.observe',params={agentCli:'codex',conversationReference:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source:'startup'}){return new Promise((resolve,reject)=>{const s=createConnection(process.env.BMN_CONTROL_SOCKET);let t='';s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'auth',params:{token:process.env.BMN_TOKEN}})+'\\n'));s.on('data',b=>{t+=b;while(t.includes('\\n')){const i=t.indexOf('\\n'),r=JSON.parse(t.slice(0,i));t=t.slice(i+1);if(r.id===1)s.write(JSON.stringify({jsonrpc:'2.0',id:2,method,params})+'\\n');else if(r.id===2){s.end();if(r.error)reject(new Error(r.error.message));else resolve(r.result)}}})})}
setInterval(async()=>{if(name!=='A'||!existsSync(${JSON.stringify(command)}))return;const p=JSON.parse(readFileSync(${JSON.stringify(command)},'utf8'));unlinkSync(${JSON.stringify(command)});await observe();if(p.native){const result=await observe('attention.open',p.native);writeFileSync(${JSON.stringify(ready)},JSON.stringify({status:0,result}));return}const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'ask',p.key,p.title,'--kind',p.kind??'question',...(p.plain?[]:['--choices-json',JSON.stringify({options:[{label:'Proceed',description:null},{label:'Wait',description:'Keep pending'}]})]),...(p.body?['--body',p.body]:[]),'--json'],{encoding:'utf8'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({status:r.status,result:r.status===0?JSON.parse(r.stdout):null}));},25);`)
  const launch = () => _electron.launch({ chromiumSandbox: true, executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), '--ozone-platform=x11', '--bmn-test-mode'], env: { ...env,
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root } })
  let app = await launch()
  let page
  let lockChild
  const close = async () => {
    const pages = await app.windows()
    await pages[0]?.evaluate(async () => { for (const workspace of await window.aiTerminal.listWorkspaces(true)) for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {}) }).catch(() => {})
    await app.close()
  }
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(12000); await page.waitForSelector('.shell-window')
    let workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    workspace = await page.evaluate(w => window.aiTerminal.updateWorkspace({ workspaceId: w.workspaceId, expectedRevision: w.revision, name: 'Project A', defaultCwd: w.cwd }), { ...workspace, cwd: dirA })
    const workspaceB = await page.evaluate(cwd => window.aiTerminal.createWorkspace({ name: 'Project B', defaultCwd: cwd }), dirB)
    const sessions = []
    for (const [name, w, cwd] of [['A', workspace, dirA], ['B', workspace, dirA], ['C', workspaceB, dirB]]) {
      sessions.push(await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: w.workspaceId, name, cwd,
        executable: process.execPath, argv: [producer, name], cols: 90, rows: 26 }))
      await waitFile(input(name))
    }
    await page.reload(); await page.waitForSelector('.session-row')
    const select = async name => page.locator(`.session-row > button[data-session-id="${sessions.find(s => s.session.name === name).session.sessionId}"]`).click()
    const snapshot = name => page.evaluate(id => window.__aitermTest.snapshot(id), sessions.find(s => s.session.name === name).session.sessionId)
    for (const name of ['A', 'B', 'C']) await select(name)
    await page.keyboard.press('Control+Shift+R')
    const recent = page.getByRole('dialog', { name: 'Recent sessions', exact: true })
    await recent.waitFor()
    assert.deepEqual(await recent.locator('.palette-results .label').allTextContents(), ['C', 'B', 'A'])
    // Background changes update labels/status without moving the frozen IDs or the highlight.
    await page.evaluate(async address => {
      const row = (await window.aiTerminal.listSessions(address.workspaceId)).find(session => session.sessionId === address.sessionId)
      await window.aiTerminal.updateSession({ sessionId: row.sessionId, expectedRevision: row.revision, name: 'B renamed' })
    }, { workspaceId: workspace.workspaceId, sessionId: sessions[1].session.sessionId })
    await recent.locator('.label').filter({ hasText: 'B renamed' }).waitFor()
    assert.deepEqual(await recent.locator('.palette-results .label').allTextContents(), ['C', 'B renamed', 'A'])
    await page.keyboard.press('ArrowDown')
    assert.equal(await recent.locator('[aria-selected="true"] .label').innerText(), 'B renamed')
    await page.evaluate(id => window.aiTerminal.stopSession(id), sessions[1].session.sessionId)
    await page.evaluate(async address => {
      const row = (await window.aiTerminal.listSessions(address.workspaceId)).find(session => session.sessionId === address.sessionId)
      await window.aiTerminal.updateSession({ sessionId: row.sessionId, expectedRevision: row.revision, archived: true })
    }, { workspaceId: workspace.workspaceId, sessionId: sessions[1].session.sessionId })
    await recent.locator('.label').filter({ hasText: 'B renamed' }).waitFor({ state: 'hidden' })
    assert.equal(await recent.locator('[aria-selected="true"] .label').innerText(), 'A')
    await page.keyboard.press('Escape'); await select('A')
    await page.evaluate(async address => {
      const row = (await window.aiTerminal.listSessions(address.workspaceId)).find(session => session.sessionId === address.sessionId)
      await window.aiTerminal.updateSession({ sessionId: row.sessionId, expectedRevision: row.revision, archived: false })
    }, { workspaceId: workspace.workspaceId, sessionId: sessions[1].session.sessionId })
    await page.keyboard.press('Control+Shift+R')
    await page.getByRole('dialog', { name: 'Recent sessions', exact: true }).getByRole('option').filter({ has: page.locator('.label', { hasText: /^B renamed$/ }) }).click()
    await page.waitForFunction(id => document.querySelector('.session-row.selected button[data-session-id]')?.getAttribute('data-session-id') === id, sessions[1].session.sessionId)
    const stopped = await page.evaluate(async address => (await window.aiTerminal.listSessions(address.workspaceId)).find(session => session.sessionId === address.sessionId),
      { workspaceId: workspace.workspaceId, sessionId: sessions[1].session.sessionId })
    assert.equal(stopped.lastProcess.state, 'exited')
    await select('A')
    result.checks.push('MRU focus commits, frozen order, label/status changes, removed-highlight successor and stopped inspection')
    await page.keyboard.press('Control+Shift+Enter')
    await page.getByRole('dialog', { name: 'Split with', exact: true }).waitFor()
    await page.getByRole('dialog', { name: 'Split with', exact: true }).getByRole('option').filter({ has: page.locator('.label', { hasText: /^C$/ }) }).click()
    await page.waitForFunction(() => document.querySelector('.session-area.split'))
    const groupA = page.getByRole('region', { name: 'Project A', exact: true })
    // Workspace groups are named sections; locate them directly to avoid browser landmark assumptions.
    const group = page.locator('.workspace-group[aria-label="Project A"]')
    await group.locator('.workspace-row > button').first().click()
    const selected = await page.evaluate(() => document.querySelector('.session-row.selected button[data-session-id]')?.getAttribute('data-session-id'))
    assert.equal(await group.locator('.session-row').count(), selected === sessions[0].session.sessionId ? 1 : 0)
    await page.keyboard.press('Control+Tab')
    assert.equal(await group.locator('.session-row').count(), 1)
    assert.equal(await group.locator('.session-row button[data-session-id]').getAttribute('data-session-id'), sessions[0].session.sessionId)
    result.checks.push('Collapsed selected row follows pane focus without expanding')
    await page.keyboard.press('Control+Shift+R')
    await page.getByRole('dialog', { name: 'Recent sessions', exact: true }).getByRole('option').filter({ has: page.locator('.label', { hasText: /^C$/ }) }).click()
    await page.waitForFunction(id => document.querySelector('.session-row.selected button[data-session-id]')?.getAttribute('data-session-id') === id, sessions[2].session.sessionId)
    assert.ok((await page.locator('.breadcrumb').innerText()).includes('Project A'))
    await page.keyboard.press('Control+Shift+R')
    await page.getByRole('dialog', { name: 'Recent sessions', exact: true }).getByRole('option').filter({ has: page.locator('.label', { hasText: /^A$/ }) }).click()
    assert.equal(await group.locator('.workspace-row > button').first().getAttribute('aria-expanded'), 'false')
    result.checks.push('Recent chooser focuses an existing other pane and keeps collapsed groups collapsed')
    void groupA
    for (const mode of ['split', 'focus', 'single']) {
      if (mode === 'focus') await page.keyboard.press('Control+Shift+Z')
      if (mode === 'single') await page.keyboard.press('Control+Shift+Enter')
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(...size); w.show() }, [width, height])
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.waitForFunction(id => { const value = window.__aitermTest.snapshot(id); return value.cols === value.ptyCols && value.rows === value.ptyRows }, sessions[0].session.sessionId)
      const before = await snapshot('A')
      await page.keyboard.press('Control+Shift+F')
      const search = page.locator('.terminal-search').filter({ has: page.getByRole('textbox', { name: 'Search A output' }) })
      if (await search.getByRole('button', { name: 'Move Find to top', exact: true }).count()) await search.getByRole('button', { name: 'Move Find to top', exact: true }).click()
      await search.getByRole('textbox').fill('MATCH'); await search.getByRole('button', { name: 'Next', exact: true }).click()
      const value = await search.locator('.search-result').innerText()
      await search.getByRole('button', { name: 'Move Find to bottom', exact: true }).click()
      assert.equal(await search.getByRole('textbox').inputValue(), 'MATCH'); assert.equal(await search.locator('.search-result').innerText(), value)
      const after = await snapshot('A'); assert.equal(after.cols, before.cols); assert.equal(after.rows, before.rows)
      assert.equal(after.inputEvents, before.inputEvents); assert.equal(after.refits, before.refits)
      await page.screenshot({ path: join(evidence, `find-${mode}-${width}.png`) })
      await search.getByRole('button', { name: 'Close search', exact: true }).click()
      await page.keyboard.press('Control+Shift+F'); assert.ok(await page.locator('.terminal-search-bottom').count())
      await page.getByRole('button', { name: 'Close search', exact: true }).click()
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true })
      const jump = prefs.getByRole('combobox', { name: 'Preferences section', exact: true })
      await jump.selectOption('Telegram')
      const chat = prefs.locator('#preferences-telegram-chat-id')
      if (await chat.count()) {
        await chat.fill('synthetic invalid')
        await prefs.getByRole('button', { name: 'Save Telegram settings', exact: true }).click()
        await prefs.locator('.preferences-error').waitFor()
      }
      const validation = await prefs.locator('.preferences-error').allTextContents()
      if (mode === 'split' && width === 800) {
        const locked = join(root, 'settings-locked'), unlock = join(root, 'settings-unlock')
        const driver = createRequire(join(repo, 'apps/desktop/package.json')).resolve('better-sqlite3')
        const code = `const fs=require('node:fs');const DB=require(${JSON.stringify(driver)});const db=new DB(${JSON.stringify(join(roots.data, 'bmn', 'state.sqlite3'))});db.exec('BEGIN IMMEDIATE');fs.writeFileSync(${JSON.stringify(locked)},'');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(unlock)})){clearInterval(timer);db.exec('COMMIT');db.close();process.exit(0)}},25);setTimeout(()=>process.exit(2),10000).unref();`
        lockChild = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'ignore', 'pipe'] })
        let lockError = ''; lockChild.stderr.on('data', bytes => { lockError += bytes.toString() })
        await waitFile(locked).catch(error => { throw new Error(`${error.message}; ${lockError}`) })
        try {
          await chat.fill('123')
          await prefs.getByRole('button', { name: 'Save Telegram settings', exact: true }).click()
          await prefs.getByRole('button', { name: 'Saving…', exact: true }).waitFor()
          await jump.selectOption('Appearance'); await jump.selectOption('Telegram')
          assert.equal(await prefs.getByRole('button', { name: 'Saving…', exact: true }).isDisabled(), true)
          assert.equal(await chat.inputValue(), '123')
        } finally { writeFileSync(unlock, '') }
        await prefs.getByRole('button', { name: 'Save Telegram settings', exact: true }).waitFor()
        await prefs.locator('.preferences-success').waitFor()
        lockChild.kill('SIGTERM'); lockChild = undefined
        await chat.fill('synthetic invalid'); await prefs.getByRole('button', { name: 'Save Telegram settings', exact: true }).click()
        await prefs.locator('.preferences-error').waitFor()
        result.checks.push('Preferences jumps preserve an actual pending SQLite save and its unsaved field')
      }
      for (const section of ['Backup', 'History', 'Voice', 'Appearance', 'Terminal', 'Notifications', 'Local agent control', 'Telegram']) {
        await jump.selectOption(section)
        assert.equal(await page.evaluate(() => document.activeElement.textContent), section)
      }
      if (await chat.count()) assert.equal(await chat.inputValue(), 'synthetic invalid')
      assert.deepEqual(await prefs.locator('.preferences-error').allTextContents(), validation)
      await page.screenshot({ path: join(evidence, `preferences-${mode}-${width}.png`) })
      await page.getByRole('button', { name: 'Close Preferences', exact: true }).click()
      result.states.push({ mode, width, height, findGrid: [after.cols, after.rows], inputEvents: after.inputEvents })
    }
      if (mode === 'focus') await page.keyboard.press('Control+Shift+Z')
    }
    result.checks.push('Find overlay/query/match stability and Preferences mounted section focus at three sizes')
    // Explicit workspace pins use the menu, not the active session's path.
    await page.getByRole('button', { name: 'Actions for Project A', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Pinned files…', exact: true }).click()
    const pins = page.getByRole('dialog', { name: 'Pinned files — Project A', exact: true })
    const add = async path => { await pins.getByRole('textbox', { name: 'Pinned file path' }).fill(path); await pins.getByRole('button', { name: 'Add path', exact: true }).click(); await pins.locator('li code').filter({ hasText: path }).waitFor() }
    await add('AGENTS.md'); await add(link); await add(join(dirA, 'missing.md')); await add(join(dirA, 'large.txt')); await add(join(dirA, 'binary.dat'))
    const stored = (await page.evaluate(() => window.aiTerminal.listWorkspaces())).find(w => w.workspaceId === workspace.workspaceId)
    assert.equal(stored.pinnedFilePaths[0], join(dirA, 'AGENTS.md'))
    await pins.getByRole('button', { name: `Open ${join(dirA, 'AGENTS.md')}`, exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'File reference', exact: true }); await preview.getByRole('region', { name: 'Read-only file contents' }).waitFor()
    assert.ok((await preview.innerText()).includes('SYNTHETIC WORKSPACE A')); assert.ok((await preview.innerText()).includes('Project A'))
    assert.equal(await preview.getByRole('button', { name: 'Send reference', exact: true }).count(), 0)
    await page.screenshot({ path: join(evidence, 'pins-preview.png') }); await page.getByRole('button', { name: 'Close File reference', exact: true }).click()
    const opened = await page.evaluate(p => window.aiTerminal.readFileReference(p), { workspaceId: workspace.workspaceId, reference: link })
    assert.equal(opened.canonicalPath, join(dirA, 'AGENTS.md'))
    unlinkSync(link); symlinkSync(join(dirB, 'AGENTS.md'), link)
    const changed = await page.evaluate(p => window.aiTerminal.readFileReference(p), { workspaceId: workspace.workspaceId, reference: link })
    assert.equal(changed.canonicalPath, join(dirB, 'AGENTS.md')); assert.ok(changed.content.includes('WORKSPACE B'))
    for (const [name, reason] of [['missing.md', 'missing'], ['large.txt', 'too-large'], ['binary.dat', 'binary']]) {
      const unavailable = await page.evaluate(p => window.aiTerminal.readFileReference(p), { workspaceId: workspace.workspaceId, reference: join(dirA, name) })
      assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.reason, reason)
    }
    result.checks.push('Owner pin Add/store/preview, absolute addressing, symlink retarget and unavailable file classes')
    await page.getByRole('button', { name: 'Actions for Project B', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Pinned files…', exact: true }).click()
    const otherPins = page.getByRole('dialog', { name: 'Pinned files — Project B', exact: true })
    await otherPins.getByRole('textbox', { name: 'Pinned file path' }).fill('AGENTS.md')
    await otherPins.getByRole('button', { name: 'Add path', exact: true }).click()
    await otherPins.getByRole('button', { name: `Open ${join(dirB, 'AGENTS.md')}`, exact: true }).click()
    await page.getByRole('region', { name: 'Read-only file contents' }).waitFor()
    assert.ok((await page.getByRole('dialog', { name: 'File reference', exact: true }).innerText()).includes('SYNTHETIC WORKSPACE B'))
    await page.getByRole('button', { name: 'Close File reference', exact: true }).click()
    result.checks.push('Workspace B pin reaches its folder while session A remains selected')
    writeFileSync(command, JSON.stringify({ key: 'desktop-manual', title: 'Synthetic manual checkpoint' })); await waitFile(ready)
    const asked = JSON.parse(readFileSync(ready)); assert.equal(asked.status, 0); assert.equal(asked.result.producer, undefined)
    const owned = await page.evaluate(() => window.aiTerminal.listAttention())
    assert.ok(owned.find(row => row.requestId === asked.result.requestId)?.producer)
    await toggleSessionRequests(page)
    const card = page.locator('.attention-item').filter({ hasText: 'Synthetic manual checkpoint' })
    assert.equal(await card.locator('h3').count(), 0)
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(...size) }, [width, height])
      await page.screenshot({ path: join(evidence, `manual-card-${width}.png`) })
    }
    assert.ok((await card.innerText()).includes('Proceed'))
    assert.equal(await card.locator('input, textarea').count(), 0)
    await card.getByRole('button', { name: 'Dismiss', exact: true }).click()
    assert.equal(readFileSync(input('A'), 'utf8'), '')
    result.checks.push('Actual bmn ask API reaches read-only desktop choices; Dismiss writes no input')
    const publishCard = async params => {
      unlinkSync(ready); writeFileSync(command, JSON.stringify(params)); await waitFile(ready)
      assert.equal(JSON.parse(readFileSync(ready)).status, 0)
    }
    await publishCard({ native: { requestKey: 'synthetic-native-multiple', kind: 'question', title: 'Synthetic two-part question',
      origin: 'hook:codex:PreToolUse', body: 'Synthetic current question context',
      prompt: { type: 'questions', harness: 'codex', shape: 'async-choice', requestRef: 'synthetic-request', toolUseId: 'synthetic-tool',
        questions: [{ id: 'first', header: 'First', text: 'Synthetic first question with enough context to wrap safely in a narrow card?', multiSelect: false,
          options: [{ label: 'First option', description: 'Synthetic description' }, { label: 'Second option', description: null }] },
          { id: 'second', header: 'Second', text: 'Synthetic second question?', multiSelect: false,
            options: [{ label: 'Proceed', description: null }, { label: 'Wait', description: null }] }] } } })
    await publishCard({ key: 'synthetic-permission', kind: 'permission', plain: true, title: 'Synthetic permission target',
      body: '/synthetic/project/' + 'long-path-component/'.repeat(15) + 'instruction.md\nPermission is pending; no command ran.' })
    const multiple = page.locator('.attention-item[data-request-id]').filter({ hasText: 'Synthetic two-part question' })
    const permission = page.locator('.attention-item[data-request-id]').filter({ hasText: 'Synthetic permission target' })
    await toggleSessionRequests(page)
    await multiple.waitFor(); await permission.waitFor()
    assert.equal(await multiple.locator('.attention-questions section').count(), 2)
    assert.ok((await permission.innerText()).includes('long-path-component'))
    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      await permission.scrollIntoViewIfNeeded()
      assert.equal(await page.locator('.session-request-card').evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(evidence, `populated-cards-${width}.png`) })
    }
    result.checks.push('Synthetic native multi-question and long permission target retain context and fit all three sizes')
    await page.keyboard.press('Escape')
    // Race an actual safe-reader operation with archive; the final workspace revision must reject it.
    writeFileSync(join(dirB, 'race.txt'), 'R'.repeat(1024 * 1024))
    await page.evaluate(id => window.aiTerminal.stopSession(id), sessions[2].session.sessionId)
    const archiveRace = await page.evaluate(async address => {
      const source = (await window.aiTerminal.listWorkspaces(true)).find(w => w.workspaceId === address.workspaceId)
      const reading = window.aiTerminal.readFileReference({ workspaceId: source.workspaceId, reference: address.path })
        .then(() => ({ accepted: true }), error => ({ accepted: false, code: error.code }))
      const archived = await window.aiTerminal.updateWorkspace({ workspaceId: source.workspaceId, expectedRevision: source.revision, archived: true })
      const outcome = await reading
      await window.aiTerminal.updateWorkspace({ workspaceId: source.workspaceId, expectedRevision: archived.revision, archived: false })
      return outcome
    }, { workspaceId: workspaceB.workspaceId, path: join(dirB, 'race.txt') })
    assert.equal(archiveRace.accepted, false)
    result.checks.push('Workspace archive during actual file read rejects its late preview')


    // Remove both the highlighted row and its preceding sibling in one workspace archive.
    const chooserWorkspaces = await page.evaluate(async () => ({
      gone: await window.aiTerminal.createWorkspace({ name: 'Gone group' }),
      kept: await window.aiTerminal.createWorkspace({ name: 'Kept group' })
    }))
    const chooserRows = []
    for (const [name, owner] of [['H', chooserWorkspaces.kept], ['G', chooserWorkspaces.kept], ['F', chooserWorkspaces.gone], ['E', chooserWorkspaces.gone]]) {
      const created = await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: owner.workspaceId, name,
        cwd: dirA, executable: process.execPath, argv: [producer, name], cols: 80, rows: 24 })
      chooserRows.push(created.session)
      await waitFile(input(name))
    }
    // API setup bypasses the owner's new-workspace UI, which normally adopts each layout.
    // Load the real owner startup catalogue/layouts once before the measured focus commits.
    await page.reload(); await page.waitForSelector('.session-row')
    for (const row of chooserRows) {
      const owner = row.name === 'H' || row.name === 'G' ? chooserWorkspaces.kept : chooserWorkspaces.gone
      const group = page.locator(`.workspace-group[aria-label="${owner.name}"]`)
      if (await group.locator('.workspace-row > button').first().getAttribute('aria-expanded') === 'false') await group.locator('.workspace-row > button').first().click()
      await group.locator('.session-row > button[data-session-id="' + row.sessionId + '"]').click()
      await page.waitForFunction(id => document.querySelector('.session-row.selected button[data-session-id]')?.getAttribute('data-session-id') === id, row.sessionId)
    }
    await page.keyboard.press('Control+Shift+R')
    const removing = page.getByRole('dialog', { name: 'Recent sessions', exact: true })
    assert.deepEqual((await removing.locator('.palette-results .label').allTextContents()).slice(0, 4), ['E', 'F', 'G', 'H'])
    await page.keyboard.press('ArrowDown')
    assert.equal(await removing.locator('[aria-selected="true"] .label').innerText(), 'F')
    await page.evaluate(async address => {
      for (const row of await window.aiTerminal.listSessions(address)) await window.aiTerminal.stopSession(row.sessionId)
      const source = (await window.aiTerminal.listWorkspaces(true)).find(w => w.workspaceId === address)
      await window.aiTerminal.updateWorkspace({ workspaceId: source.workspaceId, expectedRevision: source.revision, archived: true })
    }, chooserWorkspaces.gone.workspaceId)
    await removing.locator('.label').filter({ hasText: /^F$/ }).waitFor({ state: 'hidden' })
    assert.equal(await removing.locator('[aria-selected="true"] .label').innerText(), 'G')
    await page.keyboard.press('Enter')
    const selectedG = chooserRows.find(row => row.name === 'G')
    await page.waitForFunction(id => document.querySelector('.session-row.selected button[data-session-id]')?.getAttribute('data-session-id') === id, selectedG.sessionId)
    for (const name of ['E', 'F', 'G', 'H']) assert.equal(readFileSync(input(name), 'utf8'), '')
    result.checks.push('MRU simultaneous workspace removal selects and commits the next surviving identity')
    for (const name of ['A', 'B', 'C']) assert.equal(readFileSync(input(name), 'utf8'), '')
    await close(); app = await launch(); page = await app.firstWindow(); await page.waitForSelector('.shell-window')
    const restored = (await page.evaluate(() => window.aiTerminal.listWorkspaces())).find(w => w.workspaceId === workspace.workspaceId)
    assert.deepEqual(restored.pinnedFilePaths, stored.pinnedFilePaths)
    result.checks.push('Pin paths/order survive restart; no terminal bytes throughout UI controls')
    result.status = 'PASS'
  } catch (error) {
    await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
    writeFileSync(join(evidence, 'failure-dom.txt'), await page?.locator('body').innerText().catch(() => '') ?? '')
    throw error
  } finally { lockChild?.kill('SIGTERM'); await close().catch(() => {}); writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2)) }
})
console.log(JSON.stringify(result))
