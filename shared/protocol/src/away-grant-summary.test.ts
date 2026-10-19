// MODULE: away-grant-summary.test.ts - the summary's Granted section over a synthetic night built with the record's own operations (Story 84.7)
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD, type AwayRecord, type OwnerAwayView } from './away'
import { AWAY_GRANT_LIMITS, awayGrantSection } from './away-grant-summary'
import { buildAwaySummary, type AwaySummaryInput } from './away-summary'
import {
  EMPTY_GRANT_RECORD,
  answerGrant,
  askGrant,
  followAwayChange,
  parseGrantCardInput,
  reportGrant,
  startDeparture,
  useGrant,
  type GrantRecord,
  type GrantReportInput
} from './grant'

// Local times, as the owner reads them: leaving Wed 14 Oct 22:30, away 22:34, back Thu 15 Oct 07:40.
const at = (day: number, hours: number, minutes: number): string => new Date(2026, 9, day, hours, minutes).toISOString()
const LEAVING = at(14, 22, 30)
const AWAY_AT = at(14, 22, 34)
const ENDED = at(15, 7, 40)
const NOW = new Date(2026, 9, 15, 7, 41)
const awayRecord = (over: Partial<AwayRecord>): AwayRecord => ({ ...EMPTY_AWAY_RECORD, operations: [], ...over })
const AWAY = awayRecord({ state: 'away', revision: 1, periodId: 'p-1', since: AWAY_AT, source: 'agent' })
const BACK = awayRecord({ state: 'back', revision: 2, periodId: 'p-1', since: AWAY_AT, endedAt: ENDED, source: 'agent', endedBy: 'app' })
const read = (record: GrantRecord) => ({ state: 'read' as const, record })

const card = (terms: unknown[], title = 'Epic 80 · clean up ai slop') => {
  const parsed = parseGrantCardInput({ title, scope: 'Stories 80.2-80.6', ...(terms.length === 0 ? { nothing: true } : { terms }) })
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.card
}
const TERMS = [
  { kind: 'rounds', proposed: 3, reason: 'two review boundaries are ahead' },
  { kind: 'merge', id: 'merge-12', repository: 'forever-Agriculture/BMN', pr: 12, headSha: '3f2a9c1', proposed: 'pr', reason: 'checks green at 22:20' },
  { kind: 'push-default', id: 'push-81', repository: 'forever-Agriculture/dev-auto', branch: 'dev-auto/epic-81', proposed: 'yes', reason: 'no PRs there' }
]

/** A departure with the runs asked, Away carrying it, and each answer given. */
function night(answers: Record<string, Record<string, unknown> | null>, asks: Record<string, unknown[]> = { 'run-80': TERMS }): GrantRecord {
  let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'agent', agentSessionId: 's1', periodId: 'p-1' }, 'back', LEAVING).record
  for (const [runId, terms] of Object.entries(asks)) {
    record = askGrant(record, { runId, sessionId: 's1', agentCli: 'claude', card: card(terms, `Run ${runId}`) }, LEAVING).record
  }
  record = followAwayChange(record, awayRecord({}), AWAY, { to: 'away', source: 'agent', outcome: 'changed' }, AWAY_AT).record
  for (const [runId, choices] of Object.entries(answers)) {
    if (choices === null) continue
    const result = answerGrant(record, { periodId: 'p-1', runId, cardRevision: 1, choices, via: 'telegram', operationKey: `op-${runId}` }, AWAY_AT)
    expect(result.outcome).toBe('granted')
    record = result.record
  }
  return record
}
const use = (record: GrantRecord, id: string, step: { boundary: string } | { item: string }, when: string, runId = 'run-80'): GrantRecord =>
  useGrant(read(record), AWAY, 'boundary' in step ? { runId, sessionId: 's1', id, kind: 'round', boundary: step.boundary } : { runId, sessionId: 's1', id, kind: 'action', item: step.item }, when).record
const report = (record: GrantRecord, input: Omit<GrantReportInput, 'runId' | 'sessionId'> & Record<string, unknown>, when: string): GrantRecord => {
  // An outcome names its use's period (the epic recheck); this night is p-1 unless a test says otherwise.
  const result = reportGrant(read(record), { runId: 'run-80', sessionId: 's1', ...(input.kind === 'outcome' ? { periodId: 'p-1' } : {}), ...input } as GrantReportInput, when)
  expect(result.outcome).toBe('recorded')
  return result.record
}
const back = (record: GrantRecord): GrantRecord => followAwayChange(record, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, ENDED).record

/** The notes' example night (§4): three rounds at 80.3 review, one at 80.5 acceptance, a merge, refusals and a gap. */
function exampleNight(): GrantRecord {
  let record = night({ 'run-80': { rounds: 3, 'merge-12': 'pr', 'push-81': 'no' } })
  record = use(record, 'r1', { boundary: '80.3-review' }, at(15, 0, 40))
  record = report(record, { kind: 'outcome', useId: 'r1', result: 'failed', text: null }, at(15, 1, 30))
  record = use(record, 'r2', { boundary: '80.3-review' }, at(15, 1, 55))
  record = report(record, { kind: 'outcome', useId: 'r2', result: 'failed', text: null }, at(15, 2, 40))
  record = use(record, 'm1', { item: 'merge-12' }, at(15, 2, 20))
  record = report(record, { kind: 'outcome', useId: 'm1', result: 'done', text: 'Merged at 3f2a9c1' }, at(15, 2, 21))
  record = report(record, { kind: 'step-back', boundary: '80.3-review', text: 'a different design, the record written apart from the summary' }, at(15, 3, 0))
  record = use(record, 'r3', { boundary: '80.3-review' }, at(15, 3, 10))
  record = report(record, { kind: 'outcome', useId: 'r3', result: 'passed', text: null }, at(15, 3, 50))
  record = useGrant(read(record), AWAY, { runId: 'run-80', sessionId: 's1', id: 'r4', kind: 'round', boundary: '80.3-review' }, at(15, 4, 15)).record
  record = useGrant(read(record), AWAY, { runId: 'run-80', sessionId: 's1', id: 'p1', kind: 'action', item: 'push-81' }, at(15, 4, 40)).record
  record = report(record, { kind: 'refused', item: 'merge-12', text: 'PR 15 changes .github/workflows, so it asked you' }, at(15, 5, 40))
  record = use(record, 'r5', { boundary: '80.5-acceptance' }, at(15, 5, 2))
  return back(record)
}

describe('awayGrantSection (Story 84.7 AC1)', () => {
  it('shows each run\'s rounds per boundary, the actions used, what was refused and what is missing, BMN\'s record and the agent\'s report apart', () => {
    const section = awayGrantSection(exampleNight().periods, 'p-1', NOW)!
    expect(section.count).toBe(1)
    const [row] = section.rows
    expect(row).toMatchObject({ title: 'Run run-80', state: 'used' })
    expect(row!.text).toBe('Rounds 3 of 3 at 80.3-review, 1 of 3 at 80.5-acceptance · merge PR 12 at 3f2a9c1 used · 2 refused · 1 missing')
    expect(row!.lines.map((line) => [line.label, line.text, line.source])).toEqual([
      ['Granted', 'Wed 22:34 from Telegram', 'BMN\'s record'],
      ['Granted', '3 extra rounds per boundary', 'BMN\'s record'],
      ['Granted', 'Merge PR 12 in forever-agriculture/bmn at 3f2a9c1', 'BMN\'s record'],
      ['Not granted', 'Push dev-auto/epic-81 to the default branch in forever-agriculture/dev-auto', 'BMN\'s record'],
      ['Rounds', '80.3-review: 3 of 3 used · 00:40, 01:55, 03:10', 'BMN\'s record'],
      ['Rounds', '80.5-acceptance: 1 of 3 used, 2 left · 05:02', 'BMN\'s record'],
      ['Step back', '80.3-review, before round 3: a different design, the record written apart from the summary', 'the agent\'s report'],
      ['Outcome', '80.3-review still failing after round 1', 'the agent\'s report'],
      ['Outcome', '80.3-review still failing after round 2', 'the agent\'s report'],
      ['Outcome', '80.3-review passed after round 3', 'the agent\'s report'],
      ['Merge PR 12', 'Used 1 of 1 · 02:20', 'BMN\'s record'],
      ['Merge PR 12', 'Merged at 3f2a9c1 · 02:21', 'the agent\'s report'],
      ['Refused', '80.3-review, a 4th round: none left · 04:15', 'BMN\'s record'],
      ['Refused', 'Push to the default branch: not on the card · 04:40', 'BMN\'s record'],
      ['Refused', 'Merge PR 12: PR 15 changes .github/workflows, so it asked you · 05:40', 'the agent\'s report'],
      ['Missing', '80.5-acceptance, round 1: no outcome reported', 'BMN\'s record'],
      ['Ended', '07:40 at back', 'BMN\'s record']
    ])
  })

  it('lists runs whose card granted nothing once one run holds a grant, each in its own words', () => {
    const record = back(night(
      { 'run-80': { rounds: 3, 'merge-12': 'no', 'push-81': 'no' }, 'run-81': { rounds: 0, 'merge-12': 'no', 'push-81': 'no' }, 'run-83': null },
      { 'run-80': TERMS, 'run-81': TERMS, 'run-82': [], 'run-83': TERMS }
    ))
    const section = awayGrantSection(record.periods, 'p-1', NOW)!
    expect(section.count).toBe(1)
    expect(section.rows.map((row) => [row.title, row.state, row.text])).toEqual([
      ['Run run-80', 'unused', '3 rounds per boundary granted; none used'],
      ['Run run-81', 'none', 'You granted none'],
      ['Run run-82', 'none', 'Needed nothing'],
      ['Run run-83', 'none', 'Card unanswered; withdrawn at back']
    ])
    expect(section.rows[1]!.lines[0]).toEqual({ label: 'Granted', text: 'Wed 22:34 from Telegram · none', source: 'BMN\'s record' })
    expect(section.rows[3]!.lines.map((line) => line.text)).toContain('Nothing: card unanswered; withdrawn at back')
  })

  it('says an uncertain outcome is missing, and while he is away that an outcome may still come', () => {
    let record = night({ 'run-80': { rounds: 2, 'merge-12': 'pr', 'push-81': 'no' } })
    record = use(record, 'r1', { boundary: '80.3-review' }, at(15, 0, 40))
    record = use(record, 'm1', { item: 'merge-12' }, at(15, 2, 20))
    record = report(record, { kind: 'outcome', useId: 'm1', result: 'uncertain', text: 'the call timed out' }, at(15, 2, 21))
    const live = awayGrantSection(record.periods, 'p-1', NOW)!.rows[0]!
    expect(live.lines.filter((line) => line.label === 'Missing').map((line) => line.text)).toEqual([
      '80.3-review, round 1: no outcome reported yet', 'Merge PR 12: outcome uncertain'
    ])
    expect(live.lines.some((line) => line.label === 'Ended')).toBe(false)
    const closed = awayGrantSection(back(record).periods, 'p-1', NOW)!.rows[0]!
    expect(closed.lines.find((line) => line.label === 'Missing')!.text).toBe('80.3-review, round 1: no outcome reported')
  })

  it('counts a boundary\'s rounds as bmn grant does, across the kept periods', () => {
    let record = night({ 'run-80': { rounds: 3, 'merge-12': 'no', 'push-81': 'no' } })
    record = use(record, 'r1', { boundary: '80.3-review' }, at(15, 0, 40))
    record = back(record)
    const second = awayRecord({ state: 'away', revision: 3, periodId: 'p-2', since: at(15, 22, 0), source: 'agent' })
    record = startDeparture(record, { source: 'agent', agentSessionId: 's1', periodId: 'p-2' }, 'back', at(15, 21, 55)).record
    record = askGrant(record, { runId: 'run-80', sessionId: 's1', agentCli: 'claude', card: card(TERMS, 'Run run-80') }, at(15, 21, 56)).record
    record = followAwayChange(record, BACK, second, { to: 'away', source: 'agent', outcome: 'changed' }, at(15, 22, 0)).record
    record = answerGrant(record, { periodId: 'p-2', runId: 'run-80', cardRevision: 1, choices: { rounds: 3, 'merge-12': 'no', 'push-81': 'no' }, via: 'app', operationKey: 'op-2' }, at(15, 22, 1)).record
    record = useGrant(read(record), second, { runId: 'run-80', sessionId: 's1', id: 'r2', kind: 'round', boundary: '80.3-review' }, at(15, 23, 5)).record
    const row = awayGrantSection(record.periods, 'p-2', new Date(2026, 9, 16, 0, 0))!.rows[0]!
    expect(row.lines.find((line) => line.label === 'Rounds')!.text).toBe('80.3-review: 2 of 3 used, 1 left · 23:05 · 1 in an earlier period')
    expect(row.lines[0]!.text).toBe('Thu 22:01 here')
    expect(row.lines.find((line) => line.label === 'Missing')!.text).toBe('80.3-review, round 2: no outcome reported yet')
    // Rounds of a period no longer kept are carried in the record and still count (R84-FR3).
    const carried = awayGrantSection(record.periods.slice(1), 'p-2', new Date(2026, 9, 16, 0, 0), [{ runId: 'run-80', boundary: '80.3-review', rounds: 1 }])!.rows[0]!
    expect(carried.lines.find((line) => line.label === 'Rounds')!.text).toBe('80.3-review: 2 of 3 used, 1 left · 23:05 · 1 in earlier periods')
    const both = awayGrantSection(record.periods, 'p-2', new Date(2026, 9, 16, 0, 0), [{ runId: 'run-80', boundary: '80.3-review', rounds: 1 }])!.rows[0]!
    expect(both.lines.find((line) => line.label === 'Rounds')!.text).toBe('80.3-review: 3 of 3 used · 23:05 · 2 in earlier periods')
  })

  it('reads each use against the answer it was made under, keeps an earlier answer, and shows his refused answers (the epic review, findings 5 and 6)', () => {
    let record = night({ 'run-80': { rounds: 3, 'merge-12': 'pr', 'push-81': 'no' } })
    record = use(record, 'm1', { item: 'merge-12' }, at(15, 1, 0))
    record = report(record, { kind: 'outcome', useId: 'm1', result: 'done', text: null }, at(15, 1, 1))
    const moved = [TERMS[0], { ...TERMS[1], pr: 13 }, TERMS[2]]
    record = askGrant(record, { runId: 'run-80', sessionId: 's1', agentCli: 'claude', card: card(moved, 'Run run-80') }, at(15, 2, 0)).record
    const stale = answerGrant(record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: {}, via: 'telegram', operationKey: 'op-stale' }, at(15, 2, 5))
    expect(stale.outcome).toBe('refused')
    record = answerGrant(stale.record, { periodId: 'p-1', runId: 'run-80', cardRevision: 2, choices: { rounds: 0, 'merge-12': 'no', 'push-81': 'no' }, via: 'app', operationKey: 'op-none' }, at(15, 2, 10)).record
    const row = awayGrantSection(back(record).periods, 'p-1', NOW)!.rows[0]!
    const text = (label: string) => row.lines.filter((line) => line.label === label).map((line) => line.text)
    expect(text('Granted')).toEqual(['Wed 22:34 from Telegram · card revision 1', '3 extra rounds per boundary', 'Merge PR 12 in forever-agriculture/bmn at 3f2a9c1', '02:10 here · none · card revision 2'])
    expect(text('Merge PR 12')).toEqual(['Used 1 of 1 · 01:00', 'Merged · 01:01'])
    expect(text('Refused')).toEqual(['Your answer from Telegram at 02:05: the card had changed'])
    expect(row.lines.find((line) => line.text.startsWith('Your answer'))!.source).toBe('BMN\'s record')
    expect(row.state).toBe('used')
  })

  it('names a PR-elsewhere item\'s target on its Granted line', () => {
    const elsewhere = [{ kind: 'pr-elsewhere', id: 'pr-a', repository: 'octo/skills', branch: 'fix/grant', count: 2, proposed: 'yes', reason: 'the skill fix' }]
    const row = awayGrantSection(back(night({ 'run-80': { 'pr-a': 'yes' } }, { 'run-80': elsewhere })).periods, 'p-1', NOW)!.rows[0]!
    expect(row.lines.filter((line) => line.label === 'Granted').map((line) => line.text)).toContain('Open or update a PR from fix/grant in octo/skills, up to 2')
  })

  it('keeps its bounds: 10 refusals per run, then "N more"; 20 runs, then "N more · dev-auto runs…"', () => {
    let record = night({ 'run-80': { rounds: 2, 'merge-12': 'no', 'push-81': 'no' } })
    for (let index = 0; index < 12; index += 1) record = useGrant(read(record), AWAY, { runId: 'run-80', sessionId: 's1', id: `x${index}`, kind: 'action', item: 'push-81' }, at(15, 1, index)).record
    const refused = awayGrantSection(record.periods, 'p-1', NOW)!.rows[0]!.lines.filter((line) => line.label === 'Refused')
    expect(refused).toHaveLength(AWAY_GRANT_LIMITS.refusals + 1)
    expect(refused.at(-1)!.text).toBe('2 more')
    const asks = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`run-${index}`, TERMS]))
    const answers = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`run-${index}`, { rounds: 2, 'merge-12': 'no', 'push-81': 'no' }]))
    const many = awayGrantSection(night(answers, asks).periods, 'p-1', NOW)!
    expect(many.count).toBe(22)
    expect(many.rows).toHaveLength(AWAY_GRANT_LIMITS.runs)
    expect(many.more).toBe('2 more · dev-auto runs…')
  })
})

describe('the summary with and without grants (Story 84.7 AC1-AC2)', () => {
  const owner = (over: Partial<OwnerAwayView> = {}): OwnerAwayView => ({
    state: 'back', revision: 2, periodId: 'p-1', since: AWAY_AT, endedAt: ENDED, source: 'agent', endedBy: 'app', note: null, summaryShownAt: null, agentSessionId: null, ...over
  })
  const input = (over: Partial<AwaySummaryInput> = {}): AwaySummaryInput => ({
    away: owner(), now: NOW, sessions: [], order: [], attention: [], decisions: { decisions: [], complete: true }, wentOn: { records: [], complete: true, total: 0 },
    activity: { sessions: [], gaps: {} }, artifactNames: {}, devAuto: { result: { runs: [], skipped: 0, issues: [], observedAt: ENDED }, workspaceNames: {} }, ...over
  })

  it('is as before in a period with no grant: no section, no gap', () => {
    const before = buildAwaySummary(input())
    expect(before.granted).toBeNull()
    for (const grants of [{ periods: [] }, { periods: back(night({ 'run-80': { rounds: 0, 'merge-12': 'no', 'push-81': 'no' } })).periods }]) {
      const view = buildAwaySummary(input({ grants }))
      expect(view).toEqual(before)
    }
    const otherPeriod = buildAwaySummary(input({ away: owner({ periodId: 'p-9' }), grants: { periods: exampleNight().periods } }))
    expect(otherPeriod.granted).toBeNull()
  })

  it('shows the section in a period with a grant, and says when grant records could not be read', () => {
    expect(buildAwaySummary(input({ grants: { periods: exampleNight().periods } })).granted?.count).toBe(1)
    const unread = buildAwaySummary(input({ grants: null }))
    expect(unread.granted).toEqual({ count: 0, rows: [], more: null, empty: 'Grant records could not be read.' })
    expect(unread.couldNotRead).toBe('Not fully read: grant records · counts there may be low.')
    expect(unread.couldNotReadWhy).toBe('grant records: unreadable')
  })
})
