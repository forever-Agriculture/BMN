// MODULE: plan-cli.d.mts - types for plan-cli.mjs (Epic 77: bmn plan status|check|set; 96.1: go)
export declare const KEPT_VERSIONS: number
type Environment = NodeJS.ProcessEnv | Record<string, string>
export declare function versionsDirectory(boardPath: string, environment?: Environment): string
export declare function keepVersion(boardPath: string, text: string, environment?: Environment): string
export declare function lockBoard(boardPath: string, options?: { waitMs?: number }): Promise<() => void>
export declare function replaceRow(text: string, key: string, status: string, note: string | undefined): { text: string; before: { status: string; note: string }; token: string } | null
export declare function setRow(boardPath: string, options: {
  key: string; status: string; note?: string; expect: string; environment?: Environment; seam?: (event: string, attempt: number) => void
}): Promise<
  | { outcome: 'changed'; kept: string; token: string; attempts: number }
  | { outcome: 'unchanged'; token: string }
  | { outcome: 'conflict'; current: { key: string; status: string; note: string; token: string } }
  | { outcome: 'busy' }
>
export declare function runPlanCommand(argv: string[]): Promise<number>
export declare function approvalText(text: string | null | undefined): string
export declare function addToQueue(text: string, epic: number): string | null
export declare function recordGo(plan: Awaited<ReturnType<typeof import('./plan-board.mjs').resolvePlan>>, options: {
  epic: number; source?: string; approved?: string; expect: string; date?: string; note?: string; now?: Date; seam?: (step: string, commit: string) => void
}): Promise<{
  outcome: 'recorded' | 'recorded-before'; commit: string; date: string; source: string; approvedSha: string; file: string; repo: string; epicIncluded: boolean
  row: { status: string; note: string; token: string } | null; pending: boolean; noteClipped?: boolean
}>
