// MODULE: qa-ask.test.ts - quick-QA input restrictions and verdicts bound to retained browser evidence
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { browserTools } from '../../bin/agents-team-browser.mjs'
import { finishQa, qaAskInputs } from '../../bin/agents-team-qa.mjs'

const ORIGIN = 'http://127.0.0.1:4173'
const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const RELAY = fileURLToPath(new URL('../../bin/ask-browser-relay.mjs', import.meta.url))
const roots: string[] = []
const folder = () => { const root = mkdtempSync(join(tmpdir(), 'bmn-qa-ask-')); roots.push(root); return root }
const brief = () => ({
  version: 1, revision: 'synthetic-build', target: ORIGIN, mode: 'quick-web', goal: 'Keep a selected product in the cart', why: 'Complete a selection',
  scope: { included: ['Cart'], excluded: ['Payment'] }, decisions: [], designs: [], regression_checklist: ['Empty cart'], starting_state: 'Signed out, empty cart',
  fixtures: ['Synthetic product'], accounts: [] as { alias: string; permission: string }[], time_budget_minutes: 5,
  criteria: [{ id: 'AC1', description: 'Selected product appears', mandatory: true }]
})
const report = () => ({
  version: 1, revision: 'synthetic-build', target: ORIGIN, mode: 'quick-web',
  account_context: { signed_out: true, used_accounts: [], observed_restrictions: ['Signed-out synthetic app'] },
  goal_check: { status: 'achieved', execution: 'started', steps: ['Select a product', 'Open cart'], observations: 'Selected product appears' },
  criteria: [{ id: 'AC1', status: 'PASS', steps: ['Select product'], observations: 'Product appears', evidence: ['browser/cart.png'], finding_ids: [] }],
  findings: [], debrief: { confidence: 'high', summary: 'Selection exercised', notes: [] }, untested_areas: [], verdict: 'GO'
})
function recorded(calls = 3) {
  const root = folder()
  mkdirSync(join(root, 'inputs'))
  writeFileSync(join(root, 'inputs/manifest.json'), JSON.stringify({ qa: { brief: brief() } }))
  writeFileSync(join(root, 'browser.json'), JSON.stringify({ calls, pages: [{ url: ORIGIN, title: 'Cart' }], screenshots: [{ name: 'cart.png', bytes: 4, sha256: 'synthetic' }] }))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('quick QA contract', () => {
  it('omits unsafe callbacks for QA while preserving existing browser interactions', () => {
    expect(browserTools(true, true)).toContain('browser_click')
    expect(browserTools(true, true)).toContain('browser_evaluate')
    expect(browserTools(true, true)).not.toContain('browser_run_code_unsafe')
    expect(browserTools(true)).toContain('browser_run_code_unsafe')
  })
  it('supplies only the checked brief and shared skill/report/schema', () => {
    const root = folder(), path = join(root, 'brief.json')
    writeFileSync(path, JSON.stringify(brief()))
    const input = qaAskInputs(path, { origin: ORIGIN })
    expect(input.files.map(path => path.split('/').at(-1))).toEqual(['brief.json', 'SKILL.md', 'report.md', 'schema.json'])
    expect(input.brief).toEqual(brief())
    expect(input.question).toContain('Do not inspect implementation')
  })
  it.each(['target', 'accounts', 'mode', 'duplicate', 'mandatory'])('refuses an invalid %s brief before dispatch', kind => {
    const b = brief()
    if (kind === 'target') b.target = 'http://127.0.0.1:4174'
    if (kind === 'accounts') b.accounts.push({ alias: 'Synthetic account', permission: 'look-only' })
    if (kind === 'mode') b.mode = 'session'
    if (kind === 'duplicate') b.criteria.push({ ...b.criteria[0]! })
    if (kind === 'mandatory') delete (b.criteria[0] as Partial<typeof b.criteria[0]>)!.mandatory
    const path = join(folder(), 'brief.json'); writeFileSync(path, JSON.stringify(b))
    expect(() => qaAskInputs(path, { origin: ORIGIN })).toThrow()
  })
  it('keeps a valid report and gives its verdict only with native evidence', () => {
    const root = recorded(), r = report()
    expect(finishQa(root, JSON.stringify(r))).toMatchObject({ valid: true, verdict: 'GO', errors: [] })
    expect(JSON.parse(readFileSync(join(root, 'qa/report.json'), 'utf8'))).toEqual(r)
  })
  it.each(['revision', 'missing-screenshot', 'no-browser', 'prose'])('withholds the verdict for %s', kind => {
    const root = recorded(kind === 'no-browser' ? 0 : 3), r = report()
    if (kind === 'revision') r.revision = 'other-build'
    if (kind === 'missing-screenshot') r.criteria[0]!.evidence = ['browser/invented.png']
    const result = finishQa(root, kind === 'prose' ? `Here is the report: ${JSON.stringify(r)}` : JSON.stringify(r))!
    expect(result.valid).toBe(false); expect(result.verdict).toBeNull(); expect(result.errors.length).toBeGreaterThan(0)
  })
  it('does not create QA results for a normal teammate ask', () => {
    const root = folder(); mkdirSync(join(root, 'inputs')); writeFileSync(join(root, 'inputs/manifest.json'), '{}')
    expect(finishQa(root, 'A normal answer')).toBeNull()
  })
  it('refuses an unbounded bench without starting a teammate or reading the brief', () => {
    const result = spawnSync(process.execPath, [BMN, 'team', 'ask', '--role', 'qa', '--brief', 'absent.json', '--bench', '--json'], { encoding: 'utf8' })
    expect(result.status).toBe(10)
    expect(JSON.parse(result.stdout).refusal.code).toBe('QA_BENCH_UNAVAILABLE')
  })
  it('filters server tool discovery and refuses unsafe/account calls before the backend receives them', () => {
    const root = folder(), calls = join(root, 'calls.jsonl')
    const backend = `const fs=require('node:fs'); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); let result={}; if(m.method==='tools/list') result={tools:[{name:'browser_click'},{name:'browser_run_code_unsafe'},{name:'browser_account_pick'}]}; if(m.method==='tools/call'){fs.appendFileSync(process.argv[1],JSON.stringify(m)+'\\n');result={content:[{type:'text',text:m.params.name}]};} if(m.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`
    const messages = [
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: { code: 'unsafe sentinel' } } },
      { id: 3, method: 'tools/call', params: { name: 'browser_account_pick', arguments: { name: 'Synthetic account' } } },
      { id: 4, method: 'tools/call', params: { name: 'browser_click', arguments: {} } }
    ]
    const child = spawnSync(process.execPath, [RELAY, root, join(root, 'temporary'), '--qa', process.execPath, '-e', backend, calls], {
      input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n', encoding: 'utf8', timeout: 10_000
    })
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
    const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(replies.find(reply => reply.id === 1).result.tools).toEqual([{ name: 'browser_click' }])
    expect(replies.find(reply => reply.id === 2).error.message).toContain('unavailable')
    expect(replies.find(reply => reply.id === 3).error.message).toContain('unavailable')
    expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line).params.name)).toEqual(['browser_click'])
  })
})
