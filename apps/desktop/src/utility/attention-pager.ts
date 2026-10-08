// MODULE: attention-pager.ts - sends an attention request to the owner's phone only when the owner is away and it waited unseen
import type { AttentionKind, AttentionRecord } from '@bmn/protocol'
import { observeTelegramDelivery, type TelegramDeliveryObserver } from './telegram-delivery'

/** How long a request may wait for the owner in the app before it is also sent away from the desk. */
export const PAGE_AFTER_MS: Readonly<Record<AttentionKind, number>> = Object.freeze({
  permission: 15_000,
  question: 15_000,
  handoff: 15_000,
  review: 15_000,
  notice: 60_000
})

/** A request that fell due while the owner was at the desk is still sent if they leave this soon after it opened. */
export const LEFT_WITHIN_MS = 10 * 60_000

export interface AttentionPagerOptions {
  /** The request as stored now, or null when it is gone. */
  current(requestId: string): Promise<AttentionRecord | null>
  /** False only when nothing was attempted and recovery may safely retry. */
  send(record: AttentionRecord): Promise<void | boolean>
  schedule(callback: () => void, ms: number): () => void
  /** False while the owner is at the desk, where the app already notified them; null when presence cannot be read. */
  ownerAway(): boolean | null
  now(): number
  pageAfterMs?: Readonly<Record<AttentionKind, number>>
  leftWithinMs?: number
  observeDelivery?: TelegramDeliveryObserver
  /** Runs before the desktop rule so overnight requests retain delivery eligibility. */
  holdQuiet?(record: AttentionRecord): Promise<boolean>
}

/**
 * Agents repeat the same request and the owner often answers at the desk, so each request revision is sent at most
 * once, only if it is still open and unseen when its wait ends, and only while the owner is away. A request that fell
 * due at the desk waits a while for the owner to leave; when presence cannot be read, it is sent as before.
 */
export function createAttentionPager(options: AttentionPagerOptions): {
  opened(record: AttentionRecord): void
  /** Call when the owner turns away from the desk. */
  ownerLeft(): void
  /** Telegram is available again; try only revisions definitely left unsent. */
  retryUnsent(): void
  /** Quiet-hours departure eligibility expired; keep the request itself untouched. */
  retire(record: AttentionRecord): void
  close(): void
} {
  const pageAfterMs = options.pageAfterMs ?? PAGE_AFTER_MS
  const leftWithinMs = options.leftWithinMs ?? LEFT_WITHIN_MS
  const pending = new Map<string, () => void>()
  const atDesk = new Map<string, { record: AttentionRecord; openedAt: number }>()
  const handled = new Set<string>()
  const unsent = new Map<string, AttentionRecord>()
  const inFlight = new Set<string>()
  let availability = 0
  let closed = false
  const page = async (key: string, record: AttentionRecord, openedAt?: number): Promise<void> => {
    if (closed || handled.has(key) || inFlight.has(key)) return
    inFlight.add(key)
    atDesk.delete(key)
    unsent.delete(key)
    const started = availability
    let retry = false
    try {
      const current = await options.current(record.requestId).catch(() => null)
      if (closed || !current || current.state !== 'open' || current.seenAt !== null || current.revision !== record.revision) {
        observeTelegramDelivery(options.observeDelivery, record,
          closed || !current ? 'request-unavailable' : current.state !== 'open' ? 'request-closed'
            : current.seenAt !== null ? 'request-seen' : 'request-revised')
        handled.add(key)
        return
      }
      // Departure made this revision eligible already; reconnects must not reset or expire that eligibility.
      let held = false
      try { held = await options.holdQuiet?.(current) ?? false }
      catch {
        observeTelegramDelivery(options.observeDelivery, current, 'quiet-history-unavailable')
        unsent.set(key, current)
        return
      }
      if (held) {
        observeTelegramDelivery(options.observeDelivery, current, 'held-quiet')
        unsent.set(key, current)
        return
      }
      if (handled.has(key)) return
      if (options.ownerAway() === false) {
        observeTelegramDelivery(options.observeDelivery, record, 'held-at-desk', { away: false })
        if (openedAt !== undefined) atDesk.set(key, { record: current, openedAt })
        else unsent.set(key, current)
        return
      }
      const consumed = await options.send(current).catch(() => {
        observeTelegramDelivery(options.observeDelivery, record, 'page-error')
        return true
      })
      if (consumed === false && !closed) {
        unsent.set(key, current)
        retry = started !== availability
      } else handled.add(key)
    } finally {
      inFlight.delete(key)
      // Recovery may arrive while an unavailable attempt is still settling.
      if (retry && options.ownerAway() !== false) void page(key, record)
    }
  }
  const forgetStale = (): void => {
    for (const [key, waiting] of atDesk) {
      if (options.now() - waiting.openedAt <= leftWithinMs) continue
      observeTelegramDelivery(options.observeDelivery, waiting.record, 'departure-window-expired')
      atDesk.delete(key)
      handled.add(key)
    }
  }
  return {
    retire: record => {
      const key = `${record.requestId}:${record.revision}`
      pending.get(key)?.(); pending.delete(key)
      atDesk.delete(key); unsent.delete(key); handled.add(key)
    },
    opened: (record) => {
      const key = `${record.requestId}:${record.revision}`
      if (closed || record.state !== 'open' || record.seenAt !== null || pending.has(key) || atDesk.has(key) || handled.has(key) || unsent.has(key) || inFlight.has(key)) {
        return
      }
      const openedAt = options.now()
      observeTelegramDelivery(options.observeDelivery, record, 'scheduled', {
        away: options.ownerAway(), delayMs: pageAfterMs[record.kind]
      })
      pending.set(key, options.schedule(() => {
        pending.delete(key)
        forgetStale()
        const away = options.ownerAway()
        observeTelegramDelivery(options.observeDelivery, record, 'timer-fired', { away, elapsedMs: options.now() - openedAt })
        if (away === false && !options.holdQuiet) {
          observeTelegramDelivery(options.observeDelivery, record, 'held-at-desk', { away })
          atDesk.set(key, { record, openedAt })
        }
        else void page(key, record, openedAt)
      }, pageAfterMs[record.kind]))
    },
    ownerLeft: () => {
      if (closed) return
      forgetStale()
      for (const [key, waiting] of [...atDesk]) void page(key, waiting.record)
      if (options.ownerAway() !== false) {
        availability += 1
        for (const [key, record] of [...unsent]) void page(key, record)
      }
    },
    retryUnsent: () => {
      if (closed || options.ownerAway() === false) return
      availability += 1
      for (const [key, record] of [...unsent]) void page(key, record)
    },
    close: () => {
      closed = true
      for (const cancel of pending.values()) cancel()
      pending.clear()
      atDesk.clear()
      unsent.clear()
    }
  }
}
