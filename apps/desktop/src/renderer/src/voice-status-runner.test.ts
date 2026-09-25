import { describe, expect, it, vi } from 'vitest'
import { createVoiceStatusRunner } from './voice-status-runner'
import type { VoiceStatus } from '@bmn/protocol'

const status = (receivedBytes: number): VoiceStatus => ({
  engineAvailable: true,
  modelFolder: { path: '/models', custom: false, available: true },
  models: [{ id: 'base', label: 'Base', bytes: 1, installed: false, download: { receivedBytes } }]
})

const statusWithError = (): VoiceStatus => ({
  engineAvailable: true,
  modelFolder: { path: '/models', custom: false, available: true },
  models: [{ id: 'base', label: 'Base', bytes: 1, installed: false, download: { receivedBytes: 1_000, error: 'connection reset' } }]
})

function deferred(): { promise: Promise<VoiceStatus>; resolve(value: VoiceStatus): void; reject(cause: unknown): void } {
  let resolve: (value: VoiceStatus) => void = () => undefined
  let reject: (cause: unknown) => void = () => undefined
  const promise = new Promise<VoiceStatus>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('voice status runner', () => {
  it('lets a slow poll publish while ticks keep coming, without a backlog of reads', async () => {
    const publish = vi.fn()
    const reads = [deferred(), deferred(), deferred()]
    let readCount = 0
    const runner = createVoiceStatusRunner(() => reads[readCount++]!.promise, publish)

    // The first poll's read is still pending, so further ticks skip instead of superseding it.
    const first = runner.poll()
    expect(readCount).toBe(1)
    await runner.poll()
    await runner.poll()
    expect(readCount).toBe(1)
    reads[0]!.resolve(status(1_000))
    await first
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(1_000) })

    // Settlement reopens the gate: the next tick issues exactly one further read.
    const second = runner.poll()
    expect(readCount).toBe(2)
    reads[1]!.resolve(statusWithError())
    await second
    expect(publish).toHaveBeenLastCalledWith({ kind: 'status', status: statusWithError() })

    // A rejected read also settles: the gate reopens and the failure is published.
    const third = runner.poll()
    expect(readCount).toBe(3)
    reads[2]!.reject(new Error('status read failed'))
    await third
    expect(publish).toHaveBeenLastCalledWith({ kind: 'unavailable', cause: expect.objectContaining({ message: 'status read failed' }) })
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('keeps a dismissed error dismissed: the explicit refresh wins in either completion order', async () => {
    for (const order of ['refresh-first', 'stale-first'] as const) {
      const publish = vi.fn()
      const stale = deferred()
      const afterDismiss = deferred()
      let readCount = 0
      const runner = createVoiceStatusRunner(
        () => (++readCount === 1 ? stale.promise : afterDismiss.promise),
        publish
      )
      const polling = runner.poll()
      const refresh = runner.run()
      if (order === 'refresh-first') {
        afterDismiss.resolve(status(0))
        await refresh
        stale.resolve(statusWithError())
      } else {
        stale.resolve(statusWithError())
        await polling
        afterDismiss.resolve(status(0))
        await refresh
      }
      await polling
      expect(publish, order).toHaveBeenCalledTimes(1)
      expect(publish, order).toHaveBeenCalledWith({ kind: 'status', status: status(0) })
    }
  })

  it('an obsolete read cannot reopen the gate or publish over its successor', async () => {
    const publish = vi.fn()
    const obsolete = deferred()
    const current = deferred()
    let readCount = 0
    const runner = createVoiceStatusRunner(
      () => (++readCount === 1 ? obsolete.promise : current.promise),
      publish
    )
    const polling = runner.poll()
    const refresh = runner.run()
    // The tick lands while the successor is still pending: it must not issue a third read.
    await runner.poll()
    expect(readCount).toBe(2)
    obsolete.resolve(statusWithError())
    await polling
    current.resolve(status(5_000))
    await refresh
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(5_000) })
    // The successor's completion reopened the gate.
    const next = runner.poll()
    expect(readCount).toBe(3)
    next.catch(() => undefined)
  })

  it('ticks cannot supersede an explicit action refresh', async () => {
    const publish = vi.fn()
    const action = deferred()
    let readCount = 0
    const runner = createVoiceStatusRunner(() => (++readCount === 1 ? action.promise : Promise.resolve(status(9))), publish)
    const refresh = runner.run()
    await runner.poll()
    expect(readCount).toBe(1)
    action.resolve(status(9))
    await refresh
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(9) })
  })

  it('cancel drops late results and a fresh explicit refresh still works', async () => {
    const publish = vi.fn()
    const cancelled = deferred()
    let readCount = 0
    const runner = createVoiceStatusRunner(() => (++readCount === 1 ? cancelled.promise : Promise.resolve(status(3))), publish)
    const running = runner.run()
    runner.cancel()
    cancelled.resolve(status(3))
    await running
    expect(publish).not.toHaveBeenCalled()
    await runner.run()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(3) })
  })

  it('a newer explicit refresh wins over an earlier one, in either completion order', async () => {
    for (const order of ['newer-first', 'older-first'] as const) {
      const publish = vi.fn()
      const first = deferred()
      const second = deferred()
      let readCount = 0
      const runner = createVoiceStatusRunner(
        () => (++readCount === 1 ? first.promise : second.promise),
        publish
      )
      const older = runner.run()
      const newer = runner.run()
      if (order === 'newer-first') {
        second.resolve(status(2))
        await newer
        first.resolve(status(1))
      } else {
        first.resolve(status(1))
        await older
        second.resolve(status(2))
        await newer
      }
      await older
      expect(publish, order).toHaveBeenCalledTimes(1)
      expect(publish, order).toHaveBeenCalledWith({ kind: 'status', status: status(2) })
    }
  })
})
