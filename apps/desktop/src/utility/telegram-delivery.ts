import type { AttentionRecord } from '@bmn/protocol'

export type TelegramDeliveryPhase =
  | 'scheduled' | 'timer-fired' | 'held-at-desk' | 'departure-window-expired'
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
