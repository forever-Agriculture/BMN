// MODULE: agents-team-ask.d.mts - types for making one teammate's ask ready (Epic 72)
import type { AskResult } from './agents-check.mjs'
export declare function askRunId(now?: Date): string
export declare class AskUsageError extends Error {}
export declare function earlierRun(id: string, runs?: string): { role: string; project: string | null; agent: string } | null
export declare function filePrompt(question: string, files: { label: string; sha256: string; bytes: Buffer }[]): string
export declare function projectPrompt(question: string, frozen: import('./agents-team-inputs.mjs').FrozenProject, root: string): string
export interface AskAsked {
  role: string; question: string; agent?: string; effort?: string; smallWork?: boolean; recheckOf?: string; project?: string
  access?: string; files?: string[]; data?: string; wide?: boolean
}
export interface PreparedAsk {
  id: string; folder: string; choice: { agent: string; effort: string; rule: string; phase: string }
  verdict: AskResult; argv: string[]; stdin: 'text' | 'stream-json'; manifest: Record<string, unknown> & { inputs: import('./agents-check.mjs').AskInput[] }
}
export declare function prepareAsk(request: AskAsked, options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; home?: string; now?: Date; runs?: string; id?: string; contextTestLog?: import('./agents-context.mjs').ContextTestEntry[] }): PreparedAsk
