/* global window */
// Actual BMN lifecycle, with retained Windows handles observing synthetic trees.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'
import { waitForAsyncPagePredicate } from '../lib/async-page-predicate.mjs'
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
      await waitForAsyncPagePredicate(page, async () => {
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
    // Measure the original utility-loss -> main-death sequence with the debugger
    // attached, alongside a protected direct launch. No missing RED is called proof.
    for (const { mode, directLaunch } of [
      { mode: 'protected', directLaunch: true },
      { mode: 'without-backstop', directLaunch: false },
      { mode: 'protected', directLaunch: false }
    ]) {
      const probeRoot = join(root, `${mode}-${directLaunch ? 'direct' : 'debugger'}`)
      mkdirSync(probeRoot)
      const report = join(output, `windows-application-crash-${mode}-${directLaunch ? 'direct' : 'debugger'}.json`)
      const probeEnv = { ...env,
        BMN_CONFIG_HOME: join(probeRoot, 'config'), BMN_DATA_HOME: join(probeRoot, 'data'),
        BMN_STATE_HOME: join(probeRoot, 'state'), BMN_RUNTIME_HOME: join(probeRoot, 'runtime') }
      const probeArgs = [join(repo, 'scripts/test/fixtures/windows-application-crash.mjs'),
        repo, probeRoot, process.execPath, fixture, report, mode, '--bmn-test-mode']
      const debugApp = directLaunch ? null : await _electron.launch({ ...options, args: probeArgs, env: probeEnv })
      const probe = debugApp?.process() ?? spawn(options.executablePath, probeArgs, { cwd: repo, env: probeEnv, stdio: 'inherit' })
      let held
      const probeTimer = setTimeout(() => { if (probe.exitCode === null) probe.kill() }, 60000)
      try {
        const ready = await waitFor(() => JSON.parse(readFileSync(report, 'utf8')), 'Direct crash probe did not become ready')
        assert.equal(ready.ready, true, ready.error)
        const mainIndex = ready.entries.findIndex(entry => entry.pid === ready.mainPid)
        const utilityIndex = ready.entries.findIndex(entry => entry.pid === ready.utilityPid)
        assert.ok(mainIndex >= 0 && utilityIndex >= 0)
        const beforeKill = directLaunch ? [] : [{ killIndex: utilityIndex,
          waitIndices: ready.entries.flatMap((entry, index) =>
            entry.pid === ready.utilityPid || ready.terminalPids.includes(entry.pid) ? [index] : []) }]
        held = await windowsExitObserver(ready.entries, mainIndex, beforeKill)
        if (mode === 'without-backstop') {
          let missingBackstopObserved = false
          try { await held.finish() } catch (error) {
            assert.match(String(error), /Owned process survived lifecycle action/)
            missingBackstopObserved = true
          }
          observations.push({ mode: 'application-lifetime-baseline', directLaunch,
            utilityFirst: true, missingBackstopObserved,
            regressionProof: missingBackstopObserved ? 'RED' : 'INCONCLUSIVE' })
        } else {
          observations.push({ mode: 'application-lifetime-protected', directLaunch,
            utilityFirst: !directLaunch, ...await held.finish() })
        }
      } finally {
        clearTimeout(probeTimer)
        await held?.abort()
        if (probe.exitCode === null) probe.kill()
      }
    }
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
    // Processes still referencing this isolated root, recorded when a relaunch is refused.
    const lingering = () => {
      try {
        return JSON.parse(execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
          `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${root.replaceAll("'", "''")}') } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;parentAlive=($null -ne (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue));name=$_.Name;type=([regex]::Match($_.CommandLine,'--type=([a-z-]+)').Groups[1].Value);service=([regex]::Match($_.CommandLine,'--utility-sub-type=([A-Za-z.]+)').Groups[1].Value)} })`],
          { encoding: 'utf8', windowsHide: true }) || '[]')
      } catch (error) { return [{ queryError: String(error.message).split('\n')[0] }] }
    }
    const relaunchAttempts = []
    let killedMainPid
    // These are processes reported by this synthetic app, retained before termination.
    // Parent PIDs and text matches remain diagnostics, never termination authority.
    const electronTree = () => app.evaluate(({ app }) => {
      const builtin = process.mainModule.require.bind(process.mainModule)
      const require = builtin('node:module').createRequire(builtin('node:path').join(app.getAppPath(), 'package.json'))
      const identity = require('node-pty').queryProcessStartIdentity(process.pid)
      if (!/^windows-filetime:[0-9]+$/.test(identity)) throw new Error('Main process creation identity unavailable')
      const entries = new Map(app.getAppMetrics().map(({ pid, creationTime }) => [pid, { pid, creationTime }]))
      const metricsIncludedMain = entries.has(process.pid)
      entries.set(process.pid, { pid: process.pid,
        creationTime: Number(BigInt(identity.slice('windows-filetime:'.length)) / 10000n) - 11644473600000 })
      return { mainPid: process.pid, metricsIncludedMain, entries: [...entries.values()] }
    })
    const verifyRestart = async (session, { forcedExit = false } = {}) => {
      for (let attempt = 1; ; attempt += 1) {
        try { await open(); break } catch (error) {
          if (!forcedExit || attempt >= 15) throw error
          relaunchAttempts.push({ attempt, at: Date.now(), error: String(error.message).split('\n')[0].slice(0, 200), lingering: lingering() })
          await delay(1000)
        }
      }
      const records = await page.evaluate(id => window.aiTerminal.listSessions(id), session.session.workspaceId)
      const record = records.find(record => record.sessionId === session.session.sessionId)
      assert.equal(record.lastProcess.state, 'interrupted')
      assert.equal(record.lastProcess.incarnationId, session.startup.incarnationId)
      assert.equal(JSON.parse(readFileSync(join(session.directory, 'starts.json'), 'utf8')), 1)
      return record.lastProcess.state
    }
    try {
      // Playwright's CDP session asserts on late responses after a forced crash.
      // Exercise crash/recovery in the actual main process with no debugger attached.
      const crashReport = join(output, 'windows-renderer-crash.json')
      const crash = spawn(options.executablePath, [join(repo, 'scripts/test/fixtures/windows-renderer-crash.mjs'),
        repo, root, process.execPath, fixture, crashReport, '--bmn-test-mode'], { cwd: repo, env, stdio: 'inherit' })
      const crashTimer = setTimeout(() => crash.kill(), 90000)
      try { assert.equal((await once(crash, 'exit'))[0], 0, 'Renderer crash fixture failed') }
      finally { clearTimeout(crashTimer) }
      observations.push(JSON.parse(readFileSync(crashReport, 'utf8')))
      await open()
      const kept = await start('keep-running-close', 'hide')
      await unchanged(kept)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'Keep-running Close did not minimize')
      await heartbeat(kept)
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show() })
      await unchanged(kept)
      let observer = await windowsExitObserver(kept.entries)
      try {
        await page.evaluate(id => window.aiTerminal.stopSession(id), kept.session.sessionId)
        observations.push({ mode: 'keep-running-close', incarnationPreserved: true, ...await observer.finish() })
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

      const mainCrashed = await start('main-crash', 'stop')
      const mainTree = await electronTree()
      const beforeMainCrash = mainTree.entries
      observations.push({ mode: 'main-process-identity', launchedPid: app.process().pid, mainPid: mainTree.mainPid, metricsIncludedMain: mainTree.metricsIncludedMain, entries: beforeMainCrash })
      const mainIndex = beforeMainCrash.findIndex(entry => entry.pid === mainTree.mainPid)
      assert.ok(mainIndex >= 0, 'The process tree must include main')
      assert.ok(beforeMainCrash.length >= 3, 'Observe main and Electron descendants')
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
      observer = await windowsExitObserver([...beforeMainCrash, ...mainCrashed.entries], mainIndex)
      try {
        const exited = exitedApp()
        const cleanup = await observer.finish()
        await exited
        assert.equal(unrelated.exitCode, null, 'Application crash affected an unrelated process')
        observations.push({ mode: 'main-crash-restart', ...cleanup,
          electronProcesses: beforeMainCrash.length,
          recoveredState: await verifyRestart(mainCrashed), automaticRestart: false })
      } finally {
        await observer.abort()
        if (unrelated.exitCode === null) unrelated.kill()
      }

      const crashed = await start('host-crash', 'stop')
      const host = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'pty-host' || metric.serviceName === 'pty-host')
        .map(({ pid, creationTime }) => ({ pid, creationTime })))
      assert.equal(host.length, 1, 'Expected exactly one utility host owned by this app')
      observer = await windowsExitObserver([...host, ...crashed.entries], 0)
      try {
        const cleanup = await observer.finish()
        // Restart this isolated main process after its utility was forcibly lost.
        // The retained observer has already confirmed that the entire tree exited.
        const remainingTree = await electronTree()
        killedMainPid = remainingTree.mainPid
        const remainingElectron = remainingTree.entries.filter(entry => !host.some(killed => killed.pid === entry.pid))
        const mainIndex = remainingElectron.findIndex(entry => entry.pid === killedMainPid)
        assert.ok(mainIndex >= 0, 'Observe main after utility loss')
        const remainingObserver = await windowsExitObserver(remainingElectron, mainIndex)
        const exited = exitedApp()
        let electronCleanup
        try { electronCleanup = await remainingObserver.finish(); await exited }
        finally { await remainingObserver.abort() }
        const killedAt = Date.now()
        const recoveredState = await verifyRestart(crashed, { forcedExit: true })
        observations.push({ mode: 'utility-crash-restart', ...cleanup, recoveredState, automaticRestart: false,
          killedMainPid, electronCleanup,
          refusedRelaunches: relaunchAttempts.map(entry => ({ ...entry, afterKillMs: entry.at - killedAt })) })
      } finally { await observer.abort() }
    } catch (error) {
      if (relaunchAttempts.length) observations.push({ mode: 'refused-relaunches', killedMainPid, relaunchAttempts })
      await page?.screenshot({ path: join(output, 'windows-lifecycle-failure.png') }).catch(() => {})
      throw error
    } finally {
      await page?.evaluate(async () => {
        for (const workspace of await window.aiTerminal.listWorkspaces())
          for (const session of await window.aiTerminal.listSessions(workspace.workspaceId)) await window.aiTerminal.stopSession(session.sessionId).catch(() => {})
      }).catch(() => {})
      if (app?.process().exitCode === null) {
        // Playwright's Windows process is a cmd wrapper. Observe the actual final
        // Electron tree before closing, rather than treating wrapper exit as cleanup.
        const finalTree = await electronTree()
        const finalObserver = await windowsExitObserver(finalTree.entries)
        try {
          await app.close()
          observations.push({ mode: 'final-app-close', ...await finalObserver.finish() })
        } finally { await finalObserver.abort() }
      }
      observations.push({ mode: 'post-close-root-users', processes: lingering() })
    }
  })
  console.log(JSON.stringify({ passed: true, observations }))
} finally { writeFileSync(join(output, 'windows-lifecycle-observations.json'), JSON.stringify(observations, null, 2)) }
