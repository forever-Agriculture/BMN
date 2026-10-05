// Story 53.4: build the native Windows `bmn` launcher that sessions find on PATH.
// Packaged builds copy bmn.exe beside bmn.mjs; development adds bmn.runtime naming
// this checkout's Electron runtime and CLI script. Story 53.6: the same source builds
// codex.exe, which runs codex.mjs so Codex typed in a session stays off its shared daemon,
// as bin/codex does on Linux; it leaves its runtime in the caller's job.
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msvcEnvironment } from '../lib/msvc.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const windowsCliDirectory = join(repo, 'apps/desktop/native-out/windows-cli')
/** Each launcher, the defines it is built with and the script its development sidecar names. */
export const windowsCliLaunchers = [
  { name: 'bmn', defines: [], script: 'apps/desktop/bin/bmn' },
  { name: 'codex', defines: ['/DBMN_LAUNCHER_SHARED_TREE'], script: 'apps/desktop/bin/codex.mjs' }
]

export function buildWindowsCli() {
  if (process.platform !== 'win32') return null
  mkdirSync(windowsCliDirectory, { recursive: true })
  const requireFromApp = createRequire(join(repo, 'apps/desktop/package.json'))
  for (const { name, defines, script } of windowsCliLaunchers) {
    const output = join(windowsCliDirectory, `${name}.exe`)
    const compiled = spawnSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/DUNICODE', '/D_UNICODE', ...defines,
      join(repo, 'apps/desktop/native/windows-cli/bmn-launcher.c'), `/Fe:${output}.tmp.exe`,
      `/Fo:${join(windowsCliDirectory, `${name}-launcher.obj`)}`, '/link', '/SUBSYSTEM:CONSOLE'],
    { cwd: windowsCliDirectory, env: msvcEnvironment(), encoding: 'utf8', timeout: 120000 })
    if (compiled.error || compiled.status !== 0) {
      throw new Error(`${name}.exe did not compile:\n${compiled.stdout ?? ''}${compiled.stderr ?? ''}${compiled.error?.message ?? ''}`)
    }
    renameSync(`${output}.tmp.exe`, output)
    writeFileSync(join(windowsCliDirectory, `${name}.runtime`), `${requireFromApp('electron')}\r\n${join(repo, script)}\r\n`)
  }
  return join(windowsCliDirectory, 'bmn.exe')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildWindowsCli()
  console.log(built ? `built ${built}` : 'bmn.exe is built on Windows only')
}
