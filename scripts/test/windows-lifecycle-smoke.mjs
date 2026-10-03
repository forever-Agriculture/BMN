/* global window */
// Actual BMN lifecycle, with retained Windows handles observing synthetic trees.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { windowsExitObserver } from '../lib/windows-exit-observer.mjs'

assert.equal(process.platform, 'win32')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(repo, 'test-results')
mkdirSync(output, { recursive: true })
const observations = []
const waitFor = async (probe, description) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value } catch { /* startup/recovery may still be in progress */ }
    await delay(100)
  }
  throw new Error(description)
}
try {
  await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
    const env = { ...process.env,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
      XDG_RUNTIME_DIR: roots.runtime, XDG_CACHE_HOME: roots.cache,
      CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
      OPENCODE_CONFIG_DIR: join(roots.config, 'opencode') }
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'BMN_PTY_INCARNATION_ID'].includes(key.toUpperCase())) delete env[key]
    const options = { executablePath: createRequire(join(repo, 'apps/desktop/package.json'))('electron'),
      cwd: repo, args: [join(repo, 'apps/desktop'), '--bmn-test-mode'], env, chromiumSandbox: true, timeout: 45000 }
    let app, page
    const open = async () => {
      app = await _electron.launch(options)
      page = await app.firstWindow(); page.setDefaultTimeout(20000)
      await page.waitForFunction(async () => {
        try { return (await window.aiTerminal.listWorkspaces()).length > 0 } catch { return false }
      })
    }
    const fixture = join(root, 'lifecycle.cjs')
    writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const [dir,role='root']=process.argv.slice(2);
function publish(name,value){const file=path.join(dir,name);fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file)}
if(role==='root'){let starts=0;try{starts=JSON.parse(fs.readFileSync(path.join(dir,'starts.json'),'utf8'))}catch{};publish('starts.json',starts+1)}
publish(role+'.json',{pid:process.pid});
if(role!=='grandchild')cp.spawn(process.execPath,[__filename,dir,role==='root'?'child':'grandchild'],{stdio:'ignore',detached:true});
if(role==='root')process.stdout.write('BMN_LIFECYCLE_READY\\r\\n');
setInterval(()=>{if(role==='root')publish('heartbeat.json',Date.now())},100);
`)
    const start = async (name, backgroundChoice) => {
      const directory = join(root, name); mkdirSync(directory)
      const workspace = (await page.evaluate(() => window.aiTerminal.listWorkspaces()))[0]
      const created = await page.evaluate(params => window.aiTerminal.createSession(params), {
        workspaceId: workspace.workspaceId, name, cwd: directory, executable: process.execPath,
        argv: [fixture, directory], cols: 80, rows: 24, backgroundChoice
      })
      const pids = []
      for (const role of ['root', 'child', 'grandchild']) {
        const record = await waitFor(() => JSON.parse(readFileSync(join(directory, role + '.json'), 'utf8')), 'Lifecycle tree not ready')
        pids.push(record.pid)
      }
      const entries = await app.evaluate(({ app }, pids) => {
        const builtin = process.mainModule.require.bind(process.mainModule)
        const require = builtin('node:module').createRequire(builtin('node:path').join(app.getAppPath(), 'package.json'))
        const native = require('node-pty')
        return pids.map(pid => {
          const identity = native.queryProcessStartIdentity(pid)
          if (!/^windows-filetime:[0-9]+$/.test(identity)) throw new Error('Native creation identity unavailable')
          return { pid, creationTime: Number(BigInt(identity.slice('windows-filetime:'.length)) / 10000n) - 11644473600000 }
        })
      }, pids)
      await page.reload()
      await page.locator(`.session-row button[data-session-id="${created.session.sessionId}"]`).click()
      return { ...created, directory, entries }
    }
    const heartbeat = async session => {
      const before = JSON.parse(readFileSync(join(session.directory, 'heartbeat.json'), 'utf8'))
      await waitFor(() => JSON.parse(readFileSync(join(session.directory, 'heartbeat.json'), 'utf8')) > before, 'Process did not remain alive')
    }
    const unchanged = async session => {
      const records = await page.evaluate(id => window.aiTerminal.listSessions(id), session.session.workspaceId)
      const record = records.find(record => record.sessionId === session.session.sessionId)
      assert.equal(record.lastProcess.incarnationId, session.startup.incarnationId)
      assert.equal(record.lastProcess.state, 'live')
      await heartbeat(session)
    }
    const exitedApp = () => once(app.process(), 'exit', { signal: AbortSignal.timeout(30000) })
    const verifyRestart = async session => {
      await open()
      const records = await page.evaluate(id => window.aiTerminal.listSessions(id), session.session.workspaceId)
      const record = records.find(record => record.sessionId === session.session.sessionId)
      assert.equal(record.lastProcess.state, 'interrupted')
      assert.equal(record.lastProcess.incarnationId, session.startup.incarnationId)
      assert.equal(JSON.parse(readFileSync(join(session.directory, 'starts.json'), 'utf8')), 1)
      return record.lastProcess.state
    }
    try {
      await open()
      const kept = await start('renderer-and-hide', 'hide')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
      await waitFor(async () => {
        const records = await page.evaluate(id => window.aiTerminal.listSessions(id), kept.session.workspaceId)
        return records.some(record => record.sessionId === kept.session.sessionId)
      }, 'Renderer did not recover')
      await unchanged(kept)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'Keep-running Close did not minimize')
      await heartbeat(kept)
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show() })
      await unchanged(kept)
      let observer = await windowsExitObserver(kept.entries)
      try {
        await page.evaluate(id => window.aiTerminal.stopSession(id), kept.session.sessionId)
        observations.push({ mode: 'renderer-crash-and-keep-running-close', incarnationPreserved: true, ...await observer.finish() })
      } finally { await observer.abort() }

      const closed = await start('close-stop', 'stop')
      observer = await windowsExitObserver(closed.entries)
      try {
        const exited = exitedApp()
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
        await exited
        const cleanup = await observer.finish()
        observations.push({ mode: 'close-stop-restart', ...cleanup, recoveredState: await verifyRestart(closed), automaticRestart: false })
      } finally { await observer.abort() }

      const asked = await start('ask-and-quit', null)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      const closeDialog = page.getByRole('dialog', { name: 'Close BMN?', exact: true })
      await closeDialog.waitFor()
      await closeDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await unchanged(asked)
      await app.evaluate(({ app }) => { app.quit() })
      const quitDialog = page.getByRole('dialog', { name: 'Quit BMN?', exact: true })
      await quitDialog.waitFor()
      await quitDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await unchanged(asked)
      observer = await windowsExitObserver(asked.entries)
      try {
        const exited = exitedApp()
        await app.evaluate(({ app }) => { app.quit() })
        await quitDialog.getByRole('button', { name: 'Quit BMN', exact: true }).click()
        await exited
        const cleanup = await observer.finish()
        observations.push({ mode: 'ask-cancel-and-quit-restart', cancelPreservedProcess: true, ...cleanup,
          recoveredState: await verifyRestart(asked), automaticRestart: false })
      } finally { await observer.abort() }

      const crashed = await start('host-crash', 'stop')
      const host = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'pty-host' || metric.serviceName === 'pty-host')
        .map(({ pid, creationTime }) => ({ pid, creationTime })))
      assert.equal(host.length, 1, 'Expected exactly one utility host owned by this app')
      observer = await windowsExitObserver([...host, ...crashed.entries], 0)
      try {
        const cleanup = await observer.finish()
        // Restart this isolated main process after its utility was forcibly lost.
        // The retained observer has already confirmed that the entire tree exited.
        const exited = exitedApp(); app.process().kill(); await exited
        observations.push({ mode: 'utility-crash-restart', ...cleanup,
          recoveredState: await verifyRestart(crashed), automaticRestart: false })
      } finally { await observer.abort() }
    } catch (error) {
      await page?.screenshot({ path: join(output, 'windows-lifecycle-failure.png') }).catch(() => {})
      throw error
    } finally {
      await page?.evaluate(async () => {
        for (const workspace of await window.aiTerminal.listWorkspaces())
          for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }).catch(() => {})
      if (app?.process().exitCode === null) await app.close()
    }
  })
  console.log(JSON.stringify({ passed: true, observations }))
} finally { writeFileSync(join(output, 'windows-lifecycle-observations.json'), JSON.stringify(observations, null, 2)) }
