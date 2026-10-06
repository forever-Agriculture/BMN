import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const electronVersion = '44.3.0'
const workerDevDir = process.env.npm_config_devdir
const originalHomeDirectory = os.homedir

// @electron/rebuild 4.2.0 fixes its header directory at import time from
// os.homedir(). In restricted workers, use the required environment-only
// cache root without changing HOME or writing package-manager configuration.
if (workerDevDir) os.homedir = () => workerDevDir
const { rebuild } = await import('@electron/rebuild')
os.homedir = originalHomeDirectory

await rebuild({
  buildPath: resolve('apps/desktop'),
  electronVersion,
  force: true,
  onlyModules: ['node-pty', 'better-sqlite3'],
  buildFromSource: true,
  mode: 'sequential'
})

// node-gyp recreates build/Release. Restore the Windows runtime sidecars from the
// pinned node-pty package after rebuilding; its installer also removes build debris.
if (process.platform === 'win32') {
  const requireFromApp = createRequire(resolve('apps/desktop/package.json'))
  const ptyRoot = dirname(requireFromApp.resolve('node-pty/package.json'))
  execFileSync(process.execPath, [join(ptyRoot, 'scripts', 'post-install.js')], { stdio: 'inherit', timeout: 60_000 })
}

if (process.platform === 'win32') {
  const { buildWindowsCli } = await import('./windows-cli.mjs')
  console.log(`built ${buildWindowsCli()}`)
  const { buildWindowsInstallTools } = await import('./windows-install-tools.mjs')
  console.log(`built ${await buildWindowsInstallTools()}`)
}

console.log(`rebuilt node-pty and better-sqlite3 for Electron ${electronVersion}`)
