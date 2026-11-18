// MODULE: grant-facts.d.mts - type boundary for checkout-scoped night facts and allowance pins
import type { GrantLimitPin, GrantLimitTerm, PushPolicyStatus } from '@bmn/protocol'

export interface GrantNightFacts {
  plan: { state: string; reason: string | null; limits: unknown[]; prepared: unknown[] }
  pullRequests: { state: string; reason: string | null; items: unknown[] }
  conflicts: { id: string; words: string }[]
}
export function grantFacts(input: {
  cwd: string | undefined
  project: string | undefined
  runId: string
  epic: number | undefined
  policy: PushPolicyStatus
  environment?: NodeJS.ProcessEnv
}): Promise<GrantNightFacts>

export function sameGrantCheckout(cwd: string | undefined, project: string): Promise<boolean>
export function pinGrantLimit(cwd: string | undefined, term: GrantLimitTerm): Promise<GrantLimitPin>
export function resolveGrantLimitPlan(project: string): Promise<unknown>
export function classifyRequiredChecks(rows: unknown): 'unknown' | 'green' | 'failed' | 'pending' | 'unconfirmed'
export function grantFactConflicts(facts: { plan: { limits: unknown[] }; pullRequests: { items: unknown[] } }): { id: string; words: string }[]
