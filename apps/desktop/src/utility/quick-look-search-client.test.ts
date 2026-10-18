// MODULE: quick-look-search-client.test.ts - the real Quick look search worker, asked from the host's side: the same answer as the search itself, the host's thread left free while crafted files of hidden values are masked, a stop that lands inside a file, a worker that does not stop, and one that cannot start (Story 67.5 AC6)
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@bmn/protocol'
import { QuickLookSearchClient } from './quick-look-search-client'
import { searchQuickLookContents } from './quick-look-search'

const here = dirname(fileURLToPath(import.meta.url))
// The worker is the product's own file, run by plain Node: the app's build is not needed to test the thread.
const WORKER = join(here, 'quick-look-search-worker.ts')
const RESOLVE = pathToFileURL(join(here, 'test-fixtures/turn-changes/ts-resolve.mjs')).href
const OPTIONS = { execArgv: ['--import', RESOLVE] }

const folders: string[] = []
const clients: QuickLookSearchClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

function client(entry: string = WORKER, graceMs?: number): QuickLookSearchClient {
  const made = new QuickLookSearchClient(entry, OPTIONS, graceMs)
  clients.push(made)
  return made
}

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-quick-look-worker-'))
  folders.push(root)
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content)
  return root
}

const ask = (query: string) => ({ query, matchCase: false, wholeWord: false })
const megabyte = (unit: string): string => unit.repeat(Math.floor(1_048_576 / unit.length))
/** Files of a megabyte each that hold the host's thread for 100 ms or more when masked on it. */
const CRAFTED = {
  'a.json': megabyte('API_KEY=x\n'),
  'b.json': megabyte('"password":"x",'),
  'c.md': megabyte('eyJaa.aa.bb '),
  'd.env': megabyte('NAME=madeup\n'),
  'e.md': megabyte(`sk-${'a'.repeat(24)} api `)
}

describe('the Quick look search worker', () => {
  it('answers as the search itself does, masked, from its own thread', async () => {
    const root = await folder({ '.env': 'TOKEN=madeup-secret-value\nPLAIN=madeup\n', 'notes.md': 'madeup line\npassword = madeupsecretvalue\n' })
    const viaWorker = await client().contents(root, ask('password'), new AbortController().signal)
    const direct = await searchQuickLookContents(root, { ...ask('password'), gitRoot: async () => null }, new AbortController().signal)
    expect(viaWorker.matchCount).toBe(1)
    expect({ ...viaWorker, elapsedMs: 0 }).toEqual({ ...direct, elapsedMs: 0 })
    expect(JSON.stringify(viaWorker)).not.toContain('madeupsecretvalue')
    expect(JSON.stringify(viaWorker)).toContain(SECRET_MASK)
  })

  it('leaves the host\'s thread a turn every few ms while it masks crafted megabyte files of hidden values', async () => {
    const root = await folder(CRAFTED)
    const searching = client()
    for (const query of ['api', 'password', 'eyJ', 'NAME']) {
      let last = performance.now()
      let longest = 0
      const ticker = setInterval(() => {
        const now = performance.now()
        longest = Math.max(longest, now - last)
        last = now
      }, 5)
      const result = await searching.contents(root, ask(query), new AbortController().signal)
      clearInterval(ticker)
      // A query that matches every line of a file stops at 2,000 lines, so how many files were read varies.
      expect(result).toMatchObject({ cancelled: false, unavailable: null })
      expect(result.filesRead).toBeGreaterThanOrEqual(1)
      expect(longest, query).toBeLessThan(50)
    }
  }, 120_000)

  it('stops inside a file\'s masking, not after it', async () => {
    const root = await folder({ 'a.json': CRAFTED['a.json'], 'b.json': CRAFTED['b.json'], 'd.env': CRAFTED['d.env'] })
    const searching = client()
    // Warm: the thread is started and its modules loaded before the time is taken.
    await searching.contents(root, ask('zz-none'), new AbortController().signal)
    const controller = new AbortController()
    const started = performance.now()
    const running = searching.contents(root, ask('key'), controller.signal)
    setTimeout(() => controller.abort(), 20)
    expect(await running).toMatchObject({ cancelled: true, unavailable: null })
    // Masking the first of these files alone takes 100 ms or more: the stop is heard inside it.
    expect(performance.now() - started).toBeLessThan(90)
    // The same thread answers the next search.
    expect((await searching.contents(root, ask('api'), new AbortController().signal)).cancelled).toBe(false)
  }, 60_000)

  it('ends a worker that does not answer a stop, and starts another for the next search', async () => {
    const root = await folder({ 'a.md': 'madeup\n' })
    const silent = client(join(here, 'test-fixtures/quick-look/silent-worker.mjs'), 50)
    for (let round = 0; round < 2; round += 1) {
      const controller = new AbortController()
      const running = silent.contents(root, ask('madeup'), controller.signal)
      const started = performance.now()
      controller.abort()
      expect(await running).toMatchObject({ cancelled: true, files: [] })
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  it('says the search is unavailable when its thread cannot start, and runs nothing on the host\'s', async () => {
    const root = await folder({ 'a.md': 'madeup\n' })
    const result = await client(join(here, 'test-fixtures/quick-look/no-such-worker.ts')).contents(root, ask('madeup'), new AbortController().signal)
    expect(result).toMatchObject({ cancelled: false, unavailable: 'Search is unavailable', files: [] })
  })
})
