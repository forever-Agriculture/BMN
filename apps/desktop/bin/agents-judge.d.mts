// MODULE: agents-judge.d.mts - types for agents-judge.mjs (Epic 65: one checked call to the team's judge)
import type { Asker } from './agents-ask.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>

export declare const LINE: number
export declare const NEAR: number
export declare const NO_ANSWER: 'no answer'
export declare const SYSTEM_ONE_PATH: string
export declare const DEADLINE_MS: number
export declare const DEADLINE_MAX_MS: number
export declare const MAX_CHOICES: number
export declare const MIN_LEVELS: number
export declare const MAX_LEVELS: number
export declare const STATE_MAX_BYTES: number
export declare const REQUEST_MAX_BYTES: number
export declare const MAX_QUESTIONS: number
export declare const CALLS_KEPT: number
export declare const NO_PURPOSE: string
export declare const EXIT: { ok: 0; usage: 2; refusal: 10; timeout: 11; failed: 12; shape: 13 }
export declare const JUDGE_USAGE: string

export type JudgeQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
export type JudgeQuestions = Record<string, JudgeQuestion>

/** Jev's own numbers for one question, as they came. */
export type JudgeAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }

/** BMN's reading of one answer: "yes", a label, a number marked sure, or "no answer"; `near` within 0.02 of the line; `differed` where two calls did not agree. */
export interface JudgeReading { reading: string | number; sure?: true; near?: true; differed?: true }

export interface JudgeProblem { code: 'QUESTIONS_INVALID' | 'STATE_EMPTY' | 'TOO_LARGE'; question?: string; message: string }
export declare function questionsProblem(questions: unknown): JudgeProblem | null
export declare function sizeProblem(state: unknown, questions: JudgeQuestions): JudgeProblem | null
export declare function readingOf(question: JudgeQuestion, answer: unknown): JudgeReading | null
export declare function readBody(questions: JudgeQuestions, body: unknown):
  { ok: true; answers: Record<string, JudgeAnswer>; readings: Record<string, JudgeReading>; tokens: number | null } | { ok: false }
export declare function agreed(first: Record<string, JudgeReading>, second: Record<string, JudgeReading>): Record<string, JudgeReading>

export declare function openCodeSignInFile(environment?: Environment): string
export declare function judgeDirectory(): string
export declare function judgeRecordPath(): string

export type JudgeOutcome = 'answered' | 'refused' | 'timeout' | 'failed' | 'shape'
/** One line of the record: no text, no answer and no key; a hash of the text where there was one. */
export interface JudgeCall {
  at: string; by: Asker; purpose: string; agent: string | null; model: string | null
  requests: number; input_tokens: number; cost_usd: number; took_ms: number; outcome: JudgeOutcome; code?: string; state_sha256?: string
}
export interface JudgeTotals { calls: number; requests: number; input_tokens: number; cost_usd: number }
export interface JudgeMonth extends JudgeTotals { refused: number; purposes: Record<string, JudgeTotals> }
export interface JudgeRecord { calls: JudgeCall[]; months: Record<string, JudgeMonth> }
export declare function readJudgeRecord(): JudgeRecord
export declare function judgeTotals(now?: Date, record?: JudgeRecord): { current: JudgeMonth & { month: string }; previous: JudgeMonth & { month: string } }
export declare function judgeLimit(): { on: boolean; usd: number }
export declare function setJudgeLimit(limit: { on: boolean; usd: number }): void
/** A limit in dollars with two places, or as many as it needs. */
export declare function limitWords(usd: number): string

export interface JudgeRequest {
  state: string; questions: unknown; data: 'public' | 'private' | undefined
  workspace?: string | null; purpose?: string; twice?: boolean; agent?: string | null; model?: string | null; by?: Asker
  environment?: Environment; now?: () => Date; deadlineMs?: number
}
export interface JudgeResult {
  ok: boolean; outcome: JudgeOutcome; took_ms: number
  code?: string; message?: string; next?: string; note?: string
  agent?: string; model?: string; answers?: Record<string, JudgeAnswer>; second?: Record<string, JudgeAnswer>; readings?: Record<string, JudgeReading>
  requests?: number; input_tokens?: number; cost_usd?: number
}
export declare function runJudge(request: JudgeRequest): Promise<JudgeResult>
export declare function judgeLines(result: JudgeResult, questions: JudgeQuestions): string[]
export declare function runJudgeCommand(argv: string[], options?: { judge?: typeof runJudge; environment?: Environment }): Promise<number>
