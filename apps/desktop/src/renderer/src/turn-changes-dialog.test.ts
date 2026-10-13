// MODULE: turn-changes-dialog.test.ts - Story 69.5 markup: the list in each of its states, the state of recording beside older numbers, an opened turn's labels and files, a file's difference with its masks, bounds and marks, the header plate and the pause card
import {
  TURN_PAUSE_REASONS, TURN_SECRET_PLATE, TURN_WORDINGS,
  type TurnDetail, type TurnFileView, type TurnSessionView, type TurnShownDifference, type TurnShownLine, type TurnSummary
} from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnPauseCard } from './turn-changes-card'
import { TurnChangesView, TurnDifference, type TurnFileBody, type TurnOpened } from './turn-changes-dialog'
import { TurnPlate } from './turn-changes-plate'

const at = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute, 2).toISOString()
const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime()
const noop = (): void => undefined
const SECRET = /whsec|key-one|key-two|MADEUPLINE/

function turn(turnId: string, change: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turnId, number: 1, app: 'claude', appVersion: '2.1.296', startedAt: at(13, 14, 32), endedAt: at(13, 14, 36), end: 'finished', state: 'closed',
    totalsState: 'complete', totals: { files: 4, added: 120, removed: 33 }, wording: null, ...change
  }
}
const none = (turnId: string, wording: string, change: Partial<TurnSummary> = {}): TurnSummary =>
  turn(turnId, { totals: null, totalsState: 'none', wording, ...change })
function view(change: Partial<TurnSessionView> = {}): TurnSessionView {
  return { sessionId: 's1', state: 'recording', app: 'claude', pausedRoot: null, pauseReason: null, latest: turn('t-1'), removalPending: false, ...change }
}

function dialog(given: {
  view?: TurnSessionView | null; turns?: TurnSummary[] | null; opened?: TurnOpened | null; bodies?: Map<string, TurnFileBody>
}): string {
  return renderToStaticMarkup(createElement(TurnChangesView, {
    view: given.view === undefined ? view() : given.view, turns: given.turns === undefined ? [turn('t-1')] : given.turns,
    opened: given.opened ?? null, bodies: given.bodies ?? new Map(), home: '/home/synthetic', now: NOW,
    onOpenTurn: noop, onBack: noop, onToggleFile: noop
  }))
}
/** What a reader, a copy and Find get: the text of the markup. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
/** The rows of the list, each as its text with a bar between its two lines. */
const rows = (html: string): string[] => [...html.matchAll(/<button type="button" class="turn-row"[^>]*>(.*?)<\/button>/g)]
  .map((match) => text((match[1] ?? '').replace('</span><span class="l2">', '</span> | <span>').replace(/<\/span><span class="(app|end)">/g, '</span> <span>')))
const golds = (html: string): string[] => [...html.matchAll(/<span class="caveat">([^<]*)<\/span>/g)].map((match) => match[1] ?? '')

describe('the list of turns', () => {
  it('is headed "The latest 50 turns still kept" and says so when there is no turn yet', () => {
    const html = dialog({ turns: [], view: view({ latest: null }) })
    expect(html).toContain('<h3>The latest 50 turns still kept</h3>')
    expect(html).toContain('<p class="turn-recording" role="status">Recording on</p>')
    expect(html).toContain('<p class="turn-gone">No turns yet</p>')
    expect(html).not.toContain('turn-row')
    expect(dialog({ turns: null })).toContain('Reading the turns…')
  })

  it('lists a turn newest first with its time, app, the word for its end and its totals', () => {
    const html = dialog({ turns: [
      turn('t-3'), turn('t-2', { app: 'codex', startedAt: at(13, 13, 48), end: 'interrupted', totals: { files: 2, added: 9, removed: 4 } }),
      turn('t-1', { startedAt: at(12, 18, 4), end: 'error', totals: { files: 5, added: 33, removed: 12 } })
    ] })
    expect(rows(html)).toEqual([
      '14:32 Claude Code Finished | 4 files +120 −33',
      '13:48 Codex Interrupted | 2 files +9 −4',
      '12 Oct 18:04 Claude Code Error | 5 files +33 −12'
    ])
    expect(golds(html)).toEqual([])
  })

  it('marks totals that are partial or not complete, in gold and nowhere else', () => {
    const html = dialog({ turns: [
      turn('t-2', { totalsState: 'partial', totals: { files: 11, added: 96, removed: 40 }, wording: TURN_WORDINGS.partial(3) }),
      turn('t-1', { totalsState: 'not-complete', totals: { files: 6, added: 58, removed: 7 }, wording: TURN_WORDINGS.orderingUnverified('Claude Code', '2.1.300') })
    ] })
    expect(rows(html)).toEqual(['14:32 Claude Code Finished | 11 files +96 −40partial', '14:32 Claude Code Finished | 6 files +58 −7not complete'])
    expect(golds(html)).toEqual(['partial', 'not complete'])
  })

  it.each([
    [TURN_WORDINGS.beforeUnavailable(), 'finished', 'Finished'],
    [TURN_WORDINGS.finalScanUnavailable(), 'not-observed', 'End not observed'],
    [TURN_WORDINGS.overlapped(), 'finished', 'Finished'],
    [TURN_WORDINGS.incomplete('100 MiB read'), 'finished', 'Finished'],
    [TURN_WORDINGS.notSupported('a sparse checkout'), 'finished', 'Finished'],
    [TURN_WORDINGS.limitReached(), 'finished', 'Finished'],
    [TURN_WORDINGS.switchedOff(), 'switched-off', '']
  ])('says in the place of the totals why there are none: %s', (wording, end, endWord) => {
    const html = dialog({ turns: [none('t-1', wording, { end })] })
    expect(rows(html)).toEqual([`14:32 Claude Code ${endWord} | ${wording}`])
    expect(golds(html)).toEqual([wording])
    expect(html).not.toContain('class="totals"')
  })

  it('shows a turn still running without totals and without gold', () => {
    const html = dialog({ turns: [turn('t-1', { state: 'open', end: null, endedAt: null, totals: null, totalsState: 'none' })] })
    expect(rows(html)).toEqual(['14:32 Claude Code Running | '])
    expect(golds(html)).toEqual([])
  })
})

describe('the state of recording beside older numbers', () => {
  it.each([
    [view({ state: 'off', app: null }), 'Recording off'],
    [view({ state: 'paused', pausedRoot: '/home/synthetic/code/shop', pauseReason: 'failed' }), 'Paused'],
    [view({ state: 'not-supported', app: 'opencode' }), 'Not supported for OpenCode'],
    [null, 'Recording off']
  ] as const)('says %s above the kept turns', (given, words) => {
    const html = dialog({ view: given })
    expect(html).toContain(`<p class="turn-recording" role="status">${words}</p>`)
    // The earlier turn is still listed, with its own numbers.
    expect(rows(html)).toEqual(['14:32 Claude Code Finished | 4 files +120 −33'])
  })

  it('says "Removal pending" beside the state while a removal waits for this session', () => {
    expect(dialog({ view: view({ state: 'paused', removalPending: true }) })).toContain('<p class="turn-recording" role="status">Paused · Removal pending</p>')
    expect(dialog({ view: view({ removalPending: true }) })).toContain('Recording on · Removal pending')
    expect(dialog({ view: view() })).not.toContain('Removal pending')
  })
})

const FILES: TurnFileView[] = [
  { path: '.env.example', state: 'changed', added: 1, removed: 1, note: null, opens: true },
  { path: 'assets/logo.png', state: 'binary', added: null, removed: null, note: null, opens: true },
  { path: 'bin/release.sh', state: 'mode only', added: null, removed: null, note: 'now executable', opens: false },
  { path: 'config/local.yaml', state: 'entered what is covered', added: null, removed: null, note: null, opens: false },
  { path: 'docs/guide.md', state: 'changed kind', added: null, removed: null, note: 'file to link', opens: false },
  { path: 'src/checkout/cart.test.ts', state: 'added', added: 52, removed: 0, note: null, opens: true },
  { path: 'src/legacy/coupons.ts', state: 'removed', added: 0, removed: 20, note: null, opens: true },
  { path: 'tmp/debug.log', state: 'left what is covered', added: null, removed: null, note: null, opens: false },
  { path: 'vendor/prices.sql', state: 'not read', added: null, removed: null, note: 'too large, 14.2 MiB', opens: false }
]
const OWN = 'Partial: 3 files were not read or entered or left what is covered'
const SCANS = 'Two scans of /home/synthetic/code/shop, the first from 14:05:02 to 14:05:02, the second from 14:09:41 to 14:09:42. Files in a scan were read at different moments, and other programs\' changes may be included'
function detail(change: Partial<TurnDetail> = {}): TurnDetail {
  return {
    turn: turn('t-2', { app: 'codex', appVersion: '0.162.1', startedAt: at(13, 14, 5), totalsState: 'partial', totals: { files: 11, added: 96, removed: 40 }, wording: TURN_WORDINGS.partial(3) }),
    workTree: '/home/synthetic/code/shop', labels: [SCANS, 'Anything written after the second scan ended is not included', OWN], files: FILES, moreFiles: 0, unavailable: null, ...change
  }
}
const opened = (change: Partial<TurnDetail> = {}): TurnOpened => ({ state: 'read', turnId: 't-2', detail: detail(change) })
const fileRows = (html: string): string[] => [...html.matchAll(/<button type="button" class="file-row"([^>]*)>(.*?)<\/button>/g)]
  .map((match) => `${/disabled/.test(match[1] ?? '') ? 'x' : /aria-expanded="true"/.test(match[1] ?? '') ? 'v' : '>'} ${text((match[2] ?? '').replace(/<\/span><span class="(state|lines|rm)">/g, '</span> <span>')).replace(/^›/, '').trim()}`)

describe('an opened turn', () => {
  it('says what it is and is not, its own labels first, and its files in the order given with state and lines', () => {
    const html = dialog({ turns: [turn('t-3'), detail().turn], opened: opened() })
    expect(html).toContain('<h3>14:05 · Codex 0.162.1 · Finished</h3>')
    expect(text(html)).toContain('What differs between two scans of ~/code/shop. It is not a list of what the agent did.')
    expect(html).toContain('<span class="mono" title="/home/synthetic/code/shop">~/code/shop</span>')
    expect([...html.matchAll(/<li(?: class="(own)")?>([^<]*)<\/li>/g)].map((match) => `${match[1] ?? 'all'}: ${(match[2] ?? '').slice(0, 24)}`))
      .toEqual(['own: Partial: 3 files were no', 'all: Two scans of ~/code/shop', 'all: Anything written after t'])
    // In the head the wording stands whole; it and the mark in the list are the only gold.
    expect(golds(html)).toEqual(['partial', 'Partial: 3 files'])
    expect(html).toContain('<span class="eyebrow">Files · 9</span>')
    expect(fileRows(html)).toEqual([
      '> .env.example changed +1 −1',
      '> assets/logo.png binary',
      'x bin/release.sh mode only · now executable',
      'x config/local.yaml entered what is covered',
      'x docs/guide.md changed kind · file to link',
      '> src/checkout/cart.test.ts added +52',
      '> src/legacy/coupons.ts removed  −20',
      'x tmp/debug.log left what is covered',
      'x vendor/prices.sql not read · too large, 14.2 MiB'
    ])
    // The opened turn is marked in the list, and under 900 px the stylesheet shows it in place of the list.
    expect(html).toContain('<div class="turns-layout" data-opened="true">')
    expect(html).toMatch(/class="turn-row" data-turn="t-2" aria-current="true"/)
    expect(html).toContain('‹ Back')
  })

  it('counts the files it does not list, and says why when the two scans cannot be compared now', () => {
    const many = dialog({ opened: opened({ moreFiles: 1_500 }) })
    expect(many).toContain('<span class="eyebrow">Files · 1,509</span>')
    expect(many).toContain('1,500 more files not listed')
    const unreadable = dialog({ opened: opened({ files: [], unavailable: 'The stored scans of this turn cannot be read' }) })
    expect(unreadable).toContain('<p class="turn-gone">The stored scans of this turn cannot be read</p>')
    expect(unreadable).not.toContain('class="turn-files"')
    const noTotals = dialog({ opened: opened({ turn: none('t-2', TURN_WORDINGS.beforeUnavailable()), files: [], labels: [] }) })
    expect(noTotals).not.toContain('Files ·')
    expect(golds(noTotals)).toContain('Before snapshot unavailable')
  })

  it('closes as "No longer kept" when its turn was removed while it was open', () => {
    const html = dialog({ turns: [turn('t-3')], opened: { state: 'gone', turnId: 't-2' } })
    expect(html).toContain('<p class="turn-gone" role="status">No longer kept</p>')
    expect(html).not.toContain('class="turn-head"')
    expect(html).not.toContain('aria-current')
    expect(rows(html)).toHaveLength(1)
  })
})

const line = (kind: TurnShownLine['kind'], a: number | null, b: number | null, shown: string, cut = false): TurnShownLine => {
  const start = shown.indexOf(TURN_SECRET_PLATE)
  return { kind, a, b, text: shown, masks: start === -1 ? [] : [[start, start + TURN_SECRET_PLATE.length]], cut }
}
const shown = (difference: TurnShownDifference, path = 'config/payments.yaml'): string =>
  renderToStaticMarkup(createElement(TurnDifference, { path, body: { state: 'shown', difference } }))
/** Each line as its two numbers, its sign and its text. */
const lines = (html: string): string[] => [...html.matchAll(/<div class="dl ([a-z ]+)"><span class="no">([^<]*)<\/span><span class="no">([^<]*)<\/span><span class="sg">([^<]*)<\/span><span class="tx">(.*?)<\/span><\/div>/g)]
  .map((match) => `${match[1]} ${match[2]}/${match[3]} ${match[4]}${text(match[5] ?? '')}`)

const PAYMENTS: TurnShownDifference = {
  state: 'text', added: 3, removed: 2, more: 0,
  hunks: [
    { aStart: 8, aLines: 5, bStart: 8, bLines: 6, secret: false, lines: [
      line(' ', 8, 8, 'provider: stripe'), line(' ', 9, 9, 'region: eu'), line(' ', 10, 10, `webhook_secret: ${TURN_SECRET_PLATE}`),
      line('-', 11, null, `api_key: ${TURN_SECRET_PLATE}`), line('+', null, 11, `api_key: ${TURN_SECRET_PLATE}`), line('+', null, 12, 'retries: 3'),
      line(' ', 12, 13, 'timeout_ms: 8000')
    ] },
    { aStart: 31, aLines: 3, bStart: 32, bLines: 3, secret: true, lines: [
      line(' ', 31, 32, 'sandbox:'), line('-', 32, null, `  signing_key: ${TURN_SECRET_PLATE}`), line('+', null, 33, `  signing_key: ${TURN_SECRET_PLATE}`), line(' ', 33, 34, '  retries: 1')
    ] }
  ]
}

describe('a file\'s difference', () => {
  it('is unified, with a sign at the start of a line, the numbers of the original texts, and one plate where a value stood in all three kinds of line', () => {
    const html = shown(PAYMENTS)
    expect(html).toContain('role="region" aria-label="Difference of config/payments.yaml"')
    expect(lines(html)).toEqual([
      'hunk / @@ −8,5 +8,6 @@',
      `ctx 8/8 provider: stripe`, 'ctx 9/9 region: eu', `ctx 10/10 webhook_secret: ${TURN_SECRET_PLATE}`,
      `del 11/ −api_key: ${TURN_SECRET_PLATE}`, `add /11 +api_key: ${TURN_SECRET_PLATE}`, 'add /12 +retries: 3', 'ctx 12/13 timeout_ms: 8000',
      'hunk / @@ −31,3 +32,3 @@Secret value changed',
      'ctx 31/32 sandbox:', `del 32/ −  signing_key: ${TURN_SECRET_PLATE}`, `add /33 +  signing_key: ${TURN_SECRET_PLATE}`, 'ctx 33/34   retries: 1'
    ])
    // One drawing of the plate for an unchanged, a removed and an added line.
    expect(html.match(/<span class="msk">••••••••••<\/span>/g)).toHaveLength(5)
    expect(html).toContain(`<span class="tx">webhook_secret: <span class="msk">${TURN_SECRET_PLATE}</span></span>`)
    expect(html).toContain('<span class="hunk-note">Secret value changed</span>')
    expect(html.match(/hunk-note/g)).toHaveLength(1)
  })

  it('hands a reader, a copy and Find the masked text only: nothing of a value is in the markup, in a name or in a title', () => {
    // What the window is given has no value in it; this is what it makes of that.
    const html = shown(PAYMENTS)
    expect(html).not.toMatch(SECRET)
    expect(text(html)).toContain(`api_key: ${TURN_SECRET_PLATE}`)
    expect(html).not.toMatch(/title="[^"]*api_key/)
    expect(html).not.toMatch(/reveal|show value/i)
    expect(html).not.toContain('<button')
  })

  it('keeps a key block of many lines as that many masked lines', () => {
    const block: TurnShownDifference = { state: 'text', added: 5, removed: 0, more: 0, hunks: [{ aStart: 1, aLines: 1, bStart: 1, bLines: 6, secret: false, lines: [
      line(' ', 1, 1, 'top'), ...[2, 3, 4, 5].map((b) => line('+', null, b, TURN_SECRET_PLATE)), line('+', null, 6, 'end')
    ] }] }
    expect(lines(shown(block, 'deploy/key.txt'))).toEqual([
      'hunk / @@ −1,1 +1,6 @@', 'ctx 1/1 top', ...[2, 3, 4, 5].map((b) => `add /${b} +${TURN_SECRET_PLATE}`), 'add /6 +end'
    ])
  })

  it('says how many lines are not shown when it knows, and that there are more when it does not', () => {
    const cutOff = (more: number | null): TurnShownDifference => ({ state: 'text', added: 3_110, removed: 2_102, more, hunks: [{ aStart: 4_317, aLines: 2, bStart: 4_902, bLines: 2, secret: false, lines: [
      line(' ', 4_317, 4_902, '  "sandbox": []'), line('-', 4_318, null, '  "prod": [', true), line('+', null, 4_903, '  "prod": [', true)
    ] }] })
    const known = shown(cutOff(212), 'data/origins.json')
    expect(text(known)).toContain('212 more lines not shown')
    expect(known).toContain('<div class="dl more">')
    expect(text(shown(cutOff(null)))).toContain('More lines not shown')
    expect(text(shown(cutOff(null)))).not.toMatch(/\d+ more lines/)
    expect(text(shown(cutOff(0)))).not.toMatch(/not shown/)
    // A line cut at 2,000 characters carries its mark; the numbers are those of the original texts.
    expect(known).toContain('<div class="dl del cutline"><span class="no">4,318</span><span class="no"></span>')
    expect(known.match(/<span class="cut-mark">cut at 2,000 characters<\/span>/g)).toHaveLength(2)
    expect(known).toMatch(/--no:\s*7ch/)
  })

  it('reads a binary file as changed with both sizes, a difference out of time as unavailable, and the mark for a last line without an ending', () => {
    expect(text(shown({ state: 'binary', sizeBefore: 18_637, sizeAfter: 22_221 }, 'assets/logo.png'))).toBe('Binary file changed18.2 KiB before, 21.7 KiB after')
    expect(text(shown({ state: 'binary', sizeBefore: null, sizeAfter: 512 }))).toBe('Binary file changednot there before, 512 B after')
    const unavailable = renderToStaticMarkup(createElement(TurnDifference, { path: 'db/seed.sql', body: { state: 'unavailable', words: 'Difference unavailable: limit reached' } }))
    expect(unavailable).toBe('<p class="file-body"><span>Difference unavailable: limit reached</span></p>')
    expect(renderToStaticMarkup(createElement(TurnDifference, { path: 'a', body: { state: 'reading' } }))).toContain('Reading the difference…')
    const ending = shown({ state: 'text', added: 1, removed: 0, more: 0, hunks: [{ aStart: 1, aLines: 1, bStart: 1, bLines: 2, secret: false, lines: [line(' ', 1, 1, 'a'), line('+', null, 2, 'b'), { kind: '\\' }] }] })
    expect(lines(ending).at(-1)).toBe('hunk / No line ending at the end of the file')
  })

  it('opens in place under its row, several at once, each row saying that it is open', () => {
    const bodies = new Map<string, TurnFileBody>([
      ['.env.example', { state: 'shown', difference: PAYMENTS }],
      ['assets/logo.png', { state: 'shown', difference: { state: 'binary', sizeBefore: 18_637, sizeAfter: 22_221 } }],
      ['src/legacy/coupons.ts', { state: 'reading' }]
    ])
    const html = dialog({ opened: opened(), bodies })
    expect(fileRows(html).filter((row) => row.startsWith('v'))).toEqual(['v .env.example changed +1 −1', 'v assets/logo.png binary', 'v src/legacy/coupons.ts removed  −20'])
    expect(html.match(/<li class="pinned">/g)).toHaveLength(3)
    expect(html).toContain('</button><div class="turn-diff" role="region" aria-label="Difference of .env.example"')
    expect(html).toContain('</button><p class="file-body"><span>Binary file changed</span>')
    expect(html).toContain('</button><p class="file-body"><small>Reading the difference…</small></p>')
    // A file that cannot be opened has no state of open or closed to tell.
    expect(html).toMatch(/class="file-row" disabled="">/)
  })
})

describe('the header plate', () => {
  const plate = (given: TurnSessionView | null): string => renderToStaticMarkup(createElement(TurnPlate, { view: given, now: NOW, onOpen: noop }))

  it('is one button that holds both of its wordings, named by what it says', () => {
    const html = plate(view())
    expect(html).toBe('<button type="button" class="turn-plate" data-turn-plate="s1" aria-haspopup="dialog" title="Turn changes: the latest turn, 14:32. 4 files +120 −33" ' +
      'aria-label="Turn changes: the latest turn, 14:32. 4 files +120 −33"><span class="full"><span>4 files +120</span><span class="old"> −33</span></span>' +
      '<span class="short"><span>4 files</span></span></button>')
  })

  it('is gold only where the latest turn has no complete totals, and plain beside a state of recording', () => {
    const partial = plate(view({ latest: turn('t-1', { totalsState: 'partial', wording: TURN_WORDINGS.partial(3) }) }))
    expect(partial).toContain('<span class="caveat"> partial</span>')
    expect(partial).toContain('<span class="short"><span class="caveat">Partial</span></span>')
    expect(plate(view({ latest: none('t-1', TURN_WORDINGS.incomplete('100 MiB read')) }))).toContain('<span class="short"><span class="caveat">No totals</span></span>')
    for (const given of [view({ state: 'off' }), view({ state: 'paused', pauseReason: 'incomplete' }), view({ state: 'not-supported', app: 'opencode' })]) {
      expect(plate(given)).not.toContain('caveat')
      expect(plate(given)).toContain('<span class="old"> · 4 files</span>')
    }
    expect(plate(view({ state: 'not-supported', app: 'opencode' }))).toContain('<span class="short"><span>Not supported</span></span>')
  })

  it('is not there for a session without a kept turn', () => {
    expect(plate(null)).toBe('')
    expect(plate(view({ latest: null }))).toBe('')
  })
})

describe('the card of a paused recording', () => {
  const card = (change: Partial<TurnSessionView> = {}): string => renderToStaticMarkup(createElement(TurnPauseCard, {
    state: view({ state: 'paused', pausedRoot: '/home/synthetic/code/shop', pauseReason: 'incomplete', ...change }),
    place: { workspace: 'Shop', session: 'api-agent' }, home: '/home/synthetic', anchor: null, onClose: noop
  }))

  it('says where and why in fixed words, and only closes: Resume is in the workspace\'s menu', () => {
    const html = card()
    expect(html).toContain('role="dialog" aria-label="Turn changes"')
    expect(html).toContain('<header><strong>Paused</strong><span>stays on this computer</span>')
    expect(html).toContain('<h3>Recording what each turn changes is paused here</h3>')
    expect(html).toContain('<dt>Work tree</dt><dd class="mono" title="/home/synthetic/code/shop">~/code/shop</dd>')
    expect(html).toContain(`<dt>Reason</dt><dd>${TURN_PAUSE_REASONS.incomplete}</dd>`)
    expect(html).toContain('<span class="attention-kind">Claude Code</span>')
    expect(text(html)).toContain("Resume is in this workspace's menu and sets the count back to zero.")
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1])).toEqual(['×', 'Close'])
  })

  it.each(['failed', 'incomplete', 'mixed'] as const)('gives the reason "%s" from the fixed list', (reason) => {
    expect(card({ pauseReason: reason })).toContain(`<dd>${TURN_PAUSE_REASONS[reason]}</dd>`)
  })
})
