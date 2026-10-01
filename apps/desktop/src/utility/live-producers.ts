import { randomUUID } from 'node:crypto'
import type { AttentionProducer, AttentionProducerBinding, AttentionRecord } from '@bmn/protocol'

/** One foreground producer per live process. No transcripts, persistence or resume authority. */
export class LiveProducers {
  private readonly slots = new Map<string, { incarnationId: string; binding: AttentionProducerBinding | null; available: boolean; seen: Set<string>; overflow: boolean; ambiguous: boolean }>()

  constructor(private readonly live: (sessionId: string) => string | undefined) {}

  private slot(sessionId: string): ReturnType<typeof this.slots.get> {
    const slot = this.slots.get(sessionId)
    if (slot && this.live(sessionId) !== slot.incarnationId) {
      this.slots.delete(sessionId)
      return undefined
    }
    return slot
  }

  observe(sessionId: string, incarnationId: string | null, producer: AttentionProducer): AttentionProducerBinding | null {
    if (!incarnationId || this.live(sessionId) !== incarnationId) return null
    // Prune exited sessions whenever new evidence arrives, bounding state by live sessions.
    for (const id of this.slots.keys()) this.slot(id)
    const previous = this.slot(sessionId)
    if (previous?.available && previous.binding?.agentCli === producer.agentCli &&
      previous.binding.conversationReference === producer.conversationReference) return previous.binding
    const identity = this.identity(producer)
    const seen = previous?.seen ?? new Set<string>()
    const ambiguous = !!previous?.overflow || seen.has(identity)
    // Sticky overflow is conservative: evicting an ID must never restore destructive authority.
    const overflow = !!previous?.overflow || seen.size >= 64 && !seen.has(identity)
    if (seen.size < 64) seen.add(identity)
    const binding = { ...producer, generation: randomUUID() }
    this.slots.set(sessionId, { incarnationId, binding, available: true, seen, overflow, ambiguous })
    return binding
  }

  stamp(sessionId: string, incarnationId: string | null): AttentionProducerBinding | null {
    const slot = this.slot(sessionId)
    return slot?.available && slot.incarnationId === incarnationId ? slot.binding : null
  }

  current(record: AttentionRecord, allowUnconfirmed = true): boolean {
    if (!record.incarnationId || this.live(record.sessionId) !== record.incarnationId) return false
    const slot = this.slot(record.sessionId)
    if (!record.producer) return allowUnconfirmed && !slot
    return !!slot?.available && !!slot.binding && slot.binding.generation === record.producer.generation &&
      slot.binding.agentCli === record.producer.agentCli &&
      slot.binding.conversationReference === record.producer.conversationReference
  }

  private identity(producer: AttentionProducer): string {
    return `${producer.agentCli}:${producer.conversationReference}`
  }

  private remember(slot: NonNullable<ReturnType<LiveProducers['slot']>>, producer: AttentionProducer): void {
    const identity = this.identity(producer)
    if (slot.seen.has(identity)) return
    if (slot.seen.size < 64) slot.seen.add(identity)
    else slot.overflow = true
  }

  /** A destructive event never establishes or replaces the current producer. */
  canClose(record: AttentionRecord, producer: AttentionProducer | undefined, correlated = false, lifecycle = false): boolean {
    const slot = this.slot(record.sessionId)
    if (slot && producer) this.remember(slot, producer)
    if (!record.producer) {
      if (!producer && !slot && !lifecycle) return true
      // A conflicting old ID cannot disable a newer identified producer.
      if (!slot?.binding || !producer || this.identity(slot.binding) === this.identity(producer)) this.unavailable(record.sessionId, producer)
      return false
    }
    if (!producer) { this.unavailable(record.sessionId); return false }
    const matches = record.producer.agentCli === producer.agentCli &&
      record.producer.conversationReference === producer.conversationReference
    if (!matches) return false
    if (!correlated && slot?.binding && this.identity(slot.binding) === this.identity(producer) && slot.ambiguous) {
      slot.available = false
      return false
    }
    return true
  }

  unavailable(sessionId: string, producer?: AttentionProducer): void {
    const slot = this.slot(sessionId)
    if (slot) slot.available = false
    else {
      const incarnationId = this.live(sessionId)
      if (incarnationId) this.slots.set(sessionId, { incarnationId, binding: null, available: false,
        seen: new Set(), overflow: false, ambiguous: true })
    }
    const held = this.slot(sessionId)
    if (held && producer) this.remember(held, producer)
  }

  ended(sessionId: string, producer: AttentionProducer | undefined): void {
    const slot = this.slot(sessionId)
    if (slot && producer) this.remember(slot, producer)
    if (!slot?.binding || !producer || this.identity(slot.binding) === this.identity(producer)) this.unavailable(sessionId, producer)
  }
}
