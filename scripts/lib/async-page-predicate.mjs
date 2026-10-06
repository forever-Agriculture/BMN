// Playwright's renderer waiter treats a returned Promise as truthy before it
// resolves. Poll asynchronous IPC through evaluate and await the resolved value.
import { setTimeout as delay } from 'node:timers/promises'

export async function waitForAsyncPagePredicate(page, predicate, argument, { timeout = 20000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    let timer
    try {
      const value = await Promise.race([
        page.evaluate(predicate, argument),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Async page predicate timed out')), Math.max(1, deadline - Date.now())) })
      ])
      if (value) return value
    } finally { clearTimeout(timer) }
    await delay(Math.max(0, Math.min(interval, deadline - Date.now())))
  }
  throw new Error('Async page predicate timed out')
}
