// MODULE: away-summary-dialog.test.ts - the summary dialog's view: live requests, completed asks and dev-auto names joined to what the host read (Story 76.6)
import { describe, expect, it } from 'vitest'
import type { AttentionRecord, OwnerAwayView, TeamAskLine, WorkspaceRecord } from '@bmn/protocol'
import { awayTooltip } from './away-check'
import { awaySummaryReadKey, awaySummaryView, presentedClosedPeriod, type AwaySummarySources } from './away-summary-dialog'

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
    expect(view.happened.blocks).toEqual([{ sessionId: 's1', head: 'Personal › Builder', lines: ['1 teammate ask completed · reviewer'] }])
    expect(view.waiting.groups[0]!.rows[0]!.title).toBe('Which storage?')
    const answered = awaySummaryView(sources(), [{ ...request, state: 'answered' }], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(answered.waiting.empty).toBe('Nothing waits on you.')
  })

  it('names asks and dev-auto runs that could not be read instead of saying nothing happened', () => {
    const view = awaySummaryView(sources({ asks: null, devAuto: null }), [], workspaces, new Date(2026, 9, 15, 7, 41))
    expect(view.couldNotRead).toBe('Could not read in full: teammate asks (unreadable), dev-auto runs (unreadable).')
    expect(view.happened.empty).toBe('No retained activity found for this period; some sources could not be read.')
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
