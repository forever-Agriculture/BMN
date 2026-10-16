// MODULE: team-asks.test.ts - Story 73.1 markup and words: Agents › Asks as a read-only record of his agents' asks: each line's fields and outcome, why a run ended, Stop on a running line, an opened ask with hostile answers kept as plain text, removal and retention, over synthetic asks
import type { TeamAskDetail, TeamAskLine, TeamAskReads, TeamAsksSnapshot } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ASK_OUTCOME_WORDS, TeamAsks, costWords, elapsedMs, fullUsageWords, outcomeWords, pictureWords, projectStateWords, readsWords, shortTook, sizeWords, subagentWords, usageWords, type TeamAsksProps } from './team-asks'

const NOW = new Date(2026, 9, 15, 4, 0)
const at = (hour: number, minute: number, second = 0, day = 15): string => new Date(2026, 9, day, hour, minute, second).toISOString()
/** A run made before 72.9: the question and its files, its mode not recorded. */
const TEXT = (files = 0, pictures = 0): TeamAskReads => ({ form: null, scope: 'text', reach: null, words: null, folder: null, files, pictures })
const CODEX_WORDS = 'Codex\'s read-only sandbox: any file your user can read, with its shell, Git, web search and sub-agents; it writes nothing'
/** A 72.9 Codex ask: its read-only sandbox, working in the project. */
const CODEX = (files = 0): TeamAskReads => ({ form: 'codex-read-only', scope: 'computer', reach: 'any file your user can read', words: CODEX_WORDS, folder: '/home/made-up/code/shop', files, pictures: 0 })
const line = (fields: Partial<TeamAskLine>): TeamAskLine => ({
  id: '20261015T034100-7c2e91ab', question: 'Does the invoice total round the same way in the PDF and the API?', by: { kind: 'session', session: 's-1', app: 'claude' },
  agent: 'astra', agentName: 'Astra', effort: 'medium', role: 'focused-reviewer', project: '/home/made-up/code/shop', data: 'private',
  reads: TEXT(2), askedAt: at(3, 41), startedAt: at(3, 41), endedAt: at(3, 43, 4), timeLimitMinutes: 30, state: 'answered',
  usage: { input: 7817, cached: 2816, output: 33, reasoning: 20, reportedCost: null, billing: 'subscription', complete: null, incompleteReason: null, basis: null }, keptUntil: at(3, 43, 4, 14), ...fields
})
const ANSWERED = line({})
const RUNNING = line({ id: '20261015T035800-0000aaaa', question: 'Is the checkout retry safe when the payment webhook arrives twice?', askedAt: at(3, 58), startedAt: at(3, 55, 48), endedAt: null, state: 'running', usage: null, keptUntil: null, now: at(4, 0), reads: TEXT(3) })
const REFUSED = line({ id: '20261015T021200-0000bbbb', question: 'Review the migration plan for the orders table before I run it.', by: { kind: 'shell' }, agent: 'opus', agentName: 'Opus', effort: 'xhigh', role: 'lead', project: '/home/made-up/code/invoices', reads: TEXT(), askedAt: at(2, 12), startedAt: null, endedAt: at(2, 12), state: 'refused', refusalCode: 'CHECK_FAILED', reason: 'the check refused the command: Opus is off since 13 Oct', usage: null })
const LOST = line({ id: '20261014T230700-0000cccc', question: 'Which tests cover the coupon code path?', by: { kind: 'session', session: 's-9' }, agentName: 'Luna', effort: 'max', role: 'helper', reads: TEXT(), askedAt: at(23, 7, 0, 14), startedAt: at(23, 7, 0, 14), endedAt: at(23, 8, 31, 14), state: 'not-attributed', reason: 'the events named a second session', usage: { input: 3204, cached: null, output: 412, reasoning: null, reportedCost: null, billing: 'subscription', complete: null, incompleteReason: null, basis: null } })
const LATE = line({ id: '20261014T214000-0000dddd', question: 'Summarise the public changelog since 3.2.', by: { kind: 'session', session: 's-1', app: 'opencode' }, agentName: 'Luna (Go)', effort: 'max', role: 'helper', data: 'public', reads: TEXT(), askedAt: at(21, 40, 0, 14), startedAt: at(21, 40, 0, 14), endedAt: at(22, 10, 0, 14), state: 'out-of-time', reason: 'OpenCode was still waiting on its provider', usage: null })

const snapshot = (fields: Partial<TeamAsksSnapshot> = {}): TeamAsksSnapshot => ({ asks: [RUNNING, ANSWERED, REFUSED, LOST, LATE], places: { used: 1, capacity: 4 }, keptDays: 30, ...fields })
const sessionName = (id: string): string | undefined => ({ 's-1': 'bash' } as Record<string, string>)[id]
const render = (fields: Partial<TeamAsksProps> = {}): string => renderToStaticMarkup(createElement(TeamAsks, {
  snapshot: snapshot(), busy: false, home: '/home/made-up', sessionName, detail: async () => { throw new Error('not read in a static render') },
  stop: () => {}, remove: () => {}, exportAsk: () => {}, copy: () => {}, now: NOW, ...fields
}))
/** The text a reader gets, tags gone. */
const words = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const HOSTILE = 'Both round differently (src/api/invoice.ts:88).\n\n[the fix](javascript:alert(1)) <img src="https://x.test/p.png"> <script>alert(1)</script> **bold** <a href="https://x.test">link</a>'
const detail = (fields: Partial<TeamAskDetail> = {}): TeamAskDetail => ({
  line: ANSWERED, question: 'Does the invoice total round the same way in the PDF and the API?\nOrders with a coupon differ by one cent.', questionWhole: true, answer: HOSTILE,
  files: [{ path: '/home/made-up/code/shop/src/invoice/total.ts', bytes: 4100 }, { path: '/home/made-up/code/shop/src/api/invoice.ts', bytes: 6800 }], pictures: [], project: null, browser: null,
  teammate: { app: 'codex', appName: 'Codex', appVersion: '0.162.1', model: 'gpt-6-astra', session: '01a13c80-made-up', sessionSource: 'thread.started' }, subagents: [], masked: [], ...fields
})

describe('the words of Agents › Asks', () => {
  it('has one or two plain words for every outcome, and words for one it does not know', () => {
    expect(ASK_OUTCOME_WORDS).toEqual({ running: 'Asking now', answered: 'Answered', failed: 'Failed', refused: 'Refused', 'out-of-time': 'Out of time', stopped: 'Stopped', 'not-attributed': 'Not attributed', interrupted: 'Cut short' })
    expect(outcomeWords('some-new-state')).toBe('Some new state')
  })

  it('says what was readable, times, sizes and usage as the record has them, "unknown" where it does not', () => {
    expect(readsWords(TEXT(), 'private')).toBe('the question only')
    expect(readsWords(TEXT(1), 'private')).toBe('the question and 1 file')
    expect(readsWords(TEXT(0, 2), 'public')).toBe('the question and 2 pictures · public')
    expect(readsWords({ ...TEXT(), scope: 'folder', reach: 'a copy of the project as it was', folder: '/home/made-up/code/shop' }, 'private')).toBe('the question and a copy of the project as it was')
    expect([48_000, 252_000, 1_800_000].map(shortTook)).toEqual(['48 s', '4 min 12 s', '30 min'])
    expect(elapsedMs(ANSWERED)).toBe(124_000)
    expect(elapsedMs(RUNNING)).toBe(252_000)
    expect(elapsedMs(REFUSED)).toBeNull()
    expect(sizeWords(4100)).toBe('4.1 KB')
    expect(sizeWords(2_800_000)).toBe('2.8 MB')
    expect(usageWords(ANSWERED)).toBe('7,817 in · 33 out · cost unknown · subscription')
    expect(usageWords({ state: 'answered', usage: { input: 9412, cached: 0, output: 188, reasoning: null, reportedCost: 0.0391, billing: 'per_token', complete: null, incompleteReason: null, basis: null } })).toBe('9,412 in · 188 out · $0.0391 · paid per token')
    expect(usageWords({ state: 'answered', usage: { input: 213, cached: 0, output: 13, reasoning: 36, reportedCost: 0.0000458, billing: 'unknown', complete: null, incompleteReason: null, basis: null } })).toBe('213 in · 13 out · under $0.0001 · billing unknown')
    expect(costWords(0)).toBe('$0.0000')
    expect(usageWords(RUNNING)).toBe('usage at the end')
    expect(usageWords(REFUSED)).toBe('no usage')
    expect(usageWords(LATE)).toBe('usage unknown')
    expect(fullUsageWords(ANSWERED.usage)).toBe('7,817 in · 2,816 cached · 33 out · 20 reasoning · cost unknown · subscription')
    expect(pictureWords({ label: 'checkout.png', bytes: 214_000, mediaType: 'image/png', width: 1280, height: 900, removed: ['text chunks'] })).toBe('checkout.png · 1280 × 900 · 214 KB · PNG · took out: text chunks')
  })

  it('says what the teammate\'s own mode could read, the project\'s state at each end, each sub-agent and a usage not wholly read (72.9 AC5, AC6)', () => {
    expect(readsWords(CODEX(1), 'private')).toBe('the question, 1 file and any file your user can read')
    expect(readsWords({ ...CODEX(), form: 'claude-read-tools', scope: 'folder', reach: 'its working folder' }, 'private')).toBe('the question and its working folder')
    expect(projectStateWords({ commit: 'a1b2c3d4e5f6a7b8c9d0', clean: true, changed: 0, reason: null })).toBe('a1b2c3d4e5f6, clean')
    expect(projectStateWords({ commit: 'a1b2c3d4e5f6a7b8c9d0', clean: false, changed: 1, reason: null })).toBe('a1b2c3d4e5f6, 1 change')
    expect(projectStateWords({ commit: null, clean: null, changed: null, reason: null })).toBe('not a Git working tree')
    expect(projectStateWords(null)).toBe('not read')
    const counted = { input: 2410, cached: 0, output: 96, reasoning: 12, reportedCost: null, billing: 'subscription', complete: true, incompleteReason: null, basis: null }
    expect(subagentWords({ session: '019a-made-up', name: 'check the tests', role: 'explorer', kind: 'Codex sub-agent', model: 'gpt-6-astra', effort: 'high', usage: counted, usageNote: null, ownTokens: null }))
      .toBe('check the tests · Codex sub-agent · gpt-6-astra high · 2,410 in · 96 out')
    expect(subagentWords({ session: 'task-1', name: null, role: 'Explore', kind: 'Claude Code sub-agent', model: null, effort: null, usage: null, usageNote: 'counted in the run\'s total', ownTokens: 18_204 }))
      .toBe('Explore · Claude Code sub-agent · counted in the run\'s total · 18,204 tokens of its own')
    const incomplete = { ...counted, complete: false, incompleteReason: 'a sub-agent\'s usage could not be read from its rollout' }
    expect(usageWords({ state: 'answered', usage: incomplete })).toBe('2,410 in · 96 out · cost unknown · subscription · incomplete')
    expect(fullUsageWords(incomplete)).toBe('2,410 in · 0 cached · 96 out · 12 reasoning · cost unknown · subscription · incomplete: a sub-agent\'s usage could not be read from its rollout')
  })
})

describe('Agents › Asks', () => {
  it('lists every ask newest first with when, who asked whom at which effort, the role, the project, what was readable, the time, the usage and the outcome (AC2)', () => {
    const html = render()
    const text = words(html)
    expect(text).toContain('Every ask your agents\', newest first')
    expect(text).toContain('Asks 1 of 4 places in use')
    expect(text).toContain('Today 03:41 bash (Claude Code) asked Astra medium Focused reviewer ~/code/shop the question and 2 files 2 min 4 s 7,817 in · 33 out · cost unknown · subscription Answered')
    expect(html.indexOf(RUNNING.id)).toBeLessThan(html.indexOf(ANSWERED.id))
    expect(html.indexOf(ANSWERED.id)).toBeLessThan(html.indexOf(REFUSED.id))
  })

  it('a running ask shows its time against its limit and a Stop; an ended one has none (AC2)', () => {
    const text = words(render())
    expect(text).toContain('Today 03:58 bash (Claude Code) asked Astra medium Focused reviewer ~/code/shop the question and 3 files 4 min 12 s of 30 min usage at the end Asking now Stop')
    expect((render().match(/>Stop</g) ?? []).length).toBe(1)
    expect(render()).toContain('aria-label="Stop the ask to Astra"')
  })

  it('a refusal, a lost attribution and a run out of time say why on the line itself (AC2)', () => {
    const text = words(render())
    expect(text).toContain('A shell asked Opus xhigh Lead ~/code/invoices the question only no usage the check refused the command: Opus is off since 13 Oct Refused')
    expect(text).toContain('A closed session\'s shell asked Luna max Helper ~/code/shop the question only 1 min 31 s 3,204 in · 412 out · cost unknown · subscription the events named a second session Not attributed')
    expect(text).toContain('bash (OpenCode) asked Luna (Go) max Helper ~/code/shop the question only · public 30 min usage unknown OpenCode was still waiting on its provider Out of time')
  })

  it('is a record, not a place to ask: no Ask button, no question field, no panel', () => {
    const html = render()
    expect(words(html)).not.toMatch(/Ask a teammate/u)
    expect(html).not.toMatch(/<textarea|<input/u)
  })

  it('opens an ask in place: the whole question, what was readable, who answered, the answer as the teammate\'s plain words, usage, time and its actions (AC3)', () => {
    const text = words(render({ initiallyOpen: ANSWERED.id, initialDetail: detail() }))
    expect(text).toContain('Does the invoice total round the same way in the PDF and the API? Orders with a coupon differ by one cent.')
    expect(text).toContain('Readable the question and 2 files · ~/code/shop/src/invoice/total.ts 4.1 KB · ~/code/shop/src/api/invoice.ts 6.8 KB')
    expect(text).toContain('Teammate Astra · Codex 0.162.1 · gpt-6-astra · medium · session 01a13c80-made-up from thread.started')
    expect(text).toContain('Answer · Astra\'s words, shown as plain text')
    expect(text).toContain('Usage 7,817 in · 2,816 cached · 33 out · 20 reasoning · cost unknown · subscription')
    expect(text).toMatch(/Took 2 minutes 4 seconds of 30 minutes · kept until \S+ \S+ 2026 · run 20261015T034100-7c2e91ab/u)
    expect(text).toContain('Copy Export… Remove')
  })

  it('keeps a hostile answer literal: no link, picture, script or markup is made of it (AC3)', () => {
    const html = render({ initiallyOpen: ANSWERED.id, initialDetail: detail() })
    expect(html).not.toMatch(/<img|<script|<a |<strong|<b>bold/u)
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('&lt;img src=&quot;https://x.test/p.png&quot;&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('[the fix](javascript:alert(1))')
    expect(html).toContain('**bold**')
  })

  it('an opened browser ask lists its pages and screenshots as plain lines: a hostile title or address makes no link, picture or markup (74.3 AC3)', () => {
    const browser = { origin: 'http://127.0.0.1:4173', interact: false, limit: 'Playwright keeps the browser\'s requests to this address, but it is not a security boundary: a redirect can leave it. Downloads are refused.',
      pages: [{ url: 'http://127.0.0.1:4173/?q=<script>alert(1)</script>', title: '<img src=x onerror=alert(1)> [pay](javascript:alert(1)) **Shop**' }, { url: 'http://127.0.0.1:4173/empty', title: null }],
      screenshots: [{ name: 'page-<b>1</b>.png', bytes: 14_336 }] }
    const browsing = line({ reads: { ...CODEX(), browser: { origin: browser.origin, interact: false } } })
    const html = render({ snapshot: snapshot({ asks: [browsing] }), initiallyOpen: browsing.id, initialDetail: detail({ line: browsing, files: [], browser }) })
    expect(html).not.toMatch(/<img|<script|<a |<strong|<b>1/u)
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('http://127.0.0.1:4173/?q=&lt;script&gt;alert(1)&lt;/script&gt; · &lt;img src=x onerror=alert(1)&gt; [pay](javascript:alert(1)) **Shop**')
    expect(html).toContain('page-&lt;b&gt;1&lt;/b&gt;.png')
    const text = words(html)
    expect(text).toContain('the question, any file your user can read and the app at http://127.0.0.1:4173, looking only')
    expect(text).toContain('http://127.0.0.1:4173/empty')
    expect(text).toContain("The app's own text, shown as plain text")
    expect(text).toContain('page-<b>1</b>.png 14 KB')
    // The origin limit is said where the owner reads the ask (full review).
    expect(text).toContain('Its limit Playwright keeps the browser\'s requests to this address, but it is not a security boundary: a redirect can leave it. Downloads are refused.')
    // While it runs, the record of pages is not written yet, and says so.
    const going = line({ ...RUNNING, reads: { ...CODEX(), browser: { origin: browser.origin, interact: true } } })
    const running = words(render({ snapshot: snapshot({ asks: [going] }), initiallyOpen: going.id, initialDetail: detail({ line: going, answer: null, files: [], browser: { ...browser, interact: true, pages: [], screenshots: [] } }) }))
    expect(running).toContain('the app at http://127.0.0.1:4173, clicking and typing')
    expect(running).toContain('Pages Recorded when the ask ends. Screenshots Recorded when the ask ends.')
  })

  it('an opened refused or lost ask shows why and no answer; a running one says it is answering and cannot be removed', () => {
    const lost = words(render({ initiallyOpen: LOST.id, initialDetail: detail({ line: LOST, answer: null }) }))
    expect(lost).toContain('Not attributed: the events named a second session')
    expect(lost).not.toContain('words, shown as plain text')
    const running = render({ initiallyOpen: RUNNING.id, initialDetail: detail({ line: RUNNING, answer: null }) })
    expect(words(running)).toContain('Astra is answering. The answer shows here when the ask ends.')
    expect(running).toMatch(/<button type="button" class="small" disabled="" title="Stop the ask first">Remove<\/button>/u)
  })

  it('opens a 72.9 ask with its mode and where it worked, the project at the start and the end, its sub-agents, how usage was counted and what BMN masked (72.9 AC5, AC6)', () => {
    const basis = 'the teammate\'s own turns (turn.completed) plus each sub-agent\'s own rollout (its last token count), each counted once'
    const asked = line({ reads: CODEX(), usage: { input: 9817, cached: 2816, output: 129, reasoning: 20, reportedCost: null, billing: 'subscription', complete: true, incompleteReason: null, basis } })
    const text = words(render({ snapshot: snapshot({ asks: [asked] }), initiallyOpen: asked.id, initialDetail: detail({
      line: asked, files: [], project: { root: '/home/made-up/code/shop', start: { commit: 'a1b2c3d4e5f6a7b8', clean: true, changed: 0, reason: null }, end: { commit: 'a1b2c3d4e5f6a7b8', clean: false, changed: 1, reason: null } },
      subagents: [{ session: '019a-made-up', name: 'check the tests', role: 'explorer', kind: 'Codex sub-agent', model: 'gpt-6-astra', effort: 'high', usage: { input: 2000, cached: 0, output: 96, reasoning: 0, reportedCost: null, billing: 'subscription', complete: true, incompleteReason: null, basis: null }, usageNote: null, ownTokens: null }],
      masked: ['an OpenAI key']
    }) }))
    expect(text).toContain('Readable the question and any file your user can read')
    expect(text).toContain(`Its mode ${CODEX_WORDS} · worked in ~/code/shop`)
    expect(text).toContain('Project ~/code/shop · at the start a1b2c3d4e5f6, clean · at the end a1b2c3d4e5f6, 1 change')
    expect(text).toContain('Sub-agents check the tests · Codex sub-agent · gpt-6-astra high · 2,000 in · 96 out')
    expect(text).toContain('BMN masked what looked like an OpenAI key in the answer and the app\'s output, here, in the record and in an export.')
    expect(text).toContain(`Counted ${basis}`)
  })

  it('lists a picture ask\'s pictures as lines under Readable, with what was taken out', () => {
    const pictures = [{ label: 'checkout-1280.png', bytes: 214_000, mediaType: 'image/png', width: 1280, height: 900, removed: ['text chunks'] }]
    const text = words(render({ initiallyOpen: ANSWERED.id, initialDetail: detail({ pictures }) }))
    expect(text).toContain('Pictures checkout-1280.png · 1280 × 900 · 214 KB · PNG · took out: text chunks')
  })

  it('says how long an ask is kept beside Remove all, and asks before removing all; an ask under way stays (AC3)', () => {
    expect(words(render())).toContain('5 asks kept. An ask stays 30 days after it ends, or until removed; Export writes the allowlisted record, never a sign-in or the app\'s home. Remove all…')
  })

  it('says so when nothing was asked yet, with nothing to remove', () => {
    const text = words(render({ snapshot: snapshot({ asks: [], places: { used: 0, capacity: 4 } }) }))
    expect(text).toContain('No asks yet. Your agents\' asks are kept here with their answers, 30 days after each ends.')
    expect(text).not.toContain('Remove all')
  })

  it('uses the panel pattern only: no native select, no colour of its own, every button a plate or a line', () => {
    const html = render({ initiallyOpen: ANSWERED.id, initialDetail: detail() })
    expect(html).not.toContain('<select')
    expect(html).not.toMatch(/style="[^"]*colou?r/u)
  })
})
