// MODULE: turn-changes-client.test.ts - the real worker thread, asked from the host's side: a capture and its comparison, a comparison stopped while it runs with the host's own thread left free, and a worker that died
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnChangesClient, TurnChangesUnavailable, turnJobId } from './turn-changes-client'
import type { TurnCaptureAnswer } from './turn-changes-engine'
import type { TurnCaptureRecord } from './turn-changes-store'
import { scratch, sleep, write, type Place } from './test-fixtures/turn-changes/fixtures'

const here = dirname(fileURLToPath(import.meta.url))
// The worker is the product's own file, run by plain Node: the app's build is not needed to test the thread.
const WORKER = join(here, 'turn-changes-worker.ts')
const RESOLVE = pathToFileURL(join(here, 'test-fixtures/turn-changes/ts-resolve.mjs')).href

const places: Place[] = []
const clients: TurnChangesClient[] = []
function setup(name: string): { at: Place; client: TurnChangesClient } {
  const at = scratch(name)
  places.push(at)
  const client = new TurnChangesClient(WORKER, { dataRoot: at.dataRoot, home: at.home }, { execArgv: ['--import', RESOLVE] })
  clients.push(client)
  return { at, client }
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const made of places.splice(0)) made.done()
})

const record = (answer: TurnCaptureAnswer): TurnCaptureRecord => {
  if (!('record' in answer)) throw new Error(`refused: ${answer.state}: ${answer.reason}`)
  return answer.record
}

describe('the turn changes worker thread', () => {
  it('captures, publishes on confirmation, compares and reads one file\'s difference', async () => {
    const { at, client } = setup('worker')
    write(at.repo, 'a.txt', 'one\n')
    const staged = await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: false })
    expect(staged).toMatchObject({ state: 'whole', published: false })
    const one = await client.publish(record(staged).id)
    expect(one?.id).toBe(record(staged).id)
    expect(await client.publish(record(staged).id)).toBeNull()
    await sleep(25)
    write(at.repo, 'a.txt', 'one\ntwo\n')
    const two = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true, base: record(staged).id }))
    const pair = { session: 's-one', root: at.repo, a: record(staged).id, b: two.id }
    expect(await client.compare(pair)).toMatchObject({ state: 'compared', files: [{ path: 'a.txt', state: 'changed', added: 1, removed: 0 }], totals: { files: 1, added: 1, removed: 0 } })
    expect(await client.difference({ ...pair, path: 'a.txt' })).toMatchObject({ state: 'text', added: 1, removed: 0 })
    // A refusal travels as it is; a folder outside every repository reads nothing.
    expect(await client.capture({ job: turnJobId(), session: 's-one', folder: at.home, publish: true })).toMatchObject({ state: 'unavailable' })
    // Forgetting a session drops only what the worker holds in memory; the store is read again from the disk.
    await client.forget('s-one')
    expect(await client.compare(pair)).toMatchObject({ state: 'compared', totals: { files: 1, added: 1, removed: 0 } })
    expect(await client.compare({ ...pair, b: 'no-such-capture' })).toMatchObject({ state: 'unavailable' })

    // Keeping the store in order goes through the same thread: counts and ids, then removal.
    const [store] = await client.inventory()
    expect(store).toMatchObject({ session: 's-one', captures: [{ id: record(staged).id }, { id: two.id }] })
    const before = await client.usage()
    expect(before.all).toBeGreaterThan(0)
    expect(before.sessions).toEqual({ 's-one': before.all })
    await client.removeCaptures({ session: 's-one', key: store!.key, captures: [record(staged).id] })
    expect((await client.inventory())[0]?.captures.map((capture) => capture.id)).toEqual([two.id])
    expect((await client.usage()).all).toBeLessThan(before.all)
    expect(await client.compare(pair)).toMatchObject({ state: 'unavailable' })
    await client.clearLeftovers()
    await client.removeSession('s-one')
    expect(await client.inventory()).toEqual([])
    expect(await client.usage()).toEqual({ sessions: {}, all: 0 })
    // A name that could reach outside the store is refused, with the fixed words.
    await expect(client.removeSession('../s-one')).rejects.toBeInstanceOf(TurnChangesUnavailable)
    await expect(client.removeCaptures({ session: 's-one', key: '../../x', captures: [] })).rejects.toBeInstanceOf(TurnChangesUnavailable)
  })

  it('stops a comparison and one file\'s difference within 100 ms, while the host\'s own thread stays free', async () => {
    const { at, client } = setup('worker-stop')
    const long = (prefix: string): string => `${Array.from({ length: 60000 }, (_, n) => `${prefix}${n}`).join('\n')}\n`
    write(at.repo, 'long.txt', long('a'))
    const one = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true }))
    await sleep(25)
    write(at.repo, 'long.txt', long('b'))
    const two = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true, base: one.id }))
    const pair = { session: 's-one', root: at.repo, a: one.id, b: two.id }

    // The host's thread: a timer every 5 ms, and the longest wait between two of its turns while the worker compares.
    let last = performance.now()
    let longest = 0
    const ticking = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 5)
    try {
      for (const ask of [
        (signal: AbortSignal) => client.compare(pair, signal),
        (signal: AbortSignal) => client.difference({ ...pair, path: 'long.txt' }, signal)
      ]) {
        const controller = new AbortController()
        const answer = ask(controller.signal)
        await sleep(150)
        const stoppedAt = performance.now()
        controller.abort()
        // It was still comparing when it was stopped: left alone it runs to its limit of 2 s and says so, as below.
        expect(await answer).toEqual({ state: 'cancelled', reason: 'cancelled' })
        expect(performance.now() - stoppedAt).toBeLessThan(100)
      }
      const started = performance.now()
      expect(await client.compare(pair)).toEqual({ state: 'unavailable', reason: 'Difference unavailable: limit reached' })
      expect(performance.now() - started).toBeLessThan(2_600)
    } finally {
      clearInterval(ticking)
    }
    expect(longest).toBeLessThan(100)
  })

  it('answers "unavailable" with fixed words when the worker dies, and starts it again for the next request', async () => {
    const { at, client } = setup('worker-died')
    const first = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true }))
    const dead = new TurnChangesClient(join(here, 'test-fixtures/turn-changes/no-such-worker.ts'), { dataRoot: at.dataRoot, home: at.home }, { execArgv: ['--import', RESOLVE] })
    clients.push(dead)
    const failure = await dead.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TurnChangesUnavailable)
    expect((failure as Error).message).toBe('turn changes are unavailable')
    // The same client, its thread ended from outside: the request in flight is refused, the next one is served by a new thread.
    const internals = client as unknown as { worker: { terminate: () => Promise<number> } | null }
    await internals.worker?.terminate()
    const second = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true, base: first.id }))
    expect(second.base).toBe(first.id)
    await client.close()
    await expect(client.compare({ session: 's-one', root: at.repo, a: first.id, b: second.id })).rejects.toBeInstanceOf(TurnChangesUnavailable)
  })
})

describe('what can reach a capture', () => {
  // Criterion 11 of Story 69.2: this story adds no way in. A method that marks a turn comes with Story 69.4, and its own test.
  it('is no control-socket method and no bmn command', () => {
    for (const file of ['control-server.ts', '../../bin/bmn']) {
      expect(readFileSync(join(here, file), 'utf8'), file).not.toMatch(/turn-changes|turnChanges|TurnChanges/)
    }
  })
})
