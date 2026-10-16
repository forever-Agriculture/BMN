// MODULE: agent-away-notices.ts - which conversation was handed which away state, and the snapshot an event's answer carries (Story 76.4)
import {
  AGENT_BRIEF_HANDOVER,
  AWAY_NOTICE_HANDOVER,
  awayNotice,
  type AwayRecord
} from '@bmn/protocol'
import type { AgentBriefEvent } from './agent-briefs'

/** Conversations remembered at once; the oldest is forgotten first. */
export const AWAY_NOTICES_REMEMBERED = 2_000
/**
 * How long a claim may stay unconfirmed before it counts as uncertain: longer than a hook takes from BMN's answer to its
 * printed report (its own 3 s calls and the message allowance), so a claim still on its way is never handed twice.
 */
export const AWAY_CLAIM_SETTLE_MS = 15_000
/** Retries of a save that failed, so what was handed survives a restart without waiting for the next change. */
const SAVE_RETRY_MS = 5_000
/** SessionStart sources after which the conversation has lost what it was told. */
const LOST_SOURCES: readonly string[] = Object.freeze(['compact', 'clear'])

/**
 * What one conversation was handed last: the revision and state, and whether its hook reported printing it. `claimed` is
 * BMN's answer sent and no report back, so it may or may not have reached the agent: it counts as handed, and a back after
 * it is handed too. Neither ever means read.
 */
export interface AwayTold {
  revision: number
  state: 'away' | 'back'
  status: 'claimed' | 'printed'
  incarnationId: string
  /** When BMN answered with it; absent in a record kept before it was stored, which reads as long settled. */
  claimedAt?: string
}

export interface AwayNoticeAnswer {
  text: string
  revision: number
}

/**
 * Story 76.4 AC1–AC2: the current state for the agent typed into a session, in its main conversation, in the answer to the
 * event Story 76.2 measured: the start of a conversation and, while it works, the next tool call after a change. A new
 * conversation is told only while he is away; a conversation once told away is told back, also after a BMN restart, since
 * what was handed is kept on disk; a compaction or a clear hands the current state again to one that was told before. An
 * away that was never handed and is over by now is never handed (away and back coalesce only then). The record is the one
 * the host holds when the answer is made, and a revision older than the one handed is never handed.
 */
export class AwayNotices {
  private readonly told = new Map<string, AwayTold>()
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: {
    liveIncarnationId(sessionId: string): string | null | undefined
    now(): Date
    /** Keeps what was handed; a failed write leaves the answer as it is and is tried again with the next change. */
    save(entries: Array<[string, AwayTold]>): Promise<void>
  }) {}

  /** What was kept, read back at start. */
  load(entries: Array<[string, AwayTold]>): void {
    this.told.clear()
    for (const [key, told] of entries.slice(-AWAY_NOTICES_REMEMBERED)) this.told.set(key, told)
  }

  /** The snapshot for this event's answer, or null; a returned one counts as handed. */
  answer(p: AgentBriefEvent, record: Pick<AwayRecord, 'state' | 'revision' | 'since' | 'endedAt'>): AwayNoticeAnswer | null {
    const start = AGENT_BRIEF_HANDOVER[p.agent]?.event === p.event && p.source !== null
    const tool = AWAY_NOTICE_HANDOVER[p.agent]?.event === p.event
    if (!start && !tool) return null
    if (p.turn === undefined || p.turn.nested || p.incarnationId === null) return null
    if (this.options.liveIncarnationId(p.sessionId) !== p.incarnationId) return null
    const key = AwayNotices.key(p.sessionId, p.agent, p.turn.conversation)
    const known = this.told.get(key)
    if (record.state === 'none' || (known !== undefined && known.revision > record.revision)) return null
    const lost = start && LOST_SOURCES.includes(p.source ?? '')
    // One claim at a time per conversation: while one is on its way in this process, a later state waits for its report,
    // so a hook still delivering an older revision can never print after a newer one (76.4 AC2).
    const settling = known?.status === 'claimed' && known.incarnationId === p.incarnationId && known.claimedAt !== undefined &&
      this.options.now().getTime() - Date.parse(known.claimedAt) < AWAY_CLAIM_SETTLE_MS
    if (settling && !lost) return null
    // A claim never reported printed, by another process or past its settle time, may or may not have reached the agent:
    // it is reconciled by handing the current state again (76.4 AC2), also after a restart and in a resumed process.
    const uncertain = known?.status === 'claimed'
    const due = record.state === 'away'
      ? known === undefined || known.revision !== record.revision || known.state !== 'away' || lost || uncertain
      : known !== undefined && (known.state === 'away' || lost || uncertain) && (known.revision !== record.revision || lost || uncertain)
    if (!due) return null
    const text = awayNotice(record, this.options.now())
    if (text === null) return null
    this.remember(key, { revision: record.revision, state: record.state, status: 'claimed', incarnationId: p.incarnationId, claimedAt: this.options.now().toISOString() })
    return { text, revision: record.revision }
  }

  /** The hook printed it: still never read. */
  printed(sessionId: string, agent: string, conversation: string, revision: number): boolean {
    const key = AwayNotices.key(sessionId, agent, conversation)
    const known = this.told.get(key)
    if (known === undefined || known.revision !== revision || known.status === 'printed') return false
    this.remember(key, { ...known, status: 'printed' })
    return true
  }

  /** What one conversation was handed last, for tests and the summary. */
  toldTo(sessionId: string, agent: string, conversation: string): AwayTold | undefined {
    return this.told.get(AwayNotices.key(sessionId, agent, conversation))
  }

  private remember(key: string, told: AwayTold): void {
    this.told.delete(key)
    this.told.set(key, told)
    while (this.told.size > AWAY_NOTICES_REMEMBERED) {
      const oldest = this.told.keys().next().value
      if (oldest === undefined) break
      this.told.delete(oldest)
    }
    this.save()
  }

  /** Saves everything held; a failed save is tried again until one succeeds, a newer save taking its place. */
  private save(): void {
    if (this.retry !== null) { clearTimeout(this.retry); this.retry = null }
    void this.options.save([...this.told.entries()]).catch(() => {
      this.retry ??= setTimeout(() => { this.retry = null; this.save() }, SAVE_RETRY_MS)
    })
  }

  static key(sessionId: string, agent: string, conversation: string): string {
    return `${sessionId}\u0000${agent}\u0000${conversation}`
  }
}
