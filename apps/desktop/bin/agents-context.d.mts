// MODULE: agents-context.d.mts - types for the context-limit settings, their test (the owner's, or BMN's own for a new version) and the default for the owner's own sessions
export type ContextApp = 'codex' | 'claude'
export type ContextTestOutcome = 'pass' | 'fail' | 'inconclusive' | 'unavailable'
export interface ContextTestEntry {
  harness: string
  at: string
  version: string | null
  /** The form the setting was tried in (Story 96.5); a record without one tried the form its app had before: Codex `argv`, Claude Code `env`. */
  control?: ContextControlForm
  limit: ContextTestOutcome
  compact: ContextTestOutcome | 'untested'
  asked: number
  observed: number | null
  detail: string
  /** Claude Code only: every other source that named a size for the test run, by its identity. */
  rivals?: ContextSource[]
  /** Set where BMN started the test by itself (63.1); the owner's own test carries none. */
  by?: 'bmn'
}
/** Another source that names a context size for a run, by its identity (a file's part, path and key). */
export interface ContextSource { source: string; id: string; value: number }
/** How an app's setting stands on one version: the latest test's outcome, `untested` with none, `unknown` where the version cannot be read. */
export type ContextStanding = ContextTestOutcome | 'untested' | 'unknown'
export interface ContextProven {
  limit: boolean
  compact: boolean
  standing?: ContextStanding
  /** Why the limit is not applied, where the caller's form is one no test covers (a research run, Story 96.5). */
  reason?: string
}
/** How a setting reaches one run: `-c` items, an `env -i` entry, or a `--settings` text of its own. */
export type ContextControlForm = 'argv' | 'env' | 'settings'
/** One app BMN should test by itself now, why, and the agents whose limit waits for it. */
/** `set` names the sources a `sources` test would meet, so that each set is tested once. */
export interface ContextAutoPlanEntry { harness: ContextApp; version: string; reason: 'untested' | 'retry' | 'sources'; control: ContextControlForm; agents: string[]; default?: number; set?: string }
/** A source the run's own `--settings` text was seen to win over, and on which side its size lay. */
export interface ContextPrecedence { id: string; side: 'above' | 'below' }
/** Why a context limit is refused: see checkContext. */
export type ContextRefusalReason = 'out-of-range' | 'conflict' | 'unresolved' | 'missing' | 'differs'
export type ContextItems =
  | { state: 'app-default' }
  | { state: 'not-supported-yet' | 'out-of-range'; limit: number; compact_at?: number; reason: string }
  | { state: 'applied'; limit: number; compact_at?: number; compact?: 'applied' | 'not-supported-yet'; argv: string[]; env: string[] }
export interface ContextResolved {
  limit: { value: number; source: string } | { unresolved: string; conflict?: boolean } | null
  compact: { value: number; source: string } | { unresolved: string } | null
  /** Claude Code only: every source that names a size, with its identity (`environment`, or a file's part, path and key; the run's own `--settings` starts with OWN_CONTEXT_SOURCE). */
  sizes?: { source: string; value: number; id: string }[]
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
  limit: { form: ContextControlForm; key: string; min?: number; max?: number }
  compact: { form: ContextControlForm; key: string } | null
}>
export declare const CONTEXT_APPS: ContextApp[]
export declare const CODEX_CONTEXT_KEYS: string[]
export declare const CLAUDE_CONTEXT_KEY: string
export declare const CONTEXT_TEST_SIZE: Record<ContextApp, number>
export declare const OWN_CONTEXT_SOURCE: string
export declare function contextTestControl(entry: Partial<ContextTestEntry> | null | undefined): ContextControlForm | null
export declare function claudeContextSettings(size: number): string
export declare function claudeContextSettingsSize(text: string): number | null
export declare function researchContextProven(agent: { id?: string; harness: string; context_limit?: number }, version: string | null, tests?: ContextTestEntry[]): ContextProven
export declare function wholeNumber(raw: unknown): number | null
export declare function contextTestsPath(): string
export declare function contextTests(): ContextTestEntry[]
export declare function provenControls(harness: string, version: string | null, tests?: ContextTestEntry[]): ContextProven
export declare function provenPrecedence(harness: string, version: string | null, tests?: ContextTestEntry[]): ContextPrecedence[]
export declare function contextItems(agent: { id: string; harness: string; context_limit?: number; compact_at?: number }, proven: ContextProven): ContextItems
export declare function checkContext(agent: { id: string; harness: string; context_limit?: number; compact_at?: number }, resolved: ContextResolved | undefined, proven: ContextProven, precedence?: ContextPrecedence[]):
  { applied: number | null; note: string; refusal?: undefined } | { refusal: string; why: ContextRefusalReason }
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
export declare function testContext(harness: string, options?: { environment?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number; by?: 'bmn' }): Promise<ContextTestEntry>
export declare const CLAUDE_TEST_ARGUMENTS: string[]
export declare function contextTestFolder(environment?: NodeJS.ProcessEnv | Record<string, string>): string
export declare function limitedAgents(data: import('./agents-roster.mjs').RosterData | null, harness: string): import('./agents-roster.mjs').RosterAgent[]
export declare function contextAutoPlan(input: {
  data: import('./agents-roster.mjs').RosterData | null
  versions: Partial<Record<ContextApp, string | null>>
  tests?: ContextTestEntry[]
  sources?: Partial<Record<ContextApp, ContextSource[]>>
  defaults?: Partial<Record<ContextApp, number | null>>
}): ContextAutoPlanEntry[]
export declare function runContextCommand(argv: string[]): Promise<number>
