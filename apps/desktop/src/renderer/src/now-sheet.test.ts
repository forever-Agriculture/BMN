// MODULE: now-sheet.test.ts - Story 110.9 AC1 and AC6: each designed state of the Now sheet, focus kept across a refresh, and the way back to the row
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildNow, type DevAutoRun, type DevAutoRunsResult, type NowSection, type NowSessionInput, type NowView } from '@bmn/protocol'
import { NowSheet, NowSheetView, createNowMemory, createNowTestControl, NOW_TEST_PRESETS, focusAfter, heldSections, rowWords, visibleKeys, type NowHead, type NowSheetViewProps } from './now-sheet'

const NOW = new Date(2026, 10, 5, 9, 40)
const READ = new Date(2026, 10, 5, 9, 40).toISOString()
const MIN = 60_000

describe('isolated Now QA controls', () => {
  it('has no control in normal mode and accepts only fixed preset names in test mode', () => {
    const selected: unknown[] = []
    expect(createNowTestControl(false, (value) => selected.push(value))).toBeNull()
    const control = createNowTestControl(true, (value) => selected.push(value))!
    for (const preset of NOW_TEST_PRESETS) control.select(preset)
    control.select('reset')
    expect(selected).toEqual([...NOW_TEST_PRESETS, undefined])
    for (const invalid of [null, {}, { preset: 'success' }, 'arbitrary', 1]) expect(() => control.select(invalid)).toThrow('Unknown Now QA preset')
    expect(selected).toHaveLength(NOW_TEST_PRESETS.length + 1)
    expect(Object.isFrozen(control)).toBe(true)
  })
})

function session(id: string, workspaceId: string, over: Partial<NowSessionInput> = {}): NowSessionInput {
  return { sessionId: id, workspaceId, name: id, dot: 'running', live: true, started: true, agent: true, working: true,
    progressLabel: null, title: null, card: null, ...over }
}
function run(over: Partial<DevAutoRun>): DevAutoRun {
  return { workspaceIds: ['wq'], checkout: '/home/me/code/run', branch: 'dev-auto/epic', project: null, status: 'ACTIVE', nextAction: 'Finish it',
    decisions: [], runId: null, decisionEntries: [], omittedDecisions: 0, finished: false, updatedAt: null, ownership: 'own', ownerCheckout: null,
    ownerBranch: null, unavailable: null, board: { checkout: null, rows: [], unavailable: null }, ownerItems: [], waitingOn: null,
    finishedStories: [], skippedFinishedStories: 0, leadConversations: [], sessionId: null, sessionLink: null, ...over }
}
function board(epic: number, total: number, done: number, slug: string): DevAutoRun['board'] {
  return { checkout: null, unavailable: null, rows: Array.from({ length: total }, (_, index) => ({
    key: `${epic}-${index + 1}-${index === done ? slug : `s${index + 1}`}`, status: index < done ? 'done' : index === done ? 'in-progress' : 'backlog', comment: '' })) }
}
const took = (...minutes: number[]): NonNullable<DevAutoRun['finishedStories']> => minutes.map((m, index) => ({ story: `1.${index + 1}`,
  startedAt: new Date(NOW.getTime() - (index + 2) * 86_400_000).toISOString(), finishedAt: new Date(NOW.getTime() - (index + 2) * 86_400_000 + m * MIN).toISOString() }))

const WORKSPACES = [{ workspaceId: 'wq', name: 'Q-Automations' }, { workspaceId: 'wb', name: 'BMN' }, { workspaceId: 'wp', name: 'Pet' }]
const SESSIONS = [
  session('q40', 'wq', { name: 'Q-Automations-40', dot: 'needs-you', working: false, card: { requestId: 'c40', title: 'approve TEST deploy' } }),
  session('q41', 'wq', { name: 'Q-Automations-41', dot: 'running-idle', working: false }),
  session('qlong', 'wq', { name: 'Q-Automations-39-retry-after-timeout-and-the-second-billing-import', dot: 'running-idle', working: false }),
  session('qrev', 'wq', { name: 'q-review', progressLabel: 'Review PR comments' }),
  session('b110', 'wb', { name: 'BMN-110' }),
  session('b112', 'wb', { name: 'BMN-112', dot: 'running-idle', working: false }),
  session('bnotes', 'wb', { name: 'bmn-notes', dot: 'running-idle', working: false }),
  session('p128', 'wp', { name: 'Pet-128', live: false, dot: 'exited' }),
  session('pshell', 'wp', { name: 'pet-shell', agent: false, dot: 'running-idle', working: false }),
  session('qspike', 'wp', { name: 'q-spike', live: false, dot: 'exited' })
]
const RUNS = [
  run({ sessionId: 'q40', board: board(40, 7, 4, 'licence-import-QA'), finishedStories: took(40, 60, 60, 80), checkout: '/home/me/code/q-automations-40' }),
  run({ sessionId: 'q41', board: board(41, 5, 2, 'report-export'), waitingOn: 'Marta, review', finishedStories: took(60, 100) }),
  run({ sessionId: 'qlong', board: board(39, 2, 1, 'retry-after-timeout'), waitingOn: 'TEST deploy', finishedStories: took(30) }),
  run({ workspaceIds: ['wb'], sessionId: 'b110', board: board(110, 3, 2, 'time-left-range'), finishedStories: took(30, 70) }),
  run({ workspaceIds: ['wb'], sessionId: 'b112', unavailable: 'larger than the read limit' }),
  run({ workspaceIds: ['wp'], sessionId: 'p128', board: board(128, 6, 2, 'photo-upload') }),
  run({ workspaceIds: ['wp'], checkout: '/home/me/code/q-automations-36', branch: 'dev-auto/epic-36', board: board(36, 8, 3, 'x') })
]
const view = (over: { sessions?: NowSessionInput[]; runs?: DevAutoRun[] | null } = {}): NowView =>
  buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: over.sessions ?? SESSIONS, runs: over.runs === undefined ? RUNS : over.runs, home: '/home/me' })
function draw(v: NowView, over: Partial<NowSheetViewProps> = {}): string {
  const head: NowHead = { kind: 'read', at: READ }
  return renderToStaticMarkup(createElement(NowSheetView, { view: v, sections: v.sections, head, copy: 'ready', open: new Set<string>(),
    notRunningOpen: false, focusKey: v.sections[0]?.keys[0] ?? null, currentSessionId: null, ...over }))
}
const text = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the Now sheet, state by state (Story 110.9 AC6)', () => {
  it('12 sessions: the head counts and calls only the waiting ones gold; sections in order; Copy standup ready', () => {
    const twelve = [...SESSIONS, session('q42', 'wq', { name: 'Q-Automations-42' }), session('b108', 'wb', { name: 'BMN-108-109' }),
      session('p111', 'wp', { name: 'Pet-111-127' })]
    const markup = draw(view({ sessions: twelve }))
    expect(text(markup)).toContain('Read 09:40 · 12 sessions · 1 waits on you Copy standup')
    // Twelve rows outside Not running, the design's twelve sessions.
    expect(markup.slice(0, markup.indexOf('<section><button type="button" class="n-sec"')).match(/class="n-main"/g)).toHaveLength(12)
    expect(markup.match(/status-dot needs-you/g)).toHaveLength(2)
    expect([...markup.matchAll(/<h3 class="n-sec"><span>([^<]+)<\/span><b>(\d+)<\/b>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['Waits on you 1', 'Q-Automations 4', 'BMN 4', 'Pet 3'])
    expect(markup).toContain('data-now-key="fold:not-running" tabindex="-1" aria-expanded="false" aria-controls="now-not-running"')
    expect(markup).toContain('<span>Not running</span><b>2</b>')
    expect(markup).not.toMatch(/class="plate" disabled/)
    // Only the focused row is a Tab stop (roving tabindex).
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1)
    expect(text(markup)).toContain('Q-Automations-40 40.5 licence import QA 4 of 7 Waits on you: approve TEST deploy about 2-4 h + wait')
  })

  it('a row opened: label and value rows, the card a button, the folder in the mono face', () => {
    const markup = draw(view(), { open: new Set(['s:q40']) })
    expect(markup).toMatch(/<button type="button" class="n-chev" tabindex="-1" aria-expanded="true" aria-controls="now-fold-s_q40" aria-label="Explain Q-Automations-40">/)
    expect(markup).toContain('<dl class="n-fold" id="now-fold-s_q40">')
    expect(text(markup)).toContain('Time left About 2-4 h of work. 3 stories left; its 4 finished stories took 40 min to 1 h 20 each. The wait for you is not counted.')
    expect(markup).toContain('<dt>Card</dt><dd><button type="button" class="link" tabindex="-1">approve TEST deploy</button></dd>')
    expect(markup).toContain('<span class="path" title="~/code/q-automations-40 on dev-auto/epic">~/code/q-automations-40 on dev-auto/epic</span>')
    expect(markup).toMatch(/<dl class="n-fold" id="now-fold-s_q41" hidden="">/)
  })

  it('30 sessions: every row is drawn inside the one scrolling list, under the head that stays', () => {
    const many = Array.from({ length: 30 }, (_, i) => session(`m${i}`, WORKSPACES[i % 3]!.workspaceId, { name: `Session-${i}` }))
    const markup = draw(view({ sessions: many, runs: [] }))
    expect(markup.match(/class="n-main"/g)).toHaveLength(30)
    expect(markup.indexOf('class="n-scroll"')).toBeLessThan(markup.indexOf('class="n-main"'))
    expect(text(markup)).toContain('30 sessions · nothing waits on you')
  })

  it('a long name is cut by the column, whole in its tooltip and in the open row', () => {
    const markup = draw(view(), { open: new Set(['s:qlong']) })
    const long = 'Q-Automations-39-retry-after-timeout-and-the-second-billing-import'
    expect(markup).toContain(`title="${long}. 39.2 retry after timeout, 1 of 2. Waits on TEST deploy. No estimate."`)
    expect(markup).toContain(`<dt>Session</dt><dd>${long}</dd>`)
  })

  it('loading: rows from memory at once, no run words, no chevrons, Copy disabled until the read returns', () => {
    const markup = draw(view({ runs: null }), { head: { kind: 'loading' }, copy: 'disabled' })
    expect(text(markup)).toContain('Reading runs…')
    expect(markup).toContain('<button type="button" class="plate" disabled="" aria-live="polite">Copy standup</button>')
    expect(markup).not.toContain('n-chev')
    expect(markup).not.toContain('no estimate')
    expect(text(markup)).toContain('BMN-110 Working')
    expect(text(markup)).toContain('Q-Automations-40 Idle Waits on you: approve TEST deploy')
  })

  it('stale: the head and an alert say so, rows keep their last words; one unreadable handoff marks only its row', () => {
    const markup = draw(view(), { head: { kind: 'stale', at: new Date(2026, 10, 5, 9, 12).toISOString() } })
    expect(text(markup)).toContain('Read 09:12 · stale')
    expect(markup).toContain('<p class="n-alert" role="alert">Could not read the dev-auto runs. Rows show the 09:12 read.</p>')
    expect(text(markup)).toContain('BMN-112 Handoff unreadable stale Waits on unknown no estimate')
    expect(markup.match(/class="chip">stale/g)).toHaveLength(1)
    expect(markup).toContain('class="c-who is-faint"')
  })

  it('no agent running: the head says so', () => {
    const v = view({ sessions: [session('pshell', 'wp', { name: 'pet-shell', agent: false, dot: 'running-idle' }),
      ...Array.from({ length: 17 }, (_, i) => session(`s${i}`, 'wp', { name: `session-${i + 40}`, live: false, dot: 'exited' }))], runs: [] })
    const markup = draw(v)
    expect(text(markup)).toContain('Read 09:40 · no agent running')
    expect(markup).toContain('<span>Not running</span><b>17</b>')
    expect(markup).not.toContain('needs-you')
  })

  it('no run: Doing is the agent\'s words or the hook\'s, Left is "no estimate" and there is nothing to open', () => {
    const markup = draw(view({ runs: [] }))
    expect(text(markup)).toContain('q-review Working: Review PR comments no estimate')
    expect(text(markup)).toContain('bmn-notes Idle no estimate')
    // Only the session with a card has something to open: its card.
    expect(markup.match(/class="n-chev"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Explain Q-Automations-40"')
  })

  it('nothing waits on you: no Waits on you section and no gold on the sheet', () => {
    const markup = draw(view({ sessions: SESSIONS.map((item) => ({ ...item, card: null, dot: item.dot === 'needs-you' ? 'running' : item.dot })) }))
    expect(text(markup)).toContain('nothing waits on you')
    expect(markup).not.toContain('needs-you')
    expect(markup).not.toContain('Waits on you</span>')
  })

  it('stopped: an unfinished run stays in its project, muted; the rest fold into Not running, a run with no session too', () => {
    const markup = draw(view(), { notRunningOpen: true })
    expect(markup).toMatch(/<li class="n-row is-stopped" data-key="s:p128">/)
    expect(text(markup)).toContain('Pet-128 Stopped at 128.3 photo upload 2 of 6')
    expect(markup).toContain('<ul class="n-list" id="now-not-running">')
    expect(text(markup)).toContain('dev-auto/epic-36 No session, stopped at 36.4 3 of 8')
    expect(draw(view())).toContain('<ul class="n-list" id="now-not-running" hidden="">')
  })

  it('marks the current session with the gold bar row', () => {
    expect(draw(view(), { currentSessionId: 'b110' })).toMatch(/<li class="n-row is-current" data-key="s:b110">/)
  })

  it('says each row whole for a screen reader and the tooltip', () => {
    const row = view().rows.find((item) => item.key === 's:q41')!
    expect(rowWords(row)).toBe('Q-Automations-41. 41.3 report export, 2 of 5. Waits on Marta, review. about 3-5 h plus the wait.')
  })
})

describe('a refresh never moves focus or a row under him (Story 110.9 AC6)', () => {
  const sections = (pairs: Array<[string, string[]]>): NowSection[] => pairs.map(([id, keys]) => ({ id, kind: id === 'not-running' ? 'not-running' : id === 'you' ? 'you' : 'project', title: id, workspaceId: null, keys }))
  it('keeps each row in the section it is shown in while held, a new row after every shown one, and adopts the new sections once let go', () => {
    const shown = sections([['you', ['a']], ['w:1', ['b', 'c']], ['not-running', ['d']]])
    const next = sections([['w:1', ['a', 'b']], ['not-running', ['c', 'd']], ['w:2', ['e']]])
    expect(heldSections(shown, next, true)).toEqual(sections([['you', ['a']], ['w:1', ['b', 'c']], ['not-running', ['d']], ['w:2', ['e']]]))
    // A new row of a section shown above comes last, under its own title; the next new one of that section joins it.
    const card = heldSections(shown, sections([['you', ['x', 'a']], ['w:1', ['b', 'c']], ['not-running', ['d']]]), true)
    expect(card.map((section) => [section.id, section.title, section.keys])).toEqual([['you', 'you', ['a']], ['w:1', 'w:1', ['b', 'c']],
      ['not-running', 'not-running', ['d']], ['you:new', 'you', ['x']]])
    expect(heldSections(card, sections([['you', ['y', 'x', 'a']], ['w:1', ['b', 'c']], ['not-running', ['d']]]), true).at(-1)?.keys).toEqual(['x', 'y'])
    // A third new row of another section, then a fourth of the first: each block comes last with its own id.
    const mixed = heldSections(card, sections([['you', ['x', 'a']], ['w:1', ['f', 'b', 'c']], ['not-running', ['d']]]), true)
    const again = heldSections(mixed, sections([['you', ['g', 'x', 'a']], ['w:1', ['f', 'b', 'c']], ['not-running', ['d']]]), true)
    expect(again.map((section) => [section.id, section.keys])).toEqual([['you', ['a']], ['w:1', ['b', 'c']], ['not-running', ['d']],
      ['you:new', ['x']], ['w:1:new', ['f']], ['you:new2', ['g']]])
    expect(heldSections(shown, next, false)).toEqual(next)
    // A row that went is gone even while held; a section left empty goes with it.
    expect(heldSections(shown, sections([['w:1', ['b', 'c']], ['not-running', ['d']]]), true)).toEqual(sections([['w:1', ['b', 'c']], ['not-running', ['d']]]))
  })
  it('gives focus to the next row when the focused one goes, else the one before, else the first', () => {
    expect(focusAfter(['a', 'b', 'c'], ['a', 'b', 'c'], 'b')).toBe('b')
    expect(focusAfter(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(focusAfter(['a', 'b', 'c'], ['a'], 'c')).toBe('a')
    expect(focusAfter(['a', 'b'], ['x'], 'b')).toBe('x')
    expect(focusAfter([], ['x', 'y'], null)).toBe('x')
    expect(focusAfter(['a'], [], 'a')).toBeNull()
  })
  it('walks only rows he can see: Not running only when it is open', () => {
    const s = sections([['w:1', ['a', 'b']], ['not-running', ['c']]])
    expect(visibleKeys(s, false)).toEqual(['a', 'b', 'fold:not-running'])
    expect(visibleKeys(s, true)).toEqual(['a', 'b', 'fold:not-running', 'c'])
  })
})

describe('back to the row he left (Story 110.9 AC1)', () => {
  it('opens on the remembered row with its rows and Not running open, and the last read\'s words at once', () => {
    const memory = { ...createNowMemory(), key: 's:b110', open: ['s:q41'], notRunningOpen: true,
      result: { runs: RUNS, skipped: 0, issues: [], observedAt: READ } satisfies DevAutoRunsResult }
    const markup = renderToStaticMarkup(createElement(NowSheet, { workspaces: WORKSPACES, sessions: SESSIONS, home: '/home/me', currentSessionId: 'b110',
      memory, onOpenRow: () => undefined, onClose: () => undefined }))
    expect(markup).toMatch(/data-key="s:b110"[^>]*tabindex="0"/)
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1)
    expect(markup).toContain('<dl class="n-fold" id="now-fold-s_q41">')
    expect(markup).toContain('<ul class="n-list" id="now-not-running">')
    expect(text(markup)).toContain('Read 09:40')
    // Copy waits for this opening's own read.
    expect(markup).toContain('class="plate" disabled=""')
    expect(markup).toContain('aria-label="Now"')
  })
  it('starts on the first row when nothing is remembered', () => {
    const markup = renderToStaticMarkup(createElement(NowSheet, { workspaces: WORKSPACES, sessions: SESSIONS, home: null, currentSessionId: null,
      memory: createNowMemory(), onOpenRow: () => undefined, onClose: () => undefined }))
    expect(markup).toMatch(/data-key="s:q40"[^>]*tabindex="0"/)
    expect(text(markup)).toContain('Reading runs…')
  })
})
