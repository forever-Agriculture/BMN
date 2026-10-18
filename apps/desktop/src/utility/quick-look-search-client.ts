// MODULE: quick-look-search-client.ts - the host's side of the Quick look search worker: asks for a contents search, stops it through a shared flag, and ends a worker that does not stop
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { QuickLookContentsResult } from '@bmn/protocol'
import type { ContentsSearchOptions } from './quick-look-search'
import type { QuickLookSearchWorkerRequest, QuickLookSearchWorkerResponse } from './quick-look-search-worker'

/** How long a stopped search may take to answer before its worker is ended and started again for the next one. */
const STOP_GRACE_MS = 1_000

interface Pending {
  root: string
  resolve: (result: QuickLookContentsResult) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** A search that found nothing because it did not run to the end: stopped, or with the worker gone. */
function unfinished(root: string, unavailable: string | null): QuickLookContentsResult {
  return { mode: 'contents', root, scope: 'walk', files: [], matchCount: 0, filesRead: 0, unreadable: 0, limit: null, cancelled: unavailable === null, unavailable, elapsedMs: 0 }
}

export class QuickLookSearchClient {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(
    private readonly entry: string | URL,
    private readonly workerOptions: WorkerOptions = {},
    private readonly graceMs = STOP_GRACE_MS
  ) {}

  private start(): Worker {
    const worker = new Worker(this.entry, this.workerOptions)
    const failAll = (): void => {
      if (this.worker !== worker) return
      this.worker = null
      for (const [id, pending] of this.pending) this.finish(id, unfinished(pending.root, 'Search is unavailable'))
    }
    worker.on('message', (response: QuickLookSearchWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (pending) this.finish(response.id, response.ok ? response.result : unfinished(pending.root, 'Search is unavailable'))
    })
    worker.on('error', failAll)
    worker.on('exit', failAll)
    // Nothing waits for this thread when the host ends.
    worker.unref()
    return worker
  }

  private finish(id: number, result: QuickLookContentsResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(result)
  }

  /**
   * One contents search in the worker. The signal sets the shared stop flag, which the search reads inside each file's
   * work; a worker that has not answered `graceMs` after the stop is ended, with every search it held, and the next
   * search starts a new one.
   */
  contents(root: string, options: Omit<ContentsSearchOptions, 'gitRoot' | 'stopped'>, signal: AbortSignal): Promise<QuickLookContentsResult> {
    if (this.closed) return Promise.resolve(unfinished(root, 'Search is unavailable'))
    if (signal.aborted) return Promise.resolve(unfinished(root, null))
    const stop = new SharedArrayBuffer(4)
    return new Promise<QuickLookContentsResult>((resolve) => {
      const id = this.nextId
      this.nextId += 1
      const pending: Pending = { root, resolve, timer: null }
      this.pending.set(id, pending)
      let worker: Worker
      try {
        worker = this.worker ??= this.start()
        worker.postMessage({ id, root, options, stop } satisfies QuickLookSearchWorkerRequest)
      } catch {
        this.finish(id, unfinished(root, 'Search is unavailable'))
        return
      }
      signal.addEventListener('abort', () => {
        Atomics.store(new Int32Array(stop), 0, 1)
        if (!this.pending.has(id)) return
        pending.timer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.finish(id, unfinished(root, null))
          if (this.worker === worker) {
            this.worker = null
            for (const [other, held] of this.pending) this.finish(other, unfinished(held.root, 'Search is unavailable'))
            void worker.terminate()
          }
        }, this.graceMs)
        pending.timer.unref?.()
      }, { once: true })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    this.worker = null
    for (const [id, pending] of this.pending) this.finish(id, unfinished(pending.root, 'Search is unavailable'))
    await worker?.terminate()
  }
}
