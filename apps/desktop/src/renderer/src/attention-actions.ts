// MODULE: attention-actions.ts - revision-guarded owner withdrawal, held through the renderer refresh
import { ERROR_CODES, type AttentionRecord } from '@bmn/protocol'
import type { AiTerminalBridge } from '../../preload/bridge'
import { attentionActionWhenOpened } from './session-presentation'

type WithdrawalObserver = (record: AttentionRecord) => void
interface PendingReminder {
  operation: Promise<AttentionRecord | null>
  result: AttentionRecord | null
  observers: WithdrawalObserver[]
}
const pendingReminders = new WeakMap<object, Map<string, PendingReminder>>()

export function noticesWhenNavigating(records: readonly AttentionRecord[], sessionId: string): AttentionRecord[] {
  return records.filter(request => request.sessionId === sessionId && attentionActionWhenOpened(request) !== null)
}

/** Resolution advances the store revision. Replace the captured revision, never a newer arrival. */
export function applyAttentionWithdrawal(records: AttentionRecord[], captured: AttentionRecord, resolved: AttentionRecord): AttentionRecord[] {
  return records.map(record => record.requestId === captured.requestId && record.revision === captured.revision ? resolved : record)
}

export async function dismissAttentionReminder(
  bridge: Pick<AiTerminalBridge, 'resolveAttention'>,
  request: AttentionRecord,
  resolution = 'Dismissed in BMN',
  refresh: () => Promise<unknown> = async () => undefined,
  onWithdrawn?: WithdrawalObserver
): Promise<AttentionRecord | null> {
  let pending = pendingReminders.get(bridge)
  if (!pending) { pending = new Map(); pendingReminders.set(bridge, pending) }
  const key = `${request.requestId}:${request.revision}`
  const active = pending.get(key)
  if (active) {
    if (onWithdrawn) {
      if (active.result) onWithdrawn(active.result)
      else active.observers.push(onWithdrawn)
    }
    return active.operation
  }
  const entry: PendingReminder = { operation: Promise.resolve(null), result: null, observers: onWithdrawn ? [onWithdrawn] : [] }
  pending.set(key, entry)
  entry.operation = (async () => {
    let failed = false
    let failure: unknown
    try {
      entry.result = await bridge.resolveAttention(request.requestId, resolution,
        { kind: request.kind, revision: request.revision }, 'owner', 'withdrawn')
      for (const observe of entry.observers) observe(entry.result)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== ERROR_CODES.notFound && code !== ERROR_CODES.revisionConflict) { failed = true; failure = error }
    }
    try {
      await refresh()
    } catch (error) {
      if (!failed) throw new Error(entry.result
        ? 'Reminder cleared. The request list could not refresh; try again.'
        : 'The request list could not refresh; try again.', { cause: error })
    }
    if (failed) throw failure
    return entry.result
  })().finally(() => pending.delete(key))
  return entry.operation
}
