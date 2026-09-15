import { failureDetail } from './bridge-error'

export type RendererIpcOperation = 'resize' | 'detach' | 'stop' | 'hide'

interface RendererIpcCallbacks<T> {
  setFailure: (value: string | undefined) => void
  setStatus?: (value: string) => void
  onSuccess?: (value: T) => void
  shouldSurfaceFailure?: () => boolean
}

const failureFeedback: Record<
  RendererIpcOperation,
  { prefix: string; fallback: string; nextStep: string; status?: string }
> = {
  resize: {
    prefix: 'Terminal resize failed',
    fallback: 'the terminal host returned an unknown error',
    nextStep: 'reopen the terminal view and try resizing again.'
  },
  detach: {
    prefix: 'Terminal detach failed',
    fallback: 'the terminal host returned an unknown error',
    nextStep: 'reopen the terminal view before sending more input.'
  },
  stop: {
    prefix: 'The shell stop failed',
    fallback: 'the terminal host returned an unknown error',
    nextStep: 'restart BMN before starting another shell.',
    status: 'Stop outcome unknown'
  },
  hide: {
    prefix: 'Window hide failed',
    fallback: 'the main process returned an unknown error',
    nextStep: 'try Hide again or close BMN from the desktop.'
  }
}

export async function runIpcWithFeedback<T>(
  operation: RendererIpcOperation,
  invoke: () => Promise<T>,
  callbacks: RendererIpcCallbacks<T>
): Promise<void> {
  try {
    const result = await invoke()
    callbacks.onSuccess?.(result)
  } catch (error) {
    if (callbacks.shouldSurfaceFailure?.() === false) return
    const feedback = failureFeedback[operation]
    const detail = failureDetail(error, feedback.fallback).slice(0, 240)
    if (feedback.status) callbacks.setStatus?.(feedback.status)
    callbacks.setFailure(`${feedback.prefix}: ${detail}. Fix: ${feedback.nextStep}`)
  }
}

interface AttachmentRef {
  current: { attachmentId: string } | undefined
}

export function clearTerminalAttachment(attachment: AttachmentRef): void {
  attachment.current = undefined
}

export function sendTerminalInputIfAttached(
  attachment: AttachmentRef,
  bytes: Uint8Array,
  send: (attachmentId: string, bytes: Uint8Array) => void
): void {
  const current = attachment.current
  if (current) send(current.attachmentId, bytes)
}

export function handleTerminalUnavailable(
  attachment: AttachmentRef,
  message: string,
  setStatus: (value: string) => void,
  setFailure: (value: string | undefined) => void
): void {
  clearTerminalAttachment(attachment)
  setStatus('Terminal unavailable')
  setFailure(message)
}

export async function handleTerminalOutputOverflow(
  attachment: AttachmentRef,
  detach: () => Promise<unknown>,
  setStatus: (value: string) => void,
  setFailure: (value: string | undefined) => void
): Promise<void> {
  clearTerminalAttachment(attachment)
  setStatus('Terminal view disconnected')
  setFailure(
    'Terminal output exceeded the 4 MiB view queue. Fix: reopen the terminal view; the shell process was not stopped.'
  )
  await runIpcWithFeedback('detach', detach, { setFailure })
}
