import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msvcEnvironment } from '../lib/msvc.mjs'
import { windowsIconFromPng } from '../lib/windows-icon.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const windowsInstallToolsDirectory = join(repo, 'apps/desktop/native-out/windows-install')
export async function buildWindowsInstallTools({ bundleOnly = false } = {}) {
  if (process.platform !== 'win32' && !bundleOnly) return null
  mkdirSync(windowsInstallToolsDirectory, { recursive: true })
  const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
  const requireVite = createRequire(requireApp.resolve('vite/package.json'))
  await requireVite('esbuild').build({ entryPoints: [join(repo, 'scripts/install/windows-worker-entry.mjs')],
    outfile: join(windowsInstallToolsDirectory, 'worker.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs',
    define: { 'import.meta.url': 'undefined' } })
  const icon = join(windowsInstallToolsDirectory, 'BMN.ico')
  writeFileSync(icon, windowsIconFromPng(readFileSync(join(repo, 'apps/desktop/resources/icons/hicolor/256x256.png'))))
  if (bundleOnly) return windowsInstallToolsDirectory
  const environment = msvcEnvironment()
  writeFileSync(join(windowsInstallToolsDirectory, 'launcher.rc'), '1 ICON "BMN.ico"\r\n')
  const resource = join(windowsInstallToolsDirectory, 'launcher.res')
  const rc = spawnSync('rc.exe', ['/nologo', `/fo${resource}`, 'launcher.rc'],
    { cwd: windowsInstallToolsDirectory, env: environment, encoding: 'utf8', timeout: 120000 })
  if (rc.error || rc.status !== 0) throw new Error('BMN launcher icon did not compile')
  for (const [name, defines] of [['BMN-launcher', []], ['BMN-install-runner', ['/DBMN_INSTALLER_RUNNER']]]) {
    const output = join(windowsInstallToolsDirectory, name + '.exe')
    const result = spawnSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', ...defines,
      join(repo, 'apps/desktop/native/windows-install/launcher.c'), `/Fe:${output}.tmp.exe`,
      `/Fo:${join(windowsInstallToolsDirectory, name + '.obj')}`, '/link', '/SUBSYSTEM:WINDOWS', 'user32.lib', resource],
    { cwd: windowsInstallToolsDirectory, env: environment, encoding: 'utf8', timeout: 120000 })
    if (result.error || result.status !== 0) throw new Error(`Installed launcher did not compile:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    renameSync(`${output}.tmp.exe`, output)
  }
  const shortcut = join(windowsInstallToolsDirectory, 'BMN-shortcut.exe')
  const compiled = spawnSync('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/EHsc',
    join(repo, 'apps/desktop/native/windows-install/shortcut.cpp'), `/Fe:${shortcut}.tmp.exe`,
    `/Fo:${join(windowsInstallToolsDirectory, 'shortcut.obj')}`, '/link', '/SUBSYSTEM:CONSOLE', 'ole32.lib', 'propsys.lib', 'shell32.lib', 'uuid.lib'],
  { cwd: windowsInstallToolsDirectory, env: environment, encoding: 'utf8', timeout: 120000 })
  if (compiled.error || compiled.status !== 0) throw new Error(`BMN shortcut helper did not compile:\n${compiled.stdout ?? ''}${compiled.stderr ?? ''}`)
  renameSync(`${shortcut}.tmp.exe`, shortcut)
  return windowsInstallToolsDirectory
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsInstallTools({ bundleOnly: process.argv.includes('--bundle-only') })
}
