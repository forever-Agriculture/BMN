import { describe, expect, it, vi } from 'vitest'
import { withWindowsInstallLease, withWindowsReleaseLeases } from '../lib/windows-install-lease.mjs'

describe('Windows update lease adapter', () => {
  it('can retain a shared startup lease without granting update access', async () => {
    const close = vi.fn(), acquireInstallLease = vi.fn(() => ({ close }))
    await withWindowsInstallLease('/install', async () => {}, { native: { acquireInstallLease }, exclusive: false })
    expect(acquireInstallLease.mock.calls[0][1]).toBe(false)
    expect(close).toHaveBeenCalledOnce()
  })
  it('holds installation then data leases through the operation and releases them in reverse order', async () => {
    const order = []
    const native = { acquireInstallLease: vi.fn(path => {
      const role = path.endsWith('update.lock') ? 'data' : 'installation'
      order.push('acquire-' + role); return { close: () => order.push('close-' + role) }
    }) }
    await withWindowsReleaseLeases('/install', '/data', async () => { order.push('operation') }, { native })
    expect(order).toEqual(['acquire-installation', 'acquire-data', 'operation', 'close-data', 'close-installation'])
  })
  it('waits only on a live sharing conflict and closes its own acquired lease after failure', async () => {
    const close = vi.fn(), onWait = vi.fn(), wait = vi.fn(async () => {})
    const acquireInstallLease = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { windowsError: 32 }) })
      .mockReturnValue({ close })
    await expect(withWindowsInstallLease('/synthetic', async () => { throw new Error('smoke failed') },
      { native: { acquireInstallLease }, onWait, wait })).rejects.toThrow('smoke failed')
    expect(acquireInstallLease).toHaveBeenCalledTimes(2); expect(onWait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })
  it('never treats denied access as another running instance or retries it', async () => {
    const wait = vi.fn(), operation = vi.fn()
    const acquireInstallLease = vi.fn(() => { throw Object.assign(new Error('denied'), { windowsError: 5 }) })
    await expect(withWindowsInstallLease('/synthetic', operation, { native: { acquireInstallLease }, wait })).rejects.toThrow('denied')
    expect(wait).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled()
  })
  it('honors cancellation while waiting without disposing someone else’s handle', async () => {
    const controller = new AbortController(), operation = vi.fn()
    const acquireInstallLease = vi.fn(() => { throw Object.assign(new Error('busy'), { windowsError: 32 }) })
    const wait = vi.fn(async () => { controller.abort() })
    await expect(withWindowsInstallLease('/synthetic', operation, { native: { acquireInstallLease }, signal: controller.signal, wait })).rejects.toThrow()
    expect(acquireInstallLease).toHaveBeenCalledOnce(); expect(operation).not.toHaveBeenCalled()
  })
})
