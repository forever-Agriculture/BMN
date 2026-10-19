// MODULE: plan-cli.d.mts - types for plan-cli.mjs (Epic 77: bmn plan status|check|set)
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
