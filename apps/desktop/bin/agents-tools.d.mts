// MODULE: agents-tools.d.mts - types for agents-tools.mjs (Story 60.12)
import type { RosterAgent, RosterData, RosterTool } from './agents-roster.mjs'
import type { Generation } from './agents-state.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>
export type ToolsHarness = 'claude' | 'codex' | 'opencode' | 'cursor'
export type ToolState = 'unreadable' | 'missing' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'exposed' | 'excluded' | 'blocked'
export type ToolsOutcome = 'pass' | 'fail' | 'inconclusive' | 'unavailable'
type Versions = Partial<Record<ToolsHarness, string | null>>

export declare class ToolsError extends Error {
  code: string
  constructor(code: string, message: string)
}

export declare const TOOL_APPS: Record<ToolsHarness, {
  command: string; format: 'json' | 'toml'; path: string[]; file: (environment: Environment) => string
  list: string[]; add: ((id: string, program: string) => string[]) | null; remove: ((id: string) => string[]) | null
}>
export declare const SETTLED_STATES: ToolState[]
export declare function toolsTestsPath(): string

export interface ToolsTestEntry {
  harness: string
  kind: 'capability'
  at: string
  version: string | null
  outcome: ToolsOutcome
  detail: string
  /** Where the app was seen reading its tools, with the home folder as ~. */
  file?: string
  variable: 'pass' | 'unproven'
  variable_basis?: 'started' | 'listed'
  isolation: 'pass' | 'fail' | 'unproven'
  own_command: 'pass' | 'fail' | 'none'
}
export declare function toolsTests(): ToolsTestEntry[]
export declare function lastToolsTest(harness: string, tests?: ToolsTestEntry[]): ToolsTestEntry | null
export interface AppTools {
  harness: ToolsHarness
  version: string | null
  supported: boolean
  /** Whether the app was seen passing a named environment variable to a tool on this version. */
  variable: boolean
  /** Whether a run was seen with only the tools its own command names. */
  isolation: boolean
  own_command: string | null
  /** Why tools are not supported yet in this app, when they are not. */
  reason?: string
}
export declare function appTools(harness: string, options: { version: string | null | undefined; tests?: ToolsTestEntry[] }): AppTools

export type ToolDefinition = { url: string; headers?: Record<string, string> } | { command: string; args?: (string | { env: string })[]; env?: Record<string, string> }
export declare function definitionOf(tool: RosterTool): ToolDefinition
export declare function renderTool(tool: RosterTool, harness: string, options?: { variable?: boolean }): { entry: Record<string, unknown>; blocked?: undefined } | { blocked: string; entry?: undefined }
export declare function looksSecret(text: unknown): boolean
export declare function neutralOf(value: unknown, harness: string): { definition: ToolDefinition; secrets: string[]; extras: string[] } | null
export declare function maskedEntry(value: unknown, harness: string): unknown

export type AppToolEntry =
  | { unreadable: string; value?: undefined }
  | { value: Record<string, unknown>; raw: string; hash: string; definition: ToolDefinition; secrets: string[]; extras: string[]; unreadable?: undefined }
export interface AppToolsFile { harness: string; path: string; readable: boolean; detail?: string; entries: Map<string, AppToolEntry>; text?: string; link?: string }
export declare function readAppTools(harness: string, environment?: Environment, options?: { path?: string }): AppToolsFile
export declare function eligible(tool: RosterTool, harness: string, kind: 'full' | 'public'): boolean
export declare function transportWords(tool: Pick<RosterTool, 'command' | 'args' | 'url'>): string

export interface ToolRow { id: string; state: ToolState; detail?: string; managed?: boolean; secret?: true }
export interface UnlistedRow { id: string; state: 'unmanaged' | 'exposed'; managed: boolean; secret?: true }
export interface ToolsApp extends AppTools {
  kind: 'full' | 'public'
  kind_reason: string
  path: string
  readable: boolean
  detail?: string
  /** The settings file is a link to this: BMN reads through it and never writes there. */
  link?: string
  tools: ToolRow[]
  /** Entries the app holds that are not on the owner's list. */
  unlisted: UnlistedRow[]
}
export interface ToolSummary { id: string; name: string; transport: string; public: boolean; apps: ToolsHarness[] | null; agents: string[] | null }
export interface ToolsCheck { tools: ToolSummary[]; apps: ToolsApp[] }
export declare function checkTools(options?: { environment?: Environment; tests?: ToolsTestEntry[]; versions?: Versions; generation?: Generation | null }): ToolsCheck
export declare function checkExit(result: ToolsCheck): 0 | 1
export declare function pendingCounts(result: ToolsCheck): { pending: number; exposed: number; blocked: number }
export declare function appStateWord(app: ToolsApp): 'Not supported yet' | 'Differs' | 'Exposed' | 'Missing' | 'Set up' | 'None'

export interface ToolsTarget {
  harness: ToolsHarness; tool: string; path: string; action: 'set' | 'remove'; change: string; words: string
  before: string | null; after: string | null; unlisted?: true
}
export interface ToolsOpen { harness: ToolsHarness; tool: string; path: string; fix: string; unlisted?: true }
export interface ToolsPlan { code: string; message?: string; targets: ToolsTarget[]; exposed: ToolsOpen[]; blocked: ToolsOpen[]; planHash: string | null }
interface InstallOptions { environment?: Environment; versions?: Versions; tests?: ToolsTestEntry[]; removeUnlisted?: boolean }
export declare function planToolsInstall(harnesses?: string[], options?: InstallOptions): Promise<ToolsPlan>
export declare function toolsPlanView(result: ToolsPlan): { code: string; message?: string; plan_hash: string | null; targets: ToolsTarget[]; exposed: ToolsOpen[]; blocked: ToolsOpen[] }
export interface ToolsInstallResult {
  code: string; message?: string; transaction: string | null
  written: { harness: ToolsHarness; tool: string; path: string; action: 'set' | 'remove' }[]
  exposed: ToolsOpen[]; blocked: ToolsOpen[]
}
export declare function installTools(harnesses?: string[], options?: InstallOptions & {
  yes?: boolean; asJson?: boolean; now?: Date; expectedPlanHash?: string; afterConfirm?: () => void
  beforeTarget?: (target: ToolsTarget, index: number) => void; beforeCommit?: (target: ToolsTarget, index: number) => void
}): Promise<ToolsInstallResult>
export declare function restoreToolsTransaction(manifest: unknown, folder: string, options?: { yes?: boolean; asJson?: boolean; planOnly?: boolean; expectedPlanHash?: string }): Promise<Record<string, unknown>>

export interface ToolProposal { id: string; state: 'ready' | 'secret' | 'known' | 'conflict' | 'unreadable'; apps: ToolsHarness[]; tool?: RosterTool; notes: string[] }
export declare function proposeTools(options?: { environment?: Environment; generation?: Generation | null }): { files: { harness: ToolsHarness; path: string; readable: boolean; detail?: string }[]; proposals: ToolProposal[] }

export declare function agentTools(data: Pick<RosterData, 'tools'> | null, agentId: string): RosterTool[]
export type ToolItems =
  | { state: 'none' }
  | { state: 'not-supported-yet' | 'blocked'; tools: string[]; reason: string }
  | { state: 'applied'; tools: string[]; argv: string[]; hash: string }
export declare function toolItems(agent: RosterAgent, data: Pick<RosterData, 'tools'>, proven: { isolation: boolean; variable: boolean }): ToolItems
export declare function checkRunTools(agent: RosterAgent, data: Pick<RosterData, 'tools'>, parsed: Record<string, unknown>, proven: { isolation: boolean; variable: boolean }, options?: { packet?: boolean; profile?: boolean }):
  | { applied: string[]; note: string; hash?: string; refusal?: undefined }
  | { refusal: { code: 'TOOL_MISMATCH' | 'ROUTE_UNSUPPORTED'; message: string }; applied?: undefined; note?: undefined; hash?: undefined }

export declare function testTools(harness: string, options?: { environment?: Environment; now?: Date; timeoutMs?: number }): Promise<ToolsTestEntry>
export declare const TOOLS_USAGE: string
export declare function runToolsCommand(argv: string[]): Promise<number>
