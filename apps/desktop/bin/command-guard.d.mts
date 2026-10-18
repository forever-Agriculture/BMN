// MODULE: command-guard.d.mts - types for the command guard (Story 83.4), so the hook and the tests read the same shapes
export declare const GUARDED_TOOLS: Record<'claude' | 'codex', string>
export declare function heldCommand(command: unknown): string | null
export declare function guardAnswer(agent: string, event: Record<string, unknown> & { tool_input?: Record<string, unknown> }): string | null
