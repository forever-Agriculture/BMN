import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { METHOD_REGISTRY } from '@ai-terminal/protocol'
import type { UtilityProcess } from 'electron'
import {
  closeWithinDeadline,
  HOST_DIAGNOSTIC_BUFFER_BYTES,
  PtyHostClient,
  PtyHostExitedError,
  PtyHostRequestTimeoutError
} from './pty-host-client'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

const readyMessage = {
  kind: 'host-ready',
  electronVersion: '44.3.0',
  nativeModules: { nodePty: true, betterSqlite3: true },
  databasePath: '/tmp/state.sqlite3',
  schemaTables: ['process_incarnation', 'schema_migration', 'session', 'workspace'],
  database: { journalMode: 'wal', foreignKeys: true, busyTimeoutMs: 5_000 }
} as const

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly stdout = new PassThrough()
  readonly pid = 4242
  readonly postMessage = vi.fn<(message: unknown, ports?: unknown[]) => void>()
}

async function connectedClient(options: ConstructorParameters<typeof PtyHostClient>[1] = {}) {
  const process = new FakeUtilityProcess()
  const client = new PtyHostClient(process as unknown as UtilityProcess, {
    readyTimeoutMs: 100,
    requestTimeoutMs: 20,
    shutdownGraceMs: 20,
    terminateWaitMs: 20,
    ...options
  })
  process.emit('message', readyMessage)
  await client.ready
  return { client, process }
}

describe('PtyHostClient lifecycle', () => {
  it('rejects a request issued after host exit immediately with a typed error', async () => {
    const { client, process } = await connectedClient()
    process.emit('exit', 17)
    const callsBefore = process.postMessage.mock.calls.length

    await expect(client.request(METHOD_REGISTRY.healthGet, {})).rejects.toBeInstanceOf(
      PtyHostExitedError
    )
    expect(process.postMessage).toHaveBeenCalledTimes(callsBefore)
  })

  it('projects utility-owned incarnation state events and replays the latest state to late listeners', async () => {
    const { client, process } = await connectedClient()
    const state = {
      kind: 'session-process-state-changed',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      state: 'exited'
    } as const
    process.emit('message', state)
    const listener = vi.fn()

    client.onSessionStateChanged(listener)
    await Promise.resolve()

    expect(listener).toHaveBeenCalledWith(state)
  })

  it('times out a hung control request with a typed error', async () => {
    const { client } = await connectedClient({ requestTimeoutMs: 5 })
    const startedAt = Date.now()
    await expect(client.request(METHOD_REGISTRY.healthGet, {})).rejects.toBeInstanceOf(
      PtyHostRequestTimeoutError
    )
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it('bounds retained host diagnostics while preserving the newest stderr', async () => {
    const { client, process } = await connectedClient()
    process.stderr.write(`old-${'x'.repeat(HOST_DIAGNOSTIC_BUFFER_BYTES * 2)}-newest`)
    expect(client.diagnosticBufferBytes).toBeLessThanOrEqual(HOST_DIAGNOSTIC_BUFFER_BYTES * 2)
    process.emit('exit', 9)
    await expect(client.request(METHOD_REGISTRY.healthGet, {})).rejects.toThrow(/newest/)
  })

  it('lets host-shutdown close the database and exit before sending a signal', async () => {
    const signalProcess = vi.fn(() => true)
    const { client, process } = await connectedClient({ signalProcess })
    let databaseClosed = false
    process.postMessage.mockImplementation((message) => {
      if ((message as { kind?: string }).kind !== 'host-shutdown') return
      databaseClosed = true
      queueMicrotask(() => process.emit('exit', 0))
    })

    await expect(client.close()).resolves.toEqual({ graceful: true })
    expect(databaseClosed).toBe(true)
    expect(signalProcess).not.toHaveBeenCalled()
  })

  it('does not label a host that exited before shutdown as graceful', async () => {
    const { client, process } = await connectedClient()
    process.emit('exit', 17)

    await expect(client.close()).resolves.toEqual({ graceful: false })
    expect(process.postMessage).not.toHaveBeenCalled()
  })

  it('falls back to SIGTERM and then SIGKILL after bounded waits', async () => {
    const process = new FakeUtilityProcess()
    const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') queueMicrotask(() => process.emit('exit', 137))
      return true
    })
    const client = new PtyHostClient(process as unknown as UtilityProcess, {
      readyTimeoutMs: 100,
      requestTimeoutMs: 20,
      shutdownGraceMs: 2,
      terminateWaitMs: 2,
      signalProcess
    })
    process.emit('message', readyMessage)
    await client.ready

    await expect(client.close()).resolves.toEqual({ graceful: false })
    expect(signalProcess.mock.calls.map((call) => call[1])).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('closeWithinDeadline', () => {
  it('passes a close that settles before the deadline through unchanged', async () => {
    vi.useFakeTimers()
    try {
      await expect(closeWithinDeadline({ close: async () => ({ graceful: true }) }, 5_000)).resolves.toEqual({
        graceful: true
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a close still pending at the deadline as ungraceful', async () => {
    vi.useFakeTimers()
    try {
      let outcome: { graceful: boolean } | undefined
      void closeWithinDeadline({ close: () => new Promise(() => undefined) }, 5_000).then((value) => {
        outcome = value
      })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toEqual({ graceful: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
