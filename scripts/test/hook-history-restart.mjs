/* global window */
// A recognized synthetic hook producer on a real PTY, graceful restart, and the existing owner dialog.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = join(repo, '.dev-auto/evidence/epic-49/runtime'); mkdirSync(evidence, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const input = join(root, 'input'), trigger = join(root, 'emit'), ready = join(root, 'ready.json'), fixture = join(root, 'hooks.mjs')
  writeFileSync(fixture, `import {createConnection} from 'node:net';import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
process.stdout.write('hook producer ready\\r\\n');let ticks=0;setInterval(()=>process.stdout.write('heartbeat '+(++ticks)+'\\r\\n'),100);
function call(method,params){return new Promise((resolve,reject)=>{const socket=createConnection(process.env.BMN_CONTROL_SOCKET);let text='';
socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('Synthetic socket timeout'))});socket.on('error',()=>reject(new Error('Synthetic socket failure')));
socket.on('connect',()=>socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'auth',params:{token:process.env.BMN_TOKEN}})+'\\n'));
socket.on('data',b=>{text+=b.toString();while(text.includes('\\n')){const end=text.indexOf('\\n'),r=JSON.parse(text.slice(0,end));text=text.slice(end+1);
if(r.id===1){if(r.error){socket.destroy();reject(new Error('Synthetic auth refusal'));return}socket.write(JSON.stringify({jsonrpc:'2.0',id:2,method,params})+'\\n')}
else if(r.id===2){socket.end();resolve(r)}}})})}
let sent=false;setInterval(async()=>{if(sent||!existsSync(${JSON.stringify(trigger)}))return;sent=true;
try{for(let i=0;i<240;i++){const r=await call('hook.observe',{agent:'claude',event:'PostToolUse',toolName:'Bash',effects:[]});if(r.error)throw new Error('Synthetic hook refusal')}
await call('hook.observe',{agent:'claude',event:'secret-event',source:'secret-source',toolName:'secret-tool',model:'secret-model',apiHost:'secret.invalid',effects:[]});
await call('hook.observe',{agent:'claude',event:'SessionStart',source:'compact',effects:[]});
const forbidden=await call('hookEvents.list',{sessionId:process.env.BMN_SESSION_ID,includeHistory:true});
writeFileSync(${JSON.stringify(ready)},JSON.stringify({events:242,historyDenied:!!forbidden.error,heartbeats:ticks}));}
catch{writeFileSync(${JSON.stringify(ready)},JSON.stringify({error:'Synthetic producer failed'}))}},25);`)
  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY = join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID']) delete env[key]
  const launch = () => _electron.launch({ executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'), cwd: repo,
    args: [join(repo, 'apps/desktop'), ...(!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode'],
    env: { ...env, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'), BMN_LAUNCH_CWD: root }
  })
  let app = await launch()
  const close = async () => {
    const page = (await app.windows())[0]
    await page?.evaluate(async () => { for (const ws of await window.aiTerminal.listWorkspaces(true)) for (const s of await window.aiTerminal.listSessions(ws.workspaceId)) await window.aiTerminal.stopSession(s.sessionId).catch(() => {}) }).catch(() => {})
    await app.close()
  }
  try {
    let page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.shell-window')
    const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
    const created = await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: workspace.workspaceId,
      name: 'Hook history fixture', cwd: root, executable: process.execPath, argv: [fixture], cols: 100, rows: 30 })
    const sid = created.session.sessionId
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${sid}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(l => l.includes('hook producer ready')), sid)
    const before = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
    writeFileSync(trigger, '')
    const deadline = Date.now() + 20000
    while (!existsSync(ready)) { if (Date.now() >= deadline) throw new Error('Hook producer timed out'); await new Promise(resolve => setTimeout(resolve, 50)) }
    const producer = JSON.parse(readFileSync(ready, 'utf8')); assert.equal(producer.error, undefined); assert.equal(producer.historyDenied, true); assert.ok(producer.heartbeats > 0)
    const current = await page.evaluate(id => window.aiTerminal.listHookEvents(id, true), sid)
    assert.equal(current.events.length, 30); assert.equal(current.earlier.length, 0)
    assert.ok(current.events.some(event => event.toolName === 'secret-tool'), 'Live view was rewritten by retention projection')
    assert.equal(readFileSync(input, 'utf8'), '')
    const after = await page.evaluate(id => window.__aitermTest.snapshot(id), sid)
    assert.equal(before.cols, after.cols); assert.equal(before.rows, after.rows); assert.equal(after.inputEvents, before.inputEvents)
    assert.ok(after.bufferLines.some(l => l.includes('heartbeat')))
    await close()
    const path = join(roots.state, 'bmn/hook-events.json'), bytes = readFileSync(path, 'utf8')
    assert.equal(bytes.includes('secret'), false); assert.equal(JSON.parse(bytes).rows.length, 30)
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.session-row')
    const restarted = await page.evaluate(async id => ({ view: await window.aiTerminal.listHookEvents(id, true),
      observation: await window.aiTerminal.getHookObservation(id), origins: await window.aiTerminal.listHookOrigins(), attention: await window.aiTerminal.listAttention(),
      usage: await window.aiTerminal.listUsage(), progress: await window.aiTerminal.listProgress() }), sid)
    assert.equal(restarted.view.events.length, 0); assert.equal(restarted.view.earlier.length, 30); assert.equal(restarted.view.historyUnavailable, false)
    assert.equal(restarted.observation.state, 'none'); assert.deepEqual(restarted.origins, []); assert.deepEqual(restarted.attention, [])
    assert.deepEqual(restarted.usage, []); assert.deepEqual(restarted.progress, [])
    assert.ok(restarted.view.earlier.some(event => event.toolName === 'other'))
    await page.getByRole('button', { name: 'Actions for Hook history fixture', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Hook events…', exact: true }).click()
    await page.getByRole('list', { name: 'Earlier host run history', exact: true }).waitFor()
    assert.equal(await page.getByRole('list', { name: 'Earlier host run history', exact: true }).locator('li').count(), 30)
    assert.ok((await page.locator('.hook-events-dialog').innerText()).includes('This host run'))
    assert.ok((await page.locator('.hook-events-dialog').innerText()).includes('No hook events yet'))
    const viewports = []
    for (const size of [[800, 500], [1000, 700], [1280, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setContentSize(...size); w.show() }, size)
      const closeButton = page.getByRole('button', { name: 'Close Hook events — Hook history fixture', exact: true })
      await closeButton.focus()
      assert.ok(await closeButton.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth }))
      await page.screenshot({ path: join(evidence, `history-${size[0]}.png`) }); viewports.push(size)
    }
    await page.screenshot({ path: join(evidence, 'earlier-run.png') })
    await page.keyboard.press('Escape')
    await close()
    writeFileSync(path, '{'); unlinkSync(trigger); unlinkSync(ready)
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForSelector('.shell-window')
    const recovery = await page.evaluate(p => window.aiTerminal.createSession(p), { workspaceId: workspace.workspaceId,
      name: 'Recovery hook fixture', cwd: root, executable: process.execPath, argv: [fixture], cols: 100, rows: 30 })
    const rid = recovery.session.sessionId
    await page.reload(); await page.locator(`.session-row > button[data-session-id="${rid}"]`).click()
    await page.waitForFunction(id => window.__aitermTest.snapshot(id).bufferLines.some(l => l.includes('hook producer ready')), rid)
    writeFileSync(trigger, '')
    const recoveredDeadline = Date.now() + 20000
    while (!existsSync(ready)) { if (Date.now() >= recoveredDeadline) throw new Error('Recovery producer timed out'); await new Promise(resolve => setTimeout(resolve, 50)) }
    assert.equal(JSON.parse(readFileSync(ready, 'utf8')).error, undefined)
    const recovered = await page.evaluate(id => window.aiTerminal.listHookEvents(id, true), rid)
    assert.equal(recovered.events.length, 30); assert.equal(recovered.earlier.length, 0); assert.equal(recovered.historyUnavailable, true)
    assert.equal((await page.evaluate(id => window.aiTerminal.listHookEvents(id, true), sid)).earlier.length, 0)
    await page.getByRole('button', { name: 'Actions for Recovery hook fixture', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Hook events…', exact: true }).click()
    await page.locator('.hook-events-dialog [role="status"]').filter({ hasText: 'Recent history was unavailable' }).waitFor()
    await page.screenshot({ path: join(evidence, 'unavailable-history.png') })
    assert.equal(readFileSync(input, 'utf8'), '')
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ producer, normalRestart: true, historyRows: 30, liveRows: 0,
      stateNotReplayed: true, ownerOnly: true, sensitiveLabelsOmitted: true, liveLabelsPreserved: true, terminalResponsive: true,
      gridInputPreserved: true, fileBytes: Buffer.byteLength(bytes), directoryMode: '0700', fileMode: '0600', dialogHistoryLabel: true,
      viewports, unavailableHistoryExplained: true, liveAfterMalformedLoad: true }, null, 2))
  } finally { await close() }
})
console.log('Hook history restart runtime PASS')
