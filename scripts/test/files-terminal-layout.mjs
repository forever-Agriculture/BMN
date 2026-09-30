/* global window, document, getComputedStyle */
// Opening Files must keep the live terminal grid inside its viewport, with intact row backgrounds.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = process.argv.indexOf('--binary')
const packaged = flag < 0 ? null : resolve(process.argv[flag + 1])
const binary = packaged ?? createRequire(join(repo, 'apps/desktop/package.json'))('electron')
const evidence = process.env.BMN_LAYOUT_EVIDENCE ?? join(repo, '.dev-auto/evidence/files-terminal/runtime')
mkdirSync(evidence, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const fixture = join(root, 'terminal.mjs'), input = join(root, 'input.txt')
  writeFileSync(fixture, `import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);
process.stdin.on('data',b=>appendFileSync(${JSON.stringify(input)},b));
function draw(){const cols=process.stdout.columns;process.stdout.write('\\x1b[2J\\x1b[HLEFT EDGE - OpenAI Codex synthetic\\r\\n'+
'\\x1b[48;2;48;48;48m'+('> Files resize background ').padEnd(cols,' ')+'\\x1b[0m\\r\\n'+
'LEFT EDGE - text remains readable\\r\\n');}
process.stdout.on('resize',()=>{process.stdout.write('\\x1b[4;1H\\x1b[48;2;48;48;48m'+('> Current prompt ').padEnd(process.stdout.columns,' ')+'\\x1b[0m')});setTimeout(draw,500);setInterval(()=>{},1000);`)
  const env = { ...process.env }
  if (env.WAYLAND_DISPLAY && !isAbsolute(env.WAYLAND_DISPLAY)) env.WAYLAND_DISPLAY=join(env.XDG_RUNTIME_DIR,env.WAYLAND_DISPLAY)
  for (const key of ['BMN_TOKEN','BMN_SESSION_ID','BMN_CONTROL_SOCKET','BMN_PTY_INCARNATION_ID']) delete env[key]
  const app = await _electron.launch({ executablePath: binary, cwd: repo, timeout: 20000,
    args: [...(packaged ? [] : [join(repo,'apps/desktop')]), ...(!env.WAYLAND_DISPLAY && env.DISPLAY ? ['--ozone-platform=x11'] : []), '--bmn-test-mode','--','/bin/bash','--noprofile','--norc'],
    env: { ...env, ...Object.fromEntries(Object.entries(roots).map(([k,v])=>['XDG_'+k.toUpperCase()+'_HOME',v])),
      XDG_RUNTIME_DIR: roots.runtime, BMN_CONFIG_HOME: join(roots.config,'bmn'), BMN_DATA_HOME: join(roots.data,'bmn'),
      BMN_STATE_HOME: join(roots.state,'bmn'), BMN_RUNTIME_HOME: join(roots.runtime,'bmn'), BMN_LAUNCH_CWD: root }
  })
  const results = []
  try {
    console.log('Fixture: Electron launched')
    const page = await app.firstWindow();page.setDefaultTimeout(15000)
    await page.waitForSelector('.session-row')
    const sessionId = await page.evaluate(async p=>{
      const ws=(await window.aiTerminal.listWorkspaces())[0]
      return (await window.aiTerminal.createSession({...p,workspaceId:ws.workspaceId})).session.sessionId
    },{name:'Files resize fixture',cwd:root,executable:process.execPath,argv:[fixture],cols:100,rows:30,backgroundChoice:'stop'})
    console.log('Fixture: session created',sessionId)
    await page.reload();await page.locator(`.session-row > button[data-session-id="${sessionId}"]`).click()
    await page.waitForFunction(id=>window.__aitermTest?.snapshot(id)?.bufferLines.some(l=>l.includes('LEFT EDGE')||l.includes('OpenAI Codex')||l.includes('trust')),sessionId)
    for (const layout of ['normal','focus','split']) {
    const action=page.locator('.session-terminal.selected .pane-actions button').filter({hasText:layout==='focus'?'Focus':'Split'})
    if(layout!=='normal') await action.click()
    if(layout==='split') {
      await page.locator('dialog[open]').getByRole('textbox').press('Enter')
      await page.waitForFunction(()=>document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)').length===2)
      await page.locator(`.session-terminal[data-session-id="${sessionId}"] .pane-heading strong`).click()
      await page.waitForTimeout(100)
    }
    for (const [width,height] of [[1653,1300],[1380,1300],[1280,900],[1000,700],[800,500]]) {
      await app.evaluate(({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(0,0);w.setContentSize(...size);w.show()},[width,height])
      await page.waitForTimeout(350)
      const beforeFiles=await page.evaluate(id=>window.__aitermTest.snapshot(id),sessionId)
      for (const state of ['closed','open','closed-again']) {
        if(state==='open') {
          await page.locator('.session-terminal.selected .pane-actions button').filter({hasText:'Files'}).focus()
          await page.keyboard.press('Enter')
          await page.waitForTimeout(100)
          assert.equal(await page.locator('.files-close').evaluate(el=>el===document.activeElement),true,
            'Opening Files left keyboard focus behind the drawer')
        }
        if(state==='closed-again') await page.keyboard.press('Enter')
        await page.waitForTimeout(350)
        const data=await page.evaluate(id=>{
          const pane=document.querySelector(`.session-terminal[data-session-id="${id}"]`)
          const surface=pane.querySelector('.terminal-surface'),screen=pane.querySelector('.xterm-screen'),viewport=pane.querySelector('.xterm-viewport')
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}}
          const snapshot=window.__aitermTest.snapshot(id)
          return {surface:rect(surface),screen:rect(screen),viewport:rect(viewport),scrollLeft:viewport.scrollLeft,
            snapshot,bodyWidth:document.body.scrollWidth,windowWidth:window.innerWidth,
            rows:[...pane.querySelectorAll('.xterm-rows>div')].slice(0,3).map(row=>({text:row.textContent,rect:rect(row),
              spans:[...row.children].map(span=>({text:span.textContent,rect:rect(span),bg:getComputedStyle(span).backgroundColor,display:getComputedStyle(span).display}))}))}
        },sessionId)
        results.push({layout,width,height,state,...data})
        writeFileSync(join(evidence,'result.json'),JSON.stringify(results,null,2))
        await page.screenshot({path:join(evidence,`${layout}-${width}-${state}.png`)})
        assert.deepEqual([data.snapshot.cols,data.snapshot.rows],[beforeFiles.cols,beforeFiles.rows],
          'Files changed the live terminal grid and reflowed inline TUI history')
        assert.equal(data.scrollLeft,0,'Terminal scrolled sideways when Files changed')
        assert.ok(data.screen.left>=data.surface.left && data.screen.right<=data.surface.right+1,'Terminal grid clipped when Files changed')
        assert.equal(data.bodyWidth,data.windowWidth,'Files overflowed the application viewport')
        assert.equal(data.snapshot.cols,data.snapshot.ptyCols,'Displayed and PTY columns disagree')
        const spans=data.rows[1].spans
        for(let i=1;i<spans.length;i++) assert.ok(Math.abs(spans[i].rect.left-spans[i-1].rect.right)<1,'Gap in terminal row background')
        assert.equal(readFileSync(input,'utf8'),'','Opening Files sent input to the running process')
        if(state==='closed-again') assert.equal(await page.locator('.session-terminal.selected button[aria-label="Files"]').evaluate(el=>el===document.activeElement),true,
          'Closing Files did not restore keyboard focus')
      }
    }
    if(layout!=='normal') await action.click()
    }
    console.log('PASS: Files keyboard layout in normal/focus/split at five sizes; zero input, matching PTY grid, intact rows')
  } catch(error) { console.error(error);throw error }
  finally { await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close() }
})
