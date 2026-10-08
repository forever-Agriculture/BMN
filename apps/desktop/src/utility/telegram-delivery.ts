import type { AttentionRecord } from '@bmn/protocol'
import { TelegramConnectorError } from './telegram-connector'

/** Local validation or a definite Bot API refusal is safe to retry; transport/protocol failures are not. */
export function telegramSendDefinitelyUnsent(error: unknown): boolean {
  return error instanceof TelegramConnectorError && (error.kind === 'invalid-argument' ||
    (error.status !== undefined && error.status !== null && [400, 401, 403, 404, 429].includes(error.status)))
}

export type TelegramDeliveryPhase =
  | 'scheduled' | 'timer-fired' | 'held-at-desk' | 'held-quiet' | 'departure-window-expired'
  | 'quiet-history-unavailable'
  | 'quiet-backlog' | 'quiet-capacity' | 'quiet-restarting'
  | 'request-unavailable' | 'request-read-failed' | 'request-closed' | 'request-seen' | 'request-revised'
  | 'already-notified-elsewhere'
  | 'connector-unavailable' | 'page-error' | 'send-started' | 'send-confirmed'
  | 'send-uncertain' | 'format-fallback' | 'fallback-failed' | 'mapping-write-failed'

/** Identity and fixed categories only: never include card text, callback data, errors or credentials. */
export interface TelegramDeliveryEvent {
  requestId: string
  /** A failed lookup has only the requested ID; never invent the missing record's metadata. */
  sessionId?: string
  incarnationId?: string | null
  revision?: number
  kind?: AttentionRecord['kind']
  phase: TelegramDeliveryPhase
  away?: boolean | null
  delayMs?: number
  elapsedMs?: number
}

export type TelegramDeliveryObserver = (event: TelegramDeliveryEvent) => void

export function observeTelegramDelivery(
  observer: TelegramDeliveryObserver | undefined,
  record: AttentionRecord,
  phase: TelegramDeliveryPhase,
  timing: Pick<TelegramDeliveryEvent, 'away' | 'delayMs' | 'elapsedMs'> = {}
): void {
  if (!observer) return
  try {
    observer({
      requestId: record.requestId, sessionId: record.sessionId, incarnationId: record.incarnationId,
      revision: record.revision, kind: record.kind, phase,
      ...(timing.away === undefined ? {} : { away: timing.away }),
      ...(timing.delayMs === undefined ? {} : { delayMs: timing.delayMs }),
      ...(timing.elapsedMs === undefined ? {} : { elapsedMs: timing.elapsedMs })
    })
  } catch { /* Diagnosis must not affect sending, suppressing or retrying a card. */ }
}
