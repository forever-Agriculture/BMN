// Test-only direct Electron entry: no Playwright attachment and no production bypass flag.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureArguments } from '../../lib/fixture-arguments.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

const [repo, root, node, fixture, report, mode] = fixtureArguments(process.argv, fileURLToPath(import.meta.url))
assert.equal(process.platform, 'win32')
assert.ok(['protected', 'without-backstop'].includes(mode))
const desktop = join(repo, 'apps/desktop')
app.setAppPath(desktop)
const main = join(desktop, 'out/main/index.js')
if (mode === 'without-backstop') {
  // The pre-fix defect is the missing startup call. Remove exactly that call in
  // memory while keeping the same app, fixture, native build and root contracts.
  const source = readFileSync(main, 'utf8')
  const call = /^protectWindowsApplicationLifetime\(\);$/gm
  assert.equal([...source.matchAll(call)].length, 1)
  const baseline = new Module(main)
  baseline.filename = main
  baseline.paths = Module._nodeModulePaths(dirname(main))
  baseline._compile(source.replace(call, ''), main)
} else {
  createRequire(import.meta.url)(main)
}

const waitFor = async probe => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value } catch { /* startup */ }
    await delay(100)
  }
  throw new Error('Direct application crash fixture did not become ready')
}

void (async () => {
  try {
    const window = await waitFor(() => BrowserWindow.getAllWindows()[0])
    const evaluate = (fn, value) => window.webContents.executeJavaScript(`(${fn})(${JSON.stringify(value) ?? ''})`)
    const workspace = await waitFor(() => evaluate(async () => (await globalThis.aiTerminal.listWorkspaces())[0]))
    const directory = join(root, `direct-${mode}`)
    mkdirSync(directory)
    await evaluate(params => globalThis.aiTerminal.createSession(params), {
      workspaceId: workspace.workspaceId, name: `direct-${mode}`, cwd: directory,
      executable: node, argv: [fixture, directory], cols: 80, rows: 24, backgroundChoice: 'stop'
    })
    const native = createRequire(join(desktop, 'package.json'))('node-pty')
    const binding = createRequire(join(desktop, 'package.json'))('node-pty/lib/utils').loadNativeModule('conpty').module
    assert.throws(() => binding.queryApplicationLifetimeProcesses('extra'), /takes no arguments/)
    if (mode === 'without-backstop') assert.throws(() => native.queryApplicationLifetimeProcesses(), /not established/)
    const metrics = app.getAppMetrics()
    const hosts = metrics.filter(metric => metric.name === 'pty-host' || metric.serviceName === 'pty-host')
    assert.equal(hosts.length, 1, 'Observe the actual utility host')
    const terminalPids = []
    const identities = new Map(metrics.map(({ pid, creationTime }) => [pid, { pid, creationTime }]))
    for (const role of ['root', 'child', 'grandchild']) {
      const { pid } = await waitFor(() => JSON.parse(readFileSync(join(directory, role + '.json'), 'utf8')))
      const identity = native.queryProcessStartIdentity(pid)
      assert.match(identity, /^windows-filetime:[0-9]+$/)
      terminalPids.push(pid)
      identities.set(pid, { pid, creationTime: Number(BigInt(identity.slice('windows-filetime:'.length)) / 10000n) - 11644473600000 })
    }
    let jobSnapshot
    if (mode === 'protected') {
      jobSnapshot = native.queryApplicationLifetimeProcesses()
      assert.equal(jobSnapshot.listed, jobSnapshot.identified)
      assert.equal(jobSnapshot.entries.length, jobSnapshot.listed)
      assert.ok(jobSnapshot.entries.some(entry => entry.pid === process.pid))
      assert.ok(terminalPids.every(pid => jobSnapshot.entries.some(entry => entry.pid === pid)), 'Nested terminal jobs must appear in the application snapshot')
      for (const entry of jobSnapshot.entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['creationFileTime', 'creationTimeMs', 'pid'])
        assert.equal(entry.creationTimeMs, Number((BigInt(entry.creationFileTime) - 116444736000000000n) / 10000n))
      }
    }
    const entries = [...identities.values()]
    assert.ok(entries.some(entry => entry.pid === process.pid))
    assert.ok(entries.length >= 6, 'Retain main, Electron descendants and the terminal tree')
    const temporary = report + '.tmp'
    writeFileSync(temporary, JSON.stringify({ ready: true, mode, mainPid: process.pid, utilityPid: hosts[0].pid, terminalPids, entries, jobSnapshot }))
    const { renameSync } = await import('node:fs')
    renameSync(temporary, report)
    // The parent retains creation-checked handles before deliberately killing main.
  } catch (error) {
    writeFileSync(report, JSON.stringify({ ready: false, error: String(error.stack ?? error) }))
    app.exit(1)
  }
})()
