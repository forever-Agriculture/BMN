// MODULE: away-summary.test.ts - the away summary's words, order, bounds and gaps (Story 76.6)
import { describe, expect, it } from 'vitest'
import type { TeamAskLine } from './agents-roster'
import type { DecisionRecord, OwnerAwayView } from './away'
import {
  AWAY_SUMMARY_LIMITS,
  awayTelegramWaiting,
  awayTelegramWentOn,
  awayWentOnWords,
  buildAwaySummary,
  withCompletedAsks,
  type AwaySessionActivity,
  type AwaySummaryInput
} from './away-summary'
import type { AttentionRecord } from './companion'
import type { DevAutoRun } from './dev-auto'

// Local times, as the owner reads them: away Wed 14 Oct 22:10 to Thu 15 Oct 07:40.
const at = (day: number, hours: number, minutes: number): string => new Date(2026, 9, day, hours, minutes).toISOString()
const SINCE = at(14, 22, 10)
const ENDED = at(15, 7, 40)
const NOW = new Date(2026, 9, 15, 7, 41)

const away = (over: Partial<OwnerAwayView> = {}): OwnerAwayView => ({
  state: 'back', revision: 2, periodId: 'p-1', since: SINCE, endedAt: ENDED, source: 'telegram', endedBy: 'app', note: 'back by 8',
  summaryShownAt: null, agentSessionId: null, ...over
})
const request = (id: string, sessionId: string, openedAt: string, over: Partial<AttentionRecord> = {}): AttentionRecord => ({
  requestId: id, sessionId, incarnationId: null, requestKey: id, kind: 'question', title: `Title ${id}`, body: null, state: 'open', resolution: null,
  openedAt, expiresAt: null, resolvedAt: null, seenAt: null, revision: 1, openedBy: null, resolvedBy: null, prompt: null, ...over
})
const decision = (key: string, sessionId: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  key, sessionId, choice: `Choice ${key}`, reason: 'A reason', affects: 'src/store.js', reverse: 'Revert the commit', references: [], depends: [],
  periodId: 'p-1', revision: 1, agentCli: 'claude', conversation: 'c', incarnationId: 'i', recordedAt: at(14, 23, 41), outcomes: [], ...over
})
const activity = (sessionId: string, over: Partial<AwaySessionActivity> = {}): AwaySessionActivity => ({
  sessionId, app: 'claude', turnsEnded: 0, turnsWithChanges: 0, changesAtLeast: false, published: [], publishedCount: 0, asksCompleted: [],
  messages: { printed: 0, queued: 0, uncertain: 0, expired: 0 }, handoffs: [], exits: [], ...over
})
const run = (over: Partial<DevAutoRun> = {}): DevAutoRun => ({
  workspaceIds: ['w'], checkout: '/code/x/.claude/worktrees/epic-76', branch: 'dev-auto/epic-76', project: 'Epic 76', status: 'ACTIVE', nextAction: null,
  decisions: [], runId: 'r1', decisionEntries: [], omittedDecisions: 0, finished: false, ownership: 'own', ownerCheckout: null, ownerBranch: null,
  unavailable: null, board: { checkout: null, rows: [], unavailable: null }, ownerItems: [], ...over
})
const input = (over: Partial<AwaySummaryInput> = {}): AwaySummaryInput => ({
  away: away(), now: NOW,
  sessions: [
    { sessionId: 's1', name: 'Builder', workspace: 'Personal', archivedAt: null },
    { sessionId: 's2', name: 'Reviewer', workspace: 'Personal', archivedAt: at(15, 5, 0) }
  ],
  order: ['s1', 's2'], attention: [], decisions: { decisions: [], complete: true }, wentOn: { records: [], complete: true }, activity: { sessions: [], gaps: {} }, artifactNames: {},
  devAuto: { result: { runs: [], skipped: 0, issues: [], observedAt: ENDED }, workspaceNames: { w: 'Personal' } },
  ...over
})

describe('buildAwaySummary (Story 76.6 AC1-AC2)', () => {
  it('reads an empty, complete period in Fable\'s words: the head, the note, nothing waiting, no records, no activity', () => {
    const view = buildAwaySummary(input())
    expect(view.label).toBe('While you were away')
    expect(view.head).toBe('Away 9 h 30 min · Wed 22:10 – Thu 07:40 · set from Telegram, ended here')
    expect(view.note).toBe('back by 8')
    expect(view.couldNotRead).toBeNull()
    expect(view.waiting.empty).toBe('Nothing waits on you.')
    expect(view.decided.empty).toBe('No BMN decision records for this period.')
    expect(view.decided.tail).toBe('Decisions kept only in a workflow\'s own log, and any an agent did not report, are outside this list.')
    expect(view.happened.empty).toBe('No retained activity found for this period.')
    expect(view.now.lines).toEqual([])
  })

  it('says "so far" and since while he is away, and names the agent that set it on his words', () => {
    const view = buildAwaySummary(input({ away: away({ state: 'away', endedAt: null, endedBy: null, source: 'agent', agentSessionId: 's1' }), now: new Date(2026, 9, 15, 0, 20) }))
    expect(view.label).toBe('While you are away')
    expect(view.head).toBe('Away 2 h 10 min so far · since Wed 22:10 · set by Builder on your words')
  })

  it('lists every open request by session, marks one opened before he left, shows a command as the title and bounds the list', () => {
    const attention = [
      request('r1', 's2', at(14, 21, 0)),
      request('r2', 's1', at(15, 1, 0), { kind: 'permission', prompt: { type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null, tool: 'Bash', command: 'sudo systemctl restart x', cwd: null } }),
      request('r3', 's1', at(15, 2, 0), { state: 'answered' }),
      request('r4', 'gone', at(15, 3, 0))
    ]
    const view = buildAwaySummary(input({ attention }))
    expect(view.waiting.open).toBe(3)
    expect(view.waiting.groups.map((group) => [group.where, group.rows.map((row) => [row.kind, row.title, row.before, row.command])])).toEqual([
      ['Personal › Builder', [['Permission', 'sudo systemctl restart x', false, true]]],
      ['Personal › Reviewer (archived 05:00)', [['Question', 'Title r1', true, false]]],
      ['A session BMN no longer holds', [['Question', 'Title r4', false, false]]]
    ])
    // The request card's kind words: an update, a manual decision and a manual question.
    const kinds = buildAwaySummary(input({ attention: [request('n1', 's1', at(15, 1, 0), { kind: 'notice' }),
      request('n2', 's1', at(15, 1, 1), { kind: 'permission', manualChoices: { options: [], allowOther: true } }), request('n3', 's1', at(15, 1, 2), { manualChoices: { options: [], allowOther: true } })] }))
    expect(kinds.waiting.groups[0]!.rows.map((row) => row.kind)).toEqual(['Update', 'Manual decision', 'Manual question'])
    const many = Array.from({ length: AWAY_SUMMARY_LIMITS.waiting + 3 }, (_, index) => request(`m${index}`, 's1', at(15, 1, index % 60)))
    const bounded = buildAwaySummary(input({ attention: many }))
    expect(bounded.waiting.groups.flatMap((group) => group.rows)).toHaveLength(AWAY_SUMMARY_LIMITS.waiting)
    expect(bounded.waiting.more).toBe('3 more · Go to next request needing you walks them.')
  })

  it('shows each decision with its rows, validated references as navigation only, dependencies and the outcome', () => {
    const records = [
      decision('cache-key', 's1', { recordedAt: at(14, 23, 0) }),
      decision('storage', 's1', {
        depends: ['cache-key', 'elsewhere'], outcomes: [{ op: 'build', result: 'failed', evidence: ['two tests fail in search.test.ts'], reporter: 'agent', at: at(15, 6, 12) }],
        references: [{ kind: 'session', id: 's2', valid: true }, { kind: 'artifact', id: 'a1', valid: true }, { kind: 'artifact', id: 'a2', valid: false }, { kind: 'workflow', id: 'dev-auto:r1:d3', valid: false }]
      })
    ]
    const view = buildAwaySummary(input({ decisions: { decisions: records, complete: true }, artifactNames: { a1: 'report.md' } }))
    const storage = view.decided.groups[0]!.records[1]!
    expect(storage.rows).toEqual([
      { label: 'Choice', text: 'Choice storage' },
      { label: 'Reason', text: 'A reason' },
      { label: 'Affects', text: 'src/store.js · a2 · dev-auto:r1:d3', links: [{ kind: 'session', id: 's2', text: 'Personal › Reviewer (archived 05:00)' }, { kind: 'artifact', id: 'a1', text: 'report.md' }] },
      { label: 'Depends on', text: 'cache-key (above) · elsewhere (not in this list)' },
      { label: 'To reverse', text: 'Revert the commit' },
      { label: 'Outcome', text: 'Agent reported failed 06:12 · two tests fail in search.test.ts' },
      { label: 'Recorded', text: 'Wed 23:41 by Builder (Claude Code)' }
    ])
    expect(view.decided.groups[0]!.records[0]!.rows.find((row) => row.label === 'Outcome')).toEqual({ label: 'Outcome', text: 'Outcome unknown', muted: true })
  })

  it('cuts decisions at thirty, names a store cut as incomplete and never says "no decisions" when it could not read them', () => {
    const records = Array.from({ length: 33 }, (_, index) => decision(`k${index}`, 's1'))
    const cut = buildAwaySummary(input({ decisions: { decisions: records, complete: false } }))
    expect(cut.decided.groups[0]!.records).toHaveLength(30)
    expect(cut.decided.more).toBe('3 more recorded; the list is cut at 30.')
    expect(cut.decided.incomplete).toBe(true)
    expect(cut.couldNotRead).toBe('Could not read in full: decision records (cut at 33 listings).')
    const unread = buildAwaySummary(input({ decisions: null, attention: null }))
    expect(unread.decided.empty).toBeNull()
    expect(unread.waiting.empty).toBeNull()
    expect(unread.couldNotRead).toBe('Could not read in full: requests (unreadable), decision records (unreadable).')
  })

  it('words what happened per session in sidebar order, at most eight lines, counts never summed past a gap', () => {
    const view = buildAwaySummary(input({
      activity: {
        gaps: { turns: { kind: 'truncated', at: 500 } },
        sessions: [
          activity('s2', { app: 'codex', exits: [{ at: at(15, 3, 12), code: 1, signal: null }] }),
          activity('s1', {
            turnsEnded: 14, turnsWithChanges: 9, changesAtLeast: true, published: ['report.md', 'plan.md', 'a.txt'], publishedCount: 5,
            asksCompleted: ['reviewer', 'reviewer'], messages: { printed: 3, queued: 1, uncertain: 1, expired: 0 }, handoffs: [{ receiver: 'Reviewer', state: 'printed' }]
          }),
          activity('s3')
        ]
      }
    }))
    expect(view.happened.blocks).toEqual([
      { sessionId: 's1', head: 'Personal › Builder · Claude Code', lines: [
        'at least 14 turns ended, at least 9 with changed files', 'Published report.md, plan.md, a.txt +2', '2 teammate asks completed · reviewer',
        'Messages: 3 printed, 1 queued, 1 uncertain · Handoff to Reviewer printed'
      ] },
      { sessionId: 's2', head: 'Personal › Reviewer (archived 05:00) · Codex', lines: ['Exited 03:12 (exit 1)'] }
    ])
    expect(view.happened.incomplete).toBe(true)
    const long = buildAwaySummary(input({ activity: { gaps: {}, sessions: [activity('s1', { exits: Array.from({ length: 10 }, (_, index) => ({ at: at(15, 1, index), code: 0, signal: null })) })] } }))
    expect(long.happened.blocks[0]!.lines).toHaveLength(8)
    expect(long.happened.blocks[0]!.lines[7]).toBe('3 more · open its Turn changes, Hook events and Messages')
    const gapped = buildAwaySummary(input({ activity: null }))
    expect(gapped.happened.empty).toBe('No retained activity found for this period; some sources could not be read.')
  })

  it('shows dev-auto as Now, undated; an entry joined to its BMN record by session and key shows once, above; legacy entries are said', () => {
    const devAuto = {
      result: { runs: [run({ finished: true, decisions: ['[d1] SQLite (bmn: s1/dev-auto:r1:d1)', 'old line'], decisionEntries: [{ entry: 'd1', bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, { entry: null, bmnKey: null, bmnSession: null }] }), run({ ownership: 'copy', finished: true })], skipped: 0, issues: [], observedAt: ENDED },
      workspaceNames: { w: 'Personal' }
    }
    const view = buildAwaySummary(input({ devAuto, decisions: { decisions: [decision('dev-auto:r1:d1', 's1')], complete: true } }))
    expect(view.now.lines).toEqual(['Personal · dev-auto/epic-76 · Epic 76: Finished', 'Personal · dev-auto/epic-76 · Epic 76: old line'])
    expect(view.now.legacy).toBe('Entries without an identity may repeat a record above.')
    expect(view.decided.groups[0]!.records[0]!.rows.at(-1)!.text).toBe('Wed 23:41 by Builder (Claude Code) · also in dev-auto\'s handoff')
  })

  it('qualifies every count whose source was not read whole: changes partly captured, messages, files and asks cut or past retention', () => {
    const view = buildAwaySummary(input({ activity: {
      sessions: [activity('s1', { turnsEnded: 1, changesAtLeast: true, messages: { printed: 500, queued: 0, uncertain: 0, expired: 0 }, published: ['a.md'], publishedCount: 1, asksCompleted: ['reviewer'] })],
      gaps: { changes: { kind: 'partial', read: 0, skipped: 1 }, messages: { kind: 'truncated', at: 500 }, files: { kind: 'truncated', at: 200 } }
    } }))
    expect(view.happened.blocks[0]!.lines).toEqual(['1 turn ended, changed files not all recorded', 'Published a.md and perhaps more', '1 teammate ask completed · reviewer', 'Messages: at least 500 printed'])
    expect(view.couldNotRead).toBe('Could not read in full: turn changes (partial: 0 read, 1 skipped), published files (cut at 200 listings), messages (cut at 500 listings).')
    expect(view.happened.incomplete).toBe(true)
    const old = withCompletedAsks({ sessions: [], gaps: {} }, [], SINCE, ENDED, { keptDays: 30, now: new Date(Date.parse(SINCE) + 31 * 86_400_000) })
    expect(old.gaps.asks).toEqual({ kind: 'expired' })
    expect(withCompletedAsks({ sessions: [], gaps: {} }, [], SINCE, ENDED, { keptDays: 30, now: new Date(ENDED) }).gaps.asks).toBeUndefined()
  })

  it('joins a dev-auto entry only by the record identity it kept and its own run\'s key, never by a key another run or session shares', () => {
    const view = (entry: { bmnKey: string | null; bmnSession: string | null }, decisions: ReturnType<typeof decision>[], over: Partial<ReturnType<typeof run>> = {}) => {
      const line = `[d1] SQLite (bmn: ${entry.bmnSession === null ? '' : `${entry.bmnSession}/`}${entry.bmnKey})`
      const devAuto = { result: { runs: [run({ decisions: [line], decisionEntries: [{ entry: 'd1', ...entry }], ...over })], skipped: 0, issues: [], observedAt: ENDED }, workspaceNames: { w: 'Personal' } }
      return buildAwaySummary(input({ devAuto, decisions: { decisions, complete: true } }))
    }
    const joined = (summary: ReturnType<typeof buildAwaySummary>) => summary.now.lines.length === 0
    // Its own record, shown: one line, above.
    expect(joined(view({ bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, [decision('dev-auto:r1:d1', 's1')]))).toBe(true)
    // Another run's entry borrowing that key, a record of another session with the key, a record naming another workflow entry,
    // an entry that kept only the key: each stays apart.
    expect(joined(view({ bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, [decision('dev-auto:r1:d1', 's1')], { runId: 'rB' }))).toBe(false)
    expect(joined(view({ bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, [decision('dev-auto:r1:d1', 's2')]))).toBe(false)
    expect(joined(view({ bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, [decision('dev-auto:r1:d1', 's1', { references: [{ kind: 'workflow', id: 'dev-auto:other:d1', valid: false }] })]))).toBe(false)
    const keyOnly = view({ bmnKey: 'dev-auto:r1:d1', bmnSession: null }, [decision('dev-auto:r1:d1', 's1')])
    expect(joined(keyOnly)).toBe(false)
    expect(keyOnly.now.legacy).toBe('Entries without an identity may repeat a record above.')
    expect(keyOnly.decided.groups[0]!.records[0]!.rows.at(-1)!.text).not.toContain('also in dev-auto')
    // A record cut from the list does not hide its entry.
    const many = Array.from({ length: 31 }, (_, index) => decision(`k${String(index).padStart(2, '0')}`, 's1'))
    expect(joined(view({ bmnKey: 'dev-auto:r1:d1', bmnSession: 's1' }, [...many, decision('dev-auto:r1:d1', 's1', { recordedAt: at(15, 7, 0) })]))).toBe(false)
  })

  it('links a workflow reference dev-auto identifies to its run; one no readable run holds stays words', () => {
    const devAuto = { result: { runs: [run({ decisionEntries: [{ entry: 'd3', bmnKey: null, bmnSession: null }] })], skipped: 0, issues: [], observedAt: ENDED }, workspaceNames: { w: 'Personal' } }
    const record = decision('k', 's1', { affects: 'src/a.ts', references: [{ kind: 'workflow', id: 'dev-auto:r1:d3', valid: false }, { kind: 'workflow', id: 'dev-auto:r9:d3', valid: false }] })
    const affects = buildAwaySummary(input({ devAuto, decisions: { decisions: [record], complete: true } })).decided.groups[0]!.records[0]!.rows.find((row) => row.label === 'Affects')
    expect(affects).toEqual({ label: 'Affects', text: 'src/a.ts · dev-auto:r9:d3', links: [{ kind: 'workflow', id: 'dev-auto:r1:d3', text: 'Personal · dev-auto/epic-76 · Epic 76 [d3]' }] })
  })

  it('a folder that is not a repository is no gap in dev-auto; a real skip is named with its count and an empty Now says so', () => {
    const devAuto = (issues: string[]) => ({ result: { runs: [], skipped: issues.length, issues, observedAt: ENDED }, workspaceNames: { w: 'Personal' } })
    const plain = buildAwaySummary(input({ devAuto: devAuto(['/home/me/notes: Not a repository']) }))
    expect(plain.couldNotRead).toBeNull()
    expect(plain.now.incomplete).toBe(false)
    const skipped = buildAwaySummary(input({ devAuto: devAuto(['/home/me/notes: Not a repository', '/repo: Worktree bound: /repo/wt']) }))
    expect(skipped.couldNotRead).toBe('Could not read in full: dev-auto runs (partial: 0 read, 1 skipped).')
    expect(skipped.now).toMatchObject({ incomplete: true, lines: [], empty: 'No dev-auto run that BMN could read reports anything now.' })
  })
})

describe('withCompletedAsks (Story 76.6 AC1)', () => {
  const ask = (over: Partial<TeamAskLine>): TeamAskLine => ({
    id: 'x', question: null, by: { kind: 'session', session: 's1' }, agent: null, agentName: null, effort: null, role: 'reviewer', project: null, data: 'private',
    reads: { scope: 'text', words: '', folder: null, files: [] } as unknown as TeamAskLine['reads'], askedAt: null, startedAt: null, endedAt: at(15, 1, 0), timeLimitMinutes: null,
    state: 'answered', usage: null, keptUntil: null, ...over
  })
  it('adds only answered asks of a session that ended inside the period, and names unreadable asks', () => {
    const merged = withCompletedAsks({ sessions: [], gaps: {} }, [ask({}), ask({ state: 'failed' }), ask({ by: { kind: 'shell' } }), ask({ endedAt: at(15, 8, 0) })], SINCE, ENDED)
    expect(merged.sessions.map((session) => [session.sessionId, session.asksCompleted])).toEqual([['s1', ['reviewer']]])
    expect(withCompletedAsks({ sessions: [], gaps: {} }, null, SINCE, ENDED).gaps.asks).toEqual({ kind: 'unreadable' })
  })
})

describe('awayTelegramWaiting (Story 76.6 AC4)', () => {
  it('gives up to ten "Session: title" lines through the phone field and counts the rest', () => {
    const attention = Array.from({ length: 12 }, (_, index) => request(`r${index}`, 's1', at(15, 1, index)))
    const field = (text: string, limit: number): string => `[${text.slice(0, limit)}]`
    const { lines, more } = awayTelegramWaiting(attention, () => 'Builder', field)
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('[Builder]: [Title r0]')
    expect(more).toBe(2)
  })
})

describe('Went on without you (Epic 78, owner 2026-10-17)', () => {
  const BASH = { type: 'permission' as const, harness: 'claude' as const, shape: 'permission' as const, requestRef: 'ref-1', toolUseId: null, tool: 'Bash', command: 'rmdir ..', cwd: null }
  const closed = (id: string, sessionId: string, resolvedAt: string, over: Partial<AttentionRecord> = {}): AttentionRecord =>
    request(id, sessionId, SINCE, { state: 'withdrawn', resolvedAt, ...over })

  it('names how each card closed without him', () => {
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: 'hook:claude:Stop' })).toBe('Closed when the agent ended its turn')
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: 'hook:codex:SessionEnd' })).toBe('Closed when the session ended')
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: 'hook:claude:UserPromptSubmit' })).toBe('Closed by a new message to the agent')
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: 'hook:claude:PostToolUse' })).toBe('Closed when the agent went on')
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: 'cli' })).toBe('Withdrawn by the agent')
    expect(awayWentOnWords({ state: 'expired', resolvedBy: 'expiry' })).toBe('Expired unanswered')
    expect(awayWentOnWords({ state: 'withdrawn', resolvedBy: null })).toBe('Closed without your answer')
  })

  it('lists every card of the period that closed without his answer, by session, the command as its title', () => {
    const view = buildAwaySummary(input({
      wentOn: {
        records: [
          closed('w1', 's1', at(14, 23, 5), { kind: 'permission', prompt: BASH, resolvedBy: 'hook:claude:Stop' }),
          closed('w2', 's2', at(15, 1, 0), { resolvedBy: 'cli' })
        ],
        complete: true
      }
    }))
    expect(view.wentOn.count).toBe(2)
    expect(view.wentOn.incomplete).toBe(false)
    expect(view.wentOn.empty).toBeNull()
    expect(view.wentOn.groups.map((group) => [group.where, group.rows.map((row) => [row.time, row.kind, row.title, row.command, row.how])])).toEqual([
      ['Personal › Builder', [['23:05', 'Permission', 'rmdir ..', true, 'Closed when the agent ended its turn']]],
      ['Personal › Reviewer (archived 05:00)', [['01:00', 'Question', 'Title w2', false, 'Withdrawn by the agent']]]
    ])
  })

  it('says none closed without him, and names a list it could not read or was cut', () => {
    expect(buildAwaySummary(input()).wentOn.empty).toBe('No card closed without you.')
    const unread = buildAwaySummary(input({ wentOn: null }))
    expect(unread.wentOn.incomplete).toBe(true)
    expect(unread.wentOn.empty).toBeNull()
    expect(unread.couldNotRead).toBe('Could not read in full: requests closed without you (unreadable).')
    const records = Array.from({ length: AWAY_SUMMARY_LIMITS.wentOn + 1 }, (_, index) => closed(`c${index}`, 's1', at(15, 1, index % 60)))
    const cut = buildAwaySummary(input({ wentOn: { records, complete: false } }))
    expect(cut.wentOn.groups[0]!.rows).toHaveLength(AWAY_SUMMARY_LIMITS.wentOn)
    expect(cut.wentOn.more).toBe('1 more · each session\'s Needs you history has them.')
    expect(cut.couldNotRead).toBe(`Could not read in full: requests closed without you (cut at ${AWAY_SUMMARY_LIMITS.wentOn + 1} listings).`)
  })

  it('gives the /back reply up to ten "Session: subject (how)" lines and counts the rest', () => {
    const records = Array.from({ length: 12 }, (_, index) => closed(`c${index}`, 's1', at(15, 1, index), { resolvedBy: 'cli' }))
    const field = (text: string, limit: number): string => `[${text.slice(0, limit)}]`
    const { lines, more } = awayTelegramWentOn(records, () => 'Builder', field)
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('[Builder]: [Title c0] (Withdrawn by the agent)')
    expect(more).toBe(2)
  })
})
