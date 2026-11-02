// MODULE: load-clock.ts - Story 102.1: time bounds in tests that mean the same on a quiet machine and on one at twice its cores' load
import { Worker } from 'node:worker_threads'

/**
 * This thread's own CPU time in milliseconds. A bound on work done on this thread uses it: on a busy machine the wall clock
 * also counts the time other processes had the CPU, which the work cannot shorten (Story 91.6); on a quiet one they agree.
 */
export function threadWork(): number {
  const used = process.threadCpuUsage()
  return (used.user + used.system) / 1000
}

/** The limit of a capture whose clock the test moves by hand: its reading ends 250 ms before, its sliced work 100 ms before. */
export const HAND_LIMIT_MS = 60_000

/**
 * A capture's clock that stands still until the test moves it, for what happens at a capture's limits: the margins there are
 * capped at 250 and 100 ms of its time, which a busy machine can take from any real wait, however long the limit.
 */
export function handClock(): { clock: () => number; readingOver: () => void; passed: () => void } {
  let now = 0
  return {
    clock: () => now,
    /** Past the end of its reading, with time left to keep what it read. */
    readingOver: () => { now = HAND_LIMIT_MS - 240 },
    passed: () => { now = HAND_LIMIT_MS + 1 }
  }
}

/**
 * Something that happens elsewhere (a worker, a stop heard across threads), timed beside a control timer on this thread. `late`
 * is the longest that timer ran behind meanwhile, less what this thread itself worked in that time: what the machine took, near
 * zero on a quiet one, and never this thread's own blocking work. So `took` under a limit plus `late` keeps the limit where the
 * machine has room, does not fail what the machine imposed, and still fails work that blocks.
 */
export async function timedBesideControl<T>(run: () => Promise<T>): Promise<{ answer: T; took: number; late: number }> {
  const every = 5
  let last = performance.now()
  let lastWork = threadWork()
  let late = 0
  const control = setInterval(() => {
    const now = performance.now()
    const work = threadWork()
    late = Math.max(late, now - last - every - (work - lastWork))
    last = now
    lastWork = work
  }, every)
  try {
    const began = performance.now()
    const answer = await run()
    const took = performance.now() - began
    // Its own lateness is known only when it runs: one more turn, so a thread held during the stop counts.
    await new Promise((resolve) => setTimeout(resolve, every * 2))
    return { answer, took, late }
  } finally {
    clearInterval(control)
  }
}

/** The control thread's body: it spins, and counts the time between two looks at the clock that the machine gave to others. */
const CONTROL_THREAD = `
const { workerData } = require('node:worker_threads')
const words = new Int32Array(workerData)
let last = performance.now()
let taken = 0
Atomics.store(words, 1, 1)
while (Atomics.load(words, 0) === 0) {
  const now = performance.now()
  if (now - last > 0.5) {
    taken += now - last
    Atomics.store(words, 2, Math.round(taken))
  }
  last = now
}
`

/**
 * A thread at work, as a worker doing a stop's steps is, beside what is timed. A timer's thread sleeps and is woken first on a
 * busy machine; a thread at work waits its turn. So what is timed on another working thread is bounded by the time this one lost
 * over the same window: near zero on a quiet machine, whatever load does on a busy one, and a stop slow by its own work stays slow.
 */
export async function workingControl(): Promise<{ timed: <T>(run: () => Promise<T>) => Promise<{ answer: T; took: number; late: number }>; end: () => Promise<void> }> {
  const shared = new SharedArrayBuffer(12)
  const words = new Int32Array(shared)
  const thread = new Worker(CONTROL_THREAD, { eval: true, workerData: shared })
  while (Atomics.load(words, 1) === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  return {
    timed: async (run) => {
      const from = Atomics.load(words, 2)
      const { answer, took, late } = await timedBesideControl(run)
      return { answer, took, late: Math.max(late, Atomics.load(words, 2) - from) }
    },
    end: async () => {
      Atomics.store(words, 0, 1)
      await thread.terminate()
    }
  }
}
