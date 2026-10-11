// MODULE: machine-reads.ts - Story 63.4: reads of the machine in the order they began: one under way, one owed, and only the answer of the read begun last is shown; kept pure for tests

export interface MachineReads {
  /**
   * Reads the machine. With a read under way this one is owed: it begins when that one has ended, and however
   * many ask meanwhile there is one. The answer of the read under way is then the older one and is dropped, an
   * error with it. Resolves once no read is under way any more.
   */
  read(): Promise<void>
  /**
   * An answer was shown from elsewhere just now, such as what an action left behind. Returns when; a read under
   * way began before it, so it is followed by one more and its own answer is dropped.
   */
  shownElsewhere(): number
}

export interface MachineReadSeams<T> {
  fetch(): Promise<T>
  /** Shows an answer; `began` is when its read was asked for, which is what its freshness is judged by. */
  adopt(answer: T, began: number): void
  /** The read begun last failed. */
  failed(error: unknown): void
  /** Whether a read is under way. */
  reading(on: boolean): void
  now?(): number
}

export function createMachineReads<T>(seams: MachineReadSeams<T>): MachineReads {
  const now = seams.now ?? Date.now
  let chain: { promise: Promise<void>; resolve(): void } | null = null
  let owed = false

  const begin = (): void => {
    const began = now()
    let asked: Promise<T>
    try {
      asked = seams.fetch()
    } catch (error) {
      asked = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    void asked.then((answer) => ({ answer }), (error: unknown) => ({ error })).then((result) => {
      if (owed) {
        owed = false
        begin()
        return
      }
      const ended = chain
      chain = null
      if ('error' in result) seams.failed(result.error)
      else seams.adopt(result.answer, began)
      seams.reading(false)
      ended?.resolve()
    })
  }

  return {
    read() {
      if (chain !== null) {
        owed = true
        return chain.promise
      }
      let resolve = (): void => {}
      const promise = new Promise<void>((done) => { resolve = done })
      chain = { promise, resolve }
      seams.reading(true)
      begin()
      return promise
    },
    shownElsewhere() {
      if (chain !== null) owed = true
      return now()
    }
  }
}

/**
 * Whether what is shown was read before an update command ended, so that it may be the state from before the
 * update. Judged by when the read began, never by a time stamped inside its answer: a read begun before the end
 * stamps a later time while it still reports what it read first. A read whose beginning is not known is the older one.
 */
export function endedSince(began: number | null, endedAt: number | null): boolean {
  return endedAt !== null && !(began !== null && began > endedAt)
}
