// MODULE: qa-report.test.ts - Epic 100.2: report/brief binding, verdicts and invalid evidence, through the shared checker and CLI
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkQaReport } from '../../../../skills/manual-qa/check.mjs'

const SKILL = fileURLToPath(new URL('../../../../skills/manual-qa/', import.meta.url))
const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const finding = () => ({
  id: 'F1', category: 'functional', severity: 'minor', prerequisites: ['Synthetic cart is empty'], steps: ['Open Cart'],
  expected: 'Label fits', actual: 'Label is clipped', impact: 'Wording is hard to read', reproduction: { attempts: 2, observed: 1 },
  evidence: ['screenshots/cart.png'], status: 'open',
  retest: undefined as { steps: string[]; observations: string; regression_gaps: string[] } | undefined
})
function brief() {
  return {
    version: 1, revision: 'synthetic-build-a', target: 'http://127.0.0.1:4173', mode: 'quick-web', goal: 'Add a product to the cart', why: 'Keep a selected product',
    scope: { included: ['Cart'], excluded: ['Payment'] }, decisions: [], designs: [], regression_checklist: ['Open an empty cart'],
    starting_state: 'Signed out, empty cart', fixtures: ['Synthetic product'], accounts: [] as { alias: string; permission: string }[], time_budget_minutes: 10,
    criteria: [{ id: 'AC1', description: 'Product appears in cart', mandatory: true }, { id: 'AC2', description: 'Narrow viewport label fits', mandatory: false }]
  }
}
function report() {
  return {
    version: 1, revision: 'synthetic-build-a', target: 'http://127.0.0.1:4173', mode: 'quick-web',
    account_context: { signed_out: true, used_accounts: [] as { alias: string; permission: string; observed_restrictions: string[] }[], observed_restrictions: ['Signed-out disposable loopback context'] },
    goal_check: { status: 'achieved', execution: 'started', steps: ['Open product', 'Add to cart', 'Open cart'], observations: 'Selected product appeared' } as { status: string; execution: string; steps: string[]; observations: string; question?: string },
    criteria: ['AC1', 'AC2'].map(id => ({ id, status: 'PASS', steps: ['Exercise the stated case'], observations: 'Expected state appeared', evidence: [] as string[], finding_ids: [] as string[] })),
    findings: [] as ReturnType<typeof finding>[], debrief: { confidence: 'high', summary: 'Goal exercised on the named candidate', notes: [] as string[] },
    untested_areas: [] as string[], verdict: 'GO', audit_summary: undefined as { complete: boolean; observed_traffic: string[]; gaps: string[] } | undefined
  }
}
// Round-trip as actual JSON, so an omitted optional field is absent rather than an own `undefined` value.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const check = (r = report(), b = brief()) => checkQaReport(json(r), json(b))
type Report = ReturnType<typeof report>
type Brief = ReturnType<typeof brief>
function withIssue() {
  const r = report(); r.findings.push(finding()); r.criteria[1]!.status = 'FAIL'; r.criteria[1]!.finding_ids = ['F1']; r.verdict = 'GO WITH ISSUES'
  return r
}

describe('QA reports bound to the brief', () => {
  it('accepts the complete GO and low confidence without inventing another gate', () => {
    const r = report(); r.debrief.confidence = 'low'
    expect(check(r)).toEqual([])
  })
  it('accepts a reproduced optional failure only with its open minor finding', () => { expect(check(withIssue())).toEqual([]) })
  it('accepts optional verification gaps without inventing a defect', () => {
    for (const status of ['BLOCKED', 'NOT RUN']) {
      const r = report(); r.criteria[1]!.status = status; r.criteria[1]!.steps = []; r.untested_areas = ['AC2: viewport fixture unavailable']
      expect(check(r)).toEqual([])
    }
  })
  it('accepts an uncertain goal as NO-GO and a question, including execution that could not start', () => {
    const r = report(); r.goal_check = { status: 'uncertain', execution: 'not started', steps: [], observations: 'Target cannot be opened', question: 'Which target should be exercised?' }; r.verdict = 'NO-GO'
    expect(check(r)).toEqual([])
  })
  it('accepts a mandatory FAIL as a valid NO-GO report, not a valid release', () => {
    const r = withIssue(); r.criteria[0]!.status = 'FAIL'; r.criteria[0]!.finding_ids = ['F1']; r.verdict = 'NO-GO'
    expect(check(r)).toEqual([])
  })

  const bad: [string, (r: Report, b: Brief) => void, string][] = [
    ['wrong revision', r => { r.revision = 'another-build' }, 'revision'],
    ['wrong target', r => { r.target = 'another-target' }, 'target'],
    ['wrong mode', r => { r.mode = 'session' }, 'mode'],
    ['missing criterion', r => { r.criteria.pop() }, 'missing criterion AC2'],
    ['duplicate criterion', r => { r.criteria.push(r.criteria[0]!) }, 'duplicate'],
    ['unknown criterion', r => { r.criteria[1]!.id = 'AC3' }, 'unknown criterion'],
    ['duplicate brief criterion', (_r, b) => { b.criteria.push(b.criteria[0]!) }, 'brief.criteria'],
    ['blank observation', r => { r.criteria[0]!.observations = '  ' }, 'observations'],
    ['missing debrief', r => { Reflect.deleteProperty(r, 'debrief') }, 'debrief'],
    ['unknown nested field', r => { Object.assign(r.goal_check, { evidence_claim: 'copied lead evidence' }) }, 'unknown field'],
    ['wrong mandatory flag type', (_r, b) => { Object.assign(b.criteria[0]!, { mandatory: 'false' }) }, 'mandatory'],
    ['missing brief boundary', (_r, b) => { Reflect.deleteProperty(b.scope, 'excluded') }, 'excluded'],
    ['PASS with no steps', r => { r.criteria[0]!.steps = [] }, 'steps'],
    ['FAIL with no finding', r => { r.criteria[1]!.status = 'FAIL' }, 'finding_ids'],
    ['unknown finding reference', r => { r.criteria[1]!.finding_ids = ['missing'] }, 'unknown finding'],
    ['mandatory BLOCKED with GO', r => { r.criteria[0]!.status = 'BLOCKED'; r.untested_areas = ['AC1: service unavailable'] }, 'expected NO-GO'],
    ['mandatory NOT RUN with GO', r => { r.criteria[0]!.status = 'NOT RUN'; r.untested_areas = ['AC1: budget ended'] }, 'expected NO-GO'],
    ['undisclosed optional gap', r => { r.criteria[1]!.status = 'NOT RUN' }, 'untested_areas'],
    ['partly achieved with GO', r => { r.goal_check.status = 'partly' }, 'expected NO-GO'],
    ['not achieved with GO', r => { r.goal_check.status = 'not achieved' }, 'expected NO-GO'],
    ['uncertain without owner question', r => { r.goal_check.status = 'uncertain'; r.verdict = 'NO-GO' }, 'question'],
    ['started goal with no steps', r => { r.goal_check.steps = [] }, 'goal_check.steps'],
    ['claim achieved before execution', r => { r.goal_check.execution = 'not started' }, 'requires uncertain'],
    ['GO WITH ISSUES without an issue', r => { r.verdict = 'GO WITH ISSUES' }, 'expected GO'],
    ['unknown confidence', r => { r.debrief.confidence = 'certain' }, 'confidence'],
    ['unknown account alias', r => { r.account_context.signed_out = false; r.account_context.used_accounts = [{ alias: 'outside', permission: 'look-only', observed_restrictions: ['Look tools'] }] }, 'not in brief'],
    ['signed-in context without alias', r => { r.account_context.signed_out = false }, 'signed-in context'],
    ['quick mode with accounts', (_r, b) => { b.accounts = [{ alias: 'test', permission: 'test-full' }] }, 'quick modes']
  ]
  it.each(bad)('rejects %s with a field/contradiction', (_name, mutate, field) => {
    const r = report(), b = brief(); mutate(r, b)
    expect(check(r, b).join('\n')).toContain(field)
  })
  it.each(['id', 'category', 'severity', 'prerequisites', 'steps', 'expected', 'actual', 'impact', 'reproduction', 'evidence', 'status'])('requires finding.%s', field => {
    const r = withIssue(); Reflect.deleteProperty(r.findings[0]!, field)
    expect(check(r).join('\n')).toContain(`findings[0].${field}`)
  })
  it.each(['/etc/passwd', '../secret.png', 'a/../../secret.png', 'https://example.org/file', 'C:\\secret.png', './file.png'])('rejects unsafe evidence name %s', name => {
    const r = withIssue(); r.findings[0]!.evidence = [name]
    expect(check(r).join('\n')).toContain('relative local evidence')
  })
  it('does not let optionality downgrade an open major or blocker', () => {
    for (const severity of ['major', 'blocker']) {
      const r = withIssue(); r.findings[0]!.severity = severity
      expect(check(r).join('\n')).toContain('expected NO-GO')
      r.verdict = 'NO-GO'; expect(check(r)).toEqual([])
    }
  })
  it('requires bounded integer reproduction counts and unique finding IDs', () => {
    const r = withIssue(); r.findings[0]!.reproduction.observed = 3
    expect(check(r).join('\n')).toContain('cannot exceed attempts')
    r.findings[0]!.reproduction.observed = 0; expect(check(r).join('\n')).toContain('at least 1')
    r.findings[0]!.reproduction.observed = 1.5; expect(check(r).join('\n')).toContain('integer')
    r.findings[0]!.reproduction.observed = 1; r.findings.push(finding()); expect(check(r).join('\n')).toContain('duplicate')
  })
  it('requires current retest proof and never accepts resolved findings as a current FAIL', () => {
    const b = { ...brief(), prior_findings: [{ finding: json(finding()), disposition: 'Retest the original reproduction' }] }
    const r = withIssue(); r.findings[0]!.status = 'resolved'
    expect(checkQaReport(json(r), b).join('\n')).toContain('retest')
    r.findings[0]!.retest = { steps: ['Repeat original reproduction'], observations: 'Label now fits', regression_gaps: [] }
    expect(checkQaReport(json(r), b).join('\n')).toContain('cannot justify FAIL')
    r.criteria[1]!.status = 'PASS'; r.criteria[1]!.finding_ids = []; r.verdict = 'GO'
    expect(checkQaReport(json(r), b)).toEqual([])
  })
  it('keeps newly observed defects open on the frozen candidate, including intermittent blockers', () => {
    const r = report(); const f = finding(); f.severity = 'blocker'; f.reproduction = { attempts: 3, observed: 3 }; f.status = 'resolved'
    f.retest = { steps: ['Try once more'], observations: 'Not seen on the second try', regression_gaps: [] }; r.findings = [f]
    expect(check(r).join('\n')).toContain('found on this revision stays open')
    f.status = 'open'; r.verdict = 'NO-GO'
    expect(check(r).join('\n')).toContain('retest is only for a prior finding')
    f.retest = undefined; expect(check(r)).toEqual([])
  })
  it('requires a nonempty gap explanation after the criterion ID', () => {
    const r = report(); r.criteria[1]!.status = 'BLOCKED'; r.untested_areas = ['AC2:   ']
    expect(check(r).join('\n')).toContain('AC2: reason')
  })
  it('keeps earlier findings visible on retest and does not confuse AC1 with AC10 in gap disclosure', () => {
    const b = { ...brief(), prior_findings: [{ finding: json(finding()), disposition: 'Lead says repaired; retest the original steps' }] }
    expect(checkQaReport(json(report()), b).join('\n')).toContain('retain prior finding F1')
    const r = withIssue(); expect(checkQaReport(json(r), b)).toEqual([])
    r.criteria[0]!.status = 'BLOCKED'; r.untested_areas = ['AC10: different untested area']; r.verdict = 'NO-GO'
    expect(check(r).join('\n')).toContain('AC1: reason')
  })
  it('rejects rewriting a prior major finding as minor or changing its reproduction facts', () => {
    const prior = json(finding()); prior.severity = 'major'
    const b = { ...brief(), prior_findings: [{ finding: prior, disposition: 'Retest on the new build' }] }
    const r = withIssue()
    expect(checkQaReport(json(r), b).join('\n')).toContain('cannot rewrite prior finding facts')
    r.findings[0]!.severity = 'major'; r.verdict = 'NO-GO'; expect(checkQaReport(json(r), b)).toEqual([])
    r.findings[0]!.actual = 'Different observation'; expect(checkQaReport(json(r), b).join('\n')).toContain('actual')
    r.findings[0]!.actual = prior.actual; r.findings[0]!.reproduction.attempts = 3
    expect(checkQaReport(json(r), b).join('\n')).toContain('reproduction.attempts')
  })
  it('requires account-session audits and makes incomplete audit gaps visible', () => {
    const b = brief(), r = report(); b.mode = r.mode = 'session'; b.accounts = [{ alias: 'qa-test', permission: 'test-full' }]
    r.account_context = { signed_out: false, used_accounts: [{ alias: 'qa-test', permission: 'test-full', observed_restrictions: ['Test account tools observed'] }], observed_restrictions: ['Session context observed'] }
    expect(check(r, b).join('\n')).toContain('audit_summary')
    r.audit_summary = { complete: false, observed_traffic: [], gaps: [] }; expect(check(r, b).join('\n')).toContain('incomplete audit needs gaps')
    r.audit_summary.gaps = ['Audit capture started late']; expect(check(r, b)).toEqual([])
    r.audit_summary = { complete: true, observed_traffic: ['Observed a synthetic page request'], gaps: [] }; expect(check(r, b)).toEqual([])
    r.account_context.used_accounts[0]!.permission = 'look-only'; expect(check(r, b).join('\n')).toContain('does not match brief')
    r.account_context.used_accounts[0]!.permission = 'test-full'; r.account_context.used_accounts[0]!.observed_restrictions = []
    expect(check(r, b).join('\n')).toContain('observed_restrictions')
  })
  it('refuses unsupported schema keywords instead of silently ignoring a future constraint', () => {
    const schema = JSON.parse(readFileSync(join(SKILL, 'schema.json'), 'utf8'))
    schema.$defs.text.pattern = '\\S'
    expect(checkQaReport(json(report()), brief(), schema).join('\n')).toContain('unsupported schema keyword')
  })
  it('refuses constraints adjacent to a ref instead of silently skipping them', () => {
    const schema = JSON.parse(readFileSync(join(SKILL, 'schema.json'), 'utf8'))
    schema.$defs.criterion.properties.id.minLength = 100
    expect(checkQaReport(json(report()), brief(), schema).join('\n')).toContain('unsupported constraint alongside $ref')
  })
})

describe('the local command and packaged resource layout', () => {
  it('uses the same checker from BMN, the installed skill and packaged resources, with meaningful exit codes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-qa-report-'))
    try {
      const b = join(root, 'brief.json'), r = join(root, 'report.json')
      writeFileSync(b, JSON.stringify(brief())); writeFileSync(r, JSON.stringify(report()))
      const run = (entry: string, args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8' })
      const checked = run(BMN, ['qa', 'report', 'check', r, '--brief', b])
      expect(checked.error).toBeUndefined()
      expect(checked).toMatchObject({ status: 0, stdout: expect.stringContaining('PASS') })
      expect(run(join(SKILL, 'check.mjs'), [r, '--brief', b]).status).toBe(0)
      const resources = join(root, 'resources'); mkdirSync(join(resources, 'bin'), { recursive: true })
      cpSync(fileURLToPath(new URL('../../bin/qa-cli.mjs', import.meta.url)), join(resources, 'bin/qa-cli.mjs'))
      cpSync(SKILL, join(resources, 'skills/manual-qa'), { recursive: true })
      const entry = join(resources, 'bin/entry.mjs'); writeFileSync(entry, 'import {runQaCommand} from "./qa-cli.mjs"; process.exitCode=await runQaCommand(process.argv.slice(2));\n')
      expect(run(entry, ['report', 'check', r, '--brief', b]).status).toBe(0)
      const invalid = report(); invalid.criteria.pop(); writeFileSync(r, JSON.stringify(invalid))
      expect(run(BMN, ['qa', 'report', 'check', r, '--brief', b])).toMatchObject({ status: 1, stderr: expect.stringContaining('missing criterion AC2') })
      writeFileSync(r, '{ invalid JSON'); expect(run(BMN, ['qa', 'report', 'check', r, '--brief', b]).status).toBe(1)
      expect(run(BMN, ['qa', 'report', 'check', r]).status).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
