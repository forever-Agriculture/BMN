// MODULE: agent-briefs.ts - when a conversation gets BMN's start brief (Story 75.6)
import {
  AGENT_BRIEF_AGAIN_SOURCE,
  AGENT_BRIEF_HANDOVER,
  AGENT_BRIEF_NEW_SOURCES,
  AGENT_START_BRIEF
} from '@bmn/protocol'

/** One compaction's start may be reported by more than one hook entry; starts this close are one compaction. */
export const AGENT_BRIEF_COMPACT_SAME_MS = 60_000
/** Conversations remembered at once; the oldest is forgotten first. */
export const AGENT_BRIEF_REMEMBERED = 2_000

export interface AgentBriefEvent {
  sessionId: string
  incarnationId: string | null
  agent: string
  event: string
  source: string | null
  /** The conversation and whether a sub-agent speaks, as the session's own hook reported them. */
  turn?: { conversation: string; nested: boolean } | undefined
}

/**
 * Hands the agent typed into a session BMN's brief once per conversation, in the answer to the report of its
 * start, and once more after each compaction, which loses it (Story 75.2). A resumed or forked conversation
 * already holds what it was told; a BMN restart briefs nothing again, because the process BMN briefed ended
 * with it and goes on only as a resumed or a new conversation. A sub-agent has no start of its own in Claude
 * Code and is a fork in Codex. The brief counts as given when BMN answers: a hook that gave up waiting loses it.
 */
export class AgentBriefs {
  /** When each remembered conversation was last compacted, or null; a remembered one was briefed or resumed. */
  private readonly conversations = new Map<string, { compactedAt: number | null }>()

  constructor(private readonly options: {
    liveIncarnationId(sessionId: string): string | null | undefined
    now(): number
  }) {}

  /** The brief for this event's answer, or null. */
  answer(p: AgentBriefEvent): string | null {
    if (AGENT_BRIEF_HANDOVER[p.agent]?.event !== p.event || p.source === null) return null
    if (p.turn === undefined || p.turn.nested || p.incarnationId === null) return null
    if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return null
    const key = `${p.sessionId}\u0000${p.agent}\u0000${p.turn.conversation}`
    const known = this.conversations.get(key)
    if (p.source === AGENT_BRIEF_AGAIN_SOURCE) {
      const now = this.options.now()
      const same = known?.compactedAt != null && now - known.compactedAt < AGENT_BRIEF_COMPACT_SAME_MS
      this.remember(key, { compactedAt: now })
      return same ? null : AGENT_START_BRIEF
    }
    if (known !== undefined) return null
    this.remember(key, { compactedAt: null })
    return AGENT_BRIEF_NEW_SOURCES.includes(p.source) ? AGENT_START_BRIEF : null
  }

  private remember(key: string, conversation: { compactedAt: number | null }): void {
    this.conversations.delete(key)
    this.conversations.set(key, conversation)
    while (this.conversations.size > AGENT_BRIEF_REMEMBERED) {
      const oldest = this.conversations.keys().next().value
      if (oldest === undefined) break
      this.conversations.delete(oldest)
    }
  }
}
