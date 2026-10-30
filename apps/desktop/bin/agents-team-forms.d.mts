// MODULE: agents-team-forms.d.mts - types for each app's own read-only ask command (Epic 72, 72.9)
export type AskFormName = 'codex-read-only' | 'codex-qa' | 'claude-read-tools' | 'opencode-reader' | 'opencode-asker'
export declare const ASK_APPS: readonly string[]
export declare const ASK_FORMS_CHECKED: Readonly<Record<string, { version: string; on: string }>>
export declare const ASK_UNSUPPORTED: Readonly<Record<string, Record<string, string>>>
export declare const ASK_RUN_FILES: Readonly<{ request: string; manifest: string; prompt: string; rules: string; files: string; pictures: string; message: string; inputs: string; snapshots: string; receipt: string; answer: string; outcome: string; question: string; work: string; bin: string; codexAnswer: string; projectStart: string; browser: string; browserRecord: string }>
export declare const ASK_READS: Readonly<Record<AskFormName, { scope: 'computer' | 'folder' | 'text'; reach: string; words: string }>>
export declare function askReads(form: AskFormName, browser?: { interact: boolean; qa?: boolean } | null): { scope: 'computer' | 'folder' | 'text'; reach: string; words: string }
export declare const CLAUDE_ASK_TOOLS: readonly string[]
export interface AskProgram { launcher: string; payload: string }
export interface CodexMcpServer { name: string; transport: 'stdio' | 'streamable_http' }
export interface AskCommandRequest { form: AskFormName; model: string; provider?: string; effort: string; cwd: string; folder: string; pictures?: string[]; rules?: string | null; context?: { argv: string[]; env: string[] }; environment?: NodeJS.ProcessEnv | Record<string, string>; browser?: { origin: string; interact: boolean; qa?: boolean } | null; inherited?: CodexMcpServer[] }
export interface AskCommand { argv: string[]; environment: Record<string, string>; command: string[]; cwd: string; stdin: 'text' | 'stream-json' }
export declare function appSearchPath(environment?: NodeJS.ProcessEnv | Record<string, string>): string
export declare function askProgram(harness: string, environment?: NodeJS.ProcessEnv | Record<string, string>): AskProgram | null
export declare function codexMcpServers(program: AskProgram, cwd: string, environment?: NodeJS.ProcessEnv | Record<string, string>, options?: { config?: string[]; enabled?: string[]; browserServer?: { command: string; args: string[]; cwd: string; env_vars?: string[] } }): CodexMcpServer[]
export declare function checkCodexMcp(program: AskProgram, built: Pick<AskCommand, 'command' | 'cwd' | 'environment'>, browser?: { origin: string; interact: boolean; qa?: boolean } | null, folder?: string | null): void
export declare function askFormName(harness: string, options: { project: string | null; label: string; textOnly?: boolean }): AskFormName
export declare function askCommand(harness: string, program: AskProgram, request: AskCommandRequest): AskCommand
export declare function claudePictureMessage(pictures: { media_type: string; bytes: Buffer }[], prompt: string): string
export interface ProgramFile { path: string; real: string; sha256: string; link: string | null; dev: string; ino: string; size: string; mtime_ns: string; ctime_ns: string }
export declare function executableIdentity(program: AskProgram): { launcher: ProgramFile; payload: ProgramFile }
export declare function sameProgram(identity: { launcher: ProgramFile; payload: ProgramFile }, program: AskProgram): boolean

export declare const CODEX_QA_CONFIG: readonly string[]
export declare const CODEX_QA_DISABLED: readonly string[]
