// Test-only Electron entry: exercise the real app without a renderer debugger.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

const [repo, root, node, fixture, report] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
const desktop = join(repo, 'apps/desktop')
app.setAppPath(desktop)
createRequire(import.meta.url)(join(desktop, 'out/main/index.js'))

const waitFor = async (probe, description) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value } catch { /* loading */ }
    await delay(100)
  }
  throw new Error(description)
}

void (async () => {
  let observer
  try {
    const window = await waitFor(() => BrowserWindow.getAllWindows()[0], 'No application window')
    const evaluate = (fn, value) => window.webContents.executeJavaScript(`(${fn})(${JSON.stringify(value) ?? ''})`)
    const workspace = await waitFor(() => evaluate(async () => (await globalThis.aiTerminal.listWorkspaces())[0]), 'Application not ready')
    const directory = join(root, 'renderer-crash'); mkdirSync(directory)
    const session = await evaluate(params => globalThis.aiTerminal.createSession(params), {
      workspaceId: workspace.workspaceId, name: 'renderer-crash', cwd: directory,
      executable: node, argv: [fixture, directory], cols: 80, rows: 24, backgroundChoice: 'stop'
    })
    const native = createRequire(join(desktop, 'package.json'))('node-pty')
    const entries = []
    for (const role of ['root', 'child', 'grandchild']) {
      const { pid } = await waitFor(() => JSON.parse(readFileSync(join(directory, role + '.json'), 'utf8')), 'Tree not ready')
      const identity = native.queryProcessStartIdentity(pid)
      assert.match(identity, /^windows-filetime:[0-9]+$/)
      entries.push({ pid, creationTime: Number(BigInt(identity.slice('windows-filetime:'.length)) / 10000n) - 11644473600000 })
    }
    const { windowsExitObserver } = await import(pathToFileURL(join(repo, 'scripts/lib/windows-exit-observer.mjs')).href)
    observer = await windowsExitObserver(entries)
    const gone = new Promise(resolve => window.webContents.once('render-process-gone', (_event, details) => resolve(details)))
    window.webContents.forcefullyCrashRenderer()
    const details = await gone
    assert.equal(details.reason, 'crashed')
    const record = await waitFor(async () => {
      const records = await evaluate(id => globalThis.aiTerminal.listSessions(id), workspace.workspaceId)
      return records.find(record => record.sessionId === session.session.sessionId)
    }, 'Renderer did not recover')
    assert.equal(record.lastProcess.incarnationId, session.startup.incarnationId)
    assert.equal(record.lastProcess.state, 'live')
    const heartbeat = () => JSON.parse(readFileSync(join(directory, 'heartbeat.json'), 'utf8'))
    const before = heartbeat()
    await waitFor(() => heartbeat() > before, 'Tree did not survive renderer crash')
    assert.equal(JSON.parse(readFileSync(join(directory, 'starts.json'), 'utf8')), 1)
    await evaluate(id => globalThis.aiTerminal.stopSession(id), session.session.sessionId)
    const cleanup = await observer.finish()
    writeFileSync(report, JSON.stringify({ mode: 'renderer-crash-recovery', reason: details.reason,
      incarnationPreserved: true, heartbeatContinued: true, automaticRestart: false, ...cleanup }))
    await observer.abort()
    app.exit(0)
  } catch (error) {
    writeFileSync(report, JSON.stringify({ passed: false, error: String(error.stack ?? error) }))
    await observer?.abort()
    app.exit(1)
  }
})()
