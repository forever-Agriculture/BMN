// MODULE: agent-away-notices.ts - which conversation was handed which away state, and the snapshot an event's answer carries (Story 76.4)
import { randomUUID } from 'node:crypto'
import {
  AGENT_BRIEF_HANDOVER,
  AWAY_NOTICE_HANDOVER,
  awayNotice,
  type AwayRecord
} from '@bmn/protocol'
import type { AgentBriefEvent } from './agent-briefs'

/**
 * Conversations remembered at once. The oldest told back and reported printed is forgotten first: a conversation still told
 * away, or holding a claim not reported printed, may yet be resumed and must be told back (the consultant, finding 1), so it
 * goes only past the hard bound.
 */
export const AWAY_NOTICES_REMEMBERED = 2_000
export const AWAY_NOTICES_HARD_BOUND = 10_000
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
  /** When BMN answered with it. */
  claimedAt?: string
  /** The one claim a printed report must name, so a late report of an older claim never confirms a newer one. */
  claimId?: string
}

export interface AwayNoticeAnswer {
  text: string
  revision: number
  claimId: string
}

/**
 * Story 76.4 AC1–AC2: the current state for the agent typed into a session, in its main conversation, in the answer to the
 * event Story 76.2 measured: the start of a conversation and, while it works, the next tool call after a change. A new
 * conversation is told only while he is away; a conversation once told away is told back, also after a BMN restart, since
 * what was handed is kept on disk; a compaction or a clear hands the current state again to one that was told before. An
 * away that was never handed and is over by now is never handed (away and back coalesce only then). The record is the one
 * the host holds when the answer is made, and a revision older than the one handed is never handed.
 *
 * Order (76.4 AC2, the consultant's method): only a hook holding its conversation's lock (bin/bmn holdAwayLock, taken before
 * it asks and held by its process until it ends) is handed anything, so a claim never reported printed belongs to a hook that
 * has ended and is reconciled by handing the current state again at once. Claims are made one at a time and stored before
 * their text is returned: a claim that cannot be stored hands nothing and the next tool call tries again.
 */
export class AwayNotices {
  private told = new Map<string, AwayTold>()
  private retry: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: {
    liveIncarnationId(sessionId: string): string | null | undefined
    now(): Date
    /** Keeps what was handed: a claim is stored before it is answered; a printed report's failed save is tried again. */
    save(entries: Array<[string, AwayTold]>): Promise<void>
  }) {}

  /** What was kept, read back at start. */
  load(entries: Array<[string, AwayTold]>): void {
    this.told = new Map(entries.slice(-AWAY_NOTICES_HARD_BOUND))
  }

  /**
   * The snapshot for this event's answer, or null; a returned one counts as handed. `locked` says the asking hook holds its
   * conversation's lock; `current` reads the record once this claim's turn comes.
   */
  answer(p: AgentBriefEvent, current: () => Pick<AwayRecord, 'state' | 'revision' | 'since' | 'endedAt'>, locked: boolean): Promise<AwayNoticeAnswer | null> {
    const start = AGENT_BRIEF_HANDOVER[p.agent]?.event === p.event && p.source !== null
    const tool = AWAY_NOTICE_HANDOVER[p.agent]?.event === p.event
    if ((!start && !tool) || !locked) return Promise.resolve(null)
    if (p.turn === undefined || p.turn.nested || p.incarnationId === null) return Promise.resolve(null)
    const incarnationId = p.incarnationId
    const key = AwayNotices.key(p.sessionId, p.agent, p.turn.conversation)
    return this.serial(async () => {
      if (this.options.liveIncarnationId(p.sessionId) !== incarnationId) return null
      const record = current()
      const known = this.told.get(key)
      if (record.state === 'none' || (known !== undefined && known.revision > record.revision)) return null
      const lost = start && LOST_SOURCES.includes(p.source ?? '')
      // A claim never reported printed may or may not have reached the agent; its hook has ended, since this one holds the
      // lock, so the current state is handed again (76.4 AC2), also after a restart and in a resumed process.
      const uncertain = known?.status === 'claimed'
      const due = record.state === 'away'
        ? known === undefined || known.revision !== record.revision || known.state !== 'away' || lost || uncertain
        : known !== undefined && (known.state === 'away' || lost || uncertain) && (known.revision !== record.revision || lost || uncertain)
      if (!due) return null
      const now = this.options.now()
      const text = awayNotice(record, now)
      if (text === null) return null
      const claim: AwayTold = { revision: record.revision, state: record.state, status: 'claimed', incarnationId, claimedAt: now.toISOString(), claimId: randomUUID() }
      const next = this.with(key, claim)
      try { await this.options.save([...next.entries()]) } catch { return null }
      this.told = next
      return { text, revision: record.revision, claimId: claim.claimId! }
    })
  }

  /** The hook printed the claim it names: still never read. A report of another claim confirms nothing. */
  printed(sessionId: string, agent: string, conversation: string, claimId: string): Promise<boolean> {
    const key = AwayNotices.key(sessionId, agent, conversation)
    return this.serial(async () => {
      const known = this.told.get(key)
      if (known === undefined || known.claimId !== claimId || known.status === 'printed') return false
      this.told = this.with(key, { ...known, status: 'printed' })
      this.save()
      return true
    })
  }

  /** What one conversation was handed last, for tests and the summary. */
  toldTo(sessionId: string, agent: string, conversation: string): AwayTold | undefined {
    return this.told.get(AwayNotices.key(sessionId, agent, conversation))
  }

  /** Claims and reports one after another, each against what the one before left. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The map with this conversation's entry last, trimmed: settled back first, anything else only past the hard bound. */
  private with(key: string, told: AwayTold): Map<string, AwayTold> {
    const next = new Map(this.told)
    next.delete(key)
    next.set(key, told)
    for (const [candidate, entry] of next) {
      if (next.size <= AWAY_NOTICES_REMEMBERED) break
      if (candidate !== key && entry.state === 'back' && entry.status === 'printed') next.delete(candidate)
    }
    while (next.size > AWAY_NOTICES_HARD_BOUND) {
      const oldest = next.keys().next().value
      if (oldest === undefined) break
      next.delete(oldest)
    }
    return next
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
