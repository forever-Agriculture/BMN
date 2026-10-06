// MODULE: conpty-reader-state.ts - Self-test diagnostics: where node-pty's Windows ConPTY output reader and input pipe stand
// BMN's node-pty patch reads ConPTY's output in a worker, one chunk per credit, and writes input straight to ConPTY's
// input pipe. When a pane stops printing, these say whether output is waiting on BMN's side of that reader (no credit,
// bytes buffered in the worker, a handle that stopped reading) or never reached it, and whether typed input left BMN.

interface ReaderWorker {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

interface PatchedAgent {
  _worker?: { _worker?: ReaderWorker }
  inSocket?: { writableLength?: number; writableNeedDrain?: boolean; bytesWritten?: number; destroyed?: boolean }
}

/** The worker reading ConPTY's output for a node-pty terminal, or undefined where there is none (POSIX). */
export function conptyReaderWorker(pty: unknown): ReaderWorker | undefined {
  const worker = (pty as { _agent?: PatchedAgent })._agent?._worker?._worker
  return typeof worker?.postMessage === 'function' ? worker : undefined
}

/**
 * Asks the reader worker where it stands: whether it holds a credit, how many credits and chunks it saw, how many bytes
 * it read from ConPTY's pipe and passed on, what its socket still buffers and whether the socket's handle is reading.
 * Also reads the input pipe's own counters. Observation only: the worker answers without touching its credit. Null
 * where there is no such reader (POSIX).
 */
export async function conptyReaderState(pty: unknown, timeoutMs = 1_000): Promise<Record<string, unknown> | null> {
  const worker = conptyReaderWorker(pty)
  if (!worker) return null
  const input = (pty as { _agent?: PatchedAgent })._agent?.inSocket
  const conin = input ? { pendingBytes: input.writableLength ?? null, awaitingDrain: input.writableNeedDrain ?? null,
    bytesWritten: input.bytesWritten ?? null, destroyed: input.destroyed ?? null } : null
  const reader = await new Promise<unknown>((resolve) => {
    const answered = (message: unknown): void => {
      if ((message as { type?: unknown } | null)?.type === 'state') done(message)
    }
    const timer = setTimeout(() => done(`no answer within ${timeoutMs} ms`), timeoutMs)
    const done = (value: unknown): void => {
      clearTimeout(timer)
      worker.off('message', answered)
      resolve(value)
    }
    worker.on('message', answered)
    worker.postMessage('state')
  })
  return { reader, conin }
}
