// MODULE: agents-ask.d.mts - types for agents-ask.mjs (Epic 64: one web question behind the research fence)
import type { FetchPage } from './agents-research.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>
type FenceTestEntry = import('./agents-check.mjs').FenceTestEntry

export declare const ASK_LIMIT_MS: number
export declare const ASK_MAX_CHARS: number
export declare const ASK_PER_DAY: number
export declare const ASK_KEPT: number
export declare const MARKS: { found: string; missing: string; unreadable: string }
export declare const RESEARCH_USAGE: string

export declare function askPrompt(question: string): string
export declare function questionProblem(question: unknown, options?: { home?: string }): { code: 'QUESTION_EMPTY' | 'QUESTION_TOO_LONG' | 'QUESTION_HOLDS_CREDENTIAL' | 'QUESTION_NAMES_HOME'; message: string } | null

/** Who asked: the owner on Models, a BMN session (with the agent app the command ran under, where there is one), or a shell outside BMN. */
export type Asker = { kind: 'owner' } | { kind: 'shell' } | { kind: 'session'; session: string; app?: string }
export declare function askerOf(environment?: Environment, options?: { programs?: () => string[] }): Asker
export declare function askerWords(by: Asker | undefined, sessionName?: string): string

export interface MarkedClaim { claim: string; source: string; passage: string; mark: string; why?: string }
export interface MarkCounts { found: number; not_found: number; unreadable: number }
export type AskOutcome = 'answered' | 'no-answer' | 'failed' | 'stopped' | 'limit' | 'refused'
export interface QuestionRecord {
  id: string; at: string; by: Asker; researcher: string | null; researcher_name: string | null
  /** The exact question, or null for a text refused before it could be taken for public. */
  question: string | null
  outcome: AskOutcome | 'running' | 'interrupted'
  code?: string; note?: string; run?: string; answer?: string; claims?: MarkedClaim[]; not_found?: string[]; counts?: MarkCounts; took_ms?: number
  /** The OpenCode session the researcher's run was bound to (70.4 AC4). */
  session?: string
}
export declare function questionsPath(): string
export declare function readQuestions(): QuestionRecord[]
export declare function removeQuestions(id?: string | null, now?: Date): Promise<void>
export declare function askedToday(questions: Pick<QuestionRecord, 'at' | 'outcome'>[], now?: Date): number
/** The day's count the limit is held against: what the list shows for today, and today's questions since removed from it. */
export declare function askedCount(now?: Date): number
export declare const RECORD_BUSY: string
export declare function agentsMayAsk(): boolean
export declare function setAgentsMayAsk(on: boolean): void

export declare function parseAskAnswer(answer: unknown): { ok: true; answer: string; claims: Omit<MarkedClaim, 'mark' | 'why'>[]; notFound: string[] } | { ok: false; reason: string }
export declare function markClaims(claims: Omit<MarkedClaim, 'mark' | 'why'>[], options?: { fetchPage?: FetchPage; signal?: AbortSignal; deadline?: number }): Promise<MarkedClaim[]>
export declare function noResearcherWords(named: readonly string[] | null): string

export interface AskResult {
  ok: boolean; id: string; outcome: AskOutcome; researcher?: string | null; run?: string; code?: string; message?: string; next?: string; note?: string
  answer?: string; claims?: MarkedClaim[]; not_found?: string[]; counts?: MarkCounts; took_ms?: number; session?: string
}
export declare function runAsk(options: {
  question: string; agent?: string | null; by?: Asker; owner?: boolean; environment?: Environment; now?: () => Date; signal?: AbortSignal
  onStart?: (started: { id: string; researcher: string }) => void; fetchPage?: FetchPage; limitMs?: number; contextTests?: unknown[]
  fenceVersions?: Record<string, string[]>; fenceTests?: FenceTestEntry[]
  compare?: NonNullable<Parameters<typeof import('./agents-research.mjs').runResearch>[0]['compare']>
}): Promise<AskResult>
export declare function answerLines(result: AskResult, researcherName: string): string[]
export declare function askEnvironment(source?: Environment, own?: string): Record<string, string | undefined>
export declare function runResearchCommand(argv: string[], options?: { ask?: typeof runAsk; environment?: Environment }): Promise<number>
