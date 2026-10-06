import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { protectWindowsApplicationLifetime } from './windows-application-lifetime'

describe('Windows application lifetime protection', () => {
  // The native crash fixture's original-defect control removes exactly this statement from the built main
  // (scripts/test/fixtures/windows-application-crash.mjs); wrapping the call would leave it nothing to remove.
  it('is called by startup as one standalone statement', () => {
    const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(main.match(/^protectWindowsApplicationLifetime\(\)$/gmu)).toHaveLength(1)
  })

  it('keeps the Linux startup independent of Windows native modules', () => {
    const load = vi.fn()
    protectWindowsApplicationLifetime('linux', load)
    expect(load).not.toHaveBeenCalled()
  })

  it('establishes the native backstop synchronously and exposes no disposer', () => {
    const protect = vi.fn()
    expect(protectWindowsApplicationLifetime('win32', () => ({ protectApplicationLifetime: protect }))).toBeUndefined()
    expect(protect).toHaveBeenCalledOnce()
  })

  it('refuses startup without the patched native operation or when assignment fails', () => {
    expect(() => protectWindowsApplicationLifetime('win32', () => ({}))).toThrow('unavailable')
    const failure = new Error('Job assignment refused')
    expect(() => protectWindowsApplicationLifetime('win32', () => ({
      protectApplicationLifetime() { throw failure }
    }))).toThrow(failure)
  })
})
