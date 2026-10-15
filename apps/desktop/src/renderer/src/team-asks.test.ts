// MODULE: team-asks.test.ts - Story 73.1 markup and words: Team › Asks as a read-only record of his agents' asks: each line's fields and outcome, why a run ended, Stop on a running line, an opened ask with hostile answers kept as plain text, removal and retention, over synthetic asks
import type { TeamAskDetail, TeamAskLine, TeamAsksSnapshot } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ASK_OUTCOME_WORDS, TeamAsks, costWords, elapsedMs, fullUsageWords, outcomeWords, pictureWords, readsWords, shortTook, sizeWords, usageWords, type TeamAsksProps } from './team-asks'

const NOW = new Date(2026, 9, 15, 4, 0)
const at = (hour: number, minute: number, second = 0, day = 15): string => new Date(2026, 9, day, hour, minute, second).toISOString()
const line = (fields: Partial<TeamAskLine>): TeamAskLine => ({
  id: '20261015T034100-7c2e91ab', question: 'Does the invoice total round the same way in the PDF and the API?', by: { kind: 'session', session: 's-1', app: 'claude' },
  agent: 'astra', agentName: 'Astra', effort: 'medium', role: 'focused-reviewer', project: '/home/made-up/code/shop', data: 'private',
  reads: { access: 'files', files: 2, pictures: 0 }, askedAt: at(3, 41), startedAt: at(3, 41), endedAt: at(3, 43, 4), timeLimitMinutes: 30, state: 'answered',
  usage: { input: 7817, cached: 2816, output: 33, reasoning: 20, reportedCost: null, billing: 'subscription' }, keptUntil: at(3, 43, 4, 14), ...fields
})
const ANSWERED = line({})
const RUNNING = line({ id: '20261015T035800-0000aaaa', question: 'Is the checkout retry safe when the payment webhook arrives twice?', askedAt: at(3, 58), startedAt: at(3, 55, 48), endedAt: null, state: 'running', usage: null, keptUntil: null, now: at(4, 0), reads: { access: 'files', files: 3, pictures: 0 } })
const REFUSED = line({ id: '20261015T021200-0000bbbb', question: 'Review the migration plan for the orders table before I run it.', by: { kind: 'shell' }, agent: 'opus', agentName: 'Opus', effort: 'xhigh', role: 'lead', project: '/home/made-up/code/invoices', reads: { access: 'question', files: 0, pictures: 0 }, askedAt: at(2, 12), startedAt: null, endedAt: at(2, 12), state: 'refused', refusalCode: 'CHECK_FAILED', reason: 'the check refused the command: Opus is off since 13 Oct', usage: null })
const LOST = line({ id: '20261014T230700-0000cccc', question: 'Which tests cover the coupon code path?', by: { kind: 'session', session: 's-9' }, agentName: 'Luna', effort: 'max', role: 'helper', reads: { access: 'question', files: 0, pictures: 0 }, askedAt: at(23, 7, 0, 14), startedAt: at(23, 7, 0, 14), endedAt: at(23, 8, 31, 14), state: 'not-attributed', reason: 'the events named a second session', usage: { input: 3204, cached: null, output: 412, reasoning: null, reportedCost: null, billing: 'subscription' } })
const LATE = line({ id: '20261014T214000-0000dddd', question: 'Summarise the public changelog since 3.2.', by: { kind: 'session', session: 's-1', app: 'opencode' }, agentName: 'Luna (Go)', effort: 'max', role: 'helper', data: 'public', reads: { access: 'question', files: 0, pictures: 0 }, askedAt: at(21, 40, 0, 14), startedAt: at(21, 40, 0, 14), endedAt: at(22, 10, 0, 14), state: 'out-of-time', reason: 'OpenCode was still waiting on its provider', usage: null })

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
  teammate: { app: 'codex', appName: 'Codex', appVersion: '0.162.1', model: 'gpt-6-astra', session: '01a13c80-made-up', sessionSource: 'thread.started' }, ...fields
})

describe('the words of Team › Asks', () => {
  it('has one or two plain words for every outcome, and words for one it does not know', () => {
    expect(ASK_OUTCOME_WORDS).toEqual({ running: 'Asking now', answered: 'Answered', failed: 'Failed', refused: 'Refused', 'out-of-time': 'Out of time', stopped: 'Stopped', 'not-attributed': 'Not attributed', interrupted: 'Cut short' })
    expect(outcomeWords('some-new-state')).toBe('Some new state')
  })

  it('says what was readable, times, sizes and usage as the record has them, "unknown" where it does not', () => {
    expect(readsWords({ access: 'question', files: 0, pictures: 0 }, 'private')).toBe('the question only')
    expect(readsWords({ access: 'files', files: 1, pictures: 0 }, 'private')).toBe('the question and 1 file')
    expect(readsWords({ access: 'question', files: 0, pictures: 2 }, 'public')).toBe('the question and 2 pictures · public')
    expect(readsWords({ access: 'project', files: 0, pictures: 0 }, 'private')).toBe('the question and the project')
    expect([48_000, 252_000, 1_800_000].map(shortTook)).toEqual(['48 s', '4 min 12 s', '30 min'])
    expect(elapsedMs(ANSWERED)).toBe(124_000)
    expect(elapsedMs(RUNNING)).toBe(252_000)
    expect(elapsedMs(REFUSED)).toBeNull()
    expect(sizeWords(4100)).toBe('4.1 KB')
    expect(sizeWords(2_800_000)).toBe('2.8 MB')
    expect(usageWords(ANSWERED)).toBe('7,817 in · 33 out · cost unknown · subscription')
    expect(usageWords({ state: 'answered', usage: { input: 9412, cached: 0, output: 188, reasoning: null, reportedCost: 0.0391, billing: 'per_token' } })).toBe('9,412 in · 188 out · $0.0391 · paid per token')
    expect(usageWords({ state: 'answered', usage: { input: 213, cached: 0, output: 13, reasoning: 36, reportedCost: 0.0000458, billing: 'unknown' } })).toBe('213 in · 13 out · under $0.0001 · billing unknown')
    expect(costWords(0)).toBe('$0.0000')
    expect(usageWords(RUNNING)).toBe('usage at the end')
    expect(usageWords(REFUSED)).toBe('no usage')
    expect(usageWords(LATE)).toBe('usage unknown')
    expect(fullUsageWords(ANSWERED.usage)).toBe('7,817 in · 2,816 cached · 33 out · 20 reasoning · cost unknown · subscription')
    expect(pictureWords({ label: 'checkout.png', bytes: 214_000, mediaType: 'image/png', width: 1280, height: 900, removed: ['text chunks'] })).toBe('checkout.png · 1280 × 900 · 214 KB · PNG · took out: text chunks')
  })
})

describe('Team › Asks', () => {
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

  it('an opened refused or lost ask shows why and no answer; a running one says it is answering and cannot be removed', () => {
    const lost = words(render({ initiallyOpen: LOST.id, initialDetail: detail({ line: LOST, answer: null }) }))
    expect(lost).toContain('Not attributed: the events named a second session')
    expect(lost).not.toContain('words, shown as plain text')
    const running = render({ initiallyOpen: RUNNING.id, initialDetail: detail({ line: RUNNING, answer: null }) })
    expect(words(running)).toContain('Astra is answering. The answer shows here when the ask ends.')
    expect(running).toMatch(/<button type="button" class="small" disabled="" title="Stop the ask first">Remove<\/button>/u)
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
