// Story 53.4: build the native Windows `bmn` launcher that sessions find on PATH.
// Packaged builds copy bmn.exe beside bmn.mjs; development adds bmn.runtime naming
// this checkout's Electron runtime and CLI script.
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msvcEnvironment } from '../lib/msvc.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const windowsCliDirectory = join(repo, 'apps/desktop/native-out/windows-cli')

export function buildWindowsCli() {
  if (process.platform !== 'win32') return null
  mkdirSync(windowsCliDirectory, { recursive: true })
  const output = join(windowsCliDirectory, 'bmn.exe')
  const compiled = spawnSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/DUNICODE', '/D_UNICODE',
    join(repo, 'apps/desktop/native/windows-cli/bmn-launcher.c'), `/Fe:${output}.tmp.exe`,
    `/Fo:${join(windowsCliDirectory, 'bmn-launcher.obj')}`, '/link', '/SUBSYSTEM:CONSOLE'],
  { cwd: windowsCliDirectory, env: msvcEnvironment(), encoding: 'utf8', timeout: 120000 })
  if (compiled.error || compiled.status !== 0) {
    throw new Error(`bmn.exe did not compile:\n${compiled.stdout ?? ''}${compiled.stderr ?? ''}${compiled.error?.message ?? ''}`)
  }
  renameSync(`${output}.tmp.exe`, output)
  const requireFromApp = createRequire(join(repo, 'apps/desktop/package.json'))
  writeFileSync(join(windowsCliDirectory, 'bmn.runtime'),
    `${requireFromApp('electron')}\r\n${join(repo, 'apps/desktop/bin/bmn')}\r\n`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildWindowsCli()
  console.log(built ? `built ${built}` : 'bmn.exe is built on Windows only')
}
