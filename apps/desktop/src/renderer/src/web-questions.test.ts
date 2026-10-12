// MODULE: web-questions.test.ts - Story 64.3 markup and words: the list, an opened question, each mark, the refusals' place, the switch and the removal, over synthetic questions
import type { WebQuestionView, WebQuestionsSnapshot } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OUTCOME_WORDS, WebQuestions, askWaits, askerName, evidenceWords, firstLine, tookWords, whenWords, type WebQuestionsProps } from './web-questions'

const NOW = new Date(2026, 9, 12, 15, 0)
const at = (hour: number, minute: number, day = 12): string => new Date(2026, 9, day, hour, minute).toISOString()
const USES = 'https://www.docs.example.org/jev/uses'
const ANSWERED: WebQuestionView = {
  id: 'q-answered', at: at(14, 2), by: { kind: 'session', session: 's-1', app: 'claude' }, researcher: 'Haiku', outcome: 'answered',
  question: 'How do people use the Jev 1.13 model?\nName the page for each claim.',
  answer: 'People use Jev mostly to route requests by intent.',
  claims: [
    { claim: 'A vendor page lists four patterns.', source: 'https://gone.example.org/jev', passage: 'four patterns: speculative fan-out', mark: 'page not readable', why: 'the site answered 404' },
    { claim: 'Jev is used for intent routing.', source: USES, passage: 'Teams use Jev for intent routing', mark: 'passage found on the page' },
    { claim: 'Urgency detection is a common use.', source: USES, passage: 'urgency detection is common', mark: 'page read, passage not found' }
  ],
  notFound: ['an independent accuracy measurement'], counts: { found: 1, not_found: 1, unreadable: 1 }, tookMs: 72_000
}
const REFUSED: WebQuestionView = { id: 'q-refused', at: at(9, 30, 11), by: { kind: 'shell' }, researcher: null, question: null, outcome: 'refused',
  note: 'word 2 of the question looks like a key or a password; nothing was sent' }
const STOPPED: WebQuestionView = { id: 'q-stopped', at: at(13, 0), by: { kind: 'owner' }, researcher: 'Luna', question: 'What is a context window?', outcome: 'stopped', tookMs: 4000 }
const RUNNING: WebQuestionView = { id: 'q-running', at: at(14, 58), by: { kind: 'session', session: 's-2' }, researcher: 'Haiku', question: 'Which sites list model prices?', outcome: 'running' }

const snapshot = (fields: Partial<WebQuestionsSnapshot> = {}): WebQuestionsSnapshot => ({
  questions: [ANSWERED, STOPPED, REFUSED], holder: null, agentsMayAsk: true, today: 3, limits: { perDay: 20, minutes: 10, characters: 2000, kept: 200 }, ...fields
})
const sessionName = (id: string): string | undefined => ({ 's-1': 'bmn-ui' } as Record<string, string>)[id]
const render = (fields: Partial<WebQuestionsProps> = {}): string => renderToStaticMarkup(createElement(WebQuestions, {
  snapshot: snapshot(), researcher: 'Haiku', busy: false, sessionName, ask: async () => null, stop: () => {}, allow: () => {}, remove: () => {}, openPage: () => {}, now: NOW, ...fields
}))
/** The text a reader gets, tags gone. */
const words = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('the words of the web questions part', () => {
  it('names who asked: the owner, a shell, a session by the name it has now, with its app or its shell', () => {
    expect(askerName({ kind: 'owner' }, sessionName)).toBe('You')
    expect(askerName({ kind: 'shell' }, sessionName)).toBe('A shell')
    expect(askerName({ kind: 'session', session: 's-1', app: 'claude' }, sessionName)).toBe('bmn-ui (Claude Code)')
    expect(askerName({ kind: 'session', session: 's-1', app: 'codex' }, sessionName)).toBe('bmn-ui (Codex)')
    expect(askerName({ kind: 'session', session: 's-1' }, sessionName)).toBe("bmn-ui's shell")
    expect(askerName({ kind: 'session', session: 's-9', app: 'claude' }, sessionName)).toBe('A closed session (Claude Code)')
  })

  it('has one or two plain words for every outcome', () => {
    expect(OUTCOME_WORDS).toEqual({ running: 'Asking now', answered: 'Answered', 'no-answer': 'No answer', failed: 'Failed', stopped: 'Stopped', limit: 'Hit a limit', refused: 'Refused', interrupted: 'Cut short' })
  })

  it('says a first line, a time taken, a day and what an answer\'s claims are worth', () => {
    expect(firstLine(' How so?\nMore. ')).toBe('How so?')
    expect(firstLine(null)).toBe('Words not kept')
    expect([400, 42_000, 60_000, 72_000, 121_000].map(tookWords)).toEqual(['1 second', '42 seconds', '1 minute', '1 minute 12 seconds', '2 minutes 1 second'])
    expect(whenWords(at(14, 2), NOW)).toBe('Today 14:02')
    expect(whenWords(at(9, 30, 11), NOW)).not.toContain('Today')
    expect(evidenceWords({ found: 3, not_found: 1, unreadable: 0 })).toBe('evidence for 3 of 4 claims')
    expect(evidenceWords({ found: 1, not_found: 0, unreadable: 0 })).toBe('evidence for 1 of 1 claim')
    expect(evidenceWords({ found: 0, not_found: 2, unreadable: 1 })).toBe('no evidence for its 3 claims')
    expect(evidenceWords({ found: 0, not_found: 1, unreadable: 0 })).toBe('no evidence for its claim')
    expect(evidenceWords({ found: 0, not_found: 0, unreadable: 0 })).toBeNull()
    expect(evidenceWords(undefined)).toBeNull()
  })

  it('says why the owner\'s own question cannot start now', () => {
    expect(askWaits({ holder: null }, 'Haiku')).toBeNull()
    expect(askWaits({ holder: null }, null)).toBe('Pick a researcher above first.')
    expect(askWaits({ holder: { kind: 'question' } }, 'Haiku')).toBe('One question at a time: the one below is under way.')
    expect(askWaits({ holder: { kind: 'research' } }, 'Haiku')).toBe('Models research is running, so a question cannot start yet.')
    expect(askWaits({ holder: { kind: 'lookup' } }, 'Haiku')).toBe('Models research is running, so a question cannot start yet.')
  })
})

describe('the web questions part (64.3)', () => {
  it('lists the kept questions newest first: the first line, when, who asked whom, what the claims are worth and the outcome (AC1)', () => {
    const html = render()
    const lines = [...html.matchAll(/<div class="question[^"]*" data-question="([^"]+)">(.*?)<\/button>/g)].map((match) => [match[1], words(match[2]!)])
    expect(lines).toEqual([
      ['q-answered', 'How do people use the Jev 1.13 model? Today 14:02 bmn-ui (Claude Code) asked Haiku evidence for 1 of 3 claims Answered'],
      ['q-stopped', 'What is a context window? Today 13:00 You asked Luna Stopped'],
      ['q-refused', expect.stringMatching(/^Words not kept .+ A shell asked Refused$/)]
    ])
    // Every line is a real button that says whether it is open; a question without an answer is quiet.
    expect(html.match(/<button type="button" class="question-line" aria-expanded="false"/g)).toHaveLength(3)
    expect(html).toContain('<div class="question" data-question="q-answered">')
    expect(html).toContain('<div class="question quiet" data-question="q-stopped">')
    expect(words(html)).toContain("Web questions yours and your agents', newest first")
    expect(html).not.toContain('question-body')
  })

  it('opens a question: all of it, the answer, each claim with its mark and its page, what was not found, how long it took (AC1)', () => {
    const html = render({ initiallyOpen: 'q-answered' })
    const body = html.slice(html.indexOf('class="question-body"'), html.indexOf('data-question="q-stopped"'))
    expect(html).toContain('<div class="question open" data-question="q-answered">')
    expect(body).toContain('<p class="whole">How do people use the Jev 1.13 model?\nName the page for each claim.</p>')
    expect(words(body)).toContain('Answer People use Jev mostly to route requests by intent.')
    expect(words(body)).toContain('1 of 3 is evidence: BMN found the passage on the page. Pages open in your browser.')
    // Evidence first and on its plate; the two other marks after "Not evidence", without one.
    const evidence = body.slice(body.indexOf('aria-label="Evidence"'), body.indexOf('Not evidence'))
    const rest = body.slice(body.indexOf('aria-label="Not evidence"'))
    expect(evidence.match(/<li class="claim found">/g)).toHaveLength(1)
    expect(words(evidence)).toContain('Passage found on the page Jev is used for intent routing. “Teams use Jev for intent routing” docs.example.org/jev/uses')
    expect(rest.match(/<li class="claim">/g)).toHaveLength(2)
    expect(rest).not.toContain('claim found')
    expect(words(rest)).toContain('Page not readable: the site answered 404 A vendor page lists four patterns.')
    expect(words(rest)).toContain('Page read, passage not found Urgency detection is a common use.')
    // A page is a link that says where it goes and that it opens in the browser.
    expect(body).toContain(`<a class="page-link mono one-line" href="${USES}" title="${USES}" aria-label="docs.example.org/jev/uses, opens in your browser">docs.example.org/jev/uses</a>`)
    expect(words(body)).toContain('Looked for, not found an independent accuracy measurement')
    expect(words(body)).toContain('Took 1 minute 12 seconds')
    expect(body).toContain('<button type="button" class="small">Remove</button>')
  })

  it('says of a refused question why, in the command\'s words, and that its words were not kept', () => {
    const body = words(render({ initiallyOpen: 'q-refused' }))
    expect(body).toContain("The question's words were not kept.")
    expect(body).toContain('Refused: word 2 of the question looks like a key or a password; nothing was sent')
    const none = render({ snapshot: snapshot({ questions: [{ ...ANSWERED, claims: ANSWERED.claims!.filter((claim) => claim.mark !== 'passage found on the page') }] }), initiallyOpen: 'q-answered' })
    expect(words(none)).toContain('None of these is evidence: no passage was found on its page. Pages open in your browser.')
    expect(none).not.toContain('claim found')
    expect(none).not.toContain('aria-label="Evidence"')
  })

  it('shows a question under way with who asked and a Stop, and holds the owner\'s Ask off meanwhile (AC2, AC3)', () => {
    const html = render({ snapshot: snapshot({ questions: [RUNNING, ANSWERED], holder: { kind: 'question', id: 'q-running' } }) })
    const plate = html.slice(html.indexOf('<div class="page-note with-action" role="status">'), html.indexOf('<div class="question-lines"'))
    expect(words(plate)).toMatch(/^A closed session's shell is asking Haiku · started 14:58 Which sites list model prices\? Stop$/)
    expect(plate).toContain('<button type="button" class="small">Stop</button>')
    // The one under way is not also a kept line.
    expect(html).not.toContain('data-question="q-running"')
    expect(words(html)).toContain('One question at a time: the one below is under way.')
    const own = words(render({ snapshot: snapshot({ questions: [{ ...RUNNING, by: { kind: 'owner' } }], holder: { kind: 'question' } }) }))
    expect(own).toContain('You are asking Haiku · started 14:58')
    expect(words(render({ snapshot: snapshot({ holder: { kind: 'research' } }) }))).toContain('Models research is running, so a question cannot start yet.')
  })

  it('offers the Ask field with the researcher beside it, as a labelled field and a plate (AC3)', () => {
    const html = render()
    expect(html).toMatch(/<textarea class="field wide ask-field" rows="2" aria-labelledby="[^"]+" aria-describedby="[^"]+" placeholder="A question for the web"><\/textarea>/)
    expect(words(html)).toContain('Goes to Haiku.')
    // Nothing typed yet: nothing to send.
    expect(html).toContain('<button type="button" class="small" disabled="" title="Ctrl+Enter">Ask</button>')
    expect(words(render({ researcher: null }))).toContain('Pick a researcher above first.')
    expect(html).not.toContain('Not asked:')
  })

  it('has the switch with the day\'s count beside it and a help that names the limits and where the words go (AC4)', () => {
    const on = render()
    expect(on).toMatch(/<button type="button" class="switch on" role="switch" aria-checked="true" aria-labelledby="[^"]+"><\/button><span class="muted">3 of 20 asked today<\/span>/)
    expect(words(on)).toContain("Agents may ask the web 3 of 20 asked today A question's words reach the search sites. Limits: 20 a day, 10 minutes and 2,000 characters each, one research at a time.")
    const off = render({ snapshot: snapshot({ agentsMayAsk: false, today: 20 }) })
    expect(off).toContain('class="switch" role="switch" aria-checked="false"')
    expect(words(off)).toContain('All 20 asked today; the next can be asked tomorrow')
    expect(words(off)).toContain("Off: only your own Ask works. A question's words reach the search sites.")
  })

  it('offers to remove all, says what is kept, and puts the older questions under one line (AC5)', () => {
    const html = render()
    expect(words(html)).toContain('BMN keeps the newest 200 questions with their answers. Remove all…')
    expect(html).not.toContain('<details')
    const many = render({ snapshot: snapshot({ questions: Array.from({ length: 11 }, (_unused, index) => ({ ...STOPPED, id: `q-${index}` })) }) })
    expect(many).toContain('<summary>Earlier · 3 questions</summary>')
    expect(many.slice(0, many.indexOf('<details')).match(/data-question=/g)).toHaveLength(8)
    expect(many.slice(many.indexOf('<details')).match(/data-question=/g)).toHaveLength(3)
  })

  it('says so when nothing was asked yet, with no list and nothing to remove', () => {
    const html = render({ snapshot: snapshot({ questions: [], today: 0 }) })
    expect(words(html)).toContain("No questions yet. Yours and your agents' are kept here with their answers.")
    expect(html).not.toContain('question-lines')
    expect(html).not.toContain('Remove all')
  })

  it('uses the panel pattern only: no native select, no new colour, every button a plate or a line (AC6)', () => {
    for (const html of [render({ initiallyOpen: 'q-answered' }), render({ snapshot: snapshot({ questions: [RUNNING], holder: { kind: 'question' } }) })]) {
      expect(html).not.toMatch(/<select|style="|color:/)
      for (const button of html.match(/<button [^>]*>/g) ?? []) expect(button).toMatch(/class="(small|switch( on)?|question-line)"/)
    }
  })
})
