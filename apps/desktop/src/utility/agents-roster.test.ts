// MODULE: agents-roster.test.ts - Epic 60.1/60.2: roster validation, the golden role table, team output and approved-state reads
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, proseOf, rewriteProse, rewriteRoster, starterRoster } from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'
import { buildGeneration, currentPointerPath, generationPath, listGenerations, machineDiff, readApproved, readValidRoster } from '../../bin/agents-state.mjs'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
/** Prose, notes, prices, role descriptions and exception folders: none may reach an agent-facing output. */
const SENTINELS = ['PROSE-SENTINEL', 'NOTE-SENTINEL', 'PRICE-SENTINEL', 'DESCRIPTION-SENTINEL', 'EXCEPTION-SENTINEL']

let home: string
const savedHome = process.env.HOME

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-roster-')))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function writeRoster(text: string): string {
  const folder = join(home, '.config/bmn/agents')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'roster.md'), text)
  return join(folder, 'roster.md')
}

function approveFile(text = EXAMPLE) {
  writeRoster(text)
  const roster = readValidRoster()
  return approveRoster({ generation: null, fileHash: roster.hash }, { checkInspectedRoutes: () => {} })
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('BMN_') && !key.startsWith('AITERM_')) clean[key] = value
  }
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...clean, HOME: home, ...env }, timeout: 15_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }))
    child.stdin?.end()
  })
}

/** Replaces exactly one occurrence, so a fixture edit that misses fails loudly instead of testing nothing. */
function edit(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`fixture edit expected one "${from}", found ${count}`)
  return text.replace(from, to)
}

function codes(text: string): string[] {
  return parseRoster(text).errors.map((error) => error.code)
}

describe('roster validation (60.1 AC1, AC2)', () => {
  it('accepts the synthetic example with every field type', () => {
    const parsed = parseRoster(EXAMPLE)
    expect(parsed.errors).toEqual([])
    expect(parsed.data?.schema_version).toBe(2)
    expect(parsed.data?.agents.map((agent) => agent.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna', 'sonnet', 'haiku', 'glm'])
    expect(parsed.data?.agents.map((agent) => agent.class)).toEqual(['knight', 'knight', 'bishop', 'queen', 'pawn', 'bishop', 'pawn', 'pawn'])
    expect(parsed.data?.roles).toHaveLength(10)
    expect(parsed.data?.providers.map((provider) => `${provider.id}:${provider.private_work}`))
      .toEqual(['openai:allowed', 'anthropic:allowed', 'zai:public_only', 'opencode-go:public_only', 'cursor:public_only'])
    expect(parsed.data?.exceptions).toEqual([{ id: 'zai-synthetic', provider: 'zai', folder: '/synthetic/EXCEPTION-SENTINEL-FOLDER' }])
    expect(parsed.data?.harness_routes.map((route) => route.harness)).toEqual(['claude', 'codex', 'opencode', 'cursor'])
    expect(parsed.data?.agents.find((agent) => agent.id === 'sol')).toMatchObject({
      context_window: 400000, context_limit: 272000, paid_by: 'subscription',
      price: { input: 1.25, cached_input: 0.125, output: 10, as_of: '2026-10-01' }
    })
    // A disabled candidate is reported, never refused.
    const withDisabled = edit(EXAMPLE, 'helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}',
      'helper: {candidates: [luna@max], then: lead}\nchores: {candidates: [glm@low], then: lead}')
      .replace('efforts: []\nroles: [helper]', 'efforts: [low]\nroles: [helper, chores]')
    expect(codes(withDisabled)).toEqual([])
    expect(parseRoster(withDisabled).warnings.map((w) => w.code)).toContain('CANDIDATE_DISABLED')
  })

  it('ships a starter roster with no agents and five editable roles, in universal words', () => {
    const parsed = parseRoster(starterRoster())
    expect(parsed.errors).toEqual([])
    expect(parsed.data?.agents).toEqual([])
    expect(parsed.data?.roles.map((role) => `${role.id}: ${role.description}`)).toEqual([
      'lead: leads an epic/project start to finish', 'designer: designs and thinks creatively', 'helper: does small jobs a lead hands off',
      'reviewer: judges finished work', "advisor: answers a lead's hard questions"
    ])
    expect(starterRoster()).not.toMatch(/BMAD|dev-auto|sprint|story/i)
    // Written the way BMN writes it back, so a first save changes nothing it did not have to.
    expect(rewriteRoster(starterRoster(), parsed.data!)).toBe(starterRoster())
  })

  const SOL_CONTEXT = 'context_window: 400000\ncontext_limit: 272000'
  const refusals: [string, (text: string) => string, string][] = [
    ['unsupported schema version', (t) => edit(t, 'schema_version: 2', 'schema_version: 3'), 'SCHEMA_VERSION'],
    ['schema 1', (t) => edit(t, 'schema_version: 2', 'schema_version: 1'), 'SCHEMA_VERSION'],
    ['missing schema section', (t) => edit(t, '## roster\n\n```yaml\nschema_version: 2\n```\n', ''), 'SCHEMA_VERSION'],
    ['duplicate agent id', (t) => `${t}\n## luna\n\n\`\`\`yaml\nname: x\n\`\`\`\n`, 'DUPLICATE_ID'],
    ['duplicate key', (t) => edit(t, 'name: Luna\n', 'name: Luna\nname: Luna2\n'), 'DUPLICATE_KEY'],
    ['duplicate yaml block', (t) => edit(t, 'Deactivated in this example.', '```yaml\nname: other\n```\nDeactivated in this example.'), 'DUPLICATE_BLOCK'],
    ['unknown field', (t) => edit(t, 'name: Luna\n', 'name: Luna\nrank: knight\n'), 'UNKNOWN_FIELD'],
    ['a schema-1 field', (t) => edit(t, 'name: Luna\n', 'name: Luna\ntrust: 2\n'), 'UNKNOWN_FIELD'],
    ['value outside an enum', (t) => edit(t, 'name: Luna\nclass: pawn', 'name: Luna\nclass: squire'), 'INVALID_VALUE'],
    ['text over its bound', (t) => edit(t, 'name: Luna\n', `name: ${'L'.repeat(41)}\n`), 'INVALID_VALUE'],
    ['null in an optional field', (t) => edit(t, 'aliases: [fable]', 'aliases: null'), 'NULL_OPTIONAL'],
    ['null in a required field', (t) => edit(t, 'name: Luna\nclass: pawn', 'name: Luna\nclass: null'), 'INVALID_VALUE'],
    ['null efforts', (t) => edit(t, 'efforts: [max]', 'efforts: null'), 'INVALID_VALUE'],
    ['candidate effort the agent does not list', (t) => edit(t, 'browser: {candidates: [luna@max]', 'browser: {candidates: [luna@high]'), 'EFFORT_NOT_LISTED'],
    ['candidate lacking the role', (t) => edit(t, 'candidates: [luna@max], then: lead}\nfocused', 'candidates: [luna@max, astra@low], then: lead}\nfocused'), 'ROLE_NOT_HELD'],
    ['a pawn holding the lead role', (t) => edit(t, 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]', 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer, lead]'), 'CLASS_CANNOT_LEAD'],
    ['a bishop holding the lead role', (t) => edit(t, 'roles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]', 'roles: [lead, focused-reviewer, epic-reviewer, final-reviewer, consultant]'), 'CLASS_CANNOT_LEAD'],
    ['a queen holding the lead role', (t) => edit(t, 'roles: [designer, epic-reviewer, final-reviewer, consultant]', 'roles: [lead, designer, epic-reviewer, final-reviewer, consultant]'), 'CLASS_CANNOT_LEAD'],
    ['a knight holding the designer role', (t) => edit(t, 'roles: [lead]\ncontext_window', 'roles: [lead, designer]\ncontext_window'), 'CLASS_CANNOT_DESIGN'],
    ['a bishop holding the designer role', (t) => edit(t, 'roles: [focused-reviewer, epic-reviewer, final-reviewer, consultant]', 'roles: [designer, focused-reviewer, epic-reviewer, final-reviewer, consultant]'), 'CLASS_CANNOT_DESIGN'],
    ['a queen made bishop while holding the designer role', (t) => edit(t, 'name: Fable\nclass: queen', 'name: Fable\nclass: bishop'), 'CLASS_CANNOT_DESIGN'],
    ['a bishop in the lead chain', (t) => edit(t, 'candidates: [sol@xhigh, opus@xhigh]', 'candidates: [sol@xhigh, opus@xhigh, astra@high]'), 'ROLE_NOT_HELD'],
    ['candidate naming an unknown agent', (t) => edit(t, 'browser: {candidates: [luna@max]', 'browser: {candidates: [nova@max]'), 'UNKNOWN_AGENT'],
    ['agent naming an unknown provider', (t) => edit(t, 'model: gpt-6-luna\nprovider: openai', 'model: gpt-6-luna\nprovider: nowhere'), 'UNKNOWN_PROVIDER'],
    ['harness route naming an unknown provider', (t) => edit(t, 'cursor: {provider: cursor, basis: owner-declared}', 'cursor: {provider: nowhere, basis: owner-declared}'), 'UNKNOWN_PROVIDER'],
    ['one host listed by two providers', (t) => edit(t, 'hosts: [api.z.ai]', 'hosts: [api.z.ai, API.OpenAI.com]'), 'DUPLICATE_HOST'],
    ['provider answer outside its enum', (t) => edit(t, 'hosts: [api.z.ai], private_work: public_only', 'hosts: [api.z.ai], private_work: sometimes'), 'INVALID_VALUE'],
    ['too many provider hosts', (t) => edit(t, 'hosts: [api.z.ai]', `hosts: [${Array.from({ length: 9 }, (_, n) => `h${n}.z.ai`).join(', ')}]`), 'INVALID_VALUE'],
    ['an explicit host its provider does not list', (t) => edit(t, 'host: api.z.ai', 'host: elsewhere.example.test'), 'HOST_UNLISTED'],
    ['relative exception folder', (t) => edit(t, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', 'folder: code/app'), 'EXCEPTION_PATH'],
    ['exception folder with ..', (t) => edit(t, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', 'folder: /work/../app'), 'EXCEPTION_PATH'],
    ['exception folder with ~ (never expanded)', (t) => edit(t, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', 'folder: ~/code'), 'EXCEPTION_PATH'],
    ['exception for an unknown provider', (t) => edit(t, 'zai-synthetic: {provider: zai', 'zai-synthetic: {provider: nowhere'), 'UNKNOWN_PROVIDER'],
    ['host: default on a harness whose default provider is another', (t) => edit(t, 'name: Opus\nclass: knight\nharness: claude', 'name: Opus\nclass: knight\nharness: opencode'), 'ROUTE_CONFLICT'],
    ['empty efforts on an enabled agent', (t) => edit(t, 'efforts: [max]', 'efforts: []'), 'INVALID_VALUE'],
    ['compact_at without a context limit', (t) => edit(t, SOL_CONTEXT, 'context_window: 400000\ncompact_at: 1000'), 'INVALID_VALUE'],
    ['compact_at not below the context limit', (t) => edit(t, SOL_CONTEXT, `${SOL_CONTEXT}\ncompact_at: 272000`), 'INVALID_VALUE'],
    ['context limit above the context window', (t) => edit(t, SOL_CONTEXT, 'context_window: 400000\ncontext_limit: 400001'), 'INVALID_VALUE'],
    ['a price without its output', (t) => edit(t, 'input: 1.25, cached_input: 0.125, output: 10,', 'input: 1.25, cached_input: 0.125,'), 'INVALID_VALUE'],
    ['a price source that is not a URL', (t) => edit(t, '"https://prices.example.test/PRICE-SENTINEL-SOL"', 'somewhere'), 'INVALID_VALUE'],
    ['a price date that is not a date', (t) => edit(t, 'as_of: 2026-10-01', 'as_of: 2026-13-01'), 'INVALID_VALUE'],
    ['a role description over its bound', (t) => edit(t, 'description: DESCRIPTION-SENTINEL-HELPER', `description: ${'d'.repeat(81)}`), 'INVALID_VALUE'],
    ['the earlier small_epic rule', (t) => edit(t, 'small_work: astra@low', 'small_epic: astra@low'), 'UNKNOWN_FIELD'],
    ['the earlier ## data-labels section', (t) => `${t}\n## data-labels\n\n\`\`\`yaml\ndefault: private\n\`\`\`\n`, 'MISSING_FIELD'],
    ['a reserved section this version does not read', (t) => `${t}\n## tools\n\n\`\`\`yaml\nplaywright: {}\n\`\`\`\n`, 'SECTION_INVALID'],
    ['unsupported YAML', (t) => edit(t, 'name: Luna\n', 'name: &anchor Luna\n'), 'YAML_SYNTAX'],
    ['heading that is not an id', (t) => `${t}\n## Notes for later\n\ntext\n`, 'SECTION_INVALID']
  ]
  it.each(refusals)('refuses %s with its code and line', (_name, change, code) => {
    const errors = parseRoster(change(EXAMPLE)).errors
    expect(errors.map((error) => error.code)).toContain(code)
    expect(errors.every((error) => typeof error.line === 'number' && error.line > 0)).toBe(true)
    expect(parseRoster(change(EXAMPLE)).data).toBeNull()
  })

  it('a schema-1 roster is told which fields changed', () => {
    const [error] = parseRoster(edit(EXAMPLE, 'schema_version: 2', 'schema_version: 1')).errors
    expect(error?.message).toMatch(/title became class/)
    expect(error?.message).toMatch(/trust, authority, security, cost, quota, tags and ## data-labels are gone/)
    expect(error?.message).toMatch(/private_work: allowed \| public_only/)
  })

  it('refuses two exceptions for one provider that resolve to the same directory, and more than 64', () => {
    mkdirSync(join(home, 'work/app'), { recursive: true })
    symlinkSync(join(home, 'work/app'), join(home, 'alias'))
    const one = 'zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}'
    expect(codes(edit(EXAMPLE, one, `a: {provider: zai, folder: ${home}/work/app}\nb: {provider: zai, folder: ${home}/alias}`))).toEqual(['EXCEPTION_COLLISION'])
    // The same folder for another provider is a different exception.
    expect(codes(edit(EXAMPLE, one, `a: {provider: zai, folder: ${home}/work/app}\nb: {provider: cursor, folder: ${home}/alias}`))).toEqual([])
    const many = Array.from({ length: 65 }, (_, n) => `e${n}: {provider: zai, folder: /synthetic/f${n}}`).join('\n')
    expect(codes(edit(EXAMPLE, one, many))).toEqual(['INVALID_VALUE'])
  })

  it('never expands a value through a shell', () => {
    const text = edit(EXAMPLE, 'name: Luna\n', 'name: "$(touch pwned)"\n')
    expect(parseRoster(text).data?.agents.find((agent) => agent.id === 'luna')?.name).toBe('$(touch pwned)')
  })
})

/**
 * Golden: dev-auto references/models.md (lines ~6-44 at the time of Epic 60) as data. Each row
 * of the helper table, the lead line, the recheck row, the consultant's effort choice and the
 * small-work rule must come back from `bmn roster role` exactly.
 */
const MODELS_TABLE: Record<string, { candidates: string[]; then: string; recheck?: Record<string, unknown>; small_work?: string }> = {
  lead: { candidates: ['sol@xhigh', 'opus@xhigh'], then: 'owner-chooses' }, // "The owner picks and starts the lead"
  helper: { candidates: ['luna@max'], then: 'lead' }, // Routine chores | Luna max | lead
  'focused-reviewer': { candidates: ['luna@max', 'astra@low'], then: 'lead' }, // Focused review | Luna max | Astra low | lead
  browser: { candidates: ['luna@max'], then: 'lead' }, // Browser checks | Luna max browse | lead
  'pre-reviewer': { candidates: ['luna@max'], then: 'skip' }, // Epic pre-review (quick) | Luna max | skip it
  'epic-reviewer': { candidates: ['astra@medium', 'fable@medium'], then: 'blocked', // Epic review | Astra medium | Fable medium | BLOCKED
    recheck: { same_reviewer: true, efforts: { astra: 'low' } }, // Recheck a finding | same reviewer, Astra at low
    small_work: 'astra@low' }, // "The epic review may use Astra low for a small, well-evidenced epic"
  'project-pre-reviewer': { candidates: ['luna@max'], then: 'skip' }, // Project pre-review (quick) | Luna max | skip it
  'final-reviewer': { candidates: ['astra@high', 'fable@high'], then: 'blocked', recheck: { same_reviewer: true, efforts: { astra: 'low' } } },
  consultant: { candidates: ['astra@medium|high', 'fable@medium|high'], then: 'blocked' } // Consultant | Astra medium or high | Fable medium or high | BLOCKED
}

describe('bmn roster role (60.1 AC3, golden table)', () => {
  it('reproduces every row and rule of the dev-auto table', async () => {
    approveFile()
    for (const [role, expected] of Object.entries(MODELS_TABLE)) {
      const result = await runCli(['roster', 'role', role, '--json'])
      expect(result.code, result.stderr).toBe(0)
      const chain = JSON.parse(result.stdout)
      expect(chain.candidates.map((c: { agent: string; efforts: string[] }) => `${c.agent}@${c.efforts.join('|')}`)).toEqual(expected.candidates)
      expect(chain.candidates.every((c: { eligible: boolean; private_work: string }) => c.eligible && c.private_work === 'allowed')).toBe(true)
      expect(chain.candidates.map((c: { effort_choice: boolean }) => c.effort_choice)).toEqual(expected.candidates.map((c) => c.includes('|')))
      expect(chain.then).toBe(expected.then)
      expect(chain.recheck).toEqual(expected.recheck)
      expect(chain.small_work === undefined ? undefined : `${chain.small_work.agent}@${chain.small_work.efforts[0]}`).toBe(expected.small_work)
    }
    const text = await runCli(['roster', 'role', 'epic-reviewer'])
    expect(text.stdout).toContain('1. astra@medium  eligible  private-work=allowed')
    expect(text.stdout).toContain('recheck: same reviewer, astra at low')
    expect(text.stdout).toContain('small work: astra@low  eligible')
  })

  it("gives each candidate its provider's answer, so a lead can skip a public-only one for private work", async () => {
    approveFile(EXAMPLE.replace('enabled: false\nstatus: active\nefforts: []\nroles: [helper]\nenabled_note: NOTE-SENTINEL-GLM', 'enabled: true\nstatus: active\nefforts: [low]\nroles: [helper]')
      .replace('candidates: [luna@max], then: lead}\nfocused', 'candidates: [luna@max, glm@low], then: lead}\nfocused'))
    const chain = JSON.parse((await runCli(['roster', 'role', 'helper', '--json'])).stdout)
    expect(chain.candidates.map((c: { agent: string; private_work: string }) => `${c.agent}:${c.private_work}`)).toEqual(['luna:allowed', 'glm:public_only'])
    expect((await runCli(['roster', 'role', 'helper'])).stdout).toContain('2. glm@low  eligible  private-work=public-only')
  })

  it('refuses an unknown role with ROLE_UNKNOWN', async () => {
    approveFile()
    const result = await runCli(['roster', 'role', 'jester', '--json'])
    expect(result.code).toBe(10)
    expect(JSON.parse(result.stdout).code).toBe('ROLE_UNKNOWN')
  })
})

describe('bmn team (60.1 AC3-AC4, 60.2 AC2)', () => {
  it('lists only enabled active agents, unabridged, in roster order; --all marks the rest', async () => {
    approveFile()
    const result = await runCli(['team', '--json'])
    expect(result.code, result.stderr).toBe(0)
    const team = JSON.parse(result.stdout)
    expect(team.agents.map((agent: { id: string }) => agent.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna'])
    expect(Object.keys(team.agents[0]).sort()).toEqual(['class', 'context_limit', 'efforts', 'harness', 'id', 'model', 'name', 'private_work', 'provider', 'roles', 'state'])
    expect(Object.keys(team.agents[1]).sort()).toEqual(['class', 'efforts', 'harness', 'id', 'model', 'name', 'private_work', 'provider', 'roles', 'state'])
    const text = await runCli(['team'])
    expect(text.stdout).toContain('luna  Luna  pawn  codex  gpt-6-luna  provider=openai  private-work=allowed  roles=helper,focused-reviewer,browser,pre-reviewer,project-pre-reviewer  efforts=max  context-limit=app default')
    expect(text.stdout).toContain('context-limit=272000')
    const all = await runCli(['team', '--all'])
    expect(all.stdout).toMatch(/sonnet .*\[proposed\]/)
    expect(all.stdout).toMatch(/glm .*private-work=public-only.*\[disabled\]/)
  })

  it('works with no control socket and refuses without an approval, a roster or valid state', async () => {
    const env = { BMN_CONTROL_SOCKET: join(home, 'no-such.sock') }
    expect((await runCli(['roster', 'validate'], env)).code).toBe(3)
    const missingTeam = await runCli(['team'], env)
    expect(missingTeam.code).toBe(3)
    expect(missingTeam.stdout).toBe('')
    writeRoster(EXAMPLE)
    expect((await runCli(['roster', 'validate'], env)).code).toBe(0)
    expect((await runCli(['team'], env)).code).toBe(5)
    approveFile()
    expect((await runCli(['team'], env)).code).toBe(0)
    // A missing file prints no team, even with one approved (60.1 AC4).
    rmSync(join(home, '.config/bmn/agents/roster.md'))
    for (const command of [['team'], ['team', '--json'], ['roster', 'role', 'lead']]) {
      const gone = await runCli(command, env)
      expect(gone.code, command.join(' ')).toBe(3)
      expect(gone.stdout).not.toContain('opus')
    }
    writeRoster(EXAMPLE)
    // An invalid file blocks only what reads the file; the approved team still answers.
    writeRoster(edit(EXAMPLE, 'schema_version: 2', 'schema_version: 9'))
    const invalid = await runCli(['roster', 'validate', '--json'], env)
    expect(invalid.code).toBe(4)
    expect(JSON.parse(invalid.stdout).errors[0]).toMatchObject({ code: 'SCHEMA_VERSION', line: 11 })
    expect((await runCli(['team'], env)).code).toBe(0)
    expect((await runCli(['roster', 'status'], env)).code).toBe(4)
  })

  it('never approves from the CLI', async () => {
    writeRoster(EXAMPLE)
    for (const action of ['approve', 'restore', 'revert']) {
      const result = await runCli(['roster', action])
      expect(result.code).toBe(12)
      expect(result.stderr).toContain('OWNER_APPROVAL_IN_APP')
    }
    expect(() => readApproved()).toThrow(/nothing is approved/)
  })

  it('keeps prose, notes, prices, role descriptions and exception folders out of every agent-facing output', async () => {
    approveFile()
    const outputs = await Promise.all([
      runCli(['team']), runCli(['team', '--all', '--json']), runCli(['roster', 'role', 'helper']), runCli(['roster', 'role', 'lead', '--json'])
    ])
    for (const output of outputs) {
      for (const sentinel of SENTINELS) expect(`${output.stdout}${output.stderr}`).not.toContain(sentinel)
      expect(output.stdout).not.toMatch(/paid_by|subscription|1\.25/)
    }
  })
})

describe('roster status (60.2 AC3)', () => {
  it('lists each pending difference, free text and folders only as a hash, and none take effect', async () => {
    approveFile()
    let text = edit(EXAMPLE, 'hosts: [api.openai.com], sites: [openai.com], private_work: allowed', 'hosts: [api.openai.com], sites: [openai.com], private_work: public_only')
    text = edit(text, 'enabled_note: NOTE-SENTINEL-GLM', 'enabled_note: NOTE-SENTINEL-CHANGED')
    text = edit(text, 'description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead', 'description: DESCRIPTION-SENTINEL-OTHER, candidates: [luna@max], then: skip')
    text = edit(text, 'folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', 'folder: /synthetic/EXCEPTION-SENTINEL-MOVED')
    writeRoster(text)
    const result = await runCli(['roster', 'status', '--json'])
    expect(result.code).toBe(0)
    const status = JSON.parse(result.stdout)
    expect(status.differences.map((d: { scope: string; id: string; field: string }) => `${d.scope}:${d.id}.${d.field}`).sort())
      .toEqual(['agent:glm.enabled_note', 'exceptions:zai-synthetic.folder', 'providers:openai.private_work', 'roles:helper.description', 'roles:helper.then'])
    for (const sentinel of SENTINELS) expect(result.stdout).not.toContain(sentinel)
    const human = await runCli(['roster', 'status'])
    expect(human.stdout).toContain('## providers openai.private_work: allowed -> public_only')
    expect(human.stdout).toMatch(/agent glm\.enabled_note: changed \(#[0-9a-f]{12} -> #[0-9a-f]{12}\)/)
    expect(human.stdout).toMatch(/## exceptions zai-synthetic\.folder: changed \(#[0-9a-f]{12} -> #[0-9a-f]{12}\)/)
    const team = JSON.parse((await runCli(['team', '--json'])).stdout)
    expect(team.agents.find((agent: { id: string }) => agent.id === 'luna').private_work).toBe('allowed')
  })
})

describe('approved state from schema 1 (60.2 AC7)', () => {
  /** A current generation exactly as the schema-1 writer left it: valid hash, earlier schema. */
  function approvedUnderSchemaOne(): void {
    const data = { schema_version: 1, agents: [{ id: 'luna', name: 'Luna', title: 'squire', security: 'high', trust: 2, authority: 'read', efforts: ['max'], roles: [] }],
      roles: [], data_labels: { default: 'private', paths: [] }, harness_routes: [] }
    const generation = buildGeneration({ number: 1, parent: null, data: data as never, rosterFileHash: 'f'.repeat(64) })
    mkdirSync(join(home, '.config/bmn/agents/state/generations'), { recursive: true })
    writeFileSync(generationPath(1), JSON.stringify(generation))
    writeFileSync(currentPointerPath(), JSON.stringify({ generation: 1, hash: generation.hash }))
  }

  it('readers exit 5 and say to approve again; nothing is derived from the old security fields', async () => {
    approvedUnderSchemaOne()
    writeRoster(EXAMPLE)
    expect(() => readApproved()).toThrow(expect.objectContaining({ code: 'NOT_APPROVED', message: expect.stringContaining('approve the roster again on the Team pages') }))
    const team = await runCli(['team'])
    expect(team.code).toBe(5)
    expect(team.stdout).toBe('')
    expect((await runCli(['roster', 'role', 'helper'])).code).toBe(5)
    expect((await runCli(['roster', 'status'])).code).toBe(5)
  })

  it('stays listed as history that can only be viewed', () => {
    approvedUnderSchemaOne()
    expect(listGenerations()).toEqual([expect.objectContaining({ number: 1, valid: true, earlier_schema: 1 })])
  })

  it('a first schema-2 approval takes effect and numbers on from it', () => {
    approvedUnderSchemaOne()
    const generation = approveFile()
    expect(generation).toMatchObject({ number: 2, parent: null })
    expect(readApproved().number).toBe(2)
    expect(listGenerations().map((entry) => entry.earlier_schema)).toEqual([undefined, 1])
  })
})

describe('machine differences (60.5 AC2)', () => {
  it('an added or removed agent carries every machine value, free text only as a short hash', () => {
    const approved = parseRoster(EXAMPLE).data!
    const withNova = { ...approved, agents: [...approved.agents, { ...approved.agents[0]!, id: 'nova', name: 'Nova', enabled_note: 'NOTE-SENTINEL-NOVA' }] }
    const [added] = machineDiff(approved, withNova)
    expect(added).toMatchObject({ scope: 'agent', id: 'nova', field: null, kind: 'added', after: { present: true, value: { name: 'Nova', harness: approved.agents[0]!.harness } } })
    expect(JSON.stringify(added)).not.toContain('NOTE-SENTINEL-NOVA')
    expect((added!.after!.value as { enabled_note: string }).enabled_note).toMatch(/^text [0-9a-f]{8}$/)
    const [removed] = machineDiff(withNova, approved)
    expect(removed).toMatchObject({ kind: 'removed', before: { value: { name: 'Nova' } } })
  })

  it('covers providers and exceptions; an exception folder is only ever a hash', () => {
    const approved = parseRoster(EXAMPLE).data!
    const changed = {
      ...approved,
      providers: approved.providers.map((provider) => (provider.id === 'zai' ? { ...provider, private_work: 'allowed' as const } : provider)),
      exceptions: [...approved.exceptions, { id: 'cursor-app', provider: 'cursor', folder: '/synthetic/EXCEPTION-SENTINEL-NEW' }]
    }
    const diff = machineDiff(approved, changed)
    expect(diff).toEqual([
      expect.objectContaining({ scope: 'providers', id: 'zai', field: 'private_work', before: { present: true, value: 'public_only' }, after: { present: true, value: 'allowed' } }),
      expect.objectContaining({ scope: 'exceptions', id: 'cursor-app', field: null, kind: 'added' })
    ])
    expect(JSON.stringify(diff)).not.toContain('EXCEPTION-SENTINEL')
  })
})

describe('rewriteRoster', () => {
  it('changes only the differing blocks and keeps every other byte', () => {
    const data = parseRoster(EXAMPLE).data!
    expect(rewriteRoster(EXAMPLE, data)).toBe(EXAMPLE)
    const changed = { ...data, agents: data.agents.map((agent) => agent.id === 'luna' ? { ...agent, class: 'bishop' as const } : agent) }
    const out = rewriteRoster(EXAMPLE, changed)
    expect(parseRoster(out).data).toEqual(changed)
    const lunaStart = EXAMPLE.indexOf('## luna')
    const lunaEnd = EXAMPLE.indexOf('## sonnet')
    expect(out.slice(0, lunaStart)).toBe(EXAMPLE.slice(0, lunaStart))
    expect(out.slice(out.indexOf('## sonnet'))).toBe(EXAMPLE.slice(lunaEnd))
  })

  it('writes a provider answer, an exception and a price back the way it reads them', () => {
    const data = parseRoster(EXAMPLE).data!
    const changed = {
      ...data,
      agents: data.agents.map((agent) => agent.id === 'opus' ? { ...agent, price: { input: 15, cached_input: 1.5, output: 75.25, source: 'https://prices.example.test/opus?a=1', as_of: '2026-10-09' } } : agent),
      providers: [...data.providers, { id: 'moonshot', name: 'Moonshot AI', hosts: ['api.moonshot.example.test'], private_work: 'public_only' as const }],
      exceptions: [...data.exceptions, { id: 'moonshot-app', provider: 'moonshot', folder: '/synthetic/code/app with space' }]
    }
    expect(parseRoster(rewriteRoster(EXAMPLE, changed)).data).toEqual(changed)
  })

  it('builds a whole roster from the starter one', () => {
    const data = parseRoster(EXAMPLE).data!
    const built = rewriteRoster(starterRoster(), data)
    expect(parseRoster(built).errors).toEqual([])
    expect(parseRoster(built).data).toEqual(data)
  })
})

describe('notes are the section prose (60.5 AC3)', () => {
  it('rewrites only that agent\'s prose; machine data and every other byte stay', () => {
    const next = rewriteProse(EXAMPLE, 'sol', 'Fast and thorough.\n\nSecond paragraph.')
    expect(proseOf(next, 'sol')).toBe('Fast and thorough.\n\nSecond paragraph.')
    expect(parseRoster(next).data).toEqual(parseRoster(EXAMPLE).data)
    expect(next.replace(/\n(Fast and thorough\.\n\nSecond paragraph\.)\n/, '\nOwner\'s notes: PROSE-SENTINEL-SOL.\n')).toBe(EXAMPLE)
    expect(proseOf(rewriteProse(EXAMPLE, 'sol', ''), 'sol')).toBe('')
  })

  it.each([['a code fence', 'x\n```yaml\nname: Evil\n```'], ['a section heading', 'x\n## evil']])('refuses %s, which would change the roster\'s structure', (_name, prose) => {
    expect(() => rewriteProse(EXAMPLE, 'sol', prose)).toThrow(expect.objectContaining({ code: 'ROSTER_INVALID' }))
  })

  it('never reaches an agent: `bmn team` carries no notes', async () => {
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), rewriteProse(EXAMPLE, 'sol', 'NOTES-SENTINEL written on the agent page.'))
    approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
    const output = await new Promise<string>((resolve) => {
      execFile(process.execPath, [CLI, 'team'], { env: { HOME: home, PATH: '/usr/bin:/bin' } }, (_error, stdout) => resolve(stdout))
    })
    expect(output).toContain('Sol')
    expect(output).not.toContain('NOTES-SENTINEL')
  })
})
