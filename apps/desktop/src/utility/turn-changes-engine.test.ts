// MODULE: turn-changes-engine.test.ts - the order of a session's captures, "busy" between sessions, staged captures that are published, discarded or let go, both bounds of the store's size, and a capture for a session's terminal
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCapturing, type TurnLimits, type TurnRefusal } from './turn-changes-capture'
import { TurnChangesEngine, inProcessKeeper, inProcessPort, type TurnCaptureAnswer, type TurnCaptureRequest } from './turn-changes-engine'
import { captureSessionWorkTree } from './turn-changes-service'
import { TurnStore, type TurnCaptureRecord } from './turn-changes-store'
import { filesUnder, scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const places: Place[] = []
const engines: TurnChangesEngine[] = []
function setup(name: string, holdMs?: number): { at: Place; engine: TurnChangesEngine; ask: (job: string, more?: Partial<TurnCaptureRequest>) => Promise<TurnCaptureAnswer> } {
  const at = scratch(name)
  places.push(at)
  const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, ...(holdMs === undefined ? {} : { holdMs }) })
  engines.push(engine)
  return { at, engine, ask: (job, more = {}) => engine.capture({ job, session: 's-one', folder: at.repo, publish: false, ...more }) }
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.close()
  for (const made of places.splice(0)) made.done()
})

const record = (answer: TurnCaptureAnswer): TurnCaptureRecord => {
  if (!('record' in answer)) throw new Error(`refused: ${answer.state}: ${answer.reason}`)
  return answer.record
}
const settledWithin = async <Value>(promise: Promise<Value>, ms: number): Promise<Value | 'pending'> =>
  Promise.race([promise, sleep(ms).then(() => 'pending' as const)])

describe('the engine of turn changes', () => {
  it('publishes at once a capture nobody has to confirm', async () => {
    const { at, ask } = setup('at-once')
    const answer = await ask('job-1', { publish: true })
    expect(answer).toMatchObject({ state: 'whole', published: true })
    expect(new TurnStore(at.dataRoot, 's-one', at.repo).record(record(answer).id)?.state).toBe('whole')
    expect(isCapturing(at.repo)).toBe(false)
  })

  it('keeps a capture staged until it is published, and publishes it once', async () => {
    const { at, engine, ask } = setup('staged')
    const answer = await ask('job-1')
    expect(answer).toMatchObject({ state: 'whole', published: false })
    const id = record(answer).id
    const store = new TurnStore(at.dataRoot, 's-one', at.repo)
    expect(store.record(id)).toBeNull()
    expect(engine.publish(id)?.id).toBe(id)
    expect(store.record(id)?.id).toBe(id)
    expect(engine.publish(id)).toBeNull()
  })

  it('removes the bytes of a staged capture that is discarded, and of one nobody settles in time', async () => {
    const { at, engine, ask } = setup('let-go', 60)
    const discarded = record(await ask('job-1')).id
    engine.discard(discarded)
    expect(engine.publish(discarded)).toBeNull()
    const forgotten = record(await ask('job-2')).id
    await sleep(120)
    expect(engine.publish(forgotten)).toBeNull()
    const store = engine.store('s-one', at.repo)
    await store.settled()
    expect(store.captures()).toEqual([])
    expect(filesUnder(at.dataRoot)).toBe(0)
    expect(isCapturing(at.repo)).toBe(false)
  })

  it('acknowledges a session\'s later capture only when the earlier one was published or discarded', async () => {
    const { at, engine, ask } = setup('order', 5_000)
    const first = record(await ask('job-1')).id
    const second = ask('job-2', { base: first })
    expect(await settledWithin(second, 150)).toBe('pending')
    write(at.repo, 'between.txt', 'b\n')
    engine.publish(first)
    const later = record(await second)
    // The later capture ran after the earlier one was real: it was taken to be compared with it, and it saw the new file.
    expect(later.base).toBe(first)
    expect(later.counts.entries).toBe(2)
    expect(later.startedAt).toBeGreaterThanOrEqual(engine.store('s-one', at.repo).record(first)?.endedAt ?? Infinity)
    engine.discard(later.id)
    // A discarded earlier capture lets the next one through as well.
    const third = record(await ask('job-3')).id
    const fourth = ask('job-4')
    engine.discard(third)
    expect(record(await fourth).state).toBe('whole')
  })

  it('answers "busy" to another session while one captures the same work tree', async () => {
    const { at, engine, ask } = setup('busy')
    const first = record(await ask('job-1')).id
    expect(await ask('job-2', { session: 's-two' })).toEqual({ state: 'busy', reason: 'busy' })
    engine.publish(first)
    const other = await ask('job-3', { session: 's-two', publish: true })
    expect(other).toMatchObject({ state: 'whole', published: true })
    // Two sessions in one repository each keep their own copy.
    expect(new TurnStore(at.dataRoot, 's-two', at.repo).record(record(other).id)).not.toBeNull()
    expect(new TurnStore(at.dataRoot, 's-one', at.repo).record(record(other).id)).toBeNull()
  })

  it('cancels a capture that waits for an earlier one, one that runs and one that is staged; none is published', async () => {
    const { at, engine, ask } = setup('cancel', 5_000)
    const first = record(await ask('job-1')).id
    const waiting = ask('job-2')
    engine.cancel('job-2')
    engine.publish(first)
    expect(await waiting).toEqual({ state: 'cancelled', reason: 'cancelled' })

    for (let n = 0; n < 30; n += 1) write(at.repo, `f${n}.txt`, `${n}\n`)
    let seen = 0
    const running = engine.capture({ job: 'job-3', session: 's-one', folder: at.repo, publish: true }, {
      beforeEntry: async () => {
        seen += 1
        if (seen === 5) engine.cancel('job-3')
        if (seen >= 5) await sleep(6)
      }
    })
    expect(await running).toEqual({ state: 'cancelled', reason: 'cancelled' })

    const stagedId = record(await ask('job-4')).id
    engine.cancel('job-4')
    expect(engine.publish(stagedId)).toBeNull()
    const store = engine.store('s-one', at.repo)
    await store.settled()
    expect(store.captures()).toEqual([first])
    expect(filesUnder(join(store.directory, 'staging'))).toBe(0)
    expect(filesUnder(join(store.directory, 'trash'))).toBe(0)
  })

  it('compares two captures and reads one file\'s difference, also through the port the host uses', async () => {
    const { at, engine, ask } = setup('compare')
    write(at.repo, 'a.txt', 'one\n')
    const one = record(await ask('job-1', { publish: true }))
    await sleep(25)
    write(at.repo, 'a.txt', 'one\ntwo\n')
    const two = record(await ask('job-2', { publish: true, base: one.id }))
    const pair = { session: 's-one', root: at.repo, a: one.id, b: two.id }
    expect(engine.compare(pair)).toMatchObject({ state: 'compared', files: [{ path: 'a.txt', state: 'changed', added: 1, removed: 0 }] })
    const port = inProcessPort(engine)
    expect(await port.difference({ ...pair, path: 'a.txt' })).toMatchObject({ state: 'text', added: 1, removed: 0 })
    expect(await port.compare(pair)).toMatchObject({ state: 'compared' })
    expect(await port.compare(pair, AbortSignal.abort())).toEqual({ state: 'cancelled', reason: 'cancelled' })
    // The second capture read only what was new.
    expect(two.bytesRead).toBe('one\ntwo\n'.length)
  })

  it('stops a capture through the port when the caller gives up', async () => {
    const { at, engine } = setup('port')
    const port = inProcessPort(engine)
    expect(await port.capture({ job: 'job-1', session: 's-one', folder: at.repo, publish: true }, AbortSignal.abort())).toEqual({ state: 'cancelled', reason: 'cancelled' })
    const controller = new AbortController()
    const staged = await port.capture({ job: 'job-2', session: 's-one', folder: at.repo, publish: false }, controller.signal)
    controller.abort()
    expect(await port.publish(record(staged).id)).not.toBeNull()
  })
})

describe('the space the stores may take', () => {
  const FULL = { state: 'incomplete', record: { state: 'incomplete', bound: 'store full', tree: null, bytesStored: 0 } }
  /** A place whose repository holds one more file, and an engine with these bounds over the place's data root. */
  function bounded(name: string, limits: Partial<TurnLimits>, dataRoot?: string): { at: Place; engine: TurnChangesEngine } {
    const at = scratch(name)
    places.push(at)
    write(at.repo, 'a.txt', 'x'.repeat(4_000))
    const engine = new TurnChangesEngine({ dataRoot: dataRoot ?? at.dataRoot, home: at.home, limits })
    engines.push(engine)
    return { at, engine }
  }
  const take = (engine: TurnChangesEngine, session: string, folder: string, job = `job-${session}-${folder}`): Promise<TurnCaptureAnswer> =>
    engine.capture({ job, session, folder, publish: true })
  /** What one capture of such a repository stores: its files' bytes and its folder lists. */
  async function need(): Promise<number> {
    const probe = bounded('bound-probe', {})
    return record(await take(probe.engine, 's-one', probe.at.repo)).bytesStored
  }

  it('lets one session store up to its bound, all its work trees together, and ends a capture that would pass it as "incomplete: store full"', async () => {
    const one = await need()
    expect(one).toBeGreaterThan(4_000)
    for (const [bound, state] of [[2 * one, 'whole'], [2 * one - 1, 'incomplete']] as const) {
      const first = bounded(`session-${state}-a`, { storeBytes: bound })
      const second = bounded(`session-${state}-b`, {})
      expect(await take(first.engine, 's-one', first.at.repo)).toMatchObject({ state: 'whole' })
      // The same session in another work tree: its copy there counts against the same bound.
      const answer = await take(first.engine, 's-one', second.at.repo)
      expect(answer).toMatchObject(state === 'whole' ? { state: 'whole' } : FULL)
      // Another session has a bound of its own.
      expect(await take(first.engine, 's-two', second.at.repo)).toMatchObject({ state: 'whole' })
      expect((await inProcessKeeper(first.engine).usage()).sessions).toEqual({ 's-one': state === 'whole' ? 2 * one : one, 's-two': one })
    }
  })

  it('lets all sessions together store up to their bound, each counting its own copy, and removes nothing kept to make room', async () => {
    const one = await need()
    for (const [bound, state] of [[2 * one, 'whole'], [2 * one - 1, 'incomplete']] as const) {
      const { at, engine } = bounded(`all-${state}`, { allStoresBytes: bound })
      const kept = record(await take(engine, 's-one', at.repo))
      // A second session in the same repository keeps its own copy of every file.
      const answer = await take(engine, 's-two', at.repo)
      expect(answer).toMatchObject(state === 'whole' ? { state: 'whole' } : FULL)
      const keeper = inProcessKeeper(engine)
      // A capture that ended "store full" is kept as that word and holds no byte.
      expect(await keeper.usage()).toEqual(state === 'whole' ? { sessions: { 's-one': one, 's-two': one }, all: 2 * one } : { sessions: { 's-one': one, 's-two': 0 }, all: one })
      expect(engine.store('s-one', at.repo).record(kept.id)?.state).toBe('whole')
      if (state === 'whole') continue
      // An engine that starts on this data root counts the same from the disk.
      const again = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits: { allStoresBytes: bound } })
      engines.push(again)
      expect(await inProcessKeeper(again).usage()).toEqual({ sessions: { 's-one': one, 's-two': 0 }, all: one })
      expect(await take(again, 's-two', at.repo, 'job-again')).toMatchObject(FULL)
      // What is counted is what is on disk after a removal: once the first session's store has gone, the second fits.
      await keeper.removeSession('s-one')
      expect(await take(engine, 's-two', at.repo, 'job-after')).toMatchObject({ state: 'whole' })
      expect(await keeper.usage()).toEqual({ sessions: { 's-two': one }, all: one })
    }
  })
})

describe('a capture for a session', () => {
  const answer: TurnRefusal = { state: 'busy', reason: 'busy' }

  it('starts from the folder Linux reports for the terminal\'s foreground process, never from a folder a caller names', async () => {
    const capture = vi.fn().mockResolvedValue(answer)
    const port = { ...inProcessPort(new TurnChangesEngine({ dataRoot: '/nowhere', home: '/nowhere' })), capture }
    const result = await captureSessionWorkTree(port, { identity: () => '1:200:20:1:2', folder: (identity) => (identity === '1:200:20:1:2' ? '/the/agent/folder' : null) },
      { job: 'job-1', session: 's-one', named: '/a/named/folder', publish: false })
    expect(capture).toHaveBeenCalledWith({ job: 'job-1', session: 's-one', named: '/a/named/folder', publish: false, folder: '/the/agent/folder' }, undefined)
    expect(result).toEqual({ ...answer, foreground: '1:200:20:1:2' })
  })

  it('is unavailable and reads nothing when the terminal has no foreground process, or that process is gone', async () => {
    const capture = vi.fn()
    const port = { ...inProcessPort(new TurnChangesEngine({ dataRoot: '/nowhere', home: '/nowhere' })), capture }
    const request = { job: 'job-1', session: 's-one', named: '/a/named/folder', publish: false }
    expect(await captureSessionWorkTree(port, { identity: () => null, folder: () => '/never/asked' }, request)).toEqual({ state: 'unavailable', reason: 'the terminal has no foreground process' })
    expect(await captureSessionWorkTree(port, { identity: () => '1:200:20:1:2', folder: () => null }, request)).toEqual({ state: 'unavailable', reason: 'the terminal has no foreground process' })
    expect(capture).not.toHaveBeenCalled()
  })
})
