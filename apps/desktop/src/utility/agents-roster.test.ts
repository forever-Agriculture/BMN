// MODULE: agents-roster.test.ts - Epic 60.1/60.2: roster validation, the golden role table, team output and approved-state reads
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRoster, proseOf, rewriteProse, rewriteRoster } from '../../bin/agents-roster.mjs'
import { approveRoster } from '../main/agents-approval'
import { readApproved, readValidRoster } from '../../bin/agents-state.mjs'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const SENTINELS = ['PROSE-SENTINEL', 'QUOTA-SENTINEL', 'TAG-SENTINEL', 'NOTE-SENTINEL']

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
  return approveRoster({ generation: null, fileHash: roster.hash })
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
    expect(parsed.data?.agents.map((agent) => agent.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna', 'sonnet', 'haiku', 'glm'])
    expect(parsed.data?.roles).toHaveLength(9)
    expect(parsed.data?.harness_routes.map((route) => route.harness)).toEqual(['claude', 'codex', 'opencode', 'cursor'])
    // A disabled candidate is reported, never refused.
    const withDisabled = edit(EXAMPLE, 'helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max], then: lead}\nchores: {candidates: [glm@low], then: lead}')
    expect(codes(withDisabled.replace('efforts: []\nroles: [helper]', 'efforts: [low]\nroles: [helper, chores]'))).toEqual([])
    expect(parseRoster(withDisabled.replace('efforts: []\nroles: [helper]', 'efforts: [low]\nroles: [helper, chores]')).warnings.map((w) => w.code)).toContain('CANDIDATE_DISABLED')
  })

  const refusals: [string, (text: string) => string, string][] = [
    ['unsupported schema version', (t) => edit(t, 'schema_version: 1', 'schema_version: 2'), 'SCHEMA_VERSION'],
    ['missing schema section', (t) => edit(t, '## roster\n\n```yaml\nschema_version: 1\n```\n', ''), 'SCHEMA_VERSION'],
    ['duplicate agent id', (t) => `${t}\n## luna\n\n\`\`\`yaml\nname: x\n\`\`\`\n`, 'DUPLICATE_ID'],
    ['duplicate key', (t) => edit(t, 'name: Luna\n', 'name: Luna\nname: Luna2\n'), 'DUPLICATE_KEY'],
    ['duplicate yaml block', (t) => edit(t, 'Deactivated in this example.', '```yaml\nname: other\n```\nDeactivated in this example.'), 'DUPLICATE_BLOCK'],
    ['unknown field', (t) => edit(t, 'name: Luna\n', 'name: Luna\nrank: knight\n'), 'UNKNOWN_FIELD'],
    ['value outside an enum', (t) => edit(t, 'name: Luna\ntitle: squire', 'name: Luna\ntitle: baron'), 'INVALID_VALUE'],
    ['text over its bound', (t) => edit(t, 'name: Luna\n', `name: ${'L'.repeat(41)}\n`), 'INVALID_VALUE'],
    ['trust out of range', (t) => edit(t, 'trust: 2\nauthority: read\nenabled: true\nstatus: active\nefforts: [max]', 'trust: 4\nauthority: read\nenabled: true\nstatus: active\nefforts: [max]'), 'INVALID_VALUE'],
    ['null in an optional field', (t) => edit(t, 'aliases: [fable]', 'aliases: null'), 'NULL_OPTIONAL'],
    ['candidate effort the agent does not list', (t) => edit(t, 'browser: {candidates: [luna@max]', 'browser: {candidates: [luna@high]'), 'EFFORT_NOT_LISTED'],
    ['candidate lacking the role', (t) => edit(t, 'helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max, astra@low], then: lead}'), 'ROLE_NOT_HELD'],
    ['squire with authority lead', (t) => edit(t, 'trust: 2\nauthority: read\nenabled: true\nstatus: active\nefforts: [max]', 'trust: 2\nauthority: lead\nenabled: true\nstatus: active\nefforts: [max]'), 'SQUIRE_LEAD'],
    ['squire in the lead chain', (t) => edit(edit(t, 'lead: {candidates: [sol@xhigh, opus@xhigh]', 'lead: {candidates: [sol@xhigh, opus@xhigh, luna@max]'),
      'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]', 'roles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer, lead]'), 'SQUIRE_LEAD'],
    ['candidate naming an unknown agent', (t) => edit(t, 'browser: {candidates: [luna@max]', 'browser: {candidates: [nova@max]'), 'UNKNOWN_AGENT'],
    ['relative label path', (t) => edit(t, 'default: private\n', 'default: private\ncode/public: public\n'), 'LABEL_PATH'],
    ['label path with ..', (t) => edit(t, 'default: private\n', 'default: private\n/work/../public: public\n'), 'LABEL_PATH'],
    ['label path with ~ (never expanded)', (t) => edit(t, 'default: private\n', 'default: private\n~/code: public\n'), 'LABEL_PATH'],
    ['high agent on a low default route', (t) => edit(t, 'opencode: {provider: opencode-go, security: low', 'opencode: {provider: opencode-go, security: low').replace(
      'name: Opus\ntitle: knight\nharness: claude', 'name: Opus\ntitle: knight\nharness: opencode'), 'ROUTE_CONFLICT'],
    ['empty efforts on an enabled agent', (t) => edit(t, 'efforts: [max]', 'efforts: []'), 'INVALID_VALUE'],
    ['unsupported YAML', (t) => edit(t, 'name: Luna\n', 'name: &anchor Luna\n'), 'YAML_SYNTAX'],
    ['heading that is not an id', (t) => `${t}\n## Notes for later\n\ntext\n`, 'SECTION_INVALID']
  ]
  it.each(refusals)('refuses %s with its code and line', (_name, change, code) => {
    const errors = parseRoster(change(EXAMPLE)).errors
    expect(errors.map((error) => error.code)).toContain(code)
    expect(errors.every((error) => typeof error.line === 'number' && error.line > 0)).toBe(true)
    expect(parseRoster(change(EXAMPLE)).data).toBeNull()
  })

  it('refuses two label paths that resolve to the same directory', () => {
    mkdirSync(join(home, 'work/public'), { recursive: true })
    symlinkSync(join(home, 'work/public'), join(home, 'alias'))
    const text = edit(EXAMPLE, 'default: private\n', `default: private\n${home}/work/public: public\n${home}/alias: private\n`)
    expect(codes(text)).toEqual(['LABEL_COLLISION'])
  })

  it('never expands a value through a shell', () => {
    const text = edit(EXAMPLE, 'name: Luna\n', 'name: "$(touch pwned)"\n')
    expect(parseRoster(text).data?.agents.find((agent) => agent.id === 'luna')?.name).toBe('$(touch pwned)')
  })
})

/**
 * Golden: dev-auto references/models.md (lines ~6-44 at the time of Epic 60) as data. Each row
 * of the helper table, the lead line, the recheck row, the consultant's effort choice and the
 * small-epic rule must come back from `bmn roster role` exactly.
 */
const MODELS_TABLE: Record<string, { candidates: string[]; then: string; recheck?: Record<string, unknown>; small_epic?: string }> = {
  lead: { candidates: ['sol@xhigh', 'opus@xhigh'], then: 'owner-chooses' }, // "The owner picks and starts the lead"
  helper: { candidates: ['luna@max'], then: 'lead' }, // Routine chores | Luna max | lead
  'focused-reviewer': { candidates: ['luna@max', 'astra@low'], then: 'lead' }, // Focused review | Luna max | Astra low | lead
  browser: { candidates: ['luna@max'], then: 'lead' }, // Browser checks | Luna max browse | lead
  'pre-reviewer': { candidates: ['luna@max'], then: 'skip' }, // Epic pre-review (quick) | Luna max | skip it
  'epic-reviewer': { candidates: ['astra@medium', 'fable@medium'], then: 'blocked', // Epic review | Astra medium | Fable medium | BLOCKED
    recheck: { same_reviewer: true, efforts: { astra: 'low' } }, // Recheck a finding | same reviewer, Astra at low
    small_epic: 'astra@low' }, // "The epic review may use Astra low for a small, well-evidenced epic"
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
      expect(chain.candidates.every((c: { eligible: boolean }) => c.eligible)).toBe(true)
      expect(chain.candidates.map((c: { effort_choice: boolean }) => c.effort_choice)).toEqual(expected.candidates.map((c) => c.includes('|')))
      expect(chain.then).toBe(expected.then)
      expect(chain.recheck).toEqual(expected.recheck)
      expect(chain.small_epic === undefined ? undefined : `${chain.small_epic.agent}@${chain.small_epic.efforts[0]}`).toBe(expected.small_epic)
    }
    const text = await runCli(['roster', 'role', 'epic-reviewer'])
    expect(text.stdout).toContain('1. astra@medium  eligible')
    expect(text.stdout).toContain('recheck: same reviewer, astra at low')
    expect(text.stdout).toContain('small epic: astra@low  eligible')
  })

  it('refuses an unknown role with ROLE_UNKNOWN', async () => {
    approveFile()
    const result = await runCli(['roster', 'role', 'jester', '--json'])
    expect(result.code).toBe(10)
    expect(JSON.parse(result.stdout).code).toBe('ROLE_UNKNOWN')
  })
})

describe('bmn team (60.1 AC3-AC5, 60.2 AC2)', () => {
  it('lists only enabled active agents, unabridged, in roster order; --all marks the rest', async () => {
    approveFile()
    const result = await runCli(['team', '--json'])
    expect(result.code, result.stderr).toBe(0)
    const team = JSON.parse(result.stdout)
    expect(team.agents.map((agent: { id: string }) => agent.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna'])
    expect(Object.keys(team.agents[0]).sort()).toEqual(['authority', 'efforts', 'harness', 'id', 'model', 'name', 'roles', 'security', 'state', 'title', 'trust'])
    const text = await runCli(['team'])
    expect(text.stdout).toContain('luna  Luna  squire  codex  gpt-6-luna  roles=helper,focused-reviewer,browser,pre-reviewer,project-pre-reviewer  security=high  trust=2  authority=read  efforts=max')
    const all = await runCli(['team', '--all'])
    expect(all.stdout).toMatch(/sonnet .*\[proposed\]/)
    expect(all.stdout).toMatch(/glm .*\[disabled\]/)
    expect(all.stdout).toContain('max_context_tokens=100000 (configured; not enforced)')
  })

  it('works with no control socket and refuses without an approval, a roster or valid state', async () => {
    const env = { BMN_CONTROL_SOCKET: join(home, 'no-such.sock') }
    expect((await runCli(['roster', 'validate'], env)).code).toBe(3)
    const missingTeam = await runCli(['team'], env)
    expect(missingTeam.code).toBe(5)
    expect(missingTeam.stdout).toBe('')
    writeRoster(EXAMPLE)
    expect((await runCli(['roster', 'validate'], env)).code).toBe(0)
    expect((await runCli(['team'], env)).code).toBe(5)
    approveFile()
    expect((await runCli(['team'], env)).code).toBe(0)
    // An invalid file blocks only what reads the file; the approved team still answers.
    writeRoster(edit(EXAMPLE, 'schema_version: 1', 'schema_version: 9'))
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

  it('keeps prose, notes, quota and tags out of every agent-facing output', async () => {
    approveFile()
    const outputs = await Promise.all([
      runCli(['team']), runCli(['team', '--all', '--json']), runCli(['roster', 'role', 'helper']), runCli(['roster', 'role', 'lead', '--json'])
    ])
    for (const output of outputs) {
      for (const sentinel of SENTINELS) expect(`${output.stdout}${output.stderr}`).not.toContain(sentinel)
    }
  })
})

describe('roster status (60.2 AC3)', () => {
  it('lists each pending difference, free text only as a hash, and none take effect', async () => {
    approveFile()
    let text = edit(EXAMPLE, 'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: high',
      'name: Luna\ntitle: squire\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nsecurity: low')
    text = edit(text, 'enabled_note: NOTE-SENTINEL-GLM', 'enabled_note: NOTE-SENTINEL-CHANGED')
    text = edit(text, 'helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max], then: skip}')
    writeRoster(text)
    const result = await runCli(['roster', 'status', '--json'])
    expect(result.code).toBe(0)
    const status = JSON.parse(result.stdout)
    expect(status.differences.map((d: { scope: string; id: string; field: string }) => `${d.scope}:${d.id}.${d.field}`).sort())
      .toEqual(['agent:glm.enabled_note', 'agent:luna.security', 'roles:helper.then'])
    expect(result.stdout).not.toContain('NOTE-SENTINEL')
    const human = await runCli(['roster', 'status'])
    expect(human.stdout).toContain('agent luna.security: high -> low')
    expect(human.stdout).toMatch(/agent glm\.enabled_note: changed \(#[0-9a-f]{12} -> #[0-9a-f]{12}\)/)
    const team = JSON.parse((await runCli(['team', '--json'])).stdout)
    expect(team.agents.find((agent: { id: string }) => agent.id === 'luna').security).toBe('high')
  })
})

describe('rewriteRoster', () => {
  it('changes only the differing blocks and keeps every other byte', () => {
    const data = parseRoster(EXAMPLE).data!
    expect(rewriteRoster(EXAMPLE, data)).toBe(EXAMPLE)
    const changed = { ...data, agents: data.agents.map((agent) => agent.id === 'luna' ? { ...agent, trust: 3 as const } : agent) }
    const out = rewriteRoster(EXAMPLE, changed)
    expect(parseRoster(out).data).toEqual(changed)
    const lunaStart = EXAMPLE.indexOf('## luna')
    const lunaEnd = EXAMPLE.indexOf('## sonnet')
    expect(out.slice(0, lunaStart)).toBe(EXAMPLE.slice(0, lunaStart))
    expect(out.slice(out.indexOf('## sonnet'))).toBe(EXAMPLE.slice(lunaEnd))
  })
})

describe('the opinion is the section prose (60.5 AC5)', () => {
  it('rewrites only that agent\'s prose; machine data and every other byte stay', () => {
    const next = rewriteProse(EXAMPLE, 'sol', 'Fast and thorough.\n\nSecond paragraph.')
    expect(proseOf(next, 'sol')).toBe('Fast and thorough.\n\nSecond paragraph.')
    expect(parseRoster(next).data).toEqual(parseRoster(EXAMPLE).data)
    expect(next.replace(/\n(Fast and thorough\.\n\nSecond paragraph\.)\n/, '\nOwner\'s opinion: PROSE-SENTINEL-SOL.\n')).toBe(EXAMPLE)
    expect(proseOf(rewriteProse(EXAMPLE, 'sol', ''), 'sol')).toBe('')
  })

  it.each([['a code fence', 'x\n```yaml\nname: Evil\n```'], ['a section heading', 'x\n## evil']])('refuses %s, which would change the roster\'s structure', (_name, prose) => {
    expect(() => rewriteProse(EXAMPLE, 'sol', prose)).toThrow(expect.objectContaining({ code: 'ROSTER_INVALID' }))
  })

  it('never reaches an agent: `bmn team` carries no opinion', async () => {
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), rewriteProse(EXAMPLE, 'sol', 'OPINION-SENTINEL written in the panel.'))
    approveRoster({ generation: null, fileHash: readValidRoster().hash })
    const output = await new Promise<string>((resolve) => {
      execFile(process.execPath, [CLI, 'team'], { env: { HOME: home, PATH: '/usr/bin:/bin' } }, (_error, stdout) => resolve(stdout))
    })
    expect(output).toContain('Sol')
    expect(output).not.toContain('OPINION-SENTINEL')
  })
})
