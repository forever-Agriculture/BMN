// MODULE: agents-roster.ts - Epic 60 shapes the Preferences Team and Rules pages exchange with the main process
export const ROSTER_HARNESSES = ['claude', 'codex', 'opencode', 'cursor'] as const
export type RosterHarness = (typeof ROSTER_HARNESSES)[number]
/** How each agent app is named to the owner. */
export const ROSTER_APP_NAMES: Readonly<Record<RosterHarness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' }
/** What each app's own updater is started with. BMN shows the command; the updater itself decides what it does. */
export const ROSTER_APP_UPDATE_ARGUMENTS: Readonly<Record<RosterHarness, readonly string[]>> = { claude: ['update'], codex: ['update'], opencode: ['upgrade'], cursor: ['update'] }
export const ROSTER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type RosterEffort = (typeof ROSTER_EFFORTS)[number]
export const ROSTER_THEN = ['lead', 'skip', 'blocked', 'owner-chooses'] as const
export type RosterThen = (typeof ROSTER_THEN)[number]
/** The chess classes, in the order the owner chooses among them. */
export const ROSTER_CLASSES = ['knight', 'queen', 'rook', 'bishop', 'pawn'] as const
export type RosterClass = (typeof ROSTER_CLASSES)[number]
/** The role only a knight or a queen may hold, and the one only a rook or a queen may hold. */
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
  /** Skills that carry a mark, in name order; absent when no skill has one. */
  skills?: RosterSkillShape[]
  /** The folder the skills come from, when it is not the default. */
  skills_source?: string
  /** The owner's MCP tools, in id order; absent when there are none. */
  tools?: RosterToolShape[]
}

/** One MCP tool: a program with arguments or an address, the environment variables it names (never a value), and who gets it. */
export interface RosterToolShape {
  id: string
  name: string
  command?: string
  args?: (string | { env: string })[]
  url?: string
  /** An entry the program receives, mapped to the environment variable it comes from. */
  env?: Record<string, string>
  /** A request header, mapped to the environment variable it comes from. */
  headers?: Record<string, string>
  /** Whether an app that gets public work only may have it. */
  public?: true
  /** Kept to these apps; absent with `agents` absent means every app. */
  apps?: RosterHarness[]
  /** Kept to the runs of these agents: then no app's settings hold it. */
  agents?: string[]
}

/** One skill's marks: `public` lets an app on a public-only route have it, `only` keeps it to some apps. */
export interface RosterSkillShape { id: string; public?: true; only?: RosterHarness[] }

export interface RosterIssueShape { code: string; line?: number; message: string }

export interface RosterDiffShape {
  scope: 'agent' | 'roles' | 'providers' | 'exceptions' | 'harness-routes' | 'skills' | 'tools'
  id: string
  field: string | null
  kind: 'added' | 'removed' | 'changed'
  free_text?: boolean
  before?: { present: boolean; value?: unknown; hash?: string }
  after?: { present: boolean; value?: unknown; hash?: string }
}

/** What the page showed; an approval or save carries it back and is refused when either moved. */
export interface AgentsShownRevision { generation: number | null; fileHash: string; link?: string | null; directory?: string | null }

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
  /** Set for a version that was written and never put into effect: BMN stopped before the approval finished. */
  unfinished?: boolean
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
    /** The real folder holding the team file when read: every link on the way to it followed. */
    directory: string | null
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
  /** For a restore: the team that would take effect, which is not the one in the team file. */
  restored?: RosterDataShape
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

/** One agent app as Rules › Health shows it: its version and where it sends data as inspected. */
export interface AgentAppView {
  harness: RosterHarness
  version: string | null
  /** The program PATH selects for this app, past BMN's own commands; null when none is found. */
  program: string | null
  /** Where that entry leads when it is a link. */
  programTarget?: string
  /** `default` (its provider's own servers), `explicit` (a custom host) or `unknown`. */
  basis: string
  provider: string | null
  host: string | null
  sources: string[]
  /**
   * `tested`, `newer` (later than every version BMN tested), `other` (any other installed version)
   * or `unknown` (no version read, or an app BMN does not check). Every installed version is supported.
   */
  versionState: 'tested' | 'newer' | 'other' | 'unknown'
  /** What that state means, in words. */
  versionNote: string
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

/** The apps BMN has a context-limit setting for. */
export const CONTEXT_LIMIT_APPS = ['codex', 'claude'] as const
export type ContextLimitApp = (typeof CONTEXT_LIMIT_APPS)[number]

/**
 * An agent's own context limit and what becomes of it in a run BMN checks: `applied`, `not-applied`
 * (no test of the installed version passed, so the run gets the app's own size) or `refused` (the
 * check stops the run), each but the first with the check's reason.
 */
export interface ContextAgentLimit { agent: string; limit: number; state: 'applied' | 'not-applied' | 'refused'; reason?: string }

/** One app's default context limit for the owner's own sessions, as Rules › Health shows it (60.9 AC3). */
export interface ContextLimitView {
  harness: ContextLimitApp
  /** The app's own settings file that holds the default. */
  path: string
  resolvedPath?: string
  linkTarget?: string
  exists: boolean
  limit: number | null
  /** Where the app starts summarising, when its file names that. */
  compact: number | null
  /** Why the file's value cannot be read, in words. */
  unreadable?: string
  version: string | null
  /** Whether the owner's test showed, on the installed version, that the app takes the setting. Until then BMN writes and requires nothing. */
  limitProven: boolean
  compactProven: boolean
  /** The sizes the app takes, where it says. */
  min?: number
  max?: number
  /** The last test of this app, whatever version it ran against; `by` is set where BMN ran it by itself (63.1). */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; by?: 'bmn' } | null
  /** Each approved, enabled agent on this app that has a limit of its own, and how that limit fares for a run started now (63.1 AC4). */
  limits: ContextAgentLimit[]
  /** The approved, enabled agents that run on this app: they share this one file. */
  agents: string[]
}

/** One skill's state in one app (60.11 AC2); `excluded` is a skill the app is not meant to have and does not have. */
export type SkillStateName = 'unreadable' | 'missing' | 'link' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'read-directly' | 'exposed' | 'excluded'

/** One app's skills, as Rules › Health shows them (60.11 AC5). */
export interface SkillsAppView {
  harness: RosterHarness
  version: string | null
  /** Whether the owner's test showed, on the installed version, where this app reads skills. Until then nothing is written for it. */
  supported: boolean
  /** Why skills are not supported yet in this app. */
  reason?: string
  /** Whether BMN can ask this app which skills it sees. */
  testable: boolean
  /** The folder BMN installs into, or null when the app reads the skills folder itself. */
  location: string | null
  format: 'link' | 'copy' | null
  readsSource: boolean
  /** Every skill the app may have, or only the public ones. */
  kind: RulesRenderingKind
  kindReason: string
  /** Linked, Copied, Reads the source, Differs, Missing, Not supported yet or Exposed. */
  state: string
  /** The last test of where the app reads skills, whatever version it ran against. */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string } | null
  /** Whether BMN can tell, in a run of this app, the app handing a skill to its model from the model reading the file itself. */
  loadTestable: boolean
  /** The last listing test (no prompt): the app lists a skill placed where its skills live. Stale when the app, its destination or a skill changed since. */
  listing: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; stale: boolean } | null
  /** The last loading test (one prompt): the app hands a skill's text to its model. Never filled from a listing. Stale the same way. */
  loading: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; stale: boolean } | null
}

/** One skill of the skills folder, as Rules › Skills shows it. */
export interface SkillView {
  name: string
  /** The first line of its description. */
  description: string
  readable: boolean
  detail?: string
  /** Its state in each app whose skills are supported. */
  states: Partial<Record<RosterHarness, SkillStateName>>
}

export interface SkillsView {
  source: { path: string; readable: boolean; detail?: string }
  skills: SkillView[]
  /** Skills the approved team marks that the folder does not hold. */
  markedMissing: string[]
  apps: SkillsAppView[]
  /** Entries an install would add, replace or remove. */
  pending: number
  /** Skills an app can see but may not have; no install hides them. */
  exposed: number
}

export interface SkillsPlanTarget extends RulesPlanTarget { skill: string }
/** What a skills install would do, before it does it (R60-NFR2), and what stays exposed whatever is installed. */
export interface SkillsPlan { ok: boolean; code: string; message?: string; planHash: string | null; targets: SkillsPlanTarget[]; exposed: { harness: RosterHarness; skill: string; fix: string }[] }

/** One tool's state in one app (60.12 AC4); `excluded` is a tool the app is not meant to have and does not have, `blocked` one it cannot take as it is. */
export type ToolStateName = 'unreadable' | 'missing' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'exposed' | 'excluded' | 'blocked'

/** One app's tools, as Rules › Health shows them (60.12 AC6). */
export interface ToolsAppView {
  harness: RosterHarness
  version: string | null
  /** Whether the owner's test showed, on the installed version, that this app reads tools from the file BMN would change. Until then nothing is written for it. */
  supported: boolean
  /** Why tools are not supported yet in this app. */
  reason?: string
  /** The app's own settings file that holds its tools. */
  path: string
  readable: boolean
  /** Why the file cannot be read, in words. */
  detail?: string
  /** The settings file is a link to this: BMN reads through it and never writes there. */
  link?: string
  /** Every tool the app may have, or only the public ones. */
  kind: RulesRenderingKind
  kindReason: string
  /** Set up, Missing, Differs, Exposed, None or Not supported yet. */
  state: string
  /** Whether the app was seen passing a named environment variable to a tool. */
  variable: boolean
  /** Whether a run was seen with only the tools its own command names. */
  isolation: boolean
  /** The last test of where the app reads tools, whatever version it ran against. */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string } | null
  /** Entries the app holds that are not on the owner's list; `managed` ones BMN wrote for a tool that left the list. */
  unlisted: { id: string; state: 'unmanaged' | 'exposed'; managed: boolean }[]
}

/** One approved tool, as Rules › Tools shows its state. */
export interface ToolView {
  id: string
  /** Its state in each app whose tools are supported. */
  states: Partial<Record<RosterHarness, ToolStateName>>
  /** Why an app cannot take it, or why its entry there is left alone, where there is something to say. */
  details: Partial<Record<RosterHarness, string>>
}

export interface ToolsView {
  tools: ToolView[]
  apps: ToolsAppView[]
  /** Entries an install would add, replace or remove. */
  pending: number
  /** Tools an app holds but may not have, which no install removes. */
  exposed: number
  /** Tools an app cannot take as they are, and entries that hold a value inline. */
  blocked: number
  /** Why the tools could not be checked at all, in words. */
  error?: string
}

/** One entry an install would set or remove, with what the file holds there now (values masked) and what it would hold. */
export interface ToolsPlanTarget { harness: RosterHarness; tool: string; path: string; action: 'set' | 'remove'; words: string; before: string | null; after: string | null }
/** What a tools install would do, before it does it (R60-NFR2), and what stays exposed or blocked whatever is installed. */
export interface ToolsPlan {
  ok: boolean
  code: string
  message?: string
  planHash: string | null
  /** Whether this plan also removes entries that are not on the list. */
  removeUnlisted: boolean
  targets: ToolsPlanTarget[]
  exposed: { harness: RosterHarness; tool: string; fix: string }[]
  blocked: { harness: RosterHarness; tool: string; fix: string }[]
}

/** An entry the apps already hold, proposed as a tool (60.12 AC3). A value an entry held is never part of it. */
export interface ToolProposalView {
  id: string
  /** `ready`; `secret` (ready, with a value left out); `known` (already on the list); `conflict` (the apps differ) or `unreadable`. */
  state: 'ready' | 'secret' | 'known' | 'conflict' | 'unreadable'
  apps: RosterHarness[]
  tool?: RosterToolShape
  notes: string[]
}

/** Whether BMN's own read of the cited page shows a researched value beside the model, and which source list the page is on (1 provider pages, 2 other sites). */
export interface ResearchChecked { rank: 1 | 2; verified: boolean; why?: string }
export interface ResearchPrice extends ResearchChecked { input: number; output: number; cached_input?: number; source: string; as_of: string }
export interface ResearchWindow extends ResearchChecked { tokens: number; source: string; as_of: string }
/** One model as research found it (Story 60.10). `fresh`: the last research of the team saw it for the first time. */
export interface ResearchModelView {
  id: string
  provider: string
  providerId: string
  publishedName?: string
  price: ResearchPrice | null
  contextWindow: ResearchWindow | null
  firstSeen: string
  lastSeen: string
  fresh: boolean
  foundLast: boolean
}
export type ResearchRunState = 'complete' | 'partial' | 'stopped' | 'failed'
/** An active agent and whether it could research now; `why` says why not in a few words, `reason` in the check's own. */
export interface ResearcherView { id: string; name: string; harness: RosterHarness; ok: boolean; why?: string; reason?: string }
/** Team › Models: what research has found, who may research, and the run that is going. */
export interface ResearchSnapshot {
  last: { at: string; researcher: string; state: ResearchRunState; models: number; note?: string } | null
  previousAt: string | null
  models: ResearchModelView[]
  researchers: ResearcherView[]
  /** The researcher the owner last picked, when it may still research. */
  researcher: string | null
  running: { researcher: string; done: number; total: number; lookup: boolean } | null
  /** How the last run started from this window ended, in words; `kept` when it found something, which the page then shows. Null when none has. */
  ended: { ok: boolean; text: string; kept: boolean } | null
}
/** What Look up found for one model name. */
export interface ResearchLookup { ok: boolean; message: string; model: ResearchModelView | null }

/** What changing a default would write, before it is written (R60-NFR2). */
export interface ContextLimitPlan {
  ok: boolean
  code: string
  message?: string
  path?: string
  resolvedPath?: string
  linkTarget?: string
  diff: string
  planHash: string | null
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
  /** Each app's default context limit, and whether its setting is proven on the installed version. */
  context: ContextLimitView[]
  /** Whether BMN tests a new app version's context setting by itself, and the app it is testing right now (63.1). */
  contextAuto: { enabled: boolean; running: ContextLimitApp | null }
  /** The skills folder, each skill's state in each app, and where each app reads skills. */
  skills: SkillsView
  /** Each approved tool's state in each app, and where each app keeps its tools. */
  tools: ToolsView
  /**
   * Set when BMN could not ask the owner's shell for its settings and inspected with its own
   * environment instead: why, in words. A session may then find other programs than BMN does.
   */
  ownEnvironment?: string
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
  /** Install: the target's state before (`link`, `missing`, `unmanaged`, `edited-outside`, `stale`); restore: what it becomes (`link`, `file`, `folder`, `entry`, `missing`). */
  change: string
  diff: string
  /** Said in place of a diff, where the entry is a folder or a link whose lines BMN never shows. */
  note?: string
  /** The one entry of the file that changes, where an undo puts back entries and not the whole file (a tool). */
  entry?: string
  rendering?: RulesRenderingKind
  linkTarget?: string
  fold?: string[]
}

/** A master edit before saving: whether it renders, its diff, the hash a save must still find, and each app's rendering of it. */
export interface RulesMasterPlan {
  valid: boolean
  errors: RosterIssueShape[]
  diff: string
  expectedHash: string | null
  expectedLink: string | null
  /** The real folder holding the master when the diff was made; a save refuses once a link on the way leads elsewhere. */
  expectedDirectory: string
  renderings: RulesRenderingView[]
}

export interface RulesRevertPlan { ok: boolean; diff: string; expectedHash: string | null; expectedLink?: string | null; expectedDirectory?: string; text?: string; message?: string }

export interface RulesPlan { ok: boolean; code: string; message?: string; planHash: string | null; targets: RulesPlanTarget[] }

export type RulesOutcome = { ok: true; message: string; snapshot: RulesSnapshot } | { ok: false; code: string; message: string; snapshot: RulesSnapshot }
