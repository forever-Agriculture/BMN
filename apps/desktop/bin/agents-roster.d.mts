// MODULE: agents-roster.d.mts - types for the Epic 60 roster module so the main process can import it
export type Harness = 'claude' | 'codex' | 'opencode' | 'cursor'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface RosterAgent {
  id: string
  name: string
  title: 'knight' | 'squire'
  harness: Harness
  model: string
  provider: string
  host: string | null
  security: 'high' | 'low'
  trust: 1 | 2 | 3
  authority: 'lead' | 'write' | 'review' | 'read'
  enabled: boolean
  status: 'active' | 'proposed'
  efforts: Effort[]
  roles: string[]
  aliases?: string[]
  enabled_note?: string
  cost?: 'low' | 'medium' | 'high'
  quota?: string
  tags?: string[]
  context_window?: number
  max_context_tokens?: number
}
export interface RosterRole {
  id: string
  candidates: string[]
  then: 'lead' | 'skip' | 'blocked' | 'owner-chooses'
  recheck?: Record<string, boolean | string>
  small_epic?: string
}
export interface RosterRoute {
  harness: Harness
  provider: string
  security: 'high' | 'low'
  basis: 'observed-default' | 'owner-declared'
  accepted_versions?: string[]
}
export interface RosterData {
  schema_version: 1
  agents: RosterAgent[]
  roles: RosterRole[]
  data_labels: { default: 'public' | 'private'; paths: { path: string; label: 'public' | 'private' }[] }
  harness_routes: RosterRoute[]
}
export interface RosterIssue { code: string; line?: number; message: string }
export interface RosterBlock { startLine: number; contentLine: number; endLine: number; start: number; end: number; contentStart: number; contentEnd: number; source: string }
export interface RosterSection { heading: string; line: number; start: number; blocks: RosterBlock[] }
export declare const SCHEMA_VERSION: 1
export declare const HARNESSES: Harness[]
export declare const EFFORTS: Effort[]
export declare const THEN: RosterRole['then'][]
export declare const AGENT_FIELDS: string[]
export declare const FREE_TEXT_FIELDS: string[]
export declare const RESERVED_SECTIONS: string[]
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
export declare function team(data: RosterData, all: boolean): Record<string, unknown>[]
export declare function roleChain(data: RosterData, roleId: string): Record<string, unknown>
export declare function agentYaml(agent: RosterAgent): string
export declare function rolesYaml(roles: RosterRole[]): string
export declare function labelsYaml(labels: RosterData['data_labels']): string
export declare function routesYaml(routes: RosterRoute[]): string
export declare function headerYaml(): string
export declare function rewriteRoster(text: string, data: RosterData, options?: { scope?: string[] | null }): string
export declare function proseOf(text: string, id: string): string | null
export declare function rewriteProse(text: string, id: string, prose: string): string
