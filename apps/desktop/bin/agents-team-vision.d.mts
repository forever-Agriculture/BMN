// MODULE: agents-team-vision.d.mts - types for agents-team-vision.mjs (Epic 112: a reviewer's ask carries the project's VISION.md)
import type { AskVision } from './agents-team-ask.mjs'
import type { ResolvedPlan } from './plan-board.mjs'

export declare const VISION_LIMIT: number
export declare const VISION_ROLES: readonly string[]
export declare function reviewVision(role: string, project: string | null | undefined, options?: { home?: string; resolvePlan?: ((start: string) => Promise<ResolvedPlan>) | null }): Promise<(AskVision & { bytes?: number }) | null>
export declare function visionPrompt(prompt: string, vision: { file: string; label: string; sha256: string }): string
