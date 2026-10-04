import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'
import { loadWindowsInstallLease, withWindowsInstallLease } from '../lib/windows-install-lease.mjs'
import { queueWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { readWindowsSourceState } from '../lib/windows-source-build.mjs'
import { readWindowsInstallation } from '../lib/windows-release-transaction.mjs'
import { packagedApp } from '../lib/packaged-app.mjs'
import { readInstallerDescriptor, validateWindowsReleasePayload } from '../lib/windows-release-payload.mjs'

export function windowsDesktopLocations(environment = process.env) {
  const local = windowsEnvironmentValue(environment, 'LOCALAPPDATA')
  assert.ok(local && isAbsolute(local), 'Windows LOCALAPPDATA is unavailable')
  const root = join(local, 'Programs/BMN'), dataRoot = join(local, 'BMN/data')
  return { root, dataRoot, requests: join(root, 'requests'), requestPath: join(root, 'requests/source-update.json') }
}

export async function queueWindowsDesktopUpdate(repo) {
  assert.equal(process.platform, 'win32')
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Source updater requires Node 24')
  const pnpm = process.env.npm_execpath
  assert.ok(pnpm && isAbsolute(pnpm) && existsSync(pnpm), 'Run pnpm run update:desktop with the pinned package manager')
  const locations = windowsDesktopLocations()
  assert.ok(existsSync(join(locations.root, 'BMN-launcher.exe')), 'Install the packaged Windows build with pnpm run install:desktop first')
  assert.ok(readWindowsInstallation(locations.root), 'Install the packaged Windows build before queueing an update')
  ensurePrivateDirectories([locations.requests])
  const native = loadWindowsInstallLease(pathToFileURL(join(locations.root, 'bootstrap/resources/app.asar/package.json')))
  // The request lock is separate from the application's startup lock: queueing
  // must succeed while BMN is still open. No build starts in this command's tree.
  const request = await withWindowsInstallLease(locations.requests, async () => queueWindowsSourceUpdate(locations.requestPath,
    { repo, node: process.execPath, pnpm, sourceState: readWindowsSourceState(repo) }), { native })
  console.log(`Queued BMN ${request.commit.slice(0, 12)}. Close BMN, then open its Start menu shortcut to build and install the queued commit. The request survives closing this terminal or reboot.`)
  return request
}

export async function installWindowsDesktop(repo) {
  assert.equal(process.platform, 'win32')
  const source = packagedApp(repo).root, descriptor = readInstallerDescriptor(source)
  await validateWindowsReleasePayload(source, descriptor)
  const { root, dataRoot } = windowsDesktopLocations()
  const result = spawnSync(join(source, 'resources/install/BMN-install-runner.exe'), ['--install', source, root, dataRoot],
    { stdio: 'inherit', windowsHide: false })
  assert.ok(!result.error && result.status === 0, 'Windows desktop installation is incomplete; rerun install:desktop to repair')
}
