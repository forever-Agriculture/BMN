import os from 'node:os'
import { resolve } from 'node:path'

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

console.log(`rebuilt node-pty and better-sqlite3 for Electron ${electronVersion}`)
