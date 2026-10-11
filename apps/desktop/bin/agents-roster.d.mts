// MODULE: agents-roster.d.mts - types for the Epic 60 roster module so the main process can import it
export type Harness = 'claude' | 'codex' | 'opencode' | 'cursor'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentClass = 'knight' | 'queen' | 'rook' | 'bishop' | 'pawn'
export type PrivateWork = 'allowed' | 'public_only'
export interface RosterPrice { input: number; output: number; cached_input?: number; source?: string; as_of?: string }
export interface RosterAgent {
  id: string
  name: string
  class: AgentClass
  harness: Harness
  model: string
  provider: string
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
export interface RosterRoute {
  harness: Harness
  provider: string
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}
export interface RosterData {
  schema_version: 2
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
}
export interface RosterSkill { id: string; public?: true; only?: Harness[] }
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
  apps?: Harness[]
  agents?: string[]
}
export interface RosterIssue { code: string; line?: number; message: string }
export interface RosterBlock { startLine: number; contentLine: number; endLine: number; start: number; end: number; contentStart: number; contentEnd: number; source: string }
export interface RosterSection { heading: string; line: number; start: number; blocks: RosterBlock[] }
export declare const SCHEMA_VERSION: 2
export declare const HARNESSES: Harness[]
export declare const EFFORTS: Effort[]
export declare const THEN: RosterRole['then'][]
export declare const CLASSES: AgentClass[]
export declare const PRIVATE_WORK: PrivateWork[]
export declare const LEAD_ROLE: 'lead'
export declare const DESIGNER_ROLE: 'designer'
export interface ClassRule { classes: AgentClass[]; code: 'CLASS_CANNOT_LEAD' | 'CLASS_CANNOT_DESIGN'; rule: string }
export declare const CLASS_ROLES: Record<string, ClassRule>
export declare function classRefusal(agentClass: AgentClass, role: string): ClassRule | null
export declare const MAX_EXCEPTIONS: number
export declare const MAX_SKILLS: number
export declare const SKILL_PATTERN: RegExp
export declare const MAX_TOOLS: number
export declare const TOOL_PATTERN: RegExp
export declare const ENV_NAME_PATTERN: RegExp
export declare const TOOL_FIELDS: string[]
export declare const SHARED_SECTIONS: string[]
export declare const STARTER_ROLES: RosterRole[]
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
export declare function parseRoster(text: string): { data: RosterData | null; errors: RosterIssue[]; warnings: RosterIssue[]; sections: RosterSection[] }
export declare function parseCandidate(text: string): { agent: string; efforts: Effort[]; choice: boolean } | null
export declare function agentState(agent: RosterAgent): 'active' | 'disabled' | 'proposed'
export interface TeamEntry {
  id: string; name: string; class: AgentClass; harness: string; model: string; provider: string; private_work: PrivateWork
  roles: string[]; efforts: string[]; state: 'active' | 'proposed' | 'disabled'; context_limit?: number
}
export declare const APP_NAMES: Record<'claude' | 'codex' | 'opencode' | 'cursor', string>
export declare const UNCHECKED_APPS: Harness[]
export declare function harnessPrivateWork(data: RosterData | null, harness: string): { allowed: boolean; reason: string; route: RosterRoute | null; provider: RosterProvider | null }
export declare function publicOnlyReasons(agent: RosterAgent, data: RosterData): string[]
export declare function teamEntry(data: RosterData, agent: RosterAgent): TeamEntry
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
export declare function agentYaml(agent: RosterAgent): string
export declare function rolesYaml(roles: RosterRole[]): string
export declare function providersYaml(providers: RosterProvider[]): string
export declare function exceptionsYaml(exceptions: RosterException[]): string
export declare function skillsYaml(data: Pick<RosterData, 'skills' | 'skills_source'>): string
export declare function toolsYaml(data: Pick<RosterData, 'tools'>): string
export declare function starterRoster(): string
export declare function privateWorkOf(data: RosterData, agent: RosterAgent): PrivateWork
export declare function resolvedDirectory(path: string): string
export declare function routesYaml(routes: RosterRoute[]): string
export declare function headerYaml(): string
export declare function rewriteRoster(text: string, data: RosterData, options?: { scope?: string[] | null }): string
export declare function outsideYamlBlocks(text: string): string[]
export declare function proseOf(text: string, id: string): string | null
export declare function rewriteProse(text: string, id: string, prose: string): string
