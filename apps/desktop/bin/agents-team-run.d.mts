// MODULE: agents-team-run.d.mts - types for an ask started as judged, attributed and kept (Epic 72)
export declare const TIME_LIMIT: Readonly<{ default: number; min: number; max: number }>
export declare const OUTPUT_LIMIT: number
export declare const ANSWER_LIMIT: number
export declare const OUTCOME_EXIT: Readonly<Record<'answered' | 'failed' | 'interrupted' | 'refused' | 'out-of-time' | 'stopped' | 'not-attributed', number>>
export declare class StartRefusal extends Error { code: string; constructor(code: string, message: string) }
export interface Observed { session: string | null; session_source: string | null; model: string | null; model_source: string | null; effort: string | null; effort_source: string | null }
export interface AskUsage { input_tokens: number | 'unknown'; cached_input_tokens: number | 'unknown'; output_tokens: number | 'unknown'; reasoning_tokens: number | 'unknown'; reported_cost: number | 'unknown'; billing: string; source: string }
export interface Outcome {
  version: 1; id?: string | null; state: string; exit: number | null; reason?: string
  requested?: { agent: string | null; model: string | null; effort: string | null }; observed: Observed; usage: AskUsage
  rate_limit?: { status: string; window: string; utilization: number | string }; problems?: string[]; started_at?: string | null; ended_at?: string | null; time_limit_minutes?: number | null
}
export declare function startAsk(prepared: import('./agents-team-ask.mjs').PreparedAsk, options?: { now?: Date; timeLimitMinutes?: number; start?: (folder: string) => { pid?: number; start?: string; failed?: string }; tokenCeiling?: number | null }): { pid: number; start: string }
export declare function observeAsk(folder: string, harness: string | null, request: { model?: string; aliases?: string[]; effort?: string; billing?: string }): { observed: Observed; answer: string | null; failure: string | null; usage: AskUsage; rateLimit: Outcome['rate_limit'] | null; problems: string[] }
export declare function finishAsk(folder: string): void
export declare function watchAsk(folder: string, launch: { token_ceiling?: number } | null): string | null
export declare function askOutcome(folder: string): Outcome
export declare function waitAsk(folder: string, options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<Outcome>
export declare function stopAsk(folder: string): void
export declare const EXPORTED: readonly string[]
export declare function exportAsk(folder: string, output: string): string[]
