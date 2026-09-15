// MODULE: attention-pager.ts - sends an attention request to the owner's phone only after it waited unseen in the app
import type { AttentionKind, AttentionRecord } from '@ai-terminal/protocol'

/** How long a request may wait for the owner in the app before it is also sent away from the desk. */
export const PAGE_AFTER_MS: Readonly<Record<AttentionKind, number>> = Object.freeze({
  permission: 15_000,
  question: 15_000,
  review: 15_000,
  notice: 60_000
})

export interface AttentionPagerOptions {
  /** The request as stored now, or null when it is gone. */
  current(requestId: string): Promise<AttentionRecord | null>
  send(record: AttentionRecord): Promise<void>
  schedule(callback: () => void, ms: number): () => void
  pageAfterMs?: Readonly<Record<AttentionKind, number>>
}

/**
 * Agents repeat the same request and the owner often answers at the desk, so each request revision is sent at most
 * once, and only if it is still open and unseen when its wait ends.
 */
export function createAttentionPager(options: AttentionPagerOptions): {
  opened(record: AttentionRecord): void
  close(): void
} {
  const pageAfterMs = options.pageAfterMs ?? PAGE_AFTER_MS
  const pending = new Map<string, () => void>()
  const handled = new Set<string>()
  let closed = false
  const page = async (key: string, record: AttentionRecord): Promise<void> => {
    pending.delete(key)
    handled.add(key)
    const current = await options.current(record.requestId).catch(() => null)
    if (closed || !current || current.state !== 'open' || current.seenAt !== null || current.revision !== record.revision) {
      return
    }
    await options.send(current).catch(() => undefined)
  }
  return {
    opened: (record) => {
      const key = `${record.requestId}:${record.revision}`
      if (closed || record.state !== 'open' || record.seenAt !== null || pending.has(key) || handled.has(key)) return
      pending.set(key, options.schedule(() => void page(key, record), pageAfterMs[record.kind]))
    },
    close: () => {
      closed = true
      for (const cancel of pending.values()) cancel()
      pending.clear()
    }
  }
}
