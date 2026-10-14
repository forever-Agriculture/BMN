// MODULE: agents-opencode.d.mts - types for the OpenCode helper folder module (Epic 70)
export declare const OPENCODE_FORM_TESTED: { version: string; on: string }
export declare const OPENCODE_HELPER_AGENT: string
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
