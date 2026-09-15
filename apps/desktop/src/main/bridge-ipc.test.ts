import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  ERROR_CODES,
  emptyWorkspaceLayout,
  type LayoutGetResult,
  type LayoutPutParams,
  type ProtocolErrorCode,
  type WorkspaceLayoutState
} from '@ai-terminal/protocol'
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron'
import { bridgeInvokeRegistrar } from './bridge-ipc'
import { PtyHostClient } from './pty-host-client'
import { MainIpcError, installWorkspaceIpcHandlers } from './workspace-ipc'
import { unwrapBridgeInvoke } from '../preload/bridge-invoke'
import { createLayoutWriter, type LayoutWriterPort } from '../renderer/src/layout-writer'
import { captureLayoutScroll, selectLayoutSession } from '../renderer/src/workspace-layout'

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

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

/**
 * A real PtyHostClient answered by a scripted utility process, the real workspace IPC routes
 * installed through the real envelope registrar, and an Electron-like invoke that structured-clones
 * the handler result the way ipcRenderer.invoke does.
 */
async function bridgeHarness(
  answer: (method: string, params: Record<string, unknown>) =>
    | { result: unknown }
    | { error: { code: number; message: string; data: { code: ProtocolErrorCode; retryable: boolean } } }
) {
  const process = new FakeUtilityProcess()
  const client = new PtyHostClient(process as unknown as UtilityProcess, {
    readyTimeoutMs: 100,
    requestTimeoutMs: 200
  })
  process.postMessage.mockImplementation((message) => {
    const request = (message as { kind?: string; request?: { id: string; method: string; params: Record<string, unknown> } })
    if (request.kind !== 'control-request' || !request.request) return
    const { id, method, params } = request.request
    queueMicrotask(() => process.emit('message', {
      kind: 'control-response',
      response: { jsonrpc: '2.0', id, ...answer(method, params) }
    }))
  })
  process.emit('message', readyMessage)
  await client.ready
  const handlers = new Map<string, Handler>()
  const bridgeIpc = bridgeInvokeRegistrar({ handle: (channel, listener) => handlers.set(channel, listener) })
  installWorkspaceIpcHandlers(bridgeIpc, (event) => (event as unknown as { allowed: boolean }).allowed, {
    client: () => client,
    createSession: vi.fn()
  })
  const invoke = (allowed: boolean) => <Result>(channel: string, ...args: unknown[]) =>
    unwrapBridgeInvoke<Result>(async () => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for '${channel}'`)
      return structuredClone(await handler({ allowed } as unknown as IpcMainInvokeEvent, ...args))
    })
  return {
    handlers,
    registrations: bridgeIpc.registrations(),
    invoke: invoke(true),
    invokeDenied: invoke(false)
  }
}

const sessions = ['session-a', 'session-b']

describe('typed bridge error contract (main -> preload -> renderer)', () => {
  it('re-fetches the layout when a real host REVISION_CONFLICT crosses the real handler and unwrap', async () => {
    const stale = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    const authoritative: WorkspaceLayoutState = { ...stale, selectedSessionId: 'session-a', revision: 4 }
    const methods: string[] = []
    const puts: LayoutPutParams[] = []
    const { invoke } = await bridgeHarness((method, params) => {
      methods.push(method)
      if (method === 'layout.put') {
        const put = params as unknown as LayoutPutParams
        puts.push(put)
        if (put.expectedRevision === authoritative.revision && put.state.revision === authoritative.revision) {
          return { result: { ...put.state, revision: authoritative.revision + 1 } }
        }
        return {
          error: {
            code: -32000,
            message: 'Workspace layout workspace-1 has revision 4',
            data: { code: ERROR_CODES.revisionConflict, retryable: false }
          }
        }
      }
      return { result: { layout: authoritative, notice: null } satisfies LayoutGetResult }
    })
    const port: LayoutWriterPort = {
      put: (params) => invoke<WorkspaceLayoutState>('aiterm:layout:put', params),
      get: (workspaceId) => invoke<LayoutGetResult>('aiterm:layout:get', { workspaceId }),
      publish: vi.fn(),
      notice: vi.fn(),
      failure: vi.fn()
    }
    await expect(port.put({ workspaceId: 'workspace-1', expectedRevision: 1, state: stale })).rejects.toEqual({
      name: 'BridgeError',
      code: ERROR_CODES.revisionConflict,
      message: 'Workspace layout workspace-1 has revision 4'
    })
    methods.length = 0
    puts.length = 0

    const writer = createLayoutWriter(port)
    writer.reset([stale])
    writer.apply('workspace-1', (state) => captureLayoutScroll(state, 'session-a', 12, sessions))
    await writer.idle('workspace-1')

    expect(methods).toEqual(['layout.put', 'layout.get', 'layout.put'])
    expect(puts.map((put) => put.expectedRevision)).toEqual([1, 4])
    expect(writer.layout('workspace-1')).toEqual({
      ...authoritative,
      sessionView: { ...authoritative.sessionView, 'session-a': { scrollLine: 12, followTail: false } },
      revision: 5
    })
    expect(port.failure).not.toHaveBeenCalled()
  })

  it('does not re-fetch for any other host code, and never reads the code from message text', async () => {
    const state = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    const methods: string[] = []
    const { invoke } = await bridgeHarness((method) => {
      methods.push(method)
      return {
        error: {
          code: -32000,
          message: 'REVISION_CONFLICT appears only in this message text',
          data: { code: ERROR_CODES.notFound, retryable: false }
        }
      }
    })
    const failure = vi.fn()
    const writer = createLayoutWriter({
      put: (params) => invoke<WorkspaceLayoutState>('aiterm:layout:put', params),
      get: (workspaceId) => invoke<LayoutGetResult>('aiterm:layout:get', { workspaceId }),
      publish: vi.fn(),
      notice: vi.fn(),
      failure
    })
    writer.reset([state])
    writer.apply('workspace-1', (current) => captureLayoutScroll(current, 'session-a', 3, sessions))
    await writer.idle('workspace-1')
    expect(methods).toEqual(['layout.put'])
    expect(failure).toHaveBeenCalledWith('REVISION_CONFLICT appears only in this message text')
    expect(writer.layout('workspace-1')).toBe(state)

    const get = vi.fn(async () => ({ layout: state, notice: null }))
    const localFailure = vi.fn()
    const local = createLayoutWriter({
      put: async () => {
        throw new Error('REVISION_CONFLICT: a message-only error is not a conflict')
      },
      get,
      publish: vi.fn(),
      notice: vi.fn(),
      failure: localFailure
    })
    local.reset([state])
    local.apply('workspace-1', (current) => captureLayoutScroll(current, 'session-a', 3, sessions))
    await local.idle('workspace-1')
    expect(get).not.toHaveBeenCalled()
    expect(localFailure).toHaveBeenCalledWith('REVISION_CONFLICT: a message-only error is not a conflict')
  })

  it('carries main-origin codes and maps untyped failures to IO_ERROR through the same envelope', async () => {
    const { invokeDenied, handlers } = await bridgeHarness(() => ({ result: [] }))
    await expect(invokeDenied('aiterm:workspace:list', {})).rejects.toEqual({
      name: 'BridgeError',
      code: ERROR_CODES.unauthorized,
      message: 'Renderer sender is not authorized'
    })

    const direct = new Map<string, Handler>()
    const registrar = bridgeInvokeRegistrar({ handle: (channel, listener) => direct.set(channel, listener) })
    registrar.handle('aiterm:test:typed', () => {
      throw new MainIpcError(ERROR_CODES.notFound, 'Session missing is not live')
    })
    registrar.handle('aiterm:test:untyped', async () => {
      throw new Error('disk vanished')
    })
    registrar.handle('aiterm:test:ok', async () => undefined)
    const event = {} as IpcMainInvokeEvent
    await expect(direct.get('aiterm:test:typed')!(event)).resolves.toEqual({
      ok: false, code: ERROR_CODES.notFound, message: 'Session missing is not live'
    })
    await expect(direct.get('aiterm:test:untyped')!(event)).resolves.toEqual({
      ok: false, code: ERROR_CODES.ioError, message: 'disk vanished'
    })
    await expect(unwrapBridgeInvoke(() => direct.get('aiterm:test:ok')!(event))).resolves.toBeUndefined()
    expect(handlers.size).toBe(10)
  })

  it('rejects malformed envelopes and transport failures with typed codes', async () => {
    await expect(unwrapBridgeInvoke(async () => ({ ok: false, code: 'NOPE', message: 'x' })))
      .rejects.toMatchObject({ name: 'BridgeError', code: ERROR_CODES.protocolMismatch })
    await expect(unwrapBridgeInvoke(async () => 'bare result'))
      .rejects.toMatchObject({ name: 'BridgeError', code: ERROR_CODES.protocolMismatch })
    await expect(unwrapBridgeInvoke(async () => {
      throw new Error("Error invoking remote method 'aiterm:layout:get': gone")
    })).rejects.toMatchObject({ name: 'BridgeError', code: ERROR_CODES.ioError })
  })

  it('answers every runtime-registered workspace invoke through the typed envelope', async () => {
    const { registrations } = await bridgeHarness(() => ({ result: [] }))
    const event = { allowed: false } as unknown as IpcMainInvokeEvent
    const answers = await Promise.all(registrations.map((registration) => registration.invoke(event)))

    expect(registrations.map((registration) => registration.channel)).toHaveLength(10)
    expect(answers).toEqual(registrations.map(() => ({
      ok: false,
      code: ERROR_CODES.unauthorized,
      message: 'Renderer sender is not authorized'
    })))
  })
})
