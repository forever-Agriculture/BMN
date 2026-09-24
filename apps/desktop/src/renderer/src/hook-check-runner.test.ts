import { describe, expect, it } from 'vitest'
import type { HookCheckReport } from '@bmn/protocol'
import { createHookCheckRunner, type HookCheckEvent } from './hook-check-runner'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(cause: Error): void } {
  let resolve: (value: T) => void = () => undefined
  let reject: (cause: Error) => void = () => undefined
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('hook configuration check ordering', () => {
  it('publishes only the newer result when an older check resolves last', async () => {
    const first = deferred<HookCheckReport>()
    const second = deferred<HookCheckReport>()
    const events: HookCheckEvent[] = []
    let reads = 0
    const runner = createHookCheckRunner(() => ++reads === 1 ? first.promise : second.promise,
      (event) => events.push(event))
    const pendingFirst = runner.run()
    const pendingSecond = runner.run()
    const newer: HookCheckReport = { state: 'failed', checkedAt: '2026-09-24T12:01:00Z', reason: 'Timed out' }
    second.resolve(newer)
    await pendingSecond
    first.resolve({ state: 'failed', checkedAt: '2026-09-24T12:00:00Z', reason: 'Old' })
    await pendingFirst

    expect(events).toEqual([{ kind: 'started' }, { kind: 'started' }, { kind: 'checked', report: newer }])
  })

  it('keeps an older result from replacing a newer failure and cancels on close', async () => {
    const first = deferred<HookCheckReport>()
    const second = deferred<HookCheckReport>()
    const events: HookCheckEvent[] = []
    let reads = 0
    const runner = createHookCheckRunner(() => ++reads === 1 ? first.promise : second.promise,
      (event) => events.push(event))
    const pendingFirst = runner.run()
    const pendingSecond = runner.run()
    second.reject(new Error('Unavailable'))
    await pendingSecond
    first.resolve({ state: 'failed', checkedAt: '2026-09-24T12:00:00Z', reason: 'Old' })
    await pendingFirst
    expect(events.map((event) => event.kind)).toEqual(['started', 'started', 'unavailable'])

    const third = deferred<HookCheckReport>()
    const closedEvents: HookCheckEvent[] = []
    const closing = createHookCheckRunner(() => third.promise, (event) => closedEvents.push(event))
    const pendingThird = closing.run()
    closing.cancel()
    third.resolve({ state: 'failed', checkedAt: '2026-09-24T12:02:00Z', reason: 'After close' })
    await pendingThird
    expect(closedEvents.map((event) => event.kind)).toEqual(['started'])
  })
})
