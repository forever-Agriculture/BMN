import { randomUUID } from 'node:crypto'
import {
  METHOD_REGISTRY,
  type ProtocolMethod,
  type SavedOutputCaptureFlushResult,
  type SavedOutputCaptureOutcome,
  type SessionProcessState
} from '@bmn/protocol'
import type { IpcMainEvent, WebContents } from 'electron'

interface CaptureIpcRegistrar {
  on(
    channel: 'aiterm:terminal:capture-result',
    listener: (event: IpcMainEvent, requestId: unknown, result: unknown) => void
  ): void
}

interface PendingCapture {
  senderId: number
  resolve(outcome: SavedOutputCaptureOutcome): void
  timer: ReturnType<typeof setTimeout>
}

function captureResult(value: unknown): SavedOutputCaptureFlushResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<SavedOutputCaptureFlushResult>
  if (candidate.ok === true) return { ok: true }
  if (candidate.ok === false && typeof candidate.message === 'string' && candidate.message.length > 0) {
    return { ok: false, message: candidate.message.slice(0, 240) }
  }
  return undefined
}

export class SavedOutputCaptureCoordinator {
  private readonly pending = new Map<string, PendingCapture>()

  constructor(
    ipc: CaptureIpcRegistrar,
    private readonly senderIsAllowed: (sender: WebContents) => boolean,
    private readonly timeoutMs = 2_000
  ) {
    ipc.on('aiterm:terminal:capture-result', (event, requestId, rawResult) => {
      if (typeof requestId !== 'string' || !this.senderIsAllowed(event.sender)) return
      const pending = this.pending.get(requestId)
      if (!pending || pending.senderId !== event.sender.id) return
      const result = captureResult(rawResult)
      if (!result) return
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      if (result.ok) pending.resolve({ status: 'saved' })
      else {
        pending.resolve({
          status: 'unavailable',
          reason: 'capture-persist-failure',
          detail: result.message
        })
      }
    })
  }

  request(sender: WebContents, sessionId: string): Promise<SavedOutputCaptureOutcome> {
    if (sender.isDestroyed()) {
      return Promise.resolve({
        status: 'unavailable',
        reason: 'renderer-destroyed',
        detail: 'the renderer was destroyed before final capture'
      })
    }
    if (!this.senderIsAllowed(sender)) {
      return Promise.resolve({
        status: 'unavailable',
        reason: 'no-renderer',
        detail: 'no authorized renderer was available for final capture'
      })
    }
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({
          status: 'unavailable',
          reason: 'not-acknowledged-in-time',
          detail: `the renderer did not acknowledge final capture within ${this.timeoutMs} ms`
        })
      }, this.timeoutMs)
      this.pending.set(requestId, { senderId: sender.id, resolve, timer })
      try {
        sender.send('aiterm:terminal:capture-request', requestId, sessionId)
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        resolve({
          status: 'unavailable',
          reason: 'renderer-destroyed',
          detail: error instanceof Error ? error.message.slice(0, 240) : 'the renderer became unavailable'
        })
      }
    })
  }
}

interface CaptureLifecycleRuntime {
  client: {
    request<Result>(method: ProtocolMethod, params: object): Promise<Result>
  }
  session: { sessionId: string; incarnationId: string }
  attachment: { attachmentId: string; captureStartedAt: string }
  processState: SessionProcessState
}

export function captureWebContents(
  hasRuntime: boolean,
  window: { isDestroyed(): boolean; readonly webContents: WebContents } | undefined
): WebContents | undefined {
  if (!hasRuntime || !window || window.isDestroyed()) return undefined
  return window.webContents
}

export async function captureSavedOutputForLifecycle(
  runtime: CaptureLifecycleRuntime | undefined,
  view: WebContents | undefined,
  coordinator: SavedOutputCaptureCoordinator | undefined,
  now: () => Date = () => new Date(),
  reportDisclosureFailure: (error: unknown) => void = () => undefined
): Promise<SavedOutputCaptureOutcome> {
  if (!runtime) return { status: 'saved' }
  const identity = { ...runtime.session }
  const attachment = { ...runtime.attachment }
  const processState = runtime.processState
  let outcome: SavedOutputCaptureOutcome
  if (!view) {
    outcome = {
      status: 'unavailable',
      reason: 'no-renderer',
      detail: 'no terminal window was available for final capture'
    }
  } else if (view.isDestroyed()) {
    outcome = {
      status: 'unavailable',
      reason: 'renderer-destroyed',
      detail: 'the terminal window was destroyed before final capture'
    }
  } else if (!coordinator) {
    outcome = {
      status: 'unavailable',
      reason: 'no-renderer',
      detail: 'the final-capture coordinator was unavailable'
    }
  } else {
    try {
      outcome = await coordinator.request(view, identity.sessionId)
    } catch (error) {
      outcome = {
        status: 'unavailable',
        reason: 'capture-persist-failure',
        detail: error instanceof Error ? error.message.slice(0, 240) : 'final capture failed'
      }
    }
  }
  if (outcome.status === 'unavailable') {
    try {
      await runtime.client.request(METHOD_REGISTRY.terminalFinalCaptureUnavailable, {
        ...identity,
        viewEpoch: attachment.attachmentId,
        captureStartedAt: attachment.captureStartedAt,
        unavailableAt: now().toISOString(),
        reason: outcome.reason,
        detail: outcome.detail,
        processState: processState === 'exit-unconfirmed'
          ? 'interrupted'
          : processState
      })
    } catch (error) {
      reportDisclosureFailure(error)
    }
  }
  return outcome
}
