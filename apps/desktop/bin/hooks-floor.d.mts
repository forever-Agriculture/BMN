// MODULE: hooks-floor.d.mts - types for the command guard's probe (Story 102.4)
export type GuardStanding = { state: 'holds' | 'does-not-answer' | 'changed' | 'missing' | 'not-approved' | 'unverified' | 'no-codex'; reason?: string }
export declare const PROBE_COMMAND: string
export declare function probeCommandGuard(agent: string, entry: string, options?: { env?: NodeJS.ProcessEnv; ownFolder?: string; spawn?: typeof import('node:child_process').spawnSync; entrySeconds?: number | null }): GuardStanding
export declare function guardWords(standing: GuardStanding): string
