// Frozen bootstrap protocol: resolve the selected immutable payload without
// loading its native modules into the bootstrap's older Electron runtime.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { loadWindowsInstallLease, withWindowsInstallLease } from './windows-install-lease.mjs'
import { realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { readWindowsInstallation, releaseDirectory } from './windows-release-transaction.mjs'
import { validateWindowsReleasePayload } from './windows-release-payload.mjs'

export const windowsWorkerImageName = 'BMN-worker.exe'
export function assertWindowsWorkerImage(executable = process.execPath, {
  platform = process.platform, canonicalExecutable = realpathSync.native
} = {}) {
  if (platform !== 'win32') return
  assert.equal(win32.basename(canonicalExecutable(executable)).toLowerCase(), windowsWorkerImageName.toLowerCase(),
    'Installed worker requires its dedicated runtime image')
}

export function windowsInstalledEngineLocation(entry) {
  const path = resolve(entry), install = dirname(path), resources = dirname(install), payload = dirname(resources)
  assert.equal(basename(path).toLowerCase(), 'worker.cjs', 'Unsupported installed worker entry')
  assert.equal(basename(install).toLowerCase(), 'install', 'Unsupported worker location')
  assert.equal(basename(resources).toLowerCase(), 'resources', 'Unsupported worker location')
  if (basename(payload).toLowerCase() === 'bootstrap') return { root: dirname(payload), payload, mode: 'bootstrap' }
  assert.equal(basename(dirname(payload)).toLowerCase(), 'versions', 'Unsupported installed worker location')
  assert.match(basename(payload), /^[a-f0-9]{40}-[a-f0-9]{64}$/u, 'Invalid versioned worker identity')
  return { root: dirname(dirname(payload)), payload, mode: 'engine' }
}

export async function delegateWindowsInstalledEngine(entry, argv, {
  readInstallation = readWindowsInstallation, validate = validateWindowsReleasePayload,
  start = spawn, environment = process.env, native
} = {}) {
  const location = windowsInstalledEngineLocation(entry)
  if (location.mode === 'engine') return { ...location, delegated: false }
  // The bootstrap loads only its own stable lease addon, never a newer engine's
  // modules. Hold a shared lease through validation and OS process creation,
  // then release before waiting: uninstall cannot miss a late-created mapped
  // engine, and the engine can obtain an exclusive update lease afterwards.
  native ??= loadWindowsInstallLease(pathToFileURL(join(location.payload, 'resources/app.asar/package.json')))
  let completion, recovery = false
  await withWindowsInstallLease(location.root, async () => {
    let target
    try {
      const installation = readInstallation(location.root)
      assert.ok(installation, 'No selected installation')
      target = releaseDirectory(location.root, installation.current)
      await validate(target, installation.current)
    } catch {
      assert.ok(argv[0] === '--uninstall', 'Installed engine is unavailable; rerun the offline installer')
      recovery = true
      return
    }
    completion = new Promise((resolveExit, reject) => {
      const child = start(join(target, windowsWorkerImageName), [join(target, 'resources/install/worker.cjs'), ...argv], {
        env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true
      })
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolveExit(signal ? 1 : exitCode ?? 1))
    })
    // Subscribe before leaving this scope even for immediate child exits. A
    // rejected spawn is propagated by awaiting completion after lease release.
    completion.catch(() => {})
  }, { native, exclusive: false })
  if (recovery) return { ...location, delegated: false }
  return { ...location, delegated: true, exitCode: await completion }
}
