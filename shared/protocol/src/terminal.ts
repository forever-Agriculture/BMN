import { hasExactKeys } from './closed-shape'
import { MAX_TERMINAL_CHUNK_BYTES, METHOD_REGISTRY } from './constants'
import { isLifecycleStopCause, type LifecycleStopCause } from './workspace'

export const CONSUMER_OUTPUT_QUEUE_BYTES = 4 * 1024 * 1024
export const PTY_HOST_OUTPUT_QUEUE_BYTES = 16 * 1024 * 1024
export const TERMINAL_PARSER_ATOM_BYTES = 64 * 1024
// Output produced without a streaming attachment is retained only for the next view.
export const TERMINAL_UNDELIVERED_OUTPUT_BYTES = 16 * 1024 * 1024
export const TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS = 5_000
export const TERMINAL_SCROLLBACK_LINES = 10_000
export const TERMINAL_SAVED_OUTPUT_BYTES = 64 * 1024 * 1024
export const TERMINAL_SAVED_OUTPUT_RETENTION = 100
export const SAVED_OUTPUT_FORMAT_VERSION = 2
export const RESTORED_VIEW_NOTICE =
  'View restored after renderer loss. The process kept running. Earlier output is in Saved Output.'

export interface TerminalByteMessage {
  attachmentId: string
  streamSeq: number
  bytes: Uint8Array
}

export interface TerminalOutputMessage extends TerminalByteMessage {
  kind: 'terminal-output'
}

export interface TerminalInputMessage {
  kind: 'terminal-input'
  method: typeof METHOD_REGISTRY.terminalWrite
  attachmentId: string
  bytes: Uint8Array
}

export interface TerminalAckMessage {
  kind: 'terminal-ack'
  attachmentId: string
  streamSeq: number
}

export interface TerminalExitedMessage {
  kind: 'terminal-exit'
  state: 'exited'
  attachmentId: string
  exitCode: number
  signal?: number
}

export interface TerminalLifecycleInterruptedMessage {
  kind: 'terminal-exit'
  state: 'interrupted'
  attachmentId: string
  cause: LifecycleStopCause
  exitCode: number
  signal?: number
}

export interface TerminalUnobservedInterruptedMessage {
  kind: 'terminal-exit'
  state: 'interrupted'
  attachmentId: string
  cause: 'unobserved-loss'
  reason: string
}

export type TerminalInterruptedMessage =
  | TerminalLifecycleInterruptedMessage
  | TerminalUnobservedInterruptedMessage

export type TerminalViewDisconnectReason =
  | 'output-overflow'
  | 'sequence-gap'
  | 'acknowledgement-timeout'

export interface TerminalViewDisconnectedMessage {
  kind: 'terminal-view-disconnected'
  attachmentId: string
  reason: TerminalViewDisconnectReason
}

export interface TerminalActivationResult {
  activated: true
  undeliveredOutput: {
    limitBytes: number
    droppedBytes: number
    truncated: boolean
  }
}

export type SessionProcessState = 'live' | 'exited' | 'exit-unconfirmed'

export interface SessionProcessStateChangedMessage {
  kind: 'session-process-state-changed'
  sessionId: string
  incarnationId: string
  state: Exclude<SessionProcessState, 'live'>
}

export function isSessionProcessStateChangedMessage(
  value: unknown
): value is SessionProcessStateChangedMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionProcessStateChangedMessage>
  return (
    candidate.kind === 'session-process-state-changed' &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.incarnationId === 'string' &&
    candidate.incarnationId.length > 0 &&
    (candidate.state === 'exited' || candidate.state === 'exit-unconfirmed')
  )
}

export interface SavedOutputCapture {
  capturedAt: string
  content: string
  retainedLines: number
  snapshotTruncated: boolean
  snapshotDroppedLines: number
  snapshotDroppedBytes: number | null
  transportDroppedBytes: number
}

export type SavedOutputProcessState = 'live' | 'exited' | 'interrupted'

export type SavedOutputUnavailableReason =
  | 'no-renderer'
  | 'renderer-destroyed'
  | 'not-acknowledged-in-time'
  | 'capture-persist-failure'

export type SavedOutputCaptureOutcome =
  | { status: 'saved' }
  | {
      status: 'unavailable'
      reason: SavedOutputUnavailableReason
      detail: string
    }

export type SavedOutputSnapshot = Omit<
  SavedOutputCapture,
  'snapshotTruncated' | 'snapshotDroppedLines' | 'snapshotDroppedBytes' | 'transportDroppedBytes'
> & {
  formatVersion: 1 | typeof SAVED_OUTPUT_FORMAT_VERSION
  sessionId: string
  incarnationId: string
  viewEpoch: string
  captureStartedAt: string
  lineLimit: number
  snapshotLimitBytes: number
  snapshotTruncated: boolean | null
  snapshotDroppedLines: number | null
  snapshotDroppedBytes: number | null
  transportDroppedBytes: number | null
  processState: SavedOutputProcessState
}

export interface SavedOutputFinalCaptureUnavailable {
  formatVersion: typeof SAVED_OUTPUT_FORMAT_VERSION
  sessionId: string
  incarnationId: string
  viewEpoch: string
  unavailableAt: string
  reason: SavedOutputUnavailableReason
  detail: string
  lastCaptureAt: string | null
  processState: SavedOutputProcessState
}

export interface SavedOutputUnreadableEntry {
  source: string
  reason: 'invalid' | 'unsupported-format'
  sessionId?: string
  incarnationId?: string
  viewEpoch?: string
}

export interface SavedOutputCatalog {
  view: {
    sessionId: string
    incarnationId: string
    viewEpoch: string
  }
  current?: SavedOutputSnapshot
  history: SavedOutputSnapshot[]
  finalCaptureUnavailable: SavedOutputFinalCaptureUnavailable[]
  unreadable: SavedOutputUnreadableEntry[]
  retention: {
    limit: number
    pruned: number
  }
}

export type SavedOutputCaptureFlushResult =
  | { ok: true }
  | { ok: false; message: string }

export type TerminalExitMessage = TerminalExitedMessage | TerminalInterruptedMessage

export type TerminalPortMessage =
  | TerminalOutputMessage
  | TerminalInputMessage
  | TerminalAckMessage
  | TerminalExitMessage
  | TerminalViewDisconnectedMessage

function hasAttachmentId(value: unknown): value is { attachmentId: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { attachmentId?: unknown }).attachmentId === 'string' &&
    (value as { attachmentId: string }).attachmentId.length > 0
  )
}

function hasBoundedBytes(value: unknown): value is { bytes: Uint8Array } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { bytes?: unknown }).bytes instanceof Uint8Array &&
    ((value as { bytes: Uint8Array }).bytes.byteLength <= MAX_TERMINAL_CHUNK_BYTES)
  )
}

function hasStreamSequence(value: unknown): value is { streamSeq: number } {
  if (!value || typeof value !== 'object') return false
  const streamSeq = (value as { streamSeq?: unknown }).streamSeq
  return Number.isSafeInteger(streamSeq) && (streamSeq as number) >= 0
}

export function isTerminalByteMessage(value: unknown): value is TerminalByteMessage {
  return hasAttachmentId(value) && hasStreamSequence(value) && hasBoundedBytes(value)
}

export function isTerminalOutputMessage(value: unknown): value is TerminalOutputMessage {
  return (
    isTerminalByteMessage(value) &&
    (value as { kind?: unknown }).kind === 'terminal-output'
  )
}

export function isTerminalInputMessage(value: unknown): value is TerminalInputMessage {
  return (
    hasAttachmentId(value) &&
    hasBoundedBytes(value) &&
    (value as { kind?: unknown }).kind === 'terminal-input' &&
    (value as { method?: unknown }).method === METHOD_REGISTRY.terminalWrite
  )
}

export function isTerminalAckMessage(value: unknown): value is TerminalAckMessage {
  return (
    hasAttachmentId(value) &&
    hasStreamSequence(value) &&
    (value as { kind?: unknown }).kind === 'terminal-ack'
  )
}

export function isTerminalExitMessage(value: unknown): value is TerminalExitMessage {
  if (!hasAttachmentId(value) || (value as { kind?: unknown }).kind !== 'terminal-exit') return false
  const candidate = value as {
    state?: unknown
    cause?: unknown
    exitCode?: unknown
    signal?: unknown
    reason?: unknown
  }
  if (candidate.state === 'exited') {
    return (
      hasExactKeys(value, ['kind', 'state', 'attachmentId', 'exitCode'], ['signal']) &&
      Number.isInteger(candidate.exitCode) &&
      (candidate.signal === undefined || Number.isInteger(candidate.signal))
    )
  }
  if (candidate.state !== 'interrupted') return false
  if (isLifecycleStopCause(candidate.cause)) {
    return (
      hasExactKeys(
        value,
        ['kind', 'state', 'attachmentId', 'cause', 'exitCode'],
        ['signal']
      ) &&
      Number.isInteger(candidate.exitCode) &&
      (candidate.signal === undefined || Number.isInteger(candidate.signal))
    )
  }
  return candidate.cause === 'unobserved-loss' &&
    hasExactKeys(value, ['kind', 'state', 'attachmentId', 'cause', 'reason']) &&
    typeof candidate.reason === 'string' &&
    candidate.reason.length > 0 &&
    candidate.reason.length <= 240
}

export function isTerminalViewDisconnectedMessage(
  value: unknown
): value is TerminalViewDisconnectedMessage {
  if (!hasAttachmentId(value) || (value as { kind?: unknown }).kind !== 'terminal-view-disconnected') {
    return false
  }
  const reason = (value as { reason?: unknown }).reason
  return (
    reason === 'output-overflow' ||
    reason === 'sequence-gap' ||
    reason === 'acknowledgement-timeout'
  )
}
