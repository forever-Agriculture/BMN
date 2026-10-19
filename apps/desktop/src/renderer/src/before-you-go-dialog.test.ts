// MODULE: before-you-go-dialog.test.ts - the head's departure words and Before you go's told line (Story 84.3, the notes 84.2 §2)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { askGrant, EMPTY_GRANT_RECORD, ownerGrantView, parseGrantCardInput, startDeparture, type GrantRecord } from '@bmn/protocol'
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

  it('says "leaving" with who it was said to while no card is open', () => {
    const words = awayGrantWords(ownerGrantView({ state: 'read', record: leaving() }), now, name)
    expect(words).toEqual({
      words: 'leaving', label: 'Leaving: before you go', cards: false,
      title: 'Leaving since 22:31 · said to Builder\nRuns were told and may each ask on one card. Check Away when you go.'
    })
  })

  it('counts open cards in gold and names who asks; a run that needs nothing is not a card', () => {
    const record = asked(asked(asked(leaving(), 'run-80', 's-builder'), 'run-81', 's-night'), 'run-79', 's-night', true)
    const words = awayGrantWords(ownerGrantView({ state: 'read', record }), now, name)
    expect(words).toMatchObject({ words: '2 cards', label: '2 cards before you go', cards: true })
    expect(words?.title).toBe('Builder and Night ask before you go.\nA card you leave unanswered grants nothing. Away does not wait for them.')
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
  it('makes only the first open card\'s Grant the primary; the next card\'s Grant is a plate', () => {
    const record = asked(asked(leaving(), 'run-80', 's-builder'), 'run-81', 's-night')
    const markup = renderToStaticMarkup(createElement(BeforeYouGoDialog, {
      grant: ownerGrantView({ state: 'read', record }), now, sessionName: name,
      place: () => ({ workspace: 'Work', session: 'Builder' }),
      onAnswer: async () => ({ outcome: 'granted' as const }), onAwayNow: () => undefined, onNotLeaving: () => undefined, onClose: () => undefined
    }))
    const cards = [...markup.matchAll(/<div class="actions">(.*?)<\/div>/gu)].map((match) => match[1]!)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatch(/^<button type="button" class="primary">Grant<\/button>/u)
    expect(cards[1]).toMatch(/^<button type="button">Grant<\/button>/u)
    expect(markup.match(/class="primary"/gu)).toHaveLength(1)
  })
})
