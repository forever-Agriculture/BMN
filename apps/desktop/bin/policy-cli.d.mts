// MODULE: policy-cli.d.mts - types for `bmn policy` (Story 83.3), so the tests read the same words and shapes
export declare const LEVEL_WORDS: Readonly<Record<'prs-only' | 'merge-when-green' | 'merge-and-push-main', string>>
export declare const POLICY_USAGE: string
export declare function remoteRepository(url: string): string | null
export declare function repositoryVerdict(status: unknown, asked: string, facts: unknown): Record<string, unknown>
export declare function describePolicy(status: unknown, verdict: unknown): string
export declare function runPolicyCommand(argv: string[], io: { readCredentials: unknown; call: unknown }): Promise<number>
