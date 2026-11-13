// MODULE: update-restart-deadline.ts - the common monotonic clock and bounded waits for update shutdown
export const restartClock = (): number => Number(process.hrtime.bigint() / 1_000_000n)
/** A timed-out operation may finish later; callers fence its effects against their deadline and incarnation. */
export function beforeRestartDeadline<T>(operation: Promise<T>, deadline: number, timeoutValue: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(timeoutValue), Math.max(0, deadline - restartClock()))
    operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
