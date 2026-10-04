import { expect, it, vi } from 'vitest'
import { waitForAsyncPagePredicate } from '../lib/async-page-predicate.mjs'

it('retries resolved false and returns the eventual session object', async () => {
  let calls = 0
  const session = { sessionId: 'synthetic-session' }
  const page = { evaluate: vi.fn(async (predicate, argument) => predicate(argument)) }
  expect(await waitForAsyncPagePredicate(page, async value => ++calls < 3 ? false : value, session, { interval: 0 }))
    .toBe(session)
  expect(page.evaluate).toHaveBeenCalledTimes(3)
})

it('bounds an IPC evaluation that never settles', async () => {
  await expect(waitForAsyncPagePredicate({ evaluate: () => new Promise(() => {}) }, () => true, undefined, { timeout: 10 }))
    .rejects.toThrow('Async page predicate timed out')
})

it('surfaces evaluation errors instead of reporting readiness', async () => {
  await expect(waitForAsyncPagePredicate({ evaluate: async () => { throw new Error('synthetic IPC failure') } }, () => true))
    .rejects.toThrow('synthetic IPC failure')
})
