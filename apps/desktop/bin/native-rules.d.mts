// MODULE: native-rules.d.mts - types for the native rules (Story 102.3)
export declare const NEVER_COMMANDS: string[]
export declare const CODEX_RULES: string
export declare const CODEX_RULES_FILE: string
export declare const CODEX_ASK_PROFILE: string
export declare const CODEX_DENIED_WORDS: string
export declare function privateKeyNames(home: string): string[]
export declare function secretPaths(home: string): string[]
export declare function claudeDenyRows(home: string): string[]
export declare function missingClaudeRows(data: unknown, home: string): string[]
export declare function withClaudeRows<T>(data: T, rows: string[]): T
export declare function codexRulesPath(codexHome: string): string
export declare function codexDeniedPaths(home: string): string[]
export declare function codexAskProfile(home: string): string[]
