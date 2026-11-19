// MODULE: plan-actions.d.mts - types for exact epic action parsing and display
import type { PlanAction } from '@bmn/protocol'

export function parsePlanAction(raw: unknown): { action: PlanAction } | { problem: string }
export function planActionsHash(actions: readonly PlanAction[]): string
export function planActionWords(action: PlanAction): string
export function planPolicyTarget(action: Exclude<PlanAction, { kind: 'command' }>, command: string, cwd: string):
  Promise<{ remote: string | null } | { problem: string }>
