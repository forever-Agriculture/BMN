// MODULE: agents-roster.d.mts - types for the Epic 60 roster module so the main process can import it
export type Harness = 'claude' | 'codex' | 'opencode'
/** An app BMN retired (Epic 71): an old team file may still name it; nothing runs on it. */
export type RetiredApp = 'cursor'
/** What a team file's app fields and lists may hold. */
export type ListedApp = Harness | RetiredApp
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentClass = 'knight' | 'queen' | 'rook' | 'bishop' | 'pawn'
export type PrivateWork = 'allowed' | 'public_only'
export interface RosterPrice { input: number; output: number; cached_input?: number; source?: string; as_of?: string }
/** What an agent's `harness` says when BMN itself calls the model instead of an agent app running it (65.1). */
export type CalledByBmn = 'bmn'
export interface RosterAgent {
  id: string
  name: string
  class: AgentClass
  harness: ListedApp | CalledByBmn
  model: string
  provider: string
  /** Only for an agent called by BMN: the provider that runs the model (`provider` is who receives the request). */
  run_by?: string
  host: string | null
  enabled: boolean
  status: 'active' | 'proposed'
  efforts: Effort[]
  roles: string[]
  aliases?: string[]
  enabled_note?: string
  context_window?: number
  context_limit?: number
  compact_at?: number
  paid_by?: 'per_token' | 'subscription'
  price?: RosterPrice
  /** The team names this agent a researcher (63.3). */
  researcher?: boolean
}
export interface RosterRole {
  id: string
  description?: string
  candidates: string[]
  then: 'lead' | 'skip' | 'blocked' | 'owner-chooses'
  recheck?: Record<string, boolean | string>
  small_work?: string
  /** A run for this role must not be able to write (63.2); absent or false for a role that may. */
  read_only?: boolean
}
export interface RosterProvider {
  id: string
  name: string
  hosts: string[]
  sites?: string[]
  private_work: PrivateWork
}
export interface RosterException { id: string; provider: string; folder: string }
/** The owner's teammate for one role in one project (73.2): the project's real folder, the role, the agent, an optional effort and end date. */
export interface RosterProjectChoice { id: string; project: string; role: string; agent: string; effort?: Effort; ends?: string }
export interface RosterRoute {
  harness: ListedApp
  provider: string
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}
export interface RosterData {
  schema_version: 2 | 3
  agents: RosterAgent[]
  roles: RosterRole[]
  providers: RosterProvider[]
  exceptions: RosterException[]
  harness_routes: RosterRoute[]
  /** Skills that carry a mark, in name order; absent when no skill has one. */
  skills?: RosterSkill[]
  /** The folder the skills come from, when it is not the default. */
  skills_source?: string
  /** The owner's MCP tools, in id order; absent when there are none. */
  tools?: RosterTool[]
  /** The owner's project choices (73.2); absent when there are none. */
  project_choices?: RosterProjectChoice[]
}
export interface RosterSkill { id: string; public?: true; only?: ListedApp[] }
/** One MCP tool: a program with arguments or an address, the environment variables it names (never a value), and who gets it. */
export interface RosterTool {
  id: string
  name: string
  command?: string
  args?: (string | { env: string })[]
  url?: string
  /** An entry the program receives -> the environment variable it comes from. */
  env?: Record<string, string>
  /** A request header -> the environment variable it comes from. */
  headers?: Record<string, string>
  public?: true
  apps?: ListedApp[]
  agents?: string[]
}
export interface RosterIssue { code: string; line?: number; message: string }
export interface RosterBlock { startLine: number; contentLine: number; endLine: number; start: number; end: number; contentStart: number; contentEnd: number; source: string }
export interface RosterSection { heading: string; line: number; start: number; blocks: RosterBlock[] }
export declare const OLDEST_SCHEMA_VERSION: 2
export declare function schemaSupported(version: unknown): boolean
/** Whether an agent is called by BMN itself instead of running in an agent app (65.1). */
export declare function isCalled(agent: Pick<RosterAgent, 'harness'> | null | undefined): boolean
/** The role only an agent called by BMN may hold, and the only one it may hold. */
export declare const JUDGE_ROLE: 'judge'
export interface JudgeProposal { receives: RosterProvider; runs: RosterProvider; agent: Omit<RosterAgent, 'provider' | 'run_by'> }
export declare const JUDGE_PROPOSAL: JudgeProposal
/** The team with BMN's judge proposal taken, or null where there is nothing to propose. */
export declare function judgeProposal(data: RosterData | null | undefined): RosterData | null
/** The agents an approved team offers as a judge, in the role's order. */
export declare function judges(data: Pick<RosterData, 'agents' | 'roles'> | null | undefined): RosterAgent[]
export interface CalledParty { id: string; name: string; private_work: PrivateWork }
/** Who receives a called agent's request and who runs its model, and whether both allow private work. */
export declare function calledParties(data: Pick<RosterData, 'providers'>, agent: RosterAgent): { receives: CalledParty; runs: CalledParty; allowed: boolean; reason: string }
export declare const HARNESSES: Harness[]
export declare const LISTED_APPS: ListedApp[]
export declare const RETIRED_APPS: Record<RetiredApp, string>
export declare function isRetired(app: unknown): app is RetiredApp
export declare function retiredWords(app: RetiredApp): string
export declare function appRefusal(app: unknown, words: string): string
export declare function retiredProgram(command: unknown): RetiredApp | null
export declare function appName(app: string): string
export declare const EFFORTS: Effort[]
export declare const LEAD_ROLE: 'lead'
export declare const DESIGNER_ROLE: 'designer'
export interface ClassRule { classes: AgentClass[]; code: 'CLASS_CANNOT_LEAD' | 'CLASS_CANNOT_DESIGN'; rule: string }
export declare function classRefusal(agentClass: AgentClass, role: string): ClassRule | null
export declare const SKILL_PATTERN: RegExp
export declare const TOOL_PATTERN: RegExp
export declare const TOOL_FIELDS: string[]
export declare const SHARED_SECTIONS: string[]
export declare const AGENT_FIELDS: string[]
export declare const FREE_TEXT_FIELDS: string[]
export declare const RESERVED_SECTIONS: string[]
export declare const ID_PATTERN: RegExp
export declare function agentsDirectory(): string
export declare function rosterPath(): string
export declare class RosterError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>)
  readonly code: string
  readonly errors?: RosterIssue[]
  readonly lastGood?: number | null
}
export declare function canonicalJson(value: unknown): string
export declare function sha256(text: string): string
export declare function splitSections(text: string): RosterSection[]
export declare function parseRoster(text: string, options?: { now?: Date }): { data: RosterData | null; errors: RosterIssue[]; warnings: RosterIssue[]; sections: RosterSection[] }
export declare function parseCandidate(text: string): { agent: string; efforts: Effort[]; choice: boolean } | null
export declare function agentState(agent: RosterAgent): 'active' | 'disabled' | 'proposed' | 'retired'
export interface TeamEntry {
  id: string; name: string; class: AgentClass; harness: string; model: string; provider: string; private_work: PrivateWork
  roles: string[]; efforts: string[]; state: 'active' | 'proposed' | 'disabled' | 'retired'; context_limit?: number
  /** Only for an agent called by BMN: said in place of an app, with who runs the model. */
  called_by?: CalledByBmn; run_by?: string
}
export declare const APP_NAMES: Record<Harness, string>
export declare function harnessPrivateWork(data: RosterData | null, harness: string): { allowed: boolean; reason: string; route: RosterRoute | null; provider: RosterProvider | null }
export declare function publicOnlyReasons(agent: RosterAgent, data: RosterData): string[]
export declare function teamLine(entry: TeamEntry): string
export declare function team(data: RosterData, all: boolean): TeamEntry[]
export declare function roleChain(data: RosterData, roleId: string): Record<string, unknown>
export declare function roleChainText(chain: Record<string, unknown>): string
export declare const ROLE_FIELDS: string[]
/** The agent apps that have a research form the check admits. */
export declare const RESEARCH_APPS: string[]
/** The agents the approved team names as researchers, or null while it names none (a team from before the mark). */
export declare function namedResearchers(data: Pick<RosterData, 'agents'> | null | undefined): string[] | null
/** Who BMN proposes as researchers while the team names none: knights and pawns on an app that can research, one per model. */
export declare function researcherProposal(data: (Pick<RosterData, 'agents'> & Partial<Pick<RosterData, 'providers'>>) | null | undefined): string[]
/** Whether BMN proposes to hold a role to read-only: every role whose name ends in `reviewer`, and the consultant. */
export declare function readOnlyProposed(roleId: string): boolean
/** The roles of a team that BMN proposes to hold to read-only and that are not held yet. */
export declare function readOnlyProposal(data: Pick<RosterData, 'roles'> | null | undefined): string[]
/** The efforts a role names for an agent; empty where it does not name the agent. */
export declare function roleEfforts(role: RosterRole, agentId: string): string[]
export declare function initialEfforts(role: RosterRole, agent: RosterAgent): string[]
export declare const PROJECT_CHOICE_FIELDS: readonly string[]
export declare function projectChoiceProblem(data: Pick<RosterData, 'agents' | 'roles'>, choice: RosterProjectChoice): string | null
export declare function choiceEnded(choice: RosterProjectChoice, now?: Date): boolean
export interface ProjectChoiceCollision { project: string; role: string; choices: RosterProjectChoice[] }
export declare function projectChoiceCollisions(choices: readonly RosterProjectChoice[] | undefined, canonical: (folder: string) => string, now?: Date | null): ProjectChoiceCollision[]
export declare function collisionWords(group: ProjectChoiceCollision): string
export declare function projectChoiceFor(data: Pick<RosterData, 'project_choices'>, project: string, roleId: string, canonical: (folder: string) => string, now?: Date): { choice: RosterProjectChoice; ended: boolean; collision?: undefined } | { collision: ProjectChoiceCollision; choice?: undefined; ended?: undefined } | null
export declare function starterRoster(): string
export declare function privateWorkOf(data: RosterData, agent: RosterAgent): PrivateWork
export declare function resolvedDirectory(path: string): string
export declare function rewriteRoster(text: string, data: RosterData, options?: { scope?: string[] | null }): string
export declare function outsideYamlBlocks(text: string): string[]
export declare function proseOf(text: string, id: string): string | null
export declare function rewriteProse(text: string, id: string, prose: string): string
