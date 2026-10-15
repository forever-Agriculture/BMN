// MODULE: agents-team-ask.d.mts - types for making one teammate's ask ready (Epic 72)
import type { AskResult } from './agents-check.mjs'
export declare function askRunId(now?: Date): string
export declare class AskUsageError extends Error {}
export declare function earlierRun(id: string, runs?: string): { role: string; project: string | null; agent: string } | null
export declare function filePrompt(question: string, files: { label: string; sha256: string; bytes: Buffer }[]): string
export declare function picturePrompt(prompt: string, pictures: { label: string; media_type: string; width: number; height: number }[]): string
export declare function projectPrompt(prompt: string, root: string): string
export declare const ACCESS_GONE: string
export declare const WIDE_READ_GONE: string
export interface AskAsked {
  role: string; question: string; agent?: string; effort?: string; smallWork?: boolean; recheckOf?: string; project?: string
  /** Gone in 72.9: given, the ask is refused with the new spelling. */
  access?: string; wide?: boolean
  files?: string[]; images?: string[]; data?: string
  key?: string; keyScope?: string; requestSha256?: string; askedBy?: { kind: string; session?: string; app?: string }; inputHashes?: { files?: string[]; images?: string[] }
}
export interface PreparedAsk {
  id: string; folder: string; choice: { agent: string; effort: string; rule: string; phase: string; project_choice?: string }
  verdict: AskResult; argv: string[]; cwd: string; stdin: 'text' | 'stream-json'; manifest: Record<string, unknown> & { inputs: import('./agents-check.mjs').AskInput[] }
  program: import('./agents-team-forms.mjs').AskProgram
}
export declare function instructionRules(harness: string, generation: unknown): string | null
export declare function prepareAsk(request: AskAsked, options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; home?: string; now?: Date; runs?: string; id?: string; contextTestLog?: import('./agents-context.mjs').ContextTestEntry[] }): PreparedAsk
