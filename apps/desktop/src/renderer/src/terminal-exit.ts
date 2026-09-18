// MODULE: terminal-exit.ts - the one presenter for a live pane's terminal-exit message
import {
  lifecycleStopDetail,
  type TerminalExitMessage,
  type TerminalExitedMessage,
  type TerminalLifecycleInterruptedMessage,
  type TerminalUnobservedInterruptedMessage
} from '@bmn/protocol'
import { sessionProcessLabel } from './session-status'

type TerminalExitFeedbackInput =
  | Omit<TerminalExitedMessage, 'kind' | 'attachmentId'>
  | Omit<TerminalLifecycleInterruptedMessage, 'kind' | 'attachmentId'>
  | Omit<TerminalUnobservedInterruptedMessage, 'kind' | 'attachmentId'>

/** A placeholder incarnation id: the label depends only on the observed outcome fields. */
const LIVE_EXIT_INCARNATION = 'live-terminal-exit'

/**
 * Presents a live terminal exit with the same wording as the stored session label.
 * - Observed exit and observed lifecycle stop: status only; nothing needs the owner's action.
 * - Unobserved loss: `Interrupted` plus the recovery failure, because the stop outcome is unknown.
 */
export function terminalExitFeedback(exit: TerminalExitFeedbackInput): {
  status: string
  failure?: string
} {
  if (exit.state === 'exited') {
    return {
      status: sessionProcessLabel({
        incarnationId: LIVE_EXIT_INCARNATION,
        state: 'exited',
        exitCode: exit.exitCode,
        signal: exit.signal ?? null,
        detail: null
      })
    }
  }
  if (exit.cause !== 'unobserved-loss') {
    return {
      status: sessionProcessLabel({
        incarnationId: LIVE_EXIT_INCARNATION,
        state: 'interrupted',
        exitCode: null,
        signal: null,
        detail: lifecycleStopDetail(exit.cause, exit)
      })
    }
  }
  return {
    status: sessionProcessLabel({
      incarnationId: LIVE_EXIT_INCARNATION,
      state: 'interrupted',
      exitCode: null,
      signal: null,
      detail: null
    }),
    failure: `The shell stop outcome is unknown: ${exit.reason}. Fix: restart BMN before starting another shell.`
  }
}

/**
 * A live pane's whole reaction to its terminal-exit message: detach the output flow, show the exit
 * status, and forward the failure text to the failure surface only for an unobserved loss.
 */
export function applyTerminalExit(
  message: TerminalExitMessage,
  pane: {
    detach(attachmentId: string): void
    setStatus(status: string): void
    onFailure(failure: string): void
  }
): void {
  pane.detach(message.attachmentId)
  const feedback = terminalExitFeedback(message)
  pane.setStatus(feedback.status)
  if (feedback.failure) pane.onFailure(feedback.failure)
}
