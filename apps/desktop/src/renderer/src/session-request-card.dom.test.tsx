// @vitest-environment jsdom
// MODULE: session-request-card.dom.test.tsx - opening a specific waiting card focuses its own enabled action
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AttentionRecord } from '@bmn/protocol'
import { SessionRequestCard } from './session-request-card'

it('focuses the targeted request rather than Close or another request, including an already-open card', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const now = Date.now()
  const request = (id: string): AttentionRecord => ({ requestId: id, requestKey: id, sessionId: 's', incarnationId: 'i',
    kind: 'question', title: id, body: null, state: 'open', resolution: null, openedAt: new Date(now).toISOString(),
    expiresAt: null, resolvedAt: null, seenAt: null, revision: 1, openedBy: null, resolvedBy: null, prompt: null })
  const render = (focusRequestId: string): void => root.render(createElement(SessionRequestCard, {
    requests: [request('first'), request('second')], cleared: [], now, anchor: null, focusRequestId,
    place: () => ({ workspace: 'Workspace', session: 'Session' }), onAcknowledge: () => {}, onMarkAnswered: () => {}, onClose: () => {}
  }))
  try {
    await act(async () => render('second'))
    expect(document.activeElement?.closest<HTMLElement>('article')?.dataset.requestId).toBe('second')
    expect(document.activeElement?.textContent).toBe('Dismiss')
    await act(async () => render('first'))
    expect(document.activeElement?.closest<HTMLElement>('article')?.dataset.requestId).toBe('first')
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
