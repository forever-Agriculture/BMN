// MODULE: qa-request-gate.d.mts - host-side request classification contract
import type { QaActivity, QaRequestMeta } from '@bmn/protocol'
export interface QaSiteContract {
  readonly id: string; readonly sha256: string; readonly origin: string
  /** A reviewed multi-origin contract (Epic 101): its page, API and sign-in origins. */
  readonly origins?: { readonly page: string; readonly api: string; readonly signIn: string }
}
export interface QaClassified { request: QaRequestMeta; classification: 'unknown' | 'read' | 'activity'; activity: QaActivity | null; reviewed: boolean }
export interface QaRequestPayload { contentType: string | null; data: Buffer | null }
export const PICHE_TEST_ORIGINS: { readonly page: string; readonly api: string; readonly signIn: string }
export function syntheticPaidContract(origin: string): QaSiteContract
export function qaContractActivities(contract: QaSiteContract | null): QaActivity[]
export function picheReadContract(origins?: { page: string; api: string; signIn: string }): QaSiteContract & { readonly origins: { readonly page: string; readonly api: string; readonly signIn: string } }
export function qaOwnOrigin(contract: QaSiteContract | null, ownOrigins: readonly string[], origin: string): boolean
export function classifyQaRequest(contract: QaSiteContract | null, method: string, address: string, ownOrigins?: readonly string[], payload?: QaRequestPayload | (() => QaRequestPayload) | null): QaClassified
export function classifyQaMeta(contract: QaSiteContract | null, meta: QaRequestMeta, ownOrigins?: readonly string[]): QaClassified
