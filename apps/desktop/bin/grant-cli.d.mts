// MODULE: grant-cli.d.mts - types for `bmn grant` (Story 84.3), so the tests read the same words
export declare const GRANT_USAGE: string
export declare function describeAsk(result: unknown): string
export declare function describeStatus(result: unknown, runId: string | undefined): string
export declare function describeUse(result: unknown, use: { runId: string; boundary?: string; item?: string }): string
export declare function describeReport(result: unknown, runId: string): string
export declare function runGrantCommand(argv: string[], io: { readCredentials: unknown; call: unknown }): Promise<number>
