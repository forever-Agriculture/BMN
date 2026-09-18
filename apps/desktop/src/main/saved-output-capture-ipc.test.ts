import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainEvent, WebContents } from 'electron'
import { METHOD_REGISTRY } from '@bmn/protocol'
import {
  SavedOutputCaptureCoordinator,
  captureWebContents,
  captureSavedOutputForLifecycle
} from './saved-output-capture-ipc'

describe('saved-output capture IPC coordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('does not read webContents from a destroyed startup-failure window', () => {
    const destroyed = {
      isDestroyed: () => true,
      get webContents(): WebContents {
        throw new Error('Object has been destroyed')
      }
    }
    expect(captureWebContents(false, destroyed)).toBeUndefined()
    expect(captureWebContents(true, destroyed)).toBeUndefined()
  })

  it('settles only after the addressed renderer acknowledges persistence', async () => {
    let receive: (event: IpcMainEvent, requestId: unknown, result: unknown) => void = () => undefined
    const ipc = {
      on: vi.fn((_channel, listener: typeof receive) => {
        receive = listener
      })
    }
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: vi.fn()
    } as unknown as WebContents
    const coordinator = new SavedOutputCaptureCoordinator(ipc, (candidate) => candidate === sender, 50)

    const capture = coordinator.request(sender, 'session-7')
    const requestId = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    let settled = false
    void capture.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(sender.send).toHaveBeenCalledWith(
      'aiterm:terminal:capture-request',
      requestId,
      'session-7'
    )

    receive({ sender } as IpcMainEvent, requestId, { ok: true })

    await expect(capture).resolves.toEqual({ status: 'saved' })
  })

  it('returns typed unavailable outcomes for renderer failure and missing acknowledgement', async () => {
    vi.useFakeTimers()
    let receive: (event: IpcMainEvent, requestId: unknown, result: unknown) => void = () => undefined
    const ipc = { on: (_channel: string, listener: typeof receive) => (receive = listener) }
    const sender = {
      id: 9,
      isDestroyed: () => false,
      send: vi.fn()
    } as unknown as WebContents
    const coordinator = new SavedOutputCaptureCoordinator(ipc, () => true, 25)
    const failed = coordinator.request(sender, 'session-9')
    const failedId = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    receive({ sender } as IpcMainEvent, failedId, { ok: false, message: 'disk full' })
    await expect(failed).resolves.toEqual({
      status: 'unavailable',
      reason: 'capture-persist-failure',
      detail: 'disk full'
    })

    const timedOut = coordinator.request(sender, 'session-9')
    vi.advanceTimersByTime(25)
    await expect(timedOut).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-acknowledged-in-time',
      detail: 'the renderer did not acknowledge final capture within 25 ms'
    })
  })

  it('persists a final-capture loss disclosure when no renderer is available', async () => {
    const requests: Array<{ method: string; params: object }> = []
    const client = {
      async request<Result>(method: string, params: object): Promise<Result> {
        requests.push({ method, params })
        return { recorded: true } as Result
      }
    }
    const now = new Date('2026-09-13T12:00:00.000Z')

    await expect(captureSavedOutputForLifecycle(
      {
        client,
        session: { sessionId: 'session-1', incarnationId: 'incarnation-1' },
        attachment: {
          attachmentId: 'view-1',
          captureStartedAt: '2026-09-13T11:00:00.000Z'
        },
        processState: 'live'
      },
      undefined,
      undefined,
      () => now
    )).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-renderer',
      detail: 'no terminal window was available for final capture'
    })
    expect(requests).toEqual([{
      method: METHOD_REGISTRY.terminalFinalCaptureUnavailable,
      params: expect.objectContaining({
        sessionId: 'session-1',
        incarnationId: 'incarnation-1',
        viewEpoch: 'view-1',
        unavailableAt: now.toISOString(),
        reason: 'no-renderer'
      })
    }])
  })

  it('attributes a delayed unavailable outcome to the view that requested capture', async () => {
    let receive: (event: IpcMainEvent, requestId: unknown, result: unknown) => void = () => undefined
    const ipc = { on: (_channel: string, listener: typeof receive) => (receive = listener) }
    const sender = {
      id: 12,
      isDestroyed: () => false,
      send: vi.fn()
    } as unknown as WebContents
    const coordinator = new SavedOutputCaptureCoordinator(ipc, () => true, 50)
    const requests: Array<{ method: string; params: object }> = []
    const client = {
      async request<Result>(method: string, params: object): Promise<Result> {
        requests.push({ method, params })
        return { recorded: true } as Result
      }
    }
    const runtime = {
      client,
      session: { sessionId: 'session-1', incarnationId: 'incarnation-1' },
      attachment: {
        attachmentId: 'view-before-recovery',
        captureStartedAt: '2026-09-13T11:00:00.000Z'
      },
      processState: 'live' as const
    }

    const capture = captureSavedOutputForLifecycle(runtime, sender, coordinator)
    const requestId = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    runtime.attachment = {
      attachmentId: 'replacement-view',
      captureStartedAt: '2026-09-13T11:01:00.000Z'
    }
    receive({ sender } as IpcMainEvent, requestId, { ok: false, message: 'old view lost' })
    await capture

    expect(requests).toEqual([{
      method: METHOD_REGISTRY.terminalFinalCaptureUnavailable,
      params: expect.objectContaining({
        viewEpoch: 'view-before-recovery',
        captureStartedAt: '2026-09-13T11:00:00.000Z'
      })
    }])
  })
})
