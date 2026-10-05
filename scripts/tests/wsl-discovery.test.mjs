// MODULE: wsl-discovery.test.mjs - WSL registrations, recorded-distribution resolution and distribution-qualified paths
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LXSS_REGISTRATIONS_COMMAND, confineGuestPath, guestPathFromWindows, parseRegistrations, parseWslVersion,
  qualifiedGuestPath, resolveRecordedDistribution
} from '../lib/wsl-discovery.mjs'

const UBUNTU = '{0B1E2F3A-4C5D-4E6F-8A9B-0C1D2E3F4A5B}'
const DEBIAN = '{11111111-2222-4333-8444-555555555555}'
const listing = (registrations, extra = {}) => JSON.stringify({ present: true, default: DEBIAN, registrations, ...extra })
const ubuntu = { id: UBUNTU, name: 'Ubuntu-24.04', version: 2, state: 1, basePath: 'C:\\Users\\synthetic\\Ubuntu' }
const debian = { id: DEBIAN, name: 'Debian', version: 2, state: 1, basePath: 'C:\\Users\\synthetic\\Debian' }
const recorded = { id: UBUNTU.toLowerCase(), name: 'Ubuntu-24.04' }

describe('WSL discovery', () => {
  it('reads the versions wsl.exe --version prints, and gives null for labels it cannot find', () => {
    // As printed on the Windows runner (run 37322654021).
    const text = 'WSL version: 2.7.14.0\r\nKernel version: 6.18.33.2-2\r\nWSLg version: 1.0.73.2\r\nWindows version: 10.0.26100.33438'
    expect(parseWslVersion(text)).toEqual({ wsl: '2.7.14.0', kernel: '6.18.33.2-2', windows: '10.0.26100.33438' })
    expect(parseWslVersion('Version de WSL : 2.7.14.0')).toEqual({ wsl: null, kernel: null, windows: null })
  })

  it('lists registrations by lowercased registry identity, keeps unusable entries visible and marks names equal apart from case', () => {
    const parsed = parseRegistrations('\uFEFF' + listing([ubuntu, debian, { id: 'not-a-guid', name: 'X', version: 2 },
      { id: '{22222222-3333-4444-8555-666666666666}', name: 'bad name', version: 2 },
      { id: '{33333333-4444-4555-8666-777777777777}', name: 'Legacy', version: 3 },
      { id: '{44444444-5555-4666-8777-888888888888}', name: 'debian', version: 2 }]))
    expect(parsed.present).toBe(true)
    expect(parsed.defaultId).toBe(DEBIAN.toLowerCase())
    expect(parsed.registrations.map((registration) => [registration.id, registration.name, registration.ambiguousName])).toEqual([
      [UBUNTU.toLowerCase(), 'Ubuntu-24.04', false], [DEBIAN.toLowerCase(), 'Debian', true],
      ['{44444444-5555-4666-8777-888888888888}', 'debian', true]])
    expect(parsed.ignored).toEqual([{ id: 'not-a-guid', reason: 'identity is not a registry GUID' },
      { id: '{22222222-3333-4444-8555-666666666666}', reason: 'name is not a WSL distribution name' },
      { id: '{33333333-4444-4555-8666-777777777777}', reason: 'version is neither 1 nor 2' }])
    // PowerShell prints a single registration as an object, none as an empty list, and no Lxss key as absent.
    expect(parseRegistrations(JSON.stringify({ present: true, default: null, registrations: ubuntu })).registrations).toHaveLength(1)
    expect(parseRegistrations(listing([]))).toMatchObject({ present: true, registrations: [] })
    expect(parseRegistrations('{"present":false}')).toEqual({ present: false, defaultId: null, registrations: [], ignored: [] })
    expect(() => parseRegistrations('WSL is not installed')).toThrow('not JSON')
  })

  it('resolves only the exact recorded registration, never the default or a same-named replacement', () => {
    const resolve = (registrations, extra) => resolveRecordedDistribution(recorded, parseRegistrations(listing(registrations, extra)))
    expect(resolve([ubuntu, debian])).toMatchObject({ ok: true, registration: { id: UBUNTU.toLowerCase(), name: 'Ubuntu-24.04' } })
    const outcomes = {
      missing: resolveRecordedDistribution(recorded, parseRegistrations('{"present":false}')),
      removed: resolve([debian]),
      replaced: resolve([{ ...ubuntu, id: '{55555555-6666-4777-8888-999999999999}' }, debian]),
      renamed: resolve([{ ...ubuntu, name: 'Ubuntu-Work' }, debian]),
      ambiguous: resolve([ubuntu, { ...ubuntu, id: '{55555555-6666-4777-8888-999999999999}', name: 'ubuntu-24.04' }]),
      wsl1: resolve([{ ...ubuntu, version: 1 }])
    }
    expect(Object.fromEntries(Object.entries(outcomes).map(([name, outcome]) => [name, outcome.code]))).toEqual({
      missing: 'WSL_MISSING', removed: 'DISTRO_CHANGED', replaced: 'DISTRO_CHANGED', renamed: 'DISTRO_CHANGED',
      ambiguous: 'DISTRO_CHANGED', wsl1: 'UNSUPPORTED_PROFILE' })
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.ok).toBe(false)
      // Every message says what to do and that Windows sessions keep working.
      expect(outcome.message).toMatch(/(Install|Choose|Rename|Convert)/u)
      expect(outcome.message).toContain('Windows sessions are not affected.')
    }
    expect(outcomes.replaced.message).toContain('replaced by a new registration with the same name')
  })

  it('keeps equal Linux paths in two distributions apart and confines paths to an authorized root', () => {
    const inUbuntu = qualifiedGuestPath(UBUNTU.toLowerCase(), '/home/project/a.txt')
    const inDebian = qualifiedGuestPath(DEBIAN.toLowerCase(), '/home/project/a.txt')
    expect(inUbuntu).not.toEqual(inDebian)
    const root = qualifiedGuestPath(UBUNTU.toLowerCase(), '/home/project')
    expect(confineGuestPath(root, inUbuntu)).toEqual(['a.txt'])
    expect(confineGuestPath(root, root)).toEqual([])
    expect(confineGuestPath(qualifiedGuestPath(UBUNTU.toLowerCase(), '/'), inUbuntu)).toEqual(['home', 'project', 'a.txt'])
    expect(() => confineGuestPath(root, inDebian)).toThrow('another distribution')
    expect(() => confineGuestPath(root, qualifiedGuestPath(UBUNTU.toLowerCase(), '/home/project-other/a.txt'))).toThrow('outside the authorized root')
    expect(() => qualifiedGuestPath(UBUNTU.toLowerCase(), '/home/project/../other')).toThrow('not a normalized path')
    expect(() => qualifiedGuestPath(UBUNTU, '/home')).toThrow('lowercase registration GUID')
  })

  it('maps \\\\wsl$ and \\\\wsl.localhost paths to exactly one registration, and fails rather than guess', () => {
    const discovery = parseRegistrations(listing([ubuntu, debian]))
    expect(guestPathFromWindows('\\\\wsl$\\Ubuntu-24.04\\home\\project\\a.txt', discovery))
      .toEqual({ distributionId: UBUNTU.toLowerCase(), path: '/home/project/a.txt' })
    expect(guestPathFromWindows('\\\\WSL.LOCALHOST\\ubuntu-24.04\\', discovery)).toEqual({ distributionId: UBUNTU.toLowerCase(), path: '/' })
    expect(guestPathFromWindows('\\\\wsl.localhost\\Debian\\home/project', discovery)).toEqual({ distributionId: DEBIAN.toLowerCase(), path: '/home/project' })
    expect(guestPathFromWindows('C:\\Users\\synthetic\\a.txt', discovery)).toBeNull()
    expect(guestPathFromWindows('\\\\server\\share\\a.txt', discovery)).toBeNull()
    expect(() => guestPathFromWindows('\\\\wsl$\\Fedora\\home', discovery)).toThrow('no installed distribution is named "Fedora"')
    const twins = parseRegistrations(listing([ubuntu, { ...ubuntu, id: '{55555555-6666-4777-8888-999999999999}', name: 'UBUNTU-24.04' }]))
    expect(() => guestPathFromWindows('\\\\wsl$\\Ubuntu-24.04\\home', twins)).toThrow('is ambiguous')
    expect(() => guestPathFromWindows('\\\\wsl$\\Ubuntu-24.04\\home\\..\\etc', discovery)).toThrow('not a normalized path')
    expect(() => guestPathFromWindows('\\\\?\\UNC\\wsl$\\Ubuntu-24.04\\home', discovery)).toThrow('device paths')
  })

  it('reads the registry without writing to it', () => {
    expect(LXSS_REGISTRATIONS_COMMAND).toContain('-LiteralPath')
    expect(LXSS_REGISTRATIONS_COMMAND).not.toMatch(/\b(Set|New|Remove|Rename|Clear|Copy|Move)-Item/iu)
  })

  // Native: the command on the runner's own registry (no distributions are installed there).
  const powerShell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
  it.runIf(powerShell !== null && existsSync(powerShell ?? ''))('lists the registrations in Windows PowerShell as JSON the parser accepts', () => {
    const output = execFileSync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LXSS_REGISTRATIONS_COMMAND],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const parsed = parseRegistrations(output.trim())
    expect(typeof parsed.present).toBe('boolean')
    expect(parsed.ignored).toEqual([])
  }, 60_000)
})
