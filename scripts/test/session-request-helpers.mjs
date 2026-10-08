/* global window */
// Address a request's actual session; navigation may retain a cleared notice snapshot.
export async function sessionRequestControl(page, sessionId) {
  if (!sessionId) {
    const selected = await page.locator('.session-row.selected button[data-session-id]').getAttribute('data-session-id').catch(() => null)
    const requests = await page.evaluate(() => window.aiTerminal.listAttention())
    sessionId = requests.find(request => request.state === 'open' && request.sessionId === selected)?.sessionId
      ?? requests.find(request => request.state === 'open')?.sessionId ?? selected
  }
  if (!sessionId) throw new Error('No session with requests')
  const control = page.locator(`[data-session-requests="${sessionId}"]`)
  if (!await control.isVisible()) {
    await page.locator(`.session-row button[data-session-id="${sessionId}"]`).click()
  }
  await control.waitFor()
  return control
}

export async function toggleSessionRequests(page, sessionId) {
  const close = page.getByRole('button', { name: 'Close session requests', exact: true })
  if (await close.count()) await close.click()
  else await (await sessionRequestControl(page, sessionId)).click()
}

/** Playwright's waitForFunction does not poll async predicates; await each bridge result within one deadline. */
export async function waitForAsyncState(page, predicate, arg, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout
  const timeoutError = () => new Error(`Async renderer state timed out after ${timeout} ms`)
  while (Date.now() < deadline) {
    let timer
    const remaining = deadline - Date.now()
    const value = await Promise.race([
      page.evaluate(predicate, arg),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining) })
    ]).finally(() => clearTimeout(timer))
    if (value) return value
    const delay = Math.min(25, deadline - Date.now())
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw timeoutError()
}
