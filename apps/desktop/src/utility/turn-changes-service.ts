// MODULE: turn-changes-service.ts - a capture for a session: the host finds by itself where that session's terminal is at work, and reads nothing when it cannot
//
// The folder a capture starts from is the one Linux reports for the foreground process of the
// session's terminal (R69-NFR4). A folder a hook names never stands in for it: it only has to lie in
// the root BMN then establishes.
import { refusal } from './turn-changes-capture'
import type { TurnCaptureAnswer, TurnCaptureRequest, TurnChangesPort } from './turn-changes-engine'

/** What the host knows of a session's terminal by itself. */
export interface SessionForeground {
  /** The identity of the terminal's foreground process, or null when a shell or nothing is in the foreground. */
  identity: (sessionId: string) => string | null
  /** The folder Linux reports for that process, or null when it is gone or another process by now. */
  folder: (identity: string) => string | null
}

export type SessionCaptureRequest = Omit<TurnCaptureRequest, 'folder'>

export type SessionCaptureAnswer = TurnCaptureAnswer & {
  /** The foreground process the capture was taken for; absent when there was none. */
  foreground?: string
}

export async function captureSessionWorkTree(
  port: TurnChangesPort,
  foreground: SessionForeground,
  request: SessionCaptureRequest,
  signal?: AbortSignal
): Promise<SessionCaptureAnswer> {
  const identity = foreground.identity(request.session)
  const folder = identity === null ? null : foreground.folder(identity)
  if (identity === null || folder === null) return refusal('unavailable', 'the terminal has no foreground process')
  const answer = await port.capture({ ...request, folder }, signal)
  return { ...answer, foreground: identity }
}
