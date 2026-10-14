// MODULE: agents-opencode.d.mts - types for the OpenCode helper folder module (Epic 70)
export declare const OPENCODE_FORM_TESTED: { version: string; on: string }
export declare const OPENCODE_HELPER_AGENT: string
export declare const OPENCODE_RESEARCH_AGENT: string
export declare const OPENCODE_WEBSEARCH_PROVIDER: string
export declare const OPENCODE_RESEARCH_TITLE: string
export declare const OPENCODE_FOLDER_SHA256: string
export declare const OPENCODE_SESSION_ID: RegExp
export declare const OPENCODE_CONFIG_FILES: Readonly<Record<string, string>>
export declare const OPENCODE_HELPER_AGENT_SHA256: string
export declare const OPENCODE_RUN_ARGV: string[]
export interface OpenCodeFolders { home: string; config: string; data: string; state: string; cache: string }
export interface OpenCodeItems { env: string[]; argv: string[]; then: string[]; stdin: string; agent_sha256: string; form_tested_on: string }
export declare function openCodeFolder(): string
export declare function openCodeFolders(base?: string): OpenCodeFolders
export declare function openCodeEnvironment(base?: string): Record<string, string>
export declare function openCodeItems(base?: string): OpenCodeItems
export declare function installOpenCodeFolder(base?: string, options?: { ownerCache?: string }): OpenCodeItems & { folder: string }
export declare function openCodeFolderProblem(base?: string): string | null
export declare function openCodeResearchArgv(agent: { model: string; provider: string }, effort: string, options?: { path?: string; base?: string }): string[]
export declare function openCodeAnswer(stdout: string): { ok: true; text: string } | { ok: false; reason: string }
export declare function openCodeSession(stdout: string): string | null
export declare const OPENCODE_GO_PROVIDER: string
export declare const LUNA_GO_MODEL: string
type Environment = NodeJS.ProcessEnv | Record<string, string>
export declare function openCodeListsLuna(options?: { environment?: Environment; timeoutMs?: number }): Promise<{ listed: boolean; reason?: string }>
export declare function openCodeGoSignedIn(options?: { environment?: Environment; base?: string; timeoutMs?: number }): Promise<{ signedIn: boolean | null; reason?: string }>
export declare function copyOpenCodeGoSignIn(options?: { environment?: Environment; base?: string; timeoutMs?: number }): Promise<{ ok: boolean; copied: boolean; message: string }>
