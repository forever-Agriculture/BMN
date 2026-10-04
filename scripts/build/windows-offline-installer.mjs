import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedApp } from '../lib/packaged-app.mjs'
import { readInstallerDescriptor, validateWindowsReleasePayload } from '../lib/windows-release-payload.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export async function buildWindowsOfflineInstaller({ root = packagedApp(repo).root, output } = {}) {
  if (process.platform !== 'win32') return null
  const descriptor = readInstallerDescriptor(root)
  await validateWindowsReleasePayload(root, descriptor)
  output ??= join(dirname(root), `BMN-${descriptor.commit}-setup.exe`)
  assert.ok(!/[\r\n"$]/u.test(root + output), 'Unsupported NSIS build path')
  const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
  const requireBuilder = createRequire(requireApp.resolve('electron-builder/package.json'))
  const { getMakeNsisPath } = requireBuilder('app-builder-lib/out/toolsets/windows')
  // Version/checksum selection comes from the pinned electron-builder dependency.
  const compiler = await getMakeNsisPath()
  const result = spawnSync(compiler.path, ['/V2', `/DBMN_PAYLOAD=${root}`, `/DBMN_SETUP_OUTPUT=${output}`,
    join(repo, 'scripts/install/windows-offline-installer.nsi')],
  { env: { ...process.env, ...compiler.env }, encoding: 'utf8', timeout: 300000 })
  if (result.error || result.status !== 0) throw new Error(`Offline Windows installer did not compile:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  return output
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildWindowsOfflineInstaller())
}
