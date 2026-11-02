// MODULE: load-clock.ts - Story 102.1: time bounds in tests that mean the same on a quiet machine and on one at twice its cores' load

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
 * is the longest that timer ran behind meanwhile: what the machine took from any thread here, near zero on a quiet one. So
 * `took` under a limit plus `late` keeps the limit where the machine has room, and does not fail what the machine imposed.
 */
export async function timedBesideControl<T>(run: () => Promise<T>): Promise<{ answer: T; took: number; late: number }> {
  const every = 5
  let last = performance.now()
  let late = 0
  const control = setInterval(() => {
    const now = performance.now()
    late = Math.max(late, now - last - every)
    last = now
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
