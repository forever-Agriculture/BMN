/** Parsed owner-only snapshots; raw handoff and board text never cross IPC. */
export interface DevAutoRun {
  workspaceIds: string[]
  checkout: string
  branch: string | null
  project: string | null
  status: string | null
  nextAction: string | null
  decisions: string[]
  omittedDecisions: number
  /** Outbound reader reports fields clipped after masking; local view remains unchanged. */
  truncatedFields?: number
  finished: boolean
  ownership: 'own' | 'unknown' | 'copy'
  ownerCheckout: string | null
  ownerBranch: string | null
  unavailable: string | null
  board: { checkout: string | null; rows: Array<{ key: string; status: string; comment: string }>; unavailable: string | null }
  ownerItems: Array<{ sessionId: string; requestId: string; title: string }>
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
