/** Parsed owner-only snapshots; raw handoff and board text never cross IPC. */
export interface DevAutoRun {
  workspaceIds: string[]
  checkout: string
  branch: string | null
  project: string | null
  status: string | null
  nextAction: string | null
  decisions: string[]
  /** The handoff's `- Run id:` field, written once when the run starts and kept across leads; null for a legacy handoff. */
  runId: string | null
  /**
   * Per decision, in the order of `decisions`: its entry id (`[d3]`, given once and never renumbered) and the BMN record the
   * lead kept with it (`(bmn: SESSION/KEY)`, the session and key BMN returned). All null for a legacy entry, matched by nothing
   * but its text; a session null with a key is an entry that kept only the key, which proves no record.
   */
  decisionEntries: Array<{ entry: string | null; bmnKey: string | null; bmnSession: string | null }>
  omittedDecisions: number
  /** Outbound reader reports fields clipped after masking; local view remains unchanged. */
  truncatedFields?: number
  finished: boolean
  /** When the handoff file last changed (its mtime), so a summary can tell a run of this period from an older one; null when unknown. */
  updatedAt?: string | null
  ownership: 'own' | 'unknown' | 'copy'
  ownerCheckout: string | null
  ownerBranch: string | null
  unavailable: string | null
  board: { checkout: string | null; rows: Array<{ key: string; status: string; comment: string }>; unavailable: string | null }
  ownerItems: Array<{ sessionId: string; requestId: string; title: string }>
  /** Story 110.9: the handoff's `- Waiting on:`; null when it names nobody or has no such line (an older handoff). */
  waitingOn?: string | null
  /** Story 110.9: the handoff's `- Finished stories` lines that read cleanly, in their order; at most 100 lines are read. */
  finishedStories?: DevAutoFinishedStory[]
  /** Story 110.9: lines under `- Finished stories` that did not read as `N.M STARTED FINISHED` with FINISHED after STARTED. */
  skippedFinishedStories?: number
  /** Story 110.9, D14: the conversation ids the handoff's `Lead sessions` and `Lead host` fields name, in their order. */
  leadConversations?: string[]
  /**
   * Story 110.9, D14: the BMN session this run belongs to: the live (or last) one whose agent conversation the handoff names,
   * else the one live session launched in this checkout; null when neither says.
   */
  sessionId?: string | null
  sessionLink?: 'conversation' | 'checkout' | null
}

/** One finished story of a run, as the handoff stamps it (UTC ISO-8601). */
export interface DevAutoFinishedStory {
  story: string
  startedAt: string
  finishedAt: string
}

export interface DevAutoRunsResult {
  runs: DevAutoRun[]
  skipped: number
  issues: string[]
  observedAt: string
}

export function isDevAutoRunsParams(value: unknown): value is { workspaceId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'workspaceId' &&
    typeof (value as { workspaceId: unknown }).workspaceId === 'string' &&
    (value as { workspaceId: string }).workspaceId.length > 0)
}
