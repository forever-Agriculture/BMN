// MODULE: agents-context.d.mts - types for the context-limit settings, their owner-run test and the default for the owner's own sessions
export type ContextApp = 'codex' | 'claude'
export type ContextTestOutcome = 'pass' | 'fail' | 'inconclusive' | 'unavailable'
export interface ContextTestEntry {
  harness: string
  at: string
  version: string | null
  limit: ContextTestOutcome
  compact: ContextTestOutcome | 'untested'
  asked: number
  observed: number | null
  detail: string
  /** Claude Code only: the other sources that named a different size for the test run, by kind. */
  rivals?: { kind: string; value: number }[]
}
export interface ContextProven { limit: boolean; compact: boolean }
/** A kind of source the run's own environment was seen to win over, and on which side its size lay. */
export interface ContextPrecedence { kind: string; side: 'above' | 'below' }
export type ContextItems =
  | { state: 'app-default' }
  | { state: 'not-supported-yet' | 'out-of-range'; limit: number; compact_at?: number; reason: string }
  | { state: 'applied'; limit: number; compact_at?: number; compact?: 'applied' | 'not-supported-yet'; argv: string[]; env: string[] }
export interface ContextResolved {
  limit: { value: number; source: string } | { unresolved: string; conflict?: boolean } | null
  compact: { value: number; source: string } | { unresolved: string } | null
  /** Claude Code only: every source that names a size, with its kind. */
  sizes?: { source: string; value: number; kind: string }[]
}
export interface ContextDefault {
  harness: ContextApp
  path: string
  resolved_path?: string
  link_target?: string
  exists: boolean
  limit: number | null
  compact: number | null
  unreadable?: string
  version: string | null
  proven: ContextProven
  test: ContextTestEntry | null
  compact_control: boolean
  min?: number
  max?: number
}
export interface ContextPlan {
  harness: ContextApp
  path: string
  resolved_path?: string
  link_target?: string
  change: 'new file' | 'no change' | 'edit'
  diff: string
  limit: number | null
  compact: number | null
  plan_hash: string
  state: import('./safe-config-write.mjs').PathState
  next: string
}
export interface ContextOptions { environment?: NodeJS.ProcessEnv; version?: string | null; tests?: ContextTestEntry[]; now?: Date; beforeCommit?: () => void }
export declare class ContextError extends Error {
  code: string
  constructor(code: string, message: string)
}
export declare const CONTEXT_CONTROLS: Record<ContextApp, {
  command: string
  limit: { form: 'argv' | 'env'; key: string; min?: number; max?: number }
  compact: { form: 'argv' | 'env'; key: string } | null
}>
export declare const CONTEXT_APPS: ContextApp[]
export declare const CODEX_CONTEXT_KEYS: string[]
export declare const CLAUDE_CONTEXT_KEY: string
export declare const CONTEXT_TEST_SIZE: Record<ContextApp, number>
export declare const CONTEXT_USAGE: string
export declare function wholeNumber(raw: unknown): number | null
export declare function contextTestsPath(): string
export declare function contextTests(): ContextTestEntry[]
export declare function lastContextTest(harness: string, tests?: ContextTestEntry[]): ContextTestEntry | null
export declare function provenControls(harness: string, version: string | null, tests?: ContextTestEntry[]): ContextProven
export declare function provenPrecedence(harness: string, version: string | null, tests?: ContextTestEntry[]): ContextPrecedence[]
export declare function contextItems(agent: { id: string; harness: string; context_limit?: number; compact_at?: number }, proven: ContextProven): ContextItems
export declare function checkContext(agent: { id: string; harness: string; context_limit?: number; compact_at?: number }, resolved: ContextResolved | undefined, proven: ContextProven, precedence?: ContextPrecedence[]):
  { applied: number | null; note: string; refusal?: undefined } | { refusal: string }
export declare function contextFile(harness: string, environment?: NodeJS.ProcessEnv): string
export declare function readCodexContext(text: string | null): { limit: number | null; compact: number | null; unreadable: string | null }
export declare function readClaudeContext(text: string | null): { limit: number | null; compact: number | null; unreadable: string | null }
export declare function setTomlTopLevelKey(text: string, key: string, value: number | null): string
export declare function setJsonEnvEntry(text: string, name: string, value: number | string | null): string
export declare function sharingAgents(data: import('./agents-roster.mjs').RosterData | null, harness: string): string[]
export declare function contextDefault(harness: string, options?: ContextOptions): ContextDefault
export declare function planContextDefault(harness: string, values: { limit: number | null; compact?: number | null }, options?: ContextOptions): ContextPlan
export declare function applyContextDefault(harness: string, values: { limit: number | null; compact?: number | null }, expectedPlanHash: string, options?: ContextOptions):
  { harness: ContextApp; path: string; written: boolean; backup: string | null }
export declare function claudeReportedWindow(output: string): number | null
export declare function codexRecordedWindow(rollout: string): number | null
export declare function testContext(harness: string, options?: { environment?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number }): Promise<ContextTestEntry>
export declare function runContextCommand(argv: string[]): Promise<number>
