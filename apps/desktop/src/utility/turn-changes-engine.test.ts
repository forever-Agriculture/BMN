// MODULE: turn-changes-engine.test.ts - the order of a session's captures, "busy" between sessions, staged captures that are published, discarded or let go, both bounds of what the stores hold on disk with room held for captures that run at once, and a capture for a session's terminal
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCapturing, type TurnLimits, type TurnRefusal } from './turn-changes-capture'
import { TurnChangesEngine, inProcessKeeper, inProcessPort, type TurnCaptureAnswer, type TurnCaptureRequest } from './turn-changes-engine'
import { captureSessionWorkTree } from './turn-changes-service'
import { TurnStore, type TurnCaptureRecord } from './turn-changes-store'
import { bytesUnder, filesUnder, scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

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
    expect((await engine.publish(id))?.id).toBe(id)
    expect(store.record(id)?.id).toBe(id)
    expect(await engine.publish(id)).toBeNull()
  })

  it('removes the bytes of a staged capture that is discarded, and of one nobody settles in time', async () => {
    const { at, engine, ask } = setup('let-go', 60)
    const discarded = record(await ask('job-1')).id
    await engine.discard(discarded)
    expect(await engine.publish(discarded)).toBeNull()
    const forgotten = record(await ask('job-2')).id
    await sleep(120)
    expect(await engine.publish(forgotten)).toBeNull()
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
    await engine.publish(first)
    const later = record(await second)
    // The later capture ran after the earlier one was real: it was taken to be compared with it, and it saw the new file.
    expect(later.base).toBe(first)
    expect(later.counts.entries).toBe(2)
    expect(later.startedAt).toBeGreaterThanOrEqual(engine.store('s-one', at.repo).record(first)?.endedAt ?? Infinity)
    await engine.discard(later.id)
    // A discarded earlier capture lets the next one through as well.
    const third = record(await ask('job-3')).id
    const fourth = ask('job-4')
    await engine.discard(third)
    expect(record(await fourth).state).toBe('whole')
  })

  it('answers "busy" to another session while one captures the same work tree', async () => {
    const { at, engine, ask } = setup('busy')
    const first = record(await ask('job-1')).id
    expect(await ask('job-2', { session: 's-two' })).toEqual({ state: 'busy', reason: 'busy' })
    await engine.publish(first)
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
    await engine.publish(first)
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
    expect(await engine.publish(stagedId)).toBeNull()
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
  /** A place whose repository holds one more file, and an engine with these bounds over a data root. */
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
  const adds = (answer: TurnCaptureAnswer): number => {
    if (!('record' in answer)) throw new Error(`refused: ${answer.state}: ${answer.reason}`)
    return answer.adds
  }
  /** What a capture of this work tree would put on disk for this session: taken staged, then discarded, its bytes gone. */
  async function wouldAdd(engine: TurnChangesEngine, session: string, folder: string): Promise<number> {
    const answer = await engine.capture({ job: `probe-${session}-${folder}`, session, folder, publish: false })
    await engine.discard(record(answer).id)
    await engine.store(session, folder).settled()
    return adds(answer)
  }

  it('counts what a capture puts on disk: its files and lists, its own record and its cache', async () => {
    const { at, engine } = bounded('on-disk', {})
    const answer = await take(engine, 's-one', at.repo)
    const store = engine.store('s-one', at.repo)
    expect(adds(answer)).toBe(store.keptBytes())
    expect(store.keptBytes()).toBe(store.size('objects') + store.size('captures') + store.cacheBytes())
    expect(store.size('captures')).toBeGreaterThan(0)
    expect(store.cacheBytes()).toBeGreaterThan(0)
    expect(await inProcessKeeper(engine).usage()).toEqual({ sessions: { 's-one': store.keptBytes() }, all: store.keptBytes() })
    expect(record(answer).bytesStored).toBe(store.size('objects'))
  })

  it('lets one session store up to its bound, all its work trees together, and ends a capture that would pass it by one byte as "incomplete: store full"', async () => {
    for (const state of ['whole', 'incomplete'] as const) {
      const first = bounded(`session-${state}-a`, {})
      const second = bounded(`session-${state}-b`, {})
      const one = adds(await take(first.engine, 's-one', first.at.repo))
      expect(one).toBeGreaterThan(4_000)
      // The same session in another work tree: its copy there counts against the same bound.
      const two = await wouldAdd(first.engine, 's-one', second.at.repo)
      const engine = new TurnChangesEngine({ dataRoot: first.at.dataRoot, home: first.at.home, limits: { storeBytes: one + two - (state === 'whole' ? 0 : 1) } })
      engines.push(engine)
      const answer = await take(engine, 's-one', second.at.repo)
      expect(answer).toMatchObject(state === 'whole' ? { state: 'whole' } : FULL)
      expect(adds(answer)).toBe(state === 'whole' ? two : engine.store('s-one', second.at.repo).size('captures'))
      // Another session has a bound of its own.
      const other = await take(engine, 's-two', second.at.repo)
      expect(other).toMatchObject({ state: 'whole' })
      expect((await inProcessKeeper(engine).usage()).sessions).toEqual({ 's-one': one + adds(answer), 's-two': adds(other) })
    }
  })

  it('lets all sessions together store up to their bound, each counting its own copy, and removes nothing kept to make room', async () => {
    for (const state of ['whole', 'incomplete'] as const) {
      const { at, engine: free } = bounded(`all-${state}`, {})
      const kept = await take(free, 's-one', at.repo)
      const one = adds(kept)
      // A second session in the same repository keeps its own copy of every file.
      const two = await wouldAdd(free, 's-two', at.repo)
      const limits = { allStoresBytes: one + two - (state === 'whole' ? 0 : 1) }
      const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits })
      engines.push(engine)
      const answer = await take(engine, 's-two', at.repo)
      expect(answer).toMatchObject(state === 'whole' ? { state: 'whole' } : FULL)
      const keeper = inProcessKeeper(engine)
      // A capture that ended "store full" is kept as that word: a record of a few bytes, counted like any other, and no file.
      expect(await keeper.usage()).toEqual({ sessions: { 's-one': one, 's-two': adds(answer) }, all: one + adds(answer) })
      expect(engine.store('s-one', at.repo).record(record(kept).id)?.state).toBe('whole')
      if (state === 'whole') continue
      expect(adds(answer)).toBeLessThan(1_000)
      expect(engine.store('s-two', at.repo).size('objects')).toBe(0)
      // An engine that starts on this data root counts the same from the disk, once what was dropped is gone from it.
      await engine.store('s-two', at.repo).settled()
      const again = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits })
      engines.push(again)
      expect(await inProcessKeeper(again).usage()).toEqual({ sessions: { 's-one': one, 's-two': adds(answer) }, all: one + adds(answer) })
      expect(await take(again, 's-two', at.repo, 'job-again')).toMatchObject(FULL)
      // What is counted is what is on disk after a removal: once the first session's store has gone, the second fits.
      await keeper.removeSession('s-one')
      const after = await take(engine, 's-two', at.repo, 'job-after')
      expect(after).toMatchObject({ state: 'whole' })
      // This engine counted its own two captures. The other engine's record of a few bytes is on disk as well, and all of it is inside the bound.
      expect(await keeper.usage()).toEqual({ sessions: { 's-two': adds(answer) + adds(after) }, all: adds(answer) + adds(after) })
      expect(engine.store('s-two', at.repo).keptBytes()).toBeLessThanOrEqual(limits.allStoresBytes)
    }
  })

  it('holds room for every capture that runs, so two sessions capturing at once cannot both take the same last bytes', async () => {
    const first = bounded('at-once-a', {})
    const second = bounded('at-once-b', {})
    const one = await wouldAdd(first.engine, 's-one', first.at.repo)
    const two = await wouldAdd(first.engine, 's-two', second.at.repo)
    // Room for either capture, and one byte too little for both.
    const limits = { allStoresBytes: one + two - 1 }
    const engine = new TurnChangesEngine({ dataRoot: first.at.dataRoot, home: first.at.home, limits })
    engines.push(engine)
    let running = 0
    let together = 0
    const slow = { beforeEntry: async (): Promise<void> => {
      running += 1
      together = Math.max(together, running)
      await sleep(30)
      running -= 1
    } }
    const answers = await Promise.all([
      engine.capture({ job: 'job-a', session: 's-one', folder: first.at.repo, publish: true }, slow),
      engine.capture({ job: 'job-b', session: 's-two', folder: second.at.repo, publish: true }, slow)
    ])
    // Both were reading at the same time, and only one of them was given the room.
    expect(together).toBe(2)
    expect(answers.map((answer) => answer.state).sort()).toEqual(['incomplete', 'whole'])
    expect(answers.find((answer) => answer.state === 'incomplete')).toMatchObject(FULL)
    const usage = await inProcessKeeper(engine).usage()
    expect(usage.all).toBeLessThanOrEqual(limits.allStoresBytes)
    await engine.store('s-one', first.at.repo).settled()
    await engine.store('s-two', second.at.repo).settled()
    // Counted from the disk by an engine that starts now: the same, and inside the bound.
    const again = new TurnChangesEngine({ dataRoot: first.at.dataRoot, home: first.at.home, limits })
    engines.push(again)
    expect(await inProcessKeeper(again).usage()).toEqual(usage)
    expect(usage.all).toBe(bytesUnder(join(first.at.dataRoot, 'turn-changes')))
    // With nothing else running, the one that found no room fits or does not by what is on disk alone.
    const later = await engine.capture({ job: 'job-c', session: 's-three', folder: second.at.repo, publish: true })
    expect(later).toMatchObject(FULL)
  })

  it('stops a publication when its job is cancelled between two files: nothing of it is kept or counted', async () => {
    const { at, engine } = bounded('cancel-publication', {})
    for (let n = 0; n < 50; n += 1) write(at.repo, `f${n}.txt`, `content ${n}\n`)
    const answer = await engine.capture({ job: 'job-1', session: 's-one', folder: at.repo, publish: true }, {
      beforeMove: (moved) => {
        if (moved === 10) engine.cancel('job-1')
      }
    })
    expect(answer).toEqual({ state: 'cancelled', reason: 'cancelled' })
    const store = engine.store('s-one', at.repo)
    await store.settled()
    expect(store.captures()).toEqual([])
    expect(filesUnder(at.dataRoot)).toBe(0)
    expect((await inProcessKeeper(engine).usage()).all).toBe(0)
    expect(isCapturing(at.repo)).toBe(false)
    expect(await take(engine, 's-one', at.repo, 'job-2')).toMatchObject({ state: 'whole', published: true })
  })

  it('stops the publication of a staged capture that is discarded, or whose job is cancelled, meanwhile', async () => {
    const { at, engine } = bounded('discard-publication', {})
    for (let n = 0; n < 50; n += 1) write(at.repo, `f${n}.txt`, `content ${n}\n`)
    const store = engine.store('s-one', at.repo)
    let id = ''
    const one = await engine.capture({ job: 'job-1', session: 's-one', folder: at.repo, publish: false }, {
      beforeMove: (moved) => {
        if (moved === 10) void engine.discard(id)
      }
    })
    id = record(one).id
    expect(await engine.publish(id)).toBeNull()
    await store.settled()
    expect(store.captures()).toEqual([])
    expect(filesUnder(at.dataRoot)).toBe(0)
    const two = await engine.capture({ job: 'job-2', session: 's-one', folder: at.repo, publish: false }, {
      beforeMove: (moved) => {
        if (moved === 10) engine.cancel('job-2')
      }
    })
    expect(await engine.publish(record(two).id)).toBeNull()
    await store.settled()
    expect(filesUnder(at.dataRoot)).toBe(0)
    expect((await inProcessKeeper(engine).usage()).all).toBe(0)
    expect(isCapturing(at.repo)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('goes on counting what a capture dropped and could not remove, also when it ended "store full", until a start cleared it', async () => {
    const { at, engine: free } = bounded('stuck', {})
    const probe = await free.capture({ job: 'probe', session: 's-one', folder: at.repo, publish: false })
    const stagedBytes = record(probe).bytesStored
    await free.discard(record(probe).id)
    await free.store('s-one', at.repo).settled()
    // Room for its files and lists and not for its record and cache beside them: it ends "store full" and drops what it staged.
    const limits = { storeBytes: stagedBytes + 300 }
    const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits })
    engines.push(engine)
    const store = engine.store('s-one', at.repo)
    const answer = await engine.capture({ job: 'job-1', session: 's-one', folder: at.repo, publish: true }, {
      // Its staged files cannot be unlinked.
      beforeRecord: () => chmodSync(join(store.directory, 'staging', readdirSync(join(store.directory, 'staging'))[0] as string, 'blobs'), 0o500)
    })
    const trash = join(store.directory, 'trash')
    const keeper = inProcessKeeper(engine)
    try {
      expect(answer).toMatchObject(FULL)
      await store.settled()
      const onDisk = bytesUnder(join(at.dataRoot, 'turn-changes'))
      expect(onDisk).toBeGreaterThan(4_000)
      // Never less than what is there: the files that could not be removed are still counted.
      expect((await keeper.usage()).all).toBeGreaterThanOrEqual(onDisk)
      // Another session's capture, with all stores bounded just above what is counted: there is no room for it.
      const tight = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits: { allStoresBytes: onDisk + 1_000 } })
      engines.push(tight)
      expect(await take(tight, 's-two', at.repo)).toMatchObject(FULL)
    } finally {
      // They can be removed again.
      chmodSync(join(trash, readdirSync(trash)[0] as string, 'blobs'), 0o700)
    }
    // A start clears them and counts the disk.
    await keeper.clearLeftovers()
    expect((await keeper.usage()).all).toBe(bytesUnder(join(at.dataRoot, 'turn-changes')))
    expect(filesUnder(trash)).toBe(0)
  })

  it('counts a cache that shrinks as well as one that grows: after every publication its number is what a count of the disk finds', async () => {
    const { at, engine } = bounded('cache-sizes', {})
    const keeper = inProcessKeeper(engine)
    const store = engine.store('s-one', at.repo)
    const agree = async (): Promise<void> => {
      await store.settled()
      expect((await keeper.usage()).all).toBe(bytesUnder(join(at.dataRoot, 'turn-changes')))
    }
    for (let n = 0; n < 200; n += 1) write(at.repo, `many/f${n}.txt`, `content ${n}\n`)
    expect(await take(engine, 's-one', at.repo, 'job-1')).toMatchObject({ state: 'whole' })
    const large = store.cacheBytes()
    await agree()
    rmSync(join(at.repo, 'many'), { recursive: true })
    const smaller = await take(engine, 's-one', at.repo, 'job-2')
    expect(smaller).toMatchObject({ state: 'whole' })
    expect(store.cacheBytes()).toBeLessThan(large)
    // The store shrank by more than this capture's list and record added.
    expect(adds(smaller)).toBeLessThan(0)
    await agree()
    for (let n = 0; n < 100; n += 1) write(at.repo, `more/f${n}.txt`, `other ${n}\n`)
    expect(adds(await take(engine, 's-one', at.repo, 'job-3'))).toBeGreaterThan(0)
    await agree()
  })

  it('counts what a crash left under a store against the bounds, and no longer once a start cleared it', async () => {
    const { at, engine: first } = bounded('leftovers', {})
    const kept = adds(await take(first, 's-one', at.repo))
    const need = await wouldAdd(first, 's-two', at.repo)
    const store = first.store('s-one', at.repo)
    // A staged capture, a discarded one and two half-written files, 1,000 bytes each.
    for (const part of ['staging/old/blobs', 'trash/old/blobs']) {
      mkdirSync(join(store.directory, part), { recursive: true })
      writeFileSync(join(store.directory, part, 'left'), 'x'.repeat(1_000))
    }
    writeFileSync(join(store.directory, 'cache.json.new'), 'x'.repeat(1_000))
    writeFileSync(join(store.directory, 'captures', 'old.json.new'), 'x'.repeat(1_000))
    const limits = { allStoresBytes: kept + 4_000 + need - 1 }
    const engine = new TurnChangesEngine({ dataRoot: at.dataRoot, home: at.home, limits })
    engines.push(engine)
    const keeper = inProcessKeeper(engine)
    expect((await keeper.usage()).sessions['s-one']).toBe(kept + 4_000)
    expect(await take(engine, 's-two', at.repo)).toMatchObject(FULL)
    await keeper.clearLeftovers()
    expect((await keeper.usage()).sessions['s-one']).toBe(kept)
    expect(bytesUnder(store.directory)).toBe(kept)
    expect(store.captures()).toHaveLength(1)
    // What the refused capture dropped counts until it is gone from the disk.
    await engine.store('s-two', at.repo).settled()
    expect(await take(engine, 's-two', at.repo, 'job-after')).toMatchObject({ state: 'whole' })
    expect((await keeper.usage()).all).toBe(bytesUnder(join(at.dataRoot, 'turn-changes')))
  })

  it('counts everything from the disk again after a start cleared what a crash left', async () => {
    const { at, engine } = bounded('recount', {})
    const answer = await take(engine, 's-one', at.repo)
    const keeper = inProcessKeeper(engine)
    await keeper.clearLeftovers()
    expect(await keeper.usage()).toEqual({ sessions: { 's-one': adds(answer) }, all: adds(answer) })
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
