// MODULE: check.d.mts - types for the shared local manual QA report checker
export declare function checkQaReport(report: unknown, brief: unknown, schema?: Record<string, unknown>, context?: { hostSummary?: unknown; receiptSha256?: string }): string[]
export declare function checkQaBrief(brief: unknown, schema?: Record<string, unknown>): string[]
export declare function runReportCheck(argv: string[], options?: { stdout?: { write(text: string): unknown }; stderr?: { write(text: string): unknown } }): number
