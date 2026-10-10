// MODULE: agents-roster.ts - Epic 60 shapes the Preferences Team and Rules pages exchange with the main process
export const ROSTER_HARNESSES = ['claude', 'codex', 'opencode', 'cursor'] as const
export type RosterHarness = (typeof ROSTER_HARNESSES)[number]
/** How each agent app is named to the owner. */
export const ROSTER_APP_NAMES: Readonly<Record<RosterHarness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' }
export const ROSTER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type RosterEffort = (typeof ROSTER_EFFORTS)[number]
export const ROSTER_THEN = ['lead', 'skip', 'blocked', 'owner-chooses'] as const
export type RosterThen = (typeof ROSTER_THEN)[number]
/** The chess classes, in the order the owner chooses among them. */
export const ROSTER_CLASSES = ['knight', 'queen', 'bishop', 'pawn'] as const
export type RosterClass = (typeof ROSTER_CLASSES)[number]
/** The one role only a knight may hold, and the one only a queen may hold. */
export const ROSTER_LEAD_ROLE = 'lead'
export const ROSTER_DESIGNER_ROLE = 'designer'
export type RosterPrivateWork = 'allowed' | 'public_only'

export interface RosterPriceShape { input: number; output: number; cached_input?: number; source?: string; as_of?: string }

export interface RosterAgentShape {
  id: string
  name: string
  class: RosterClass
  harness: RosterHarness
  model: string
  provider: string
  host: string | null
  enabled: boolean
  status: 'active' | 'proposed'
  efforts: RosterEffort[]
  roles: string[]
  aliases?: string[]
  enabled_note?: string
  context_window?: number
  context_limit?: number
  compact_at?: number
  paid_by?: 'per_token' | 'subscription'
  price?: RosterPriceShape
}

export interface RosterRoleShape {
  id: string
  description?: string
  candidates: string[]
  then: RosterThen
  recheck?: Record<string, boolean | string>
  small_work?: string
}

export interface RosterProviderShape { id: string; name: string; hosts: string[]; sites?: string[]; private_work: RosterPrivateWork }

export interface RosterExceptionShape { id: string; provider: string; folder: string }

export interface RosterRouteShape {
  harness: RosterHarness
  provider: string
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}

export interface RosterDataShape {
  schema_version: 2
  agents: RosterAgentShape[]
  roles: RosterRoleShape[]
  providers: RosterProviderShape[]
  exceptions: RosterExceptionShape[]
  harness_routes: RosterRouteShape[]
}

export interface RosterIssueShape { code: string; line?: number; message: string }

export interface RosterDiffShape {
  scope: 'agent' | 'roles' | 'providers' | 'exceptions' | 'harness-routes'
  id: string
  field: string | null
  kind: 'added' | 'removed' | 'changed'
  free_text?: boolean
  before?: { present: boolean; value?: unknown; hash?: string }
  after?: { present: boolean; value?: unknown; hash?: string }
}

/** What the page showed; an approval or save carries it back and is refused when either moved. */
export interface AgentsShownRevision { generation: number | null; fileHash: string; link?: string | null }

export interface AgentsGenerationSummary {
  number: number
  valid: boolean
  created_at?: string
  parent?: number | null
  kind?: 'approval' | 'restore'
  restored_from?: number
  agents?: number
  /** Set for a version approved under an earlier roster layout: it can be viewed, never restored. */
  earlier_schema?: number
  /** What that approval changed, in one line. */
  summary?: string
}

export interface AgentsSnapshot {
  rosterPath: string
  /** The home directory, for showing files as `~/…` (display only). */
  home: string | null
  file: {
    exists: boolean
    hash: string | null
    /** What the roster path linked to when read, or null. */
    link: string | null
    errors: RosterIssueShape[]
    warnings: RosterIssueShape[]
    data: RosterDataShape | null
    /** Each agent's notes, the owner's own words; shown only on these pages. */
    prose: Record<string, string>
  }
  approved: { generation: number; createdAt: string; data: RosterDataShape } | null
  approvalProblem: { code: string; message: string; lastGood: number | null } | null
  differences: RosterDiffShape[] | null
  consequences: string[]
  history: AgentsGenerationSummary[]
}

/** One rules file an approval would rewrite because the Team phrase in it changes (60.4 AC6). */
export interface TeamUpdateTarget {
  harness: RosterHarness
  path: string
  /** Where the write would really land, when a link on the way to the file leads elsewhere. */
  resolvedPath?: string
  kind: RulesRenderingKind
  diff: string
  binding: string
}

export interface AgentsPreview {
  valid: boolean
  errors: RosterIssueShape[]
  differences: RosterDiffShape[]
  consequences: string[]
  /** The rules files this approval would also update; empty when the Team phrase stays as it is. */
  teamUpdate: TeamUpdateTarget[]
}

/** The rules files shown beside an approving control, by the binding each was shown with; an approval updates no others. */
export type AgentsTeamUpdateShown = Pick<TeamUpdateTarget, 'harness' | 'binding'>[]

/** What an approving control approves: the staged data, the whole file, some of its outside changes, or an earlier version. */
export type AgentsApprovalRequest =
  | { kind: 'staged'; data: RosterDataShape }
  | { kind: 'file' }
  | { kind: 'sections'; scope: string[] }
  | { kind: 'restore'; number: number }

/** What happened to the rules files after an approval that showed them. */
export interface AgentsRulesUpdate { transaction: string | null; written: RosterHarness[]; skipped: RosterHarness[]; failed?: string }

export type AgentsOutcome =
  | { ok: true; snapshot: AgentsSnapshot; message: string; rulesUpdate?: AgentsRulesUpdate }
  | { ok: false; code: string; message: string; errors?: RosterIssueShape[]; snapshot: AgentsSnapshot }

/** One agent app as Rules › Health shows it: its version, where it sends data as inspected, and what the owner may do. */
export interface AgentAppView {
  harness: RosterHarness
  version: string | null
  /** `default` (its provider's own servers), `explicit` (a custom host) or `unknown`. */
  basis: string
  provider: string | null
  host: string | null
  sources: string[]
  /** `tested`, `accepted`, `new` (installed, neither tested nor accepted) or `unknown` (no version read, or an app BMN cannot check). */
  versionState: 'tested' | 'accepted' | 'new' | 'unknown'
  /** True only for a new version that resolves the same destination and sources a tested or accepted one did. */
  acceptable: boolean
  /** That comparison, or why nothing is offered, in words. */
  comparison: string
  reason?: string
}

export type RulesRenderingKind = 'full' | 'public'

export const RULES_TARGET_STATES = ['unreadable', 'missing', 'link', 'unmanaged', 'edited-outside', 'stale', 'current'] as const
export type RulesTargetState = (typeof RULES_TARGET_STATES)[number]

export interface RulesTargetHealth {
  harness: RosterHarness
  path: string
  state: RulesTargetState
  kind: RulesRenderingKind
  reason: string
  linkTarget?: string
}

export interface RulesRenderingView {
  harness: RosterHarness
  text: string
  bytes: number
  kind: RulesRenderingKind
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
  /** The home directory the agents' files resolve under, for showing them as `~/…` (display only). */
  home: string | null
  /** `savedAt` is when the master file was last written, or null when there is none. */
  master: { exists: boolean; text: string | null; hash: string | null; bytes: number; savedAt: string | null; errors: RosterIssueShape[] }
  renderings: RulesRenderingView[]
  health: { state: 'checked'; checkedAt: string; ok: boolean; targets: RulesTargetHealth[] } | { state: 'failed'; checkedAt: string; reason: string }
  probes: RulesProbeView[]
  /** Each agent app's version and destination, inspected when the snapshot was taken. */
  apps: AgentAppView[]
  transactions: { id: string; createdAt?: string; state?: string; reason?: string; targets?: RosterHarness[]; valid: boolean }[]
  history: { revision: number; at: string; hash: string; bytes: number; reason: string; intact: boolean }[] | null
}

export interface RulesPlanTarget {
  harness: RosterHarness
  path: string
  /** Where the write would really land, when a link on the way to the file leads elsewhere. */
  resolvedPath?: string
  /** What happens, in words (install), or what the target becomes (restore). */
  kind: string
  /** Install: the target's state before (`link`, `missing`, `unmanaged`, `edited-outside`, `stale`); restore: what it becomes (`link`, `file`, `missing`). */
  change: string
  diff: string
  rendering?: RulesRenderingKind
  linkTarget?: string
  fold?: string[]
}

/** A master edit before saving: whether it renders, its diff, the hash a save must still find, and each app's rendering of it. */
export interface RulesMasterPlan { valid: boolean; errors: RosterIssueShape[]; diff: string; expectedHash: string | null; expectedLink: string | null; renderings: RulesRenderingView[] }

export interface RulesRevertPlan { ok: boolean; diff: string; expectedHash: string | null; expectedLink?: string | null; text?: string; message?: string }

export interface RulesPlan { ok: boolean; code: string; message?: string; planHash: string | null; targets: RulesPlanTarget[] }

export type RulesOutcome = { ok: true; message: string; snapshot: RulesSnapshot } | { ok: false; code: string; message: string; snapshot: RulesSnapshot }
