// MODULE: agents-team-forms.d.mts - types for the measured ask form of each app (Epic 72)
export type AskAccess = 'question' | 'files' | 'project'
export type FormStanding = 'proven' | 'unavailable' | 'no-history' | 'unmeasured'
export declare const ASK_FORMS_PROVEN: Readonly<Record<string, Record<string, Record<string, FormStanding>>>>
export declare const UNAVAILABLE_WHY: Readonly<Record<string, Record<string, string>>>
export declare function formStanding(harness: string, version: string | null, mode: string): FormStanding
export declare const ASK_ACCESS: readonly AskAccess[]
export declare const ASK_RUN_FILES: Readonly<{ request: string; manifest: string; prompt: string; rules: string; objects: string; home: string; inputs: string; project: string; receipt: string }>
export declare const ASK_FORM_NAMES: Readonly<Record<string, Record<AskAccess, string>>>
export declare const CODEX_ASK_NO_TOOLS: readonly string[]
export declare const CODEX_ASK_LOG: string
export declare const CLAUDE_ASK_NO_TOOLS: readonly string[]
export declare const CLAUDE_ASK_PROJECT: readonly string[]
export declare const CLAUDE_ASK_COMMON: readonly string[]
export declare const ASK_APPS: readonly string[]
export interface AskProgram { launcher: string; payload: string; root: string; paths: string[] }
export interface AskForm { command: string[]; environment: Record<string, string>; cwd: string; home: Record<string, string>; mountPoints: string[]; stdin: 'text' | 'stream-json' }
export declare function signInBind(harness: string, environment?: NodeJS.ProcessEnv | Record<string, string>): { from: string; to: string; writable: true } | null
export declare function appSearchPath(environment?: NodeJS.ProcessEnv | Record<string, string>): string
export declare function askProgram(harness: string, environment?: NodeJS.ProcessEnv | Record<string, string>): AskProgram | null
export declare function askCommand(harness: string, program: AskProgram, request: { access: string; model: string; effort: string; rules?: string | null; pictures?: string[]; context?: { argv: string[]; env: string[] } }): AskForm
export declare function askArgv(harness: string, program: AskProgram, run: { home: string; inputs: string; project: string }, request: { access: string; model: string; effort: string; rules?: string | null; pictures?: string[]; context?: { argv: string[]; env: string[] } }, environment?: NodeJS.ProcessEnv | Record<string, string>): { argv: string[]; form: AskForm }
export declare function claudePictureMessage(pictures: { media_type: string; bytes: Buffer }[], prompt: string): string
