// MODULE: database-departure-store.test.ts - real SQLite transactions for the departure races, restart deadline and sparse answers
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { departureOmittedLines, GRANT_RECORD_KEY, newDepartureCollection, omittedDepartureCounts, readDepartureCollection, selectDepartureSessions, type GrantRecord } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { departureAction, departureDelivery, type DepartureAction } from './database-departure-store'
import { answerGrantCard, askGrantCard, readGrantRow, useGrantRecord } from './database-grant-store'
import { changeAway, getAway } from './database-away-store'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const AT = '2026-11-17T19:00:00.000Z'
const DUE = '2026-11-17T19:10:00.000Z'
const iso = (ms: number) => new Date(Date.parse(AT) + ms).toISOString()
let database: DatabaseConnection
let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bmn-departure-'))
  path = join(directory, 'state.sqlite3')
  database = new Database(path); initializeDatabase(database, AT)
})
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
const record = (): GrantRecord => { const read = readGrantRow(database); if (read.state !== 'read') throw Error(read.reason); return read.record }
const raw = () => (database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(GRANT_RECORD_KEY) as { value_json: string } | undefined)?.value_json
const collection = () => newDepartureCollection(selectDepartureSessions([{ sessionId: 's', incarnationId: 'i', name: 'Synthetic', agent: 'claude', lastEventAt: AT }], AT), AT)
const action = (input: Partial<DepartureAction> & Pick<DepartureAction, 'action'>, now = AT) => database.transaction(() => departureAction(database,
  { periodId: record().periods.at(-1)?.periodId ?? null, expectedRevision: record().revision, operationKey: `${input.action}:${now}`, source: 'app', ...input }, now))()
const start = () => action({ action: 'start', periodId: null, collection: collection() })
const ask = () => askGrantCard(database, { runId: 'run', sessionId: 's', agentCli: 'claude', origin: { generation: 0, periodId: record().periods.at(-1)?.periodId ?? null }, card: { title: 'Synthetic work', scope: 'One synthetic check', nothing: false,
  terms: [{ id: 'rounds', kind: 'rounds', proposed: 3, reason: 'review ahead' }, { id: 'check', kind: 'command', command: 'node check.mjs', folder: '/synthetic', script: null, count: 1, proposed: 'yes', reason: 'one check' }] } }, AT)
const answer = (choices: Record<string, unknown>, key: string, expectedRevision = record().revision, now = AT) => answerGrantCard(database, {
  periodId: record().periods.at(-1)!.periodId, runId: 'run', cardRevision: 1, expectedRevision, choices, operationKey: key, via: key.startsWith('phone') ? 'telegram' : 'app'
}, now)

describe('persisted grant record generation', () => {
  const metadata = () => database.prepare('SELECT generation, has_record FROM grant_generation').get()
  const archive = () => database.prepare('SELECT generation, value_json FROM grant_reset_archive').all()
  const startAt = (expectedRevision: number, expectedGeneration: number) => database.transaction(() =>
    departureAction(database, { action: 'start', periodId: null, collection: collection(), expectedRevision, expectedGeneration,
      operationKey: 'recovery-attempt', source: 'app' }, AT))()

  it('archives malformed bytes and advances the generation exactly once on a real replacement', () => {
    expect(metadata()).toEqual({ generation: 0, has_record: 0 })
    expect(readGrantRow(database)).toMatchObject({ state: 'read', generation: 0 })
    start()
    const prior = record()
    database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run('{synthetic', GRANT_RECORD_KEY)
    expect(startAt(prior.revision, 0).outcome).toBe('stale')
    expect(metadata()).toEqual({ generation: 0, has_record: 1 })
    expect(archive()).toEqual([])
    const replacement = startAt(0, 0)
    expect(replacement).toMatchObject({ outcome: 'changed', view: { generation: 1 } })
    expect(archive()).toEqual([{ generation: 0, value_json: '{synthetic' }])
    const snapshot = raw()
    const periodId = replacement.view.period!.periodId
    expect(action({ action: 'presented', periodId, expectedGeneration: 0 }).outcome).toBe('stale')
    expect(changeAway(database, { to: 'away', source: 'app', expectedGrantGeneration: 0, expectedGrantRevision: record().revision }, AT).outcome).toBe('stale')
    expect(raw()).toBe(snapshot)
    database.close(); database = new Database(path); initializeDatabase(database, DUE)
    expect(metadata()).toEqual({ generation: 1, has_record: 1 })
    expect(action({ action: 'go', expectedGeneration: 1 }).view).toMatchObject({ generation: 1, period: { periodId, state: 'away' } })
  })

  it('fails closed on unknown versions or metadata loss and rolls back when the original cannot be archived', () => {
    start()
    const replace = (value: string) => database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run(value, GRANT_RECORD_KEY)
    replace('{"version":999}')
    expect(startAt(0, 0).outcome).toBe('unknown')
    expect(raw()).toBe('{"version":999}')
    replace('{synthetic')
    database.exec("CREATE TRIGGER deny_private_archive BEFORE INSERT ON grant_reset_archive BEGIN SELECT RAISE(ABORT, 'synthetic archive failure'); END")
    expect(() => startAt(0, 0)).toThrow('synthetic archive failure')
    expect(raw()).toBe('{synthetic')
    expect(metadata()).toEqual({ generation: 0, has_record: 1 })
    database.exec('DELETE FROM grant_generation')
    expect(startAt(0, 0)).toMatchObject({ outcome: 'unknown', read: { generation: null } })
    expect(archive()).toEqual([])
    expect(raw()).toBe('{synthetic')
  })

  it('distinguishes a missing previous row from a fresh database', () => {
    start()
    database.prepare('DELETE FROM app_setting WHERE key = ?').run(GRANT_RECORD_KEY)
    expect(readGrantRow(database)).toMatchObject({ state: 'unknown', generation: 0 })
    expect(startAt(0, 0)).toMatchObject({ outcome: 'changed', view: { generation: 1 } })
    expect(archive()).toEqual([])
  })
})

describe('departure owner transactions (130.1 AC1-6)', () => {
  it('deduplicates one Telegram command across open, cancellation, and a later start route', () => {
    start()
    expect(action({ action: 'open', source: 'telegram', operationKey: 'telegram:synthetic:17' }).outcome).toBe('changed')
    action({ action: 'cancel', operationKey: 'cancel-first' })
    const before = [raw(), JSON.stringify(getAway(database))]
    expect(action({ action: 'start', periodId: null, source: 'telegram', operationKey: 'telegram:synthetic:17', collection: collection() }).outcome).toBe('repeated')
    expect([raw(), JSON.stringify(getAway(database))]).toEqual(before)
  })
  it('a replayed Telegram cancel cannot become Back in a later Away period', () => {
    start()
    expect(action({ action: 'cancel', source: 'telegram', operationKey: 'telegram:synthetic:18' }).outcome).toBe('changed')
    expect(changeAway(database, { to: 'away', source: 'cli', operationKey: 'later-away' }, AT).outcome).toBe('changed')
    const before = [raw(), JSON.stringify(getAway(database))]
    changeAway(database, { to: 'back', source: 'telegram', operationKey: 'telegram:synthetic:18' }, AT)
    expect([raw(), JSON.stringify(getAway(database))]).toEqual(before)
    expect(getAway(database).state).toBe('away')
  })
  it('a Telegram command first applied by the immediate Away route is inert on the new departure route', () => {
    expect(changeAway(database, { to: 'away', source: 'telegram', operationKey: 'telegram:synthetic:19' }, AT).outcome).toBe('changed')
    changeAway(database, { to: 'back', source: 'cli', operationKey: 'later-back' }, AT)
    const before = [raw(), JSON.stringify(getAway(database))]
    expect(action({ action: 'start', periodId: null, source: 'telegram', operationKey: 'telegram:synthetic:19', collection: collection() }).outcome).toBe('repeated')
    expect([raw(), JSON.stringify(getAway(database))]).toEqual(before)
  })
  it.each(['toString', 'constructor'])('never authorizes an unanswered inherited-name line %s after SQLite reopen', id => {
    start()
    const card = { title: 'Synthetic sparse authority', scope: 'Synthetic only', nothing: false,
      terms: [{ id: 'rounds' as const, kind: 'rounds' as const, proposed: 3, reason: 'One choice' },
        { id, kind: 'command' as const, command: 'node check.mjs', folder: '/synthetic', script: null, count: 1, proposed: 'yes' as const, reason: 'Unanswered sibling' }] }
    askGrantCard(database, { runId: 'run', sessionId: 's', agentCli: 'claude', origin: { generation: 0, periodId: record().periods.at(-1)?.periodId ?? null }, card }, AT)
    expect(answer({ rounds: 3 }, 'ordinary').outcome).toBe('granted')
    database.close(); database = new Database(path)
    expect(record().periods[0]!.runs[0]!.card.state).toBe('open')
    expect(Object.hasOwn(record().periods[0]!.runs[0]!.answer!.choices, id)).toBe(false)
    expect(useGrantRecord(database, { runId: 'run', sessionId: 's', id: 'unanswered-use', kind: 'action', item: id }, AT).outcome).toBe('refused')
    expect(answer(Object.fromEntries([[id, 'yes']]), 'explicit').outcome).toBe('granted')
    database.close(); database = new Database(path)
    expect(Object.hasOwn(record().periods[0]!.runs[0]!.answer!.choices, id)).toBe(true)
    expect(useGrantRecord(database, { runId: 'run', sessionId: 's', id: 'answered-use', kind: 'action', item: id }, AT).outcome).toBe('recorded')
  })
  it('adopts a legacy leaving collection and records actual presentation atomically', () => {
    start()
    const legacy = record()
    legacy.version = 1; delete legacy.periods[0]!.collection
    database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run(JSON.stringify(legacy), GRANT_RECORD_KEY)
    expect(action({ action: 'presented', collection: collection() }, iso(1_000)).outcome).toBe('changed')
    expect(record().version).toBe(2)
    expect(record().periods[0]!.collection).toMatchObject({ openedAt: iso(1_000), autoAwayAt: DUE })
  })
  it.each(['go', 'cancel', 'auto'] as const)('records a late actual-show receipt after %s without changing state or deadline', ending => {
    start(); const periodId = record().periods[0]!.periodId, before = record().revision
    action({ action: ending }, DUE)
    const state = record().periods[0]!.state, away = getAway(database)
    expect(action({ action: 'presented', periodId, expectedRevision: before }, iso(601_000)).outcome).toBe('changed')
    expect(record().periods[0]!.state).toBe(state)
    expect(record().periods[0]!.collection).toMatchObject({ openedAt: iso(601_000), presentedAt: iso(601_000), autoAwayAt: DUE })
    expect(getAway(database)).toEqual(away)
  })
  it('phone open activity extends only the deadline and never creates a desktop receipt', () => {
    start(); action({ action: 'open', source: 'telegram' }, iso(30_000))
    expect(record().periods[0]!.collection).toMatchObject({ openedAt: null, presentedAt: null, autoAwayAt: iso(630_000) })
  })
  it('records automatic presentation without extending a deadline, even one second before it', () => {
    start()
    expect(action({ action: 'presented' }, iso(599_000)).outcome).toBe('changed')
    expect(record().periods[0]?.state).toBe('leaving')
    expect(record().periods[0]?.collection).toMatchObject({ openedAt: iso(599_000), autoAwayAt: DUE })
    const before = raw()
    expect(action({ action: 'presented' }, iso(599_500)).outcome).toBe('unchanged')
    expect(raw()).toBe(before)
    database.close(); database = new Database(path)
    expect(action({ action: 'presented' }, DUE).outcome).toBe('unchanged')
    expect(action({ action: 'auto' }, DUE).outcome).toBe('changed')
    expect(getAway(database).state).toBe('away')
  })

  it.each([['app', 'telegram'], ['telegram', 'app']] as const)('two starts: %s wins, %s is stale without any write', (first, second) => {
    const one = action({ action: 'start', source: first, periodId: null, expectedRevision: 0, collection: collection(), operationKey: 'one' })
    const before = raw()
    const two = action({ action: 'start', source: second, periodId: null, expectedRevision: 0, collection: collection(), operationKey: 'two' })
    expect([one.outcome, two.outcome]).toEqual(['changed', 'stale'])
    expect(raw()).toBe(before)
    expect(record().periods).toHaveLength(1)
    expect(record().periods[0]?.startedBy).toBe(first)
    expect(getAway(database).state).toBe('none')
  })
  it.each([['go', 'cancel'], ['cancel', 'go'], ['go', 'auto'], ['auto', 'go'], ['cancel', 'auto'], ['auto', 'cancel']] as const)(
    '%s wins the race with %s against one shown revision', (first, second) => {
      start()
      const revision = record().revision
      const one = action({ action: first, expectedRevision: revision, operationKey: 'one' }, DUE)
      const before = raw()
      const two = action({ action: second, expectedRevision: revision, operationKey: 'two' }, DUE)
      expect([one.outcome, two.outcome]).toEqual(['changed', 'stale'])
      expect(raw()).toBe(before)
      expect(record().periods[0]?.state).toBe(first === 'cancel' ? 'cancelled' : 'away')
      expect(record().periods[0]?.collection?.autoStartedAt).toBe(first === 'auto' ? DUE : null)
    })
  it.each([['yes', 'no'], ['no', 'yes']])('one line: %s wins against %s, including across surfaces', (first, second) => {
    start(); ask()
    const revision = record().revision
    expect(answer({ check: first }, 'window', revision).outcome).toBe('granted')
    const before = raw()
    expect(answer({ check: second }, 'phone', revision)).toMatchObject({ outcome: 'refused', reason: 'stale' })
    expect(raw()).toBe(before)
    expect(record().periods[0]!.runs[0]!.answer?.choices).toEqual({ check: first })
  })
  it('cards do not move the deadline; a stale timer reads again and starts when due', () => {
    start()
    const old = record().revision
    ask()
    expect(record().periods[0]?.collection?.autoAwayAt).toBe(DUE)
    expect(action({ action: 'auto', expectedRevision: old }, DUE).outcome).toBe('stale')
    expect(action({ action: 'auto' }, DUE).outcome).toBe('changed')
    expect(getAway(database).state).toBe('away')
  })
  it('an owner answer one second before the deadline extends it, and the old timer writes nothing', () => {
    start(); ask()
    expect(answer({ check: 'yes' }, 'window', record().revision, iso(599_000)).outcome).toBe('granted')
    const before = raw()
    expect(action({ action: 'auto' }, DUE).outcome).toBe('unchanged')
    expect(raw()).toBe(before)
    expect(record().periods[0]?.collection?.autoAwayAt).toBe(iso(1_199_000))
    expect(action({ action: 'auto' }, iso(1_199_000)).outcome).toBe('changed')
  })
  it('an overdue deadline and the same cards survive a real database reopen', () => {
    start(); ask()
    const before = raw()
    database.close(); database = new Database(path)
    expect(raw()).toBe(before)
    expect(action({ action: 'auto' }, iso(700_000)).outcome).toBe('changed')
    expect(record().periods[0]?.runs[0]?.card.state).toBe('open')
    expect(record().periods[0]?.collection?.autoStartedAt).toBe(iso(700_000))
  })
  it('starts Away in the same period at once when nobody is selected', () => {
    const result = action({ action: 'start', periodId: null, collection: newDepartureCollection([], AT) })
    expect(result.outcome).toBe('changed')
    expect(result.away.state).toBe('away')
    expect(result.view.period?.periodId).toBe(result.away.periodId)
  })
  it('rolls back both rows if a later step fails', () => {
    expect(() => database.transaction(() => { start(); throw Error('synthetic crash') })()).toThrow('synthetic crash')
    expect(raw()).toBeUndefined()
    expect(getAway(database).state).toBe('none')
  })
})

describe('sparse choices and delivery evidence', () => {
  it('keeps other choices unanswered, never refunds a use after Yes→No→Yes, and never replays an old answer', () => {
    start(); ask()
    answer({ check: 'yes' }, 'first')
    const periodId = record().periods[0]!.periodId
    expect(record().periods[0]!.runs[0]!.answer?.choices).toEqual({ check: 'yes' })
    expect(useGrantRecord(database, { runId: 'run', sessionId: 's', id: 'used', kind: 'action', item: 'check' }, AT).outcome).toBe('recorded')
    answer({ check: 'no' }, 'second')
    answer({ check: 'yes' }, 'third')
    const before = raw()
    expect(answer({ check: 'no' }, 'first', 0).outcome).toBe('repeated')
    expect(raw()).toBe(before)
    expect(useGrantRecord(database, { runId: 'run', sessionId: 's', id: 'again', kind: 'action', item: 'check' }, AT).outcome).toBe('refused')
    action({ action: 'go' })
    expect(answer({ check: 'no' }, 'after-go')).toMatchObject({ outcome: 'refused', reason: 'answered' })
    expect(answer({ rounds: 2 }, 'late')).toMatchObject({ outcome: 'granted' })
    expect(record().periods[0]?.periodId).toBe(periodId)
  })
  it('reserves one typed attempt durably; a restart never makes it available again', () => {
    start()
    const input = { periodId: record().periods[0]!.periodId, sessionId: 's', token: 'attempt', kind: 'claim' as const }
    expect(departureDelivery(database, input, AT).claimed).toBe(true)
    database.close(); database = new Database(path)
    expect(departureDelivery(database, { ...input, token: 'new' }, AT).claimed).toBe(false)
    expect(departureDelivery(database, { ...input, token: 'new', kind: 'release' }, AT).claimed).toBe(false)
    expect(record().periods[0]?.collection?.sessions[0]?.toldAt).toBeNull()
  })
  it('starts a fresh owner departure after a malformed record that grants nothing', () => {
    database.prepare('INSERT INTO app_setting(key,value_json,updated_at) VALUES (?,?,?)').run(GRANT_RECORD_KEY, '{"version":1,', AT)
    const result = departureAction(database, { action: 'start', source: 'app', periodId: null, expectedRevision: 0, operationKey: 'fresh-after-malformed', collection: collection() }, AT)
    expect(result.outcome).toBe('changed')
    expect(record().version).toBe(2)
    expect(record().periods[0]?.collection?.sessions[0]?.sessionId).toBe('s')
  })
  it('keeps an unsupported stored record unchanged on a new departure', () => {
    const unsupported = JSON.stringify({ version: 99, private: 'synthetic sentinel' })
    database.prepare('INSERT INTO app_setting(key,value_json,updated_at) VALUES (?,?,?)').run(GRANT_RECORD_KEY, unsupported, AT)
    expect(departureAction(database, { action: 'start', source: 'app', periodId: null, expectedRevision: 0, operationKey: 'unknown', collection: collection() }, AT).outcome).toBe('unknown')
    expect(raw()).toBe(unsupported)
    expect(changeAway(database, { to: 'away', source: 'cli' }, AT).outcome).toBe('invalid')
    expect(raw()).toBe(unsupported)
  })
})


describe('resumed departure gaps', () => {
  it.each(['go', 'auto'] as const)('preserves a private note through %s without echoing it in the agent grant status', kind => {
    action({ action: 'start', periodId: null, collection: collection(), note: 'Private synthetic note' })
    action({ action: kind }, DUE)
    expect(getAway(database).note).toBe('Private synthetic note')
    expect(record().periods[0]?.note).toBe('Private synthetic note')
  })
  it('carries a note on a zero-selected immediate departure and refuses invalid notes without writes', () => {
    const before = raw()
    expect(action({ action: 'start', periodId: null, collection: collection(), note: 'x'.repeat(201) }).outcome).toBe('unchanged')
    expect(raw()).toBe(before)
    action({ action: 'start', periodId: null, collection: newDepartureCollection([], AT), note: 'Synthetic note' })
    expect(getAway(database)).toMatchObject({ state: 'away', note: 'Synthetic note' })
  })
  it.each(['back-first', 'timer-first'])('Back and automatic Away fence both records: %s', order => {
    start()
    const revision = record().revision
    const periodId = record().periods[0]!.periodId
    const back = () => database.transaction(() => changeAway(database, { to: 'back', source: 'telegram', expectedGrantRevision: revision, expectedPeriodId: periodId }, DUE))()
    if (order === 'back-first') {
      back()
      const before = raw()
      expect(action({ action: 'auto', expectedRevision: revision }, DUE).outcome).toBe('stale')
      expect(raw()).toBe(before)
      expect(record().periods[0]?.state).toBe('cancelled')
    } else {
      action({ action: 'auto', expectedRevision: revision }, DUE)
      const before = raw()
      expect(back().outcome).toBe('stale')
      expect(raw()).toBe(before)
      expect(getAway(database).state).toBe('away')
    }
  })
  it('opening a legacy departure upgrades its envelope and preserves cards and answers', () => {
    start(); ask(); answer({ check: 'yes' }, 'legacy')
    const old = record(); old.version = 1; delete old.offers; delete old.periods[0]!.collection
    database.prepare('UPDATE app_setting SET value_json = ? WHERE key = ?').run(JSON.stringify(old), GRANT_RECORD_KEY)
    expect(action({ action: 'open', collection: collection() }).outcome).toBe('changed')
    expect(record().version).toBe(2)
    expect(record().periods[0]?.runs[0]?.answer?.choices.check).toBe('yes')
    expect(readGrantRow(database).state).toBe('read')
  })
  it('keeps unchanged offers over a cancelled departure and period pruning, and grants only still-open lines atomically', () => {
    start(); ask(); answer({ check: 'yes', rounds: 2 }, 'first')
    action({ action: 'go', operationKey: 'first-go' })
    changeAway(database, { to: 'back', source: 'app' }, iso(1000))
    action({ action: 'start', periodId: null, collection: collection(), operationKey: 'cancel-start' }, iso(2000))
    action({ action: 'cancel', operationKey: 'cancel-middle' }, iso(3000))
    action({ action: 'start', periodId: null, collection: collection(), operationKey: 'next-start' }, iso(4000))
    ask()
    expect(record().periods).toHaveLength(2)
    const offer = action({ action: 'open', operationKey: 'offer' }, iso(5000)).view.offers[0]
    expect(offer?.choices).toEqual({ check: 'yes', rounds: 2 })
    const current = record().periods.at(-1)!
    answerGrantCard(database, { periodId: current.periodId, runId: 'run', cardRevision: 1, choices: { check: 'no' }, expectedRevision: record().revision, via: 'app', operationKey: 'new-no' }, iso(6000))
    expect(action({ action: 'same', operationKey: 'same' }, iso(7000)).outcome).toBe('changed')
    expect(record().periods.at(-1)?.runs[0]?.answer?.choices).toEqual({ check: 'no', rounds: 2 })
    const before = raw()
    expect(action({ action: 'same', operationKey: 'stale', expectedRevision: 0 }, iso(8000)).outcome).toBe('stale')
    expect(raw()).toBe(before)
  })
  it('bounds many sessions after placing recent supported sessions first', () => {
    const sessions = Array.from({ length: 70 }, (_, index) => ({ sessionId: `s${index}`, incarnationId: 'i', name: `Synthetic ${index}`, agent: 'codex', lastEventAt: index < 38 ? null : AT }))
    const selected = selectDepartureSessions(sessions, AT)
    expect(selected).toHaveLength(64)
    expect(selected.filter(session => session.selected)).toHaveLength(32)
    expect(selected.slice(0, 32).every(session => session.selected)).toBe(true)
  })
  it.each([[32, 32, 0, {}], [33, 32, 1, {}], [64, 32, 32, {}], [65, 32, 32, { 'the list is full': 1 }], [100, 32, 32, { 'the list is full': 36 }]] as const)(
    'counts every one of %i recent sessions: selected, named full, or counted beyond the rows (D13)', (total, selectedCount, fullRows, omitted) => {
      const sessions = Array.from({ length: total }, (_, index) => ({ sessionId: `s${index}`, incarnationId: 'i', name: `Synthetic ${index}`, agent: index % 2 ? 'codex' : 'claude', lastEventAt: AT }))
      const rows = selectDepartureSessions(sessions, AT)
      const counted = omittedDepartureCounts(sessions, AT)
      expect(rows.filter(row => row.selected)).toHaveLength(selectedCount)
      expect(rows.filter(row => row.reason === 'the list is full')).toHaveLength(fullRows)
      expect(counted).toEqual(omitted)
      expect(rows.length + Object.values(counted).reduce((sum, count) => sum + count, 0)).toBe(total)
      // Saved through the worker's real SQLite write, reopened from the file and read back with the count.
      action({ action: 'start', periodId: null, collection: newDepartureCollection(rows, AT, counted) })
      database.close(); database = new Database(path)
      const saved = record().periods.at(-1)?.collection ?? null
      expect(saved?.sessions).toHaveLength(rows.length)
      expect(saved?.omitted).toEqual(Object.keys(omitted).length ? omitted : undefined)
      expect(departureOmittedLines(saved ?? undefined)).toEqual(total === 65 ? ['1 more session not asked: the list is full'] : total === 100 ? ['36 more sessions not asked: the list is full'] : [])
    })
  it('gives an old session beyond the rows its own reason, and never selects it (D13)', () => {
    const recent = Array.from({ length: 40 }, (_, index) => ({ sessionId: `r${index}`, incarnationId: 'i', name: `Recent ${index}`, agent: 'claude', lastEventAt: AT }))
    const old = Array.from({ length: 30 }, (_, index) => ({ sessionId: `o${index}`, incarnationId: 'i', name: `Old ${index}`, agent: 'codex', lastEventAt: null }))
    const unsupported = [{ sessionId: 'x', incarnationId: 'i', name: 'Other app', agent: 'other', lastEventAt: AT }]
    const all = [...old, ...unsupported, ...recent]
    expect(omittedDepartureCounts(all, AT)).toEqual({ 'no work in 12 hours': 6, 'app not supported': 1 })
    expect(selectDepartureSessions(all, AT).filter(row => row.selected).every(row => row.sessionId.startsWith('r'))).toBe(true)
  })
  it('refuses a malformed count and reads an older record without one', () => {
    const base = newDepartureCollection(selectDepartureSessions([{ sessionId: 's', incarnationId: 'i', name: 'Synthetic', agent: 'claude', lastEventAt: AT }], AT), AT)
    expect(base.omitted).toBeUndefined()
    expect(readDepartureCollection(base)).not.toBeNull()
    for (const omitted of [[], { 'the list is full': 0 }, { 'the list is full': 1.5 }, { '': 1 }, null]) expect(readDepartureCollection({ ...base, omitted })).toBeNull()
  })
})
