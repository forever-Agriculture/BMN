// MODULE: away-summary-dialog.test.ts - the summary dialog's view: live requests, completed asks and dev-auto names joined to what the host read (Story 76.6)
import { describe, expect, it } from 'vitest'
import type { AttentionRecord, OwnerAwayView, TeamAskLine, WorkspaceRecord } from '@bmn/protocol'
import { awayTooltip } from './away-check'
import { awaySummaryReadKey, awaySummaryView, presentedClosedPeriod, sessionWords, type AwaySummarySources } from './away-summary-dialog'

const at = (day: number, hours: number, minutes: number): string => new Date(2026, 9, day, hours, minutes).toISOString()
const away: OwnerAwayView = {
  state: 'back', revision: 2, periodId: 'p', since: at(14, 22, 10), endedAt: at(15, 7, 40), source: 'app', endedBy: 'app', note: null,
  summaryShownAt: null, agentSessionId: null
}
const sources = (over: Partial<AwaySummarySources> = {}): AwaySummarySources => ({
  payload: {
    away, sessions: [{ sessionId: 's1', name: 'Builder', workspace: 'Personal', archivedAt: null }], order: ['s1'],
    decisions: { decisions: [], complete: true }, wentOn: { records: [], complete: true, total: 0 }, activity: { sessions: [], gaps: {} }, artifactNames: {}
  },
  asks: { asks: [{ by: { kind: 'session', session: 's1' }, state: 'answered', role: 'reviewer', endedAt: at(15, 1, 0) } as unknown as TeamAskLine], places: { used: 0, capacity: 1 }, keptDays: 30 },
  devAuto: { runs: [], skipped: 0, issues: [], observedAt: at(15, 7, 40) },
  ...over
})
const workspaces = [{ workspaceId: 'w', name: 'Personal' }] as unknown as WorkspaceRecord[]

describe('awaySummaryView (Story 76.6 AC1, AC3)', () => {
  it('adds the completed asks to what happened and reads Waiting on you from the requests the app holds now', () => {
    const request = { requestId: 'r', sessionId: 's1', state: 'open', openedAt: at(15, 2, 0), kind: 'question', title: 'Which storage?', prompt: null } as unknown as AttentionRecord
    const view = awaySummaryView(sources(), [request], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(view.activity.rows).toEqual([{ sessionId: 's1', where: 'Personal › Builder', text: '1 ask answered (reviewer)', lines: ['1 ask answered (reviewer)'] }])
    expect(view.waiting.groups[0]!.rows[0]!.title).toBe('Which storage?')
    const answered = awaySummaryView(sources(), [{ ...request, state: 'answered' }], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(answered.waiting.empty).toBe('Nothing waits on you.')
  })

  it('names asks and dev-auto runs that could not be read instead of saying nothing happened', () => {
    const view = awaySummaryView(sources({ asks: null, devAuto: null }), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(view.couldNotRead).toBe('Not fully read: teammate asks, dev-auto runs · counts there may be low.')
    expect(view.activity.empty).toBe('No session activity recorded.')
    expect(view.stuck.empty).toBe('Dev-auto runs could not be read.')
  })
})

describe('Granted (Story 84.7)', () => {
  it('passes the host\'s grant periods through to the view, and none leaves the summary as before', () => {
    const before = awaySummaryView(sources(), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(before.granted).toBeNull()
    const unread = awaySummaryView(sources({ payload: { ...sources().payload, grants: null } }), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(unread.granted?.empty).toBe('Grant records could not be read.')
    expect(unread.couldNotRead).toBe('Not fully read: grant records · counts there may be low.')
  })
})

describe('sessionWords (Fable\'s redesign 2026-10-18)', () => {
  it('shows a session by its own name and app, without the workspace path or archive stamp', () => {
    expect(sessionWords('PICHE › Q-Automations · Claude Code')).toBe('Q-Automations · Claude Code')
    expect(sessionWords('Personal › Reviewer (archived Thu 05:00)')).toBe('Reviewer')
    expect(sessionWords('A session BMN no longer holds')).toBe('A session BMN no longer holds')
  })
})

describe('summary so far turning into the return summary (Astra review finding 7)', () => {
  it('reads again when back closes the open period, and counts only a read of the closed period as presented', () => {
    const open = { ...away, state: 'away' as const, revision: 1, endedAt: null, endedBy: null }
    expect(awaySummaryReadKey(open)).not.toBe(awaySummaryReadKey(away))
    expect(presentedClosedPeriod({ away: open })).toBeNull()
    expect(presentedClosedPeriod({ away })).toBe('p')
  })
})

describe('awayTooltip (Story 76.3, 76.6)', () => {
  it('says the checked words open the summary so far', () => {
    expect(awayTooltip({ ...away, state: 'away', endedAt: null, note: 'back by 8' }, new Date(2026, 9, 14, 23, 0), () => null).split('\n'))
      .toEqual(['Away since 22:10 · set here', 'Note: back by 8', 'The words open the summary so far. Uncheck when you are back.'])
  })
})

describe('Waited for you (Story 84.8 [d29])', () => {
  it('passes the host\'s long waits he answered through to the view, and an unread list is a gap', () => {
    const answered = { requestId: 'a', sessionId: 's1', state: 'answered', openedAt: at(14, 23, 35), resolvedAt: at(15, 7, 39), resolvedBy: 'input', kind: 'question', title: 'Push now?', prompt: null } as unknown as AttentionRecord
    const view = awaySummaryView(sources({ payload: { ...sources().payload, answeredWaits: { records: [answered], complete: true, total: 1 } } }), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(view.waitedForYou.groups[0]!.rows[0]).toMatchObject({ waited: '8 h 4 min', how: 'answered at the terminal 07:39', title: 'Push now?' })
    const unread = awaySummaryView(sources({ payload: { ...sources().payload, answeredWaits: null } }), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(unread.couldNotRead).toBe('Not fully read: long waits you answered · counts there may be low.')
  })
})
