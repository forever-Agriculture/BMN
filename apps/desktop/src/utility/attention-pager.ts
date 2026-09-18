// MODULE: attention-pager.ts - sends an attention request to the owner's phone only when the owner is away and it waited unseen
import type { AttentionKind, AttentionRecord } from '@bmn/protocol'

/** How long a request may wait for the owner in the app before it is also sent away from the desk. */
export const PAGE_AFTER_MS: Readonly<Record<AttentionKind, number>> = Object.freeze({
  permission: 15_000,
  question: 15_000,
  review: 15_000,
  notice: 60_000
})

/** A request that fell due while the owner was at the desk is still sent if they leave this soon after it opened. */
export const LEFT_WITHIN_MS = 10 * 60_000

export interface AttentionPagerOptions {
  /** The request as stored now, or null when it is gone. */
  current(requestId: string): Promise<AttentionRecord | null>
  send(record: AttentionRecord): Promise<void>
  schedule(callback: () => void, ms: number): () => void
  /** False while the owner is at the desk, where the app already notified them; null when presence cannot be read. */
  ownerAway(): boolean | null
  now(): number
  pageAfterMs?: Readonly<Record<AttentionKind, number>>
  leftWithinMs?: number
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
  close(): void
} {
  const pageAfterMs = options.pageAfterMs ?? PAGE_AFTER_MS
  const leftWithinMs = options.leftWithinMs ?? LEFT_WITHIN_MS
  const pending = new Map<string, () => void>()
  const atDesk = new Map<string, { record: AttentionRecord; openedAt: number }>()
  const handled = new Set<string>()
  let closed = false
  const page = async (key: string, record: AttentionRecord): Promise<void> => {
    atDesk.delete(key)
    handled.add(key)
    const current = await options.current(record.requestId).catch(() => null)
    if (closed || !current || current.state !== 'open' || current.seenAt !== null || current.revision !== record.revision) {
      return
    }
    await options.send(current).catch(() => undefined)
  }
  const forgetStale = (): void => {
    for (const [key, waiting] of atDesk) {
      if (options.now() - waiting.openedAt <= leftWithinMs) continue
      atDesk.delete(key)
      handled.add(key)
    }
  }
  return {
    opened: (record) => {
      const key = `${record.requestId}:${record.revision}`
      if (closed || record.state !== 'open' || record.seenAt !== null || pending.has(key) || atDesk.has(key) || handled.has(key)) {
        return
      }
      const openedAt = options.now()
      pending.set(key, options.schedule(() => {
        pending.delete(key)
        forgetStale()
        if (options.ownerAway() === false) atDesk.set(key, { record, openedAt })
        else void page(key, record)
      }, pageAfterMs[record.kind]))
    },
    ownerLeft: () => {
      if (closed) return
      forgetStale()
      for (const [key, waiting] of [...atDesk]) void page(key, waiting.record)
    },
    close: () => {
      closed = true
      for (const cancel of pending.values()) cancel()
      pending.clear()
      atDesk.clear()
    }
  }
}
