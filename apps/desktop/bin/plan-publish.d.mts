// MODULE: plan-publish.d.mts - public types for plan checkpoint and publication state
import type { ResolvedPlan } from './plan-board.mjs'
export declare function checkpointPlan(plan: ResolvedPlan): string
export declare function publicationState(plan: ResolvedPlan): { unpublished: number | null; conflicts: number[]; conflict_values?: Array<{ path: string; key: string; epic: number; local: string | null; upstream?: string | null; pr?: string | null }>; publication?: string | null; publication_unavailable?: boolean; authority_unconfirmed?: boolean }
export declare function publishPlan(plan: ResolvedPlan, options?: Record<string, unknown>): Promise<{ outcome: string; unpublished: number | null; conflicts: number[]; error?: string }>
