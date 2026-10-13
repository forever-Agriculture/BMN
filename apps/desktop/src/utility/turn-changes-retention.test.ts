// MODULE: turn-changes-retention.test.ts - the sweep on a real database and a real store: bytes no capture needs removed, a crash right after the commit, a removal that fails and is retried, a deleted session, leftovers at start, a capture no row names, and no marker left by any route
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeExpiredArchives } from './database-archive-purge'
import { putSettingsSection } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import {
  failTurnRemovalJob, finishTurnRemovalJob, listTurnRemovalJobs, namedTurnCaptures, putTurn, sweepTurns, turnRemovalPendingSessions,
  type TurnCaptureRow, type TurnRow
} from './database-turn-store'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { TurnChangesEngine, inProcessKeeper, type TurnStoreKeeper } from './turn-changes-engine'
import { TurnRetention, type TurnRetentionDatabase } from './turn-changes-retention'
import { TURN_STORE_FOLDER, TurnStore, type TurnCaptureRecord } from './turn-changes-store'
import { filesUnder, holds, scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const NOW = Date.parse('2026-10-13T12:00:00.000Z')
const DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString()

interface World {
  at: Place
  database: DatabaseConnection
  engine: TurnChangesEngine
  keeper: TurnStoreKeeper
  /** The rows of turn changes as the host reaches them, each call one transaction. */
  rows: TurnRetentionDatabase
  keep: { days: number | null | undefined }
  clock: { now: number }
  retention: (keeper?: TurnStoreKeeper) => TurnRetention
  session: (id: string, archivedAt?: string | null) => void
  take: (session: string, base?: string | null) => Promise<TurnCaptureRecord>
  turn: (id: string, session: string, endedAt: number, before: TurnCaptureRecord | null, after?: TurnCaptureRecord | null) => void
  storeFolder: (session: string) => string
}

const worlds: World[] = []
let jobs = 0
function world(name: string): World {
  const at = scratch(name)
  const database = new BetterSqlite3(':memory:')
  initializeDatabase(database, iso(NOW))
  const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home })
  const keeper = inProcessKeeper(engine)
  const keep: World['keep'] = { days: 30 }
  const clock = { now: NOW }
  const once = <Result>(work: () => Result): Promise<Result> => Promise.resolve(database.transaction(work)())
  const rows: TurnRetentionDatabase = {
    keepDays: () => Promise.resolve(keep.days),
    sweep: (p) => once(() => sweepTurns(database, p)),
    jobs: () => once(() => listTurnRemovalJobs(database)),
    finish: (jobId) => once(() => finishTurnRemovalJob(database, jobId)),
    fail: (p) => once(() => failTurnRemovalJob(database, p)),
    named: () => once(() => namedTurnCaptures(database))
  }
  const row = (session: string, record: TurnCaptureRecord): TurnCaptureRow => ({
    captureId: record.id, sessionId: session, workTree: record.root, scanStartedMs: record.startedAt, scanEndedMs: record.endedAt,
    headStart: record.headStart, headEnd: record.headEnd, state: record.state, bound: record.bound, size: record.bytesStored
  })
  let numbers = 0
  const made: World = {
    at, database, engine, keeper, rows, keep, clock,
    retention: (other = keeper) => new TurnRetention({
      database: rows, keeper: other, storePresent: () => existsSync(join(at.dataRoot, TURN_STORE_FOLDER)), now: () => new Date(clock.now)
    }),
    session: (id, archivedAt = null) => {
      database.prepare(
        `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position, archived_at)
         VALUES (?, ?, ?, '/work', '/bin/bash', '[]', 1, ?, 0, ?)`
      ).run(id, DEFAULT_WORKSPACE_ID, id, iso(NOW), archivedAt)
    },
    take: async (session, base = null) => {
      // A file is taken as read before only when it had been still for a moment when it was read.
      await sleep(25)
      jobs += 1
      const answer = await engine.capture({ job: `job-${jobs}`, session, folder: at.repo, publish: true, base })
      if (!('record' in answer)) throw new Error(`refused: ${answer.state}: ${answer.reason}`)
      return answer.record
    },
    turn: (id, session, endedAt, before, after = null) => {
      numbers += 1
      const turn: TurnRow = {
        turnId: id, number: numbers, sessionId: session, incarnationId: null, foreground: '1:2:3:4:5', app: 'codex', appVersion: null, conversation: null,
        appTurnId: null, namedFolder: null, workTree: at.repo, state: 'closed', endKind: 'finished', startedAt: iso(endedAt), endedAt: iso(endedAt),
        totalsState: 'complete', totals: { files: 1, added: 1, removed: 1 }, wording: null, labels: [], before: before?.id ?? null, after: after?.id ?? null
      }
      putTurn(database, { turn, captures: [before, after].filter((record): record is TurnCaptureRecord => record !== null).map((record) => row(session, record)) })
    },
    storeFolder: (session) => join(at.dataRoot, TURN_STORE_FOLDER, session)
  }
  worlds.push(made)
  return made
}
afterEach(() => {
  for (const made of worlds.splice(0)) {
    made.engine.close()
    made.database.close()
    made.at.done()
  }
})

describe('the sweep of turn changes', () => {
  it('removes an expired turn, its captures and every stored byte no remaining capture needs; what a kept turn needs reads whole', async () => {
    const w = world('expired')
    w.session('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-first\n')
    const one = await w.take('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-second\n')
    const two = await w.take('s-one', one.id)
    write(w.at.repo, 'a.txt', 'MARKER-third\n')
    const three = await w.take('s-one', two.id)
    // The first turn's end was not observed, so it is compared through the second turn's first scan: they share it.
    w.turn('old', 's-one', NOW - 40 * DAY, one, two)
    w.turn('new', 's-one', NOW - 5 * DAY, two, three)
    const before = (await w.keeper.usage()).all

    expect(await w.retention().sweep()).toEqual({ turns: 1, captures: 1, removed: 1, waiting: 0, unnamed: 0 })

    const store = new TurnStore(w.at.dataRoot, 's-one', w.at.repo)
    expect(store.captures().sort()).toEqual([two.id, three.id].sort())
    expect(holds(w.at.dataRoot, 'MARKER-first')).toBe(false)
    expect(holds(w.at.dataRoot, 'MARKER-second')).toBe(true)
    expect(listTurnRemovalJobs(w.database)).toEqual([])
    expect(turnRemovalPendingSessions(w.database)).toEqual([])
    // What is counted against the bounds is what is on disk after the sweep.
    const after = await w.keeper.usage()
    expect(after.all).toBeLessThan(before)
    expect(after).toEqual({ sessions: { 's-one': store.size('objects') }, all: store.size('objects') })
    const pair = { session: 's-one', root: w.at.repo, a: two.id, b: three.id }
    expect(w.engine.compare(pair)).toMatchObject({ state: 'compared', files: [{ path: 'a.txt', state: 'changed', added: 1, removed: 1 }] })
    expect(w.engine.difference({ ...pair, path: 'a.txt' })).toMatchObject({ state: 'text', added: 1, removed: 1 })
    expect(w.engine.compare({ ...pair, a: one.id })).toMatchObject({ state: 'unavailable' })
    // The next capture still reads only what is new: what the newest capture saw was kept.
    write(w.at.repo, 'b.txt', 'b\n')
    const four = await w.take('s-one', three.id)
    expect(four.bytesRead).toBe(2)
    w.turn('newest', 's-one', NOW - 5 * DAY, three, four)

    // The later turns' time passes too: nothing of the session's store is left.
    w.clock.now = NOW + 26 * DAY
    expect(await w.retention().sweep()).toEqual({ turns: 2, captures: 3, removed: 3, waiting: 0, unnamed: 0 })
    expect(holds(w.at.dataRoot, 'MARKER-')).toBe(false)
    expect(filesUnder(w.storeFolder('s-one'))).toBe(0)
    expect(await w.keeper.usage()).toEqual({ sessions: {}, all: 0 })
  })

  it('finishes a removal a crash interrupted right after the commit', async () => {
    const w = world('crash')
    w.session('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-crash\n')
    const one = await w.take('s-one')
    w.turn('old', 's-one', NOW - 40 * DAY, one)
    // The rows went and the job was written; BMN died before a byte was removed.
    await w.rows.sweep({ now: iso(NOW), keepDays: 30 })
    expect(namedTurnCaptures(w.database)).toEqual([])
    expect(holds(w.at.dataRoot, 'MARKER-crash')).toBe(true)
    expect(turnRemovalPendingSessions(w.database)).toEqual(['s-one'])

    // The next start: another engine, another sweep.
    w.engine.close()
    const next = new TurnChangesEngine({ dataRoot: w.at.dataRoot, home: w.at.home })
    expect(await w.retention(inProcessKeeper(next)).sweep({ start: true })).toEqual({ turns: 0, captures: 0, removed: 1, waiting: 0, unnamed: 0 })
    expect(holds(w.at.dataRoot, 'MARKER-crash')).toBe(false)
    expect(existsSync(w.storeFolder('s-one'))).toBe(true)
    expect(filesUnder(w.storeFolder('s-one'))).toBe(0)
    expect(turnRemovalPendingSessions(w.database)).toEqual([])
  })

  it('keeps a job whose removal failed, says "Removal pending" for its session meanwhile, and tries again', async () => {
    const w = world('retry')
    w.session('s-one')
    w.session('s-two')
    write(w.at.repo, 'a.txt', 'MARKER-retry\n')
    const one = await w.take('s-one')
    const other = await w.take('s-two')
    w.turn('old', 's-one', NOW - 40 * DAY, one)
    w.turn('kept', 's-two', NOW - 1 * DAY, other)
    let refuse = true
    const failing: TurnStoreKeeper = {
      ...w.keeper,
      removeCaptures: (request) => (refuse ? Promise.reject(new Error(`cannot remove ${w.at.repo}/a.txt`)) : w.keeper.removeCaptures(request))
    }
    const lines: string[] = []
    const retention = new TurnRetention({
      database: w.rows, keeper: failing, storePresent: () => true, now: () => new Date(w.clock.now), log: (line) => lines.push(line)
    })

    expect(await retention.sweep()).toEqual({ turns: 1, captures: 1, removed: 0, waiting: 1, unnamed: 0 })
    expect(listTurnRemovalJobs(w.database)).toMatchObject([{ sessionId: 's-one', captureId: one.id, attempts: 1, lastTriedAt: iso(NOW) }])
    expect(turnRemovalPendingSessions(w.database)).toEqual(['s-one'])
    expect(holds(w.storeFolder('s-one'), 'MARKER-retry')).toBe(true)

    w.clock.now = NOW + 3_600_000
    expect(await retention.sweep()).toEqual({ turns: 0, captures: 0, removed: 0, waiting: 1, unnamed: 0 })
    expect(listTurnRemovalJobs(w.database)).toMatchObject([{ attempts: 2, lastTriedAt: iso(NOW + 3_600_000) }])

    refuse = false
    expect(await retention.sweep()).toEqual({ turns: 0, captures: 0, removed: 1, waiting: 0, unnamed: 0 })
    expect(turnRemovalPendingSessions(w.database)).toEqual([])
    expect(holds(w.storeFolder('s-one'), 'MARKER-retry')).toBe(false)
    // The other session's copy of the same file is its own and stays.
    expect(holds(w.storeFolder('s-two'), 'MARKER-retry')).toBe(true)
    // What is logged is counts: no error text, no path.
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toMatch(/^\[BMN\] turn changes: \d+ turn\(s\) and \d+ capture\(s\) past their time, \d+ removal\(s\) done(, \d+ waiting)?\n$/)
  })

  it('removes a deleted session\'s whole store folder, and nobody else\'s', async () => {
    const w = world('deleted')
    w.session('s-gone', iso(NOW - 100 * DAY))
    w.session('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-deleted\n')
    w.turn('gone', 's-gone', NOW - 1 * DAY, await w.take('s-gone'))
    w.turn('stays', 's-one', NOW - 1 * DAY, await w.take('s-one'))
    putSettingsSection(w.database, 'archive', { deleteAfterDays: 90 }, iso(NOW))
    w.database.transaction(() => purgeExpiredArchives(w.database, iso(NOW)))()
    expect(turnRemovalPendingSessions(w.database)).toEqual(['s-gone'])
    expect(existsSync(w.storeFolder('s-gone'))).toBe(true)

    expect(await w.retention().sweep()).toEqual({ turns: 0, captures: 0, removed: 1, waiting: 0, unnamed: 0 })

    expect(existsSync(w.storeFolder('s-gone'))).toBe(false)
    expect(holds(w.storeFolder('s-one'), 'MARKER-deleted')).toBe(true)
    expect(Object.keys((await w.keeper.usage()).sessions)).toEqual(['s-one'])
    expect(turnRemovalPendingSessions(w.database)).toEqual([])
  })

  it('removes staging leftovers at a start, and only then', async () => {
    const w = world('leftovers')
    w.session('s-one')
    const one = await w.take('s-one')
    w.turn('kept', 's-one', NOW - 1 * DAY, one)
    const store = new TurnStore(w.at.dataRoot, 's-one', w.at.repo)
    // What a crash leaves: a capture that was being written, and a cancelled one on its way out.
    for (const part of ['staging/crashed/blobs', 'trash/cancelled/blobs']) {
      mkdirSync(join(store.directory, part), { recursive: true })
      writeFileSync(join(store.directory, part, 'ab'.repeat(32)), 'MARKER-leftover\n')
    }
    await w.retention().sweep()
    expect(holds(w.at.dataRoot, 'MARKER-leftover')).toBe(true)
    await w.retention().sweep({ start: true })
    expect(holds(w.at.dataRoot, 'MARKER-leftover')).toBe(false)
    expect(store.record(one.id)?.state).toBe('whole')
  })

  it('leaves a published capture no row names until it is older than the keep limit by its own time, and then removes it', async () => {
    const w = world('unnamed')
    w.session('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-unnamed\n')
    const lost = await w.take('s-one')
    write(w.at.repo, 'a.txt', 'MARKER-named\n')
    const named = await w.take('s-one', lost.id)
    // As after a database restore: the store holds a capture the database has never heard of.
    w.turn('kept', 's-one', NOW + 60 * DAY, named)
    const store = new TurnStore(w.at.dataRoot, 's-one', w.at.repo)

    w.clock.now = lost.endedAt + 30 * DAY - 1
    expect(await w.retention().sweep()).toEqual({ turns: 0, captures: 0, removed: 0, waiting: 0, unnamed: 0 })
    expect(store.captures()).toHaveLength(2)

    // With Never, or with no confirmed limit, it stays however old it is.
    w.clock.now = lost.endedAt + 400 * DAY
    for (const days of [null, undefined]) {
      w.keep.days = days
      expect(await w.retention().sweep()).toMatchObject({ unnamed: 0 })
    }
    expect(store.captures()).toHaveLength(2)

    w.keep.days = 30
    w.clock.now = lost.endedAt + 30 * DAY
    expect(await w.retention().sweep()).toEqual({ turns: 0, captures: 0, removed: 0, waiting: 0, unnamed: 1 })
    expect(store.captures()).toEqual([named.id])
    expect(holds(w.at.dataRoot, 'MARKER-unnamed')).toBe(false)
    expect(holds(w.at.dataRoot, 'MARKER-named')).toBe(true)
  })

  it('asks nothing of the store while no folder of turn changes exists, and still clears its jobs', async () => {
    const w = world('absent')
    w.session('s-gone', iso(NOW - 100 * DAY))
    putSettingsSection(w.database, 'archive', { deleteAfterDays: 90 }, iso(NOW))
    w.database.transaction(() => purgeExpiredArchives(w.database, iso(NOW)))()
    const never = (): Promise<never> => Promise.reject(new Error('the worker was started'))
    const untouched: TurnStoreKeeper = { removeCaptures: never, removeSession: never, clearLeftovers: never, inventory: never, usage: never }
    expect(await w.retention(untouched).sweep({ start: true })).toEqual({ turns: 0, captures: 0, removed: 1, waiting: 0, unnamed: 0 })
    expect(listTurnRemovalJobs(w.database)).toEqual([])
    expect(existsSync(join(w.at.dataRoot, TURN_STORE_FOLDER))).toBe(false)
  })

  it('runs at a start and then every hour, one sweep at a time', async () => {
    const w = world('timer')
    const timers: Array<{ callback: () => void; ms: number }> = []
    let sweeps = 0
    const retention = new TurnRetention({
      database: { ...w.rows, sweep: (p) => { sweeps += 1; return w.rows.sweep(p) } }, keeper: w.keeper, storePresent: () => false,
      setTimer: (callback, ms) => { timers.push({ callback, ms }); return { cancel: () => undefined } }
    })
    retention.start()
    expect(timers.map((timer) => timer.ms)).toEqual([3_600_000])
    const joined = retention.sweep()
    await joined
    expect(sweeps).toBe(1)
    timers[0]!.callback()
    expect(timers).toHaveLength(2)
    await retention.sweep()
    expect(sweeps).toBe(2)
    retention.stop()
    timers[1]!.callback()
    await sleep(5)
    expect(sweeps).toBe(2)
  })
})

describe('no copy of a file outlives what was allowed', () => {
  it('whichever way it is removed, no marker of a file\'s name or content is left under the data root, and nothing outside turn-changes is touched', async () => {
    const w = world('markers')
    // Something else under the data root, and a folder under turn-changes that is not BMN's.
    write(w.at.dataRoot, 'artifacts/original.bin', 'OTHER-original\n')
    write(w.at.dataRoot, `${TURN_STORE_FOLDER}/not a session!/note.txt`, 'OTHER-note\n')
    const routes = ['expired', 'unreferenced', 'deleted', 'unnamed', 'kept'] as const
    const taken = new Map<string, TurnCaptureRecord[]>()
    for (const route of routes) {
      w.session(`s-${route}`, route === 'deleted' ? iso(NOW - 100 * DAY) : null)
      write(w.at.repo, `MARKERNAME-${route}.txt`, `MARKERTEXT-${route}-one\n`)
      const one = await w.take(`s-${route}`)
      write(w.at.repo, `MARKERNAME-${route}.txt`, `MARKERTEXT-${route}-two\n`)
      write(w.at.repo, `folder/MARKERNAME-${route}-deep.txt`, `MARKERTEXT-${route}-deep\n`)
      taken.set(route, [one, await w.take(`s-${route}`, one.id)])
      // The next session's captures hold none of this one's files.
      rmSync(join(w.at.repo, `MARKERNAME-${route}.txt`))
      rmSync(join(w.at.repo, 'folder'), { recursive: true })
    }
    const of = (route: (typeof routes)[number]): [TurnCaptureRecord, TurnCaptureRecord] => taken.get(route) as [TurnCaptureRecord, TurnCaptureRecord]
    w.turn('expired', 's-expired', NOW - 40 * DAY, ...of('expired'))
    w.turn('deleted', 's-deleted', NOW - 1 * DAY, ...of('deleted'))
    w.turn('kept', 's-kept', NOW - 1 * DAY, ...of('kept'))
    // Captures whose turn was never written: rows without a reference.
    w.database.transaction(() => {
      for (const record of of('unreferenced')) {
        w.database.prepare(
          `INSERT INTO turn_capture(capture_id, session_id, work_tree, scan_started_ms, scan_ended_ms, state, size) VALUES (?, 's-unreferenced', ?, ?, ?, 'whole', ?)`
        ).run(record.id, record.root, record.startedAt, record.endedAt, record.bytesStored)
      }
    })()
    // A cancelled capture and a crashed one leave nothing either.
    write(w.at.repo, 'MARKERNAME-cancelled.txt', 'MARKERTEXT-cancelled\n')
    w.session('s-cancelled')
    const staged = await w.engine.capture({ job: 'job-staged', session: 's-cancelled', folder: w.at.repo, publish: false })
    if (!('record' in staged)) throw new Error(staged.reason)
    expect(holds(w.storeFolder('s-cancelled'), 'MARKERTEXT-cancelled')).toBe(true)
    w.engine.cancel('job-staged')
    await w.engine.store('s-cancelled', w.at.repo).settled()
    rmSync(join(w.at.repo, 'MARKERNAME-cancelled.txt'))
    expect(holds(w.at.dataRoot, 'MARKERTEXT-cancelled')).toBe(false)
    const kept = new TurnStore(w.at.dataRoot, 's-kept', w.at.repo)
    mkdirSync(join(kept.directory, 'staging/crashed/trees'), { recursive: true })
    writeFileSync(join(kept.directory, 'staging/crashed/trees', 'cd'.repeat(32)), '[["MARKERNAME-crashed.txt","f","00",1,0]]')
    for (const route of routes) expect(holds(w.storeFolder(`s-${route}`), `MARKERNAME-${route}.txt`)).toBe(true)

    putSettingsSection(w.database, 'archive', { deleteAfterDays: 90 }, iso(NOW))
    w.database.transaction(() => purgeExpiredArchives(w.database, iso(NOW)))()
    expect(await w.retention().sweep({ start: true })).toEqual({ turns: 1, captures: 4, removed: 5, waiting: 0, unnamed: 0 })
    w.clock.now = Math.max(...of('unnamed').map((record) => record.endedAt)) + 30 * DAY
    w.turn('kept', 's-kept', w.clock.now, ...of('kept'))
    expect(await w.retention().sweep()).toMatchObject({ unnamed: 2, waiting: 0 })

    for (const route of ['expired', 'unreferenced', 'deleted', 'unnamed', 'cancelled', 'crashed']) {
      expect(holds(w.at.dataRoot, `MARKERNAME-${route}`), route).toBe(false)
      expect(holds(w.at.dataRoot, `MARKERTEXT-${route}`), route).toBe(false)
    }
    // Only the kept session's store holds anything, and it reads whole.
    expect(readdirSync(join(w.at.dataRoot, TURN_STORE_FOLDER)).filter((name) => filesUnder(join(w.at.dataRoot, TURN_STORE_FOLDER, name)) > 0).sort())
      .toEqual(['not a session!', 's-kept'])
    expect(w.engine.compare({ session: 's-kept', root: w.at.repo, a: of('kept')[0].id, b: of('kept')[1].id })).toMatchObject({ state: 'compared' })
    expect(holds(join(w.at.dataRoot, 'artifacts'), 'OTHER-original')).toBe(true)
    expect(holds(join(w.at.dataRoot, TURN_STORE_FOLDER, 'not a session!'), 'OTHER-note')).toBe(true)
    expect(listTurnRemovalJobs(w.database)).toEqual([])
  })
})
