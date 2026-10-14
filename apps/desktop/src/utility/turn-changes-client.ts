// MODULE: turn-changes-client.ts - the host's side of the turn changes worker: asks for captures and comparisons, cancels them, and starts the worker again when it died
import { randomUUID } from 'node:crypto'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { refusal, type TurnRefusal } from './turn-changes-capture'
import type { TurnShownDifference } from '@bmn/protocol'
import type { TurnComparison } from './turn-changes-compare'
import type {
  TurnCaptureAnswer, TurnCaptureRequest, TurnChangesPort, TurnPairRequest, TurnStoreInventory, TurnStoreKeeper, TurnStoreUsage
} from './turn-changes-engine'
import type { TurnCaptureRecord } from './turn-changes-store'
import type { TurnWorkerData, TurnWorkerRequest, TurnWorkerResponse } from './turn-changes-worker'

/** A request the worker could not answer. Its text is fixed: nothing of a capture is in it. */
export class TurnChangesUnavailable extends Error {
  constructor() {
    super('turn changes are unavailable')
    this.name = 'TurnChangesUnavailable'
  }
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type Body = TurnWorkerRequest extends infer Request ? (Request extends { id: number } ? Omit<Request, 'id'> : never) : never

export class TurnChangesClient implements TurnChangesPort, TurnStoreKeeper {
  private readonly entry: string | URL
  private readonly data: TurnWorkerData
  private readonly workerOptions: WorkerOptions
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(entry: string | URL, data: TurnWorkerData, workerOptions: WorkerOptions = {}) {
    this.entry = entry
    this.data = data
    this.workerOptions = workerOptions
  }

  private start(): Worker {
    const worker = new Worker(this.entry, { ...this.workerOptions, workerData: this.data })
    const failAll = (): void => {
      if (this.worker === worker) this.worker = null
      for (const [id, pending] of this.pending) {
        this.pending.delete(id)
        pending.reject(new TurnChangesUnavailable())
      }
    }
    worker.on('message', (response: TurnWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response.result)
      else pending.reject(new TurnChangesUnavailable())
    })
    worker.on('error', failAll)
    worker.on('exit', failAll)
    // Nothing waits for this thread when the host ends.
    worker.unref()
    return worker
  }

  private request<Result>(body: Body): Promise<Result> {
    if (this.closed) return Promise.reject(new TurnChangesUnavailable())
    return new Promise<Result>((resolve, reject) => {
      const id = this.nextId
      this.nextId += 1
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      try {
        this.worker ??= this.start()
        this.worker.postMessage({ id, ...body } as TurnWorkerRequest)
      } catch {
        this.pending.delete(id)
        reject(new TurnChangesUnavailable())
      }
    })
  }

  capture(request: TurnCaptureRequest, signal?: AbortSignal): Promise<TurnCaptureAnswer> {
    if (signal?.aborted) return Promise.resolve(refusal('cancelled', 'cancelled'))
    const cancel = (): void => {
      void this.request({ operation: 'cancel', params: { job: request.job } }).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    return this.request<TurnCaptureAnswer>({ operation: 'capture', params: request }).finally(() => signal?.removeEventListener('abort', cancel))
  }

  /** The time and the stop go with the request: the worker reads both itself, and the host's thread need not be free to stop it. */
  publish(capture: string, until?: number, signal?: AbortSignal): Promise<TurnCaptureRecord | null> {
    const stop = new SharedArrayBuffer(4)
    const raise = (): void => {
      Atomics.store(new Int32Array(stop), 0, 1)
    }
    // Stopped already: it is asked all the same, so that the worker discards it at once.
    if (signal?.aborted) raise()
    signal?.addEventListener('abort', raise, { once: true })
    return this.request<TurnCaptureRecord | null>({ operation: 'publish', params: { capture, ...(until === undefined ? {} : { until }) }, stop })
      .finally(() => signal?.removeEventListener('abort', raise))
  }

  async discard(capture: string): Promise<void> {
    await this.request({ operation: 'discard', params: { capture } })
  }

  async forget(session: string): Promise<void> {
    await this.request({ operation: 'forget', params: { session } })
  }

  async removeCaptures(request: { session: string; key: string; captures: string[] }): Promise<void> {
    await this.request({ operation: 'remove-captures', params: request })
  }

  async removeSession(session: string): Promise<void> {
    await this.request({ operation: 'remove-session', params: { session } })
  }

  async clearLeftovers(): Promise<void> {
    await this.request({ operation: 'clear-leftovers' })
  }

  inventory(): Promise<TurnStoreInventory[]> {
    return this.request({ operation: 'inventory' })
  }

  usage(): Promise<TurnStoreUsage> {
    return this.request({ operation: 'usage' })
  }

  compare(request: TurnPairRequest, signal?: AbortSignal): Promise<TurnComparison | TurnRefusal> {
    return this.stoppable(signal, (stop) => this.request({ operation: 'compare', params: request, stop }))
  }

  difference(request: TurnPairRequest & { path: string }, signal?: AbortSignal): Promise<TurnShownDifference | TurnRefusal> {
    return this.stoppable(signal, (stop) => this.request({ operation: 'difference', params: request, stop }))
  }

  /** A comparison is stopped through one shared number, which the worker reads while it compares. */
  private stoppable<Result>(signal: AbortSignal | undefined, ask: (stop: SharedArrayBuffer) => Promise<Result>): Promise<Result | TurnRefusal> {
    if (signal?.aborted) return Promise.resolve(refusal('cancelled', 'cancelled'))
    const stop = new SharedArrayBuffer(4)
    const raise = (): void => {
      Atomics.store(new Int32Array(stop), 0, 1)
    }
    signal?.addEventListener('abort', raise, { once: true })
    return ask(stop).finally(() => signal?.removeEventListener('abort', raise))
  }

  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    this.worker = null
    await worker?.terminate()
  }
}

/** A name for one capture's work, to cancel it by. */
export const turnJobId = (): string => randomUUID()
