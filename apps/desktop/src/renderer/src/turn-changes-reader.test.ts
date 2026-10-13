// MODULE: turn-changes-reader.test.ts - the dialog's reads in the order they are answered: a late answer never brings back a turn that is no longer kept and never replaces another turn or page, and every page of a turn's files is reached
import type { TurnDetail, TurnDetailAnswer, TurnDifferenceAnswer, TurnFileView, TurnSummary } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { TurnReader, type TurnReads } from './turn-changes-reader'

interface Held<Value> {
  answer: (value: Value) => Promise<void>
  fail: (error: unknown) => Promise<void>
}
/** Lets what an answer set in motion run. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })
function hold<Value>(): { promise: Promise<Value> } & Held<Value> {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {
    promise,
    answer: async (value) => {
      resolve(value)
      await settled()
    },
    fail: async (error) => {
      reject(error)
      await settled()
    }
  }
}

function turn(turnId: string, change: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turnId, number: 1, app: 'codex', appVersion: '0.162.1', startedAt: '2026-10-13T11:05:02.000Z', endedAt: '2026-10-13T11:09:42.000Z', end: 'finished',
    state: 'closed', totalsState: 'complete', totals: { files: 2, added: 3, removed: 1 }, wording: null, ...change
  }
}
const file = (path: string): TurnFileView => ({ path, state: 'changed', added: 1, removed: 1, note: null, opens: true })
function detail(turnId: string, change: Partial<TurnDetail> = {}): TurnDetail {
  const files = change.files ?? [file('a.txt'), file('b.txt')]
  return { turn: turn(turnId), workTree: '/home/synthetic/code/shop', labels: [], files, from: 0, total: files.length, unavailable: null, ...change }
}
const kept = (turnId: string, change: Partial<TurnDetail> = {}): TurnDetailAnswer => ({ kept: true, detail: detail(turnId, change) })
const SHOWN: TurnDifferenceAnswer = { kept: true, difference: { state: 'text', added: 1, removed: 1, hunks: [], more: 0 } }

/** A dialog's reader over reads that answer only when the test says so, in the order it says. */
function world(options: { wide?: boolean } = {}) {
  const lists: Array<Held<TurnSummary[]>> = []
  const details: Array<Held<TurnDetailAnswer> & { turnId: string; from: number }> = []
  const differences: Array<Held<TurnDifferenceAnswer> & { turnId: string; path: string }> = []
  const failures: string[] = []
  const counts = { drawn: 0 }
  const reads: TurnReads = {
    listTurns: () => {
      const held = hold<TurnSummary[]>()
      lists.push(held)
      return held.promise
    },
    readTurn: (_sessionId, turnId, from = 0) => {
      const held = hold<TurnDetailAnswer>()
      details.push({ ...held, turnId, from })
      return held.promise
    },
    readTurnDifference: (_sessionId, turnId, path) => {
      const held = hold<TurnDifferenceAnswer>()
      differences.push({ ...held, turnId, path })
      return held.promise
    }
  }
  const reader = new TurnReader(reads, 's1', {
    changed: () => { counts.drawn += 1 },
    failed: (_error, words) => failures.push(words),
    opensLatest: () => options.wide ?? true
  })
  return { reader, lists, details, differences, failures, counts }
}
/** A dialog whose list was read and whose turn `t-1` is open and read. */
async function opened(change: Partial<TurnDetail> = {}): Promise<ReturnType<typeof world>> {
  const w = world()
  w.reader.list()
  await w.lists[0]!.answer([turn('t-2', { state: 'open', end: null, endedAt: null, totals: null, totalsState: 'none' }), turn('t-1')])
  await w.details[0]!.answer(kept('t-1', change))
  expect(w.reader.state.opened).toMatchObject({ state: 'read', turnId: 't-1' })
  return w
}

describe('opening the dialog', () => {
  it('opens the latest ended turn with it where the list stands beside the detail, and none in a narrow dialog', async () => {
    const wide = world()
    wide.reader.list()
    expect(wide.reader.state).toEqual({ turns: null, opened: null, bodies: new Map() })
    await wide.lists[0]!.answer([turn('t-2', { state: 'open', end: null }), turn('t-1')])
    expect(wide.reader.state.turns?.map((row) => row.turnId)).toEqual(['t-2', 't-1'])
    expect(wide.reader.state.opened).toEqual({ state: 'reading', turnId: 't-1' })
    expect(wide.details.map((asked) => [asked.turnId, asked.from])).toEqual([['t-1', 0]])

    const narrow = world({ wide: false })
    narrow.reader.list()
    await narrow.lists[0]!.answer([turn('t-1')])
    expect(narrow.reader.state.opened).toBeNull()
    expect(narrow.details).toHaveLength(0)
  })

  it('takes the latest list only, and says so when it cannot be read', async () => {
    const w = world({ wide: false })
    w.reader.list()
    w.reader.list()
    await w.lists[1]!.answer([turn('t-2')])
    await w.lists[0]!.answer([turn('t-1')])
    expect(w.reader.state.turns?.map((row) => row.turnId)).toEqual(['t-2'])
    w.reader.list()
    await w.lists[2]!.fail(new Error('made-up'))
    expect(w.failures).toEqual(['The turns could not be read'])
  })
})

describe('a turn removed while it is open', () => {
  it('says "No longer kept" when its row has gone from the list, and stays so when the read that was on its way answers that it is kept', async () => {
    const w = await opened()
    // Its row changed, so its detail is being read again: that read is held.
    w.reader.list()
    await w.lists[1]!.answer([turn('t-1', { totals: { files: 3, added: 4, removed: 1 } })])
    expect(w.details).toHaveLength(2)
    expect(w.reader.state.opened).toMatchObject({ state: 'read', turnId: 't-1' })
    // The sweep removes the turn: the list no longer has it.
    w.reader.list()
    await w.lists[2]!.answer([])
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
    // The old read answers now, from before the removal.
    await w.details[1]!.answer(kept('t-1'))
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
    expect(w.reader.state.bodies.size).toBe(0)
  })

  it('stays "No longer kept" when its very first read was still on its way', async () => {
    const w = world()
    w.reader.list()
    await w.lists[0]!.answer([turn('t-1')])
    expect(w.reader.state.opened).toEqual({ state: 'reading', turnId: 't-1' })
    w.reader.list()
    await w.lists[1]!.answer([])
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
    await w.details[0]!.answer(kept('t-1'))
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
  })

  it('says so when a read of its files or of a difference answers that it is no longer kept, and no earlier answer undoes that', async () => {
    const w = await opened()
    w.reader.toggle('a.txt')
    w.reader.toggle('b.txt')
    expect([...w.reader.state.bodies.values()]).toEqual([{ state: 'reading' }, { state: 'reading' }])
    await w.differences[1]!.answer({ kept: false })
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
    expect(w.reader.state.bodies.size).toBe(0)
    // The first file's difference was read before the removal: it opens nothing under a turn that has gone.
    await w.differences[0]!.answer(SHOWN)
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
    expect(w.reader.state.bodies.size).toBe(0)

    const again = await opened()
    again.reader.page(0)
    again.reader.list()
    await again.lists[1]!.answer([turn('t-1', { wording: 'changed' })])
    await again.details[1]!.answer({ kept: false })
    expect(again.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
  })

  it('reads a turn that has gone again only when its row is chosen again, and then shows what that read answers', async () => {
    const w = await opened()
    w.reader.list()
    await w.lists[1]!.answer([])
    expect(w.reader.state.opened?.state).toBe('gone')
    w.reader.open('t-1')
    expect(w.reader.state.opened).toEqual({ state: 'reading', turnId: 't-1' })
    await w.details[1]!.answer({ kept: false })
    expect(w.reader.state.opened).toEqual({ state: 'gone', turnId: 't-1' })
  })
})

describe('answers out of order', () => {
  it('never lets an earlier turn\'s answer replace the turn opened after it', async () => {
    const w = world({ wide: false })
    w.reader.list()
    await w.lists[0]!.answer([turn('t-2'), turn('t-1')])
    w.reader.open('t-1')
    w.reader.open('t-2')
    await w.details[1]!.answer(kept('t-2'))
    await w.details[0]!.answer(kept('t-1'))
    expect(w.reader.state.opened).toMatchObject({ state: 'read', turnId: 't-2', detail: { turn: { turnId: 't-2' } } })
    // The turn that is open is not read again by choosing its row.
    w.reader.open('t-2')
    expect(w.details).toHaveLength(2)
  })

  it('opens nothing after Back, whatever answers then', async () => {
    const w = world({ wide: false })
    w.reader.list()
    await w.lists[0]!.answer([turn('t-1')])
    w.reader.open('t-1')
    w.reader.back()
    await w.details[0]!.answer(kept('t-1'))
    expect(w.reader.state.opened).toBeNull()
  })

  it('changes nothing once the dialog has closed', async () => {
    const w = await opened()
    w.reader.toggle('a.txt')
    w.reader.page(0)
    w.reader.list()
    const before = { state: w.reader.state, drawn: w.counts.drawn }
    w.reader.leave()
    await w.lists[1]!.answer([])
    await w.differences[0]!.answer({ kept: false })
    expect(w.reader.state).toBe(before.state)
    expect(w.counts.drawn).toBe(before.drawn)
  })

  it('closes the turn and says so when it cannot be read, and keeps what is shown when only its next page cannot', async () => {
    const w = world({ wide: false })
    w.reader.list()
    await w.lists[0]!.answer([turn('t-1')])
    w.reader.open('t-1')
    await w.details[0]!.fail(new Error('made-up'))
    expect(w.reader.state.opened).toBeNull()
    expect(w.failures).toEqual(['The turn could not be read'])

    const paged = await opened({ total: 2_002 })
    paged.reader.page(2_000)
    await paged.details[1]!.fail(new Error('made-up'))
    expect(paged.reader.state.opened).toMatchObject({ state: 'read', detail: { from: 0 } })
    expect(paged.failures).toEqual(['The turn could not be read'])
  })
})

describe('the pages of a turn\'s files', () => {
  const page = (from: number, total: number): Partial<TurnDetail> => ({ from, total, files: [file(`f-${from}.txt`), file(`f-${from + 1}.txt`)] })

  it('reads the page asked for, keeps the one shown until it answers, and reaches the last file of the turn', async () => {
    const w = await opened(page(0, 4_001))
    w.reader.page(2_000)
    expect(w.details.at(-1)).toMatchObject({ turnId: 't-1', from: 2_000 })
    // Until the answer is here the first page stands.
    expect(w.reader.state.opened).toMatchObject({ state: 'read', detail: { from: 0 } })
    await w.details[1]!.answer(kept('t-1', page(2_000, 4_001)))
    expect(w.reader.state.opened).toMatchObject({ state: 'read', detail: { from: 2_000, total: 4_001 } })
    w.reader.page(4_000)
    await w.details[2]!.answer(kept('t-1', { from: 4_000, total: 4_001, files: [file('f-4000.txt')] }))
    const last = w.reader.state.opened
    expect(last).toMatchObject({ state: 'read', detail: { from: 4_000, files: [{ path: 'f-4000.txt' }] } })
    // Its difference opens like any file's.
    w.reader.toggle('f-4000.txt')
    expect(w.differences.at(-1)).toMatchObject({ turnId: 't-1', path: 'f-4000.txt' })
    await w.differences.at(-1)!.answer(SHOWN)
    expect(w.reader.state.bodies.get('f-4000.txt')).toMatchObject({ state: 'shown' })
    // The page that is shown is not read again.
    w.reader.page(4_000)
    expect(w.details).toHaveLength(3)
  })

  it('takes the page asked for last, and closes what was open under the page before', async () => {
    const w = await opened(page(0, 6_000))
    w.reader.toggle('f-0.txt')
    w.reader.page(2_000)
    w.reader.page(4_000)
    await w.details[2]!.answer(kept('t-1', page(4_000, 6_000)))
    await w.details[1]!.answer(kept('t-1', page(2_000, 6_000)))
    expect(w.reader.state.opened).toMatchObject({ state: 'read', detail: { from: 4_000 } })
    expect(w.reader.state.bodies.size).toBe(0)
    // A difference asked for on the first page answers now: it has no row to stand under.
    await w.differences[0]!.answer(SHOWN)
    expect(w.reader.state.bodies.size).toBe(0)
  })

  it('reads the same page again when the turn was compared again', async () => {
    const w = await opened(page(0, 4_001))
    w.reader.page(2_000)
    await w.details[1]!.answer(kept('t-1', page(2_000, 4_001)))
    w.reader.list()
    await w.lists[1]!.answer([turn('t-1', { totals: { files: 4_002, added: 9, removed: 1 } })])
    expect(w.details.at(-1)).toMatchObject({ turnId: 't-1', from: 2_000 })
  })
})

describe('a file\'s difference', () => {
  it('opens under its row, closes again, and drops an answer for a file that was closed meanwhile', async () => {
    const w = await opened()
    w.reader.toggle('a.txt')
    expect(w.reader.state.bodies.get('a.txt')).toEqual({ state: 'reading' })
    await w.differences[0]!.answer(SHOWN)
    expect(w.reader.state.bodies.get('a.txt')).toMatchObject({ state: 'shown' })
    w.reader.toggle('a.txt')
    expect(w.reader.state.bodies.size).toBe(0)

    w.reader.toggle('b.txt')
    w.reader.toggle('b.txt')
    await w.differences[1]!.answer(SHOWN)
    expect(w.reader.state.bodies.size).toBe(0)

    w.reader.toggle('b.txt')
    await w.differences[2]!.answer({ kept: true, unavailable: 'Difference unavailable: limit reached' })
    expect(w.reader.state.bodies.get('b.txt')).toEqual({ state: 'unavailable', words: 'Difference unavailable: limit reached' })
    w.reader.toggle('a.txt')
    await w.differences[3]!.fail(new Error('made-up'))
    expect(w.reader.state.bodies.has('a.txt')).toBe(false)
    expect(w.failures).toEqual(['The difference could not be read'])
  })
})
