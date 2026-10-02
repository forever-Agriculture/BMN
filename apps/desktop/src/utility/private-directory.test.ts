import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { ensurePrivateDirectories } from './private-directory'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('private application directories', () => {
  it.runIf(process.platform !== 'win32')('retains Linux mode 0700 on new and existing directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-private-test-'))
    try {
      const child = join(root, 'data')
      ensurePrivateDirectories([child])
      ensurePrivateDirectories([child])
      expect(statSync(child).mode & 0o777).toBe(0o700)
      expect(spawnSync).not.toHaveBeenCalled()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['relative', 'C:\\', 'C:\\Windows'])('refuses a non-dedicated root before changing ACLs: %s', (root) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    expect(() => ensurePrivateDirectories([root], 'win32')).toThrow(/dedicated absolute/)
    expect(spawnSync).not.toHaveBeenCalled()
  })
  it('passes Windows paths as JSON input, never executable text', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'BMN_PRIVATE_ROOTS_OK' } as ReturnType<typeof spawnSync>)
    const path = 'C:\\synthetic\\"; Write-Output BAD; #数据'
    ensurePrivateDirectories([path, path], 'win32')
    const [exe, args, options] = vi.mocked(spawnSync).mock.calls[0]!
    expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(options).toMatchObject({ timeout: 15_000, windowsHide: true })
    expect(JSON.parse(options!.input as string)).toMatchObject({ paths: [path] })
    expect(Buffer.from(args!.at(-1)!, 'base64').toString('utf16le')).not.toContain(path)
  })
  it.each([
    ['C:\\profile', 'C:\\profile'],
    ['C:\\profile', 'C:\\profile\\Cache'],
    ['C:\\profile', 'C:\\'],
    ['C:\\profile', 'c:\\PROFILE\\config']
  ])('refuses Chromium policy on aliased or overlapping application roots: %j', (...roots) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    expect(() => ensurePrivateDirectories(roots, 'win32', roots[0])).toThrow(/distinct|overlap/)
    expect(spawnSync).not.toHaveBeenCalled()
  })
  it.each([
    { status: 1, stdout: 'BMN_PRIVATE_ROOTS_OK' },
    { status: 0, stdout: '' },
    { status: null, error: new Error('timeout') }
  ])('refuses startup when ACL execution or readback fails: %j', (result) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.mocked(spawnSync).mockReturnValue(result as unknown as ReturnType<typeof spawnSync>)
    expect(() => ensurePrivateDirectories(['C:\\isolated'], 'win32')).toThrow(/could not secure/)
  })
})
