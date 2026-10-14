// MODULE: turn-changes-client.test.ts - the real worker thread, asked from the host's side: a capture and its comparison, a comparison stopped while it runs with the host's own thread left free, the stop where no line is compared and in the search for secrets, named secret values of config files masked in every kind of line, and a worker that died
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TURN_SECRET_PLATE, type TurnShownLine } from '@bmn/protocol'
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
      // Its work ends a little before its 2 s, so that this answer is given inside them.
      expect(performance.now() - started).toBeLessThan(2_000)
    } finally {
      clearInterval(ticking)
    }
    expect(longest).toBeLessThan(100)
  })

  it('stops within 100 ms where no line is compared: a file that is all new, millions of short lines, and text made to be slow to search for secrets', async () => {
    const { at, client } = setup('worker-bounds')
    const one = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true }))
    // About 9 MiB of short lines, all new; one line of 2 MiB that is secret-shaped from end to end; and one line
    // of 9 MiB that opens a quote and never closes it, in a file whose names and brackets are read to its end.
    write(at.repo, 'lines.txt', Array.from({ length: 1_500_000 }, (_value, n) => `r${n % 977}`).join('\n') + '\n')
    write(at.repo, 'keys.txt', `${'sk-'.repeat(700_000)}\nplain\n`)
    write(at.repo, 'config.yaml', `${'a-'.repeat(400_000)}\ntoken: "${'eyJ'.repeat(200_000)}\n`)
    write(at.repo, 'huge.json', `{"note": "${'sk-eyJ '.repeat(1_300_000)}\n`)
    const two = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true, base: one.id }))
    const pair = { session: 's-one', root: at.repo, a: one.id, b: two.id }
    const compared = await client.compare(pair)
    expect(compared).toMatchObject({ state: 'compared', totals: { files: 4, partial: false } })
    for (const path of ['lines.txt', 'keys.txt', 'config.yaml', 'huge.json']) {
      // Left alone it answers inside its 2 s, with every bound of what is shown kept and no value in it.
      const began = performance.now()
      const whole = await client.difference({ ...pair, path })
      expect(performance.now() - began, path).toBeLessThan(2_000)
      expect(whole.state, path).toBe('text')
      expect(JSON.stringify(whole).length, path).toBeLessThan(2_000_000)
      expect(JSON.stringify(whole), path).not.toMatch(/sk-sk-|eyJeyJ|sk-eyJ/)
      // Stopped at once, and stopped a moment after it began: heard within 100 ms both times.
      for (const wait of [0, 20]) {
        const controller = new AbortController()
        const answer = client.difference({ ...pair, path }, controller.signal)
        await sleep(wait)
        const stoppedAt = performance.now()
        controller.abort()
        expect(await answer, `${path} after ${wait} ms`).toEqual({ state: 'cancelled', reason: 'cancelled' })
        expect(performance.now() - stoppedAt, `${path} after ${wait} ms`).toBeLessThan(100)
      }
    }
    const controller = new AbortController()
    const answer = client.compare(pair, controller.signal)
    await sleep(10)
    const stoppedAt = performance.now()
    controller.abort()
    expect(await answer).toEqual({ state: 'cancelled', reason: 'cancelled' })
    expect(performance.now() - stoppedAt).toBeLessThan(100)
  }, 60_000)

  it('hands back no named secret value of a config file, in removed, added or unchanged lines, however the file writes it, with the counts of the original texts', async () => {
    const { at, client } = setup('worker-masks')
    // Values no known shape and no long run would find: only their names say what they are. In each file one
    // stays (an unchanged line beside the change), one changes (removed and added lines), and a plain line changes.
    const files = (was: 'old' | 'new'): Record<string, string> => ({
      'nested.json': `{"db": {"user": "shop", "password": "MADEUPctxJ"},\n "auth": {"client": {"key": "MADEUP${was}J"}},\n "retries": "${was}"}\n`,
      'block.yaml': `service: shop\nprivate_key: |\n  MADEUPctxY one\n  MADEUPctxY two\nsigning_secret: >-\n  MADEUP${was}Y folded\nretries: ${was}\n`,
      'strings.toml': `name = "shop"\napi_token = """\nMADEUPctxT\nmore MADEUPctxT"""\nsession_secret = """MADEUP${was}T"""\nretries = "${was}"\n`,
      '.env': `NAME=shop\nCERT="MADEUPctxE\nsecond MADEUPctxE"\nOTHER="MADEUP${was}E\ntail MADEUP${was}E"\nRETRIES=${was}\n`,
      // A list begun inside a map written on one line; a name that stands past what is shown of its line, with a
      // value that goes on into lines that are shown; a token and a value on the line after `Bearer` and after a name.
      'list.json': `{"tokens": [\n  "MADEUPctxL"\n],\n "keys": [\n  "MADEUP${was}L"\n],\n "retries": "${was}"}\n`,
      'far.env': `NAME=shop\n${' '.repeat(4_049)}CERT="MADEUPctxF\nsecond MADEUPctxF"\n${' '.repeat(4_049)}OTHER="MADEUP${was}F\ntail MADEUP${was}F"\nRETRIES=${was}\n`,
      'notes.txt': `Authorization: Bearer\nMADEUPctxNabcdefghijklmn\npassword:\n  MADEUP${was}Nhunter\nretries ${was}\n`
    })
    for (const [name, content] of Object.entries(files('old'))) write(at.repo, name, content)
    const one = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true }))
    await sleep(25)
    for (const [name, content] of Object.entries(files('new'))) write(at.repo, name, content)
    const two = record(await client.capture({ job: turnJobId(), session: 's-one', folder: at.repo, publish: true, base: one.id }))
    const pair = { session: 's-one', root: at.repo, a: one.id, b: two.id }
    const changed: Record<string, number> = { 'nested.json': 2, 'block.yaml': 2, 'strings.toml': 2, '.env': 3, 'list.json': 2, 'far.env': 3, 'notes.txt': 2 }
    for (const [path, lines] of Object.entries(changed)) {
      const answer = await client.difference({ ...pair, path })
      if (answer.state !== 'text') throw new Error(`${path}: ${answer.state}`)
      // The counts and the line numbers are the original texts'.
      expect(answer, path).toMatchObject({ added: lines, removed: lines, more: 0 })
      const shown = answer.hunks.flatMap((hunk) => hunk.lines).filter((line): line is TurnShownLine => line.kind !== '\\')
      for (const kind of [' ', '-', '+'] as const) {
        expect(shown.some((line) => line.kind === kind && line.text.includes(TURN_SECRET_PLATE)), `${path}: a masked "${kind}" line`).toBe(true)
      }
      expect(shown.filter((line) => line.kind === '+'), path).toHaveLength(lines)
      // Nothing the worker hands back holds a value, whichever line it stood in.
      expect(JSON.stringify(answer), path).not.toContain('MADEUP')
    }
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
  // Story 69.4 added the one way in: `turn.mark`, which answers a status word. Neither the control socket nor
  // the `bmn` command loads anything that scans, compares or reads the store, and no command reads a turn.
  it('is one control-socket method that marks a turn; the socket and the bmn command load nothing that reads a capture', () => {
    const server = readFileSync(join(here, 'control-server.ts'), 'utf8')
    const cli = readFileSync(join(here, '../../bin/bmn'), 'utf8')
    const marks = readFileSync(join(here, '../../bin/turn-marks.mjs'), 'utf8')
    expect(server).not.toMatch(/from '\.\/turn-changes/)
    expect(cli).not.toMatch(/turn-changes/)
    expect(marks).not.toMatch(/turn-changes-|child_process|readFile|createReadStream|readdir/)
    expect([...server.matchAll(/case '(turn[^']*)'/g)].map((match) => match[1])).toEqual(['turn.mark'])
    expect([...new Set([...cli.matchAll(/method: '(turn[^']*)'/g)].map((match) => match[1]))]).toEqual(['turn.mark'])
  })
})
