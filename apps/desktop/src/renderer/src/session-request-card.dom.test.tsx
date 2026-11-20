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

it('shows a request OpenCode opened with its words and retired label, with no choice, Mark answered or answer (Epic 123, recheck A7)', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const now = Date.now()
  const base = { sessionId: 's', incarnationId: 'i', body: null, state: 'open', resolution: null, openedAt: new Date(now).toISOString(),
    expiresAt: null, resolvedAt: null, seenAt: null, revision: 1, openedBy: null, resolvedBy: null } as const
  const options = [{ label: 'JWT', description: null }, { label: 'Session cookies', description: null }]
  const stored: AttentionRecord[] = [
    { ...base, requestId: 'oc-question', requestKey: 'opencode:question', kind: 'question', title: 'OpenCode asks',
      prompt: { type: 'questions', harness: 'opencode', shape: 'choice', requestRef: 'que_1', toolUseId: null,
        questions: [{ id: null, header: null, text: 'Which auth method should the API use?', multiSelect: false, options }] } as unknown as AttentionRecord['prompt'] },
    { ...base, requestId: 'oc-permission', requestKey: 'opencode:permission', kind: 'permission', title: 'OpenCode wants to run a command',
      openedBy: 'hook:opencode:permission.asked',
      prompt: { type: 'permission', harness: 'opencode', shape: 'permission', requestRef: 'per_1', toolUseId: null,
        tool: 'bash', command: 'touch oc-c.txt', cwd: null } as unknown as AttentionRecord['prompt'] }
  ]
  // A Claude question beside them keeps its choices: the positive control.
  const claude: AttentionRecord = { ...base, requestId: 'claude', requestKey: 'claude:question', kind: 'question', title: 'Claude asks',
    prompt: { type: 'questions', harness: 'claude', shape: 'choice', requestRef: 'ref', toolUseId: 'toolu_1',
      questions: [{ id: null, header: 'Auth', text: 'Pick one', multiSelect: false, options }] } as unknown as AttentionRecord['prompt'] }
  const answers: string[] = [], marked: string[] = []
  try {
    await act(async () => root.render(createElement(SessionRequestCard, {
      requests: [...stored, claude], cleared: [], now, anchor: null,
      place: () => ({ workspace: 'Workspace', session: 'Session' }), onAcknowledge: () => {},
      onMarkAnswered: (request: AttentionRecord) => { marked.push(request.requestId) },
      onAnswer: async (request: AttentionRecord) => { answers.push(request.requestId); return { state: 'refused' as const, reason: 'unsupported' as const } },
      onClose: () => {}
    })))
    const article = (id: string): HTMLElement => container.querySelector<HTMLElement>(`article[data-request-id="${id}"]`)!
    const buttons = (id: string): string[] => Array.from(article(id).querySelectorAll('button'), (button) => button.textContent ?? '')
    for (const row of stored) {
      expect(buttons(row.requestId)).toEqual(['Dismiss'])
      // It says what it is: nothing waits for an answer (final recheck).
      expect(article(row.requestId).textContent).toContain('read only')
      expect(article(row.requestId).textContent).not.toContain('awaiting answer')
      expect(article(row.requestId).querySelector('.status-dot.needs-you')).toBeNull()
    }
    expect(article('claude').querySelector('.status-dot.needs-you')).not.toBeNull()
    expect(article('claude').textContent).toContain('awaiting answer')
    expect(article('oc-question').textContent).toContain('Which auth method should the API use?')
    expect(article('oc-question').textContent).toContain('Session cookies')
    expect(article('oc-question').querySelector('.attention-kind')?.textContent).toBe('Question · OpenCode (retired)')
    expect(article('oc-permission').textContent).toContain('touch oc-c.txt')
    expect(article('oc-permission').textContent).toContain('from OpenCode (retired)')
    expect(buttons('claude')).toEqual(expect.arrayContaining(['JWT', 'Session cookies', 'Dismiss']))
    expect(answers).toEqual([]); expect(marked).toEqual([])
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
