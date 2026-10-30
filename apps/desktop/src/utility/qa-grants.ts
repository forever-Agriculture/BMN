// MODULE: qa-grants.ts - authoritative account/contract checks in front of the SQLite activity ledger
import { createHash, randomUUID } from 'node:crypto'
import { ERROR_CODES, isQaGrantTerms, isQaRequestMeta, type QaActivity, type QaAuditEvent, type QaAuditGap, type QaGrant, type QaGrantTerms, type QaRequestMeta, type QaRun, type QaUseDecision } from '@bmn/protocol'
import { classifyQaRequest, type QaSiteContract } from '../../bin/qa-request-gate.mjs'
import type { DatabaseWorkerClient } from './database-client'
import { ControlError } from './control-server'

export interface QaAccountMetadata {
  id: string; name: string; origins: string[]; test: boolean; qaRevision: number
}
export interface QaGrantBrokerOptions {
  database: DatabaseWorkerClient
  account(id: string): QaAccountMetadata
  contract(origin: string): QaSiteContract | null
  qualified(run: QaRun): boolean
  live(sessionId: string): string | undefined
  now(): string
  changed(sessionId: string): void
}
const fail = (code: string): never => { throw new ControlError(ERROR_CODES.invalidArgument, code) }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** The production caller must establish native qualification; this broker never mints that proof. */
export class QaGrantBroker {
  constructor(private readonly options: QaGrantBrokerOptions) {}
  private current(run: QaRun): void {
    if (run.state !== 'running' || !run.sessionId || !run.incarnationId || this.options.live(run.sessionId) !== run.incarnationId) fail('QA_RUN_UNAVAILABLE')
    if (!run.agent || !run.connection || !this.options.qualified(run)) fail('QA_NATIVE_QUALIFICATION_REQUIRED')
  }
  private account(run: QaRun, id: string): QaAccountMetadata {
    const account = this.options.account(id)
    if (account.id !== id) return fail('QA_ACCOUNT_IDENTITY_CHANGED')
    const alias = (run.brief.accounts as Array<{ alias: string; permission?: string; intent?: string }> | undefined)?.find(alias => alias.alias === account.name)
    if (!alias) return fail('QA_ACCOUNT_OUT_OF_SCOPE')
    return { ...account, test: account.test && (run.brief.version === 2 ? alias.intent : alias.permission) === 'test-full' }
  }
  private contract(origin: string): QaSiteContract {
    const contract = this.options.contract(origin)
    if (!contract || contract.origin !== origin) return fail('QA_SITE_UNSUPPORTED')
    return contract
  }
  async ask(run: QaRun, request: { key: string; accountId: string; origin: string; limits: QaGrantTerms['limits']; expiresAt: string }, callerIncarnation: string | null, held = false): Promise<QaGrant> {
    if (!['preparing', 'running'].includes(run.state)) return fail('QA_RUN_UNAVAILABLE')
    const account = this.account(run, request.accountId), contract = this.contract(request.origin)
    if (!account.origins.includes(request.origin)) return fail('QA_ACCOUNT_SITE_MISMATCH')
    const terms: QaGrantTerms = { version: 1, qaId: run.id, account: { id: account.id, alias: account.name, revision: account.qaRevision },
      origin: contract.origin, contract: { id: contract.id, sha256: contract.sha256 }, limits: request.limits, expiresAt: request.expiresAt }
    if (!isQaGrantTerms(terms)) return fail('QA_GRANT_INVALID')
    const result = await this.options.database.companion(held ? 'openQaHeldGrantRequest' : 'openQaGrantRequest', { id: randomUUID(), key: request.key, terms, incarnationId: callerIncarnation }, this.options.now())
    this.options.changed(run.callerSessionId)
    return result.grant
  }
  private async grant(run: QaRun, id: string): Promise<{ grant: QaGrant; account: QaAccountMetadata; contract: QaSiteContract }> {
    this.current(run)
    const grant = await this.options.database.companion('getQaGrant', id)
    this.current(run)
    if (!grant || grant.terms.qaId !== run.id) return fail('QA_GRANT_NOT_FOUND')
    const account = this.account(run, grant.terms.account.id), contract = this.contract(grant.terms.origin)
    if (account.qaRevision !== grant.terms.account.revision || account.name !== grant.terms.account.alias || !account.origins.includes(contract.origin) ||
      contract.id !== grant.terms.contract.id || contract.sha256 !== grant.terms.contract.sha256) return fail('QA_GRANT_SCOPE_CHANGED')
    return { grant, account, contract }
  }
  async reserve(run: QaRun, request: { id: string; grantId: string; activity: QaActivity; request: QaRequestMeta; requestSha256: string }): Promise<QaUseDecision> {
    if (!isQaRequestMeta(request.request)) return fail('QA_REQUEST_INVALID')
    const { grant, account, contract } = await this.grant(run, request.grantId)
    const classified = classifyQaRequest(contract, request.request.method, request.request.origin + request.request.path)
    if (request.request.queryKeys.length || classified.classification !== 'activity' || classified.activity !== request.activity ||
      digest(classified.request) !== digest(request.request) || digest(request.request) !== request.requestSha256) return fail('QA_ACTIVITY_CONTRACT_MISMATCH')
    this.current(run)
    return this.options.database.companion('reserveQaGrantUse', { ...request, qaId: run.id, accountRevision: account.qaRevision, contractSha256: grant.terms.contract.sha256 }, this.options.now())
  }
  async send(run: QaRun, id: string): Promise<QaUseDecision> {
    this.current(run)
    const use = await this.options.database.companion('getQaGrantUse', id)
    if (!use || use.qaId !== run.id) return fail('QA_USE_NOT_FOUND')
    const { account } = await this.grant(run, use.grantId)
    this.current(run)
    return this.options.database.companion('sendQaGrantUse', run.id, id, account.qaRevision, this.options.now())
  }
  async settle(run: QaRun, id: string, state: 'succeeded' | 'failed' | 'uncertain', status: number | null): Promise<void> {
    this.current(run)
    const use = await this.options.database.companion('getQaGrantUse', id)
    if (!use || use.qaId !== run.id) return fail('QA_USE_NOT_FOUND')
    this.current(run)
    await this.options.database.companion('settleQaGrantUse', run.id, id, state, status, this.options.now())
  }
  async observe(run: QaRun, accountId: string, meta: QaRequestMeta, held = false): Promise<void> {
    this.current(run)
    if (!isQaRequestMeta(meta)) return fail('QA_REQUEST_INVALID')
    const account = this.account(run, accountId), contract = this.options.contract(meta.origin)
    const classified = classifyQaRequest(contract, meta.method, meta.origin + meta.path)
    if (!held && !account.test && (meta.queryKeys.length || classified.classification !== 'read')) return fail('QA_ACTIVITY_RESERVATION_REQUIRED')
    if (!held && !account.origins.includes(meta.origin)) return fail('QA_ACCOUNT_SITE_MISMATCH')
    const event: QaAuditEvent = { ...meta, path: classified.request.path, accountAlias: account.name, classification: held ? 'unknown' : account.test ? 'test-full' : 'read',
      result: held ? 'held' : 'observed', grantId: null, cardId: null, useId: null, status: null }
    const result = await this.options.database.companion('appendQaAudit', run.id, event, this.options.now())
    if (!result.recorded) fail('QA_AUDIT_INCOMPLETE')
  }
  async hold(run: QaRun, accountId: string, meta: QaRequestMeta, reason: string): Promise<QaGrant | null> {
    this.current(run)
    if (!isQaRequestMeta(meta)) return fail('QA_REQUEST_INVALID')
    const account = this.account(run, accountId), contract = this.options.contract(meta.origin)
    const classified = classifyQaRequest(contract, meta.method, meta.origin + meta.path)
    let grant: QaGrant | null = null
    if (!meta.queryKeys.length && classified.classification === 'activity' && classified.activity) {
      const key = `held-${digest([run.id, account.id, account.qaRevision, meta.origin, contract?.sha256, classified.activity, reason])}`
      grant = await this.options.database.companion('qaGrantForKey', run.id, key)
      this.current(run)
      if (this.account(run, accountId).qaRevision !== account.qaRevision) return fail('QA_GRANT_SCOPE_CHANGED')
      if (!grant) grant = await this.ask(run, { key, accountId, origin: meta.origin,
        limits: [{ activity: classified.activity, count: 1 }], expiresAt: new Date(Date.parse(this.options.now()) + 60 * 60 * 1000).toISOString() }, this.options.live(run.callerSessionId) ?? null, true)
    }
    const result = await this.options.database.companion('appendQaAudit', run.id, { ...meta, path: classified.request.path,
      accountAlias: account.name, classification: classified.classification, result: 'held', grantId: grant?.id ?? null,
      cardId: grant?.card?.id ?? null, useId: null, status: null }, this.options.now())
    if (!result.recorded) fail('QA_AUDIT_INCOMPLETE')
    return grant
  }
  async gap(run: QaRun, gap: QaAuditGap | null): Promise<void> { await this.options.database.companion('closeQaAudit', run.id, gap) }
  async summary(run: QaRun): Promise<import('@bmn/protocol').QaHostSummary> {
    this.current(run)
    if (run.brief.version !== 2) return fail('QA_SUMMARY_REQUIRES_V2')
    return this.options.database.companion('sealQaHostSummary', run.id, this.options.now())
  }
}
