// Native installed-launcher slice: real sealed payload, worker, launcher and GUI.
// No registry, Start Menu, scheduled task or owner profile changes. Broader update
// notices/build barriers and actual shell shortcut activation remain unverified.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

export async function measureWindowsInstalledLauncher(binary) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable native runner only')
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bmn-installed-launcher-')))
  const report = join(root, 'receipt.json'), source = dirname(binary)
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'PATH'].flatMap(name => {
    const value = windowsEnvironmentValue(process.env, name)
    return value === undefined ? [] : [[name, value]]
  }))
  Object.assign(environment, { ELECTRON_RUN_AS_NODE: '1', GITHUB_ACTIONS: 'true', HOME: root, USERPROFILE: root,
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local') })
  mkdirSync(environment.APPDATA); mkdirSync(environment.LOCALAPPDATA)
  let child
  try {
    child = spawn(join(source, 'BMN-worker.exe'),
      [fileURLToPath(new URL('./windows-installed-launcher-driver.mjs', import.meta.url)), source, root, report],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.resume()
    let stderr = '', watchdog = false
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    const completion = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
    const timer = setTimeout(() => { watchdog = true; child.kill('SIGKILL') }, 600000)
    const code = await completion.finally(() => clearTimeout(timer))
    const receipt = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8'))
      : { status: 'FAIL', missingReceipt: true, stderrBytes: Buffer.byteLength(stderr) }
    receipt.controller = { exitCode: code, watchdog }
    const destination = join(process.cwd(), 'test-results/windows-installed-launcher.json')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, JSON.stringify(receipt, null, 2))
    assert.equal(code, 0, JSON.stringify(receipt))
    assert.equal(watchdog, false, 'Controller watchdog intervention is not success')
    assert.equal(receipt.status, 'PASS', JSON.stringify(receipt))
    return receipt
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolveExit => child.once('close', resolveExit))
      child.kill('SIGKILL'); await closed
    }
    // Controller has a kill-on-close lifetime job before it spawns any child.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
