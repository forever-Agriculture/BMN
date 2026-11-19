// MODULE: epic-actions.ts - the exact action terms and owner view for an epic's allowance
interface PlanActionBase {
  id: string
  repository: string
  count: number
}

export type PlanAction = PlanActionBase & (
  { kind: 'merge'; pr: number; headSha: string | null; whenGreen: boolean; changesCI: boolean } |
  { kind: 'push-default'; branch: string } |
  { kind: 'pr-elsewhere'; branch: string | null; pr: number | null } |
  { kind: 'command'; command: string; folder: string; ref: string; script: { path: string; sha256: string } | null }
)

export interface EpicPlanContext {
  planKey: string
  project: string
  epic: number
  actions: PlanAction[]
  actionsHash: string
  approval: string
  go: string | null
  previousGo: string | null
  precedingGo: string | null
  activeApproval: string | null
  /** The approval text and the action list the latest go was recorded on, and whether that go was withdrawn. */
  goApproval: string | null
  goActionsHash: string | null
  withdrawn: boolean
}

export interface EpicRunBinding {
  id: string
  sessionId: string
  incarnationId: string
  agent: 'claude' | 'codex'
  conversation: string
  foreground: string
  generation: string
  go: string
  at: string
}

export interface EpicActionCard {
  id: string
  epic: number
  project: string
  requestedAt: string
  revision: number
  /** `rule` is the repository's deploy rule as Health holds it now; `held` says why Yes cannot be taken (132 D3). */
  actions: { id: string; words: string; rule?: string; held?: string }[]
  /** `rule` is the deploy rule he saw when he said Yes; a Yes under another rule no longer counts. */
  answers: Record<string, { choice: 'yes' | 'no'; at: string; via: 'app' | 'telegram'; rule?: string }>
  binding: { id: string; sessionId: string; go: string; at: string } | null
}

export interface EpicActionAnswer {
  card: string
  action: string
  choice: 'yes' | 'no'
  revision: number
}

export interface EpicActionAudit {
  epic: number
  action: string
  sessionId: string
  go: string
  at: string
  commandHash: string
  source: 'file' | 'night'
  receipt?: string
  bindingId?: string
  /** The native tool call, or `policy:<use id>`, this row was decided for: one decision per call, whichever source paid. */
  call?: string
  /** `withheld`: the use was taken, then BMN's last check before permission failed, so nothing was let through. */
  outcome?: 'reserved' | 'unreported' | 'returned' | 'failed' | 'withheld'
}
