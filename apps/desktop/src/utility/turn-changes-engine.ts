// MODULE: turn-changes-engine.ts - runs captures and comparisons for the host: one capture per work tree at a time, a session's captures in order, staged until confirmed
//
// The engine lives in a worker thread (`turn-changes-worker.ts`), apart from the work that keeps
// terminals flowing. A capture is answered while still staged: the caller publishes it once the hook
// confirmed the answer, or discards it, and a staged capture nobody settles is discarded by itself.
import { capture, isRefusal, refusal, type CaptureSeams, type StagedCapture, type TurnLimits, type TurnRefusal } from './turn-changes-capture'
import { compareCaptures, fileDifference, type TurnComparison, type TurnDifference } from './turn-changes-compare'
import type { TurnGitCall } from './turn-changes-git'
import { TurnStore, type TurnCaptureRecord } from './turn-changes-store'

export interface TurnEngineOptions {
  dataRoot: string
  home: string
  git?: string | null
  limits?: Partial<TurnLimits>
  /** How long a staged capture waits to be published before it is discarded. */
  holdMs?: number
  observeGit?: (call: TurnGitCall) => void
}

export interface TurnCaptureRequest {
  /** The caller's name for this piece of work, to cancel it by. */
  job: string
  session: string
  /** The folder Linux reports for the foreground process of the session's terminal. */
  folder: string
  /** A folder a hook names; it must lie in the root BMN establishes. */
  named?: string | null
  base?: string | null
  /** Publish at once, for a capture nobody has to confirm. */
  publish: boolean
}

export type TurnCaptureAnswer =
  | TurnRefusal
  | { state: 'whole' | 'incomplete'; record: TurnCaptureRecord; published: boolean; tookMs: number }

export interface TurnPairRequest {
  session: string
  root: string
  a: string
  b: string
}

/** What the host may ask of the engine, whether it runs in a worker or, in a test, in the same thread. */
export interface TurnChangesPort {
  capture: (request: TurnCaptureRequest, signal?: AbortSignal) => Promise<TurnCaptureAnswer>
  /** Makes a staged capture real. Null when it is no longer staged: discarded, cancelled or never there. */
  publish: (capture: string) => Promise<TurnCaptureRecord | null>
  discard: (capture: string) => Promise<void>
  compare: (request: TurnPairRequest, signal?: AbortSignal) => Promise<TurnComparison | TurnRefusal>
  difference: (request: TurnPairRequest & { path: string }, signal?: AbortSignal) => Promise<TurnDifference | TurnRefusal>
}

interface Held {
  staged: StagedCapture
  timer: NodeJS.Timeout
  done: () => void
}

const DEFAULT_HOLD_MS = 1_000
const STORES_KEPT = 16

export class TurnChangesEngine {
  private readonly options: TurnEngineOptions
  private readonly running = new Map<string, AbortController>()
  private readonly held = new Map<string, Held>()
  private readonly heldByJob = new Map<string, string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly stores = new Map<string, TurnStore>()

  constructor(options: TurnEngineOptions) {
    this.options = options
  }

  /** The store of one session's work tree, with what it holds in memory; the oldest is let go past a few. */
  store(session: string, root: string): TurnStore {
    const key = `${session}\n${root}`
    let store = this.stores.get(key)
    if (store) this.stores.delete(key)
    else store = new TurnStore(this.options.dataRoot, session, root)
    this.stores.set(key, store)
    if (this.stores.size > STORES_KEPT) this.stores.delete(this.stores.keys().next().value as string)
    return store
  }

  /** Something under a session's stores was removed: what is held in memory of them no longer counts. */
  forget(session: string): void {
    for (const [key, store] of this.stores) {
      if (key.startsWith(`${session}\n`)) {
        store.forget()
        this.stores.delete(key)
      }
    }
  }

  async capture(request: TurnCaptureRequest, seams?: CaptureSeams): Promise<TurnCaptureAnswer> {
    const controller = new AbortController()
    this.running.set(request.job, controller)
    // A session's captures run in the order they were asked for: a later one starts only when the
    // earlier one was published, discarded, refused or cancelled.
    const earlier = this.tails.get(request.session) ?? Promise.resolve()
    let done = (): void => undefined
    const mine = new Promise<void>((resolve) => {
      done = resolve
    })
    const tail = earlier.then(() => mine)
    this.tails.set(request.session, tail)
    void tail.then(() => {
      if (this.tails.get(request.session) === tail) this.tails.delete(request.session)
    })
    let settledHere = true
    try {
      await earlier
      if (controller.signal.aborted) return refusal('cancelled', 'cancelled')
      const outcome = await capture(request.folder, {
        git: this.options.git, home: this.options.home, dataRoot: this.options.dataRoot, session: request.session,
        named: request.named ?? null, base: request.base ?? null, signal: controller.signal,
        ...(this.options.limits ? { limits: this.options.limits } : {}),
        ...(seams ? { seams } : {}),
        ...(this.options.observeGit ? { observeGit: this.options.observeGit } : {}),
        // The root is known only once the capture established it.
        storeFor: (root) => this.store(request.session, root)
      })
      if (isRefusal(outcome)) return outcome
      if (controller.signal.aborted) {
        outcome.discard()
        return refusal('cancelled', 'cancelled')
      }
      if (request.publish) {
        const record = outcome.publish()
        return { state: outcome.state, record, published: true, tookMs: outcome.tookMs }
      }
      const id = outcome.record.id
      const timer = setTimeout(() => this.settle(id, false), this.options.holdMs ?? DEFAULT_HOLD_MS)
      this.held.set(id, { staged: outcome, timer, done })
      this.heldByJob.set(request.job, id)
      settledHere = false
      return { state: outcome.state, record: outcome.record, published: false, tookMs: outcome.tookMs }
    } finally {
      this.running.delete(request.job)
      if (settledHere) done()
    }
  }

  private settle(capture: string, publish: boolean): TurnCaptureRecord | null {
    const held = this.held.get(capture)
    if (!held) return null
    this.held.delete(capture)
    for (const [job, id] of this.heldByJob) if (id === capture) this.heldByJob.delete(job)
    clearTimeout(held.timer)
    try {
      if (publish) return held.staged.publish()
      held.staged.discard()
      return null
    } finally {
      held.done()
    }
  }

  publish(capture: string): TurnCaptureRecord | null {
    return this.settle(capture, true)
  }

  discard(capture: string): void {
    this.settle(capture, false)
  }

  /** Stops a capture that is waiting or running, and discards it when it is already staged. */
  cancel(job: string): void {
    this.running.get(job)?.abort()
    const staged = this.heldByJob.get(job)
    if (staged) this.settle(staged, false)
  }

  compare(request: TurnPairRequest, cancelled?: () => boolean): TurnComparison | TurnRefusal {
    return compareCaptures(this.pairStore(request), request.a, request.b, {
      ...(this.options.limits?.compareMs === undefined ? {} : { limitMs: this.options.limits.compareMs }),
      ...(cancelled ? { cancelled } : {})
    })
  }

  difference(request: TurnPairRequest & { path: string }, cancelled?: () => boolean): TurnDifference | TurnRefusal {
    return fileDifference(this.pairStore(request), request.a, request.b, request.path, {
      ...(this.options.limits?.compareMs === undefined ? {} : { limitMs: this.options.limits.compareMs }),
      ...(cancelled ? { cancelled } : {})
    })
  }

  /** A comparison reads a store without keeping it in memory: it must not push out a store captures use. */
  private pairStore(request: TurnPairRequest): TurnStore {
    return this.stores.get(`${request.session}\n${request.root}`) ?? new TurnStore(this.options.dataRoot, request.session, request.root)
  }

  /** Discards everything staged; for the worker's end. */
  close(): void {
    for (const controller of this.running.values()) controller.abort()
    for (const capture of [...this.held.keys()]) this.settle(capture, false)
  }
}

/** The engine in the caller's own thread, as the port the host uses. For tests and for nothing else. */
export function inProcessPort(engine: TurnChangesEngine): TurnChangesPort {
  return {
    capture: (request, signal) => {
      const cancel = (): void => engine.cancel(request.job)
      if (signal?.aborted) return Promise.resolve(refusal('cancelled', 'cancelled'))
      signal?.addEventListener('abort', cancel, { once: true })
      return engine.capture(request).finally(() => signal?.removeEventListener('abort', cancel))
    },
    publish: (capture) => Promise.resolve(engine.publish(capture)),
    discard: (capture) => Promise.resolve(engine.discard(capture)),
    compare: (request, signal) => Promise.resolve(signal?.aborted ? refusal('cancelled', 'cancelled') : engine.compare(request, () => signal?.aborted === true)),
    difference: (request, signal) => Promise.resolve(signal?.aborted ? refusal('cancelled', 'cancelled') : engine.difference(request, () => signal?.aborted === true))
  }
}
