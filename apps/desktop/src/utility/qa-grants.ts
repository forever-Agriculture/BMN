// MODULE: qa-grants.ts - authoritative account/contract checks in front of the SQLite activity ledger
import { createHash, randomUUID } from 'node:crypto'
import { ERROR_CODES, isQaGrantTerms, isQaRequestMeta, type QaActivity, type QaAuditEvent, type QaAuditGap, type QaGrant, type QaGrantTerms, type QaRequestMeta, type QaRun, type QaUseDecision } from '@bmn/protocol'
import { classifyQaRequest, type QaSiteContract } from '../../bin/qa-request-gate.mjs'
import type { DatabaseWorkerClient } from './database-client'
import { ControlError } from './control-server'

export interface QaAccountMetadata {
  id: string; name: string; origins: string[]; test: boolean; qaRevision: number
}
/** test-full: a marked test account with full interaction; ordinary-granted: an unmarked account with an approved grant; else look-only. */
export type QaAccountMode = 'test-full' | 'look-only' | 'ordinary-granted'
export interface QaAccountPick { accountId: string; alias: string; mode: QaAccountMode; origins: string[]; grantedOrigins: string[] }
export interface QaGrantBrokerOptions {
  database: DatabaseWorkerClient
  /** An account by id or by name; the broker still requires the brief to name it. */
  account(idOrName: string): QaAccountMetadata
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
  private intent(run: QaRun, name: string): string | null {
    const alias = (run.brief.accounts as Array<{ alias: string; permission?: string; intent?: string }> | undefined)?.find(alias => alias.alias === name)
    return alias ? (run.brief.version === 2 ? alias.intent : alias.permission) ?? null : null
  }
  private account(run: QaRun, id: string): QaAccountMetadata {
    const account = this.options.account(id)
    if (account.id !== id) return fail('QA_ACCOUNT_IDENTITY_CHANGED')
    const intent = this.intent(run, account.name)
    if (!intent) return fail('QA_ACCOUNT_OUT_OF_SCOPE')
    return { ...account, test: account.test && intent === 'test-full' }
  }
  private async approved(run: QaRun, accountId: string, origin: string | null, activity: QaActivity | null): Promise<QaGrant[]> {
    const now = Date.parse(this.options.now())
    return (await this.options.database.companion('qaGrantsForRun', run.id)).filter(grant => grant.state === 'approved' && grant.approval?.approved === true &&
      grant.terms.account.id === accountId && (origin === null || grant.terms.origin === origin) && Date.parse(grant.terms.expiresAt) > now &&
      (activity === null || grant.terms.limits.some(limit => limit.activity === activity)))
  }
  /** The relay's account choice: only a brief alias, its mode decided here from the stored mark, intent and approved grants. */
  async pick(run: QaRun, name: string): Promise<QaAccountPick> {
    this.current(run)
    // Only a version 2 run seals and reconciles its host audit, so only it may open an account.
    if ((run.brief as { version?: number }).version !== 2) return fail('QA_ACCOUNTS_REQUIRE_V2')
    const found = this.options.account(name)
    if (found.name !== name) return fail('QA_ACCOUNT_IDENTITY_CHANGED')
    const account = this.account(run, found.id), intent = this.intent(run, name)
    const granted = !account.test && intent === 'ordinary-granted' ? await this.approved(run, account.id, null, null) : []
    const mode: QaAccountMode = account.test ? 'test-full' : granted.length > 0 ? 'ordinary-granted' : 'look-only'
    this.current(run)
    // The relay allows interaction only on the sites these grants name (Opus F5).
    return { accountId: account.id, alias: account.name, mode, origins: [...account.origins], grantedOrigins: [...new Set(granted.map(grant => grant.terms.origin))] }
  }
  /** A refused interaction is audited like a held request; it carries the tool's name only. */
  async refuse(run: QaRun, accountId: string, tool: string): Promise<void> {
    this.current(run)
    if (!/^browser_[a-z_]{1,40}$/.test(tool)) return fail('QA_REQUEST_INVALID')
    const account = this.account(run, accountId)
    const result = await this.options.database.companion('appendQaAudit', run.id, { method: 'TOOL', origin: account.origins[0] ?? run.brief.target as string, path: `/[tool]/${tool}`, queryKeys: [],
      accountAlias: account.name, classification: 'unknown', result: 'held', grantId: null, useId: null, cardId: null, status: null }, this.options.now())
    if (!result.recorded) fail('QA_AUDIT_INCOMPLETE')
  }
  private contract(origin: string): QaSiteContract {
    const contract = this.options.contract(origin)
    if (!contract || contract.origin !== origin) return fail('QA_SITE_UNSUPPORTED')
    return contract
  }
  async ask(run: QaRun, request: { key: string; accountId: string; origin: string; limits: QaGrantTerms['limits']; expiresAt: string }, callerIncarnation: string | null, held = false): Promise<QaGrant> {
    if (!['preparing', 'running'].includes(run.state)) return fail('QA_RUN_UNAVAILABLE')
    // A lead names the account as the brief does; its stored identity is bound into the terms.
    const account = this.account(run, this.options.account(request.accountId).id), contract = this.contract(request.origin)
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
  async reserve(run: QaRun, request: { id: string; grantId: string | null; accountId?: string | undefined; activity: QaActivity; request: QaRequestMeta; requestSha256: string }): Promise<QaUseDecision> {
    if (!isQaRequestMeta(request.request)) return fail('QA_REQUEST_INVALID')
    if (request.grantId === null) {
      // The relay names no grant: try this account's approved grants for the activity in order; refusals change nothing.
      this.current(run)
      if (typeof request.accountId !== 'string') return fail('QA_REQUEST_INVALID')
      let decision: QaUseDecision = { allowed: false, reason: 'not-approved' }
      for (const grant of await this.approved(run, request.accountId, request.request.origin, request.activity)) {
        decision = await this.reserve(run, { ...request, grantId: grant.id })
        if (decision.allowed || decision.reason !== 'exhausted') return decision
      }
      return decision
    }
    const { grant, account, contract } = await this.grant(run, request.grantId)
    const classified = classifyQaRequest(contract, request.request.method, request.request.origin + request.request.path)
    if (request.request.queryKeys.length || classified.classification !== 'activity' || classified.activity !== request.activity ||
      digest(classified.request) !== digest(request.request) || digest(request.request) !== request.requestSha256) return fail('QA_ACTIVITY_CONTRACT_MISMATCH')
    this.current(run)
    return this.options.database.companion('reserveQaGrantUse', { id: request.id, grantId: grant.id, activity: request.activity, request: request.request, requestSha256: request.requestSha256,
      qaId: run.id, accountRevision: account.qaRevision, contractSha256: grant.terms.contract.sha256 }, this.options.now())
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
    const classified = classifyQaRequest(contract, meta.method, meta.origin + meta.path, account.origins)
    // A reviewed read is a literal path without a query; an unreviewed site's page read (d71) keeps only its query key names.
    if (!held && !account.test && (classified.classification !== 'read' || classified.reviewed && meta.queryKeys.length)) return fail('QA_ACTIVITY_RESERVATION_REQUIRED')
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
