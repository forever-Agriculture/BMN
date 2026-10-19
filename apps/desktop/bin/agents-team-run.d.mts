// MODULE: agents-team-run.d.mts - types for an ask started as judged, attributed with its sub-agents and kept (Epic 72)
export declare const TIME_LIMIT: Readonly<{ default: number; min: number; max: number }>
export declare const ANSWER_LIMIT: number
export declare const ASK_GIT: string
export declare const OUTCOME_EXIT: Readonly<Record<'answered' | 'failed' | 'interrupted' | 'refused' | 'out-of-time' | 'stopped' | 'not-attributed', number>>
export declare class StartRefusal extends Error { code: string; constructor(code: string, message: string) }
export interface Observed { session: string | null; session_source: string | null; model: string | null; model_source: string | null; effort: string | null; effort_source: string | null }
export interface AskUsage {
  input_tokens: number | 'unknown'; cached_input_tokens: number | 'unknown'; output_tokens: number | 'unknown'; reasoning_tokens: number | 'unknown'; reported_cost: number | 'unknown'
  billing: string; source: string; aggregation?: string; complete?: boolean; incomplete_reason?: string
}
export interface Subagent {
  session: string; parent: string | null; name: string | null; role: string | null; kind: string; model: string | null; effort: string | null
  usage: Record<string, number | 'unknown'> | 'incomplete' | string; usage_reason?: string; status?: string | null; own_tokens?: number | 'unknown'; record?: string
}
export interface ProjectState { commit: string | null; clean: boolean | null; changed: number | null; reason?: string; at: string }
export interface Outcome {
  version: 1; id?: string | null; state: string; exit: number | null; reason?: string
  requested?: { agent: string | null; model: string | null; effort: string | null }; observed: Observed; subagents?: Subagent[]; usage: AskUsage
  rate_limit?: { status: string; window: string; utilization: number | string }; problems?: string[]; credentials_masked?: { answer: string[]; output: string[] }
  project?: { root: string; start: ProjectState | null; end: ProjectState | null }
  started_at?: string | null; ended_at?: string | null; time_limit_minutes?: number | null
}
export declare function startAsk(prepared: import('./agents-team-ask.mjs').PreparedAsk, options?: { now?: Date; timeLimitMinutes?: number; start?: (folder: string) => { pid: number; start: string } | { failed: string }; tokenCeiling?: number | null }): { pid: number; start: string }
export declare function observeAsk(folder: string, harness: string | null, request: { model?: string; aliases?: string[]; effort?: string; billing?: string; provider?: string }, options?: { startedAt?: number | null; endedAt?: number | null }): { observed: Observed; answer: string | null; failure: string | null; usage: AskUsage; rateLimit: Outcome['rate_limit'] | null; problems: string[]; subagents: Subagent[] }
export declare function finishAsk(folder: string): void
export declare function finishRun(folder: string, options?: { interrupted?: string | null }): void
export declare const TRANSIENT: readonly string[]
export declare function launchCheck(folder: string, launch: Record<string, unknown>, options?: { now?: number }): string | null
export declare function watchAsk(folder: string, launch: { token_ceiling?: number } | null): string | null
export declare function askOutcome(folder: string): Outcome
export declare function waitAsk(folder: string, options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<Outcome>
export declare function stopAsk(folder: string): void
export declare function finishBrowser(folder: string): import('./agents-team-browser.mjs').BrowserRecord | null
export declare function exportAsk(folder: string, output: string): string[]
