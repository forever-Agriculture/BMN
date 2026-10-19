// MODULE: agent-grant-notices.ts - the departure notice an agent is handed once per conversation and departure, beside the away notice (Story 84.3)
import {
  AGENT_BRIEF_HANDOVER,
  AWAY_NOTICE_HANDOVER,
  grantDepartureNotice,
  type GrantPeriod
} from '@bmn/protocol'
import type { AgentBriefEvent } from './agent-briefs'

/** Conversations remembered per process; past it the oldest go, and one of them is at most told again. */
const GRANT_NOTICES_REMEMBERED = 2_000
/** SessionStart sources after which the conversation has lost what it was told. */
const LOST_SOURCES: readonly string[] = Object.freeze(['compact', 'clear'])

/**
 * Story 84.3 AC1: while he is leaving or away, the agent in each session is told once per conversation and departure, in
 * the answer to the event the away notice rides on (its start, or its next tool call), that a run may ask him on one card.
 * A missed or repeated notice is harmless: a run that does not ask is granted nothing, and asking again with the same
 * terms changes nothing. What was told is kept in memory; the sessions told are kept with the period for "told Builder".
 */
export class GrantDepartureNotices {
  private told = new Set<string>()

  constructor(private readonly options: {
    now(): Date
    /** Keeps the session with the period; a failure only drops it from "told …". */
    mark(periodId: string, sessionId: string): Promise<unknown>
  }) {}

  answer(p: AgentBriefEvent, period: GrantPeriod | null): string | null {
    const start = AGENT_BRIEF_HANDOVER[p.agent]?.event === p.event && p.source !== null
    const tool = AWAY_NOTICE_HANDOVER[p.agent]?.event === p.event
    if ((!start && !tool) || p.turn === undefined || p.turn.nested || period === null) return null
    const key = `${period.periodId}\u0000${p.sessionId}\u0000${p.agent}\u0000${p.turn.conversation}`
    if (start && LOST_SOURCES.includes(p.source ?? '')) this.told.delete(key)
    if (this.told.has(key)) return null
    const text = grantDepartureNotice(period, this.options.now())
    if (text === null) return null
    this.told.add(key)
    for (const old of this.told) {
      if (this.told.size <= GRANT_NOTICES_REMEMBERED) break
      this.told.delete(old)
    }
    if (!period.told.includes(p.sessionId)) void this.options.mark(period.periodId, p.sessionId).catch(() => undefined)
    return text
  }
}
