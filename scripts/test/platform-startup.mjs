/* global window */
// Story 53.1: real UI/database/native loading, persistence and single-instance behavior.
// Intentionally creates no terminal: native shell lifecycle belongs to Story 53.2.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { findSandboxDisablingText } from '../lib/sandbox-flag-audit.mjs'
import { withTemporaryRoot, temporaryRootContracts } from '../lib/temporary-root.mjs'
import { waitForAsyncPagePredicate } from '../lib/async-page-predicate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const flag = process.argv.indexOf('--binary')
if (flag !== -1 && !process.argv[flag + 1]) throw new Error('--binary requires a path')
const binary = flag === -1 ? undefined : resolve(process.argv[flag + 1])
const executablePath = binary ?? createRequire(join(appDirectory, 'package.json'))('electron')
const display = process.env.WAYLAND_DISPLAY
const wayland = display && process.env.XDG_RUNTIME_DIR && !isAbsolute(display)
  ? join(process.env.XDG_RUNTIME_DIR, display) : display

const receipt = await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ roots }) => {
  const env = {
    ...process.env,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
    BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state,
    XDG_RUNTIME_DIR: roots.runtime, XDG_CACHE_HOME: roots.cache,
    CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'),
    OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
    ...(wayland ? { WAYLAND_DISPLAY: wayland } : {})
  }
  // Prevent a launching agent's Electron mode from turning the app into a Node process.
  delete env.ELECTRON_RUN_AS_NODE
  const args = [...(binary ? [] : [appDirectory]), ...(!wayland && process.env.DISPLAY ? ['--ozone-platform=x11'] : [])]
  const launch = () => electron.launch({ executablePath, args, cwd: repoRoot, env, timeout: 45_000, chromiumSandbox: true })
  let application = await launch()
  try {
    assert.deepEqual(findSandboxDisablingText(application.process().spawnargs.join('\n')), [], 'Chromium sandbox was disabled by the launcher')
    let page = await application.firstWindow()
    await waitForAsyncPagePredicate(page, async () => {
      try { return (await window.aiTerminal.listWorkspaces()).length > 0 } catch { return false }
    }, null, { timeout: 30_000 })
    const state = await page.evaluate(async () => {
      let stage = 'createWorkspace'
      try {
        const workspace = await window.aiTerminal.createWorkspace({ name: 'Windows parity fixture 数据' })
        stage = 'getSettings'
        const settings = await window.aiTerminal.getSettings()
        stage = 'putSettings'
        await window.aiTerminal.putSettings('appearance', { ...settings.appearance, colorMode: 'brown' })
        stage = 'getControlInfo'
        return { workspaceId: workspace.workspaceId, control: await window.aiTerminal.getControlInfo() }
      } catch (error) {
        // Include the retained host-loss notice; a later IPC failure only says "unavailable".
        const startup = await new Promise((resolve) => {
          const timer = setTimeout(() => { unsubscribe(); resolve({ unavailable: true }) }, 1000)
          const unsubscribe = window.aiTerminal.onStartup((value) => {
            clearTimeout(timer)
            unsubscribe()
            resolve(value.ok ? { ok: true } : value)
          })
        })
        // IPC errors may be plain objects; Playwright otherwise reports only "Object".
        throw new Error(JSON.stringify({ stage, code: error?.code, startup,
          message: String(error?.message ?? error).slice(0, 1000) }), { cause: error })
      }
    })
    assert.equal(state.control.listening, true, 'The selected control transport must be ready')
    // Read only this disposable app's credential and never include it in receipts.
    const ownerToken = (await readFile(join(dirname(state.control.socketPath), 'owner.token'), 'utf8')).trim()
    const cli = spawn(state.control.cliPath, ['snapshot', '--json'], {
      cwd: repoRoot, env: { ...env, BMN_CONTROL_SOCKET: state.control.socketPath, BMN_TOKEN: ownerToken },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    let cliOutput = ''
    cli.stdout.on('data', data => { cliOutput += data })
    const cliTimer = setTimeout(() => { if (cli.exitCode === null) cli.kill() }, 15000)
    try {
      const [code] = await once(cli, 'close')
      assert.equal(code, 0, 'The real bmn launcher could not query its isolated app')
      assert.ok(Array.isArray(JSON.parse(cliOutput).sessions), 'Control snapshot must retain its JSON contract')
    } finally { clearTimeout(cliTimer) }
    const controlCli = { realLauncher: true, status: 0, snapshot: true }
    const nativeModules = await application.evaluate(({ app }) => {
      const builtin = process.mainModule.require.bind(process.mainModule)
      const require = builtin('node:module').createRequire(builtin('node:path').join(app.getAppPath(), 'package.json'))
      const { loadNativeModule } = require('node-pty/lib/utils')
      const addons = process.platform === 'win32' ? ['conpty', 'conpty_console_list', 'pty'] : ['pty']
      for (const name of addons) {
        if (!loadNativeModule(name).module) throw new Error(`Native addon did not load: ${name}`)
      }
      return addons
    })
    await page.getByText('Windows parity fixture 数据', { exact: true }).first().waitFor()
    const hardening = await application.evaluate(({ BrowserWindow, app }) => {
      const windows = BrowserWindow.getAllWindows()
      const preferences = windows[0].webContents.getLastWebPreferences()
      globalThis.bmnPlatformSecondInstance = 0
      app.on('second-instance', () => { globalThis.bmnPlatformSecondInstance++ })
      windows[0].minimize()
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }
    })
    assert.deepEqual(hardening, { sandbox: true, contextIsolation: true, nodeIntegration: false })
    const second = spawn(executablePath, args, { cwd: repoRoot, env, stdio: 'ignore' })
    try {
      const [code] = await once(second, 'exit', { signal: AbortSignal.timeout(30_000) })
      assert.equal(code, 0, 'second launch did not exit successfully')
      const activation = await application.evaluate(({ BrowserWindow }) => ({
        count: globalThis.bmnPlatformSecondInstance,
        windows: BrowserWindow.getAllWindows().length,
        minimized: BrowserWindow.getAllWindows()[0].isMinimized()
      }))
      assert.equal(activation.count, 1, 'second instance did not activate the original process')
      assert.equal(activation.windows, 1)
      assert.equal(activation.minimized, false)
    } finally { if (second.exitCode === null) second.kill() }
    await application.close()
    application = await launch()
    page = await application.firstWindow()
    await waitForAsyncPagePredicate(page, async (id) => {
      try { return (await window.aiTerminal.listWorkspaces()).some((w) => w.workspaceId === id) } catch { return false }
    }, state.workspaceId, { timeout: 30_000 })
    assert.equal(await page.evaluate(async () => (await window.aiTerminal.getSettings()).appearance.colorMode), 'brown')
    await page.getByText('Windows parity fixture 数据', { exact: true }).first().waitFor()
    return { platformStartup: 'passed', platform: process.platform, arch: process.arch,
      binary: binary ?? 'development', nativeModules, chromiumSandbox: true, persistence: true, singleInstance: true, hardening,
      control: state.control, controlCli, versions: await application.evaluate(() => process.versions) }
  } finally { await application.close() }
})
if (binary && process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true') {
  // An explicitly partial A/B observation; its result never controls the unchanged installed gate.
  const { recordScrolledPrefixes } = await import('./windows-scrolled-prefix.mjs')
  receipt.windowsScrolledPrefixes = await recordScrolledPrefixes(binary).catch(error => ({
    diagnosticOnly: true, unavailable: error?.code ?? 'diagnostic-error'
  }))
  // Observation only: locates where the packaged self-test stops natively before the installed gate runs it.
  const { recordWindowsPackagedSelfTest } = await import('./windows-self-test-diagnostic.mjs')
  receipt.windowsSelfTestDiagnostic = await recordWindowsPackagedSelfTest(binary)
  const { measureWindowsInstalledLauncher } = await import('./windows-installed-launcher.mjs')
  receipt.windowsInstalledLauncher = await measureWindowsInstalledLauncher(binary)
}
console.log(JSON.stringify(receipt))
