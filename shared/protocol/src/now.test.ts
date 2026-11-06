// MODULE: now.test.ts - Story 110.9: the Now rows, the time-left range and the standup text, against the approved design's own strings
import { describe, expect, it } from 'vitest'
import type { DevAutoRun } from './dev-auto'
import { buildNow, leftRange, nowReport, previousWorkingDay, standupLine, standupText, type NowRow, type NowSessionInput, type NowView } from './now'

const MIN = 60_000
const HOUR = 60 * MIN
/** Thu 5 Nov 2026, 09:40, local time: the design's "now". */
const NOW = new Date(2026, 10, 5, 9, 40)
const local = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute)

function run(over: Partial<DevAutoRun>): DevAutoRun {
  return {
    workspaceIds: ['wq'], checkout: '/home/me/code/run', branch: 'dev-auto/epic', project: null, status: 'ACTIVE', nextAction: null,
    decisions: [], runId: null, decisionEntries: [], omittedDecisions: 0, finished: false, updatedAt: null, ownership: 'own',
    ownerCheckout: null, ownerBranch: null, unavailable: null, board: { checkout: null, rows: [], unavailable: null }, ownerItems: [],
    waitingOn: null, finishedStories: [], skippedFinishedStories: 0, leadConversations: [], sessionId: null, sessionLink: null, ...over
  }
}
/** A board for one epic: `done` stories done, the current one with its status, the rest in backlog. */
function board(epic: number, total: number, done: number, slug: string, status = 'in-progress'): DevAutoRun['board'] {
  return { checkout: null, unavailable: null, rows: [{ key: `epic-${epic}`, status: 'in-progress', comment: '' },
    ...Array.from({ length: total }, (_, index) => ({
      key: `${epic}-${index + 1}-${index === done ? slug : `story-${index + 1}`}`,
      status: index < done ? 'done' : index === done ? status : 'backlog', comment: ''
    }))] }
}
/** Finished stories: [story, minutes it took, when it finished]. */
function took(...items: Array<[string, number, Date]>): NonNullable<DevAutoRun['finishedStories']> {
  return items.map(([story, minutes, at]) => ({ story, startedAt: new Date(at.getTime() - minutes * MIN).toISOString(), finishedAt: at.toISOString() }))
}
function session(id: string, workspaceId: string, over: Partial<NowSessionInput> = {}): NowSessionInput {
  return { sessionId: id, workspaceId, name: id, dot: 'running', live: true, started: true, agent: true, working: true,
    progressLabel: null, title: null, card: null, ...over }
}

const WORKSPACES = [{ workspaceId: 'wq', name: 'Q-Automations' }, { workspaceId: 'wb', name: 'BMN' }]
const SESSIONS: NowSessionInput[] = [
  session('Q-Automations-40', 'wq', { dot: 'needs-you', working: false, card: { requestId: 'card-40', title: 'approve TEST deploy' } }),
  session('Q-Automations-41', 'wq', { dot: 'running-idle', working: false }),
  session('Q-Automations-42', 'wq'),
  session('Q-Automations-39-retry-after-timeout-and-the-second-billing-import', 'wq', { dot: 'running-idle', working: false }),
  session('q-review', 'wq', { progressLabel: 'Review PR comments' }),
  session('BMN-108-109', 'wb', { dot: 'running-idle', working: false }),
  session('BMN-110', 'wb'),
  session('BMN-112', 'wb', { dot: 'running-idle', working: false }),
  session('bmn-notes', 'wb', { dot: 'running-idle', working: false })
]
const RUNS: DevAutoRun[] = [
  run({ sessionId: 'Q-Automations-40', checkout: '/home/me/code/q-automations-40', branch: 'dev-auto/epic-40-20261103',
    board: board(40, 7, 4, 'licence-import-QA'), decisions: ['[d1] test data stays synthetic', '[d2] import keeps the old file names (bmn: s/k)'],
    finishedStories: took(['40.1', 40, local(3, 11)], ['40.2', 60, local(3, 15)], ['40.3', 60, local(4, 10)], ['40.4', 80, local(4, 14)]) }),
  run({ sessionId: 'Q-Automations-41', board: board(41, 5, 2, 'report-export', 'review'), waitingOn: 'Marta, review',
    finishedStories: took(['41.1', 60, local(3, 12)], ['41.2', 100, local(4, 16)]) }),
  run({ sessionId: 'Q-Automations-42', board: board(42, 4, 1, 'tenant-limits'), waitingOn: 'CI', finishedStories: took(['42.1', 50, local(3, 9)]) }),
  run({ sessionId: 'Q-Automations-39-retry-after-timeout-and-the-second-billing-import', board: board(39, 2, 1, 'retry-after-timeout'),
    waitingOn: 'TEST deploy', finishedStories: took(['39.1', 30, local(2, 9)]) }),
  run({ workspaceIds: ['wb'], sessionId: 'BMN-108-109', board: board(108, 12, 4, 'plan-moves-to-a-branch'), waitingOn: 'Q-Automations-40',
    finishedStories: took(['108.1', 120, local(2, 11)], ['108.2', 300, local(2, 18)], ['108.3', 180, local(3, 13)], ['108.4', 200, local(4, 11)]) }),
  run({ workspaceIds: ['wb'], sessionId: 'BMN-110', board: board(110, 3, 2, 'time-left-range'),
    finishedStories: took(['110.1', 30, local(3, 10)], ['110.2', 70, local(4, 12)]) }),
  run({ workspaceIds: ['wb'], sessionId: 'BMN-112', unavailable: 'larger than the read limit', updatedAt: local(5, 8, 41).toISOString() })
]

describe('the time left (Story 110.9 AC3)', () => {
  it('is fastest × stories left to slowest × stories left, in whole hours under a day', () => {
    expect(leftRange([40 * MIN, 60 * MIN, 60 * MIN, 80 * MIN], 3)).toBe('about 2-4 h')
    expect(leftRange([60 * MIN, 100 * MIN], 3)).toBe('about 3-5 h')
    expect(leftRange([30 * MIN, 70 * MIN], 1)).toBe('about 1-2 h')
  })
  it('switches to days once the high end reaches 24 h', () => {
    expect(leftRange([2 * HOUR, 5 * HOUR], 8)).toBe('about 1-2 days')
    expect(leftRange([20 * HOUR, 23 * HOUR], 1)).toBe('about 20-23 h')
    expect(leftRange([24 * HOUR, 24 * HOUR], 1)).toBe('about 1-2 days')
    expect(leftRange([30 * HOUR, 70 * HOUR], 2)).toBe('about 2-6 days')
  })
  it('is never one number and never invented', () => {
    expect(leftRange([MIN, 2 * MIN], 1)).toBe('about 1-2 h')
    expect(leftRange([HOUR, HOUR], 2)).toBe('about 2-3 h')
    expect(leftRange([HOUR], 3)).toBeNull()
    expect(leftRange([], 3)).toBeNull()
    expect(leftRange([HOUR, 2 * HOUR], 0)).toBeNull()
  })
  it('needs a live session and two finished stories; a stopped one, a finished one and a run with no session say so', () => {
    const view = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: RUNS })
    const row = (key: string): NowRow => view.rows.find((item) => item.key === `s:${key}`)!
    expect(row('Q-Automations-40')).toMatchObject({ left: 'about 2-4 h', plus: true })
    expect(row('Q-Automations-42')).toMatchObject({ left: null, plus: true })
    expect(row('Q-Automations-42').fold.find((item) => item.label === 'Time left')?.value).toBe('No estimate. It takes 2 finished stories and this run has 1.')
    expect(row('Q-Automations-40').fold.find((item) => item.label === 'Time left')?.value)
      .toBe('About 2-4 h of work. 3 stories left; its 4 finished stories took 40 min to 1 h 20 each. The wait for you is not counted.')
    expect(row('Q-Automations-41').fold.find((item) => item.label === 'Time left')?.value)
      .toBe('About 3-5 h of work. 3 stories left; its 2 finished stories took 1 h and 1 h 40. The wait for Marta, review is not counted.')
    const stopped = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, runs: RUNS,
      sessions: SESSIONS.map((item) => item.sessionId === 'BMN-110' ? { ...item, live: false, dot: 'exited' } : item) })
    expect(stopped.rows.find((item) => item.key === 's:BMN-110')).toMatchObject({ left: null, stopped: true, doing: 'Stopped at 110.3 time left range', section: 'project' })
  })
})

describe('the rows (Story 110.9 AC1, AC2, AC4)', () => {
  const view = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: RUNS, home: '/home/me' })
  const row = (key: string): NowRow => view.rows.find((item) => item.key === `s:${key}`)!
  it('puts Waits on you first, then each workspace in sidebar order', () => {
    expect(view.sections.map((section) => [section.title, section.keys.length])).toEqual([['Waits on you', 1], ['Q-Automations', 4], ['BMN', 4]])
    expect(view).toMatchObject({ sessions: 9, waiting: 1, agentRunning: true, loading: false })
  })
  it('says "you" only for an open card, else what the handoff names, "unknown" for an unreadable one, blank for nobody', () => {
    expect(row('Q-Automations-40')).toMatchObject({ who: 'you: approve TEST deploy', you: true, cardRequestId: 'card-40' })
    expect(row('Q-Automations-41')).toMatchObject({ who: 'Marta, review', you: false })
    expect(row('BMN-112')).toMatchObject({ who: 'unknown', unknown: true, stale: true, doing: 'Handoff unreadable' })
    expect(row('BMN-110').who).toBe('')
  })
  it('reads Doing from the board: the current story and the count; a run idle with nothing named is "Idle at"', () => {
    expect(row('Q-Automations-41')).toMatchObject({ doing: '41.3 report export', of: '2 of 5' })
    expect(row('BMN-108-109')).toMatchObject({ doing: '108.5 plan moves to a branch', of: '4 of 12', left: 'about 1-2 days' })
    const idle = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, runs: RUNS,
      sessions: SESSIONS.map((item) => item.sessionId === 'BMN-110' ? { ...item, dot: 'running-idle', working: false } : item) })
    expect(idle.rows.find((item) => item.key === 's:BMN-110')).toMatchObject({ doing: 'Idle at 110.3', of: '2 of 3' })
  })
  it('without a run: the progress label, else the title, else Working or Idle; only the label speaks ([d9])', () => {
    expect(row('q-review')).toMatchObject({ doing: 'Working: Review PR comments', say: 'Review PR comments', left: null })
    expect(row('bmn-notes')).toMatchObject({ doing: 'Idle', say: null })
    // The agent's own label speaks for it while it rests too; a title never speaks, so Copy and `bmn now` agree ([d9]).
    const resting = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, runs: [], sessions: [
      session('a', 'wb', { working: false, dot: 'running-idle', progressLabel: 'Review PR comments' }),
      session('b', 'wb', { working: false, dot: 'running-idle', title: 'Old title' })] })
    expect(resting.rows.map((item) => [item.doing, item.say])).toEqual([['Idle: Review PR comments', 'Review PR comments'], ['Old title', null]])
    const titled = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, runs: [], sessions: [
      session('spike', 'wb', { title: 'Comparing hook payloads' }), session('shell', 'wb', { agent: false, dot: 'running-idle' })] })
    expect(titled.rows.map((item) => [item.doing, item.say])).toEqual([['Comparing hook payloads', null], ['Shell, no agent', null]])
    // The sheet knows the title, the host does not; both say the same.
    const text = (title: string | null): string => nowReport(buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, runs: [],
      sessions: [session('spike', 'wb', { title }), session('labelled', 'wb', { title, progressLabel: 'Review PR comments' })] }), WORKSPACES).text
    expect(text('Comparing hook payloads')).toBe(text(null))
    expect(text(null)).toBe('Thu 5 Nov, 09:40. 2 sessions, nothing waits on me.\n\nBMN\nlabelled: Review PR comments.')
  })
  it('explains a run in label and value rows, the card a button and the folder under home', () => {
    expect(row('Q-Automations-40').fold.map((item) => item.label)).toEqual(['Status', 'Card', 'Time left', 'Stories', 'Decided', 'Folder'])
    expect(row('Q-Automations-40').fold.find((item) => item.label === 'Stories')?.value).toBe('40.1 to 40.4 done, 40.5 in progress, 40.6 and 40.7 not started.')
    expect(row('Q-Automations-40').fold.find((item) => item.label === 'Decided')?.value)
      .toBe('2 decisions made for you: test data stays synthetic; import keeps the old file names.')
    expect(row('Q-Automations-40').fold.at(-1)).toEqual({ label: 'Folder', value: '~/code/q-automations-40 on dev-auto/epic-40-20261103', kind: 'path' })
    expect(row('Q-Automations-40').fold[1]).toEqual({ label: 'Card', value: 'approve TEST deploy', kind: 'card' })
    expect(row('Q-Automations-39-retry-after-timeout-and-the-second-billing-import').fold[0]?.label).toBe('Session')
  })
  it('keeps an unfinished run with a stopped session in its project; folds stopped sessions, finished runs and runs with no session into Not running', () => {
    const stopped = buildNow({ now: NOW, audience: 'owner', workspaces: [{ workspaceId: 'wp', name: 'Pet' }], sessions: [
      session('Pet-128', 'wp', { live: false, dot: 'exited' }), session('pet-shell', 'wp', { agent: false, dot: 'running-idle' }),
      session('Pet-99', 'wp', { live: false, dot: 'exited' }), session('q-spike', 'wp', { live: false, dot: 'exited' })
    ], runs: [
      run({ workspaceIds: ['wp'], sessionId: 'Pet-128', board: board(128, 6, 2, 'photo-upload') }),
      run({ workspaceIds: ['wp'], sessionId: 'Pet-99', finished: true, board: board(99, 6, 6, 'x'), finishedStories: took(['99.6', 60, local(2, 15)]) }),
      run({ workspaceIds: ['wp'], checkout: '/home/me/code/q-automations-36', branch: 'dev-auto/epic-36', board: board(36, 8, 3, 'x') })
    ] })
    expect(stopped.sections.map((section) => [section.title, section.keys])).toEqual([
      ['Pet', ['s:Pet-128', 's:pet-shell']], ['Not running', ['s:Pet-99', 's:q-spike', 'r:/home/me/code/q-automations-36']]])
    expect(stopped.rows.map((item) => [item.name, item.doing, item.left])).toEqual([
      ['Pet-128', 'Stopped at 128.3 photo upload', null], ['pet-shell', 'Shell, no agent', null], ['Pet-99', 'Finished 2 Nov', 'done'],
      ['q-spike', 'Stopped', null], ['dev-auto/epic-36', 'No session, stopped at 36.4', null]])
    expect(stopped.rows.at(-1)).toMatchObject({ noSession: true, sessionId: null, dot: 'exited', of: '3 of 8' })
    // A run on a default branch is named by its folder.
    const onMain = buildNow({ now: NOW, audience: 'owner', workspaces: [{ workspaceId: 'wp', name: 'Pet' }], sessions: [],
      runs: [run({ workspaceIds: ['wp'], checkout: '/home/me/code/pet-12', branch: 'main', board: board(12, 2, 0, 'x') })] })
    expect(onMain.rows[0]?.name).toBe('pet-12')
    expect(stopped.agentRunning).toBe(false)
  })
  it('loads with rows from memory at once and no run words, and leaves a copy of a checkout out', () => {
    const loading = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: null })
    expect(loading.loading).toBe(true)
    expect(loading.rows.find((item) => item.key === 's:BMN-110')).toMatchObject({ doing: 'Working', of: null, left: null })
    expect(loading.rows.find((item) => item.key === 's:Q-Automations-40')).toMatchObject({ doing: 'Idle', who: 'you: approve TEST deploy' })
    const copies = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: [], runs: [run({ ownership: 'copy' })] })
    expect(copies.rows).toEqual([])
  })
})

describe('the standup text (Story 110.9 AC5)', () => {
  it('counts what finished since the start of the previous working day', () => {
    expect(previousWorkingDay(new Date(2026, 10, 5, 9, 40))).toEqual(new Date(2026, 10, 4))
    expect(previousWorkingDay(new Date(2026, 10, 9, 9, 0))).toEqual(new Date(2026, 10, 6))
    expect(previousWorkingDay(new Date(2026, 10, 8, 9, 0))).toEqual(new Date(2026, 10, 6))
    expect(previousWorkingDay(new Date(2026, 10, 7, 9, 0))).toEqual(new Date(2026, 10, 6))
  })

  it('gives the design\'s own lines for its sample sessions, read from handoffs and boards', () => {
    const view = buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: RUNS })
    expect(standupText(view, WORKSPACES)).toBe([
      'Thu 5 Nov, 09:40. 9 sessions, 1 waits on me.',
      'Q-Automations\nQ-Automations-40: 40.5 licence import QA, 4 of 7 stories. Waits on me: approve TEST deploy. About 2-4 h after that.\n' +
      'Q-Automations-41: 41.3 report export, 2 of 5 stories. Waits on Marta, review. About 3-5 h after that.\n' +
      'Q-Automations-42: 42.2 tenant limits, 1 of 4 stories. Waits on CI. No estimate.\n' +
      'Q-Automations-39-retry-after-timeout-and-the-second-billing-import: 39.2 retry after timeout, 1 of 2 stories. Waits on TEST deploy. No estimate.\n' +
      'q-review: Review PR comments.\nDone since Wed: 40.3, 40.4, 41.2.',
      'BMN\nBMN-108-109: 108.5 plan moves to a branch, 4 of 12 stories. Waits on Q-Automations-40. About 1-2 days after that.\n' +
      'BMN-110: 110.3 time left range, 2 of 3 stories. About 1-2 h left.\nBMN-112: handoff unreadable, status unknown.\nDone since Wed: 108.4, 110.2.'
    ].join('\n\n'))
  })

  it('is exactly the design\'s text for its whole sample, one generator for the sheet\'s copy and bmn now', () => {
    const r = (name: string, over: Partial<NowRow>): NowRow => ({ key: `s:${name}`, sessionId: name, workspaceId: 'w', section: 'project', name,
      dot: 'running', doing: '', story: null, of: null, say: null, stopped: false, done: false, stale: false, noSession: false, who: '',
      you: false, unknown: false, left: null, plus: false, cardRequestId: null, fold: [], ...over })
    const ws = (id: string, rows: NowRow[]): NowRow[] => rows.map((row) => ({ ...row, workspaceId: id }))
    const rows = [
      ...ws('wq', [r('Q-Automations-40', { story: '40.5 licence import QA', of: '4 of 7', who: 'you: approve TEST deploy', you: true, left: 'about 2-4 h', plus: true }),
        r('Q-Automations-41', { story: '41.3 report export', of: '2 of 5', who: 'Marta, review', left: 'about 3-5 h', plus: true }),
        r('Q-Automations-42', { story: '42.2 tenant limits', of: '1 of 4', who: 'CI' }),
        r('Q-Automations-39-retry-after-timeout-and-the-second-billing-import', { story: '39.2 retry after timeout', of: '1 of 2', who: 'TEST deploy' }),
        r('q-review', { say: 'Review PR comments' })]),
      ...ws('wb', [r('BMN-108-109', { story: '108.5 plan moves to a branch', of: '4 of 12', who: 'Q-Automations-40', left: 'about 1-2 days', plus: true }),
        r('BMN-110', { story: '110.3 time-left range', of: '2 of 3', left: 'about 1-2 h' }), r('BMN-112', { stale: true, who: 'unknown' }), r('bmn-notes', {})]),
      ...ws('wp', [r('Pet-111-127', { story: '118 feeding schedule', of: '7 of 17', who: 'you: pick the chart library', you: true, left: 'about 10-20 h', plus: true }),
        r('Pet-128', { story: '128.3 photo upload', of: '2 of 6', stopped: true }), r('pet-shell', {})])
    ]
    const workspaces = [{ workspaceId: 'wq', name: 'Q-Automations' }, { workspaceId: 'wb', name: 'BMN' }, { workspaceId: 'wp', name: 'Pet' }]
    const view: NowView = { now: NOW, audience: 'owner', rows, sections: [{ id: 'all', kind: 'project', title: 'All', workspaceId: null, keys: rows.map((row) => row.key) }],
      sessions: 12, waiting: 2, agentRunning: true, loading: false, sinceDay: 'Wed',
      doneSince: { wq: ['40.3', '40.4', '41.2'], wb: ['108.4', '110.2'], wp: ['117'] } }
    expect(standupText(view, workspaces)).toBe(`Thu 5 Nov, 09:40. 12 sessions, 2 wait on me.

Q-Automations
Q-Automations-40: 40.5 licence import QA, 4 of 7 stories. Waits on me: approve TEST deploy. About 2-4 h after that.
Q-Automations-41: 41.3 report export, 2 of 5 stories. Waits on Marta, review. About 3-5 h after that.
Q-Automations-42: 42.2 tenant limits, 1 of 4 stories. Waits on CI. No estimate.
Q-Automations-39-retry-after-timeout-and-the-second-billing-import: 39.2 retry after timeout, 1 of 2 stories. Waits on TEST deploy. No estimate.
q-review: Review PR comments.
Done since Wed: 40.3, 40.4, 41.2.

BMN
BMN-108-109: 108.5 plan moves to a branch, 4 of 12 stories. Waits on Q-Automations-40. About 1-2 days after that.
BMN-110: 110.3 time-left range, 2 of 3 stories. About 1-2 h left.
BMN-112: handoff unreadable, status unknown.
Done since Wed: 108.4, 110.2.

Pet
Pet-111-127: 118 feeding schedule, 7 of 17 stories. Waits on me: pick the chart library. About 10-20 h after that.
Pet-128: stopped at 128.3 photo upload, 2 of 6 stories.
Done since Wed: 117.`)
    // No agent running: the header says so, and what finished still counts.
    expect(standupText({ ...view, agentRunning: false, rows: [], sections: [], doneSince: { wb: ['108.4', '110.2'] } }, workspaces))
      .toBe('Thu 5 Nov, 09:40. No agent running.\n\nBMN\nDone since Wed: 108.4, 110.2.')
    expect(standupLine(r('x', { say: null }))).toBeNull()
  })

  it('gives an agent states and labels only: no card title, no explanation (D10)', () => {
    const view = buildNow({ now: NOW, audience: 'agent', workspaces: WORKSPACES, sessions: SESSIONS, runs: RUNS })
    const report = nowReport(view, WORKSPACES)
    expect(report.text.split('\n')).toContain('Q-Automations-40: 40.5 licence import QA, 4 of 7 stories. Waits on the owner. About 2-4 h after that.')
    expect(report.text.startsWith('Thu 5 Nov, 09:40. 9 sessions, 1 waits on the owner.')).toBe(true)
    expect(report.sections[0]).toMatchObject({ title: 'Waits on the owner', rows: [{ name: 'Q-Automations-40', who: 'the owner' }] })
    const json = JSON.stringify(report)
    for (const hidden of ['approve TEST deploy', 'test data stays synthetic', 'card-40', '"fold"']) expect(json).not.toContain(hidden)
    const owner = JSON.stringify(nowReport(buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: RUNS }), WORKSPACES))
    expect(owner).toContain('approve TEST deploy')
  })

  it("never shows an agent a run without a session of its own workspace (D10), though the owner sees it", () => {
    const foreign = [...RUNS, run({ workspaceIds: ['wq', 'wb'], sessionId: 'other-workspace-session', board: board(77, 3, 1, 'secret-story'),
      waitingOn: 'Secret wait', finishedStories: took(['77.1', 30, local(4, 12)]) })]
    const agent = nowReport(buildNow({ now: NOW, audience: 'agent', workspaces: [WORKSPACES[0]!], sessions: SESSIONS, runs: foreign }), [WORKSPACES[0]!])
    const json = JSON.stringify(agent)
    for (const hidden of ['secret', 'Secret wait', '77.1', '77.2']) expect(json).not.toContain(hidden)
    const owner = nowReport(buildNow({ now: NOW, audience: 'owner', workspaces: WORKSPACES, sessions: SESSIONS, runs: foreign }), WORKSPACES)
    expect(JSON.stringify(owner)).toContain('77.2 secret story')
  })
})
