// MODULE: turn-changes-worker.ts - the worker thread that captures and compares work trees, so that no scan or comparison runs on the thread that keeps terminals flowing
import { parentPort, workerData } from 'node:worker_threads'
import { TurnChangesEngine, type TurnCaptureRequest, type TurnPairRequest } from './turn-changes-engine'

export interface TurnWorkerData {
  dataRoot: string
  home: string
}

export type TurnWorkerRequest =
  | { id: number; operation: 'capture'; params: TurnCaptureRequest }
  | { id: number; operation: 'publish' | 'discard'; params: { capture: string } }
  | { id: number; operation: 'cancel'; params: { job: string } }
  | { id: number; operation: 'forget' | 'remove-session'; params: { session: string } }
  | { id: number; operation: 'remove-captures'; params: { session: string; key: string; captures: string[] } }
  | { id: number; operation: 'clear-leftovers' | 'inventory' | 'usage' }
  /** `stop` is one shared number the host sets to 1: a comparison cannot hear a message while it runs. */
  | { id: number; operation: 'compare'; params: TurnPairRequest; stop: SharedArrayBuffer }
  | { id: number; operation: 'difference'; params: TurnPairRequest & { path: string }; stop: SharedArrayBuffer }

export type TurnWorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false }

const port = parentPort
if (!port) throw new Error('the turn changes worker needs a parent')
const engine = new TurnChangesEngine(workerData as TurnWorkerData)
const stopped = (flag: SharedArrayBuffer): (() => boolean) => {
  const cell = new Int32Array(flag)
  return () => Atomics.load(cell, 0) === 1
}

async function answer(request: TurnWorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case 'capture': return engine.capture(request.params)
    case 'publish': return engine.publish(request.params.capture)
    case 'discard': return engine.discard(request.params.capture)
    case 'cancel': return engine.cancel(request.params.job)
    case 'forget': return engine.forget(request.params.session)
    case 'remove-session': return engine.removeSession(request.params.session)
    case 'remove-captures': return engine.removeCaptures(request.params)
    case 'clear-leftovers': return engine.clearLeftovers()
    case 'inventory': return engine.inventory()
    case 'usage': return engine.usage()
    case 'compare': return engine.compare(request.params, stopped(request.stop))
    case 'difference': return engine.difference(request.params, stopped(request.stop))
  }
}

port.on('message', (request: TurnWorkerRequest) => {
  answer(request).then(
    (result) => port.postMessage({ id: request.id, ok: true, result: result ?? null } satisfies TurnWorkerResponse),
    // An error's own text may name a file, so it never leaves this thread.
    () => port.postMessage({ id: request.id, ok: false } satisfies TurnWorkerResponse)
  )
})
port.on('close', () => engine.close())
