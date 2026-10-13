// MODULE: database-turn-store.test.ts - the rows of turn changes: how long a turn is kept at each setting, a capture two turns share, rows that go together with their removal job, and a deleted session
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { purgeExpiredArchives } from './database-archive-purge'
import { getSettings, putSettingsSection } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import {
  failTurnRemovalJob, finishTurnRemovalJob, getTurn, getTurnCapture, listTurnRemovalJobs, listTurns, listUnclosedTurns, namedTurnCaptures,
  nextTurnNumber, putTurn, sweepTurns, turnRemovalPendingSessions, type TurnCaptureRow, type TurnRow
} from './database-turn-store'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-13T12:00:00.000Z'
const daysAgo = (days: number, lessMs = 0): string => new Date(Date.parse(now) - days * 86_400_000 + lessMs).toISOString()
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, now)
})
afterEach(() => database.close())

function session(sessionId: string, archivedAt: string | null = null): void {
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position, archived_at)
     VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, 0, ?)`
  ).run(sessionId, DEFAULT_WORKSPACE_ID, sessionId, now, archivedAt)
}

const capture = (captureId: string, sessionId = 's-one', workTree = '/work/tree'): TurnCaptureRow => ({
  captureId, sessionId, workTree, scanStartedMs: 1_000, scanEndedMs: 1_100, headStart: 'a'.repeat(40), headEnd: 'a'.repeat(40), state: 'whole', bound: null, size: 12
})

let counted = 0
function turn(turnId: string, more: Partial<TurnRow> = {}, captures: TurnCaptureRow[] = []): TurnRow {
  counted += 1
  const row: TurnRow = {
    turnId, number: counted, sessionId: 's-one', incarnationId: 'i-1', foreground: '1:200:20:1:2', app: 'codex', appVersion: '0.162.1',
    conversation: 'conversation-1', appTurnId: null, namedFolder: '/work/tree/sub', workTree: '/work/tree', state: 'closed', endKind: 'finished',
    startedAt: daysAgo(1), endedAt: daysAgo(1), totalsState: 'complete', totals: { files: 1, added: 2, removed: 1 }, wording: null,
    labels: ['Two scans of /work/tree'], before: null, after: null, ...more
  }
  putTurn(database, { turn: row, captures })
  return row
}

const kept = (): string[] => (database.prepare('SELECT turn_id FROM turn_record ORDER BY turn_id').all() as Array<{ turn_id: string }>).map((row) => row.turn_id)
const captures = (): string[] => namedTurnCaptures(database).map((row) => row.captureId)

describe('a turn and its captures, written and read', () => {
  it('are stored whole in one step, read back as they were, and written again with other captures', () => {
    session('s-one')
    const first = turn('t-1', { before: 'c-1', state: 'open', endedAt: null, endKind: null, totalsState: 'none', totals: null }, [capture('c-1')])
    expect(getTurn(database, 't-1')).toEqual(first)
    expect(getTurnCapture(database, 'c-1')).toEqual(capture('c-1'))
    expect(listUnclosedTurns(database).map((row) => row.turnId)).toEqual(['t-1'])
    const closed = turn('t-1', { number: first.number, before: 'c-1', after: 'c-2', wording: 'Partial: 2 files', totalsState: 'partial' }, [capture('c-2')])
    expect(getTurn(database, 't-1')).toEqual(closed)
    expect(listUnclosedTurns(database)).toEqual([])
    turn('t-2', { before: 'c-2' })
    expect(listTurns(database, { sessionId: 's-one', limit: 50 }).map((row) => row.turnId)).toEqual(['t-2', 't-1'])
    expect(listTurns(database, { sessionId: 's-one', limit: 1 }).map((row) => row.turnId)).toEqual(['t-2'])
    expect(nextTurnNumber(database, 's-one')).toBe(listTurns(database, { sessionId: 's-one', limit: 1 })[0]!.number + 1)
    expect(nextTurnNumber(database, 's-none')).toBe(1)
    expect(getTurn(database, 't-none')).toBeNull()
    expect(getTurnCapture(database, 'c-none')).toBeNull()
    // A capture a turn names must have its row.
    expect(() => turn('t-3', { before: 'c-missing' })).toThrow(/constraint/)
  })
})

describe('how long a turn is kept', () => {
  function turnsOfEveryAge(): void {
    session('s-one')
    turn('ended-5', { endedAt: daysAgo(5), startedAt: daysAgo(5) })
    turn('ended-15', { endedAt: daysAgo(15), startedAt: daysAgo(15) })
    turn('ended-40', { endedAt: daysAgo(40), startedAt: daysAgo(40) })
    turn('ended-100', { endedAt: daysAgo(100), startedAt: daysAgo(100) })
    // Without an end the time counts from its start; a long turn that ended lately counts from its end.
    turn('open-20', { endedAt: null, startedAt: daysAgo(20), state: 'open', endKind: null, totalsState: 'none', totals: null })
    turn('started-50-ended-2', { endedAt: daysAgo(2), startedAt: daysAgo(50) })
  }

  it.each([
    [10, ['ended-5', 'started-50-ended-2']],
    [30, ['ended-15', 'ended-5', 'open-20', 'started-50-ended-2']],
    [90, ['ended-15', 'ended-40', 'ended-5', 'open-20', 'started-50-ended-2']]
  ] as const)('with %i days confirmed, every turn that ended or, without an end, started longer ago is removed whole', (keepDays, stay) => {
    turnsOfEveryAge()
    expect(sweepTurns(database, { now, keepDays }).turns).toBe(6 - stay.length)
    expect(kept()).toEqual([...stay])
  })

  // null is Never; undefined is no limit confirmed yet.
  it.each([null, undefined])('with %s confirmed every turn is kept', (keepDays) => {
    turnsOfEveryAge()
    expect(sweepTurns(database, { now, keepDays })).toEqual({ turns: 0, captures: 0 })
    expect(kept()).toHaveLength(6)
  })

  it('applies the limit the owner confirmed, not a shorter one he only picked', () => {
    turnsOfEveryAge()
    // He confirmed 90 days and then picked 10 without pressing Start cleanup.
    putSettingsSection(database, 'agentHistory', { keepDays: 10, confirmedKeepDays: 90, claudeConfigDirs: [] }, now)
    sweepTurns(database, { now, keepDays: getSettings(database).agentHistory.confirmedKeepDays })
    expect(kept()).toEqual(['ended-15', 'ended-40', 'ended-5', 'open-20', 'started-50-ended-2'])
    // Never confirmed anything: the limit he picked does not apply either.
    database.prepare("DELETE FROM app_setting WHERE key = 'agentHistory'").run()
    putSettingsSection(database, 'agentHistory', { keepDays: 10, claudeConfigDirs: [] }, now)
    expect(getSettings(database).agentHistory.confirmedKeepDays).toBeUndefined()
    sweepTurns(database, { now, keepDays: getSettings(database).agentHistory.confirmedKeepDays })
    expect(kept()).toHaveLength(5)
  })

  it('keeps a turn until the very moment its time has passed', () => {
    session('s-one')
    turn('one-ms-left', { endedAt: daysAgo(10, 1) })
    turn('time-up', { endedAt: daysAgo(10) })
    sweepTurns(database, { now, keepDays: 10 })
    expect(kept()).toEqual(['one-ms-left'])
  })
})

describe('a capture', () => {
  it('stays while any kept turn refers to it: one two turns share goes only when the second has gone', () => {
    session('s-one')
    turn('first', { endedAt: daysAgo(40), before: 'c-1', after: 'c-2' }, [capture('c-1'), capture('c-2')])
    // The first turn's end was not observed: it is compared through the next prompt's scan, which both turns use.
    turn('second', { endedAt: daysAgo(5), before: 'c-2', after: 'c-3' }, [capture('c-3')])
    expect(sweepTurns(database, { now, keepDays: 30 })).toEqual({ turns: 1, captures: 1 })
    expect(kept()).toEqual(['second'])
    expect(captures()).toEqual(['c-2', 'c-3'])
    expect(listTurnRemovalJobs(database)).toMatchObject([{ sessionId: 's-one', workTree: '/work/tree', captureId: 'c-1', createdAt: now, attempts: 0, lastTriedAt: null }])
    // Nothing more goes while the second turn is kept, however often the sweep runs.
    expect(sweepTurns(database, { now, keepDays: 30 })).toEqual({ turns: 0, captures: 0 })
    expect(sweepTurns(database, { now: new Date(Date.parse(now) + 26 * 86_400_000).toISOString(), keepDays: 30 })).toEqual({ turns: 1, captures: 2 })
    expect(captures()).toEqual([])
    expect(listTurnRemovalJobs(database).map((job) => job.captureId)).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('that no turn refers to goes at the next sweep, whatever the keep setting', () => {
    session('s-one')
    turn('kept', { before: 'c-1' }, [capture('c-1')])
    database.prepare("INSERT INTO turn_capture(capture_id, session_id, work_tree, scan_started_ms, scan_ended_ms, state, size) VALUES ('c-alone', 's-one', '/work/other', 1, 2, 'whole', 3)").run()
    expect(sweepTurns(database, { now, keepDays: null })).toEqual({ turns: 0, captures: 1 })
    expect(captures()).toEqual(['c-1'])
    expect(listTurnRemovalJobs(database)).toMatchObject([{ sessionId: 's-one', workTree: '/work/other', captureId: 'c-alone' }])
  })

  it('loses its rows and gets its removal job in one transaction: neither without the other', () => {
    session('s-one')
    turn('old', { endedAt: daysAgo(40), before: 'c-1' }, [capture('c-1')])
    expect(() => database.transaction(() => {
      sweepTurns(database, { now, keepDays: 30 })
      throw new Error('the commit did not happen')
    })()).toThrow('the commit did not happen')
    expect(kept()).toEqual(['old'])
    expect(captures()).toEqual(['c-1'])
    expect(listTurnRemovalJobs(database)).toEqual([])
  })
})

describe('a removal job', () => {
  it('waits until its bytes are gone: a failure is counted and it stays, and its session reads "Removal pending"', () => {
    session('s-one')
    session('s-two')
    turn('old', { endedAt: daysAgo(40), before: 'c-1' }, [capture('c-1')])
    sweepTurns(database, { now, keepDays: 30 })
    const [job] = listTurnRemovalJobs(database)
    expect(turnRemovalPendingSessions(database)).toEqual(['s-one'])
    const later = '2026-10-13T13:00:00.000Z'
    failTurnRemovalJob(database, { jobId: job!.jobId, now: later })
    failTurnRemovalJob(database, { jobId: job!.jobId, now: later })
    expect(listTurnRemovalJobs(database)).toEqual([{ ...job, attempts: 2, lastTriedAt: later }])
    expect(turnRemovalPendingSessions(database)).toEqual(['s-one'])
    finishTurnRemovalJob(database, job!.jobId)
    expect(listTurnRemovalJobs(database)).toEqual([])
    expect(turnRemovalPendingSessions(database)).toEqual([])
  })
})

describe('a deleted session', () => {
  it('takes its turns, their references and its captures in the deleting transaction, with one job for its store folder', () => {
    session('s-gone', daysAgo(100))
    session('s-one')
    putSettingsSection(database, 'archive', { deleteAfterDays: 90 }, now)
    turn('gone-1', { sessionId: 's-gone', before: 'g-1', after: 'g-2' }, [capture('g-1', 's-gone'), capture('g-2', 's-gone')])
    turn('gone-2', { sessionId: 's-gone', before: 'g-2', state: 'open', endedAt: null })
    turn('stays', { before: 'c-1' }, [capture('c-1')])
    // An earlier job for one of its captures is covered by the folder's.
    database.prepare("INSERT INTO turn_removal_job(session_id, work_tree, capture_id, created_at) VALUES ('s-gone', '/work/tree', 'g-0', ?)").run(now)

    const purged = database.transaction(() => purgeExpiredArchives(database, now))()

    expect(purged.sessionIds).toEqual(['s-gone'])
    expect(kept()).toEqual(['stays'])
    expect(captures()).toEqual(['c-1'])
    expect(database.prepare('SELECT COUNT(*) AS count FROM turn_capture_reference').get()).toEqual({ count: 1 })
    expect(listTurnRemovalJobs(database)).toMatchObject([{ sessionId: 's-gone', workTree: null, captureId: null, createdAt: now }])
    expect(turnRemovalPendingSessions(database)).toEqual(['s-gone'])
    expect(database.pragma('foreign_key_check')).toEqual([])
  })

  it('gets its job even when no row names a capture: after a database restore its folder may still hold some', () => {
    session('s-gone', daysAgo(100))
    putSettingsSection(database, 'archive', { deleteAfterDays: 90 }, now)
    database.transaction(() => purgeExpiredArchives(database, now))()
    expect(listTurnRemovalJobs(database)).toMatchObject([{ sessionId: 's-gone', workTree: null, captureId: null }])
  })
})
