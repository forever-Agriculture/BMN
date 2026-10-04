import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { startWindowsInstallNotice, removeWindowsInstalledPayloads, windowsMappedEnginePayloads, waitForWindowsAppsToExit, windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'

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
  const root = mkdtempSync(join(tmpdir(), 'bmn-installer-env-'))
  try {
    const environment = windowsInstallerSmokeEnvironment(root, { SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'synthetic-secret', BMN_TOKEN: 'synthetic-binding', NODE_OPTIONS: '--require hostile',
      ELECTRON_RUN_AS_NODE: '1', USERPROFILE: 'owner-profile', PATH: 'owner-provider-bin' })
    expect(environment.USERPROFILE).toBe(join(root, 'home'))
    for (const name of ['OPENAI_API_KEY', 'BMN_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) expect(environment[name]).toBeUndefined()
    expect(environment.Path).not.toContain('owner-provider-bin')
  } finally { rmSync(root, { recursive: true, force: true }) }
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

it('shows an asynchronous owned notice with no deadline and closes only its own child', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() })
  const start = vi.fn(() => child)
  const notice = startWindowsInstallNotice('synthetic update status', { start, executable: 'C:\\Windows\\powershell.exe' })
  const options = start.mock.calls[0][2]
  expect(options.env.BMN_INSTALL_NOTICE).toBe('synthetic update status')
  expect(options.timeout).toBeUndefined(); expect(options.windowsHide).toBe(false)
  notice.close(); expect(child.kill).toHaveBeenCalledOnce()
  child.emit('exit', 0, null); await notice.completion
  child.exitCode = 0; notice.close(); expect(child.kill).toHaveBeenCalledOnce()
})
it('propagates a failed notice child without turning its output into executable text', async () => {
  const child = new EventEmitter()
  const notice = startWindowsInstallNotice('literal % ^& "text"', { start: () => child, executable: 'synthetic' })
  child.emit('error', new Error('synthetic unavailable notice'))
  await expect(notice.completion).rejects.toThrow('unavailable notice')
})
