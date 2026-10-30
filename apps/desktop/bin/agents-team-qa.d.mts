// MODULE: agents-team-qa.d.mts - curated QA ask and checked result types
export declare const QA_SKILL: string | undefined
export declare function qaAskInputs(path: string, options?: { cwd?: string; home?: string; origin?: string }): { brief: Record<string, unknown>; files: string[]; question: string }
export interface QaAskResult { valid: boolean; verdict: string | null; errors: string[]; report: string | null; brief: string }
export declare function finishQa(folder: string, answer: string, options?: { hostSummary?: import('@bmn/protocol').QaHostSummary }): QaAskResult | null
