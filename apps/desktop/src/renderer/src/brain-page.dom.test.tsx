// @vitest-environment jsdom
// MODULE: brain-page.dom.test.tsx - Epic 128 128.1: the real Brain page mounted on a synthetic read route; opening, search, reading, history and Esc
import type { BrainGraph, BrainPageList, BrainPageNote, BrainPageRequest, BrainPageSearch, BrainPageSummary, BrainPageVersion } from '@bmn/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrainSheet, brainDate, createBrainMemory, noResultWords, startsWithTitle, type BrainMemory } from './brain-page'

let root: Root | undefined
let container: HTMLDivElement | undefined
let requests: BrainPageRequest[] = []
let closed = 0

const AT = '2026-11-16T09:30:00.000Z'
const summary = (id: string, title: string, over: Partial<BrainPageSummary> = {}): BrainPageSummary => ({ id, title, kind: 'fact', status: 'active', changed: AT, summary: `About ${title}.`, ...over })
const note = (id: string, title: string, over: Partial<BrainPageNote> = {}): BrainPageNote => ({
  id, title, kind: 'project', status: 'active', origin: 'import', scope: 'all', changed: AT, recorded: AT, revision: 3,
  markdown: `Text of ${title}. See [[Other]] and [[Nowhere]].`, linksTo: [{ id: 'n2', title: 'Other', kind: 'fact', status: 'active' }],
  linkedFrom: [{ id: 'n3', title: 'Back', kind: 'map', status: 'active' }, { id: 'n4', title: 'Old', kind: 'fact', status: 'archived' }],
  projects: ['~/code/synthetic'], missing: ['Nowhere'], targets: { Other: 'n2', Nowhere: null }, ...over
})
const NOTES: Record<string, BrainPageNote> = { n1: note('n1', 'Backup plan'), n2: note('n2', 'Other', { linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Other text.' }) }

function route(state: 'ready' | 'not-switched' | 'fail' = 'ready', list: BrainPageSummary[] = [summary('n1', 'Backup plan'), summary('n2', 'Other')]) {
  return async <Result,>(request: BrainPageRequest): Promise<Result> => {
    requests.push(request)
    if (state === 'fail') throw new Error('Brain worker exited (1)')
    switch (request.command) {
      case 'status': return { state } as Result
      case 'list': return (request.withdrawn
        ? { notes: [summary('w1', 'Mistake', { status: 'withdrawn' })], total: 1, withdrawn: 1, offset: 0 }
        : { notes: list, total: list.length, withdrawn: 1, offset: 0 }) as BrainPageList as Result
      case 'search': {
        const found = request.query.includes('zzz') || /[\u0400-\u04ff]/u.test(request.query) ? [] : list.slice(0, 1)
        return { notes: found, limited: false } satisfies BrainPageSearch as Result
      }
      case 'read': {
        const found = NOTES[request.id]
        if (!found) throw new Error('Brain note not found')
        return found as Result
      }
      case 'history': return [{ revision: 2, action: 'edit', title: 'Backup plan', kind: 'project', origin: 'agent', status: 'active', recorded: AT, changed: AT, markdown: 'Second.' },
        { revision: 1, action: 'import', title: 'Backup plan', kind: 'project', origin: 'import', status: 'active', recorded: AT, changed: AT, markdown: 'First.' }] satisfies BrainPageVersion[] as Result
      case 'graph': return { focus: request.id, depth: 1, nodes: [{ id: request.id, title: 'Backup plan', kind: 'project', status: 'active', depth: 0, parent: null, links: 0 }], edges: [], more: [0, 0, 0] } satisfies BrainGraph as Result
    }
  }
}

async function mount(memory: BrainMemory = createBrainMemory(), state: 'ready' | 'not-switched' | 'fail' = 'ready'): Promise<void> {
  container = document.createElement('div')
  container.className = 'shell-window'
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(BrainSheet, { memory, read: route(state), onClose: () => { closed += 1 }, reducedMotion: true })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const text = (): string => container!.textContent ?? ''
const press = async (target: Element, key: string, extra: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })) })
  await flush()
}
const type = async (value: string): Promise<void> => {
  const input = container!.querySelector<HTMLInputElement>('.b-search input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/gu, '\\$&') })
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open') }
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  requests = []
  closed = 0
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

describe('Brain page (128.1)', () => {
  it('says why before the switch, and when the brain cannot be read', async () => {
    await mount(createBrainMemory(), 'not-switched')
    expect(text()).toContain('opens after the switch to the BMN brain')
    expect(requests.map((r) => r.command)).toEqual(['status'])
    act(() => root?.unmount())
    container?.remove()
    requests = []
    await mount(createBrainMemory(), 'fail')
    expect(container!.querySelector('[role="alert"]')!.textContent).toContain('The brain could not be read: Brain worker exited (1)')
  })

  it('opens on the list, newest first, with the withdrawn ones folded at its end', async () => {
    await mount()
    expect([...container!.querySelectorAll('.b-list .b-row-title')].map((e) => e.textContent)).toEqual(['Backup plan', 'Other'])
    const fold = container!.querySelector<HTMLButtonElement>('.b-withdrawn .b-fold')!
    expect(fold.textContent).toBe('Withdrawn 1')
    await act(async () => { fold.click() })
    await flush()
    expect(text()).toContain('Mistake')
    expect(requests.some((r) => r.command === 'list' && r.withdrawn === true)).toBe(true)
  })

  it('opens on the note he last read, and on the list when that note is gone', async () => {
    const memory: BrainMemory = { noteId: 'n1', archived: false }
    await mount(memory)
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
    act(() => root?.unmount())
    container?.remove()
    const gone: BrainMemory = { noteId: 'missing', archived: false }
    await mount(gone)
    expect(container!.querySelector('.b-title')).toBeNull()
    expect(gone.noteId).toBeNull()
    expect(container!.querySelectorAll('.b-list .b-row')).toHaveLength(2)
  })

  it('replaces the list with results as he types, opens one with Enter, and says the notes are in English for Cyrillic', async () => {
    await mount()
    await type('backup decision')
    expect(requests.at(-1)).toEqual({ command: 'search', query: 'backup decision', archived: false })
    expect(container!.querySelector('.b-list')!.getAttribute('aria-label')).toBe('Search results')
    await type('zzz qqq')
    expect(text()).toContain('No note has these words. Try one word.')
    await type('бекап')
    expect(text()).toContain('The notes are in English, so try English words.')
    await type('backup')
    await press(container!.querySelector('.b-search input')!, 'Enter')
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
  })

  it('reads a note with its facts and links, offers no change, and Esc steps back before it closes', async () => {
    await mount({ noteId: 'n1', archived: false })
    const side = container!.querySelector('.b-side')!.textContent!
    for (const words of ['Kind', 'Status', 'Origin', 'Scope', 'Last change', 'Version', 'Links to', 'Linked from', 'Projects', 'Not in the brain']) expect(side).toContain(words)
    // The archived back link shows only with Archived on.
    expect(side).not.toContain('Old')
    const buttons = [...container!.querySelectorAll('button')].map((button) => button.textContent!.trim())
    expect(buttons.filter((label) => /^(Edit|New note|Withdraw|Restore|Delete|Save)/u.test(label))).toEqual([])
    // An unresolved name is not a link to anything.
    expect([...container!.querySelectorAll('.ql-md-a[data-target="none"]')].map((e) => [e.textContent, e.getAttribute('title')])).toEqual([['Nowhere', 'No note with this name']])
    const box = container!.querySelector('.b-box')!
    await press(box, 'h')
    expect(container!.querySelector('.b-history')).not.toBeNull()
    expect(text()).toContain('Version 2')
    await press(box, 'Escape')
    expect(container!.querySelector('.b-history')).toBeNull()
    expect(closed).toBe(0)
    await press(box, 'g')
    expect(container!.querySelector('svg.b-graph')).not.toBeNull()
    expect(text()).toContain('No linked notes yet')
    await press(box, 'Escape')
    expect(container!.querySelector('svg.b-graph')).toBeNull()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
  })

  it('follows a link, then goes back and forward with Alt arrows', async () => {
    await mount({ noteId: 'n1', archived: false })
    await act(async () => { container!.querySelector<HTMLElement>('.ql-md-a[data-target="file"]')!.click() })
    await flush()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Other')
    const box = container!.querySelector('.b-box')!
    await press(box, 'ArrowLeft', { altKey: true })
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
    await press(box, 'ArrowRight', { altKey: true })
    expect(container!.querySelector('.b-title')!.textContent).toBe('Other')
  })

  it('keeps the Archived toggle between openings and sends it with every read', async () => {
    const memory = createBrainMemory()
    await mount(memory)
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-toggle')!.click() })
    await flush()
    expect(memory.archived).toBe(true)
    expect(container!.querySelector('.b-toggle')!.getAttribute('aria-pressed')).toBe('true')
    expect(requests.filter((r) => r.command === 'list').at(-1)).toMatchObject({ archived: true })
  })
})

describe('Brain page words', () => {
  it('formats dates, the nothing-found line and a note that opens with its own title', () => {
    expect(brainDate(AT, new Date('2026-12-01T00:00:00Z'))).toBe('16 Nov')
    expect(brainDate(AT, new Date('2027-01-01T00:00:00Z'))).toBe('16 Nov 2026')
    expect(noResultWords('backup')).toBe('No note has these words. Try one word.')
    expect(noResultWords('бекап')).toContain('in English')
    expect(startsWithTitle({ title: 'Backup plan', markdown: '# Backup plan\n\ntext' })).toBe(true)
    expect(startsWithTitle({ title: 'Backup plan', markdown: 'text\n# Backup plan' })).toBe(false)
  })
})
