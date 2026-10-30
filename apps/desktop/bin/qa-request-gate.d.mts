// MODULE: qa-request-gate.d.mts - host-side request classification contract
import type { QaActivity, QaRequestMeta } from '@bmn/protocol'
export interface QaSiteContract { readonly id: string; readonly sha256: string; readonly origin: string }
export function syntheticPaidContract(origin: string): QaSiteContract
export function classifyQaRequest(contract: QaSiteContract | null, method: string, address: string): {
  request: QaRequestMeta; classification: 'unknown' | 'read' | 'activity'; activity: QaActivity | null
}
