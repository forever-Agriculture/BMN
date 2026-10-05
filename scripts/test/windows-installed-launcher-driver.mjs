/* global window */
// Run only on the validated packaged Electron's dedicated Node image. The
// controller job owns every child before installation or GUI launch begins.
import assert from 'node:assert/strict'
import processes, { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { observeWindowsInstallCommands } from './fixtures/windows-install-command-observer.mjs'
import { measureInstalledCimPreflight } from './fixtures/windows-installed-cim-preflight.mjs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { findSandboxDisablingText } from '../lib/sandbox-flag-audit.mjs'
import { waitForAsyncPagePredicate } from '../lib/async-page-predicate.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const [source, fixture, reportPath] = process.argv.slice(2)
const requirePayload = createRequire(join(source, 'resources/app.asar/package.json'))
const native = requirePayload('node-pty/lib/utils').loadNativeModule('conpty').module
assert.equal(typeof native.protectApplicationLifetime, 'function')
native.protectApplicationLifetime()
const report = { status: 'FAIL', checks: [], nativeWindows: true, actualPackagedGui: true,
  remaining: ['real-shell-shortcut-activation', '8.3-path-alias-observation', 'waiting/building-barriers', 'notice-lifecycle/dismissal/log-access',
    'failed-update-old/new/no-build', 'unavailable-notice', 'stale-failure-suppression'] }
const children = new Set(), browsers = new Set()
const actualSpawnSync = processes.spawnSync
report.installOperations = []
report.stage = 'controller-ready'
const artifactBytes = readFileSync(join(source, 'bmn-release.json'))
const commandObserver = observeWindowsInstallCommands(actualSpawnSync, row => {
  assert.ok(report.installOperations.length < 200, 'Installer diagnostic receipt limit reached')
  report.installOperations.push(row)
}, { candidateCommit: JSON.parse(artifactBytes).commit, artifactSha256: createHash('sha256').update(artifactBytes).digest('hex') })
processes.spawnSync = commandObserver
syncBuiltinESMExports()
const check = name => report.checks.push({ name, status: 'PASS' })
const writeReport = () => {
  report.diagnosticFailures = commandObserver.diagnosticFailures
  writeFileSync(reportPath + '.tmp', JSON.stringify(report)); renameSync(reportPath + '.tmp', reportPath)
}
const waitFor = async (predicate, child, timeout = 45000) => {
  const until = Date.now() + timeout
  while (!predicate()) {
    assert.ok(!child || child.exitCode === null && child.signalCode === null, 'Owned launcher exited before its GUI became ready')
    assert.ok(Date.now() < until, 'Installed candidate observation timed out')
    await delay(50)
  }
}
const settle = async (child, timeout, message) => {
  let timer
  try {
    return await Promise.race([child.completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout) })])
  } finally { clearTimeout(timer) }
}
async function main() {
  const { installWindowsPayload, windowsInstallerSmokeEnvironment, observeWindowsApps, observeWindowsSelectedApps } = await import('../lib/windows-installed-worker.mjs')
  const { readInstallerDescriptor } = await import('../lib/windows-release-payload.mjs')
  const { readWindowsInstallation, releaseDirectory } = await import('../lib/windows-release-transaction.mjs')
  const { ensurePrivateDirectories } = await import('../../apps/desktop/src/utility/private-directory.ts')
  const { queueWindowsSourceUpdate } = await import('../lib/windows-source-update.mjs')
  const { withWindowsInstallLease } = await import('../lib/windows-install-lease.mjs')
  report.stage = 'private-smoke-environment'
  Object.assign(process.env, windowsInstallerSmokeEnvironment(join(fixture, 'profile')))
  const root = join(fixture, 'installation'), dataRoot = join(process.env.LOCALAPPDATA, 'BMN/data')
  process.env.BMN_DATA_HOME = dataRoot
  // Run the exact original entry point before explicit imports can affect this
  // private profile's module cache. Retain its failure through the separate PF.
  report.stage = 'untouched-original-cim-query'
  let originalCimFailure
  try {
    const ids = observeWindowsApps()
    assert.ok(Array.isArray(ids) && ids.every(Number.isSafeInteger), 'Original process observation is incomplete')
    report.originalCimQuery = { status: 'PASS', scope: 'actual-original-worker-entrypoint', processCount: ids.length }
  } catch (error) {
    originalCimFailure = error
    report.originalCimQuery = { status: 'FAIL', scope: 'actual-original-worker-entrypoint', errorCategory: 'operation' }
  }
  report.stage = 'separate-installed-cim-preflight'
  report.cimPreflight = measureInstalledCimPreflight(process.env)
  if (originalCimFailure) throw originalCimFailure
  // The following production installer runs in its own unchanged module context.
  const descriptor = readInstallerDescriptor(source), shortcut = join(fixture, 'BMN.lnk')
  report.stage = 'install-payload'
  await installWindowsPayload({ source, root, dataRoot, descriptor, refreshMetadata: async (installed, _release, payload) => {
    const result = spawnSync(join(payload, 'resources/install/BMN-shortcut.exe'), [join(installed, 'BMN-launcher.exe'), installed, shortcut],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.ok(!result.error && result.status === 0, 'Private installed shortcut did not verify')
  } })
  report.stage = 'selected-installed-payload'
  assert.deepEqual(readWindowsInstallation(root).current, descriptor)
  assert.ok(existsSync(shortcut))
  check('real private install, sealed selected payload, isolated smoke and native shortcut metadata')
  const launcher = join(root, 'BMN-launcher.exe'), portFile = join(dataRoot, 'DevToolsActivePort')
  const literal = '--bmn-installed-fixture=literal 数据 & %PATH% "quote" ^ \\ tail\\'
  const argv = ['--enable-automation', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', literal]
  const start = () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(launcher, argv, { env, stdio: 'ignore', windowsHide: false })
    children.add(child)
    child.completion = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)) })
    // Attach now so an early failure cannot become an unhandled rejection.
    child.completion.catch(() => {})
    return child
  }
  const attach = async child => {
    await waitFor(() => existsSync(portFile), child)
    const [port, endpoint] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u)
    assert.match(port, /^\d+$/u); assert.match(endpoint, /^\/devtools\/browser\//u)
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { timeout: 45000 })
    browsers.add(browser)
    await waitFor(() => browser.contexts()[0]?.pages().length > 0, child)
    const page = browser.contexts()[0].pages()[0]
    await waitForAsyncPagePredicate(page, async () => {
      try { return (await window.aiTerminal.listWorkspaces()).length > 0 } catch { return false }
    }, null, { timeout: 30000 })
    return { browser, page }
  }
  const quit = async (child, page, browser) => {
    await page.evaluate(() => { void window.aiTerminal.quitApplication() })
    assert.equal(await settle(child, 30000, 'Owned installed GUI did not quit'), 0)
    children.delete(child); browsers.delete(browser); await browser.close()
    if (existsSync(portFile)) unlinkSync(portFile)
    assert.deepEqual(observeWindowsSelectedApps(root), [])
  }
  report.stage = 'installed-gui-open'
  const first = start(), { browser, page } = await attach(first)
  const cdp = await browser.newBrowserCDPSession()
  const actual = (await cdp.send('Browser.getBrowserCommandLine')).arguments
  assert.ok(actual.includes(literal), 'Stable launcher changed literal Windows argv')
  assert.deepEqual(findSandboxDisablingText(actual.join('\n')), [])
  const processes = (await cdp.send('SystemInfo.getProcessInfo')).processInfo
  const primaryPid = processes.find(row => row.type === 'browser').id
  assert.ok(observeWindowsSelectedApps(root).includes(primaryPid), 'GUI must be the selected immutable installed executable')
  assert.equal(dirname(actual[0]).toLowerCase(), releaseDirectory(root, descriptor).toLowerCase())
  const workspace = await page.evaluate(() => window.aiTerminal.createWorkspace({ name: 'Installed launcher fixture 数据' }))
  await page.getByText('Installed launcher fixture 数据', { exact: true }).first().waitFor()
  check('stable launcher and retained worker open selected real GUI with literal argv and Chromium sandbox')
  report.stage = 'queued-update-forward'
  const requests = join(root, 'requests'), requestPath = join(requests, 'source-update.json')
  ensurePrivateDirectories([requests])
  // This is a queued-forward case only. There is no synthetic package build or
  // fabricated completion. A build would fail rather than spend on dependencies.
  const fakeCommit = 'a'.repeat(40), fakePnpm = join(fixture, 'must-not-build.cjs')
  writeFileSync(fakePnpm, "throw new Error('Forwarding must not execute a source build')\n")
  await withWindowsInstallLease(requests, async () => queueWindowsSourceUpdate(requestPath, {
    repo: fixture, node: process.execPath, pnpm: fakePnpm,
    sourceState: { branch: 'main', head: fakeCommit, originHead: fakeCommit, status: '' }
  }), { native })
  const queuedBytes = readFileSync(requestPath)
  const second = start()
  assert.equal(await settle(second, 45000, 'Queued forward launch did not finish'), 0)
  children.delete(second)
  assert.deepEqual(readFileSync(requestPath), queuedBytes, 'Forwarding must leave the queued update unchanged')
  assert.deepEqual(readWindowsInstallation(root).current, descriptor)
  assert.ok(observeWindowsSelectedApps(root).includes(primaryPid))
  assert.equal(browser.contexts()[0].pages().length, 1)
  assert.ok((await page.evaluate(() => window.aiTerminal.listWorkspaces())).some(row => row.workspaceId === workspace.workspaceId))
  check('queued update forwards to the same installed GUI and preserves request bytes and selected generation')
  await withWindowsInstallLease(requests, async () => unlinkSync(requestPath), { native })
  report.stage = 'installed-gui-quit'
  await quit(first, page, browser)
  check('real application Quit settles stable launcher and selected GUI observation')
  report.stage = 'installed-gui-restart'
  const restarted = start(), next = await attach(restarted)
  assert.ok((await next.page.evaluate(() => window.aiTerminal.listWorkspaces())).some(row => row.workspaceId === workspace.workspaceId))
  await next.page.getByText('Installed launcher fixture 数据', { exact: true }).first().waitFor()
  check('ordinary installed restart preserves actual workspace state')
  await quit(restarted, next.page, next.browser)
  assert.equal(commandObserver.diagnosticFailures.length, 0, 'Installer diagnostics are incomplete')
  assert.ok(report.installOperations.every(row => row.bindingComplete), 'Installer artifact binding is incomplete')
  report.status = 'PASS'
  report.selectedCommit = descriptor.commit
}
try { await main() }
catch (error) { report.error = { name: /^[A-Za-z0-9_]{1,64}$/u.test(error.name) ? error.name : 'UNKNOWN', category: error instanceof assert.AssertionError ? 'assertion' : 'operation' }; process.exitCode = 1 }
finally {
  processes.spawnSync = actualSpawnSync; syncBuiltinESMExports()
  report.cleanup = []
  for (const child of children) {
    let success = true
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await child.completion
    } catch { success = false }
    report.cleanup.push({ role: 'owned-launcher', success, exitCode: child.exitCode, signal: child.signalCode })
  }
  for (const browser of browsers) {
    let success = true
    try { await browser.close() } catch { success = false }
    report.cleanup.push({ role: 'owned-browser-connection', success })
  }
  if (report.cleanup.some(row => !row.success) || commandObserver.diagnosticFailures.length > 0) { report.status = 'FAIL'; process.exitCode = 1 }
  writeReport()
}
