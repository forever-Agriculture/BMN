// MODULE: qa-grants.ts - bounded QA activity grants, reservations and secret-free audit records
import { hasExactKeys } from './closed-shape'
import { isRecord } from './shared-helpers'

export const QA_ACTIVITIES = ['report.generate', 'brainstorm.start'] as const
export type QaActivity = typeof QA_ACTIVITIES[number]
export const QA_AUDIT_LIMIT = 10_000
export interface QaGrantTerms {
  version: 1
  qaId: string
  account: { id: string; alias: string; revision: number }
  origin: string
  contract: { id: string; sha256: string }
  limits: Array<{ activity: QaActivity; count: number }>
  expiresAt: string
}
export interface QaGrant {
  id: string
  key: string
  terms: QaGrantTerms
  termsSha256: string
  revision: number
  state: 'pending' | 'approved' | 'denied' | 'revoked'
  createdAt: string
  card: { id: string; revision: number; sha256: string } | null
  approval: { via: 'app' | 'telegram'; operationKey: string; at: string; approved: boolean } | null
}
export interface QaRequestMeta { method: string; origin: string; path: string; queryKeys: string[] }
export interface QaGrantUse {
  id: string
  qaId: string
  grantId: string
  accountId: string
  activity: QaActivity
  requestSha256: string
  request: QaRequestMeta
  state: 'reserved' | 'sent' | 'succeeded' | 'failed' | 'uncertain'
  reservedAt: string
  settledAt: string | null
  status: number | null
}
export interface QaUseRequest {
  id: string; qaId: string; grantId: string; activity: QaActivity; requestSha256: string
  accountRevision: number; contractSha256: string; request: QaRequestMeta
}
export type QaUseDecision = { allowed: true; use: QaGrantUse } | { allowed: false; reason: string; use?: QaGrantUse }
export type QaAuditGap = 'overflow' | 'interrupted' | 'relay-incomplete' | 'broker-unreachable'
export interface QaAuditState { complete: boolean; open: boolean; nextSequence: number; gaps: QaAuditGap[] }
export interface QaAuditEvent extends QaRequestMeta {
  accountAlias: string | null
  classification: 'read' | 'activity' | 'unknown' | 'test-full'
  result: 'observed' | 'held' | 'reserved' | 'sent' | 'succeeded' | 'failed' | 'uncertain'
  grantId: string | null; useId: string | null; cardId: string | null; status: number | null
}
export interface QaAuditRecord extends QaAuditEvent { qaId: string; sequence: number; at: string }
/** Local host receipt. Reserved and sent are cumulative, overlapping counts, never added together. */
export interface QaHostSummary {
  version: 1; receiptId: string; qaId: string; briefSha256: string; revision: string
  grants: Array<{
    grantId: string; termsSha256: string; state: QaGrant['state']; account: QaGrantTerms['account']
    origin: string; contract: QaGrantTerms['contract']; expiresAt: string; card: QaGrant['card']
    approval: Pick<NonNullable<QaGrant['approval']>, 'via' | 'at' | 'approved'> | null
    activities: Array<{ activity: QaActivity; granted: number; reserved: number; sent: number; succeeded: number; failed: number; uncertain: number }>
  }>
  audit: QaAuditState & {
    entries: number; recordsSha256: string
    observedTraffic: Array<{ accountAlias: string | null; origin: string; classification: QaAuditEvent['classification']; result: QaAuditEvent['result']; count: number }>
  }
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)
const id = (value: unknown): value is string => text(value, 128) && /^[a-zA-Z0-9_:@.-]+$/.test(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const origin = (value: unknown): value is string => {
  if (!text(value, 2048)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value } catch { return false }
}
export function isQaGrantTerms(value: unknown): value is QaGrantTerms {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'qaId', 'account', 'origin', 'contract', 'limits', 'expiresAt']) || value.version !== 1 || !id(value.qaId) || !origin(value.origin)) return false
  if (!isRecord(value.account) || !hasExactKeys(value.account, ['id', 'alias', 'revision']) || !id(value.account.id) || !text(value.account.alias, 100) || !Number.isSafeInteger(value.account.revision) || (value.account.revision as number) < 1) return false
  if (!isRecord(value.contract) || !hasExactKeys(value.contract, ['id', 'sha256']) || !id(value.contract.id) || !sha(value.contract.sha256)) return false
  if (!text(value.expiresAt, 32) || !Number.isFinite(Date.parse(value.expiresAt))) return false
  if (!Array.isArray(value.limits) || value.limits.length < 1 || value.limits.length > QA_ACTIVITIES.length) return false
  const seen = new Set()
  for (const item of value.limits) {
    if (!isRecord(item) || !hasExactKeys(item, ['activity', 'count']) || !QA_ACTIVITIES.includes(item.activity as QaActivity) || seen.has(item.activity) || !Number.isSafeInteger(item.count) || (item.count as number) < 1 || (item.count as number) > 3) return false
    seen.add(item.activity)
  }
  return true
}
export function isQaRequestMeta(value: unknown): value is QaRequestMeta {
  return isRecord(value) && hasExactKeys(value, ['method', 'origin', 'path', 'queryKeys']) && typeof value.method === 'string' && /^[A-Z]{3,12}$/.test(value.method) && origin(value.origin) && text(value.path, 2048) && value.path.startsWith('/') && !/[?#]/.test(value.path) && Array.isArray(value.queryKeys) && value.queryKeys.length <= 40 && value.queryKeys.every(key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(key))
}
export function isQaAuditEvent(value: unknown): value is QaAuditEvent {
  if (!isRecord(value) || !hasExactKeys(value, ['method', 'origin', 'path', 'queryKeys', 'accountAlias', 'classification', 'result', 'grantId', 'useId', 'cardId', 'status'])) return false
  const meta = { method: value.method, origin: value.origin, path: value.path, queryKeys: value.queryKeys }
  return isQaRequestMeta(meta) && (value.accountAlias === null || text(value.accountAlias, 100)) && ['read', 'activity', 'unknown', 'test-full'].includes(value.classification as string) && ['observed', 'held', 'reserved', 'sent', 'succeeded', 'failed', 'uncertain'].includes(value.result as string) && ['grantId', 'useId', 'cardId'].every(key => value[key] === null || id(value[key])) && (value.status === null || Number.isInteger(value.status) && (value.status as number) >= 100 && (value.status as number) <= 599)
}
