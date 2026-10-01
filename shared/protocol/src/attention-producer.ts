import { hasExactKeys } from './closed-shape'

/** Live foreground hook identity, separate from a persisted resume reservation. */
export interface AttentionProducer {
  agentCli: 'claude' | 'codex'
  conversationReference: string
}

/** The host's generation prevents a returned A from inheriting A's earlier cards. */
export interface AttentionProducerBinding extends AttentionProducer {
  generation: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseAttentionProducer(value: unknown): AttentionProducer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !hasExactKeys(value, ['agentCli', 'conversationReference'])) return null
  const record = value as Record<string, unknown>
  if ((record.agentCli !== 'claude' && record.agentCli !== 'codex') ||
    typeof record.conversationReference !== 'string' || !UUID.test(record.conversationReference)) return null
  return { agentCli: record.agentCli, conversationReference: record.conversationReference.toLowerCase() }
}

export function readStoredProducer(value: string | null): AttentionProducerBinding | null {
  try {
    const record: unknown = value === null ? null : JSON.parse(value)
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !hasExactKeys(record, ['agentCli', 'conversationReference', 'generation'])) return null
    const { generation, ...identity } = record as Record<string, unknown>
    const producer = parseAttentionProducer(identity)
    return producer && typeof generation === 'string' && UUID.test(generation) ? { ...producer, generation } : null
  } catch { return null }
}
