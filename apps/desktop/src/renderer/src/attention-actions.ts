// MODULE: attention-actions.ts - guarded owner reminder dismissal and clipboard-only question answers
import type { AttentionRecord } from '@bmn/protocol'
import type { AiTerminalBridge } from '../../preload/bridge'

type AttentionBridge = Pick<AiTerminalBridge, 'listAttention' | 'resolveAttention' | 'writeClipboardText'>
const pendingReminders = new WeakMap<object, Map<string, Promise<AttentionRecord>>>()

export async function dismissAttentionReminder(
  bridge: Pick<AttentionBridge, 'resolveAttention'>,
  request: AttentionRecord,
  resolution = 'Dismissed in BMN'
): Promise<AttentionRecord> {
  let pending = pendingReminders.get(bridge)
  if (!pending) { pending = new Map(); pendingReminders.set(bridge, pending) }
  const key = `${request.requestId}:${request.revision}`
  const active = pending.get(key)
  if (active) return active
  const operation = bridge.resolveAttention(request.requestId, resolution,
    { kind: request.kind, revision: request.revision }, 'owner', 'withdrawn')
    .finally(() => pending.delete(key))
  pending.set(key, operation)
  return operation
}

/** Copying is an owner action, never a producer answer or terminal write. */
export async function copyAttentionAnswer(
  bridge: AttentionBridge,
  request: AttentionRecord,
  text: string
): Promise<void> {
  if (!text.trim()) throw new Error('Choose an answer or enter your own.')
  const current = (await bridge.listAttention()).find((record) => record.requestId === request.requestId)
  if (!current || current.state !== 'open' || current.kind !== 'question' ||
      current.revision !== request.revision || current.incarnationId !== request.incarnationId ||
      current.prompt?.type !== 'questions') {
    throw new Error('This question changed. Open the current card before copying.')
  }
  await bridge.writeClipboardText(text)
  try {
    await dismissAttentionReminder(bridge, request, 'Answer copied; not submitted')
  } catch {
    throw new Error('Answer copied. The reminder could not be cleared; review the current card.')
  }
}
