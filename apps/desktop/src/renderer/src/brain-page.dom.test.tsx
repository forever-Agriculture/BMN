// @vitest-environment jsdom
// MODULE: brain-page.dom.test.tsx - Epic 128 128.1: the real Brain page mounted on a synthetic read route; opening, search, reading, history and Esc
import type { BrainGraph, BrainMap, BrainPageList, BrainPageNote, BrainPageRequest, BrainPageSearch, BrainPageSummary, BrainPageVersion } from '@bmn/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrainSheet, brainDate, createBrainMemory, noResultWords, startsWithTitle, withoutModuleHeading, type BrainMemory } from './brain-page'

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
const NOTES: Record<string, BrainPageNote> = {
  n1: note('n1', 'Backup plan'), n2: note('n2', 'Other', { linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Other text.' }),
  s1: note('s1', 'Keys', { linksTo: [{ id: 'n2', title: 'Other', kind: 'fact', status: 'active' }], linkedFrom: [], missing: [], targets: { Other: 'n2' },
    markdown: 'The key is AKIAABCDEFGHIJKLMNOP.\r\nSee [[Other]].' }),
  o2: note('o2', 'Other', { linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Another key AKIAZYXWVUTSRQPONMLK here.' }),
  h1: note('h1', 'Hidden link', { linksTo: [], linkedFrom: [], missing: [], targets: { Old: 'n4' }, markdown: 'See [[Old]].' }),
  m1: note('m1', 'keeper-note', { linksTo: [], linkedFrom: [], missing: [], targets: {},
    markdown: 'Source: Claude memory `synthetic/keeper-note.md`.\n\nSummary: "Short rule."\n\n# MODULE: keeper-note.md - a file header\n\nThe rule itself.' }),
  w1: note('w1', 'Mistake', { status: 'withdrawn', linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Withdrawn text.' })
}
const WITHDRAWN = Array.from({ length: 101 }, (_, i) => summary(i ? `w${i + 1}` : 'w1', i ? `Withdrawn ${i}` : 'Mistake', { status: 'withdrawn' }))

/** Answers held back until released, for the late-reply cases; empty means every answer comes at once. */
let held: ((request: BrainPageRequest) => boolean) | null = null
let release: (() => void)[] = []
let LIST = [summary('n1', 'Backup plan'), summary('n2', 'Other')]
let FOUND: BrainPageSummary[] | null = null
let PAIRED = false
let GRAPH_FAILS = false
let READ_FAILS = new Set<string>()
let HISTORY_TEXT = 'Second.'
function route(state: 'ready' | 'not-switched' | 'fail' = 'ready', list?: BrainPageSummary[]) {
  return async <Result,>(request: BrainPageRequest): Promise<Result> => {
    requests.push(request)
    if (held?.(request)) await new Promise<void>((resolve) => release.push(resolve))
    list = list ?? LIST
    if (state === 'fail') throw new Error('Brain worker exited (1)')
    switch (request.command) {
      case 'status': return { state } as Result
      case 'list': return (request.withdrawn
        ? { notes: WITHDRAWN.slice(request.offset ?? 0, (request.offset ?? 0) + 100), total: WITHDRAWN.length, withdrawn: WITHDRAWN.length, offset: request.offset ?? 0 }
        : { notes: list.slice(request.offset ?? 0, (request.offset ?? 0) + 100), total: list.length, withdrawn: WITHDRAWN.length, offset: request.offset ?? 0 }) as BrainPageList as Result
      case 'search': {
        const found = FOUND ?? (request.query.includes('zzz') || /[\u0400-\u04ff]/u.test(request.query) ? [] : list.slice(0, 1))
        return { notes: found, limited: false } satisfies BrainPageSearch as Result
      }
      case 'read': {
        if (READ_FAILS.has(request.id)) throw new Error('Brain worker exited (1)')
        const found = request.id === 'n2' && NOTES.o2 && requests.some((r) => r.command === 'read' && r.id === 's1') ? NOTES.o2 : NOTES[request.id]
        if (!found) throw new Error('Brain note not found')
        return found as Result
      }
      case 'history': return [{ revision: 2, action: 'edit', title: 'Backup plan', kind: 'project', origin: 'agent', status: 'active', recorded: AT, changed: AT, markdown: HISTORY_TEXT },
        { revision: 1, action: 'import', title: 'Backup plan', kind: 'project', origin: 'import', status: 'active', recorded: AT, changed: AT, markdown: 'First.' }] satisfies BrainPageVersion[] as Result
      case 'graph': {
        if (GRAPH_FAILS) throw new Error('This note is not shown in the graph')
        if (!PAIRED) return { focus: request.id, depth: 1, nodes: [{ id: request.id, title: 'Backup plan', kind: 'project', status: 'active', depth: 0, parent: null, links: 0 }], edges: [], more: [0, 0, 0] } satisfies BrainGraph as Result
        const other = request.id === 'n1' ? 'n2' : 'n1'
        return { focus: request.id, depth: 1, nodes: [{ id: request.id, title: NOTES[request.id]!.title, kind: 'project', status: 'active', depth: 0, parent: null, links: 1 },
          { id: other, title: NOTES[other]!.title, kind: 'fact', status: 'active', depth: 1, parent: request.id, links: 1 }], edges: [{ from: request.id, to: other, tree: true }], more: [0, 0, 0] } satisfies BrainGraph as Result
      }
      case 'map': return { nodes: [{ id: 'n1', title: 'Backup plan', kind: 'project', status: 'active', links: 1 }, { id: 'n2', title: 'Other', kind: 'fact', status: 'active', links: 1 },
        { id: 's1', title: 'Keys', kind: 'fact', status: 'active', links: 0 }, { id: 'h1', title: 'Hidden link', kind: 'fact', status: 'active', links: 0 }, ...(request.archived ? [{ id: 'n4', title: 'Old', kind: 'fact', status: 'archived' as const, links: 0 }] : [])],
        edges: [{ from: 'n1', to: 'n2' }], total: request.archived ? 5 : 4 } satisfies BrainMap as Result
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
  held = null
  release = []
  READ_FAILS = new Set()
  HISTORY_TEXT = 'Second.'
  LIST = [summary('n1', 'Backup plan'), summary('n2', 'Other')]
  FOUND = null
  PAIRED = false
  GRAPH_FAILS = false
})
const releaseAll = async (): Promise<void> => { const waiting = release; release = []; await act(async () => { for (const go of waiting) go() }); await flush() }
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
    expect(fold.textContent).toBe('Withdrawn 101')
    await act(async () => { fold.click() })
    await flush()
    expect(text()).toContain('Mistake')
    expect(requests.some((r) => r.command === 'list' && r.withdrawn === true)).toBe(true)
    // Past the first hundred, the fold has its own Show more.
    expect(container!.querySelectorAll('.b-withdrawn .b-row')).toHaveLength(100)
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-withdrawn .b-more')!.click() })
    await flush()
    expect(container!.querySelectorAll('.b-withdrawn .b-row')).toHaveLength(101)
    expect(container!.querySelector('.b-withdrawn .b-more')).toBeNull()
  })

  it('reads a withdrawn note with History and offers no graph for it', async () => {
    await mount({ noteId: 'w1', archived: false })
    expect(container!.querySelector('.b-title')!.textContent).toBe('Mistake')
    expect(container!.querySelector('[aria-labelledby="b-view"]')).toBeNull()
    await press(container!.querySelector('.b-box')!, 'g')
    expect(container!.querySelector('svg.b-graph')).toBeNull()
    expect(requests.some((r) => r.command === 'graph')).toBe(false)
    expect(container!.querySelector('.b-side')!.textContent).toContain('History')
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

describe('Brain page after review (Astra 20261119T191003-e9cb0226)', () => {
  it('acts only on results for the words now typed, and says First 10 at ten', async () => {
    await mount()
    held = (r) => r.command === 'search' && r.query === 'other'
    await type('other')
    // The answer for "other" is held back: the list rows from before are not there to open.
    await press(container!.querySelector('.b-search input')!, 'Enter')
    expect(container!.querySelector('.b-title')).toBeNull()
    expect(container!.querySelectorAll('.b-list .b-row')).toHaveLength(0)
    held = null
    await releaseAll()
    FOUND = Array.from({ length: 10 }, (_, i) => summary(`f${i}`, `Found ${i}`))
    await type('found')
    expect(container!.querySelector('.b-list-head')!.textContent).toContain('First 10')
  })

  it('gives the keys to the note after Enter in search, so G opens the graph and the graph takes the keys', async () => {
    await mount()
    await type('backup')
    await press(container!.querySelector('.b-search input')!, 'Enter')
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
    expect(document.activeElement).not.toBe(container!.querySelector('.b-search input'))
    await press(document.activeElement ?? container!.querySelector('.b-box')!, 'g')
    expect(container!.querySelector('svg.b-graph')).not.toBeNull()
    expect(document.activeElement).toBe(container!.querySelector('svg.b-graph'))
  })

  it('keeps History closed when its answer comes after he closed it', async () => {
    await mount({ noteId: 'n1', archived: false })
    held = (r) => r.command === 'history'
    const box = container!.querySelector('.b-box')!
    await press(box, 'h')
    await press(box, 'Escape')
    await releaseAll()
    expect(container!.querySelector('.b-history')).toBeNull()
  })

  it('asks each next page once, so repeated Show more never repeats notes', async () => {
    LIST = Array.from({ length: 250 }, (_, i) => summary(`l${i}`, `Listed ${i}`))
    await mount()
    held = (r) => r.command === 'list' && (r.offset ?? 0) > 0
    const more = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.b-list-wrap > .b-more')!
    await act(async () => { more().click(); more().click() })
    await releaseAll()
    held = null
    expect(requests.filter((r) => r.command === 'list' && r.offset === 100)).toHaveLength(1)
    await act(async () => { more().click() })
    await flush()
    const ids = [...container!.querySelectorAll('.b-list .b-row[data-note]')].map((e) => e.getAttribute('data-note'))
    expect(ids).toHaveLength(250)
    expect(new Set(ids).size).toBe(250)
    expect(container!.querySelector('.b-list-wrap > .b-more')).toBeNull()
  })

  it('after a refocus the new centre is the selected note, named beside the graph', async () => {
    PAIRED = true
    await mount({ noteId: 'n1', archived: false })
    await press(container!.querySelector('.b-box')!, 'g')
    await act(async () => { container!.querySelector<SVGGElement>('.b-node[data-node="n2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(container!.querySelector('.b-node.selected')!.getAttribute('data-node')).toBe('n2')
    await press(container!.querySelector('svg.b-graph')!, 'Enter', { shiftKey: true })
    await flush()
    expect(container!.querySelector('svg.b-graph')!.getAttribute('data-focus')).toBe('n2')
    expect(container!.querySelector('.b-node.selected')!.getAttribute('data-node')).toBe('n2')
    expect(container!.querySelector('.b-side-title')!.textContent).toBe('Other')
  })

  it('M opens the whole-brain map from the list; Enter shows a note beside, Shift Enter opens its graph, M comes back, Esc leaves', async () => {
    PAIRED = true
    await mount()
    const box = container!.querySelector('.b-box')!
    await press(box, 'm')
    expect(requests.some((r) => r.command === 'map')).toBe(true)
    const svg = container!.querySelector('svg.b-map')!
    expect(svg).not.toBeNull()
    expect(text()).toContain('4 notes · 1 link · 2 alone · 1 group, largest 2')
    expect(container!.querySelector('.b-map-toggle')!.getAttribute('aria-pressed')).toBe('true')
    expect(text()).toContain('Pick a note to read it here.')
    expect(container!.querySelectorAll('svg.b-map .b-node')).toHaveLength(4)
    // Enter on the cursor (the biggest group's centre) shows that note beside the map.
    await press(svg, 'Enter')
    expect(container!.querySelector('.b-side-title')!.textContent).toMatch(/Backup plan|Other/)
    const picked = container!.querySelector('svg.b-map .b-node.selected')!.getAttribute('data-node')!
    // Shift Enter opens that note's neighbourhood graph.
    await press(container!.querySelector('svg.b-map')!, 'Enter', { shiftKey: true })
    await flush()
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(container!.querySelector('svg.b-graph')!.getAttribute('data-focus')).toBe(picked)
    // M comes back to the map with that note selected; Esc leaves it to the note.
    await press(container!.querySelector('.b-box')!, 'm')
    expect(container!.querySelector('svg.b-map .b-node.selected')!.getAttribute('data-node')).toBe(picked)
    await press(container!.querySelector('.b-box')!, 'Escape')
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(closed).toBe(0)
    // The route stayed read-only: only reads were asked.
    expect(new Set(requests.map((r) => r.command))).toEqual(new Set(['status', 'list', 'map', 'read', 'graph']))
  })

  it('beside the map shows only the note now selected: while the next one loads, no button acts on the one before (pre-review)', async () => {
    PAIRED = true
    await mount()
    await press(container!.querySelector('.b-box')!, 'm')
    const svg = (): Element => container!.querySelector('svg.b-map')!
    await press(svg(), 'Enter')
    const first = container!.querySelector('svg.b-map .b-node.selected')!.getAttribute('data-node')!
    expect(container!.querySelector('.b-side-title')).not.toBeNull()
    // The next read is held: the panel says it is opening and offers no Open note or Graph for the first note.
    held = (request) => request.command === 'read'
    // Its one neighbour sits straight above the group's centre.
    await press(svg(), 'ArrowUp')
    await press(svg(), 'Enter')
    const second = container!.querySelector('svg.b-map .b-node.selected')!.getAttribute('data-node')!
    expect(second).not.toBe(first)
    expect(container!.querySelector('.b-side-title')).toBeNull()
    expect(text()).toContain('Opening the note…')
    expect([...container!.querySelectorAll('.b-side button')].map((b) => b.textContent)).toEqual([])
    held = null
    await act(async () => { for (const go of release.splice(0)) go() })
    await flush()
    expect(container!.querySelector('.b-side-title')!.textContent).toBe(NOTES[second]!.title)
    // While the map is open, Note | Graph shows neither as chosen: one gold bar, on Map.
    expect(container!.querySelector('.b-map-toggle')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('from the map, a search result opens as a page and leaves the map (review)', async () => {
    await mount()
    await press(container!.querySelector('.b-box')!, 'm')
    expect(container!.querySelector('svg.b-map')).not.toBeNull()
    await type('backup')
    await press(container!.querySelector('.b-search input')!, 'Enter')
    await flush()
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
    await press(container!.querySelector('.b-box')!, 'm')
    await type('backup')
    await act(async () => { container!.querySelector<HTMLElement>('.b-row[data-note]')!.click() })
    await flush()
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Backup plan')
  })

  it('a map read for another Archived setting takes the old picture and panel away until it answers; a hidden note never shows beside it (review)', async () => {
    await mount({ noteId: null, archived: true })
    await press(container!.querySelector('.b-box')!, 'm')
    // n4 (archived) is on the map while Archived is on.
    await act(async () => { (container!.querySelector('svg.b-map') as SVGElement).focus() })
    expect(container!.querySelectorAll('svg.b-map .b-node')).toHaveLength(5)
    held = (request) => request.command === 'map'
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-toggle')!.click() })
    await flush()
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(container!.querySelector('.b-side-title')).toBeNull()
    held = null
    await releaseAll()
    expect(container!.querySelectorAll('svg.b-map .b-node')).toHaveLength(4)
  })

  it('an archived note selected on the map is gone from map and panel once Archived turns off, and stays gone after (recheck)', async () => {
    NOTES.n4 = note('n4', 'Old', { status: 'archived', linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Old text.' })
    try {
      await mount({ noteId: null, archived: true })
      await press(container!.querySelector('.b-box')!, 'm')
      const dot = container!.querySelector('svg.b-map .b-node[data-node="n4"] circle:not(.b-bloom):not(.b-select)')!
      await act(async () => { container!.querySelector('svg.b-map')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Number(dot.getAttribute('cx')), clientY: Number(dot.getAttribute('cy')) })) })
      await flush()
      expect(container!.querySelector('.b-side-title')!.textContent).toBe('Old')
      held = (request) => request.command === 'map'
      await act(async () => { container!.querySelector<HTMLButtonElement>('.b-toggle')!.click() })
      await flush()
      // While the new read is pending: no map, no panel, no button for Old.
      expect(container!.querySelector('svg.b-map')).toBeNull()
      expect(container!.querySelector('.b-side-title')).toBeNull()
      expect([...container!.querySelectorAll('.b-side button')]).toEqual([])
      held = null
      await releaseAll()
      expect(container!.querySelector('svg.b-map .b-node[data-node="n4"]')).toBeNull()
      expect(container!.querySelector('svg.b-map .b-node.selected')).toBeNull()
      expect(container!.querySelector('.b-side-title')).toBeNull()
      expect(text()).toContain('Pick a note to read it here.')
    } finally { delete (NOTES as Record<string, BrainPageNote | undefined>).n4 }
  })

  it('an older map answer that arrives last is dropped (recheck)', async () => {
    await mount()
    held = (request) => request.command === 'map'
    await press(container!.querySelector('.b-box')!, 'm')
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-toggle')!.click() })
    await flush()
    const maps = requests.filter((r) => r.command === 'map')
    expect(maps.map((r) => r.command === 'map' && r.archived)).toEqual([false, true])
    expect(release).toHaveLength(2)
    held = null
    const [older, newer] = release.splice(0)
    // The newer answer (Archived on, 5 notes) comes first, the older one (Archived off, 4 notes) last.
    await act(async () => { newer!() })
    await flush()
    await act(async () => { older!() })
    await flush()
    expect(container!.querySelectorAll('svg.b-map .b-node')).toHaveLength(5)
    expect(container!.querySelector('svg.b-map .b-node[data-node="n4"]')).not.toBeNull()
  })

  it('a link beside the map to a note not on it opens that note as a page; a failed read says so (review)', async () => {
    await mount()
    await press(container!.querySelector('.b-box')!, 'm')
    const clickDot = async (id: string): Promise<void> => {
      const dot = container!.querySelector(`svg.b-map .b-node[data-node="${id}"] circle:not(.b-bloom):not(.b-select)`)!
      await act(async () => { container!.querySelector('svg.b-map')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Number(dot.getAttribute('cx')), clientY: Number(dot.getAttribute('cy')) })) })
      await flush()
    }
    await clickDot('h1')
    expect(container!.querySelector('.b-side-title')!.textContent).toBe('Hidden link')
    // Its link names Old, which is archived and not on the map: it opens Old as a page, and the map closes.
    NOTES.n4 = note('n4', 'Old', { status: 'archived', linksTo: [], linkedFrom: [], missing: [], targets: {}, markdown: 'Old text.' })
    await act(async () => { [...container!.querySelectorAll<HTMLElement>('.b-side .ql-md-a')].find((a) => a.textContent === 'Old')!.click() })
    await flush()
    expect(container!.querySelector('svg.b-map')).toBeNull()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Old')
    delete (NOTES as Record<string, BrainPageNote | undefined>).n4
    // A selection whose read fails says why, not an endless "Opening".
    await press(container!.querySelector('.b-box')!, 'm')
    READ_FAILS = new Set(['s1'])
    await clickDot('s1')
    expect(container!.querySelector('.b-side .b-alert')!.textContent).toContain('could not be read')
    expect(container!.querySelector('.b-side [aria-busy="true"]')).toBeNull()
    READ_FAILS = new Set()
  HISTORY_TEXT = 'Second.'
    await clickDot('h1')
    expect(container!.querySelector('.b-side-title')!.textContent).toBe('Hidden link')
  })

  it('after a refocus in the narrow sheet the new centre is selected and the graph stays', async () => {
    PAIRED = true
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
    try {
      await mount({ noteId: 'n1', archived: false })
      expect(container!.querySelector('.b-note.narrow')).not.toBeNull()
      await press(container!.querySelector('.b-box')!, 'g')
      await act(async () => { container!.querySelector<SVGGElement>('.b-node[data-node="n2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await flush()
      await press(container!.querySelector('svg.b-graph')!, 'Enter', { shiftKey: true })
      await flush()
      expect(container!.querySelector('svg.b-graph')!.getAttribute('data-focus')).toBe('n2')
      expect(container!.querySelector('.b-node.selected')!.getAttribute('data-node')).toBe('n2')
    } finally { if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width); else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth }
  })

  it('takes the old graph off the screen when the next graph cannot be read', async () => {
    PAIRED = true
    await mount({ noteId: 'n1', archived: false })
    await press(container!.querySelector('.b-box')!, 'g')
    expect(container!.querySelector('svg.b-graph')).not.toBeNull()
    GRAPH_FAILS = true
    await press(container!.querySelector('svg.b-graph')!, '3')
    expect(container!.querySelector('svg.b-graph')).toBeNull()
    expect(container!.querySelector('.b-graph-pane [role="alert"]')!.textContent).toContain('not shown in the graph')
  })

  it('keeps each list its own pages across an Archived change, for the withdrawn fold too (recheck 3)', async () => {
    LIST = Array.from({ length: 250 }, (_, i) => summary(`l${i}`, `Listed ${i}`))
    await mount()
    held = (r) => r.command === 'list' && (r.offset ?? 0) > 0 && r.archived !== true
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-list-wrap > .b-more')!.click() })
    // Archived on while the old page is held: the new list asks its own page once, however the old answer lands.
    held = (r) => r.command === 'list' && (r.offset ?? 0) > 0 && r.archived === true
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-toggle')!.click() })
    await flush()
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-list-wrap > .b-more')!.click() })
    const first = release.shift()!
    await act(async () => { first() })
    await flush()
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-list-wrap > .b-more')!.click() })
    expect(requests.filter((r) => r.command === 'list' && r.archived === true && r.offset === 100)).toHaveLength(1)
    held = null
    await releaseAll()
    // The withdrawn fold: two clicks while its page is held ask it once.
    await act(async () => { container!.querySelector<HTMLButtonElement>('.b-withdrawn .b-fold')!.click() })
    await flush()
    held = (r) => r.command === 'list' && r.withdrawn === true && (r.offset ?? 0) > 0
    const more = (): HTMLButtonElement => container!.querySelector<HTMLButtonElement>('.b-withdrawn .b-more')!
    await act(async () => { more().click(); more().click() })
    expect(requests.filter((r) => r.command === 'list' && r.withdrawn === true && r.offset === 100)).toHaveLength(1)
    held = null
    await releaseAll()
    expect(container!.querySelectorAll('.b-withdrawn .b-row')).toHaveLength(101)
  })

  it('opens another note at its own depth', async () => {
    await mount({ noteId: 'n1', archived: false })
    const box = container!.querySelector('.b-box')!
    await press(box, 'g')
    await press(container!.querySelector('svg.b-graph')!, '3')
    expect(requests.filter((r) => r.command === 'graph').at(-1)).toMatchObject({ depth: 3 })
    await press(box, 'Escape')
    await act(async () => { container!.querySelector<HTMLElement>('.ql-md-a[data-target="file"]')!.click() })
    await flush()
    await press(container!.querySelector('.b-box')!, 'g')
    expect(requests.filter((r) => r.command === 'graph').at(-1)).not.toHaveProperty('depth')
  })

  it('shows an unresolved name as plain text with no Tab stop', async () => {
    await mount({ noteId: 'n1', archived: false })
    const missing = container!.querySelector('[data-target="none"]')!
    expect(missing.tagName).toBe('SPAN')
    expect(missing.hasAttribute('tabindex')).toBe(false)
    expect(missing.getAttribute('title')).toBe('No note with this name')
  })

  it('shows a hidden value for ten seconds only, never on the next note, and hides it whole with CRLF text', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      await mount({ noteId: 's1', archived: false })
      const page = (): string => container!.querySelector('.b-text')!.textContent!
      expect(page()).not.toContain('AKIA')
      await act(async () => { container!.querySelector<HTMLButtonElement>('.ql-eye')!.click() })
      expect(page()).toContain('AKIAABCDEFGHIJKLMNOP')
      await act(async () => { vi.advanceTimersByTime(10_300) })
      expect(page()).not.toContain('AKIA')
      await act(async () => { container!.querySelector<HTMLButtonElement>('.ql-eye')!.click() })
      await act(async () => { container!.querySelector<HTMLElement>('.ql-md-a[data-target="file"]')!.click() })
      await flush()
      expect(container!.querySelector('.b-title')!.textContent).toBe('Other')
      expect(page()).not.toContain('AKIA')
      // Back to the first note within the ten seconds, and again after them: hidden both times (recheck 6).
      await press(container!.querySelector('.b-box')!, 'ArrowLeft', { altKey: true })
      expect(container!.querySelector('.b-title')!.textContent).toBe('Keys')
      expect(page()).not.toContain('AKIA')
      await act(async () => { container!.querySelector<HTMLButtonElement>('.ql-eye')!.click() })
      await act(async () => { container!.querySelector<HTMLElement>('.ql-md-a[data-target="file"]')!.click() })
      await flush()
      await act(async () => { vi.advanceTimersByTime(10_300) })
      await press(container!.querySelector('.b-box')!, 'ArrowLeft', { altKey: true })
      expect(container!.querySelector('.b-title')!.textContent).toBe('Keys')
      expect(page()).not.toContain('AKIA')
    } finally { vi.useRealTimers() }
  })
})

describe('Brain page after the post-delivery review (2026-11-20)', () => {
  it('opening a note gives its text the keys without scrolling, so the narrow sheet keeps the note head in view', async () => {
    // A frame is a plain timeout here: an earlier fake-timer case can leave jsdom's own frames stalled.
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    await mount()
    await type('backup')
    await press(container!.querySelector('.b-search input')!, 'Enter')
    await flush()
    const page = container!.querySelector('.b-text .ql-page')
    const calls = focus.mock.contexts.map((context, at) => [context, focus.mock.calls[at]![0]] as const).filter(([context]) => context === page)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(([, options]) => (options as FocusOptions | undefined)?.preventScroll === true)).toBe(true)
    focus.mockRestore()
  })

  it('beside the graph shows only the note now selected: nothing of the one before while it loads, and a failed read says so', async () => {
    PAIRED = true
    await mount({ noteId: 'n1', archived: false })
    await press(container!.querySelector('.b-box')!, 'g')
    expect(container!.querySelector('.b-side-title')!.textContent).toBe('Backup plan')
    held = (request) => request.command === 'read'
    await act(async () => { container!.querySelector<SVGGElement>('.b-node[data-node="n2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(container!.querySelector('.b-node.selected')!.getAttribute('data-node')).toBe('n2')
    expect(container!.querySelector('.b-side-title')).toBeNull()
    expect([...container!.querySelectorAll('.b-side button')].map((b) => b.textContent)).toEqual([])
    held = null
    await releaseAll()
    expect(container!.querySelector('.b-side-title')!.textContent).toBe('Other')
    // A read that fails: no panel for the centre note, and the reason shown.
    await act(async () => { container!.querySelector<SVGGElement>('.b-node[data-node="n1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    READ_FAILS.add('n2')
    await act(async () => { container!.querySelector<SVGGElement>('.b-node[data-node="n2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(container!.querySelector('.b-side-title')).toBeNull()
    expect(container!.querySelector('.b-side .b-alert')!.textContent).toContain('could not be read')
  })

  it('a link in History opens its note and closes History', async () => {
    HISTORY_TEXT = 'Second. See [[Other]].'
    await mount({ noteId: 'n1', archived: false })
    await press(container!.querySelector('.b-box')!, 'h')
    await act(async () => { container!.querySelector<HTMLElement>('.b-history .ql-md-a[data-target="file"]')!.click() })
    await flush()
    expect(container!.querySelector('.b-history')).toBeNull()
    expect(container!.querySelector('.b-title')!.textContent).toBe('Other')
  })

  it('draws a filed note without its MODULE file header', async () => {
    await mount({ noteId: 'm1', archived: false })
    expect(container!.querySelector('.b-text')!.textContent).toContain('The rule itself.')
    expect(container!.querySelector('.b-text')!.textContent).not.toContain('MODULE')
    expect(withoutModuleHeading('a\n# MODULE: x.md - header\nb\n# MODULE: y.md - kept')).toBe('a\nb\n# MODULE: y.md - kept')
    expect(withoutModuleHeading('# Module of x\ntext')).toBe('# Module of x\ntext')
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
