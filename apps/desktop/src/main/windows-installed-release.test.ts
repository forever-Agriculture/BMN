import { describe, expect, it, vi } from 'vitest'
import { retainWindowsDataLease, retainWindowsInstalledRelease as retainInstalledRelease } from './windows-installed-release'

// Windows path fixtures are textual on the Linux test host. Production uses
// realpathSync.native; the short-name test supplies its explicit canonical path.
const retainWindowsInstalledRelease = (path: string, options: Parameters<typeof retainInstalledRelease>[1] = {}) =>
  retainInstalledRelease(path, { canonicalExecutable: value => value, ...options })

const root = 'C:\\Users\\synthetic\\AppData\\Local\\Programs\\BMN'
const current = { commit: 'a'.repeat(40), payloadSha256: 'b'.repeat(64), schemaVersion: 23 }
const executable = `${root}\\versions\\${current.commit}-${current.payloadSha256}\\BMN.exe`

describe('versioned Windows application startup', () => {
  it('refuses direct GUI launch of the retained offline bootstrap before opening any data', () => {
    const loadNative = vi.fn(), readInstallation = vi.fn()
    expect(() => retainWindowsInstalledRelease(`${root}\\bootstrap\\BMN.exe`, { platform: 'win32', loadNative, readInstallation })).toThrow('offline installation runtime')
    expect(loadNative).not.toHaveBeenCalled(); expect(readInstallation).not.toHaveBeenCalled()
  })
  it('holds a data lease for an unpacked Windows copy and requires the current capability', () => {
    const close = vi.fn(), acquireInstallLease = vi.fn(() => ({ close }))
    expect(retainWindowsDataLease('C:\\synthetic\\data', { platform: 'win32',
      loadNative: () => ({ bmnInstallLeaseVersion: 1, acquireInstallLease }) })).toEqual({ close })
    expect(acquireInstallLease).toHaveBeenCalledWith('C:\\synthetic\\data\\update.lock', false)
    expect(close).not.toHaveBeenCalled()
    expect(() => retainWindowsDataLease('C:\\synthetic\\data', { platform: 'win32', loadNative: () => ({}) })).toThrow('unavailable')
    expect(retainWindowsDataLease('/linux', { platform: 'linux', loadNative: () => { throw new Error('must not load') } })).toBeNull()
  })
  it('retains a shared lease before reading selection, including case-insensitive installed paths', () => {
    const close = vi.fn(), order: string[] = []
    const acquireInstallLease = vi.fn((path, exclusive) => {
      expect(path.toLowerCase()).toBe(`${root}\\run.lock`.toLowerCase()); expect(exclusive).toBe(false)
      order.push('lease'); return { close }
    })
    const lease = retainWindowsInstalledRelease(executable.toUpperCase(), { platform: 'win32',
      loadNative: () => ({ bmnInstallLeaseVersion: 1, acquireInstallLease }),
      readInstallation: () => { order.push('selection'); return { format: 1, current, previous: null, snapshot: null } } })
    expect(order).toEqual(['lease', 'selection']); expect(close).not.toHaveBeenCalled()
    lease!.close(); expect(close).toHaveBeenCalledOnce()
  })
  it('refuses an old generation before its data is opened and closes only its own lease', () => {
    const close = vi.fn()
    expect(() => retainWindowsInstalledRelease(executable, { platform: 'win32',
      loadNative: () => ({ bmnInstallLeaseVersion: 1, acquireInstallLease: () => ({ close }) }),
      readInstallation: () => ({ format: 1, current: { ...current, commit: 'c'.repeat(40) }, previous: current, snapshot: null }) }))
      .toThrow('not selected')
    expect(close).toHaveBeenCalledOnce()
  })
  it('refuses unavailable capability or an exclusive updater without reading selection', () => {
    const readInstallation = vi.fn()
    expect(() => retainWindowsInstalledRelease(executable, { platform: 'win32', loadNative: () => ({}), readInstallation }))
      .toThrow('unavailable')
    const busy = Object.assign(new Error('updater holds the lease'), { windowsError: 32 })
    expect(() => retainWindowsInstalledRelease(executable, { platform: 'win32', readInstallation,
      loadNative: () => ({ bmnInstallLeaseVersion: 1, acquireInstallLease: () => { throw busy } }) })).toThrow(busy)
    expect(readInstallation).not.toHaveBeenCalled()
  })
  it('leaves Linux, development and ordinary unpacked startup outside installed selection', () => {
    const loadNative = vi.fn(), readInstallation = vi.fn()
    for (const [path, platform] of [[executable, 'linux'], ['C:\\build\\electron.exe', 'win32'], ['C:\\build\\win-unpacked\\BMN.exe', 'win32']] as const) {
      expect(retainWindowsInstalledRelease(path, { platform, loadNative, readInstallation })).toBeNull()
    }
    expect(loadNative).not.toHaveBeenCalled(); expect(readInstallation).not.toHaveBeenCalled()
  })
})

it.each(['bootstrap', 'versions/current', 'staging/partial', 'other'])('refuses worker-image GUI startup in %s before data/native access', location => {
  const loadNative = vi.fn(), readInstallation = vi.fn()
  expect(() => retainWindowsInstalledRelease(`${root}\\${location.replaceAll('/', '\\')}\\BMN-WORKER.EXE`,
    { platform: 'win32', loadNative, readInstallation })).toThrow('installed shortcut')
  expect(loadNative).not.toHaveBeenCalled(); expect(readInstallation).not.toHaveBeenCalled()
})
it('canonicalizes a short worker executable name before the GUI-image guard', () => {
  const loadNative = vi.fn()
  expect(() => retainWindowsInstalledRelease(`${root}\\BOOTST~1\\BMN-WO~1.EXE`, { platform: 'win32', loadNative,
    canonicalExecutable: () => `${root}\\bootstrap\\BMN-worker.exe` })).toThrow('installed shortcut')
  expect(loadNative).not.toHaveBeenCalled()
})

it('applies installed selection protection to a renamed executable inside a versioned payload', () => {
  const loadNative = vi.fn(() => ({ bmnInstallLeaseVersion: 1, acquireInstallLease: () => ({ close() {} }) }))
  expect(() => retainWindowsInstalledRelease(executable.replace('BMN.exe', 'renamed.exe'), { platform: 'win32', loadNative,
    readInstallation: () => ({ format: 1, current: { ...current, commit: 'c'.repeat(40) }, previous: current, snapshot: null }) }))
    .toThrow('not selected')
  expect(loadNative).toHaveBeenCalledOnce()
})
