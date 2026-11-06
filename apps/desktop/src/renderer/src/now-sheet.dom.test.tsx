// @vitest-environment jsdom
// MODULE: now-sheet.dom.test.tsx - Story 110.9 AC6: the real Now sheet mounted, a refresh never moves a row under him or loses the focus
import { buildNow, type DevAutoRun, type DevAutoRunsResult, type NowSessionInput } from '@bmn/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NowSheet, createNowMemory, type NowMemory } from './now-sheet'

let root: Root | undefined
let container: HTMLDivElement | undefined
let bridge: PropertyDescriptor | undefined
let reads: Array<(result: DevAutoRunsResult) => void> = []
let appEvent: ((message: { topic: string; sessionId: string | null }) => void) | null = null

const NOW = new Date()
const AT = NOW.toISOString()
const WORKSPACES = [{ workspaceId: 'wq', name: 'Q' }, { workspaceId: 'wp', name: 'Pet' }]

function session(id: string, workspaceId: string, over: Partial<NowSessionInput> = {}): NowSessionInput {
  return { sessionId: id, workspaceId, name: id, dot: 'running', live: true, started: true, agent: true, working: true,
    progressLabel: null, title: null, card: null, ...over }
}
function run(over: Partial<DevAutoRun>): DevAutoRun {
  return { workspaceIds: ['wp'], checkout: `/r/${over.sessionId ?? 'x'}`, branch: 'dev-auto/epic', project: null, status: 'ACTIVE', nextAction: null,
    decisions: [], runId: null, decisionEntries: [], omittedDecisions: 0, finished: false, updatedAt: null, ownership: 'own', ownerCheckout: null,
    ownerBranch: null, unavailable: null, board: { checkout: null, unavailable: null, rows: [{ key: '128-1-one', status: 'done', comment: '' },
      { key: '128-2-photo-upload', status: 'in-progress', comment: '' }] }, ownerItems: [], waitingOn: null, finishedStories: [],
    skippedFinishedStories: 0, leadConversations: [], sessionId: null, sessionLink: null, ...over }
}
const result = (runs: DevAutoRun[]): DevAutoRunsResult => ({ runs, skipped: 0, issues: [], observedAt: AT })

const SESSIONS = [
  session('a', 'wq'), session('b', 'wq'), session('c', 'wq'),
  session('p', 'wp', { live: false, dot: 'exited' }), session('d', 'wp')
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom has no CSS.escape; the keys here need only quotes and backslashes escaped.
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/gu, '\\$&') })
  bridge = Object.getOwnPropertyDescriptor(window, 'aiTerminal')
  reads = []
  appEvent = null
  // jsdom has no modal dialogs; the sheet only needs `open` set and `close` to clear it.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open') }
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  Object.defineProperty(window, 'aiTerminal', {
    configurable: true,
    value: {
      readDevAutoRuns: () => new Promise<DevAutoRunsResult>((resolve) => { reads.push(resolve) }),
      writeClipboardText: async () => ({ written: true }),
      onAppEvent: (listener: typeof appEvent) => { appEvent = listener; return () => { appEvent = null } }
    }
  })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  container = undefined
  if (bridge) Object.defineProperty(window, 'aiTerminal', bridge)
  else Reflect.deleteProperty(window, 'aiTerminal')
  vi.unstubAllGlobals()
})

async function mount(memory: NowMemory, sessions: NowSessionInput[] = SESSIONS): Promise<(next: NowSessionInput[]) => Promise<void>> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const render = (list: NowSessionInput[]) => root!.render(createElement(NowSheet, { workspaces: WORKSPACES, sessions: list, home: null,
    currentSessionId: null, memory, onOpenRow: () => undefined, onClose: () => undefined }))
  await act(async () => render(sessions))
  return async (next) => { await act(async () => render(next)) }
}
/** Answers the oldest pending read of the runs. */
async function answer(runs: DevAutoRun[]): Promise<void> {
  await act(async () => { reads.shift()!(result(runs)); await Promise.resolve() })
}
/** BMN says a card changed: the sheet reads the runs again. */
async function cardChanged(): Promise<void> {
  await act(async () => { appEvent?.({ topic: 'attention', sessionId: null }); await Promise.resolve() })
}
const rows = (): string[] => [...container!.querySelectorAll<HTMLElement>('.n-main')].map((button) => button.dataset.key!)
const sectionOf = (key: string): string | null =>
  container!.querySelector(`.n-main[data-key="${key}"]`)?.closest('section')?.querySelector('.n-sec span')?.textContent ?? null
const focused = (): string | null => (document.activeElement as HTMLElement | null)?.dataset?.key ?? document.activeElement?.tagName ?? null
const button = (key: string): HTMLElement => container!.querySelector<HTMLElement>(`.n-main[data-key="${key}"]`)!
const key = async (name: string): Promise<void> => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
}

describe('the mounted Now sheet: a refresh keeps rows and focus (Story 110.9 AC6)', () => {
  it('reopened on a remembered unfinished run, a read that finished it keeps the row and the focus where they are', async () => {
    const stopped = run({ sessionId: 'p' })
    const memory = { ...createNowMemory(), key: 's:p', notRunningOpen: true, result: result([stopped]) }
    await mount(memory)
    expect(sectionOf('s:p')).toBe('Pet')
    expect(focused()).toBe('s:p')
    const before = rows()
    await answer([{ ...stopped, finished: true, status: 'COMPLETE' }])
    // Built alone, the row now belongs under Not running; held from the remembered placement, it stays put.
    expect(buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: [{ ...stopped, finished: true }] })
      .rows.find((row) => row.key === 's:p')?.section).toBe('not-running')
    expect(sectionOf('s:p')).toBe('Pet')
    expect(rows()).toEqual(before)
    expect(focused()).toBe('s:p')
  })

  it('a row that moves section on the first read takes the focus with it', async () => {
    // Nothing read yet: the stopped session rests under Not running (open), and has the focus.
    const memory = { ...createNowMemory(), key: 's:p', notRunningOpen: true }
    await mount(memory)
    expect(sectionOf('s:p')).toBe('Not running')
    expect(focused()).toBe('s:p')
    await answer([run({ sessionId: 'p' })])
    expect(sectionOf('s:p')).toBe('Pet')
    expect(focused()).toBe('s:p')
  })

  it('a delayed read changes nothing he moved to meanwhile', async () => {
    await mount(createNowMemory())
    expect(focused()).toBe('s:a')
    await key('ArrowDown'); await key('ArrowDown')
    expect(focused()).toBe('s:c')
    await answer([run({ sessionId: 'p' })])
    expect(focused()).toBe('s:c')
    expect(rows().slice(0, 3)).toEqual(['s:a', 's:b', 's:c'])
  })

  it('a new card on a shown row leaves it where it is while he is in the list, then it joins Waits on you', async () => {
    const rerender = await mount(createNowMemory())
    await answer([])
    await key('ArrowDown')
    expect(focused()).toBe('s:b')
    const before = rows()
    const carded = SESSIONS.map((item) => item.sessionId === 'c' ? { ...item, dot: 'needs-you' as const, card: { requestId: 'k', title: 'pick one' } } : item)
    await rerender(carded)
    await cardChanged(); await answer([])
    expect(rows()).toEqual(before)
    expect(sectionOf('s:c')).toBe('Q')
    expect(focused()).toBe('s:b')
    // Out of the list (Tab to Copy standup), every row takes its own place.
    await act(async () => { container!.querySelector<HTMLElement>('.plate')!.focus() })
    expect(sectionOf('s:c')).toBe('Waits on you')
    expect(rows()[0]).toBe('s:c')
  })

  it('a new row that waits on him comes after every shown row, never above the one he is on', async () => {
    const rerender = await mount(createNowMemory())
    await answer([])
    await key('ArrowDown')
    const before = rows()
    await rerender([...SESSIONS, session('n', 'wq', { dot: 'needs-you', card: { requestId: 'n1', title: 'approve' } })])
    expect(rows()).toEqual([...before, 's:n'])
    expect(rows().indexOf('s:b')).toBe(1)
    expect(focused()).toBe('s:b')
    expect(sectionOf('s:n')).toBe('Waits on you')
  })

  it('a refresh never pulls focus back after he left the list on purpose, and a quick return keeps it', async () => {
    const rerender = await mount(createNowMemory())
    await answer([])
    expect(focused()).toBe('s:a')
    // He clicks outside any control: focus goes to the body; the row is still there.
    await act(async () => { button('s:a').blur(); await Promise.resolve() })
    expect(focused()).toBe('BODY')
    const carded = SESSIONS.map((item) => item.sessionId === 'a' ? { ...item, dot: 'needs-you' as const, card: { requestId: 'k', title: 'pick one' } } : item)
    await rerender(carded)
    await cardChanged(); await answer([])
    expect(focused()).toBe('BODY')
    // Leaving and coming straight back before the deferred check keeps the sheet holding its rows for him.
    await act(async () => { button('s:b').focus() })
    await act(async () => { button('s:b').blur(); button('s:b').focus(); await Promise.resolve() })
    expect(focused()).toBe('s:b')
    await rerender(SESSIONS)
    expect(focused()).toBe('s:b')
  })

  it('a focused row that goes hands the focus to the next one', async () => {
    const rerender = await mount(createNowMemory())
    await answer([])
    await key('ArrowDown')
    expect(focused()).toBe('s:b')
    await rerender(SESSIONS.filter((item) => item.sessionId !== 'b'))
    expect(focused()).toBe('s:c')
    expect(button('s:c').tabIndex).toBe(0)
  })
})
