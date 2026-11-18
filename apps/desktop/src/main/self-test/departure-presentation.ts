// MODULE: departure-presentation.ts - two real windows, actual modal shows and a delayed Open reply
import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { DEPARTURE_AUTO_MS, ERROR_CODES, METHOD_REGISTRY, ownerGrantView, type OwnerAwayView, type OwnerDepartureReply, type OwnerGrantView } from '@bmn/protocol'
import type { PtyHostClient } from '../pty-host-client'

/** Unmaps and maps the window again: the one focus handoff GNOME on Wayland grants between two open windows. */
export async function refocusWindow(window: BrowserWindow): Promise<void> {
  window.hide()
  await new Promise(resolve => setTimeout(resolve, 100))
  window.show()
  window.focus()
}

export async function checkDeparturePresentation(client: PtyHostClient, first: BrowserWindow, second: BrowserWindow, cli: (args: string[]) => string) {
  const renderer = <T>(window: BrowserWindow, code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const grant = () => originalRequest<OwnerGrantView>(METHOD_REGISTRY.grantGet, {})
  const until = async (condition: () => Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(`Departure presentation: ${label}`)
  }
  const modal = (window: BrowserWindow) => renderer<{ opens: number; focus: boolean; open: boolean; passive: boolean }>(window, `({
    opens: window.departureTestShows, focus: document.hasFocus(),
    open: Boolean(document.querySelector('dialog.before-you-go-dialog[open]')),
    passive: document.activeElement?.classList.contains('grant-list') === true
  })`)
  const focus = async (window: BrowserWindow, other: BrowserWindow): Promise<void> => {
    const focused = async () => BrowserWindow.getFocusedWindow() === window && window.isFocused() && !other.isFocused() &&
      (await modal(window)).focus && !(await modal(other)).focus
    window.show()
    window.focus()
    try {
      await until(focused, `focus preflight for window ${window.id}`, 1_000)
    } catch {
      // GNOME on Wayland refuses focus() for a window that is already mapped; a window mapped
      // anew is given focus, so hand it over the way the first preflight does.
      await refocusWindow(window)
      await until(focused, `focus preflight for window ${window.id}`)
    }
  }
  const start = async () => {
    assert.match(cli(['away', '--leaving']), /^Leaving since /)
    const current = (await grant()).period
    assert.ok(current?.state === 'leaving' && current.collection)
    return { periodId: current.periodId, collection: current.collection }
  }
  const cancel = async (window: BrowserWindow): Promise<void> => {
    const before = await grant()
    assert.equal(before.period?.state, 'leaving')
    const input = {
      action: 'cancel', periodId: before.period!.periodId, expectedRevision: before.revision,
      operationKey: `presentation-self-test-cancel:${before.period!.periodId}`
    }
    const reply = await renderer<OwnerDepartureReply>(window, `window.aiTerminal.departure(${JSON.stringify(input)})`)
    assert.equal(reply.outcome, 'changed', reply.detail ?? 'cancel accepted')
    assert.equal(reply.view.period?.periodId, before.period!.periodId)
    assert.equal(reply.view.period?.state, 'cancelled')
  }
  const sameDeparture = (window: BrowserWindow) =>
    renderer<boolean>(window, `document.querySelector('#away-check-box')?.getAttribute('aria-label') === 'Away; open Before you go'`)
  const releaseOpen = Promise.withResolvers<void>()
  const releaseRead = Promise.withResolvers<void>()
  const unknown = ownerGrantView({ state: 'unknown', reason: 'Synthetic unreadable record' })
  let holdRead = false
  let heldRead: OwnerGrantView | null = null
  let returnedRead = false
  let faultPeriod: string | null = null
  let unreadableReads = 0
  let faultActive = false
  const refreshFirst = () => first.webContents.send('aiterm:app-event', { kind: 'app-event', topic: 'grant', sessionId: null })
  const frame = () => renderer(first, `(async () => {
    await window.aiTerminal.getAway();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`)
  let delayedPeriod: string | null = null
  let heldOpen: OwnerDepartureReply | null = null
  let returnedOpen = false
  const ledger: { periodId: string; operationKey: string; outcome: OwnerDepartureReply['outcome'] | null }[] = []
  const originalRequest = client.request.bind(client)

  for (const window of [first, second]) {
    await renderer(window, `(() => {
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      const original = HTMLDialogElement.prototype.showModal;
      window.departureTestShows = 0;
      HTMLDialogElement.prototype.showModal = function () {
        original.call(this);
        if (this.classList.contains('before-you-go-dialog')) window.departureTestShows++;
      };
    })()`)
  }

  try {
    // The preceding Away step ends with a Back whose morning summary each window may open late;
    // an open summary covers Before you go, so wait for it and close it in both windows first.
    const away = await originalRequest<OwnerAwayView>(METHOD_REGISTRY.awayGet, {})
    if (away.state === 'back' && away.periodId !== null && away.summaryShownAt === null) {
      // The summary opens by itself only in a window that has focus. A smoke started by the update
      // service gets none on its own, so hand it to the first window before waiting.
      await focus(first, second)
      await until(async () => (await originalRequest<OwnerAwayView>(METHOD_REGISTRY.awayGet, {})).summaryShownAt !== null,
        'the previous morning summary was presented')
    }
    const previousSummaryClose = 'dialog.away-summary-dialog[open] button[aria-label="Close While you were away"]'
    const noDialog = async () => {
      for (const window of [first, second]) await renderer(window, `document.querySelector(${JSON.stringify(previousSummaryClose)})?.click()`)
      return (await Promise.all([first, second].map(window => renderer<boolean>(window, `document.querySelector('dialog[open]') === null`))))
        .every(Boolean)
    }
    // Twice, apart: a window still holding the older away view can open the summary just after the first check.
    await until(noDialog, 'no dialog is open before the presentation check')
    await new Promise(resolve => setTimeout(resolve, 300))
    await until(noDialog, 'no dialog reopened before the presentation check')
    // Check focus both ways before any departure or receipt can be recorded.
    await focus(first, second)
    await focus(second, first)
    client.request = (async (method, params) => {
      const input = params as { action?: string; periodId?: string; operationKey?: string }
      if (method === METHOD_REGISTRY.grantGet) {
        if (holdRead) {
          holdRead = false
          const reply = await originalRequest<OwnerGrantView>(method, params)
          heldRead = reply
          await releaseRead.promise
          returnedRead = true
          return reply
        }
        if (faultActive) { unreadableReads++; return unknown }
      }
      if (method !== METHOD_REGISTRY.grantDeparture) return originalRequest(method, params)
      if (input.action === 'go' && input.periodId === faultPeriod && !faultActive && unreadableReads === 0) {
        faultActive = true
        const away = await originalRequest<OwnerAwayView>(METHOD_REGISTRY.awayGet, {})
        return { outcome: 'unknown', view: unknown, away, detail: null } satisfies OwnerDepartureReply
      }
      if (input.action === 'open' && input.periodId === delayedPeriod) {
        const reply = await originalRequest<OwnerDepartureReply>(method, params)
        if (reply.outcome === 'changed') {
          heldOpen = reply
          await releaseOpen.promise
          returnedOpen = true
        }
        return reply
      }
      if (input.action !== 'presented') return originalRequest(method, params)
      assert.ok(input.periodId && input.operationKey)
      const row: (typeof ledger)[number] = { periodId: input.periodId, operationKey: input.operationKey, outcome: null }
      ledger.push(row)
      const reply = await originalRequest<OwnerDepartureReply>(method, params)
      row.outcome = reply.outcome
      return reply
    }) as typeof client.request

    const automatic = await start()
    await until(() => sameDeparture(first), 'unfocused window updates to getting ready', 1_000)
    await until(async () => ledger.some(row => row.periodId === automatic.periodId && row.outcome === 'changed'), 'automatic receipt saved')
    assert.deepEqual(await modal(second), { opens: 1, open: true, focus: true, passive: true })
    assert.equal((await modal(first)).opens, 0)
    assert.equal((await grant()).period!.collection!.autoAwayAt, automatic.collection.autoAwayAt)
    assert.equal(Date.parse(automatic.collection.autoAwayAt) - Date.parse(automatic.collection.selectedAt), DEPARTURE_AUTO_MS)
    await cancel(second)
    await renderer(second, `document.querySelector('dialog.before-you-go-dialog button[aria-label="Close Before you go"]').click()`)
    await until(async () => !(await modal(second)).open, 'dismiss the cancelled automatic modal')

    await focus(first, second)
    await renderer(first, `document.querySelector('button[aria-label="Command palette"]').click()`)
    const old = await start()
    delayedPeriod = old.periodId
    await until(() => renderer(first, `Boolean(document.querySelector('#palette-before-you-go'))`), 'manual open is available from palette')
    const view = await grant()
    const ordinary = { action: 'presented', periodId: old.periodId, expectedRevision: view.revision, operationKey: 'synthetic-receipt-test' }
    const rejection = await renderer<{ name: string; code: string; message: string } | null>(second,
      `window.aiTerminal.departure(${JSON.stringify(ordinary)}).then(() => null, ({ name, code, message }) => ({ name, code, message }))`)
    assert.deepEqual(rejection, { name: 'BridgeError', code: ERROR_CODES.invalidArgument, message: 'A desktop presentation requires its show receipt' })
    assert.equal((await grant()).period!.collection!.presentedAt, null)
    await renderer(first, `document.querySelector('#palette-before-you-go').click()`)
    await until(async () => heldOpen !== null && ledger.some(row => row.periodId === old.periodId && row.outcome === 'changed'),
      'manual A shown and its completed Open reply held')
    assert.deepEqual(await modal(first), { opens: 1, open: true, focus: true, passive: true })
    const delayed = heldOpen as OwnerDepartureReply | null
    assert.ok(delayed?.view.period?.collection)
    assert.equal(delayed.view.period.periodId, old.periodId)
    assert.ok(Date.parse(delayed.view.period.collection.autoAwayAt) > Date.parse(old.collection.autoAwayAt))

    holdRead = true
    refreshFirst()
    await until(async () => (heldRead as OwnerGrantView | null)?.period?.periodId === old.periodId, 'old actual event read held in flight')

    await cancel(second)
    await until(async () => !await sameDeparture(second), 'second window observed the cancellation', 1_000)
    const next = await start()
    await until(() => sameDeparture(second), 'unfocused second window updates for B', 1_000)
    await until(async () => ledger.some(row => row.periodId === next.periodId && row.outcome === 'changed'), 'B actually shown and acknowledged in the focused window')
    const before = await grant()
    assert.equal(before.period?.periodId, next.periodId)
    const collection = before.period?.collection
    assert.ok(collection?.presentedAt)
    assert.deepEqual(await modal(first), { opens: 2, open: true, focus: true, passive: true })
    assert.equal((await modal(second)).opens, 1)
    assert.equal(collection.autoAwayAt, next.collection.autoAwayAt)
    assert.equal(Date.parse(collection.autoAwayAt) - Date.parse(collection.selectedAt), DEPARTURE_AUTO_MS)
    await renderer(first, `(() => {
      const current = document.querySelector('dialog.before-you-go-dialog[open]');
      window.departureTestCurrent = current;
      window.departureTestCurrentCloses = 0;
      current.addEventListener('close', () => { window.departureTestCurrentCloses++; });
    })()`)

    releaseOpen.resolve()
    await until(async () => returnedOpen, 'completed old Open reply returned')
    await renderer(first, `(async () => {
      await window.aiTerminal.getGrant();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`)
    assert.equal(await renderer<boolean>(first, `document.querySelector('dialog.before-you-go-dialog[open]') === window.departureTestCurrent`),
      true, 'B still open after delayed A reply')
    assert.deepEqual(await modal(first), { opens: 2, open: true, focus: true, passive: true })
    assert.equal(await renderer<number>(first, 'window.departureTestCurrentCloses'), 0, 'B did not close after delayed A reply')
    assert.equal(ledger.filter(row => row.periodId === next.periodId).length, 1)
    assert.equal((await grant()).period!.collection!.presentedAt, collection.presentedAt)
    assert.equal((await grant()).period!.collection!.autoAwayAt, collection.autoAwayAt)
    faultPeriod = next.periodId
    await renderer(first, `document.querySelector('dialog.before-you-go-dialog .grant-go').click()`)
    await until(async () => unreadableReads > 0, 'a current Go returned unknown and a recovery read also returned unknown')
    await frame()
    const sameNode = () => renderer<boolean>(first, `document.querySelector('dialog.before-you-go-dialog[open]') === window.departureTestCurrent`)
    assert.equal(await sameNode(), true, 'B still open after the unreadable read')
    assert.equal(await renderer<number>(first, 'window.departureTestCurrentCloses'), 0, 'the same B node never closed')
    const disabled = () => renderer<boolean>(first, `
      document.querySelector('dialog.before-you-go-dialog .grant-go')?.getAttribute('aria-disabled') === 'true' &&
      document.querySelector('dialog.before-you-go-dialog [role="alert"]')?.textContent.includes('Grant records could not be read') === true
    `)
    assert.ok(await disabled(), 'B announces unreadability and Go is disabled')
    assert.deepEqual(await modal(first), { opens: 2, open: true, focus: true, passive: true })
    assert.equal((await grant()).period?.collection?.autoAwayAt, collection.autoAwayAt)
    releaseRead.resolve()
    await until(async () => returnedRead, 'the held earlier event read returned')
    await frame()
    assert.ok(await sameNode() && await disabled(), 'late A read cannot replace B or clear unreadability')
    assert.equal(ledger.filter(row => row.periodId === next.periodId).length, 1)
    assert.equal((await grant()).period?.collection?.presentedAt, collection.presentedAt)

    faultActive = false
    refreshFirst()
    await until(async () => await sameNode() && !await disabled(), 'a fresh read restores the same B without reopening')
    const pressedGoAt = Date.now()
    await renderer(first, `document.querySelector('dialog.before-you-go-dialog .grant-go').click()`)
    await until(async () => !(await modal(first)).open &&
      await renderer<boolean>(second, `document.querySelector('#away-check-box')?.checked === true`),
      'recovered B Go reaches the second window', 1_000)
    const recoveredGoSyncMs = Date.now() - pressedGoAt
    assert.equal((await modal(second)).opens, 1)
    assert.equal((await grant()).period?.state, 'away')
    cli(['back'])
    const summaryClose = 'dialog.away-summary-dialog[open] button[aria-label="Close While you were away"]'
    await until(async () => (await originalRequest<OwnerAwayView>(METHOD_REGISTRY.awayGet, {})).summaryShownAt !== null,
      'the morning summary presentation was saved')
    await renderer(first, `document.querySelector(${JSON.stringify(summaryClose)})?.click()`)
    await until(async () => !await renderer<boolean>(first, `Boolean(document.querySelector(${JSON.stringify(summaryClose)}))`),
      'dismiss the confirmed morning summary')
    second.hide()
    return { ledger, returnedOpen, returnedRead, unreadableReads, recoveredGoSyncMs, first: await modal(first), second: await modal(second) }
  } catch (error) {
    const shown = (window: BrowserWindow) => renderer(window, `({
      openDialogs: Array.from(document.querySelectorAll('dialog[open]'), dialog => dialog.getAttribute('aria-label')),
      awayBox: document.querySelector('#away-check-box')?.getAttribute('aria-label')
    })`).catch(() => null)
    const current = await grant().catch(() => null)
    console.error('[BMN] departure presentation diagnostic', JSON.stringify({
      ledger, returnedOpen, returnedRead, unreadableReads, delayedPeriod, faultPeriod, focusWindow: BrowserWindow.getFocusedWindow()?.id,
      first: { modal: await modal(first), view: await shown(first) },
      second: { modal: await modal(second), view: await shown(second) },
      current: current === null ? null : { revision: current.revision,
        periodId: current.period?.periodId, presentedAt: current.period?.collection?.presentedAt }
    }))
    throw error
  } finally {
    releaseOpen.resolve()
    releaseRead.resolve()
    client.request = originalRequest
  }
}
