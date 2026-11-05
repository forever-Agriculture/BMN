// MODULE: plan-bmad-copy.d.mts - D10 transaction and conflict types
import type { ResolvedPlan } from './plan-board.mjs'
type SetOptions = Parameters<typeof import('./plan-cli.mjs').setRow>[1]
type SetResult = Awaited<ReturnType<typeof import('./plan-cli.mjs').setRow>>
export interface CopyFinding { code: string; key: string; where: string; reason: string; token?: string; canonical?: { status: string; note: string } | null; target?: { status: string; note: string } | null }
export declare function isCopiedPlan(plan: ResolvedPlan): boolean
export declare function setWithCopy(plan: ResolvedPlan, options: Omit<SetOptions, 'seam'> & { seam?: (phase: string, state: unknown) => void | Promise<void> }): Promise<SetResult & { copy?: { outcome: string; token?: string } }>
export declare function withGoCopy<T>(plan: ResolvedPlan, options: { epic: number }, operation: () => Promise<T>): Promise<T>
export declare function copyToken(plan: ResolvedPlan, key: string): Promise<string>
export declare function copyRow(plan: ResolvedPlan, options: { key: string; expect: string; environment?: NodeJS.ProcessEnv }): Promise<SetResult & { copy?: { outcome: string; token?: string } }>
export declare function copyFindings(plan: ResolvedPlan, options?: { recover?: boolean; environment?: NodeJS.ProcessEnv }): Promise<CopyFinding[]>
