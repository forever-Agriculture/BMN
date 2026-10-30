// MODULE: qa-host-summary.test.ts - synthetic SQLite/receipt/report contracts; no native or account qualification
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaGrantTerms, type QaUseRequest } from '@bmn/protocol'
import { canonicalJson, sha256 } from '../../bin/agents-roster.mjs'
import { finishQa } from '../../bin/agents-team-qa.mjs'
import { checkQaBrief, checkQaReport, runReportCheck } from '../../../../skills/manual-qa/check.mjs'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { bindQaAgent, bindQaRun, connectQaRelay, reserveQaRun } from './database-qa-store'
import { COMPANION_OPERATIONS } from './database-companion-store'
import type { DatabaseWorkerClient } from './database-client'
import { QaSessions } from './qa-sessions'
import { syntheticPaidContract } from '../../bin/qa-request-gate.mjs'
import { answerQaGrant, appendQaAudit, askQaGrant, bindQaGrantCard, closeQaAudit, qaHostSummary, recoverQaGrantUses, reserveQaGrantUse, sealQaHostSummary, sendQaGrantUse, settleQaGrantUse } from './database-qa-grant-store'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-29T16:00:00.000Z', origin = 'http://127.0.0.1:4173'
let root: string, database: DatabaseConnection
const brief = () => ({ version: 2, revision: 'synthetic-build', target: origin, mode: 'session', goal: 'Check a synthetic selection', why: 'Keep selections',
  scope: { included: ['Cart'], excluded: ['Real accounts'] }, decisions: [], designs: [], regression_checklist: [], starting_state: 'Synthetic only', fixtures: ['Synthetic account'],
  accounts: [{ alias: 'Synthetic', intent: 'ordinary-granted' }], time_budget_minutes: 3, criteria: [{ id: 'AC1', description: 'Selection appears', mandatory: true }] })
const terms = (): QaGrantTerms => ({ version: 1, qaId: 'run-a', account: { id: 'account-a', alias: 'Synthetic', revision: 1 }, origin,
  contract: { id: 'synthetic-paid@1', sha256: 'b'.repeat(64) }, limits: [{ activity: 'report.generate', count: 1 }], expiresAt: '2026-10-29T17:00:00.000Z' })
function approve(): void {
  const card = { id: 'card-a', revision: 1, sha256: 'c'.repeat(64) }
  askQaGrant(database, { id: 'grant-a', key: 'key-a', terms: terms() }, now); bindQaGrantCard(database, 'grant-a', card)
  answerQaGrant(database, { id: 'grant-a', cardId: card.id, cardRevision: 1, cardSha256: card.sha256, approved: true, via: 'app', operationKey: 'synthetic-owner' }, now)
}
function reserve(id = 'use-a'): void {
  const request = { method: 'POST', origin, path: '/paid/report', queryKeys: [] }
  const use: QaUseRequest = { id, qaId: 'run-a', grantId: 'grant-a', accountRevision: 1, contractSha256: terms().contract.sha256, activity: 'report.generate',
    request, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') }
  expect(reserveQaGrantUse(database, use, now).allowed).toBe(true)
}
const report = (summary: ReturnType<typeof sealQaHostSummary>, verdict = 'GO') => ({ version: 2, revision: brief().revision, target: origin, mode: 'session',
  account_context: { signed_out: false, used_accounts: [{ alias: 'Synthetic', intent: 'ordinary-granted', observed_restrictions: ['Synthetic fixture; permission comes from the host'] }], observed_restrictions: ['No unsafe callbacks'] },
  goal_check: { status: 'achieved', execution: 'started', steps: ['Exercise the synthetic fixture'], observations: 'Unit fixture observation, not runtime evidence' },
  criteria: [{ id: 'AC1', status: 'PASS', steps: ['Exercise fixture'], observations: 'Fixture expectation met', evidence: [], finding_ids: [] }], findings: [],
  debrief: { confidence: 'high', summary: 'Synthetic report contract', notes: [] }, untested_areas: [], verdict,
  host_summary: { receiptId: summary.receiptId, sha256: sha256(canonicalJson(summary)) } })
const publish = (summary = sealQaHostSummary(database, 'run-a', now)) => { writeFileSync(join(root, 'host-summary.json'), canonicalJson(summary) + '\n'); return summary }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-summary-')); database = new Sqlite(join(root, 'state.sqlite')); initializeDatabase(database, now)
  for (const id of ['caller', 'qa']) database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?,?,?,?,1,?,0)')
    .run(id, DEFAULT_WORKSPACE_ID, id, root, '/bin/bash', '["--run","run-a"]', now)
  reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: sha256(JSON.stringify(brief())), brief: brief(),
    folder: root, state: 'preparing', sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null })
  bindQaRun(database, 'run-a', 'qa', 'qa-inc')
  mkdirSync(join(root, 'inputs')); writeFileSync(join(root, 'inputs/manifest.json'), JSON.stringify({ qa: { brief: brief() } }))
  writeFileSync(join(root, 'browser.json'), JSON.stringify({ calls: 1, pages: [], screenshots: [] }))
})
afterEach(() => { database.close(); rmSync(root, { recursive: true, force: true }) })

it('refuses an unsealed summary and binds a sealed summary to the exact reserved brief', () => {
  expect(() => qaHostSummary(database, 'run-a')).toThrow('QA_SUMMARY_NOT_SEALED')
  const summary = sealQaHostSummary(database, 'run-a', now)
  expect(summary).toMatchObject({ qaId: 'run-a', briefSha256: sha256(JSON.stringify(brief())), revision: brief().revision, grants: [], audit: { open: false, complete: true, entries: 0 } })
})
it('sealing is durable and idempotent; a new observer or approval cannot mutate its receipt', () => {
  approve(); const summary = sealQaHostSummary(database, 'run-a', now)
  expect(() => reserve()).toThrow('QA_ACCOUNTS_SEALED')
  expect(() => closeQaAudit(database, 'run-a', 'interrupted')).toThrow('QA_ACCOUNTS_SEALED')
  expect(() => appendQaAudit(database, 'run-a', { method: 'GET', origin, path: '/', queryKeys: [], accountAlias: 'Synthetic', classification: 'read', result: 'observed', grantId: null, cardId: null, useId: null, status: null }, now)).toThrow('QA_ACCOUNTS_SEALED')
  database.close(); database = new Sqlite(join(root, 'state.sqlite')); recoverQaGrantUses(database, now)
  expect(sealQaHostSummary(database, 'run-a', '2026-10-29T16:30:00.000Z')).toEqual(summary)
})
it('counts distinct reservations and send commitments separately from terminal outcomes', () => {
  approve(); reserve(); sendQaGrantUse(database, 'run-a', 'use-a', 1, now); settleQaGrantUse(database, 'run-a', 'use-a', 'failed', 503, now)
  const summary = sealQaHostSummary(database, 'run-a', now)
  expect(summary.grants[0]!.activities).toEqual([{ activity: 'report.generate', granted: 1, reserved: 1, sent: 1, succeeded: 0, failed: 1, uncertain: 0 }])
  expect(summary.audit.observedTraffic.map(row => row.result).sort()).toEqual(['failed', 'reserved', 'sent'])
  expect(canonicalJson(summary)).not.toMatch(/operationKey|requestSha256|queryKeys|\/paid\/report/)
})
it.each([false, true])('a pending use is sealed uncertain without refund; send commitment=%s', sent => {
  approve(); reserve(); if (sent) sendQaGrantUse(database, 'run-a', 'use-a', 1, now)
  const summary = publish()
  expect(summary.grants[0]!.activities[0]).toMatchObject({ reserved: 1, sent: sent ? 1 : 0, uncertain: 1 })
  expect(finishQa(root, JSON.stringify(report(summary)), { hostSummary: qaHostSummary(database, 'run-a') })).toMatchObject({ valid: false, verdict: null })
  expect(finishQa(root, JSON.stringify(report(summary, 'NO-GO')), { hostSummary: summary })).toMatchObject({ valid: true, verdict: 'NO-GO' })
})
it('admits a bound V2 report while requiring the host receipt rather than model-authored counters', () => {
  const summary = publish(), r = report(summary)
  expect(checkQaBrief(brief())).toEqual([])
  expect(finishQa(root, JSON.stringify(r), { hostSummary: qaHostSummary(database, 'run-a') })).toMatchObject({ valid: true, verdict: 'GO' })
  expect(finishQa(root, JSON.stringify({ ...r, counters: { succeeded: 100 } }), { hostSummary: summary })).toMatchObject({ valid: false })
  expect(finishQa(root, JSON.stringify(r))).toMatchObject({ valid: false })
})
it('rejects foreign, changed and missing receipt references without rewriting the submitted claim', () => {
  const summary = publish()
  for (const host_summary of [{ receiptId: 'foreign', sha256: report(summary).host_summary.sha256 }, { receiptId: summary.receiptId, sha256: 'a'.repeat(64) }]) {
    const r = { ...report(summary), host_summary }
    expect(finishQa(root, JSON.stringify(r), { hostSummary: summary })).toMatchObject({ valid: false })
    expect(JSON.parse(readFileSync(join(root, 'qa/report.json'), 'utf8')).host_summary).toEqual(host_summary)
  }
  expect(finishQa(root, JSON.stringify(report(summary)), { hostSummary: { ...summary, qaId: 'other' } })).toMatchObject({ valid: false })
})
it.each(['changed', 'symlink'])('refuses a %s local receipt even with the original model reference', kind => {
  const summary = publish(), path = join(root, 'host-summary.json')
  if (kind === 'changed') writeFileSync(path, canonicalJson({ ...summary, revision: 'other' }) + '\n')
  else { const other = join(root, 'other.json'); writeFileSync(other, canonicalJson(summary) + '\n'); rmSync(path); symlinkSync(other, path) }
  expect(finishQa(root, JSON.stringify(report(summary)), { hostSummary: summary })).toMatchObject({ valid: false })
})
it('an incomplete host audit requires NO-GO even when the UI goal and mandatory criteria passed', () => {
  closeQaAudit(database, 'run-a', 'broker-unreachable'); const summary = publish()
  expect(finishQa(root, JSON.stringify(report(summary)), { hostSummary: summary })).toMatchObject({ valid: false })
  expect(finishQa(root, JSON.stringify(report(summary, 'NO-GO')), { hostSummary: summary })).toMatchObject({ valid: true, verdict: 'NO-GO' })
})
it('V2 is session-only, requires matching intent, and never makes intent an owner grant', () => {
  const summary = publish(), r = report(summary), context = { hostSummary: summary, receiptSha256: r.host_summary.sha256 }
  expect(checkQaBrief({ ...brief(), mode: 'quick-web' }).length).toBeGreaterThan(0)
  expect(checkQaReport({ ...r, account_context: { ...r.account_context, used_accounts: [{ ...r.account_context.used_accounts[0], intent: 'test-full' }] } }, brief(), undefined, context).join('\n')).toContain('does not match brief')
  expect(checkQaReport({ ...r, version: 1 }, brief(), undefined, context).length).toBeGreaterThan(0)
  expect(summary.grants).toEqual([])
})
it('the local CLI accepts a bound receipt and names a missing V2 receipt', () => {
  const summary = publish(), r = report(summary), reportFile = join(root, 'report.json'), briefFile = join(root, 'brief.json')
  writeFileSync(reportFile, JSON.stringify(r)); writeFileSync(briefFile, JSON.stringify(brief()))
  let output = ''; const writer = { write: (text: string) => { output += text } }
  expect(runReportCheck([reportFile, '--brief', briefFile], { stdout: writer, stderr: writer })).toBe(1)
  expect(output).toContain('host receipt')
  expect(runReportCheck([reportFile, '--brief', briefFile, '--host-summary', join(root, 'host-summary.json')], { stdout: writer, stderr: writer })).toBe(0)
})
it('rejects malformed or private receipt fields even when their model digest is recomputed', () => {
  approve(); reserve(); sendQaGrantUse(database, 'run-a', 'use-a', 1, now); settleQaGrantUse(database, 'run-a', 'use-a', 'succeeded', 200, now)
  const original = publish()
  const mutations = [
    (s: typeof original) => { s.grants[0]!.activities[0]!.reserved = -1 },
    (s: typeof original) => { s.grants[0]!.activities[0]!.sent = 2 },
    (s: typeof original) => { s.audit.nextSequence++ },
    (s: typeof original) => { Object.assign(s, { cookies: 'synthetic-private' }) },
    (s: typeof original) => { Object.assign(s.grants[0]!.approval!, { operationKey: 'private' }) },
    (s: typeof original) => { s.grants.push(s.grants[0]!) }
  ]
  for (const mutate of mutations) {
    const summary = structuredClone(original); mutate(summary)
    const r = report(summary)
    expect(checkQaReport(r, brief(), undefined, { hostSummary: summary, receiptSha256: r.host_summary.sha256 }).join('\n')).toContain('host receipt')
  }
})
it.each([false, true])('the coordinator reconciles the submitted receipt with fresh sealed SQLite; tampered=%s', async tampered => {
  // Deliberate unit identities exercise the coordinator seam; they establish no native qualification.
  bindQaAgent(database, 'run-a', { pid: 101, ticks: '100', at: now }); connectQaRelay(database, 'run-a', { pid: 102, ticks: '101', at: now })
  approve()
  let live = true
  const operations = COMPANION_OPERATIONS as unknown as Record<string, (...args: unknown[]) => unknown>
  const client = { companion: async (name: string, ...args: unknown[]) => operations[name]!(database, ...args) } as unknown as DatabaseWorkerClient
  const service = new QaSessions({ database: client, data: root, cliPath: join(process.cwd(), 'apps/desktop/bin/bmn'), session: () => undefined,
    live: () => live ? 'qa-inc' : undefined, processId: () => undefined, launch: async () => { throw Error('not used') }, stop: async () => {}, now: () => now,
    accounts: { account: () => ({ id: 'account-a', name: 'Synthetic', origins: [origin], test: false, qaRevision: 1 }), contract: () => syntheticPaidContract(origin), qualified: () => true, changed: () => {} } })
  const ref = await service.request({ kind: 'session', sessionId: 'qa', incarnationId: 'qa-inc' }, 'qa.summary', {})
  const summary = qaHostSummary(database, 'run-a'), r = report(summary)
  expect(ref).toEqual(r.host_summary)
  if (tampered) {
    const row = database.prepare('SELECT record_json FROM qa_grant WHERE grant_id = ?').get('grant-a') as { record_json: string }
    const grant = JSON.parse(row.record_json); grant.terms.limits[0].count = 2
    database.prepare('UPDATE qa_grant SET record_json = ? WHERE grant_id = ?').run(JSON.stringify(grant), 'grant-a')
  }
  writeFileSync(join(root, 'codex-answer.md'), JSON.stringify(r)); live = false
  const result = await service.request({ kind: 'owner' }, 'qa.status', { id: 'run-a' }) as import('@bmn/protocol').QaRun
  expect(result).toMatchObject(tampered ? { state: 'failed', failure: 'QA_REPORT_INVALID' } : { state: 'finished', result: { valid: true, verdict: 'GO', hostSummary: summary } })
})
