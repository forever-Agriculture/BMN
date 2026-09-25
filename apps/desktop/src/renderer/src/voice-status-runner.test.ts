import { describe, expect, it, vi } from 'vitest'
import { createVoiceStatusRunner } from './voice-status-runner'
import type { VoiceStatus } from '@bmn/protocol'

const status = (receivedBytes: number): VoiceStatus => ({
  engineAvailable: true,
  modelFolder: { path: '/models', custom: false, available: true },
  models: [{ id: 'base', label: 'Base', bytes: 1, installed: false, download: { receivedBytes } }]
})

function deferred(): { promise: Promise<VoiceStatus>; resolve(value: VoiceStatus): void; reject(cause: unknown): void } {
  let resolve: (value: VoiceStatus) => void = () => undefined
  let reject: (cause: unknown) => void = () => undefined
  const promise = new Promise<VoiceStatus>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('voice status runner', () => {
  it('publishes the newest result when an older response that still shows a dismissed error resolves last', async () => {
    const publish = vi.fn()
    const beforeDismiss = deferred()
    const afterDismiss = deferred()
    let readCount = 0
    const runner = createVoiceStatusRunner(
      () => (++readCount === 1 ? beforeDismiss.promise : afterDismiss.promise),
      publish
    )

    const first = runner.run()
    const second = runner.run()
    // The Dismiss's own refresh answers first with the download gone…
    afterDismiss.resolve(status(0))
    await second
    // …then the older response, captured while the error was still in the slot, resolves.
    beforeDismiss.resolve(status(1_000))
    await first

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(0) })
  })

  it('publishes a failure only while it is still the newest request', async () => {
    const publish = vi.fn()
    const failing = deferred()
    let readCount = 0
    const runner = createVoiceStatusRunner(
      () => (++readCount === 1 ? failing.promise : Promise.resolve(status(7))),
      publish
    )

    const first = runner.run()
    const second = runner.run()
    await second
    // The older request fails only after a newer one already published: its failure is dropped.
    failing.reject(new Error('status read failed'))
    await expect(first).resolves.toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ kind: 'status', status: status(7) })
  })

  it('drops results after cancel', async () => {
    const publish = vi.fn()
    const pending = deferred()
    const runner = createVoiceStatusRunner(() => pending.promise, publish)
    const running = runner.run()
    runner.cancel()
    pending.resolve(status(3))
    await running
    expect(publish).not.toHaveBeenCalled()
  })
})
