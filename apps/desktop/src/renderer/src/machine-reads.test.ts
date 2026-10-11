// MODULE: machine-reads.test.ts - Story 63.4: reads of the machine are shown in the order they began, never pile up, and a read begun before an update ended is not taken for fresh
import { describe, expect, it } from 'vitest'
import { createMachineReads, endedSince } from './machine-reads'

interface Reading { version: string; checkedAt: number }

/** Reads the test answers by hand, a clock it moves, and what the page would show. */
function page(): {
  reads: ReturnType<typeof createMachineReads>; asked: () => number; answer(index: number, value: Reading): Promise<void>; fail(index: number): Promise<void>
  shown: () => { answer: Reading; began: number } | null; errors: () => number; busy: () => boolean[]; time: { now: number }
} {
  const time = { now: 1_000 }
  const pending: { resolve(value: Reading): void; reject(error: Error): void }[] = []
  let shown: { answer: Reading; began: number } | null = null
  let errors = 0
  const busy: boolean[] = []
  const reads = createMachineReads<Reading>({
    fetch: () => new Promise<Reading>((resolve, reject) => { pending.push({ resolve, reject }) }),
    adopt: (answer, began) => { shown = { answer, began } },
    failed: () => { errors += 1 },
    reading: (on) => { busy.push(on) },
    now: () => time.now
  })
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve() }
  return {
    reads, asked: () => pending.length, shown: () => shown, errors: () => errors, busy: () => busy, time,
    answer: async (index, value) => { pending[index]?.resolve(value); await settle() },
    fail: async (index) => { pending[index]?.reject(new Error('synthetic')); await settle() }
  }
}

describe('reads of the machine (63.4)', () => {
  it('shows the new version from a second read when the first began before the update ended, whatever time the first stamped inside it (AC2)', async () => {
    const health = page()
    // Health reads while the updater still runs; the version is read first, the time is stamped later.
    void health.reads.read()
    health.time.now = 2_000
    const endedAt = health.time.now
    // The end is heard while that read is under way: one more is asked for, begun after the end.
    health.time.now = 2_001
    const done = health.reads.read()
    expect(health.asked()).toBe(1)
    // The first read comes back after the end with a later time inside it and the old version: it is not shown.
    await health.answer(0, { version: '2.1.295', checkedAt: 2_500 })
    expect(health.shown()).toBeNull()
    expect(health.asked()).toBe(2)
    await health.answer(1, { version: '2.1.296', checkedAt: 2_600 })
    await done
    expect(health.shown()).toEqual({ answer: { version: '2.1.296', checkedAt: 2_600 }, began: 2_001 })
    expect(endedSince(health.shown()?.began ?? null, endedAt)).toBe(false)
    expect(health.busy()).toEqual([true, false])
  })

  it('does not take a read for fresh by the time inside it: one begun before the end is read again once it is shown (AC2)', async () => {
    const health = page()
    void health.reads.read()
    // Nobody asked for another read (a confirmation was open), so the answer is shown, with when its read began.
    health.time.now = 2_000
    await health.answer(0, { version: '2.1.295', checkedAt: 2_500 })
    const shown = health.shown()
    expect(shown?.began).toBe(1_000)
    // The time inside the answer is after the end; when the read began is before it, and that is what counts.
    expect((shown?.answer.checkedAt ?? 0) > 2_000).toBe(true)
    expect(endedSince(shown?.began ?? null, 2_000)).toBe(true)
  })

  it('keeps at most one read under way and one owed through a burst of prompts (AC3)', async () => {
    const health = page()
    const all = [health.reads.read(), health.reads.read(), health.reads.read(), health.reads.read(), health.reads.read()]
    expect(health.asked()).toBe(1)
    await health.answer(0, { version: 'a', checkedAt: 1 })
    // One more read for all who asked meanwhile, and no third.
    expect(health.asked()).toBe(2)
    expect(health.shown()).toBeNull()
    await health.answer(1, { version: 'b', checkedAt: 2 })
    await Promise.all(all)
    expect(health.asked()).toBe(2)
    expect(health.shown()?.answer.version).toBe('b')
    // The next one asked for begins at once again.
    void health.reads.read()
    expect(health.asked()).toBe(3)
  })

  it('drops an earlier read that arrives after an answer shown from elsewhere, without an error, and reads once more (AC1)', async () => {
    const health = page()
    void health.reads.read()
    // An action's outcome arrives with its own, newer reading while that read is still under way.
    health.time.now = 1_500
    expect(health.reads.shownElsewhere()).toBe(1_500)
    await health.fail(0)
    expect([health.errors(), health.shown()]).toEqual([0, null])
    expect(health.asked()).toBe(2)
    await health.answer(1, { version: 'after', checkedAt: 3 })
    expect(health.shown()).toEqual({ answer: { version: 'after', checkedAt: 3 }, began: 1_500 })
    // With no read under way an answer from elsewhere owes nothing.
    health.reads.shownElsewhere()
    expect(health.asked()).toBe(2)
  })

  it('says so when the read begun last failed, and is ready for the next', async () => {
    const health = page()
    const done = health.reads.read()
    await health.fail(0)
    await done
    expect([health.errors(), health.busy()]).toEqual([1, [true, false]])
    void health.reads.read()
    await health.answer(1, { version: 'c', checkedAt: 4 })
    expect(health.shown()?.answer.version).toBe('c')
  })
})
