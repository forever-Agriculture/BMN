// MODULE: before-you-go-dialog.test.ts - the head's departure words and Before you go's told line (Story 84.3, the notes 84.2 §2)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { answerGrant, askGrant, EMPTY_GRANT_RECORD, ownerGrantView, parseGrantCardInput, startDeparture, type GrantRecord } from '@bmn/protocol'
import { awayGrantWords } from './away-check'
import { BeforeYouGoDialog, toldWords } from './before-you-go-dialog'

const T0 = new Date(2026, 9, 19, 22, 31).toISOString()
const now = new Date(2026, 9, 19, 22, 40)
const names: Record<string, string> = { 's-builder': 'Builder', 's-night': 'Night' }
const name = (sessionId: string): string | null => names[sessionId] ?? null
const leaving = (): GrantRecord => startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'agent', agentSessionId: 's-builder', periodId: 'p-1' }, 'back', T0).record
const asked = (record: GrantRecord, runId: string, sessionId: string, nothing = false): GrantRecord => {
  const parsed = parseGrantCardInput(nothing ? { title: runId, scope: 's', nothing: true } : { title: runId, scope: 's', terms: [{ kind: 'rounds', proposed: 3, reason: 'r' }] })
  if ('problem' in parsed) throw new Error(parsed.problem)
  return askGrant(record, { runId, sessionId, agentCli: 'claude', card: parsed.card }, T0).record
}

describe('the head beside the Away check (the notes §2)', () => {
  it('says nothing when there is no departure and no open card', () => {
    expect(awayGrantWords(null, now, name)).toBeNull()
    expect(awayGrantWords(ownerGrantView({ state: 'read', record: { ...EMPTY_GRANT_RECORD, periods: [], operations: [] } }), now, name)).toBeNull()
  })

  it('says getting ready with who it was said to while no card is open', () => {
    const words = awayGrantWords(ownerGrantView({ state: 'read', record: leaving() }), now, name)
    expect(words).toEqual({
      words: 'getting ready', label: 'Getting ready: before you go', cards: false,
      title: 'Getting ready since 22:31 · said to Builder\nOpen the list, answer what you want and press Go.'
    })
  })

  it('keeps getting ready muted with open lines and names who asks', () => {
    const record = asked(asked(asked(leaving(), 'run-80', 's-builder'), 'run-81', 's-night'), 'run-79', 's-night', true)
    const words = awayGrantWords(ownerGrantView({ state: 'read', record }), now, name)
    expect(words).toMatchObject({ words: 'getting ready', label: '2 lines before you go', cards: false })
    expect(words?.title).toBe('Builder and Night ask before you go.\nA line you leave unanswered grants nothing. Away starts on Go.')
  })

  it('says nothing for an unreadable record', () => {
    expect(awayGrantWords(ownerGrantView({ state: 'unknown', reason: 'the grant record is not valid JSON' }), now, name)).toBeNull()
  })
})

describe('toldWords', () => {
  it('names up to three sessions, then "and N more"', () => {
    expect(toldWords([], name)).toBe('no run told yet')
    expect(toldWords(['s-builder'], name)).toBe('told Builder')
    expect(toldWords(['s-builder', 's-night'], name)).toBe('told Builder and Night')
    expect(toldWords(['s-builder', 's-night', 'x', 'y', 'z'], name)).toBe('told Builder, Night, a session and 2 more')
  })
})

describe('the dialog\'s buttons (docs/design.md B2)', () => {
  it('makes Go the only primary; every card action is a plate', () => {
    const record = asked(asked(leaving(), 'run-80', 's-builder'), 'run-81', 's-night')
    const markup = renderToStaticMarkup(createElement(BeforeYouGoDialog, {
      grant: ownerGrantView({ state: 'read', record }), now, sessionName: name,
      place: () => ({ workspace: 'Work', session: 'Builder' }),
      onAnswer: async () => ({ outcome: 'granted' as const }), onAwayNow: () => undefined, onNotLeaving: () => undefined, onClose: () => undefined
    }))
    const cards = [...markup.matchAll(/<div class="actions">(.*?)<\/div>/gu)].map((match) => match[1]!)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatch(/^<button type="button">All as proposed<\/button>/u)
    expect(cards[1]).toMatch(/^<button type="button">All as proposed<\/button>/u)
    expect(markup.match(/class="primary grant-go"/gu)).toHaveLength(1)
  })
})

it('shows the earlier grant still in force while a changed proposal is unanswered', () => {
  const original = asked(leaving(), 'run-80', 's-builder')
  const answered = answerGrant(original, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: { rounds: 3 }, via: 'app', operationKey: 'first' }, T0).record
  const revised = askGrant(answered, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card: { title: 'Revised', scope: 'Synthetic', nothing: false, terms: [{ id: 'rounds', kind: 'rounds', proposed: 2, reason: 'Less work' }] } }, T0).record
  const show = (record: GrantRecord) => renderToStaticMarkup(createElement(BeforeYouGoDialog, {
    grant: ownerGrantView({ state: 'read', record }), now, sessionName: name, place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }),
    onAnswer: async () => ({ outcome: 'granted' as const }), onAwayNow: () => undefined, onNotLeaving: () => undefined, onClose: () => undefined
  }))
  expect(show(revised)).toContain('Earlier answer still holds: 3 rounds per boundary. A new answer replaces it.')
  expect(show(revised)).toContain('Not answered')
  const current = answerGrant(revised, { periodId: 'p-1', runId: 'run-80', cardRevision: 2, choices: { rounds: 2 }, via: 'app', operationKey: 'second' }, T0).record
  expect(show(current)).not.toContain('Earlier answer still holds')
  const nothing = askGrant(answered, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card: { title: 'Nothing now', scope: 'Synthetic scope', nothing: true, terms: [] } }, T0).record
  expect(show(nothing)).toContain('Earlier answer still holds: 3 rounds per boundary')
})

it('shows the actual earlier grant for a run which has not asked again', () => {
  const record = leaving()
  const grant = ownerGrantView({ state: 'read', record })
  Object.assign(grant, { notAskedAgain: [{ runId: 'earlier', title: 'Earlier synthetic run', at: T0, granted: ['2 rounds per boundary'] }] })
  const markup = renderToStaticMarkup(createElement(BeforeYouGoDialog, { grant, now, sessionName: name, place: () => ({ workspace: 'Synthetic', session: 'Synthetic' }), onAnswer: async () => ({ outcome: 'granted' as const }), onAwayNow: () => undefined, onNotLeaving: () => undefined, onClose: () => undefined }))
  expect(markup).toContain('2 rounds per boundary')
  expect(markup).toContain('has not asked again. Nothing is granted.')
})
