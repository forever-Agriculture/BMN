// MODULE: agents-roster.ts - Epic 60 shapes the Preferences Team and Rules pages exchange with the main process
export const ROSTER_HARNESSES = ['claude', 'codex', 'opencode'] as const
export type RosterHarness = (typeof ROSTER_HARNESSES)[number]
/** How each agent app is named to the owner. */
export const ROSTER_APP_NAMES: Readonly<Record<RosterHarness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
/** What each app's own updater is started with. BMN shows the command; the updater itself decides what it does. */
export const ROSTER_APP_UPDATE_ARGUMENTS: Readonly<Record<RosterHarness, readonly string[]>> = { claude: ['update'], codex: ['update'], opencode: ['upgrade'] }
/**
 * Apps BMN retired (Epic 71), named as they always were. An old team file or a stored record may
 * still name one: it is read and shown by this name, and nothing runs on it.
 */
const ROSTER_RETIRED_HARNESSES = ['cursor'] as const
export type RosterRetiredHarness = (typeof ROSTER_RETIRED_HARNESSES)[number]
/** What a team file's app fields and lists may hold: an app BMN serves, or one it retired. */
export type RosterListedApp = RosterHarness | RosterRetiredHarness
export const RETIRED_APP_NAMES: Readonly<Record<RosterRetiredHarness, string>> = { cursor: 'Cursor' }
/** Each retired app's program, so a saved command that starts one is recognised. */
const RETIRED_APP_PROGRAMS: Readonly<Record<string, RosterRetiredHarness>> = { 'cursor-agent': 'cursor' }
/** The one sentence a screen gives where an old record names a retired app (71.1 design notes). */
export const RETIRED_APP_LINE = 'Cursor was retired on 14 Oct 2026.'

/** Whether a value names an app BMN retired. */
export function isRetiredApp(value: unknown): value is RosterRetiredHarness {
  return typeof value === 'string' && (ROSTER_RETIRED_HARNESSES as readonly string[]).includes(value)
}

/** How an app is named to the owner, a retired one included; anything else is shown as written. */
export function appDisplayName(value: string): string {
  if ((ROSTER_HARNESSES as readonly string[]).includes(value)) return ROSTER_APP_NAMES[value as RosterHarness]
  return isRetiredApp(value) ? RETIRED_APP_NAMES[value] : value
}

/** The retired app a command's program (a name or a path) starts, or null. */
export function retiredAppProgram(program: string): RosterRetiredHarness | null {
  const name = program.slice(program.lastIndexOf('/') + 1)
  return Object.hasOwn(RETIRED_APP_PROGRAMS, name) ? RETIRED_APP_PROGRAMS[name]! : null
}

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
/** What an agent BMN itself calls has in place of an app, and the one role only such an agent holds (Epic 65). */
export const ROSTER_CALLED_BY_BMN = 'bmn'
export const ROSTER_JUDGE_ROLE = 'judge'
/** The team file's layout now, and the one before it, which BMN still reads. */
export const ROSTER_SCHEMA_VERSION = 3
type RosterSchemaVersion = 2 | 3
export type RosterPrivateWork = 'allowed' | 'public_only'

export interface RosterPriceShape { input: number; output: number; cached_input?: number; source?: string; as_of?: string }

export interface RosterAgentShape {
  id: string
  name: string
  class: RosterClass
  /** The app the agent runs in, or `bmn` for an agent BMN itself calls. */
  harness: RosterListedApp | typeof ROSTER_CALLED_BY_BMN
  model: string
  /** Who receives the request. */
  provider: string
  /** Who runs the model, for an agent BMN itself calls; no other agent names it. */
  run_by?: string
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
  /** The team names this agent a researcher (63.3). */
  researcher?: boolean
}

/** The app an agent runs in, or null for an agent BMN itself calls. */
export function rosterApp(agent: Pick<RosterAgentShape, 'harness'>): RosterListedApp | null {
  return agent.harness === ROSTER_CALLED_BY_BMN ? null : agent.harness
}

export interface RosterRoleShape {
  id: string
  description?: string
  candidates: string[]
  then: RosterThen
  recheck?: Record<string, boolean | string>
  small_work?: string
  /** A run for this role must not be able to write (63.2); absent or false for a role that may. */
  read_only?: boolean
}

export interface RosterProviderShape { id: string; name: string; hosts: string[]; sites?: string[]; private_work: RosterPrivateWork }

interface RosterExceptionShape { id: string; provider: string; folder: string }

/** The owner's teammate for one role in one project (73.2): the project's real folder, the role, the agent, an optional effort and end date. */
interface RosterProjectChoiceShape { id: string; project: string; role: string; agent: string; effort?: RosterEffort; ends?: string }

/**
 * BMN's first OpenCode agent (70.4; the owner's card "Luna via Go", 2026-10-14): Luna's model through
 * his OpenCode Go plan, a read-only helper and a researcher. OpenCode Go joins the team as a new
 * provider does, getting public work only until he allows it. Her efforts are those his Codex Luna holds.
 */
export const LUNA_GO_PROPOSAL = {
  provider: { id: 'opencode-go', name: 'OpenCode Go', private_work: 'public_only' },
  agent: { id: 'luna-go', name: 'Luna (Go)', class: 'pawn', harness: 'opencode', model: 'gpt-6-luna', host: 'default', enabled: true, status: 'active', efforts: ['xhigh', 'max'] },
  role: 'helper'
} as const satisfies { provider: Omit<RosterProviderShape, 'hosts'>; agent: Omit<RosterAgentShape, 'provider' | 'roles' | 'efforts'> & { efforts: readonly RosterEffort[] }; role: string }

export interface RosterRouteShape {
  harness: RosterListedApp
  provider: string
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}

export interface RosterDataShape {
  schema_version: RosterSchemaVersion
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
  /** The owner's project choices (73.2); absent when there are none. */
  project_choices?: RosterProjectChoiceShape[]
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
  apps?: RosterListedApp[]
  /** Kept to the runs of these agents: then no app's settings hold it. */
  agents?: string[]
}

/** One skill's marks: `public` lets an app on a public-only route have it, `only` keeps it to some apps. */
export interface RosterSkillShape { id: string; public?: true; only?: RosterListedApp[] }

export interface RosterIssueShape { code: string; line?: number; message: string }

export interface RosterDiffShape {
  scope: 'agent' | 'roles' | 'providers' | 'exceptions' | 'harness-routes' | 'skills' | 'tools' | 'project-choices'
  id: string
  field: string | null
  kind: 'added' | 'removed' | 'changed'
  free_text?: boolean
  before?: { present: boolean; value?: unknown; hash?: string }
  after?: { present: boolean; value?: unknown; hash?: string }
}

/** What the page showed; an approval or save carries it back and is refused when either moved. */
export interface AgentsShownRevision { generation: number | null; fileHash: string; link?: string | null; directory?: string | null; setupRevision?: string }

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
  setupTeam?: import('./first-run-setup').SetupTeamProposals | null
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
export type AgentsApprovalRequest = { setupRevision?: string } & (
  | { kind: 'staged'; data: RosterDataShape }
  | { kind: 'file' }
  | { kind: 'sections'; scope: string[] }
  | { kind: 'restore'; number: number })

/**
 * What happened to the rules files after an approval that showed them. `installed` (Story 75.9) says what the
 * skills and tools installs BMN ran after it changed, in words; each is undone under Earlier installs.
 */
export interface AgentsRulesUpdate { transaction: string | null; written: RosterHarness[]; skipped: RosterHarness[]; failed?: string }

/** What became of the OpenCode Go sign-in an approval copied into BMN's OpenCode folder (70.4). */
export interface OpenCodeSignInResult { ok: boolean; copied: boolean; message: string }

/**
 * Luna through OpenCode Go (70.4), as the Team page asks it: whether the installed OpenCode lists her
 * model, and whether BMN's OpenCode folder holds a Go sign-in (null where the approved team names no
 * agent on OpenCode Go, or OpenCode could not be asked). `copy` is what a press of Copy sign-in did.
 */
export interface OpenCodeGoView { listed: boolean; signedIn: boolean | null; reason: string | null; copy?: OpenCodeSignInResult }

export type AgentsOutcome =
  | { ok: true; snapshot: AgentsSnapshot; message: string; rulesUpdate?: AgentsRulesUpdate; openCodeSignIn?: OpenCodeSignInResult; installed?: string[] }
  | { ok: false; code: string; message: string; errors?: RosterIssueShape[]; snapshot: AgentsSnapshot }

/** One agent app as Integrations › Health shows it: its version and where it sends data as inspected. */
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
  /** BMN ran it by itself (Story 75.8). */
  by?: 'bmn'
}

/** The tests BMN runs by itself when they are needed (Story 75.8): the rules loading test, the skills test, the skill loading test, the tools test, the context test and the fence test. */
export const AUTO_TEST_KINDS = ['rules', 'skills', 'skills-loading', 'tools', 'context', 'fence'] as const
export type AutoTestKind = (typeof AUTO_TEST_KINDS)[number]
/** How many times BMN starts one test by itself for one version, rendering, set of skills or sign-in before it stops and waits for Test again. */
export const AUTO_TEST_TRIES = 3

/** The tests BMN runs by itself: the one running now, and the ones it stopped trying on an installed version. */
export interface AutoTestsView {
  running: { kind: AutoTestKind; harness: RosterHarness } | null
  /**
   * Tried AUTO_TEST_TRIES times without a pass or a failure on that version; each waits for the owner's Test again. `at`
   * is when the last try began; `detail` what the last try that answered said.
   */
  stopped: { kind: AutoTestKind; harness: RosterHarness; version: string; tries: number; at: string; detail?: string }[]
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

/** One app's default context limit for the owner's own sessions, as Integrations › Health shows it (60.9 AC3). */
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
  /**
   * The last test of this app in the form BMN applies the setting in now, whatever version it ran against; `asked` the size it
   * asked for, `observed` the size the app reported (null where it reported none); `by` is set where BMN ran it by itself (63.1).
   */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; asked: number; observed: number | null; by?: 'bmn' } | null
  /**
   * Who acts next on the installed version (Story 96.5): `scheduled` BMN's own test is due; `none` no test is coming (it passed,
   * or failed and waits for the owner's Test again); `not-needed` no agent has a limit on this app and its file holds no default.
   */
  autoTest: 'scheduled' | 'none' | 'not-needed'
  /** Each approved, enabled agent on this app that has a limit of its own, and how that limit fares for a run started now (63.1 AC4). */
  limits: ContextAgentLimit[]
  /** The approved, enabled agents that run on this app: they share this one file. */
  agents: string[]
}

/** One skill's state in one app (60.11 AC2); `excluded` is a skill the app is not meant to have and does not have. */
export type SkillStateName = 'unreadable' | 'missing' | 'link' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'read-directly' | 'exposed' | 'excluded'

/** One app's skills, as Integrations › Health shows them (60.11 AC5). */
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
  /** The last test of where the app reads skills, whatever version it ran against; `by: 'bmn'` when BMN ran it by itself. */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; by?: 'bmn' } | null
  /** Whether BMN can tell, in a run of this app, the app handing a skill to its model from the model reading the file itself. */
  loadTestable: boolean
  /** The last listing test (no prompt): the app lists a skill placed where its skills live. Stale when the app, its destination or a skill changed since. */
  listing: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; stale: boolean; by?: 'bmn' } | null
  /** The last loading test (one prompt): the app hands a skill's text to its model. Never filled from a listing. Stale the same way. */
  loading: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; stale: boolean; by?: 'bmn' } | null
}

/** One skill of the skills folder, as Integrations › Skills shows it. */
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
  /** BMN's own skills that are not BMN's entries in the folder (Story 77.4): the owner's entry of that name, one he removed, or one BMN cannot read. */
  ownLeft: Array<{ name: string; state: 'foreign' | 'removed' | 'unavailable'; detail: string }>
  apps: SkillsAppView[]
  /** Entries an install would add, replace or remove. */
  pending: number
  /** Skills an app can see but may not have; no install hides them. */
  exposed: number
}

interface SkillsPlanTarget extends RulesPlanTarget { skill: string }
/** What a skills install would do, before it does it (R60-NFR2), and what stays exposed whatever is installed. */
export interface SkillsPlan { ok: boolean; code: string; message?: string; planHash: string | null; targets: SkillsPlanTarget[]; exposed: { harness: RosterHarness; skill: string; fix: string }[] }

/** One tool's state in one app (60.12 AC4); `excluded` is a tool the app is not meant to have and does not have, `blocked` one it cannot take as it is. */
export type ToolStateName = 'unreadable' | 'missing' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'exposed' | 'excluded' | 'blocked'

/** One app's tools, as Integrations › Health shows them (60.12 AC6). */
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
  /** The last test of where the app reads tools, whatever version it ran against; `by: 'bmn'` when BMN ran it by itself. */
  test: { at: string; version: string | null; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; by?: 'bmn' } | null
  /** Entries the app holds that are not on the owner's list; `managed` ones BMN wrote for a tool that left the list. */
  unlisted: { id: string; state: 'unmanaged' | 'exposed'; managed: boolean }[]
}

/** One approved tool, as Integrations › Tools shows its state. */
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
interface ToolsPlanTarget { harness: RosterHarness; tool: string; path: string; action: 'set' | 'remove'; words: string; before: string | null; after: string | null }
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
interface ResearchChecked { rank: 1 | 2; verified: boolean; why?: string }
export interface ResearchPrice extends ResearchChecked { input: number; output: number; cached_input?: number; source: string; as_of: string }
interface ResearchWindow extends ResearchChecked { tokens: number; source: string; as_of: string }
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
type ResearchRunState = 'complete' | 'partial' | 'stopped' | 'failed'
/** An active agent and whether it could research now; `why` says why not in a few words, `reason` in the check's own. */
export interface ResearcherView { id: string; name: string; harness: RosterHarness; ok: boolean; why?: string; reason?: string
  /** For a Codex researcher: the tools its fence test saw offered, and whether they were compared under the provider's own model list yet. */
  fence?: { tools: string[]; compared: boolean } }
/** Agents › Models: what research has found, who may research, and the run that is going. */
export interface ResearchSnapshot {
  last: { at: string; researcher: string; state: ResearchRunState; models: number; note?: string } | null
  previousAt: string | null
  models: ResearchModelView[]
  researchers: ResearcherView[]
  /** The researcher the owner last picked, when it may still research. */
  researcher: string | null
  /** Who researches, as the approved team says it: `named` is null for a team from before the mark, and `proposed` is who BMN would name then. */
  choice: { named: string[] | null; proposed: string[] }
  /** The name of a researcher the owner had picked that the team no longer names, until he picks again or researches. */
  dropped: string | null
  /** The fence test of the installed Codex and OpenCode, by BMN or the owner's Test again: whether one is going, and how the last one the owner started ended. */
  fenceTest: {
    running: boolean; ended: { ok: boolean; text: string } | null
    /** The last fence test recorded for each app, whoever started it: what its read-only row on Models says (Story 75.8). */
    last: { harness: 'codex' | 'opencode'; verdict: 'pass' | 'fail' | 'inconclusive'; version: string | null; at: string }[]
  }
  /** The tests BMN runs by itself, of which this page shows the fence test's (Story 75.8). */
  autoTests: AutoTestsView
  running: { researcher: string; done: number; total: number; lookup: boolean } | null
  /** How the last run started from this window ended, in words; `kept` when it found something, which the page then shows. Null when none has. */
  ended: { ok: boolean; text: string; kept: boolean } | null
}
/** What Look up found for one model name. */
export interface ResearchLookup { ok: boolean; message: string; model: ResearchModelView | null }

/** Who asked a web question (Epic 64): the owner on Models, a BMN session (with the agent app the command ran under, where there was one), or a shell outside BMN. */
export type WebQuestionAsker = { kind: 'owner' } | { kind: 'shell' } | { kind: 'session'; session: string; app?: string }
/** The three marks BMN sets by reading a claim's page itself; only the first is evidence. */
export const WEB_QUESTION_MARKS = { found: 'passage found on the page', missing: 'page read, passage not found', unreadable: 'page not readable' } as const
export interface WebQuestionClaim { claim: string; source: string; passage: string; mark: string; why?: string }
export type WebQuestionOutcome = 'running' | 'answered' | 'no-answer' | 'failed' | 'stopped' | 'limit' | 'refused' | 'interrupted'
/** One kept web question, as Models lists it. `question` is null for a text refused for what it held: that text is not kept. */
export interface WebQuestionView {
  id: string
  at: string
  by: WebQuestionAsker
  researcher: string | null
  question: string | null
  outcome: WebQuestionOutcome
  note?: string
  answer?: string
  claims?: WebQuestionClaim[]
  notFound?: string[]
  counts?: { found: number; not_found: number; unreadable: number }
  tookMs?: number
}
/** Agents › Models, "Web questions" (64.3): what was asked, what holds the one research lock now, the switch and the day's count. */
export interface WebQuestionsSnapshot {
  /** Newest first, at most the 200 BMN keeps. */
  questions: WebQuestionView[]
  /** The research or question that holds the one research lock now, whoever started it. */
  holder: { kind: 'research' | 'lookup' | 'question'; id?: string; at?: string; researcher?: string; by?: WebQuestionAsker } | null
  agentsMayAsk: boolean
  today: number
  limits: { perDay: number; minutes: number; characters: number; kept: number }
}
/** How an Ask from Models went on: started (the list shows it running), or refused in the command's own words. */
export interface WebQuestionAsked { ok: boolean; message: string | null; snapshot: WebQuestionsSnapshot }

/** Story 73.1: who asked a teammate, as the run recorded it: a BMN session (with its agent app), a shell, or the owner. */
type TeamAskAsker = { kind: 'owner' } | { kind: 'shell' } | { kind: 'session'; session: string; app?: string }
/**
 * Story 72.9: how far a teammate's own app could read, by the mode it ran in: `computer` (any file the owner's user can read),
 * `folder` (its working folder), `text` (only the question and the files' text). A run made before 72.9 says `text`, or `folder` for its copy of the project.
 */
type TeamAskScope = 'computer' | 'folder' | 'text'
/** What a run's teammate could read: the mode its app ran in, in its own words, where it worked, and what went with the question. */
export interface TeamAskReads {
  /** The app's mode (`codex-read-only`, `claude-read-tools`, `opencode-reader`, `opencode-asker`); null for a run made before 72.9. */
  form: string | null
  scope: TeamAskScope
  /** Its reach in a few words ("any file your user can read"); null where it read only the text. */
  reach: string | null
  /** The mode in a sentence, its tools included; null for a run made before 72.9. */
  words: string | null
  /** The folder it worked in; null where it read only the text. */
  folder: string | null
  files: number
  pictures: number
  /** A browser ask (74.3): the asker's app it checked, and whether it could click and type there. */
  browser?: { origin: string; interact: boolean }
}
/** How a run stands: `running` until its outcome, then the contract's outcome word. */
export type TeamAskState = 'running' | 'answered' | 'failed' | 'refused' | 'out-of-time' | 'stopped' | 'not-attributed' | 'interrupted'
/** A run's usage as the app reported it; null for a count or cost it did not report. */
export interface TeamAskUsageView {
  input: number | null; cached: number | null; output: number | null; reasoning: number | null; reportedCost: number | null; billing: string
  /** Every usage record of the run (the teammate's and each sub-agent's) was read; null for a run made before 72.9. */
  complete: boolean | null
  incompleteReason: string | null
  /** How the counts were added up, in the app's terms (72.9 AC5). */
  basis: string | null
}
/** Story 72.9: a sub-agent the teammate started, named in the record, with its own usage or why there is none to add. */
export interface TeamAskSubagentView {
  session: string
  name: string | null
  role: string | null
  /** "Codex sub-agent", "Claude Code sub-agent", "OpenCode sub-agent". */
  kind: string
  model: string | null
  effort: string | null
  /** Its own counts where they are added to the run's; null where they are already in the run's total or could not be read. */
  usage: TeamAskUsageView | null
  /** Where `usage` is null: "counted in the run's total" or why its usage could not be read. */
  usageNote: string | null
  /** Claude Code's own count for the sub-agent, shown and never added. */
  ownTokens: number | null
}
/** A project's state at one end of an ask: its commit and whether its tree was clean. */
export interface TeamAskProjectState { commit: string | null; clean: boolean | null; changed: number | null; reason: string | null }
/** One ask as Agents › Asks lists it, whoever asked. */
export interface TeamAskLine {
  id: string
  /** The question's first line; null where the record holds none. */
  question: string | null
  by: TeamAskAsker
  agent: string | null
  agentName: string | null
  effort: string | null
  role: string | null
  project: string | null
  data: 'public' | 'private'
  reads: TeamAskReads
  askedAt: string | null
  startedAt: string | null
  endedAt: string | null
  timeLimitMinutes: number | null
  state: TeamAskState | string
  reason?: string
  refusalCode?: string
  usage: TeamAskUsageView | null
  /** When BMN removes it: 30 days after it ended. */
  keptUntil: string | null
  /** For a running ask: the main process's clock when the line was read, so elapsed time is the computer's. */
  now?: string
}
/** Agents › Asks: every ask on this computer, newest first, the places in use and how long an answer is kept. */
export interface TeamAsksSnapshot { asks: TeamAskLine[]; places: { used: number; capacity: number }; keptDays: number }
/** One ask opened in place: the whole question, what it read, who answered, and the answer as the teammate's own words. */
export interface TeamAskDetail {
  line: TeamAskLine
  question: string | null
  /** False for a run made before the question had a record of its own: then only its first line is known. */
  questionWhole: boolean
  answer: string | null
  files: Array<{ path: string; bytes: number }>
  pictures: Array<{ label: string; bytes: number; mediaType: string; width: number | null; height: number | null; removed: string[] }>
  /** The project it worked in, with its state at the start and the end (72.9 AC6); a run made before 72.9 gives the revision it copied as its start. */
  project: { root: string | null; start: TeamAskProjectState | null; end: TeamAskProjectState | null } | null
  /** A browser ask's record (74.3 AC3): the pages it visited and its screenshots, the app's own words; null for any other ask. */
  browser: { origin: string; interact: boolean; limit: string; pages: Array<{ url: string; title: string | null }>; screenshots: Array<{ name: string; bytes: number }> } | null
  teammate: { app: string | null; appName: string | null; appVersion: string | null; model: string | null; session: string | null; sessionSource: string | null }
  subagents: TeamAskSubagentView[]
  /** The names of the credentials BMN masked in the answer and the app's output, none where it masked nothing. */
  masked: string[]
}
/** Epic 65: what the judge's page on Team shows of its calls. Sums count every call that made a request; a refused call costs nothing and is counted apart. */
export interface JudgeTotalsView { calls: number; input_tokens: number; cost_usd: number }
/** `estimated`: how many of the month's calls are counted by the size of their request, because the gateway gave no count of their tokens. */
export interface JudgeMonthView extends JudgeTotalsView { month: string; refused: number; estimated: number; purposes: Record<string, JudgeTotalsView> }
export type JudgeOutcome = 'answered' | 'refused' | 'timeout' | 'failed' | 'shape'
/** One call as the page lists it: when, who, the purpose word and how it ended. No text and no answer is kept of a call. */
export interface JudgeCallView { at: string; by: WebQuestionAsker; purpose: string; outcome: JudgeOutcome; code?: string }
/**
 * How a call the page itself made is in the record. `counted`: "yes"; "waiting" where its line is kept beside a record that cannot be read
 * and is counted once that is mended; "no" where BMN could not write it down at all. `estimated`: the gateway gave no count of tokens and BMN counted the request's size.
 */
export interface JudgeTryCount { counted: 'yes' | 'waiting' | 'no'; estimated: boolean }
export interface JudgeView {
  /** The owner's monthly limit: off until he switches it on. */
  limit: { on: boolean; usd: number }
  /** The limit is on and this month's calls reach it: asking is stopped. */
  reached: boolean
  current: JudgeMonthView
  previous: JudgeMonthView
  /** Newest first, at most 20. */
  calls: JudgeCallView[]
  /**
   * A part of the record of the calls is there and cannot be read: the path of that file or folder, the home folder as `~`.
   * The sums and the calls are then not known (they are sent as none, and the page shows the path in their place); nothing is asked until he mended or moved it.
   */
  unreadable?: string
  /** The limit's own setting is there and cannot be read: its path. Whether a limit holds is then not known (`limit` is sent as off, and the page says so); nothing is asked until he sets it again. */
  limitUnreadable?: string
}
/** What "Try it" got back: Jev's number with BMN's reading, the command's own refusal, or why there is no answer. */
export type JudgeTryReply =
  | ({ outcome: 'answered'; noul: number; reading: 'yes' | 'no answer'; near: boolean; input_tokens: number; cost_usd: number; took_ms: number } & JudgeTryCount)
  | { outcome: 'refused'; code: string; message: string; next?: string }
  | { outcome: 'timeout' | 'failed' | 'shape'; note: string }
export interface JudgeTried { reply: JudgeTryReply; view: JudgeView }
/** How many of the judge's calls its page lists, and the most a text and a statement pasted there may hold. */
export const JUDGE_CALLS_SHOWN = 20
export const JUDGE_TRY_TEXT_MAX = 20_000
export const JUDGE_TRY_STATEMENT_MAX = 400

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
  /** The tests BMN runs by itself (Story 75.8 took the switch away): the one running now and the ones it stopped trying. */
  autoTests: AutoTestsView
  /**
   * The roles the approved team holds to read-only, and the ones BMN proposes that it does not hold yet (63.2):
   * while it holds none, the check lets a reviewer be started with write access. Null where no team is approved.
   */
  readOnlyRoles: { held: string[]; proposed: string[] } | null
  /** The skills folder, each skill's state in each app, and where each app reads skills. */
  skills: SkillsView
  /** Each approved tool's state in each app, and where each app keeps its tools. */
  tools: ToolsView
  /**
   * Set when BMN could not ask the owner's shell for its settings and inspected with its own
   * environment instead: why, in words. A session may then find other programs than BMN does.
   */
  ownEnvironment?: string
  /** BMN's hook entries in each app's own hook file, as its install at start found and left them (Story 75.9); null until it has run. */
  hooks: HooksAtStart | null
  /** Automatic read-only doctor; absent on snapshots produced by an older build. */
  doctor?: import('./doctor').DoctorView | undefined
  /** An old install may name an app BMN retired (Epic 71); it is listed as it was saved. `master` marks a save, whose Undo puts the master back too (Story 75.9). */
  transactions: { id: string; createdAt?: string; state?: string; reason?: string; targets?: RosterListedApp[]; valid: boolean; master?: boolean }[]
  history: { revision: number; at: string; hash: string; bytes: number; reason: string; intact: boolean }[] | null
}

/** Why BMN left one hook event as it is: inside a matcher, its own wording with a field the app will not run, or an entry it did not write (Story 75.9). */
export const HOOK_LEFT_WHY = Object.freeze(['gated', 'changed', 'foreign', 'unreadable', 'unparsable', 'unusable', 'numbers', 'failed'] as const)
export type HookLeftWhy = (typeof HOOK_LEFT_WHY)[number]

/** One app's hook file after BMN's install at start: what is in place, what it added, and what it left as it is. */
export interface HookAppAtStart {
  harness: RosterHarness
  file: string
  /** `not-set-up`: the app keeps no settings folder on this computer, and BMN created none. */
  state: 'checked' | 'installed' | 'left' | 'failed' | 'not-set-up'
  /** Events whose entry is in place, added now or before; `older` of them in an older wording that still runs. */
  placed: string[]
  older: string[]
  installed: string[]
  /** Events BMN left as they are, each with why; a whole file it could not add to has `why` on the app instead. */
  left: { event: string; why: HookLeftWhy }[]
  why?: HookLeftWhy
}

export type HooksAtStart =
  | { state: 'checked'; checkedAt: string; apps: HookAppAtStart[] }
  | { state: 'failed'; checkedAt: string; reason: string }

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

export interface RulesPlan {
  ok: boolean; code: string; message?: string; planHash: string | null; targets: RulesPlanTarget[]
  /** An undo's targets in an app BMN retired (Epic 71): left as they are, never written. */
  left?: { harness: RosterRetiredHarness; path: string }[]
  /** An undo of a save puts the master back too (Story 75.9): what it becomes and the diff. */
  master?: { path: string; becomes: string; diff: string }
}

/**
 * What Save writes (Story 75.9): the master's own change and each app's file, as an install plans it, bound by
 * one hash; an app whose destination no longer inspects as approved is `blocked` and not written.
 */
export interface RulesSavePlan extends RulesMasterPlan {
  ok: boolean
  code: string
  message?: string
  changesMaster: boolean
  planHash: string | null
  targets: RulesPlanTarget[]
  blocked: { harness: RosterHarness; reason: string }[]
}

/** `undo` names the transaction a save wrote, which the Notice offers to undo (Story 75.9). */
export type RulesOutcome = { ok: true; message: string; snapshot: RulesSnapshot; undo?: string } | { ok: false; code: string; message: string; snapshot: RulesSnapshot; undo?: string }
