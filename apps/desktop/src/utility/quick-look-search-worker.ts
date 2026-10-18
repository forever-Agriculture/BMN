// MODULE: quick-look-search-worker.ts - the worker thread that runs Quick look's contents search, so that no file's masking or matching runs on the thread that keeps terminals flowing (Story 67.5 AC6)
import { parentPort } from 'node:worker_threads'
import type { QuickLookContentsResult } from '@bmn/protocol'
import { searchQuickLookContents, type ContentsSearchOptions } from './quick-look-search'

/** One search; `stop` is a shared number the host sets to 1, read inside each file's work as well as between files. */
export interface QuickLookSearchWorkerRequest {
  id: number
  root: string
  options: Omit<ContentsSearchOptions, 'gitRoot' | 'stopped'>
  stop: SharedArrayBuffer
}

export type QuickLookSearchWorkerResponse = { id: number; ok: true; result: QuickLookContentsResult } | { id: number; ok: false }

/** How often a waiting search looks at its stop flag; inside a file's work it is read at every step. */
const STOP_POLL_MS = 10

const port = parentPort
if (!port) throw new Error('the Quick look search worker needs a parent')

async function search(request: QuickLookSearchWorkerRequest): Promise<QuickLookContentsResult> {
  const cell = new Int32Array(request.stop)
  const controller = new AbortController()
  const stopped = (): boolean => {
    if (!controller.signal.aborted && Atomics.load(cell, 0) === 1) controller.abort()
    return controller.signal.aborted
  }
  // Git's listing and the walk wait on the file system; they hear the stop through the signal.
  const poll = setInterval(stopped, STOP_POLL_MS)
  try {
    return await searchQuickLookContents(request.root, { ...request.options, stopped }, controller.signal)
  } finally {
    clearInterval(poll)
  }
}

port.on('message', (request: QuickLookSearchWorkerRequest) => {
  search(request).then(
    (result) => port.postMessage({ id: request.id, ok: true, result } satisfies QuickLookSearchWorkerResponse),
    // An error's own text may name a file or quote a line, so it never leaves this thread.
    () => port.postMessage({ id: request.id, ok: false } satisfies QuickLookSearchWorkerResponse)
  )
})
