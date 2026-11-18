// @vitest-environment jsdom
// MODULE: epic130-desktop-offer-probe.dom.test.tsx - independently fence the displayed repeat proposal against the actual outgoing desktop answer
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BeforeYouGoDialog } from './before-you-go-dialog'
import { EMPTY_GRANT_RECORD, askGrant, newDepartureCollection, ownerGrantView, selectDepartureSessions, startDeparture } from '@bmn/protocol'
it('All as proposed submits the repeat choice displayed to the owner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    const at = '2026-11-17T19:00:00.000Z', term = { id: 'rounds' as const, kind: 'rounds' as const, proposed: 3, reason: 'Synthetic review' }
    const collection = newDepartureCollection(selectDepartureSessions([{ sessionId: 's', incarnationId: 'i', name: 'Synthetic', agent: 'claude', lastEventAt: at }], at), at)
    let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'repeat-probe', collection }, 'back', at).record
    record = askGrant(record, { runId: 'repeat', sessionId: 's', agentCli: 'claude', card: { title: 'Synthetic repeat', scope: 'Same synthetic scope', nothing: false, terms: [term] } }, at).record
    record.offers = [{ runId: 'repeat', title: 'Synthetic repeat', endedAt: '2026-11-17T18:30:00.000Z', answer: { cardRevision: 1, terms: [term], choices: { rounds: 2 }, at: '2026-11-17T18:00:00.000Z', via: 'app', operationKey: 'earlier-explicit-answer' } }]
    const save = vi.fn(async (answer: { choices: Record<string, unknown> }) => { expect(answer.choices).toBeDefined(); return { outcome: 'granted' as const } })
    await act(async () => root.render(createElement(BeforeYouGoDialog, { grant: ownerGrantView({ state: 'read', record }), now: new Date(at), place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }), sessionName: () => 'Synthetic', onAnswer: save, onAwayNow: vi.fn(), onNotLeaving: vi.fn(), onClose: vi.fn() })))
    expect(container.querySelector('.grant-term-reason')!.textContent).toMatch(/As you granted.*· 2 · not granted/)
    await act(async () => container.querySelector<HTMLButtonElement>('.actions button')!.click())
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0]![0].choices).toEqual({ rounds: 2 })
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
