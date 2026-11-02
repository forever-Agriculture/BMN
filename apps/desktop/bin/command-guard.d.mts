// MODULE: command-guard.d.mts - types for the command guard (Story 83.4), so the hook and the tests read the same shapes
export declare const GUARDED_TOOLS: Record<'claude' | 'codex', string>
export declare function heldCommand(command: unknown, depth?: number, inheritedSelector?: boolean, cwd?: string | null): string | null
export declare function guardAnswer(agent: string, event: Record<string, unknown> & { tool_input?: Record<string, unknown> }): string | null
export declare const DOCKER_VALUES: string[]
export declare const GIT_VALUES: string[]
export declare const GH_VALUES: string[]
export declare function subcommand(list: string[], values: string[]): string[]
export declare function simpleCommandWords(source: unknown): { words: string[] } | { problem: string }
