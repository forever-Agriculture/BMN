// MODULE: agents-called.test.ts - Story 65.1: an agent the team file marks as called by BMN itself, the role judge only it holds, and every place that offers agents for work leaving it out
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JUDGE_PROPOSAL, calledParties, judgeProposal, judges, namedResearchers, parseRoster, privateWorkOf, researcherProposal, rewriteRoster, roleChain, roleChainText, starterRoster,
  team, teamLine
} from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'
import { machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { researchers } from '../../bin/agents-research.mjs'
import { teamPhrase } from '../../bin/agents-rules.mjs'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')

let home: string
const savedHome = process.env.HOME

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-called-')))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

/** Replaces exactly one occurrence, so a fixture edit that misses fails loudly instead of testing nothing. */
function edit(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`fixture edit expected one "${from}", found ${count}`)
  return text.replace(from, to)
}

const JEV_BLOCK = [
  'name: Jev', 'class: bishop', 'harness: bmn', 'model: jev-1.13', 'provider: gateway', 'run_by: maker', 'host: gateway.example.test', 'enabled: true', 'status: active',
  'roles: [judge]', 'paid_by: per_token', 'price: {input: 0.042, output: 0, source: "https://prices.example.test/jev", as_of: 2026-10-12}'
].join('\n')
const JUDGE_ROLE_LINE = 'judge: {description: answers typed questions about a text with numbers; advice only, candidates: [jev], then: skip}'

/** The example team in the newest layout with a judge on it: who receives its request, who runs its model, the agent and the role. */
function withJudge({ receives = 'allowed', runs = 'allowed', block = JEV_BLOCK, role = JUDGE_ROLE_LINE }: { receives?: string; runs?: string; block?: string; role?: string } = {}): string {
  let text = edit(EXAMPLE, 'schema_version: 2', 'schema_version: 3')
  text = edit(text, 'cursor: {name: Cursor, hosts: [], private_work: public_only}\n',
    `cursor: {name: Cursor, hosts: [], private_work: public_only}\ngateway: {name: Gateway, hosts: [gateway.example.test], private_work: ${receives}}\nmaker: {name: Maker, hosts: [], private_work: ${runs}}\n`)
  text = edit(text, '## roles\n', `## jev\n\n\`\`\`yaml\n${block}\n\`\`\`\n\n## roles\n`)
  return edit(text, 'consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}\n',
    `consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}\n${role}\n`)
}

function problems(text: string): { code: string; line: string }[] {
  const lines = text.split('\n')
  return parseRoster(text).errors.map((error) => ({ code: error.code, line: error.line === undefined ? '' : (lines[error.line - 1] ?? '') }))
}

function approve(text: string) {
  const folder = join(home, '.config/bmn/agents')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'roster.md'), text)
  return approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('BMN_') && !key.startsWith('AITERM_')) clean[key] = value
  }
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...clean, HOME: home }, timeout: 15_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }))
    child.stdin?.end()
  })
}

describe('an agent called by BMN in the team file (65.1 AC1)', () => {
  it('is read with its two parties and no efforts, and written back as it stands', () => {
    const text = withJudge()
    const parsed = parseRoster(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.data?.schema_version).toBe(3)
    expect(parsed.data?.agents.find((agent) => agent.id === 'jev')).toEqual({
      id: 'jev', name: 'Jev', class: 'bishop', harness: 'bmn', model: 'jev-1.13', provider: 'gateway', run_by: 'maker', host: 'gateway.example.test', enabled: true, status: 'active',
      efforts: [], roles: ['judge'], paid_by: 'per_token', price: { input: 0.042, output: 0, source: 'https://prices.example.test/jev', as_of: '2026-10-12' }
    })
    expect(parsed.data?.roles.find((role) => role.id === 'judge')).toEqual({ id: 'judge', description: 'answers typed questions about a text with numbers; advice only', candidates: ['jev'], then: 'skip' })
    // No efforts line is added for it, and nothing else moves.
    expect(rewriteRoster(text, parsed.data!)).toBe(text)
  })

  const refused: [string, (text: string) => string, string, string][] = [
    ['efforts', (t) => edit(t, 'status: active\nroles: [judge]', 'status: active\nefforts: [low]\nroles: [judge]'), 'CALLED_FIELD', 'efforts: [low]'],
    ['a context limit', (t) => edit(t, 'roles: [judge]\n', 'roles: [judge]\ncontext_limit: 100000\n'), 'CALLED_FIELD', 'context_limit: 100000'],
    ['a context window', (t) => edit(t, 'roles: [judge]\n', 'roles: [judge]\ncontext_window: 64000\n'), 'CALLED_FIELD', 'context_window: 64000'],
    ['the researcher mark', (t) => edit(t, 'roles: [judge]\n', 'roles: [judge]\nresearcher: true\n'), 'CALLED_FIELD', 'researcher: true'],
    ['another role of its own', (t) => edit(t, 'roles: [judge]\n', 'roles: [judge, helper]\n'), 'CALLED_ROLE', 'roles: [judge, helper]'],
    ['no word on who runs the model', (t) => edit(t, 'run_by: maker\n', ''), 'MISSING_FIELD', 'harness: bmn'],
    ['a runner the team does not name', (t) => edit(t, 'run_by: maker\n', 'run_by: nobody\n'), 'UNKNOWN_PROVIDER', 'run_by: nobody'],
    ['the app\'s default as its host', (t) => edit(t, 'host: gateway.example.test', 'host: default'), 'INVALID_VALUE', 'host: default']
  ]
  for (const [name, change, code, line] of refused) {
    it(`refuses one with ${name}, at its line`, () => {
      expect(problems(change(withJudge()))).toEqual([{ code, line }])
    })
  }

  it('refuses it in a file that still says schema 2, and says what schema 3 added', () => {
    const text = edit(withJudge(), 'schema_version: 3', 'schema_version: 2')
    const errors = parseRoster(text).errors
    expect(errors.map((error) => error.code)).toContain('SCHEMA_VERSION')
    expect(errors.find((error) => error.code === 'SCHEMA_VERSION')?.message).toMatch(/needs schema_version: 3 .* this file says 2.*an agent called by BMN itself/)
  })

  it('refuses who-runs-the-model on an agent that runs in an app', () => {
    expect(problems(edit(EXAMPLE, 'name: Luna\nclass: pawn', 'name: Luna\nrun_by: openai\nclass: pawn'))).toEqual([{ code: 'CALLED_ONLY', line: 'run_by: openai' }])
  })

  it('reads a team file from before as it was, and it stays approved', () => {
    const before = parseRoster(EXAMPLE)
    expect(before.errors).toEqual([])
    expect(before.data?.schema_version).toBe(2)
    expect(rewriteRoster(EXAMPLE, before.data!)).toBe(EXAMPLE)
    const approved = approve(EXAMPLE)
    expect(approved.number).toBe(1)
    // The approved version is the one in force, and the file beside it shows no change to approve.
    const generation = readApproved()
    expect(generation.data.schema_version).toBe(2)
    expect(machineDiff(generation.data, readValidRoster().data)).toEqual([])
    // A new team is written in the newest layout.
    expect(parseRoster(starterRoster()).data?.schema_version).toBe(3)
  })
})

describe('the two parties of a called agent (65.1 AC2)', () => {
  const cases: [string, string, 'allowed' | 'public_only', string][] = [
    ['allowed', 'allowed', 'allowed', 'Gateway and Maker may see private work'],
    ['allowed', 'public_only', 'public_only', 'public work only: Maker gets public work only'],
    ['public_only', 'allowed', 'public_only', 'public work only: Gateway gets public work only'],
    ['public_only', 'public_only', 'public_only', 'public work only: Gateway and Maker get public work only']
  ]
  for (const [receives, runs, answer, reason] of cases) {
    it(`reads ${answer} where who receives says ${receives} and who runs says ${runs}`, () => {
      const data = parseRoster(withJudge({ receives, runs })).data!
      const jev = data.agents.find((agent) => agent.id === 'jev')!
      expect(privateWorkOf(data, jev)).toBe(answer)
      expect(calledParties(data, jev)).toMatchObject({ receives: { id: 'gateway', private_work: receives }, runs: { id: 'maker', private_work: runs }, allowed: answer === 'allowed', reason })
      expect(team(data, true).find((entry) => entry.id === 'jev')?.private_work).toBe(answer)
    })
  }
})

describe('the role judge (65.1 AC3)', () => {
  it('refuses a called agent as a candidate of another role', () => {
    const asHelper = edit(withJudge(), 'candidates: [luna@max], then: lead}\nfocused-reviewer', 'candidates: [luna@max, jev@low], then: lead}\nfocused-reviewer')
    expect(problems(asHelper).map((problem) => problem.code)).toEqual(['CALLED_ROLE'])
    expect(parseRoster(asHelper).errors[0]?.message).toMatch(/jev is called by BMN and may be a candidate of the role judge only/)
  })

  it('refuses an agent that runs in an app as a candidate of judge, and as a holder of it', () => {
    const asCandidate = withJudge({ role: 'judge: {candidates: [jev, luna], then: skip}' })
    expect(problems(asCandidate).map((problem) => problem.code)).toEqual(['JUDGE_NOT_CALLED'])
    expect(parseRoster(asCandidate).errors[0]?.message).toMatch(/only an agent called by BMN may be a candidate of judge, and luna runs in Codex/)
    const asHolder = edit(withJudge(), 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]', 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer, judge]')
    expect(problems(asHolder)).toEqual([{ code: 'JUDGE_NOT_CALLED', line: 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer, judge]' }])
  })

  it('refuses a judge with an effort, and a judge role with a field of the roles apps run', () => {
    expect(problems(withJudge({ role: 'judge: {candidates: [jev@low], then: skip}' })).map((problem) => problem.code)).toEqual(['INVALID_VALUE'])
    expect(problems(withJudge({ role: 'judge: {candidates: [jev], then: skip, read_only: true}' })).map((problem) => problem.code)).toEqual(['INVALID_VALUE'])
  })

  it('refuses a called agent whose role is not in the roles', () => {
    const text = edit(withJudge(), `${JUDGE_ROLE_LINE}\n`, '')
    expect(problems(text)).toEqual([{ code: 'ROLE_UNKNOWN', line: 'roles: [judge]' }])
  })
})

describe('where agents are offered for work (65.1 AC4)', () => {
  it('names the called agent in no role chain but its own, and says there how it is asked', () => {
    const data = parseRoster(withJudge()).data!
    for (const role of data.roles.filter((entry) => entry.id !== 'judge')) {
      expect(JSON.stringify(roleChain(data, role.id)), role.id).not.toContain('jev')
    }
    const chain = roleChain(data, 'judge')
    expect(chain).toMatchObject({ role: 'judge', called_by: 'bmn' })
    const text = roleChainText(chain)
    expect(text).toContain('1. jev  ')
    expect(text).not.toContain('jev@')
    expect(text).toContain('called by BMN: no dispatch goes to this role; ask it with `bmn judge ask`')
    expect(judges(data).map((agent) => agent.id)).toEqual(['jev'])
  })

  it('lists it in `bmn team` with "called by BMN" where the others name their app', () => {
    const data = parseRoster(withJudge({ runs: 'public_only' })).data!
    const lines = team(data, true).map(teamLine)
    const jev = lines.find((line) => line.startsWith('jev '))
    expect(jev).toBe('jev  Jev  bishop  called by BMN  jev-1.13  provider=gateway  run-by=maker  private-work=public-only  roles=judge')
    expect(lines.find((line) => line.startsWith('luna '))).toMatch(/^luna {2}Luna {2}pawn {2}codex {2}.* efforts=max {2}context-limit=app default$/)
  })

  it('never names it a researcher, also where its class would be proposed', () => {
    const pawn = parseRoster(edit(withJudge(), 'name: Jev\nclass: bishop', 'name: Jev\nclass: pawn')).data!
    expect(researcherProposal(pawn)).not.toContain('jev')
    expect(namedResearchers(pawn)).toBeNull()
    approve(withJudge())
    expect(researchers().map((entry) => entry.id)).not.toContain('jev')
  })

  it('writes it into no app\'s rules Team line', () => {
    approve(withJudge())
    const phrase = teamPhrase(readApproved())
    expect(phrase.text).toContain('Luna')
    expect(phrase.text).not.toContain('Jev')
  })

  it('refuses a dispatch check for it with a code of its own whose next names `bmn judge ask`', async () => {
    approve(withJudge())
    const refusedCheck = await runCli(['roster', 'check', '--agent', 'jev', '--role', 'judge', '--workspace', home, '--data', 'public', '--json', '--', 'codex', 'exec', '-m', 'jev-1.13', '-'])
    const verdict = JSON.parse(refusedCheck.stdout)
    expect(verdict).toMatchObject({ verdict: 'REFUSED', code: 'CALLED_BY_BMN' })
    expect(verdict.next).toContain('bmn judge ask')
    expect(refusedCheck.code).not.toBe(0)
    const teamOut = await runCli(['team', '--all'])
    expect(teamOut.stdout).toMatch(/^jev {2}Jev {2}bishop {2}called by BMN {2}jev-1\.13 {2}/m)
    const role = await runCli(['roster', 'role', 'judge'])
    expect(role.stdout).toContain('called by BMN: no dispatch goes to this role')
  })
})

describe("BMN's first proposal for a judge (65.1 AC7)", () => {
  it('adds the two providers, the role and Jev, in the newest layout, and is nothing once taken', () => {
    const before = parseRoster(EXAMPLE).data!
    const proposed = judgeProposal(before)!
    expect(proposed.schema_version).toBe(3)
    expect(proposed.providers.slice(-2)).toEqual([JUDGE_PROPOSAL.receives, JUDGE_PROPOSAL.runs])
    expect(proposed.providers.slice(-2).map((provider) => `${provider.id}:${provider.private_work}`)).toEqual(['opencode-zen:allowed', 'typesafe:allowed'])
    expect(proposed.agents.at(-1)).toMatchObject({ id: 'jev', name: 'Jev', class: 'bishop', harness: 'bmn', model: 'jev-1.13', provider: 'opencode-zen', run_by: 'typesafe', host: 'opencode.ai', enabled: true, status: 'active', roles: ['judge'] })
    expect(proposed.roles.at(-1)).toEqual({ id: 'judge', description: 'answers typed questions about a text with numbers; advice only', candidates: ['jev'], then: 'skip' })
    // What the proposal says is what the file says once written, and it reads back whole.
    const written = rewriteRoster(EXAMPLE, proposed)
    const again = parseRoster(written)
    expect(again.errors).toEqual([])
    expect(again.data).toEqual(proposed)
    expect(privateWorkOf(again.data!, again.data!.agents.at(-1)!)).toBe('allowed')
    expect(judgeProposal(again.data!)).toBeNull()
    // Everything the team said before is still what it says.
    expect(again.data!.agents.slice(0, -1)).toEqual(before.agents)
    expect(again.data!.roles.slice(0, -1)).toEqual(before.roles)
  })

  it('keeps the answer of a provider the team already names for that host', () => {
    const held = parseRoster(edit(EXAMPLE, 'opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [opencode.ai], private_work: public_only}')).data!
    const proposed = judgeProposal(held)!
    expect(proposed.providers.map((provider) => provider.id)).not.toContain('opencode-zen')
    const jev = proposed.agents.at(-1)!
    expect(jev.provider).toBe('opencode-go')
    expect(privateWorkOf(proposed, jev)).toBe('public_only')
    expect(calledParties(proposed, jev).reason).toBe('public work only: OpenCode Go gets public work only')
  })
})
