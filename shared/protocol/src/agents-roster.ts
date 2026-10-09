// MODULE: agents-roster.ts - Epic 60 shapes the Preferences Agents and Rules sections exchange with the main process
export const ROSTER_HARNESSES = ['claude', 'codex', 'opencode', 'cursor'] as const
export type RosterHarness = (typeof ROSTER_HARNESSES)[number]
export const ROSTER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type RosterEffort = (typeof ROSTER_EFFORTS)[number]
export const ROSTER_THEN = ['lead', 'skip', 'blocked', 'owner-chooses'] as const
export const ROSTER_AUTHORITIES = ['lead', 'write', 'review', 'read'] as const

export interface RosterAgentShape {
  id: string
  name: string
  title: 'knight' | 'squire'
  harness: RosterHarness
  model: string
  provider: string
  host: string | null
  security: 'high' | 'low'
  trust: 1 | 2 | 3
  authority: (typeof ROSTER_AUTHORITIES)[number]
  enabled: boolean
  status: 'active' | 'proposed'
  efforts: RosterEffort[]
  roles: string[]
  aliases?: string[]
  enabled_note?: string
  cost?: 'low' | 'medium' | 'high'
  quota?: string
  tags?: string[]
  context_window?: number
  max_context_tokens?: number
}

export interface RosterRoleShape {
  id: string
  candidates: string[]
  then: (typeof ROSTER_THEN)[number]
  recheck?: Record<string, boolean | string>
  small_epic?: string
}

export interface RosterRouteShape {
  harness: RosterHarness
  provider: string
  security: 'high' | 'low'
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}

export interface RosterDataShape {
  schema_version: 1
  agents: RosterAgentShape[]
  roles: RosterRoleShape[]
  data_labels: { default: 'public' | 'private'; paths: { path: string; label: 'public' | 'private' }[] }
  harness_routes: RosterRouteShape[]
}

export interface RosterIssueShape { code: string; line?: number; message: string }

export interface RosterDiffShape {
  scope: 'agent' | 'roles' | 'data-labels' | 'harness-routes'
  id: string
  field: string | null
  kind: 'added' | 'removed' | 'changed'
  free_text?: boolean
  before?: { present: boolean; value?: unknown; hash?: string }
  after?: { present: boolean; value?: unknown; hash?: string }
}

/** What the panel showed; an approval or save carries it back and is refused when either moved. */
export interface AgentsShownRevision { generation: number | null; fileHash: string }

export interface AgentsGenerationSummary {
  number: number
  valid: boolean
  created_at?: string
  parent?: number | null
  kind?: 'approval' | 'restore'
  restored_from?: number
  agents?: number
}

export interface AgentsSnapshot {
  rosterPath: string
  file: {
    exists: boolean
    hash: string | null
    errors: RosterIssueShape[]
    warnings: RosterIssueShape[]
    data: RosterDataShape | null
    /** Each agent's free prose, the owner's opinion; shown only in this panel. */
    prose: Record<string, string>
  }
  approved: { generation: number; createdAt: string; data: RosterDataShape } | null
  approvalProblem: { code: string; message: string; lastGood: number | null } | null
  differences: RosterDiffShape[] | null
  consequences: string[]
  history: AgentsGenerationSummary[]
}

export interface AgentsPreview {
  valid: boolean
  errors: RosterIssueShape[]
  differences: RosterDiffShape[]
  consequences: string[]
}

export type AgentsOutcome =
  | { ok: true; snapshot: AgentsSnapshot; message: string }
  | { ok: false; code: string; message: string; errors?: RosterIssueShape[]; snapshot: AgentsSnapshot }

export interface WorkspaceLabelView { path: string; label: 'public' | 'private'; source: 'explicit' | 'inherited' | 'default' }

export interface RouteInspectionView {
  harness: RosterHarness
  basis: string
  provider: string | null
  host: string | null
  sources: string[]
  version: string | null
  versionTested: boolean
  reason?: string
}

export const RULES_TARGET_STATES = ['unreadable', 'missing', 'link', 'unmanaged', 'edited-outside', 'stale', 'current'] as const
export type RulesTargetState = (typeof RULES_TARGET_STATES)[number]

export interface RulesTargetHealth {
  harness: RosterHarness
  path: string
  state: RulesTargetState
  restricted: boolean
  reason: string
  linkTarget?: string
}

export interface RulesRenderingView {
  harness: RosterHarness
  text: string
  bytes: number
  restricted: boolean
  reason: string
  teamForm: string
}

export interface RulesProbeView {
  harness: RosterHarness
  outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable' | null
  at?: string
  detail?: string
  version?: string | null
  stale?: boolean
}

export interface RulesSnapshot {
  masterPath: string
  master: { exists: boolean; text: string | null; hash: string | null; bytes: number; errors: RosterIssueShape[] }
  renderings: RulesRenderingView[]
  health: { state: 'checked'; checkedAt: string; ok: boolean; targets: RulesTargetHealth[] } | { state: 'failed'; checkedAt: string; reason: string }
  probes: RulesProbeView[]
  transactions: { id: string; createdAt?: string; state?: string; targets?: RosterHarness[]; valid: boolean }[]
  history: { revision: number; at: string; hash: string; bytes: number; reason: string; intact: boolean }[] | null
}

export interface RulesPlanTarget {
  harness: RosterHarness
  path: string
  /** What happens, in words (install), or what the target becomes (restore). */
  kind: string
  /** Install: the target's state before (`link`, `missing`, `unmanaged`, `edited-outside`, `stale`); restore: what it becomes (`link`, `file`, `missing`). */
  change: string
  diff: string
  restricted?: boolean
  linkTarget?: string
  fold?: string[]
}

/** A master edit before saving: whether it renders, its diff, the hash a save must still find, and each harness's rendering of it. */
export interface RulesMasterPlan { valid: boolean; errors: RosterIssueShape[]; diff: string; expectedHash: string | null; renderings: RulesRenderingView[] }

export interface RulesPlan { ok: boolean; code: string; message?: string; planHash: string | null; targets: RulesPlanTarget[] }

export type RulesOutcome = { ok: true; message: string; snapshot: RulesSnapshot } | { ok: false; code: string; message: string; snapshot: RulesSnapshot }
