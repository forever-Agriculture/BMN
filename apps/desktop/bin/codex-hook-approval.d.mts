// MODULE: codex-hook-approval.d.mts - types for what real Codex says about BMN's hook entries (Story 102.4)
import type { GuardStanding } from './hooks-floor.mjs'

export type CodexAnswer = { state: 'read'; hooks: unknown[]; warnings: number; errors: number } | { state: 'unread'; reason: string }
export type CodexApproval = { state: 'approved' | 'no-codex' } | { state: 'not-approved'; entries: number; events: string[] } | { state: 'unverified'; reason: string }
export declare function codexHookKey(path: string, event: string, group: number, handler: number): string
export declare function askCodexHooks(program: string, options?: { env?: NodeJS.ProcessEnv; cwd?: string; limitMs?: number; start?: typeof import('node:child_process').spawn }): Promise<CodexAnswer>
export declare function approvalFrom(answer: CodexAnswer, entries: { event: string; key: string; command: string }[]): CodexApproval
export declare function approvalWords(approval: CodexApproval): string
export declare function claimWithApproval(line: string | undefined, approval: CodexApproval | null, event: string): string | undefined
export declare function guardWithApproval(standing: GuardStanding, approval: CodexApproval | null): GuardStanding
export declare function approvalNeedsHim(approval: CodexApproval | null | undefined): boolean
