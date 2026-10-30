// MODULE: qa-sessions.ts - session-scoped QA start/status/stop and native relay attestation
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { ERROR_CODES, type MessageTeamAnswer, type QaActivity, type QaAuditGap, type QaGrantTerms, type QaLaunchRequest, type QaRequestMeta, type QaRun, type SessionRecord } from '@bmn/protocol'
import { QaGrantBroker, type QaGrantBrokerOptions } from './qa-grants'
import { canonicalJson, sha256 } from '../../bin/shared-helpers.mjs'
import { writeWhole } from '../../bin/agents-team-supervisor.mjs'
import type { DatabaseWorkerClient } from './database-client'
import type { ControlScope } from './control-auth'
import { ControlError } from './control-server'

export interface QaSessionsOptions {
  database: DatabaseWorkerClient
  data: string
  cliPath: string
  session(id: string): SessionRecord | undefined
  live(id: string): string | undefined
  processId(id: string): number | undefined
  launch(request: QaLaunchRequest): Promise<MessageTeamAnswer>
  stop(sessionId: string, incarnationId: string): Promise<void>
  now(): string
  accounts?: Pick<QaGrantBrokerOptions, 'account' | 'contract' | 'qualified' | 'changed'>
}
const fail = (message: string): never => { throw new ControlError(ERROR_CODES.invalidArgument, message) }
const unauthorized = (): never => { throw new ControlError(ERROR_CODES.unauthorized, 'Only the QA caller and the owner may access this run') }

export class QaSessions {
  constructor(private readonly options: QaSessionsOptions) {}
  private checker(): typeof import('../../../../skills/manual-qa/check.mjs') {
    const bin = dirname(this.options.cliPath)
    const path = [resolve(bin, '../skills/manual-qa/check.mjs'), resolve(bin, '../../../skills/manual-qa/check.mjs')].find(existsSync)
    if (!path) return fail('QA_SKILL_UNAVAILABLE')
    return createRequire(import.meta.url)(path) as typeof import('../../../../skills/manual-qa/check.mjs')
  }
  async request(scope: ControlScope, method: string, params: Record<string, unknown>): Promise<unknown> {
    const db = this.options.database
    if (['qa.grant.ask', 'qa.reserve', 'qa.send', 'qa.settle', 'qa.audit', 'qa.audit.close', 'qa.hold', 'qa.summary'].includes(method)) {
      const accounts = this.options.accounts
      if (!accounts) return fail('QA_NATIVE_QUALIFICATION_REQUIRED')
      const broker = new QaGrantBroker({ ...accounts, database: db, live: this.options.live, now: this.options.now })
      if (method === 'qa.grant.ask') {
        if (scope.kind === 'session' && this.options.live(scope.sessionId) !== scope.incarnationId) return unauthorized()
        const run = await db.companion('getQaRun', params.id as string)
        if (!run || scope.kind !== 'owner' && (scope.kind !== 'session' || scope.sessionId !== run.callerSessionId && scope.sessionId !== run.sessionId)) return unauthorized()
        return broker.ask(run, { key: params.key as string, accountId: params.accountId as string, origin: params.origin as string,
          limits: params.limits as QaGrantTerms['limits'], expiresAt: params.expiresAt as string }, this.options.live(run.callerSessionId) ?? null)
      }
      if (scope.kind !== 'session') return unauthorized()
      const run = await db.companion('qaRunForSession', scope.sessionId, scope.incarnationId)
      if (!run) return fail('QA_SESSION_UNBOUND')
      if (method === 'qa.summary') {
        const summary = await broker.summary(run), bytes = canonicalJson(summary)
        const file = join(run.folder, 'host-summary.json')
        if (existsSync(file) && readFileSync(file, 'utf8') !== bytes + '\n') return fail('QA_SUMMARY_FILE_CHANGED')
        writeWhole(file, bytes + '\n')
        return { receiptId: summary.receiptId, sha256: sha256(bytes) }
      }
      if (method === 'qa.reserve') return broker.reserve(run, { id: params.id as string, grantId: params.grantId as string, activity: params.activity as QaActivity,
        request: params.request as QaRequestMeta, requestSha256: params.requestSha256 as string })
      if (method === 'qa.send') return broker.send(run, params.id as string)
      if (method === 'qa.settle') return broker.settle(run, params.id as string, params.state as 'succeeded' | 'failed' | 'uncertain', params.status as number | null)
      if (method === 'qa.audit') return broker.observe(run, params.accountId as string, params.request as QaRequestMeta, params.held as boolean)
      if (method === 'qa.hold') return broker.hold(run, params.accountId as string, params.request as QaRequestMeta, params.reason as string)
      return broker.gap(run, params.gap as QaAuditGap | null)
    }
    if (method === 'qa.start') {
      if (scope.kind !== 'session') return unauthorized()
      const caller = this.options.session(scope.sessionId)
      if (!caller || caller.archivedAt !== null || this.options.live(caller.sessionId) !== scope.incarnationId) return fail('QA_CALLER_INVALID')
      const brief = params.brief as Record<string, unknown>
      const errors = this.checker().checkQaBrief(brief)
      if (errors.length) return fail(`QA_BRIEF_INVALID: ${errors.join('; ')}`)
      if (brief.mode !== 'session') return fail('QA_MODE_INVALID: a pane requires mode session')
      const id = randomUUID()
      const reservation = await db.companion('reserveQaRun', {
        id, callerSessionId: caller.sessionId, workspaceId: caller.workspaceId, key: params.key as string,
        inputSha256: createHash('sha256').update(JSON.stringify(brief)).digest('hex'), brief, folder: join(this.options.data, 'qa', id),
        state: 'preparing', sessionId: null, incarnationId: null, createdAt: this.options.now(), failure: null, connection: null, result: null
      })
      if (!reservation.created) return reservation.run
      const run = reservation.run
      let answer: MessageTeamAnswer
      try { answer = await this.options.launch({ qaId: id, workspaceId: caller.workspaceId, sourceRoot: caller.cwd, folder: run.folder, brief }) }
      catch { return db.companion('uncertainQaStart', id) }
      if ('qa' in answer) return db.companion('bindQaRun', id, answer.qa.sessionId, answer.qa.incarnationId)
      if (!('qaFailure' in answer)) return db.companion('uncertainQaStart', id)
      return db.companion('finishQaRun', id, { state: 'failed', failure: answer.qaFailure, result: null })
    }
    if (['qa.policy', 'qa.agent', 'qa.connect'].includes(method)) {
      if (scope.kind !== 'session') return unauthorized()
      const run = await db.companion('qaRunForSession', scope.sessionId, scope.incarnationId)
      if (!run) return { qaId: null, accounts: false }
      if (method === 'qa.agent') {
        if (!this.agentProcess(run, params.pid as number, params.ticks as string)) return fail('QA_AGENT_IDENTITY_INVALID')
        await db.companion('bindQaAgent', run.id, { pid: params.pid as number, ticks: params.ticks as string, at: this.options.now() })
      }
      if (method === 'qa.connect') {
        if (!this.relayProcess(run, params.pid as number, params.ticks as string)) return fail('QA_RELAY_IDENTITY_INVALID')
        await db.companion('connectQaRelay', run.id, { pid: params.pid as number, ticks: params.ticks as string, at: this.options.now() })
      }
      // Account use stays closed until the durable permission broker is connected.
      return { qaId: run.id, target: run.brief.target, accounts: false }
    }
    const run = await db.companion('getQaRun', params.id as string)
    if (!run) return fail('QA_NOT_FOUND')
    if (scope.kind !== 'owner' && run.callerSessionId !== scope.sessionId) return unauthorized()
    if (method === 'qa.stop') {
      if (run.sessionId && run.incarnationId && this.options.live(run.sessionId) === run.incarnationId) await this.options.stop(run.sessionId, run.incarnationId)
      return db.companion('finishQaRun', run.id, { state: 'stopped', failure: 'QA_STOPPED', result: null })
    }
    if (run.state === 'running' && run.sessionId && this.options.live(run.sessionId) !== run.incarnationId) return this.finish(run)
    return run
  }
  private process(pid: number): { parent: number; ticks: string; argv: string[] } {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')
    return { parent: Number(fields[1]), ticks: fields[19]!, argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) }
  }
  private agentProcess(run: QaRun, pid: number, ticks: string): boolean {
    try {
      const process = this.process(pid), launch = JSON.parse(readFileSync(join(run.folder, 'launch.json'), 'utf8')) as { built: { command: string[] }; identity: { launcher: { real: string } } }
      if (process.ticks !== ticks || process.parent !== this.options.processId(run.sessionId!) || realpathSync(`/proc/${pid}/cwd`) !== realpathSync(run.folder)) return false
      const expected = launch.built.command
      const exact = JSON.stringify(process.argv) === JSON.stringify(expected)
      const nodeLauncher = process.argv.length === expected.length + 1 && realpathSync(process.argv[1]!) === launch.identity.launcher.real && JSON.stringify(process.argv.slice(2)) === JSON.stringify(expected.slice(1))
      return (exact || nodeLauncher) && this.process(pid).ticks === ticks
    } catch { return false }
  }
  private relayProcess(run: QaRun, pid: number, ticks: string): boolean {
    try {
      if (!run.agent) return false
      const relay = this.process(pid)
      if (relay.ticks !== ticks || relay.argv.length !== 3 || relay.argv[1] !== join(dirname(this.options.cliPath), 'qa-browser-relay.mjs') || relay.argv[2] !== run.folder) return false
      const launch = JSON.parse(readFileSync(join(run.folder, 'launch.json'), 'utf8')) as { identity: { payload: { dev: string; ino: string } } }
      const executable = statSync(`/proc/${relay.parent}/exe`, { bigint: true })
      if (String(executable.dev) !== launch.identity.payload.dev || String(executable.ino) !== launch.identity.payload.ino) return false
      // Only a direct native Codex child can connect, not a shell or another descendant carrying its token.
      for (let depth = 0, current = relay.parent; current > 1 && depth < 64; depth++) {
        const process = this.process(current)
        if (current === run.agent.pid) return process.ticks === run.agent.ticks && this.process(pid).ticks === ticks
        current = process.parent
      }
    } catch { return false }
    return false
  }
  private async finish(run: QaRun): Promise<QaRun> {
    const db = this.options.database
    if (!run.connection || !run.agent) return db.companion('finishQaRun', run.id, { state: 'failed', failure: 'QA_RELAY_UNPROVEN', result: null })
    try {
      const qa = createRequire(import.meta.url)(join(dirname(this.options.cliPath), 'agents-team-qa.mjs')) as typeof import('../../bin/agents-team-qa.mjs')
      const answer = readFileSync(join(run.folder, 'codex-answer.md'), 'utf8')
      let hostSummary
      if (run.brief.version === 2) {
        try { hostSummary = await db.companion('qaHostSummary', run.id) }
        catch { return db.companion('finishQaRun', run.id, { state: 'failed', failure: 'QA_SUMMARY_UNAVAILABLE', result: null }) }
      }
      const checked = qa.finishQa(run.folder, answer, hostSummary ? { hostSummary } : undefined)
      if (!checked?.valid) return db.companion('finishQaRun', run.id, { state: 'failed', failure: 'QA_REPORT_INVALID', result: { valid: false, verdict: null, errors: checked?.errors ?? ['Missing report'], report: null } })
      return db.companion('finishQaRun', run.id, { state: 'finished', failure: null, result: { ...checked, report: JSON.parse(answer), ...(hostSummary ? { hostSummary } : {}) } })
    } catch { return db.companion('finishQaRun', run.id, { state: 'failed', failure: 'QA_REPORT_MISSING', result: null }) }
  }
}
