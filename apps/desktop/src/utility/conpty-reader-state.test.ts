// MODULE: conpty-reader-state.test.ts - The patched ConPTY output reader's credits and its self-test state answer
// The reader worker connects to ConPTY's output pipe by name; on Linux a Unix socket stands in for the pipe, so the
// worker BMN ships runs unchanged here.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { conptyReaderState } from './conpty-reader-state'

const WORKER = createRequire(import.meta.url).resolve('node-pty/lib/worker/conoutSocketWorker.js')
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface Message { type: string; data?: Uint8Array; [key: string]: unknown }

async function readerOnSocket(): Promise<{ worker: Worker; pipe: Socket; messages: Message[]; next(type: string): Promise<Message> }> {
  const root = mkdtempSync(join(tmpdir(), 'bmn-conpty-reader-'))
  const path = join(root, 'conout.sock')
  let accepted!: (socket: Socket) => void
  const connection = new Promise<Socket>((resolve) => { accepted = resolve })
  const server: Server = createServer((socket) => accepted(socket))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const worker = new Worker(WORKER, { workerData: { conoutPipeName: path } })
  const messages: Message[] = []
  const waiting: Array<{ type: string; resolve(message: Message): void }> = []
  worker.on('message', (message: Message) => {
    messages.push(message)
    const index = waiting.findIndex((entry) => entry.type === message.type)
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message)
  })
  const next = (type: string) => new Promise<Message>((resolve) => waiting.push({ type, resolve }))
  const ready = next('ready')
  const pipe = await connection
  await ready
  cleanups.push(async () => {
    await worker.terminate()
    pipe.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  return { worker, pipe, messages, next }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('the ConPTY output reader worker (node-pty patch)', () => {
  it('passes one chunk per credit and reports where it stands without taking or giving a credit', async () => {
    const { worker, pipe, messages, next } = await readerOnSocket()
    const sent = Buffer.alloc(200 * 1024, 0x61)
    await new Promise<void>((resolve) => pipe.write(sent, () => resolve()))
    await settle()
    expect(messages.filter((message) => message.type === 'data')).toHaveLength(0)

    const first = next('data')
    worker.postMessage('read')
    const chunk = await first
    await settle()
    // One credit, one chunk: nothing more arrives until the next credit.
    expect(messages.filter((message) => message.type === 'data')).toHaveLength(1)
    expect(chunk.data!.byteLength).toBeLessThanOrEqual(64 * 1024)

    const state = await conptyReaderState({ _agent: { _worker: { _worker: worker } } })
    expect(state).toMatchObject({ conin: null, reader: { type: 'state', credit: false, reads: 1, chunks: 1,
      bytes: chunk.data!.byteLength, ended: false, destroyed: false } })
    const reader = state!.reader as { bytesRead: number; readableLength: number }
    // Read from the pipe but not yet passed on: still in the worker's socket.
    expect(reader.bytesRead - chunk.data!.byteLength).toBe(reader.readableLength)
    await settle()
    expect(messages.filter((message) => message.type === 'data')).toHaveLength(1)

    let received = chunk.data!.byteLength
    while (received < sent.byteLength) {
      const more = next('data')
      worker.postMessage('read')
      received += (await more).data!.byteLength
    }
    expect(received).toBe(sent.byteLength)
    worker.postMessage('read')
    await settle()
    // At rest: a credit held, nothing buffered, the handle reading.
    expect((await conptyReaderState({ _agent: { _worker: { _worker: worker } } }))?.reader).toMatchObject({
      credit: true, readableLength: 0, bytesRead: sent.byteLength, bytes: sent.byteLength, handleReading: true })
  })
})

describe('conptyReaderState', () => {
  it('is null without a ConPTY reader, as on POSIX', async () => {
    expect(await conptyReaderState({})).toBeNull()
    expect(await conptyReaderState({ _agent: {} })).toBeNull()
  })

  it('reads the input pipe and says when the worker does not answer, leaving no listener behind', async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: () => {} })
    const state = await conptyReaderState({ _agent: { _worker: { _worker: worker },
      inSocket: { writableLength: 12, writableNeedDrain: false, bytesWritten: 345, destroyed: false } } }, 50)
    expect(state).toEqual({ reader: 'no answer within 50 ms',
      conin: { pendingBytes: 12, awaitingDrain: false, bytesWritten: 345, destroyed: false } })
    expect(worker.listenerCount('message')).toBe(0)
  })
})
