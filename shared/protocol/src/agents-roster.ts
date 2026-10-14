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
export const ROSTER_RETIRED_HARNESSES = ['cursor'] as const
export type RosterRetiredHarness = (typeof ROSTER_RETIRED_HARNESSES)[number]
/** What a team file's app fields and lists may hold: an app BMN serves, or one it retired. */
export type RosterListedApp = RosterHarness | RosterRetiredHarness
export const RETIRED_APP_NAMES: Readonly<Record<RosterRetiredHarness, string>> = { cursor: 'Cursor' }
/** Each retired app's program, so a saved command that starts one is recognised. */
export const RETIRED_APP_PROGRAMS: Readonly<Record<string, RosterRetiredHarness>> = { 'cursor-agent': 'cursor' }
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

/** Shells whose `-c` command line a saved entry may start a program through; such an entry opens as that shell. */
const COMMAND_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
/** A shell's long options that take no value; any other long option leaves the command line unread. */
const SHELL_LONG_OPTIONS: ReadonlySet<string> = new Set(['--login', '--noprofile', '--norc'])
const programName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const isSetting = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

/** Whether a saved entry's program is a shell, so an entry BMN does not start runs as that shell alone. */
export function isCommandShell(executable: string): boolean {
  return COMMAND_SHELLS.has(programName(executable))
}

/** Where the program `env` runs stands in its arguments, after the options BMN reads and NAME=value settings; -1 for any other option. */
function envProgram(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!
    // These two take the next word as their value.
    if (word === '-u' || word === '-C' || word === '--unset' || word === '--chdir') index += 1
    else if (word === '--') return index + 1 < argv.length ? index + 1 : -1
    else if (word === '-i' || word === '-' || word === '--ignore-environment' || /^--(unset|chdir)=/.test(word)) continue
    else if (word.startsWith('-')) return -1
    else if (!isSetting(word)) return index
  }
  return -1
}

/** A shell's `-c` command line: the first word after its leading options, where those options hold `c`; null otherwise. */
function shellCommandLine(argv: readonly string[]): string | null {
  let commandMode = false
  for (const word of argv) {
    if (SHELL_LONG_OPTIONS.has(word)) continue
    // An option that takes a value (-o, -O), an unknown long one or a + option: the line is not read.
    if (!/^-[A-Za-z]+$/.test(word)) return commandMode && !word.startsWith('-') && !word.startsWith('+') ? word : null
    if (/[oO]/.test(word)) return null
    if (word.includes('c')) commandMode = true
  }
  return null
}

/**
 * The first program a shell command line starts, read only as far as it takes (Epic 71, the
 * consultant's method after the review): leading unquoted NAME=value settings and an `exec` or
 * `command` without options are passed over, quotes and backslashes are taken away. Null where
 * anything else comes first: an expansion or substitution, a redirection, a separator or an
 * unclosed quote. Nothing after the first program is read.
 */
function firstShellProgram(line: string): string | null {
  let index = 0
  let wrapped = false
  for (;;) {
    while (line[index] === ' ' || line[index] === '\t') index += 1
    const from = index
    let value = ''
    let quote: string | null = null
    for (; index < line.length; index += 1) {
      const char = line[index]!
      if (quote === "'") {
        if (char === "'") quote = null
        else value += char
      } else if (char === '$' || char === '`') {
        return null
      } else if (quote === '"') {
        if (char === '"') quote = null
        else if (char === '\\' && '"\\'.includes(line[index + 1] ?? '')) value += line[++index]
        else value += char
      } else if (char === "'" || char === '"') {
        quote = char
      } else if (char === '\\') {
        if (index + 1 >= line.length || line[index + 1] === '\n') return null
        value += line[++index]
      } else if (' \t;&|()<>\n'.includes(char)) {
        break
      } else {
        value += char
      }
    }
    if (quote !== null || index === from) return null
    const word = line.slice(from, index)
    if (!wrapped && isSetting(word)) continue
    if (!wrapped && (value === 'exec' || value === 'command')) {
      wrapped = true
      while (line[index] === ' ' || line[index] === '\t') index += 1
      if (line[index] === '-') return null
      continue
    }
    return value === '' ? null : value
  }
}

/**
 * The retired app a saved entry is for, or null. Only an entry that starts it first counts (assumption
 * (b) of Epic 71, as the consultant drew it after the review): its own program; the program `env`
 * runs; or the first program of a shell's `-c` line, as the New session form writes it
 * (`bash -ic 'cursor-agent; exec bash -i'`). An argument that only names the program (a prompt, a
 * path, a later command) is the entry's own business, and the entry runs as it was saved.
 */
export function retiredAppCommand(executable: string, argv: readonly string[]): RosterRetiredHarness | null {
  const direct = retiredAppProgram(executable)
  if (direct !== null) return direct
  const name = programName(executable)
  if (name === 'env') {
    const at = envProgram(argv)
    return at < 0 ? null : retiredAppProgram(argv[at]!)
  }
  if (!COMMAND_SHELLS.has(name)) return null
  const line = shellCommandLine(argv)
  const program = line === null ? null : firstShellProgram(line)
  return program === null ? null : retiredAppProgram(program)
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
export type RosterSchemaVersion = 2 | 3
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

export interface RosterExceptionShape { id: string; provider: string; folder: string }

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

/** What became of the OpenCode Go sign-in an approval copied into BMN's OpenCode folder (70.4). */
export interface OpenCodeSignInResult { ok: boolean; copied: boolean; message: string }

/**
 * Luna through OpenCode Go (70.4), as the Team page asks it: whether the installed OpenCode lists her
 * model, and whether BMN's OpenCode folder holds a Go sign-in (null where the approved team names no
 * agent on OpenCode Go, or OpenCode could not be asked). `copy` is what a press of Copy sign-in did.
 */
export interface OpenCodeGoView { listed: boolean; signedIn: boolean | null; reason: string | null; copy?: OpenCodeSignInResult }

export type AgentsOutcome =
  | { ok: true; snapshot: AgentsSnapshot; message: string; rulesUpdate?: AgentsRulesUpdate; openCodeSignIn?: OpenCodeSignInResult }
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
export interface ResearcherView { id: string; name: string; harness: RosterHarness; ok: boolean; why?: string; reason?: string
  /** For a Codex researcher: the tools its fence test saw offered, and whether they were compared under the provider's own model list yet. */
  fence?: { tools: string[]; compared: boolean } }
/** Team › Models: what research has found, who may research, and the run that is going. */
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
  /** The fence test of the installed Codex as started from this window: whether one is going, and how the last one ended. */
  fenceTest: { running: boolean; ended: { ok: boolean; text: string } | null }
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
/** Team › Models, "Web questions" (64.3): what was asked, what holds the one research lock now, the switch and the day's count. */
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
  /** Whether BMN tests a new app version's context setting by itself, and the app it is testing right now (63.1). */
  contextAuto: { enabled: boolean; running: ContextLimitApp | null }
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
  /** An old install may name an app BMN retired (Epic 71); it is listed as it was saved. */
  transactions: { id: string; createdAt?: string; state?: string; reason?: string; targets?: RosterListedApp[]; valid: boolean }[]
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

export interface RulesPlan {
  ok: boolean; code: string; message?: string; planHash: string | null; targets: RulesPlanTarget[]
  /** An undo's targets in an app BMN retired (Epic 71): left as they are, never written. */
  left?: { harness: RosterRetiredHarness; path: string }[]
}

export type RulesOutcome = { ok: true; message: string; snapshot: RulesSnapshot } | { ok: false; code: string; message: string; snapshot: RulesSnapshot }
