// MODULE: codex-shell-launcher.test.ts - Codex typed in a BMN session stays off the shared daemon on Linux and Windows
import { execFile, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { codexWithoutSharedDaemon, pathWithoutFolders, realCodexLaunch } from '../../bin/codex-launch.mjs'
import { windowsEnvironmentValue } from '../../bin/windows-launch.mjs'

const bin = fileURLToPath(new URL('../../bin/', import.meta.url))
const session = { BMN_CONTROL_SOCKET: 'synthetic-socket', BMN_TOKEN: 'synthetic-token' }
const cases: readonly (readonly string[])[] = [
  [], ['exec', 'hi'], ['resume', '--last'], ['--model', 'agents', 'exec'], ['-c', 'x=1', 'app-server'],
  ['agents'], ['remote-control', 'start'], ['--no-daemon', 'exec'], ['--remote', 'ws://127.0.0.1:1'],
  ['--remote=ws://127.0.0.1:1'], ['--', 'agents'], ['--enable', 'agents', 'agents', '--help'], ['-m', 'o3', '--', '--no-daemon']
]

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-codex-launch-'))
  roots.push(root)
  return root
}

describe('Codex arguments in a BMN session', () => {
  it('adds --no-daemon unless the run chooses a server or manages the shared daemon', () => {
    expect(codexWithoutSharedDaemon(['exec', 'hi'])).toEqual(['--no-daemon', 'exec', 'hi'])
    expect(codexWithoutSharedDaemon(['--model', 'agents', 'exec'])).toEqual(['--no-daemon', '--model', 'agents', 'exec'])
    for (const kept of [['agents'], ['-c', 'x=1', 'app-server'], ['--no-daemon'], ['--remote=ws://h'], ['remote-control']]) {
      expect(codexWithoutSharedDaemon(kept)).toBe(kept)
    }
  })

  // The Linux wrapper is shell code; the session manager and the Windows launcher share codex-launch.mjs.
  it.runIf(process.platform === 'linux')('decides as the Linux wrapper does for every argument shape', async () => {
    const root = await temporary()
    const realBin = join(root, 'real-bin')
    await mkdir(realBin)
    await writeFile(join(realBin, 'codex'), '#!/bin/sh\nfor argument do printf "%s\\n" "$argument"; done\n')
    await chmod(join(realBin, 'codex'), 0o755)
    for (const argv of cases) {
      const result = spawnSync('/bin/sh', [join(bin, 'codex'), ...argv], {
        env: { PATH: `${bin}:${realBin}:/usr/bin:/bin`, ...session }, encoding: 'utf8'
      })
      expect(result.status, argv.join(' ')).toBe(0)
      const received = result.stdout === '' ? [] : result.stdout.replace(/\n$/u, '').split('\n')
      expect(received, argv.join(' ')).toEqual([...codexWithoutSharedDaemon(argv)])
    }
  })
})

describe('the Windows codex launcher lookup', () => {
  it('removes BMN folders from PATH however they are spelled, keeping every other entry', () => {
    const compare = (folder: string) => win32.resolve(folder).replace(/\\+$/u, '').toLowerCase()
    const path = ['C:\\BMN\\resources\\bin', '"c:\\bmn\\RESOURCES\\bin\\"', 'C:\\Users\\a\\AppData\\Roaming\\npm', 'relative', '', 'D:\\tools']
      .join(';')
    expect(pathWithoutFolders(path, ['C:\\BMN\\resources\\bin'], compare))
      .toBe(['C:\\Users\\a\\AppData\\Roaming\\npm', 'relative', '', 'D:\\tools'].join(';'))
  })

  // A synthetic npm-installed Codex: cmd-shim's exact wrapper around a script, run by node.exe.
  async function npmCodex(root: string, exitCode = 0): Promise<{ folder: string; entry: string; record: string }> {
    const folder = join(root, 'npm')
    const entry = join(folder, 'node_modules', 'codex', 'bin', 'codex.js')
    const record = join(root, 'received.json')
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({
      argv: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      launcherFolder: process.env.BMN_LAUNCHER_DIRECTORY ?? null, token: process.env.BMN_TOKEN ?? null }))
process.exit(${exitCode})\n`)
    const shim = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex\\bin\\codex.js" %*', ''].join('\r\n')
    await writeFile(join(folder, 'codex.cmd'), shim)
    await copyFile(process.execPath, join(folder, 'node.exe'))
    return { folder, entry, record }
  }

  it.runIf(process.platform === 'win32')('finds the npm Codex past BMN\'s own launcher and keeps the session\'s environment', async () => {
    const root = await temporary()
    const launcherFolder = join(root, 'bmn-bin')
    await mkdir(launcherFolder)
    await copyFile(process.execPath, join(launcherFolder, 'codex.exe'))
    const codex = await npmCodex(root)
    const environment = { ...process.env, ...session, PATH: [launcherFolder, codex.folder].join(';'),
      bmn_launcher_directory: launcherFolder.toUpperCase(), ELECTRON_RUN_AS_NODE: '1' }
    const launch = realCodexLaunch(['exec', 'hi'], environment, root, join(root, 'script-folder'))
    expect(launch.executable.toLowerCase()).toBe(join(codex.folder, 'node.exe').toLowerCase())
    expect(launch.argv).toEqual([codex.entry, '--no-daemon', 'exec', 'hi'])
    expect(windowsEnvironmentValue(launch.environment, 'ELECTRON_RUN_AS_NODE')).toBeUndefined()
    expect(windowsEnvironmentValue(launch.environment, 'BMN_LAUNCHER_DIRECTORY')).toBeUndefined()
    expect(windowsEnvironmentValue(launch.environment, 'PATH')).toBe(environment.PATH)

    const outside = realCodexLaunch(['exec', 'hi'], { ...environment, BMN_TOKEN: '' }, root, join(root, 'script-folder'))
    expect(outside.argv).toEqual([codex.entry, 'exec', 'hi'])
    expect(() => realCodexLaunch([], { ...environment, PATH: launcherFolder }, root, join(root, 'script-folder')))
      .toThrow('The Windows program is not available')
  })

  // Built by scripts/build/windows-cli.mjs during install, beside bmn.exe.
  it.runIf(process.platform === 'win32')('runs the real Codex off the shared daemon from a session shell and returns its exit code', async () => {
    const launcherFolder = fileURLToPath(new URL('../../native-out/windows-cli/', import.meta.url))
    const root = await temporary()
    const codex = await npmCodex(root, 7)
    const run = (env: Record<string, string>) => new Promise<number | null>((resolve) => {
      execFile(join(launcherFolder, 'codex.exe'), ['exec', 'say "hi" & 100%'], {
        env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD',
          PATH: [launcherFolder, codex.folder].join(';'), ...env }, timeout: 30_000
      }, (error) => resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : null))
    })
    expect(await run({ ...session, BMN_CLI_BIN_DIR: launcherFolder })).toBe(7)
    expect(JSON.parse(await readFile(codex.record, 'utf8'))).toEqual({
      argv: ['--no-daemon', 'exec', 'say "hi" & 100%'], runAsNode: null, launcherFolder: null, token: 'synthetic-token'
    })
    expect(await run({})).toBe(7)
    expect(JSON.parse(await readFile(codex.record, 'utf8')).argv).toEqual(['exec', 'say "hi" & 100%'])
  }, 60_000)
})
