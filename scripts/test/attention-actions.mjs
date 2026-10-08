/* global window, document, getComputedStyle */
// MODULE: attention-actions.mjs - explicit navigation and pane request cards, with synthetic PTYs
// Run under an isolated X display (e.g. xvfb-run), after build. --binary selects a packaged baseline/candidate.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { waitForAsyncState } from './session-request-helpers.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binaryFlag = process.argv.indexOf('--binary')
const packagedBinary = binaryFlag < 0 ? null : resolve(process.argv[binaryFlag + 1])
const binary = packagedBinary ?? createRequire(join(repo, 'apps/desktop/package.json'))('electron')
const evidence = process.env.BMN_ACTION_EVIDENCE ?? join(repo, '.dev-auto/evidence/owner-actions/runtime')
mkdirSync(evidence, { recursive: true })
const writeAtomic = (path, text) => { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path) }
// No clipboard actions or owner profile writes occur in this suite.

await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const env = { ...process.env }
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const launchOptions = { chromiumSandbox: true, executablePath: binary, cwd: repo, timeout: 20000,
    args: [...(packagedBinary ? [] : [join(repo, 'apps/desktop')]), '--ozone-platform=x11', '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  }
  const rendererRoot = join(repo, 'apps/desktop/out/renderer')
  const server = createServer((request, response) => {
    const path = resolve(rendererRoot, '.' + new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'))
    if (!path.startsWith(rendererRoot + '/')) { response.writeHead(403); response.end(); return }
    try { const body = readFileSync(path); response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream'); response.end(body) }
    catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  if (!packagedBinary) launchOptions.env.ELECTRON_RENDERER_URL = origin
  let app = await _electron.launch(launchOptions)
  const bounded = async (operation, label) => {
    let timer
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label+' timed out')), 15000) })]) }
    finally { clearTimeout(timer) }
  }
  const stopTestSessions = async (page) => {
    await bounded(page.evaluate(async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces(true)) {
        for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) {
          if (session.lastProcess?.state === 'live') await window.aiTerminal.stopSession(session.sessionId)
        }
      }
    }), 'synthetic session cleanup')
    await waitForAsyncState(page, async () => {
      for (const workspace of await window.aiTerminal.listWorkspaces(true)) {
        if ((await window.aiTerminal.listSessions(workspace.workspaceId)).some(session => session.lastProcess?.state === 'live')) return false
      }
      return true
    }, undefined, {timeout:15000})
  }
  const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
  const changed = [...execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim().split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')]
    .filter(name => /^(apps|shared|scripts|docs)\//.test(name))
  const buildHashes = {}
  const visitBuild = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) visitBuild(full)
      else if (entry.isFile()) buildHashes[full.slice(repo.length + 1)] = hash(full)
    }
  }
  if (!packagedBinary) visitBuild(join(repo, 'apps/desktop/out'))
  const result = { binary: packagedBinary ?? 'development', windows: [], status: 'running',
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceHashes: packagedBinary ? {} : Object.fromEntries(changed.map(name => [name, hash(join(repo, name))])), buildHashes,
    ...(packagedBinary ? { packagedAsarHash: hash(join(dirname(packagedBinary), 'resources/app.asar')) } : {}) }
  writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  try {
    const page = await app.firstWindow({ timeout: 15000 })
    page.setDefaultTimeout(15000)
    await page.waitForSelector('.shell-window')
    if (!packagedBinary) assert.ok(page.url().startsWith(origin), page.url())
    result.origin = origin
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const input = join(root, 'destination-input.txt'), sourceInput = join(root, 'source-input.txt')
    const receiver = join(root, 'receiver.mjs')
    const targetTrigger = join(root, 'target-review')
    const fixtureCli = packagedBinary ? join(dirname(packagedBinary), 'resources/bin/bmn.mjs') : join(repo, 'apps/desktop/bin/bmn')
    writeFileSync(receiver, `import {writeFileSync,appendFileSync,existsSync,unlinkSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdout.write('\\x1b[?2004h');
      process.stdin.on('data',c=>appendFileSync(${JSON.stringify(input)},c));setInterval(()=>{
        if(!existsSync(${JSON.stringify(targetTrigger)}))return;unlinkSync(${JSON.stringify(targetTrigger)});
        spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(fixtureCli)},'ask','other-review','Other stopped review','--kind','review'],{stdio:'ignore'});
      },25);`)
    const params = { workspaceId: workspace.workspaceId, cwd: root, executable: process.execPath, cols: 80, rows: 24 }
    const target = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Destination', argv: [receiver] })
    const producer = join(root, 'producer.mjs'), ready = join(root, 'ready.json'), command = join(root, 'command.json')
    const cli = packagedBinary ? join(dirname(packagedBinary), 'resources/bin/bmn.mjs') : join(repo, 'apps/desktop/bin/bmn')
    writeFileSync(producer, `import {writeFileSync,appendFileSync,readFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      const atomic=(path,value)=>{writeFileSync(path+'.tmp',value);renameSync(path+'.tmp',path)};
      writeFileSync(${JSON.stringify(sourceInput)},'');process.stdin.setRawMode(true);process.stdin.on('data',c=>appendFileSync(${JSON.stringify(sourceInput)},c));
      const call=(args,input)=>{const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...args],{encoding:'utf8',input});if(r.status!==0)throw new Error(r.stderr);return r.stdout};
      const file=${JSON.stringify(join(root, 'fixture.txt'))};writeFileSync(file,'Synthetic original');
      for(let i=0;i<64;i++)call(['publish',file,'--name','Fixture '+i+'.txt','--key','file-'+i,'--json']);
      writeFileSync(${JSON.stringify(ready)},JSON.stringify({ready:true}));
      setInterval(()=>{if(!existsSync(${JSON.stringify(command)}))return;const c=JSON.parse(readFileSync(${JSON.stringify(command)},'utf8'));unlinkSync(${JSON.stringify(command)});
        if(c.kind==='focus'){process.stdout.write(c.enabled?'\\x1b[?1004h':'\\x1b[?1004l');atomic(${JSON.stringify(join(root, 'response.json'))},JSON.stringify({key:c.key}));return;}
        const response=c.kind==='handoff'?call(['handoff',${JSON.stringify(target.session.sessionId)},'--text','Please review this short synthetic handoff.','--key',c.key,'--json']):
          ['manual','notice','review'].includes(c.kind)?call(['ask',c.key,c.title??'Manual question','--kind',c.kind==='manual'?'question':c.kind,'--body',c.body??'Synthetic request body','--json']):
          c.kind==='restricted'?call(['hook','opencode'],JSON.stringify({hook_event_name:'question.asked',id:c.key,questions:c.questions})):
          call(['hook','codex'],JSON.stringify({hook_event_name:'PreToolUse',tool_name:'functions.request_user_input_async',tool_use_id:c.key,tool_input:{questions:c.questions}}));
        atomic(${JSON.stringify(join(root, 'response.json'))},JSON.stringify({key:c.key,response}));},25);`)
    const source = await page.evaluate(p => window.aiTerminal.createSession(p), { ...params, name: 'Source', argv: [producer] })
    await page.waitForFunction(() => true)
    for (let i = 0; i < 900 && !existsSync(ready); i++) await page.waitForTimeout(50)
    assert.ok(existsSync(ready), 'Fixture did not initialize')
    // Fixture bridge calls create rows outside the UI creation path; reload its session registry once.
    await page.reload()
    await page.waitForSelector('.session-row', { timeout: 20000 })
    const emit = async (payload) => {
      writeAtomic(command, JSON.stringify(payload))
      for (let i = 0; i < 200; i++) {
        if (existsSync(join(root, 'response.json')) && JSON.parse(readFileSync(join(root, 'response.json'), 'utf8')).key === payload.key) return
        await page.waitForTimeout(25)
      }
      throw new Error('Synthetic source did not publish '+payload.key)
    }
    const question = (key) => ({ kind: 'question', key, questions: [
      { title: 'Which color?', options: ['Gold', 'Black'] }, { title: 'Which shape?', options: ['Circle', 'Square'] }
    ] })
    const resize = async (width, height) => app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(0, 0); win.setContentSize(...size)
    }, [width, height])
    const sid = source.session.sessionId
    const select = async id => page.locator(`.session-row button[data-session-id="${id}"]`).click()
    const control = () => page.locator(`[data-session-requests="${sid}"]`)
    const openCard = async () => {
      if (!await page.locator('.session-request-card').count()) await control().click()
      await page.getByRole('dialog', { name: 'Session requests', exact: true }).waitFor()
    }
    const card = title => page.locator('.session-request-card .attention-item').filter({ hasText: title })
    const rows = () => page.evaluate(() => window.aiTerminal.listAttention())
    const waitState = async (key, state) => waitForAsyncState(page, async ({ key, state }) =>
      (await window.aiTerminal.listAttention()).some(row => row.requestKey === key && row.state === state), { key, state })
    const grid = () => page.evaluate(id => window.__aitermTest.snapshot(id), sid)
    await select(sid)
    assert.equal(await page.locator('.app-header button').count(), 2)
    assert.doesNotMatch(await page.getByRole('button',{name:'Preferences',exact:true}).getAttribute('title'), /Phone delivery history/)
    await select(target.session.sessionId)
    await emit({kind:'notice',key:'notice-only',title:'Notice-only snapshot',body:'Only copy of this program update'})
    await select(sid); await waitState('notice-only','withdrawn')
    await openCard(); await card('Notice-only snapshot').waitFor()
    assert.ok((await card('Notice-only snapshot').innerText()).includes('Only copy of this program update'))
    await page.keyboard.press('Escape'); await openCard(); await card('Notice-only snapshot').waitFor()
    await page.keyboard.press('Escape'); await select(target.session.sessionId); await select(sid)
    assert.equal(await control().count(),0)
    await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:sid})
    // Instrument the real IPC handler; selecting an already-selected pane must not save its layout.
    await app.evaluate(({ipcMain}) => {
      const channel='aiterm:layout:put', original=ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('Layout handler unavailable')
      globalThis.bmnCountedLayoutPuts=0
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel,(...args)=>{globalThis.bmnCountedLayoutPuts++;return original(...args)})
    })
    await select(target.session.sessionId)
    await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:target.session.sessionId})
    assert.ok(await app.evaluate(()=>globalThis.bmnCountedLayoutPuts)>0, 'selection change must exercise the layout counter')
    await select(sid)
    await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:sid})
    await page.evaluate(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))))
    await app.evaluate(()=>{globalThis.bmnCountedLayoutPuts=0})
    const selectedScreen = page.locator(`.session-terminal[data-session-id="${sid}"] .xterm-screen`)
    for(let n=0;n<10;n++) await selectedScreen.click()
    for(let n=0;n<5;n++) await page.keyboard.press('Tab')
    assert.equal(await app.evaluate(()=>globalThis.bmnCountedLayoutPuts),0)
    assert.equal(readFileSync(sourceInput,'utf8'),'\t'.repeat(5))
    writeFileSync(sourceInput,'')
    result.repeatedSelectedPaneLayoutWrites=0


    for (const [width, height] of [[800, 500], [1000, 700], [1280, 900]]) {
      await resize(width, height)
      await emit(question('read-'+width))
      await control().waitFor()
      const before = await grid()
      await openCard()
      const questionCard = card('Which color?')
      await questionCard.waitFor()
      for (const text of ['Which color?', 'Which shape?', 'Gold', 'Black', 'Circle', 'Square']) assert.ok((await questionCard.innerText()).includes(text))
      assert.equal(await questionCard.locator('input, textarea').count(), 0)
      assert.equal(await questionCard.getByRole('button', { name: 'Copy answer', exact: true }).count(), 0)
      assert.ok(await page.locator('.session-request-card').evaluate(el => el.scrollWidth <= el.clientWidth))
      await page.screenshot({ path: join(evidence, `requests-${width}.png`) })
      await page.keyboard.press('Escape')
      assert.ok(await control().evaluate(el => document.activeElement === el))
      await control().press('Enter')
      await questionCard.getByRole('button', { name: 'Dismiss', exact: true }).evaluate(el => { el.click(); el.click() })
      await page.waitForSelector('.session-request-card', { state: 'detached' })
      const after = await grid()
      for (const key of ['cols', 'rows', 'ptyCols', 'ptyRows', 'inputEvents']) assert.equal(after[key], before[key], key)
      assert.equal(readFileSync(sourceInput, 'utf8'), '')
      result.windows.push({ width, height, readOnlyQuestions: true, dismiss: true, sameGeometry: true, zeroInput: true })
    }
    for (const mode of ['split', 'focus']) {
      await resize(1280, 900)
      if (mode === 'split') {
        await page.keyboard.press('Control+Shift+Enter')
        await page.locator(`#palette-split-${target.session.sessionId}`).click()
        await page.locator(`.session-terminal[data-session-id="${sid}"] .pane-heading`).click()
        await page.keyboard.press('Control+Tab')
        await emit({kind:'notice',key:'split-switch',title:'Split switch notice'})
        await page.keyboard.press('Control+Tab'); await waitState('split-switch','withdrawn')
        const visiblePaneIds = () => page.locator('.session-terminal:not(.session-terminal-hidden)').evaluateAll(panes => panes.map(pane => pane.dataset.sessionId))
        const paneIds = await visiblePaneIds()
        assert.deepEqual([...paneIds].sort(), [sid,target.session.sessionId].sort())
        const [firstPaneId, secondPaneId] = paneIds
        await select(firstPaneId)
        await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:firstPaneId})
        await page.evaluate(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))))
        const footerControl = page.locator(`.session-terminal[data-session-id="${firstPaneId}"] .pane-footer button`).last()
        const firstOtherControl = page.locator(`.session-terminal[data-session-id="${secondPaneId}"] .pane-heading button`).first()
        assert.equal(readFileSync(sourceInput,'utf8'),'')
        assert.equal(readFileSync(input,'utf8'),'')
        await footerControl.focus()
        assert.ok(await footerControl.evaluate(el => el === document.activeElement))
        await page.keyboard.press('Tab')
        await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:secondPaneId})
        await page.evaluate(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))))
        assert.ok(await firstOtherControl.evaluate(el => el === document.activeElement), 'Tab entry must keep the landed header control')
        assert.equal(readFileSync(sourceInput,'utf8'),'')
        assert.equal(readFileSync(input,'utf8'),'')
        assert.deepEqual(await visiblePaneIds(), paneIds)
        await select(sid)
        await waitForAsyncState(page, async ({wid,id}) => (await window.aiTerminal.getLayout(wid)).layout.selectedSessionId === id, {wid:workspace.workspaceId,id:sid})
        await page.evaluate(()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))))
        result.splitTabEntryFocus = true
      } else {
        await page.keyboard.press('Control+Shift+Enter')
        await page.keyboard.press('Control+Shift+Z')
      }
      for (const [width,height] of [[800,500],[1000,700],[1280,900]]) {
        await resize(width,height)
        await emit(question(`${mode}-${width}`))
        await control().filter({hasText:'Waiting for your response'}).waitFor()
        // Resize is a different action; let its existing fit acknowledgement settle first.
        await page.waitForFunction(id => { const s=window.__aitermTest.snapshot(id); return s.cols===s.ptyCols && s.rows===s.ptyRows }, sid)
        const before = await grid()
        if (await page.locator('.session-request-card').count()) await page.getByRole('button',{name:'Close session requests',exact:true}).click()
        if (mode === 'split' && width === 800) {
          await page.keyboard.press('Control+Tab')
          await control().click() // An unselected pane's request opener must retain card focus.
        } else {
          await control().focus(); await page.keyboard.press('Enter')
        }
        const close = page.getByRole('button', { name: 'Close session requests', exact: true })
        assert.ok(await close.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineWidth !== '0px'))
        await page.screenshot({ path: join(evidence, `requests-${mode}-${width}.png`) })
        await page.keyboard.press('Escape')
        const after = await grid()
        for (const key of ['cols','rows','ptyCols','ptyRows','inputEvents']) assert.equal(after[key],before[key], `${mode}:${width}:${key}`)
        await openCard()
        const dismissedQuestion = card('Which color?')
        await dismissedQuestion.getByRole('button',{name:'Dismiss',exact:true}).click()
        await dismissedQuestion.waitFor({state:'detached'})
        await page.keyboard.press('Escape')
        await page.getByRole('dialog',{name:'Session requests',exact:true}).waitFor({state:'detached'})
      }
    }
    await page.keyboard.press('Control+Shift+Z')
    // The only possible bytes with focus reporting enabled are existing DECSET1004 focus reports.
    await emit({kind:'focus',key:'focus-on',enabled:true})
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).modes.sendFocusMode, sid)
    await emit(question('focus-report-question'))
    const beforeReports = await grid()
    await openCard(); await page.keyboard.press('Escape'); await openCard()
    await card('Which color?').getByRole('button',{name:'Mark answered',exact:true}).click()
    const afterReports = await grid()
    for (const key of ['cols','rows','ptyCols','ptyRows']) assert.equal(afterReports[key],beforeReports[key],key)
    assert.equal(readFileSync(sourceInput,'utf8').split('\x1b[I').join('').split('\x1b[O').join(''), '')
    await emit({kind:'focus',key:'focus-off',enabled:false})
    await page.waitForFunction(id => !window.__aitermTest.snapshot(id).modes.sendFocusMode, sid)
    result.focusReportBytes = readFileSync(sourceInput,'utf8')
    writeFileSync(sourceInput,'') // this synthetic receiver's capture only, after checking every byte
    const routes = [
      ['palette-session', async () => { await page.keyboard.press('Control+Shift+P'); await page.locator('.command-palette input').fill('Source'); await page.locator(`#palette-session-${sid}`).click() }],
      ['recent-session', async () => { await page.keyboard.press('Control+Shift+R'); await page.locator(`#palette-session-${sid}`).click() }],
      ['next-session', async () => page.keyboard.press('Control+Shift+ArrowDown')]
    ]
    for (const [name,navigate] of routes) {
      await select(target.session.sessionId)
      await emit({kind:'notice',key:name,title:`Route ${name}`})
      await navigate(); await waitState(name,'withdrawn')
    }
    const firstSession = (await page.evaluate(wid => window.aiTerminal.listSessions(wid), workspace.workspaceId))[0]
    await select(firstSession.sessionId)
    await emit({kind:'notice',key:'previous-session',title:'Previous session route'})
    await page.keyboard.press('Control+Shift+ArrowUp'); await waitState('previous-session','withdrawn')
    const extraWorkspace = await page.evaluate(cwd => window.aiTerminal.createWorkspace({name:'Other routes',defaultCwd:cwd}),root)
    await page.reload(); await page.waitForSelector('.shell-window'); await select(sid)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await emit({kind:'notice',key:'workspace-shortcut',title:'Workspace shortcut'})
    await page.keyboard.press('Control+Shift+ArrowLeft'); await waitState('workspace-shortcut','withdrawn')
    await page.keyboard.press('Control+Shift+ArrowRight')
    await emit({kind:'notice',key:'workspace-palette',title:'Workspace palette'})
    await page.keyboard.press('Control+Shift+P'); await page.locator('.command-palette input').fill(workspace.name)
    await page.locator(`#palette-workspace-${workspace.workspaceId}`).click(); await waitState('workspace-palette','withdrawn')
    await page.keyboard.press('Control+Shift+ArrowRight')
    await emit({kind:'notice',key:'workspace-row',title:'Workspace row'})
    await page.getByRole('region',{name:workspace.name,exact:true}).locator('.workspace-row button').first().click()
    await waitState('workspace-row','withdrawn')
    const workspaceRow = page.getByRole('region',{name:workspace.name,exact:true}).locator('.workspace-row button').first()
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await emit({kind:'notice',key:'pane-tab',title:'Explicit keyboard entry'})
    await page.locator(`.session-terminal[data-session-id="${sid}"] .pane-actions button`).first().focus()
    await page.keyboard.press('Tab'); await waitState('pane-tab','withdrawn')
    result.explicitRoutes = [...routes.map(([name])=>name),'workspace-shortcut','workspace-palette','workspace-row','pane-tab']
    result.extraWorkspaceId = extraWorkspace.workspaceId
    await emit({ kind: 'manual', key: 'manual', title: 'Manual decision' })
    await openCard()
    await card('Manual decision').getByRole('button', { name: 'Mark answered', exact: true }).click()
    await waitState('manual', 'answered')
    await emit(question('keep-question'))
    await select(target.session.sessionId); await select(sid)
    assert.ok((await rows()).some(r => r.kind === 'question' && r.state === 'open'))
    // Native notification navigation preserves the blocking request and clears notices only.
    await emit({ kind: 'notice', key: 'notification-notice', title: 'Notification update', body: 'Read this exact notification body' })
    await select(target.session.sessionId)
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('aiterm:open-session', id), sid)
    await waitState('notification-notice', 'withdrawn')
    await openCard()
    assert.ok((await card('Notification update').innerText()).includes('Read this exact notification body'))
    assert.equal(await card('Notification update').locator('button,.status-dot').count(), 0)
    await page.keyboard.press('Escape'); await openCard()
    await card('Notification update').waitFor()
    // Outside activation keeps the destination, including its keyboard focus.
    await page.getByRole('button', { name: 'Command palette', exact: true }).click()
    await page.waitForSelector('.command-palette input:focus')
    assert.equal(await page.locator('.session-request-card').count(), 0)
    await page.keyboard.press('Escape')
    await select(target.session.sessionId); await select(sid)
    await openCard()
    assert.equal(await card('Notification update').count(), 0)
    await page.keyboard.press('Escape')
    // A notice arriving in the selected pane and a renderer remount acknowledge nothing.
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].blur())
    await emit({ kind: 'notice', key: 'same-selection', title: 'Selected pane update', body: 'Exact selected body' })
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].focus())
    await waitState('same-selection', 'open')
    await page.reload(); await page.waitForSelector('.shell-window')
    await waitState('same-selection', 'open')
    await select(sid)
    await waitState('same-selection', 'withdrawn')
    await openCard(); await card('Selected pane update').waitFor()
    await page.keyboard.press('Escape')
    await emit({ kind: 'notice', key: 'same-pane', title: 'Pointer pane update' })
    await page.locator(`.session-terminal[data-session-id="${sid}"] .xterm-screen`).click()
    await waitState('same-pane', 'withdrawn')
    // Revision replacement and removal recover only genuinely lost focus; arrival does not steal it.
    await openCard()
    const firstQuestion = card('Which color?')
    await firstQuestion.getByRole('button', { name: 'Dismiss', exact: true }).focus()
    await emit({ kind: 'review', key: 'neighbor', title: 'Review neighbor' })
    assert.ok(await firstQuestion.getByRole('button', { name: 'Dismiss', exact: true }).evaluate(el => el === document.activeElement))
    await firstQuestion.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await card('Review neighbor').getByRole('button', { name: 'Dismiss', exact: true }).waitFor()
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('.session-request-card')))
    const reviewBefore = (await rows()).find(row => row.requestKey === 'neighbor')
    await card('Review neighbor').getByRole('button', { name: 'Dismiss', exact: true }).focus()
    await emit({ kind: 'review', key: 'neighbor', title: 'Revised review neighbor' })
    await page.waitForFunction(id => document.querySelector(`article[data-request-id="${id}"]`)?.dataset.requestRevision !== '1', reviewBefore.requestId)
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('.session-request-card')))
    await page.keyboard.press('Escape')
    await select(target.session.sessionId)
    await page.keyboard.press('Control+Shift+U')
    await card('Revised review neighbor').waitFor() // review shortcut opens its card
    assert.ok(await page.getByRole('button',{name:'Close session requests',exact:true}).evaluate(el=>el===document.activeElement), 'Review shortcut retains card focus')
    await card('Revised review neighbor').getByRole('button', { name: 'Dismiss', exact: true }).click()
    await emit({ kind: 'handoff', key: 'handoff' }); await openCard()
    const handoff = card('Handoff to')
    assert.ok((await handoff.innerText()).includes('Destination'))
    assert.ok((await handoff.innerText()).includes(root))
    await handoff.getByRole('button', { name: 'Open handoff', exact: true }).click()
    await page.waitForSelector('.handoff-form textarea')
    assert.equal(readFileSync(input, 'utf8'), '')
    const draft = (await page.evaluate(() => window.aiTerminal.listDrafts())).find(d => d.sourceSessionId === sid && d.state === 'draft')
    assert.ok(draft)
    result.savedDraftId = draft.draftId
    await page.getByRole('button', { name: 'Save handoff', exact: true }).click()
    result.saveTransition = { expectedDraftId: draft.draftId, editorBeforeWait: await page.locator('.handoff-form').count() }
    await page.waitForSelector('.handoff-form', { state: 'detached' })
    await page.locator('#handoff-'+draft.draftId).waitFor()
    const savedDraft = (await page.evaluate(() => window.aiTerminal.listDrafts())).find(d => d.draftId === draft.draftId)
    assert.equal(savedDraft.state, 'draft')
    assert.equal(savedDraft.text, draft.text)
    assert.equal(readFileSync(sourceInput, 'utf8'), '')
    assert.equal(readFileSync(input, 'utf8'), '')
    assert.equal(await page.locator('#handoff-'+draft.draftId).count(), 1)
    assert.match(await page.locator('#handoff-'+draft.draftId+' .files-action-outcome').innerText(), /Saved\. Not sent\./)
    await page.keyboard.press('Escape')
    await select(target.session.sessionId)
    await emit({kind:'notice',key:'handoff-review-navigation',title:'Handoff review navigation'})
    await page.getByRole('button',{name:`Actions for ${workspace.name}`,exact:true}).click()
    await page.getByRole('menuitem',{name:'Review results…',exact:true}).click()
    await page.getByRole('button',{name:'Review handoff',exact:true}).click()
    await waitState('handoff-review-navigation','withdrawn')
    await page.waitForSelector('.handoff-form textarea')
    await page.getByRole('button',{name:'Save handoff',exact:true}).click()
    await page.waitForSelector('.handoff-form',{state:'detached'})
    await emit({ kind: 'review', key: 'stopped-review', title: 'Survives restart' })
    writeFileSync(targetTrigger,'')
    await waitState('other-review','open')
    await page.evaluate(id => window.aiTerminal.stopSession(id), target.session.sessionId)
    await page.evaluate(id => window.aiTerminal.stopSession(id), sid)
    await waitForAsyncState(page, async ({wid,ids}) => { const sessions=await window.aiTerminal.listSessions(wid); return ids.every(id=>sessions.find(s=>s.sessionId===id)?.lastProcess?.state==='exited') }, {wid:workspace.workspaceId,ids:[sid,target.session.sessionId]})
    const stoppedRecords = await rows()
    const stoppedReview = stoppedRecords.find(r => r.requestKey === 'stopped-review')
    const otherReview = stoppedRecords.find(r => r.requestKey === 'other-review')
    assert.equal(stoppedReview.sessionId, sid)
    assert.equal(otherReview.sessionId, target.session.sessionId)
    assert.equal(otherReview.state, 'open')
    result.stoppedReview = { requestId: stoppedReview.requestId, revision: stoppedReview.revision, sessionId: sid }
    result.otherReview = { requestId: otherReview.requestId, revision: otherReview.revision, sessionId: target.session.sessionId }
    await page.locator(`.session-terminal[data-session-id="${sid}"] .pane-exit`).waitFor()
    await openCard()
    await card('Survives restart').waitFor()
    await page.keyboard.press('Escape')
    await stopTestSessions(page)
    await bounded(app.close(), 'synthetic restart close')
    app = await _electron.launch(launchOptions)
    const restarted = await app.firstWindow({ timeout: 15000 })
    await restarted.waitForSelector('.shell-window')
    await restarted.locator(`.session-row button[data-session-id="${sid}"]`).click()
    await restarted.locator('.stopped-session').waitFor()
    await waitForAsyncState(restarted, async (expected) => {
      const records = await window.aiTerminal.listAttention()
      return expected.every(item => records.some(record => record.requestId === item.requestId && record.sessionId === item.sessionId && record.kind === 'review' && record.revision === item.revision && record.state === 'open'))
    }, [result.stoppedReview, result.otherReview])
    await restarted.keyboard.press('Control+Shift+Z')
    await restarted.waitForFunction(() => document.querySelector('.stopped-request-heading button[aria-pressed="true"]')?.title.includes('1 session waiting for your response'))
    const stoppedFocus = restarted.locator('.stopped-request-heading button[aria-pressed="true"]')
    assert.match(await stoppedFocus.getAttribute('title'), /1 session waiting for your response/)
    assert.equal(await stoppedFocus.locator('.status-dot.needs-you').count(),1)
    await restarted.screenshot({path:join(evidence,'stopped-focus-cue.png')})
    await stoppedFocus.click()

    await restarted.locator(`[data-session-requests="${sid}"]`).click()
    await restarted.getByRole('dialog', { name: 'Session requests', exact: true }).waitFor()
    assert.ok((await restarted.locator('.attention-item').innerText()).includes('Survives restart'))
    await restarted.keyboard.press('Escape')
    const saved = (await restarted.evaluate(wid => window.aiTerminal.listSessions(wid), workspace.workspaceId)).find(s => s.sessionId === sid)
    await restarted.evaluate(s => window.aiTerminal.updateSession({ sessionId: s.sessionId, expectedRevision: s.revision, archived: true }), saved)
    await restarted.getByLabel('Show archived', { exact: true }).check()
    await restarted.locator(`.session-row button[data-session-id="${sid}"]`).click()
    await restarted.locator(`[data-session-requests="${sid}"]`).click()
    await restarted.locator('.attention-item').getByRole('button', { name: 'Dismiss', exact: true }).click()
    await waitForAsyncState(restarted, async () => (await window.aiTerminal.listAttention()).find(r => r.requestKey === 'stopped-review')?.state === 'withdrawn')
    assert.equal((await restarted.evaluate(() => window.aiTerminal.listAttention())).find(r => r.requestKey === 'stopped-review').state, 'withdrawn')
    result.status = 'passed'
    result.checks = ['notice-only selection/notification/pointer', 'no acknowledgement on arrival/remount', 'snapshot exact text/reopen/lifetime',
      'read-only multi-question', 'focus arrival/removal/revision/outside/Escape', 'review shortcut', 'handoff Files preserves draft/no input', 'stopped restart/archived actions']
    writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log('PASS Epic59 pane requests', JSON.stringify(result.checks))
  } catch (error) {
    const activePage = (await app.windows())[0]
    result.focusAtFailure = await Promise.race([activePage?.evaluate(() => ({ active: document.activeElement?.outerHTML, card: document.querySelector('.session-request-card')?.outerHTML })).catch(() => null), new Promise(resolve => setTimeout(() => resolve({ diagnosticTimedOut: true }), 3000))])
    await activePage?.screenshot({ path: join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {})
    result.status = 'failed'; result.error = String(error)
    writeAtomic(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    throw error
  } finally {
    const page = (await app.windows())[0]
    if (page) await stopTestSessions(page)
    await bounded(app.close(), 'synthetic final close')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
