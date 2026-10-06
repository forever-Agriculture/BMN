import processes from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { nativeTimings } from './native-timings.test-support.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
// Payload removal is switchable so one test can make the smoke profile's removal fail.
const removal = vi.hoisted(() => ({ fail: null }))
vi.mock('../lib/physical-payload-fs.mjs', async (importOriginal) => {
  const { physicalPayloadFs } = await importOriginal()
  return { physicalPayloadFs: { ...physicalPayloadFs,
    rmSync: (...args) => removal.fail ? removal.fail(...args) : physicalPayloadFs.rmSync(...args) } }
})
import { removeWindowsInstalledPayloads, smokeWindowsInstalledPayload, windowsMappedEnginePayloads, waitForWindowsAppsToExit, windowsInstallerSmokeEnvironment, windowsInstallerSmokeFolders } from '../lib/windows-installed-worker.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { resolveApplicationRoots } from '../../apps/desktop/src/utility/roots.ts'

it('waits for utilities and for a quiet observation after a relaunch', async () => {
  const observations = [[10, 20], [10], [10, 30], [10], [10]]
  let waits = 0
  await waitForWindowsAppsToExit({ ownPid: 10, observe: () => observations.shift(), wait: async () => { waits++ } })
  expect(observations).toHaveLength(0); expect(waits).toBe(3)
})
it('refuses incomplete process observations instead of treating them as exit', async () => {
  await expect(waitForWindowsAppsToExit({ observe: () => null })).rejects.toThrow('incomplete')
  await expect(waitForWindowsAppsToExit({ ownPid: 10, observe: () => [10, '20'] })).rejects.toThrow('incomplete')
})
it('smokes with fresh homes and excludes owner credentials, Node flags and BMN bindings', () => {
  const trace = nativeTimings('installer-smoke-environment')
  let root, call = 0
  const actualSpawn = processes.spawnSync
  const observer = vi.spyOn(processes, 'spawnSync').mockImplementation((...args) => {
    const input = args[2]?.input
    let name
    try { const paths = JSON.parse(input).paths; name = paths.length === windowsInstallerSmokeFolders.length ? 'all-smoke-roots' : basename(paths[0]) }
    catch { name = 'unknown' }
    if (!['all-smoke-roots', ...windowsInstallerSmokeFolders].includes(name)) name = 'unknown'
    return trace.measure(`provision:${++call}:${name}`, () => actualSpawn(...args))
  })
  syncBuiltinESMExports()
  try {
    root = trace.measure('setup', () => mkdtempSync(join(tmpdir(), 'bmn-installer-env-')))
    trace.mark('environment:begin')
    const environment = windowsInstallerSmokeEnvironment(root, { SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'synthetic-secret', BMN_TOKEN: 'synthetic-binding', NODE_OPTIONS: '--require hostile',
      ELECTRON_RUN_AS_NODE: '1', USERPROFILE: 'owner-profile', PATH: 'owner-provider-bin' })
    trace.mark('environment:end'); trace.mark('assertions:begin')
    expect(environment.USERPROFILE).toBe(join(root, 'home'))
    for (const name of ['OPENAI_API_KEY', 'BMN_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) expect(environment[name]).toBeUndefined()
    expect(environment.Path).not.toContain('owner-provider-bin')
    const roots = windowsInstallerSmokeFolders.map(name => join(root, name))
    expect(roots.every(path => existsSync(path))).toBe(true)
    if (process.platform === 'win32') {
      expect(observer).toHaveBeenCalledOnce()
      expect(JSON.parse(observer.mock.calls[0][2].input).paths).toEqual(roots)
    }
    trace.mark('assertions:end')
  } finally {
    try { if (root) trace.measure('cleanup', () => rmSync(root, { recursive: true, force: true })) }
    finally { observer.mockRestore(); syncBuiltinESMExports(); trace.report() }
  }
}, process.platform === 'win32' ? 30000 : 5000)

it('gives the smoke profile shell folders that installed BMN accepts as distinct from its roots', () => {
  // The installed smoke once set LOCALAPPDATA to BMN_DATA_HOME, which installed BMN's startup refuses before any
  // self-test output. Startup's own root resolution and folder checks run here with Windows path rules; the
  // checks stop at a withheld SystemRoot, so no PowerShell runs and only the root validation is exercised.
  const root = mkdtempSync(join(tmpdir(), 'bmn-installer-roots-'))
  const saved = Object.fromEntries(['LOCALAPPDATA', 'SystemRoot', 'HOME', 'USERPROFILE'].map(name => [name, process.env[name]]))
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const startup = environment => {
    const roots = resolveApplicationRoots(environment, { homeDirectory: environment.USERPROFILE, runtimeFallback: environment.TEMP ?? root }, 'win32')
    process.env.LOCALAPPDATA = environment.LOCALAPPDATA
    process.env.HOME = process.env.USERPROFILE = environment.USERPROFILE
    process.env.SystemRoot = 'withheld'
    try { ensurePrivateDirectories(Object.values(roots), 'win32', roots.data) } finally { restore() }
  }
  try {
    const environment = windowsInstallerSmokeEnvironment(root, { SystemRoot: 'C:\\Windows' })
    expect(() => startup(environment)).toThrow('Windows SystemRoot is unavailable')
    expect(() => startup({ ...environment, LOCALAPPDATA: environment.BMN_DATA_HOME })).toThrow('dedicated absolute application directories')
    const bmnRoots = [environment.BMN_CONFIG_HOME, environment.BMN_DATA_HOME, environment.BMN_STATE_HOME, environment.BMN_RUNTIME_HOME]
    for (const folder of [environment.LOCALAPPDATA, environment.APPDATA]) {
      expect(existsSync(folder)).toBe(true)
      expect(bmnRoots).not.toContain(folder)
    }
    expect(environment.LOCALAPPDATA).not.toBe(environment.APPDATA)
  } finally { restore(); rmSync(root, { recursive: true, force: true }) }
})

it('reports a failed installed smoke even when its temporary profile cannot be removed yet', async () => {
  // Run 37312653316: removing the smoke profile threw, and that error replaced the smoke's own result.
  // Folder security and the smoke run are replaced here: the run fails and the profile removal fails.
  const actualSpawn = processes.spawnSync
  const removed = []
  vi.spyOn(processes, 'spawnSync').mockImplementation((command, args, options) => {
    if (String(command).endsWith('BMN.exe')) {
      return { status: 1, signal: null, stdout: '\r\n', stderr: '[BMN] self-test phase: startup ready +765ms\n[BMN] session self-test failed: synthetic installed failure\n' }
    }
    return actualSpawn(command, args, options)
  })
  removal.fail = (path) => {
    removed.push(path)
    throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
  }
  syncBuiltinESMExports()
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32') process.env.SystemRoot = 'C:\\Windows'
  try {
    const failure = await smokeWindowsInstalledPayload(mkdtempSync(join(tmpdir(), 'bmn-installed-root-'))).catch(error => error)
    expect(failure.message).toBe('Installed candidate failed isolated smoke')
    expect(failure.smokeOutcome).toMatchObject({ status: 1, cleanupErrorCode: 'EBUSY',
      failure: 'synthetic installed failure', phases: ['startup ready +765ms'] })
  } finally {
    removal.fail = null
    vi.restoreAllMocks(); syncBuiltinESMExports()
    if (process.platform !== 'win32') { if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot }
    for (const path of removed) rmSync(path, { recursive: true, force: true })
  }
})

it('retains only the mapped current engine and removes inactive payloads and staging on uninstall', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-mapped-engine-'))
  const retained = join(root, 'versions/current')
  try {
    for (const relative of ['versions/current', 'versions/previous', 'staging/partial', 'bootstrap']) {
      mkdirSync(join(root, relative), { recursive: true }); writeFileSync(join(root, relative, 'sentinel'), relative)
    }
    removeWindowsInstalledPayloads(root, retained)
    expect(readFileSync(join(retained, 'sentinel'), 'utf8')).toBe('versions/current')
    expect(readFileSync(join(root, 'bootstrap/sentinel'), 'utf8')).toBe('bootstrap')
    expect(existsSync(join(root, 'versions/previous'))).toBe(false); expect(existsSync(join(root, 'staging'))).toBe(false)
    removeWindowsInstalledPayloads(root, join(root, 'bootstrap'))
    expect(existsSync(retained)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('retains every observed mapped managed engine and ignores other installations', () => {
  const root = 'C:\\synthetic\\BMN', version = 'a'.repeat(40) + '-' + 'b'.repeat(64)
  const payload = root + '\\versions\\' + version
  expect(windowsMappedEnginePayloads(root, [payload + '\\BMN-worker.exe', 'C:\\other\\BMN-worker.exe'])).toEqual([payload])
  expect(() => windowsMappedEnginePayloads(root, [null])).toThrow('incomplete')
  expect(() => windowsMappedEnginePayloads(root, [root + '\\versions\\unknown\\BMN-worker.exe'])).toThrow('invalid')
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-mapped-peers-'))
  try {
    for (const name of ['own', 'waiting-peer', 'inactive']) mkdirSync(join(temporary, 'versions', name), { recursive: true })
    removeWindowsInstalledPayloads(temporary, join(temporary, 'versions/own'), [join(temporary, 'versions/waiting-peer')])
    expect(existsSync(join(temporary, 'versions/own'))).toBe(true)
    expect(existsSync(join(temporary, 'versions/waiting-peer'))).toBe(true)
    expect(existsSync(join(temporary, 'versions/inactive'))).toBe(false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

