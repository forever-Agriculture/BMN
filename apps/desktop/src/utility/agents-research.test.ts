// MODULE: agents-research.test.ts - Story 60.10 (first release): model research over a synthetic team, stub researchers and made-up pages; no provider and no real site is reached
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_RESEARCH_CONFIG, CODEX_RESEARCH_DISABLED, CODEX_RESEARCH_TOOLS_SEEN, researchFormHash, researchRunsDirectory, type FenceTestEntry } from '../../bin/agents-check.mjs'
import {
  MAX_LISTED, answerText, chooseResearcher, chosenResearcher, fetchPublicPage, forgetDroppedResearcher, isPublicAddress, mergeResearch, ownNames, pageText, parseAnswer, priceShown, readResearch,
  researchArgv, researchBatches, researchEffort, researchPrompt, researchResultsPath, researchSubjects, researchView, researcherChoice, researchers, runResearch, settledResearcher, sourceRank,
  verifyModels, windowShown, type AnsweredModel, type PageRead, type ResearchBatch
} from '../../bin/agents-research.mjs'
import { namedResearchers, parseRoster, researcherProposal } from '../../bin/agents-roster.mjs'
import { readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-10T12:00:00.000Z')
const ANTHROPIC: ResearchBatch = { provider: 'anthropic', name: 'Anthropic', sites: ['anthropic.com'], models: ['claude-fable-5-1', 'claude-opus-5-5'], listed: 2 }

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

function approve(text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

/**
 * A stand-in for an agent app. It records what it was started with and answers from `plan.json`:
 * the entry whose key is a model named in the prompt. Claude Code prints a result object; Codex
 * writes its last message to the `-o` file.
 */
function stubApp(name: 'claude' | 'codex', version: string): void {
  writeFileSync(join(stubs, name), `#!${process.execPath}
const fs = require('node:fs')
const home = process.env.HOME
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
const prompt = fs.readFileSync(0, 'utf8')
const own = process.env.CODEX_HOME
const codex = own === undefined ? undefined : fs.readdirSync(own).map((entry) => entry + (fs.lstatSync(own + '/' + entry).isSymbolicLink() ? ' -> ' + fs.readlinkSync(own + '/' + entry) : ''))
fs.appendFileSync(home + '/calls.log', JSON.stringify({ app: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), files: fs.readdirSync('.'), codex, prompt }) + '\\n')
if (own !== undefined) fs.writeFileSync(own + '/state_5.sqlite', 'the app keeps its own state in its folder')
const plan = JSON.parse(fs.readFileSync(home + '/plan.json', 'utf8'))
const key = Object.keys(plan).find((model) => prompt.includes('- ' + model + '\\n'))
const entry = plan[key] ?? { text: 'no plan for this prompt' }
setTimeout(() => {
  if (entry.exit) process.exit(entry.exit)
  if (${JSON.stringify(name)} === 'codex') fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], entry.text)
  else console.log(JSON.stringify({ type: 'result', is_error: entry.error === true, result: entry.text }))
}, entry.delay ?? 0)
`)
  chmodSync(join(stubs, name), 0o755)
}

interface Plan { text?: string; delay?: number; exit?: number; error?: boolean }
const plan = (entries: Record<string, Plan>): void => writeFileSync(join(home, 'plan.json'), JSON.stringify(entries))
const calls = (): { app: string; argv: string[]; env: Record<string, string>; cwd: string; files: string[]; codex?: string[]; prompt: string }[] =>
  (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])

const price = (input: number, output: number, source: string, cached?: number) => ({ input, output, ...(cached === undefined ? {} : { cached_input: cached }), source, as_of: '2026-10-10' })
const model = (id: string, provider: string, fields: Partial<AnsweredModel> & { listed?: boolean } = {}) =>
  ({ id, provider, listed: false, price: 'unavailable' as unknown, context_window: 'unavailable' as unknown, ...fields })
const answer = (models: unknown[]): string => JSON.stringify({ version: 1, models })

const ANTHROPIC_PAGE = 'https://www.anthropic.com/pricing'
const OPENAI_PAGE = 'https://openai.com/api/pricing'
/** Pages as BMN's own read returns them: prices per million tokens beside each model's name. */
const PAGES: Record<string, string> = {
  [ANTHROPIC_PAGE]: `<html><body><h1>Pricing</h1><p>Prices are per million tokens (MTok).</p>
    <table><tr><td>Claude Opus 5.5 <code>claude-opus-5-5</code></td><td>Input $15 / MTok</td><td>Cached $1.50 / MTok</td><td>Output $75 / MTok</td><td>Context window 1,000,000 tokens</td></tr>
    <tr><td>Claude Fable 5.1 <code>claude-fable-5-1</code></td><td>Input $20.00 / MTok</td><td>Output $100.00 / MTok</td><td>200K context</td></tr>
    <tr><td>Claude Sonnet 5.5 <code>claude-sonnet-5-5</code></td><td>Input $3 / MTok</td><td>Output $15 / MTok</td></tr>
    <tr><td>Claude Haiku 5.5 <code>claude-haiku-5-5</code></td><td>Input $0.80 / MTok</td><td>Output $4 / MTok</td></tr>
    <tr><td>Claude Opus 5.6 <code>claude-opus-5-6</code></td><td>Input $15 / MTok</td><td>Output $75 / MTok</td></tr></table></body></html>`,
  [OPENAI_PAGE]: `<main><p>Price per 1M tokens</p><section><h3>gpt-6.1-sol</h3><p>Input: $2.00</p><p>Output: $8.00</p></section>
    <section><h3>gpt-6-astra</h3><p>Input: $10.00</p><p>Output: $40.00</p></section><section><h3>gpt-6-luna</h3><p>Input: $0.40</p><p>Output: $1.60</p></section></main>`
}
const fetchPage = async (address: string): Promise<PageRead> => (PAGES[address] === undefined ? { ok: false, reason: 'the site answered 404' } : { ok: true, text: PAGES[address]! })

const ANTHROPIC_ANSWER = answer([
  model('claude-fable-5-1', 'Anthropic', { published_name: 'Claude Fable 5.1', price: price(20, 100, ANTHROPIC_PAGE), context_window: { tokens: 200_000, source: ANTHROPIC_PAGE, as_of: '2026-10-10' } }),
  model('claude-haiku-5-5', 'Anthropic', { price: price(0.8, 4, ANTHROPIC_PAGE) }),
  model('claude-opus-5-5', 'Anthropic', { published_name: 'Claude Opus 5.5', price: price(15, 75, ANTHROPIC_PAGE, 1.5), context_window: { tokens: 1_000_000, source: ANTHROPIC_PAGE, as_of: '2026-10-10' } }),
  model('claude-sonnet-5-5', 'Anthropic', { price: price(3, 15, ANTHROPIC_PAGE) }),
  model('claude-opus-5-6', 'Anthropic', { listed: true, price: price(15, 75, ANTHROPIC_PAGE) })
])
const OPENAI_ANSWER = answer([
  model('gpt-6-astra', 'OpenAI', { price: price(10, 40, OPENAI_PAGE) }),
  model('gpt-6-luna', 'OpenAI', { price: price(0.4, 1.6, OPENAI_PAGE) }),
  model('gpt-6.1-sol', 'OpenAI', { price: price(2, 8, OPENAI_PAGE) })
])
const GLM_ANSWER = answer([model('glm-5.3', 'Z.ai')])
const FULL: Record<string, Plan> = { 'claude-fable-5-1': { text: ANTHROPIC_ANSWER }, 'gpt-6-astra': { text: OPENAI_ANSWER }, 'glm-5.3': { text: GLM_ANSWER } }

const research = (options: Partial<Parameters<typeof runResearch>[0]> = {}) => runResearch({ researcher: 'fable', environment: env, now: () => NOW, fetchPage, ...options })
const data = () => readApproved().data
/** A fence test on record as passed for the stub Codex's version and each of the team's Codex models (63.3). */
const FENCED: FenceTestEntry[] = [{
  harness: 'codex', at: '2026-10-10T11:00:00.000Z', version: '0.161.0', form: researchFormHash('codex'), catalog: 'bundled', verdict: 'pass', reasons: [],
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((id) => ({ model: id, verdict: 'pass' as const, tools: [...CODEX_RESEARCH_TOOLS_SEEN], reasons: [] }))
}]
/** The comparison under the provider's own model list, as one that found the same tools. */
const SAME = async () => ({ ok: true, compared: true })

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-research-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stubApp('claude', '2.1.295 (Claude Code)')
  stubApp('codex', 'codex-cli 0.161.0')
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve(EXAMPLE)
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('what BMN asks (60.10 AC2)', () => {
  it('names each of the team\'s models once, grouped by provider, with at most twenty other models to list', () => {
    expect(researchSubjects(data()).map((group) => [group.provider, group.models])).toEqual([
      ['anthropic', ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']],
      ['openai', ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']],
      ['zai', ['glm-5.3']]
    ])
    const batches = researchBatches(data())
    expect(batches.map((batch) => batch.listed)).toEqual([6, 6, 6])
    expect(batches.reduce((sum, batch) => sum + batch.listed, 0)).toBeLessThanOrEqual(MAX_LISTED)
    // A provider with many models is asked in several runs; only its first run lists other models.
    const many = parseRoster(EXAMPLE).data!
    many.agents = Array.from({ length: 19 }, (_unused, index) => ({ ...many.agents[0]!, id: `a${index}`, model: `gpt-synthetic-${String(index).padStart(2, '0')}` }))
    expect(researchBatches(many).map((batch) => [batch.models.length, batch.listed])).toEqual([[8, 20], [8, 0], [3, 0]])
  })

  it('writes a prompt that holds the model names and the source list and nothing else of the team', () => {
    const text = researchBatches(data()).map(researchPrompt).join('\n')
    for (const name of ['claude-opus-5-5', 'gpt-6.1-sol', 'glm-5.3', 'anthropic.com', 'openai.com', '1. Provider pages', '2. Other sites']) expect(text).toContain(name)
    // No notes, prose, prices, agent names, folders or host names leave.
    expect(text).not.toMatch(/SENTINEL|Owner's notes|1\.25|0\.125|272000|api\.openai\.com|api\.z\.ai|\bSol\b|\bOpus\b|\bFable\b|\bAstra\b|\bLuna\b/)
    expect(text).not.toContain(home)
    expect(researchPrompt({ ...ANTHROPIC, listed: 0 })).toContain('List no other models.')
  })

  it('uses the lowest effort the agent has, and the exact research form of its app', () => {
    const team = data()
    const fable = team.agents.find((agent) => agent.id === 'fable')!
    const luna = team.agents.find((agent) => agent.id === 'luna')!
    expect(researchEffort(fable)).toBe('low')
    expect(researchEffort(luna)).toBe('max')
    expect(researchArgv(fable, { environment: env })).toEqual(['/usr/bin/env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'claude', '-p', '--model', 'claude-fable-5-1', '--effort', 'low',
      '--safe-mode', '--tools', 'WebSearch,WebFetch', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json'])
    // A Codex run is pointed at a Codex folder of its own and carries the switches of the form that held in the fence test (63.3 AC1).
    expect(researchArgv(luna, { environment: env, run: { folder: '/run', codex: '/run/codex' } })).toEqual(['/usr/bin/env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'CODEX_HOME=/run/codex',
      'codex', 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--strict-config', '--disable', 'view_image', '--disable', 'goals', '--disable', 'image_generation',
      '--disable', 'sleep_tool', '--disable', 'hooks', '-c', 'mcp_servers={}', '-c', 'web_search="live"', '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
      '-c', 'features.multi_agent=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false',
      '-c', 'include_apps_instructions=false', '-c', 'include_collaboration_mode_instructions=false', '-c', 'include_environment_context=false', '-c', 'project_doc_max_bytes=0',
      '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="max"', '-o', '/run/answer.md', '-'])
    expect(CODEX_RESEARCH_CONFIG.slice(0, 7)).toEqual(['mcp_servers={}', 'web_search="live"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false', 'features.apps=false', 'features.plugins=false'])
    expect(CODEX_RESEARCH_DISABLED).toEqual(['view_image', 'goals', 'image_generation', 'sleep_tool', 'hooks'])
    expect(researchArgv(luna, { environment: env, run: { folder: '/run' } })[4]).toBe('CODEX_HOME=/run/codex')
  })
})

describe('who may research (60.10 AC1)', () => {
  it('offers the active agents whose run the check would pass, and says why the others cannot', () => {
    const edited = EXAMPLE.replace('enabled: false\nstatus: active\nefforts: []\nroles: [helper]', 'enabled: true\nstatus: active\nefforts: [low]\nroles: [helper]')
      .replace('## roles', '## kimi\n\n```yaml\nname: Kimi\nclass: pawn\nharness: opencode\nmodel: kimi-k3\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low]\nroles: [helper]\n```\n\n## roles')
    expect(edited).not.toBe(EXAMPLE)
    approve(edited)
    const found = researchers({ environment: env, now: NOW })
    // Claude Code's research form runs as it is; Codex researches once the fence test of its installed version is on record as passed.
    expect(found.filter((entry) => entry.ok).map((entry) => entry.id)).toEqual(['opus', 'fable'])
    expect(found.find((entry) => entry.id === 'astra')).toMatchObject({ ok: false, why: 'the fence test has not run for this version of Codex yet',
      reason: expect.stringContaining('research runs in Codex only on a version whose fence test passed') })
    const fenced = researchers({ environment: env, now: NOW, fenceTests: FENCED })
    expect(fenced.filter((entry) => entry.ok).map((entry) => entry.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna'])
    expect(fenced.find((entry) => entry.id === 'luna')).toEqual({ id: 'luna', name: 'Luna', harness: 'codex', ok: true, fence: { tools: CODEX_RESEARCH_TOOLS_SEEN, compared: false } })
    // A version the record does not name stays closed.
    stubApp('codex', 'codex-cli 0.162.0')
    expect(researchers({ environment: env, now: NOW, fenceTests: FENCED }).filter((entry) => entry.ok).map((entry) => entry.id)).toEqual(['opus', 'fable'])
    stubApp('codex', 'codex-cli 0.161.0')
    // Proposed agents are not offered at all; a public-only provider needs a verified fence; OpenCode has no research form.
    expect(found.map((entry) => entry.id)).not.toContain('sonnet')
    expect(found.find((entry) => entry.id === 'glm')).toMatchObject({ ok: false, reason: expect.stringContaining('fence') })
    expect(found.find((entry) => entry.id === 'kimi')).toMatchObject({ ok: false, reason: 'OpenCode has no research form BMN can check' })
  })

  it('offers an agent with its own context limit once the owner\'s test showed that limit wins over his default', () => {
    // The owner's case: an agent capped at 100 000 while his own sessions' default says 450 000.
    const capped = EXAMPLE.replace('model: claude-opus-5-5', 'model: claude-opus-5-5\ncontext_limit: 100000')
    expect(capped).not.toBe(EXAMPLE)
    approve(capped)
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 450000 }))
    const log = join(home, '.config/bmn/agents/state/context-tests.jsonl')
    const tested = { harness: 'claude', version: '2.1.295', limit: 'pass', compact: 'untested', asked: 137_000, observed: 137_000 }
    writeFileSync(log, `${JSON.stringify(tested)}\n`)
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'opus')).toMatchObject({ ok: false, why: 'two settings name different context sizes for it',
      reason: expect.stringContaining('env -i CLAUDE_CODE_AUTO_COMPACT_WINDOW says 100000 and user settings autoCompactWindow says 450000') })
    const opus = () => researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'opus')
    const proof = (...ids: string[]) => writeFileSync(log, `${JSON.stringify({ ...tested, rivals: ids.map((id) => ({ source: 'a settings file', id, value: 450_000 })) })}\n`)
    const user = `user settings at ${join(home, '.claude/settings.json')}: autoCompactWindow`
    // The first form of the record named only a kind of source: it proves nothing.
    writeFileSync(log, `${JSON.stringify({ ...tested, rivals: [{ kind: 'user settings autoCompactWindow', value: 450_000 }] })}\n`)
    expect(opus()).toMatchObject({ ok: false, why: 'two settings name different context sizes for it' })
    proof(user)
    expect(opus()).toEqual({ id: 'opus', name: 'Opus', harness: 'claude', ok: true })
    // The offer reads the files a run would, in the parts they play for a run: a settings file in BMN's runs folder lies
    // above a run's folder, so the proof that counts is the one for a file above, not for a folder's own.
    const runs = join(home, '.config/bmn/agents/state/research/runs')
    mkdirSync(join(runs, '.claude'), { recursive: true })
    writeFileSync(join(runs, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 450000 }))
    expect(opus()).toMatchObject({ ok: false, why: 'two settings name different context sizes for it' })
    proof(user, `project settings at ${join(runs, '.claude/settings.json')}: autoCompactWindow`)
    expect(opus()).toMatchObject({ ok: false })
    proof(user, `settings above at ${join(runs, '.claude/settings.json')}: autoCompactWindow`)
    expect(opus()).toEqual({ id: 'opus', name: 'Opus', harness: 'claude', ok: true })
    // Nothing counts that no run would read: a settings file in a folder beside the runs' own, under a name no run gets,
    // or in a folder inside it, changes nothing about the offer.
    for (const beside of ['offer', 'offer/cwd']) {
      mkdirSync(join(runs, beside, '.claude'), { recursive: true })
      writeFileSync(join(runs, beside, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 300000 }))
    }
    expect(opus()).toEqual({ id: 'opus', name: 'Opus', harness: 'claude', ok: true })
    // A size BMN cannot read is said as that, not as two sizes.
    writeFileSync(join(runs, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 'lots' }))
    expect(opus()).toMatchObject({ ok: false, why: 'BMN cannot read which context size Claude Code would use', reason: expect.stringContaining('is not a whole number') })
  })

  it('remembers the researcher the owner picked', () => {
    expect(chosenResearcher()).toBeNull()
    chooseResearcher('luna')
    expect(chosenResearcher()).toBe('luna')
  })
})

describe('who researches is part of the approved team (63.3 AC7, AC8)', () => {
  /** The owner's team as it stood: a second Opus (a queen) beside the knight, and Haiku active. */
  const TWO_OPUS = EXAMPLE
    .replace('## astra', '## opus-2\n\n```yaml\nname: Opus 2\nclass: queen\nharness: claude\nmodel: claude-opus-5-5\nprovider: anthropic\nhost: default\nenabled: true\nstatus: active\nefforts: [medium, high, xhigh]\nroles: [lead]\n```\n\n## astra')
    .replace('status: proposed\nefforts: [low, medium, high]\nroles: []\ncontext_window: 200000', 'status: active\nefforts: [low, medium, high]\nroles: [helper]\ncontext_window: 200000')
  /** The same file with `researcher: true` on each named agent's own entry. */
  const naming = (text: string, ...ids: string[]) => ids.reduce((all, id) => {
    const roles = all.indexOf('\nroles:', all.indexOf(`## ${id}\n`))
    const end = all.indexOf('\n', roles + 1)
    return `${all.slice(0, end)}\nresearcher: true${all.slice(end)}`
  }, text)
  const offered = () => researchers({ environment: env, now: NOW, fenceTests: FENCED })

  it('BMN proposes the knights and the pawns on an app that can research, one per model: the first Opus, Haiku, Sol and Luna', () => {
    approve(TWO_OPUS)
    expect(namedResearchers(data())).toBeNull()
    expect(researcherProposal(data())).toEqual(['sol', 'opus', 'luna', 'haiku'])
    expect(researcherChoice()).toEqual({ named: null, proposed: ['sol', 'opus', 'luna', 'haiku'] })
    // Never the same model twice, whatever class the second agent of that model has; never a proposed or switched-off agent.
    const team = data()
    const second = { ...team.agents.find((agent) => agent.id === 'opus')!, id: 'opus-3' }
    expect(researcherProposal({ agents: [...team.agents, second] })).toEqual(['sol', 'opus', 'luna', 'haiku'])
    expect(researcherProposal({ agents: team.agents.map((agent) => (agent.id === 'haiku' ? { ...agent, enabled: false } : agent)) })).toEqual(['sol', 'opus', 'luna'])
    expect(researcherProposal(parseRoster(EXAMPLE).data)).toEqual(['sol', 'opus', 'luna'])
    // An agent whose provider gets public work only could not research, so it is not proposed.
    const closed = { ...team, providers: team.providers.map((provider) => (provider.id === 'openai' ? { ...provider, private_work: 'public_only' as const } : provider)) }
    expect(researcherProposal(closed)).toEqual(['opus', 'haiku'])
    // Once the team names anyone there is nothing left to propose.
    approve(naming(TWO_OPUS, 'opus'))
    expect(researcherChoice()).toEqual({ named: ['opus'], proposed: [] })
  })

  it('a team from before the mark keeps offering what it offered, both agents of one model among them', () => {
    approve(TWO_OPUS)
    expect(offered().map((entry) => [entry.id, entry.ok])).toEqual([['sol', true], ['opus', true], ['opus-2', true], ['astra', true], ['fable', true], ['luna', true], ['haiku', true]])
  })

  it('once the team names its researchers only those are offered: one Opus where the team holds two, and no row for anyone else', () => {
    approve(naming(TWO_OPUS, 'sol', 'opus', 'luna', 'haiku'))
    expect(namedResearchers(data())).toEqual(['sol', 'opus', 'luna', 'haiku'])
    const found = offered()
    expect(found.map((entry) => entry.id)).toEqual(['sol', 'opus', 'luna', 'haiku'])
    // Not a greyed row with a reason: an agent the team does not name is not listed at all.
    for (const id of ['opus-2', 'astra', 'fable', 'glm', 'sonnet']) expect(found.find((entry) => entry.id === id)).toBeUndefined()
    expect(found.every((entry) => entry.ok)).toBe(true)
    // A named agent that cannot research now is still listed, with why: here Sol and Luna, on a Codex version with no fence test on record.
    expect(researchers({ environment: env, now: NOW }).map((entry) => [entry.id, entry.ok, entry.why])).toEqual([['sol', false, 'the fence test has not run for this version of Codex yet'],
      ['opus', true, undefined], ['luna', false, 'the fence test has not run for this version of Codex yet'], ['haiku', true, undefined]])
  })

  it('a research with an agent the team does not name is refused by the check and starts nothing', async () => {
    approve(naming(TWO_OPUS, 'opus'))
    plan(FULL)
    const result = await research({ researcher: 'opus-2' })
    expect(result.run).toMatchObject({ state: 'failed', models: 0, note: 'BMN did not start the run: opus-2 is not one of the team\'s researchers (opus)' })
    expect((await research({ researcher: 'astra', fenceTests: FENCED, compare: SAME })).run.note).toContain('astra is not one of the team\'s researchers')
    expect(calls()).toEqual([])
    expect((await research({ researcher: 'opus' })).run.state).not.toBe('failed')
  })

  it('a team that has chosen and names no one offers no one: taking the last researcher away never brings everyone back', async () => {
    const none = (text: string) => naming(text, 'opus').replace('researcher: true', 'researcher: false')
    approve(none(TWO_OPUS))
    expect(namedResearchers(data())).toEqual([])
    expect(researcherChoice()).toEqual({ named: [], proposed: [] })
    expect(offered()).toEqual([])
    plan(FULL)
    for (const researcher of ['opus', 'opus-2', 'fable', 'astra']) {
      const result = await research({ researcher, fenceTests: FENCED, compare: SAME })
      expect(result.run, researcher).toMatchObject({ state: 'failed', models: 0, note: `BMN did not start the run: ${researcher} is not one of the team's researchers (the team names none)` })
    }
    expect(calls()).toEqual([])
    // A pick from before falls back to none picked, as with any agent the team stopped naming.
    approve(TWO_OPUS)
    chooseResearcher('opus')
    approve(none(TWO_OPUS))
    expect(settledResearcher()).toEqual({ researcher: null, dropped: 'opus' })
  })

  it('a researcher he had picked that is no longer named falls back to none picked, and its name is kept to be said once', () => {
    approve(TWO_OPUS)
    chooseResearcher('opus-2')
    // The team names no one yet: his pick stands.
    expect(settledResearcher()).toEqual({ researcher: 'opus-2', dropped: null })
    approve(naming(TWO_OPUS, 'sol', 'opus', 'luna', 'haiku'))
    expect(settledResearcher()).toEqual({ researcher: null, dropped: 'opus-2' })
    expect(chosenResearcher()).toBeNull()
    expect(settledResearcher()).toEqual({ researcher: null, dropped: 'opus-2' })
    // Said, or acted on: picking again or the note being read ends it.
    forgetDroppedResearcher()
    expect(settledResearcher()).toEqual({ researcher: null, dropped: null })
    chooseResearcher('opus-2')
    expect(settledResearcher().dropped).toBe('opus-2')
    chooseResearcher('opus')
    expect(settledResearcher()).toEqual({ researcher: 'opus', dropped: null })
  })
})

describe('the answer is one typed object or the run failed (60.10 AC3)', () => {
  const parse = (models: unknown[], batch = ANTHROPIC) => parseAnswer(answer(models), batch, { now: NOW })
  const both = (first: Record<string, unknown> = {}) => [model('claude-fable-5-1', 'Anthropic', first), model('claude-opus-5-5', 'Anthropic')]

  it('accepts the asked shape, a fenced answer and "unavailable"', () => {
    const parsed = parse([...both({ published_name: ' Claude Fable 5.1 ', price: { ...price(20, 100, ANTHROPIC_PAGE), cached_input: null } }), model('claude-opus-5-6', 'Anthropic', { listed: true })])
    expect(parsed).toEqual({ ok: true, models: [
      { id: 'claude-fable-5-1', provider: 'Anthropic', listed: false, published_name: 'Claude Fable 5.1', price: price(20, 100, ANTHROPIC_PAGE), context_window: null },
      { id: 'claude-opus-5-5', provider: 'Anthropic', listed: false, price: null, context_window: null },
      { id: 'claude-opus-5-6', provider: 'Anthropic', listed: true, price: null, context_window: null }
    ] })
    expect(parseAnswer(`\`\`\`json\n${answer(both())}\n\`\`\``, ANTHROPIC, { now: NOW }).ok).toBe(true)
  })

  it.each([
    ['prose around the object', () => `Here you go:\n${answer(both())}`, 'not one JSON object'],
    ['another version', () => JSON.stringify({ version: 2, models: both() }), 'not the asked shape'],
    ['a field BMN did not ask for', () => answer(both({ rank: 1 })), 'did not ask for'],
    ['a rank claimed inside a price', () => answer(both({ price: { ...price(20, 100, ANTHROPIC_PAGE), rank: 1 } })), 'neither "unavailable" nor the asked shape'],
    ['a price without its page', () => answer(both({ price: { input: 20, output: 100, as_of: '2026-10-10' } })), 'a source must be an https address'],
    ['a page that is not https', () => answer(both({ price: price(20, 100, 'http://www.anthropic.com/pricing') })), 'a source must be an https address'],
    ['a page with a sign-in', () => answer(both({ price: price(20, 100, 'https://user:pass@anthropic.com/pricing') })), 'carries no sign-in'],
    ['a date that has not come', () => answer(both({ price: { ...price(20, 100, ANTHROPIC_PAGE), as_of: '2026-12-01' } })), 'has not come yet'],
    ['a price that is not a number', () => answer(both({ price: { ...price(20, 100, ANTHROPIC_PAGE), input: '20' } })), 'must be numbers'],
    ['a context window in words', () => answer(both({ context_window: { tokens: '200K', source: ANTHROPIC_PAGE, as_of: '2026-10-10' } })), 'whole number of tokens'],
    ['a model twice', () => answer([...both(), model('claude-opus-5-5', 'Anthropic')]), 'in the answer twice'],
    ['an asked model left out', () => answer([model('claude-fable-5-1', 'Anthropic')]), 'leaves out claude-opus-5-5'],
    ['an asked model marked as listed', () => answer([model('claude-fable-5-1', 'Anthropic', { listed: true }), model('claude-opus-5-5', 'Anthropic')]), 'cannot be a listed model'],
    ['an extra model not marked as listed', () => answer([...both(), model('claude-opus-5-6', 'Anthropic')]), 'not marked as listed'],
    ['too many listed models', () => answer([...both(), ...['a', 'b', 'c'].map((id) => model(`claude-${id}`, 'Anthropic', { listed: true }))]), 'lists 3 other models; 2 were asked for'],
    ['an id no command line could carry', () => answer([...both(), model('claude opus; rm', 'Anthropic', { listed: true })]), 'no usable id']
  ])('fails on %s', (_name, text, reason) => {
    expect(parseAnswer(text(), ANTHROPIC, { now: NOW })).toEqual({ ok: false, reason: expect.stringContaining(reason) })
  })

  it('reads the answer out of what each app prints', () => {
    expect(answerText('claude', JSON.stringify({ type: 'result', is_error: false, result: 'the answer' }), { folder: home })).toEqual({ ok: true, text: 'the answer' })
    expect(answerText('claude', JSON.stringify({ type: 'result', is_error: true, result: 'Not signed in' }), { folder: home }).ok).toBe(false)
    expect(answerText('claude', 'Not JSON', { folder: home }).ok).toBe(false)
    expect(answerText('codex', '', { folder: home })).toEqual({ ok: false, reason: 'Codex wrote no answer' })
    writeFileSync(join(home, 'answer.md'), 'from the file')
    expect(answerText('codex', 'noise', { folder: home })).toEqual({ ok: true, text: 'from the file' })
  })
})

describe('BMN reads each cited page itself (60.10 AC3)', () => {
  const text = pageText(PAGES[ANTHROPIC_PAGE]!)
  const names = (...own: string[]) => [own, ['claude-opus-5-5', 'Claude Opus 5.5', 'claude-fable-5-1', 'Claude Fable 5.1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-6'].filter((name) => !own.includes(name))] as const

  it('counts a price only when the page shows both amounts beside that model, in dollars per million tokens', () => {
    expect(priceShown(text, ...names('claude-opus-5-5', 'Claude Opus 5.5'), { input: 15, output: 75, cached_input: 1.5 })).toEqual({ shown: true, cached: true })
    expect(priceShown(text, ...names('claude-fable-5-1'), { input: 20, output: 100 })).toEqual({ shown: true, cached: undefined })
    expect(priceShown(text, ...names('claude-haiku-5-5'), { input: 0.8, output: 4 }).shown).toBe(true)
    // The numbers are on the page, beside another model.
    expect(priceShown(text, ...names('claude-fable-5-1'), { input: 15, output: 75 })).toEqual({ shown: false, why: 'the page does not show this price beside the model' })
    expect(priceShown(text, ...names('claude-sonnet-5-5'), { input: 3, output: 75 }).shown).toBe(false)
    // A longer amount or a longer name is something else.
    expect(priceShown('per 1M tokens: claude-opus-5-5 input $150 output $750', ['claude-opus-5-5'], [], { input: 15, output: 75 }).shown).toBe(false)
    expect(priceShown('per 1M tokens: claude-opus-5-5 input $15.50 output $75', ['claude-opus-5-5'], [], { input: 15, output: 75 }).shown).toBe(false)
    expect(priceShown('per 1M tokens: gpt-6.1-sol input $2 output $8', ['gpt-6'], [], { input: 2, output: 8 })).toEqual({ shown: false, why: 'the page does not name this model' })
    expect(priceShown('per 1M tokens: gpt-6-mini input $2 output $8', ['gpt-6'], [], { input: 2, output: 8 }).shown).toBe(false)
    expect(priceShown('per 1M tokens: gpt-6. Input $2, output $8.', ['gpt-6'], [], { input: 2, output: 8 }).shown).toBe(true)
    // No unit on the page: the numbers could be anything.
    expect(priceShown('claude-opus-5-5 input $15 output $75', ['claude-opus-5-5'], [], { input: 15, output: 75 })).toEqual({ shown: false, why: 'the page does not say the price is per million tokens' })
    expect(priceShown(text, ['claude-nova-9'], [], { input: 15, output: 75 }).why).toBe('the page does not name this model')
  })

  it('counts a context window in the forms pages use, beside that model', () => {
    expect(windowShown(text, ...names('claude-opus-5-5'), 1_000_000).shown).toBe(true)
    expect(windowShown(text, ...names('claude-fable-5-1'), 200_000).shown).toBe(true)
    expect(windowShown(text, ...names('claude-fable-5-1'), 1_000_000)).toEqual({ shown: false, why: 'the page does not show this context window beside the model' })
    expect(windowShown('gpt-6-luna has a 1.05M context window', ['gpt-6-luna'], [], 1_050_000).shown).toBe(false)
    expect(windowShown('gpt-6-luna: 400,000 tokens of context', ['gpt-6-luna'], [], 400_000).shown).toBe(true)
    expect(windowShown('gpt-6-luna: 1400,000 tokens of context', ['gpt-6-luna'], [], 400_000).shown).toBe(false)
  })

  it('ties each amount to the word beside it: a price under the other word, or in the other order, is not this price', () => {
    const per = 'Prices per 1M tokens. '
    // The page says input $2, output $8; the claim swaps them.
    for (const page of ['gpt-6.1-sol Input: $2.00 Output: $8.00', 'gpt-6.1-sol $2.00 input, $8.00 output', 'gpt-6.1-sol Prompt $2 Completion $8', 'gpt-6.1-sol Output $8.00 Input $2.00 gpt-6-astra Input $10 Output $40']) {
      expect(priceShown(per + page, ['gpt-6.1-sol'], ['gpt-6-astra'], { input: 2, output: 8 }), page).toMatchObject({ shown: true })
      expect(priceShown(per + page, ['gpt-6.1-sol'], ['gpt-6-astra'], { input: 8, output: 2 }), page).toEqual({ shown: false, why: 'the page does not show this price beside the model' })
    }
    // A cached price counts only under its own word; the output amount is not the input because it stands nearby.
    const cached = `${per}claude-opus-5-5 Input $15 Cached input $1.50 Output $75`
    expect(priceShown(cached, ['claude-opus-5-5'], [], { input: 15, output: 75, cached_input: 1.5 })).toEqual({ shown: true, cached: true })
    expect(priceShown(cached, ['claude-opus-5-5'], [], { input: 15, output: 75, cached_input: 75 })).toEqual({ shown: true, cached: false })
    expect(priceShown(cached, ['claude-opus-5-5'], [], { input: 1.5, output: 75 }).shown).toBe(false)
    expect(priceShown(cached, ['claude-opus-5-5'], [], { input: 75, output: 75 }).shown).toBe(false)
    // One amount for both, where the page gives one.
    expect(priceShown(`${per}flat-1 $5 for input and output alike, input $5, output $5`, ['flat-1'], [], { input: 5, output: 5 }).shown).toBe(true)
  })

  it('never counts a bare row of a table: nothing in a page read as text ties a header to it', () => {
    const per = 'Prices per 1M tokens. '
    const bare = { shown: false, why: 'the page does not show this price beside the model' }
    // The header may give the input first or the output first, or belong to another table: the row says neither.
    for (const page of ['Model Input Output gpt-6.1-sol $2.00 $8.00 gpt-6-astra $10 $40', 'Model Output Input gpt-6.1-sol $8 $2 gpt-6.1-nova $4 $0.50', 'Input Output. Other table: gpt-6.1-sol $2 $8', 'gpt-6.1-sol $2 $8']) {
      expect(priceShown(per + page, ['gpt-6.1-sol'], ['gpt-6-astra', 'gpt-6.1-nova'], { input: 2, output: 8 }), page).toEqual(bare)
      expect(priceShown(per + page, ['gpt-6.1-sol'], ['gpt-6-astra', 'gpt-6.1-nova'], { input: 8, output: 2 }), page).toEqual(bare)
    }
    // A cached column, wherever it stands, and one amount for both.
    for (const row of ['$15 $1.50 $75', '$1.50 $15 $75', '$15 $75 $1.50']) {
      expect(priceShown(`${per}Model Input Cached Output claude-opus-5-5 ${row}`, ['claude-opus-5-5'], [], { input: 15, output: 75, cached_input: 1.5 }), row).toEqual(bare)
    }
    expect(priceShown(`${per}flat-1 $5 $5`, ['flat-1'], [], { input: 5, output: 5 })).toEqual(bare)
    // The same amounts with their own words count, and a cached price only under its own.
    expect(priceShown(`${per}claude-opus-5-5 Output $75 Cached input $1.50 Input $15`, ['claude-opus-5-5'], [], { input: 15, output: 75, cached_input: 1.5 })).toEqual({ shown: true, cached: true })
    expect(priceShown(`${per}claude-opus-5-5 Input $15 Output $75 and $1.50`, ['claude-opus-5-5'], [], { input: 15, output: 75, cached_input: 1.5 })).toEqual({ shown: true, cached: false })
  })

  it('counts a number as the context window only beside the word context, never an output limit', () => {
    const page = 'gpt-6-luna Context window 400,000 tokens Max output 128,000 tokens gpt-6-astra 1M context, 128K max output tokens'
    expect(windowShown(page, ['gpt-6-luna'], ['gpt-6-astra'], 400_000).shown).toBe(true)
    expect(windowShown(page, ['gpt-6-luna'], ['gpt-6-astra'], 128_000)).toEqual({ shown: false, why: 'the page does not show this context window beside the model' })
    expect(windowShown(page, ['gpt-6-astra'], ['gpt-6-luna'], 1_000_000).shown).toBe(true)
    expect(windowShown(page, ['gpt-6-astra'], ['gpt-6-luna'], 128_000).shown).toBe(false)
    // A number of tokens with no word saying what it counts proves nothing.
    expect(windowShown('gpt-6-luna handles 400,000 tokens', ['gpt-6-luna'], [], 400_000).shown).toBe(false)
    expect(windowShown('gpt-6-luna Output tokens 128,000 · Context 400K', ['gpt-6-luna'], [], 128_000).shown).toBe(false)
  })

  it('takes a published name only when it is the id\'s own words, so the researcher cannot point at another model\'s row', async () => {
    expect(ownNames({ id: 'claude-opus-5-5', published_name: 'Claude Opus 5.5' })).toEqual(['claude-opus-5-5', 'Claude Opus 5.5'])
    expect(ownNames({ id: 'openai/gpt-6.1-sol-20261001', published_name: 'GPT-6.1 Sol' })).toEqual(['openai/gpt-6.1-sol-20261001', 'GPT-6.1 Sol'])
    for (const published of ['Claude Fable 5.1', 'Claude Opus 5.6', 'Claude Opus', 'Opus 5.5', 'Claude Opus 5.5 Fast']) expect(ownNames({ id: 'claude-opus-5-5', published_name: published }), published).toEqual(['claude-opus-5-5'])
    expect(ownNames({ id: 'claude-opus-5-5' })).toEqual(['claude-opus-5-5'])
    // "synthetic-9" is on no page; the researcher says it is published as Claude Fable 5.1, whose price the page does show.
    const parsed = parseAnswer(answer([
      model('claude-opus-5-5', 'Anthropic', { published_name: 'Claude Fable 5.1', price: price(20, 100, ANTHROPIC_PAGE), context_window: { tokens: 200_000, source: ANTHROPIC_PAGE, as_of: '2026-10-10' } }),
      model('claude-fable-5-1', 'Anthropic', { published_name: 'Claude Fable 5.1', price: price(20, 100, ANTHROPIC_PAGE) })
    ]), ANTHROPIC, { now: NOW })
    if (!parsed.ok) throw new Error(parsed.reason)
    const checked = await verifyModels(parsed.models, ANTHROPIC.sites, { fetchPage })
    expect(checked[0]).toMatchObject({ id: 'claude-opus-5-5', price: { verified: false, why: 'the page does not show this price beside the model' }, context_window: { verified: false } })
    expect(checked[0]).not.toHaveProperty('published_name')
    expect(checked[1]).toMatchObject({ id: 'claude-fable-5-1', published_name: 'Claude Fable 5.1', price: { verified: true } })
  })

  it('drops scripts and markup before it looks', () => {
    expect(pageText('<p>a&nbsp;&amp;&#36;5</p><script>var price = "$99"</script><style>.x{}</style><!-- $77 -->b')).toBe(' a &$5 b')
  })

  it('takes a page\'s rank from its address, never from the answer', () => {
    expect(sourceRank('https://www.anthropic.com/pricing', ['anthropic.com'])).toBe(1)
    expect(sourceRank('https://anthropic.com.prices.example.test/pricing', ['anthropic.com'])).toBe(2)
    expect(sourceRank('https://notanthropic.com/pricing', ['anthropic.com'])).toBe(2)
    expect(sourceRank('https://blog.example.test/', [])).toBe(2)
  })

  it('marks each value verified or not, reads a page once, and drops a cached price the page does not show', async () => {
    const read: string[] = []
    const parsed = parseAnswer(answer([
      model('claude-fable-5-1', 'Anthropic', { price: price(20, 100, ANTHROPIC_PAGE, 2), context_window: { tokens: 200_000, source: ANTHROPIC_PAGE, as_of: '2026-10-10' } }),
      model('claude-opus-5-5', 'Anthropic', { price: price(18, 90, ANTHROPIC_PAGE), context_window: { tokens: 1_000_000, source: 'https://blog.example.test/windows', as_of: '2026-10-10' } }),
      model('claude-opus-5-6', 'Anthropic', { listed: true, price: price(15, 75, 'https://www.anthropic.com/made-up') })
    ]), ANTHROPIC, { now: NOW })
    if (!parsed.ok) throw new Error(parsed.reason)
    const checked = await verifyModels(parsed.models, ANTHROPIC.sites, { fetchPage: (address) => { read.push(address); return fetchPage(address) } })
    expect(read).toEqual([ANTHROPIC_PAGE, 'https://blog.example.test/windows', 'https://www.anthropic.com/made-up'])
    expect(checked[0]).toMatchObject({ price: { input: 20, output: 100, rank: 1, verified: true }, context_window: { tokens: 200_000, rank: 1, verified: true } })
    expect(checked[0]!.price).not.toHaveProperty('cached_input')
    // A wrong number on a real page, a page that cannot be read, and a made-up address on the provider's own site.
    expect(checked[1]).toMatchObject({ price: { verified: false, why: 'the page does not show this price beside the model' }, context_window: { rank: 2, verified: false, why: 'the site answered 404' } })
    expect(checked[2]).toMatchObject({ price: { rank: 1, verified: false, why: 'the site answered 404' } })
  })

  it('reads no page after Stop or past the research\'s time limit, and says which ended it', async () => {
    const three = ['a', 'b', 'c'].map((name) => ({ id: `m-${name}`, provider: 'P', listed: true, price: price(1, 2, `https://prices.example.test/${name}`), context_window: null }))
    const controller = new AbortController()
    const asked: unknown[] = []
    const stopped: { cut?: 'stopped' | 'limit' } = {}
    const afterStop = await verifyModels(three, [], { signal: controller.signal, report: stopped, fetchPage: async (address, limits) => {
      asked.push([address, limits?.signal === controller.signal, limits?.timeoutMs])
      controller.abort()
      return { ok: false, reason: 'the research was stopped' }
    } })
    expect(asked).toEqual([['https://prices.example.test/a', true, 10_000]])
    expect(stopped.cut).toBe('stopped')
    expect(afterStop.map((entry) => entry.price!.why)).toEqual(['the research was stopped', 'the research was stopped before BMN read this page', 'the research was stopped before BMN read this page'])
    // The limit: a page read takes no longer than what is left of the research, and none starts once nothing is left.
    const late: { cut?: 'stopped' | 'limit' } = {}
    const limits: unknown[] = []
    const deadline = Date.now() + 3000
    const slow = await verifyModels(three, [], { deadline, report: late, fetchPage: async (_address, given) => {
      limits.push(given?.timeoutMs)
      await new Promise((resolve) => setTimeout(resolve, 3100))
      return { ok: false, reason: 'the page did not answer in time' }
    } })
    expect(limits).toHaveLength(1)
    expect(limits[0]).toBeGreaterThan(2000)
    expect(limits[0]).toBeLessThanOrEqual(3000)
    expect(late.cut).toBe('limit')
    expect(slow[2]!.price).toMatchObject({ verified: false, why: 'the research reached its time limit before BMN read this page' })
  })

  it('a last page that ran to the end of the research\'s time is the limit too', async () => {
    const one = [{ id: 'm-a', provider: 'P', listed: true, price: price(1, 2, 'https://prices.example.test/a'), context_window: null }]
    const late: { cut?: 'stopped' | 'limit' } = {}
    const checked = await verifyModels(one, [], { deadline: Date.now() + 300, report: late, fetchPage: async (_address, given) => {
      await new Promise((resolve) => setTimeout(resolve, given?.timeoutMs ?? 5000))
      return { ok: false, reason: 'the page did not answer in time' }
    } })
    expect(late.cut).toBe('limit')
    expect(checked[0]!.price).toMatchObject({ verified: false, why: 'the page did not answer in time' })
    // A page read in good time leaves nothing cut.
    const fine: { cut?: 'stopped' | 'limit' } = {}
    await verifyModels(one, [], { deadline: Date.now() + 60_000, report: fine, fetchPage: async () => ({ ok: true, text: 'm-a: input $1, output $2 per 1M tokens' }) })
    expect(fine.cut).toBeUndefined()
  })

  it('reads no more pages than its limit for one run', async () => {
    const many = Array.from({ length: 30 }, (_unused, index) => ({ id: `m-${index}`, provider: 'P', listed: true, price: price(1, 2, `https://prices.example.test/${index}`), context_window: null }))
    let reads = 0
    const checked = await verifyModels(many, [], { fetchPage: async () => { reads += 1; return { ok: false, reason: 'the site answered 404' } } })
    expect(reads).toBe(24)
    expect(checked.at(-1)!.price).toMatchObject({ verified: false, why: 'the answer cites more pages than BMN reads for one run' })
  })
})

describe('a cited address never reaches this machine or a private network', () => {
  const page = { status: 200, type: 'text/html; charset=utf-8', body: '<p>ok</p>' }
  const open = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => page }

  it('knows a public address from a local, private or reserved one', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.0.1.1', '2606:4700::1111']) expect(isPublicAddress(address), address).toBe(true)
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', 'not-an-address']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('reads a plain https page at the address it checked', async () => {
    const seen: unknown[] = []
    const result = await fetchPublicPage('https://www.example.com/pricing?tab=api', { ...open, transport: async (url, address, limits) => { seen.push([url.href, address, limits.maxBytes]); return page } })
    expect(result).toEqual({ ok: true, text: '<p>ok</p>' })
    expect(seen).toEqual([['https://www.example.com/pricing?tab=api', { address: '93.184.216.34', family: 4 }, 2 * 1024 * 1024]])
  })

  it.each([
    ['http', 'http://www.example.com/'],
    ['a sign-in in the address', 'https://user:secret@www.example.com/'],
    ['another port', 'https://www.example.com:8443/'],
    ['a number address', 'https://93.184.216.34/'],
    ['an IPv6 address', 'https://[::1]/'],
    ['this machine by name', 'https://localhost/'],
    ['a name without a dot', 'https://intranet/'],
    ['a local name', 'https://printer.local/'],
    ['a file', 'file:///etc/hostname'],
    ['a reserved test name', 'https://prices.example.test/']
  ])('refuses %s without asking anything', async (_name, address) => {
    let asked = 0
    const result = await fetchPublicPage(address, { resolve: async () => { asked += 1; return [{ address: '93.184.216.34', family: 4 }] }, transport: async () => { asked += 1; return page } })
    expect(result.ok).toBe(false)
    expect(asked).toBe(0)
  })

  it('refuses a name that resolves to a private address, even beside a public one, and never sends the request', async () => {
    let sent = 0
    const transport = async () => { sent += 1; return page }
    expect(await fetchPublicPage('https://rebind.example.com/', { resolve: async () => [{ address: '10.0.0.5', family: 4 }], transport })).toEqual({ ok: false, reason: 'not a public address' })
    expect(await fetchPublicPage('https://rebind.example.com/', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], transport })).toEqual({ ok: false, reason: 'not a public address' })
    expect(await fetchPublicPage('https://gone.example.com/', { resolve: async () => { throw new Error('ENOTFOUND') }, transport })).toEqual({ ok: false, reason: 'the site could not be found' })
    expect(sent).toBe(0)
  })

  it('checks every redirect the same way and follows at most three', async () => {
    const hops: string[] = []
    const moving = (target: (hop: number) => string) => async (url: URL) => { hops.push(url.href); return hops.length <= 5 && target(hops.length) !== '' ? { status: 302, location: target(hops.length) } : page }
    expect(await fetchPublicPage('https://www.example.com/a', { ...open, transport: moving((hop) => (hop === 1 ? '/b' : '')) })).toEqual({ ok: true, text: '<p>ok</p>' })
    expect(hops).toEqual(['https://www.example.com/a', 'https://www.example.com/b'])
    expect(await fetchPublicPage('https://www.example.com/a', { ...open, transport: moving(() => 'https://169.254.169.254/latest/meta-data') })).toEqual({ ok: false, reason: 'not a public address' })
    expect(await fetchPublicPage('https://www.example.com/a', { ...open, transport: moving(() => 'http://www.example.com/plain') })).toEqual({ ok: false, reason: 'not a plain https address' })
    hops.length = 0
    expect(await fetchPublicPage('https://www.example.com/a', { ...open, transport: async (url) => { hops.push(url.href); return { status: 301, location: `/hop-${hops.length}` } } })).toEqual({ ok: false, reason: 'the page moved too many times' })
    expect(hops).toHaveLength(4)
  })

  it('gives up a name lookup that never answers within the page\'s own time, and at Stop', async () => {
    let sent = 0
    const never = { resolve: () => new Promise<never>(() => {}), transport: async () => { sent += 1; return page } }
    const started = Date.now()
    expect(await fetchPublicPage('https://slow.example.com/', { ...never, timeoutMs: 150 })).toEqual({ ok: false, reason: 'the page did not answer in time' })
    expect(Date.now() - started).toBeLessThan(2000)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    expect(await fetchPublicPage('https://slow.example.com/', { ...never, signal: controller.signal })).toEqual({ ok: false, reason: 'the research was stopped' })
    // Already stopped: nothing is asked at all.
    let asked = 0
    expect(await fetchPublicPage('https://www.example.com/', { ...open, signal: controller.signal, resolve: async () => { asked += 1; return [{ address: '93.184.216.34', family: 4 }] } })).toEqual({ ok: false, reason: 'the research was stopped' })
    expect([asked, sent]).toEqual([0, 0])
    // The lookup's time counts against the page's: what is left goes to the request, with the Stop signal.
    const given: unknown[] = []
    await fetchPublicPage('https://www.example.com/', { ...open, timeoutMs: 5000, signal: new AbortController().signal, transport: async (_url, _address, limits) => { given.push(limits.timeoutMs <= 5000, limits.signal instanceof AbortSignal); return page } })
    expect(given).toEqual([true, true])
  })

  it('takes only a text page that arrived whole and in time', async () => {
    expect(await fetchPublicPage('https://www.example.com/', { ...open, transport: async () => ({ status: 404 }) })).toEqual({ ok: false, reason: 'the site answered 404' })
    expect(await fetchPublicPage('https://www.example.com/', { ...open, transport: async () => ({ status: 200, type: 'application/pdf', body: '%PDF' }) })).toEqual({ ok: false, reason: 'the page is not text' })
    expect(await fetchPublicPage('https://www.example.com/', { ...open, transport: async () => ({ status: 200, tooLarge: true }) })).toEqual({ ok: false, reason: 'the page is too large to read' })
    expect(await fetchPublicPage('https://www.example.com/', { ...open, transport: async () => ({ failed: 'the page did not answer in time' }) })).toEqual({ ok: false, reason: 'the page did not answer in time' })
    expect(await fetchPublicPage('https://www.example.com/data.json', { ...open, transport: async () => ({ status: 200, type: 'application/json', body: '{"a":1}' }) })).toEqual({ ok: true, text: '{"a":1}' })
  })

  it('serves a reserved test name from the self-test folder only, and never a path outside it', async () => {
    const pages = join(home, 'pages')
    mkdirSync(join(pages, 'prices.example.test'), { recursive: true })
    writeFileSync(join(pages, 'prices.example.test/pricing'), '<p>made up</p>')
    writeFileSync(join(home, 'secret'), 'not a page')
    expect(await fetchPublicPage('https://prices.example.test/pricing', { selfTestPages: pages })).toEqual({ ok: true, text: '<p>made up</p>' })
    expect(await fetchPublicPage('https://prices.example.test/missing', { selfTestPages: pages })).toEqual({ ok: false, reason: 'the page could not be read' })
    expect((await fetchPublicPage('https://prices.example.test/%2e%2e/%2e%2e/secret', { selfTestPages: pages })).ok).toBe(false)
    // A real site is never served from the folder.
    let asked = 0
    await fetchPublicPage('https://www.example.com/pricing', { selfTestPages: pages, resolve: async () => { asked += 1; return [{ address: '10.0.0.1', family: 4 }] } })
    expect(asked).toBe(1)
  })
})

describe('a research run (60.10 AC2-AC5)', () => {
  it('starts one checked run per provider in an empty folder with only the home and the program path, and keeps what it found', async () => {
    plan(FULL)
    const progress: string[] = []
    const result = await research({ onProgress: ({ done, total }) => progress.push(`${done}/${total}`) })
    expect(result.run).toMatchObject({ kind: 'research', researcher: 'fable', researcher_name: 'Fable', state: 'complete', models: 9 })
    expect(progress).toEqual(['0/8', '4/8', '7/8', '8/8'])
    const started = calls()
    expect(started).toHaveLength(3)
    for (const call of started) {
      expect(call.app).toBe('claude')
      expect(Object.keys(call.env).filter((name) => !['HOME', 'PATH'].includes(name) && !name.startsWith('__'))).toEqual([])
      expect(call.files).toEqual([])
      expect(call.cwd.startsWith(`${researchRunsDirectory()}/`)).toBe(true)
      expect(call.argv).toEqual(['-p', '--model', 'claude-fable-5-1', '--effort', 'low', '--safe-mode', '--tools', 'WebSearch,WebFetch', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence', '--output-format', 'json'])
      expect(call.prompt).not.toMatch(/SENTINEL|Owner's notes/)
    }
    // Each run left the check's receipt beside the prompt it was given.
    const runs = readdirSync(researchRunsDirectory())
    expect(runs).toHaveLength(3)
    for (const run of runs) {
      const receipt = JSON.parse(readFileSync(join(researchRunsDirectory(), run, 'receipt.json'), 'utf8'))
      expect(receipt).toMatchObject({ mode: 'research', verdict: 'PASS', agent: 'fable' })
      expect(readFileSync(join(researchRunsDirectory(), run, 'prompt.md'), 'utf8')).toBe(started.find((call) => call.cwd === join(researchRunsDirectory(), run, 'cwd'))!.prompt)
    }
    const store = readResearch()
    expect(store.runs).toHaveLength(1)
    expect(store.models.map((entry) => [entry.id, entry.provider_id, entry.price?.verified ?? null])).toEqual([
      ['claude-fable-5-1', 'anthropic', true], ['claude-haiku-5-5', 'anthropic', true], ['claude-opus-5-5', 'anthropic', true], ['claude-sonnet-5-5', 'anthropic', true],
      ['claude-opus-5-6', 'anthropic', true], ['gpt-6-astra', 'openai', true], ['gpt-6-luna', 'openai', true], ['gpt-6.1-sol', 'openai', true], ['glm-5.3', 'zai', null]
    ])
    expect((readFileSync(researchResultsPath()).length)).toBeGreaterThan(0)
  })

  it('a later research says what is new since the last one, and what it did not find this time', async () => {
    plan(FULL)
    await research()
    const first = researchView(readResearch())
    expect(first.last).toEqual({ at: NOW.toISOString(), researcher: 'Fable', state: 'complete', models: 9 })
    expect(first.previousAt).toBeNull()
    expect(first.models.filter((entry) => entry.fresh)).toHaveLength(9)
    expect(first.models.find((entry) => entry.id === 'claude-opus-5-5')).toMatchObject({ provider: 'Anthropic', providerId: 'anthropic', publishedName: 'Claude Opus 5.5', foundLast: true,
      price: { input: 15, output: 75, cached_input: 1.5, source: ANTHROPIC_PAGE, as_of: '2026-10-10', rank: 1, verified: true }, contextWindow: { tokens: 1_000_000, verified: true } })
    const later = new Date('2026-10-17T09:00:00.000Z')
    plan({ ...FULL, 'claude-fable-5-1': { text: ANTHROPIC_ANSWER.replace('"claude-opus-5-6"', '"claude-opus-5-7"').replace(/"as_of":"2026-10-10"/g, '"as_of":"2026-10-17"') }, 'glm-5.3': { text: 'I could not find it.' } })
    const second = await research({ now: () => later })
    expect(second.run).toMatchObject({ state: 'partial', note: expect.stringContaining('Z.ai: the answer is not one JSON object') })
    const view = researchView(readResearch())
    expect(view.last).toMatchObject({ at: later.toISOString(), state: 'partial' })
    expect(view.previousAt).toBe(NOW.toISOString())
    // The page shows no claude-opus-5-7, so it is new and its price is unverified.
    expect(view.models.filter((entry) => entry.fresh).map((entry) => [entry.id, entry.price?.verified])).toEqual([['claude-opus-5-7', false]])
    expect(view.models.find((entry) => entry.id === 'claude-opus-5-6')).toMatchObject({ fresh: false, foundLast: false, firstSeen: NOW.toISOString() })
    expect(view.models.find((entry) => entry.id === 'glm-5.3')).toMatchObject({ foundLast: false, lastSeen: NOW.toISOString() })
    expect(view.models.find((entry) => entry.id === 'claude-opus-5-5')).toMatchObject({ foundLast: true, firstSeen: NOW.toISOString(), lastSeen: later.toISOString() })
  })

  it('Stop ends the run that is going and keeps what the earlier runs found, marked partial', async () => {
    plan({ ...FULL, 'gpt-6-astra': { text: OPENAI_ANSWER, delay: 60_000 } })
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = await research({ signal: controller.signal, onProgress: ({ done }) => { if (done === 4) setTimeout(() => controller.abort(), 150) } })
    expect(Date.now() - startedAt).toBeLessThan(20_000)
    expect(result.run).toMatchObject({ state: 'partial', note: 'Stopped before it finished.', models: 5 })
    expect(calls()).toHaveLength(2)
    expect(readResearch().models.map((entry) => entry.provider_id)).toEqual(['anthropic', 'anthropic', 'anthropic', 'anthropic', 'anthropic'])
    expect(researchView(readResearch()).last).toMatchObject({ state: 'partial', note: 'Stopped before it finished.' })
  })

  it('Stop while the cited pages are being read ends the research there, even on its last run', async () => {
    plan({ 'claude-opus-5-6': { text: answer([model('claude-opus-5-6', 'Anthropic', { price: price(15, 75, ANTHROPIC_PAGE), context_window: { tokens: 1_000_000, source: 'https://blog.example.test/windows', as_of: '2026-10-10' } })]) } })
    const controller = new AbortController()
    const read: string[] = []
    const result = await research({ only: { provider: 'anthropic', model: 'claude-opus-5-6' }, signal: controller.signal, fetchPage: async (address, limits) => {
      read.push(address)
      expect(limits?.signal).toBe(controller.signal)
      controller.abort()
      return { ok: false, reason: 'the research was stopped' }
    } })
    expect(read).toHaveLength(1)
    // What the run answered is kept, marked: none of its values was read on its page, and the research did not finish.
    expect(result.run).toMatchObject({ kind: 'lookup', state: 'partial', note: 'Stopped before it finished.', models: 1 })
    expect(result.found[0]).toMatchObject({ price: { verified: false, why: 'the research was stopped' }, context_window: { verified: false, why: 'the research was stopped before BMN read this page' } })
  })

  it('the time limit ends it the same way, and a research that found nothing is not kept', async () => {
    plan({ 'claude-fable-5-1': { text: ANTHROPIC_ANSWER, delay: 60_000 } })
    const result = await research({ limitMs: 400 })
    expect(result.run).toMatchObject({ state: 'stopped', note: 'Ended at the 20-minute limit.', models: 0 })
    expect(existsSync(researchResultsPath())).toBe(false)
  })

  it('a failed run or an error from the app fails that provider only', async () => {
    plan({ ...FULL, 'claude-fable-5-1': { exit: 3 }, 'glm-5.3': { text: 'Not signed in', error: true } })
    const result = await research()
    expect(result.run).toMatchObject({ state: 'partial', models: 3 })
    expect(result.run.note).toBe('Anthropic: the app ended with code 3; Z.ai: Claude Code reported an error instead of an answer')
    expect(readResearch().models.map((entry) => entry.id)).toEqual(['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'])
  })

  it('starts nothing when the check refuses the researcher', async () => {
    plan(FULL)
    for (const researcher of ['sonnet', 'nobody']) {
      const result = await research({ researcher })
      expect(result.run.state).toBe('failed')
      expect(result.found).toEqual([])
    }
    expect((await research({ researcher: 'sonnet' })).run.note).toContain('BMN did not start the run: sonnet is proposed')
    expect(calls()).toEqual([])
    expect(existsSync(researchResultsPath())).toBe(false)
  })

  it('a Codex agent researches through its own form, once the fence test of its version is on record, and writes the answer beside the prompt', async () => {
    plan(FULL)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/auth.json'), '{"synthetic":"sign-in"}\n')
    // Without that record no run is started.
    const refused = await research({ researcher: 'astra', compare: SAME })
    expect(refused.run).toMatchObject({ state: 'failed', models: 0, note: expect.stringContaining('BMN did not start the run: research runs in Codex only on a version whose fence test passed') })
    expect(calls()).toEqual([])
    const compared: string[] = []
    const result = await research({ researcher: 'astra', fenceTests: FENCED, compare: async ({ agent }) => { compared.push(agent.id); return { ok: true } } })
    expect(result.run).toMatchObject({ state: 'complete', researcher_name: 'Astra', models: 9 })
    // Once per research, before its first run: is the tool list under the provider's own model list the tested one (63.3 AC6)?
    expect(compared).toEqual(['astra'])
    expect(calls()).toHaveLength(3)
    const first = calls()[0]!
    expect(first.app).toBe('codex')
    expect(first.argv.slice(0, 6)).toEqual(['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--strict-config'])
    expect(first.argv).toEqual(expect.arrayContaining(['web_search="live"', 'features.shell_tool=false', 'mcp_servers={}', 'project_doc_max_bytes=0', 'hooks', 'gpt-6-astra', 'model_reasoning_effort="low"']))
    expect(first.argv.at(-1)).toBe('-')
    expect(first.files).toEqual([])
    expect(Object.keys(first.env).filter((name) => !['HOME', 'PATH', 'CODEX_HOME'].includes(name) && !name.startsWith('__'))).toEqual([])
    expect(first.argv[first.argv.indexOf('-o') + 1]).toBe(join(first.cwd, '..', 'answer.md'))
    // The run saw a Codex folder of its own that held only the link to the sign-in file (63.3 AC1) ...
    expect(first.env.CODEX_HOME).toBe(join(first.cwd, '..', 'codex'))
    for (const call of calls()) expect(call.codex).toEqual([`auth.json -> ${join(home, '.codex/auth.json')}`])
    // ... and that folder went with the run, whatever the app left in it; the sign-in file is as it was (63.3 AC5).
    for (const call of calls()) expect(existsSync(join(call.cwd, '..', 'codex'))).toBe(false)
    expect(existsSync(join(first.cwd, '..', 'receipt.json'))).toBe(true)
    expect(readFileSync(join(home, '.codex/auth.json'), 'utf8')).toBe('{"synthetic":"sign-in"}\n')
    expect(lstatSync(join(home, '.codex/auth.json')).isSymbolicLink()).toBe(false)
  })

  it('no Codex run starts, and no answer is used, where the tool list under the provider\'s own model list is not the tested one (63.3 AC6)', async () => {
    plan(FULL)
    const differs = await research({ researcher: 'astra', fenceTests: FENCED, compare: async () => ({ ok: false, reason: 'under the provider\'s own model list the fence test of Codex 0.161.0 did not pass for gpt-6-astra: a tool BMN has not looked at: function:functions.shell' }) })
    expect(differs.run).toMatchObject({ state: 'failed', models: 0, note: expect.stringContaining('BMN did not start the run: under the provider\'s own model list') })
    const broken = await research({ researcher: 'astra', fenceTests: FENCED, compare: async () => { throw new Error('the comparison broke') } })
    expect(broken.run).toMatchObject({ state: 'failed', note: 'BMN did not start the run: the comparison broke' })
    expect(calls()).toEqual([])
    expect(existsSync(researchResultsPath())).toBe(false)
    // The folder BMN made for the run that never started is gone too.
    for (const name of readdirSync(researchRunsDirectory())) expect(existsSync(join(researchRunsDirectory(), name, 'codex'))).toBe(false)
    // A researcher on Claude Code is never compared: its tools are the ones its command names.
    const claude = await research({ compare: async () => { throw new Error('not asked') } })
    expect(claude.run.state).toBe('complete')
  })

  it('Stop and the time limit reach the comparison: it is handed both, and no run starts after either', async () => {
    plan(FULL)
    const controller = new AbortController()
    const given: { signal: boolean, limitMs: number | undefined }[] = []
    const stopped = await research({ researcher: 'astra', fenceTests: FENCED, signal: controller.signal, limitMs: 60_000, compare: async ({ signal, limitMs }) => {
      given.push({ signal: signal === controller.signal, limitMs })
      // He presses Stop while the comparison is under way; the comparison itself would have passed.
      controller.abort()
      return { ok: true, compared: true }
    } })
    expect(given).toHaveLength(1)
    expect(given[0]!.signal).toBe(true)
    expect(given[0]!.limitMs).toBeGreaterThan(0)
    expect(given[0]!.limitMs).toBeLessThanOrEqual(60_000)
    expect(stopped.run).toMatchObject({ state: 'stopped', note: 'Stopped before it finished.', models: 0 })
    expect(calls()).toEqual([])
    // A comparison that says it was stopped is a Stop, never a failed research.
    const second = new AbortController()
    const told = await research({ researcher: 'astra', fenceTests: FENCED, signal: second.signal, compare: async () => { second.abort(); return { ok: false, stopped: true, reason: 'the comparison was stopped' } } })
    expect(told.run).toMatchObject({ state: 'stopped', note: 'Stopped before it finished.' })
    // The time limit: a comparison that outlasts it ends the research at the limit.
    const late = await research({ researcher: 'astra', fenceTests: FENCED, limitMs: 200, compare: async ({ limitMs }) => {
      expect(limitMs).toBeLessThanOrEqual(200)
      await new Promise((done) => setTimeout(done, 300))
      return { ok: true, compared: true }
    } })
    expect(late.run).toMatchObject({ state: 'stopped', note: 'Ended at the 20-minute limit.', models: 0 })
    expect(calls()).toEqual([])
    expect(existsSync(researchResultsPath())).toBe(false)
    for (const name of readdirSync(researchRunsDirectory())) expect(existsSync(join(researchRunsDirectory(), name, 'codex'))).toBe(false)
  })

  it('an agent whose context limit the owner\'s test proved researches with that limit in its command', async () => {
    // Sol has a context limit; once its setting is proven on this Codex version, every run of Sol must carry it.
    writeFileSync(join(home, '.config/bmn/agents/state/context-tests.jsonl'), `${JSON.stringify({ harness: 'codex', version: '0.161.0', limit: 'pass', compact: 'pass' })}\n`)
    expect(researchers({ environment: env, now: NOW, fenceTests: FENCED }).find((entry) => entry.id === 'sol')).toMatchObject({ id: 'sol', name: 'Sol', harness: 'codex', ok: true })
    plan(FULL)
    const result = await research({ researcher: 'sol', fenceTests: FENCED, compare: SAME })
    expect(result.run).toMatchObject({ state: 'complete', models: 9 })
    const first = calls()[0]!
    expect(first.argv).toEqual(expect.arrayContaining(['model_context_window=272000']))
    const receipt = JSON.parse(readFileSync(join(first.cwd, '..', 'receipt.json'), 'utf8')) as { context_limit_applied: number | null }
    expect(receipt.context_limit_applied).toBe(272000)
  })

  it('Look up researches one name and is not a research of the team', async () => {
    plan({ 'claude-opus-5-6': { text: answer([model('claude-opus-5-6', 'Anthropic', { price: price(15, 75, ANTHROPIC_PAGE) })]) } })
    const result = await research({ only: { provider: 'anthropic', model: 'claude-opus-5-6' } })
    expect(result.run).toMatchObject({ kind: 'lookup', state: 'complete', models: 1 })
    expect(result.found[0]).toMatchObject({ id: 'claude-opus-5-6', provider_id: 'anthropic', listed: false, price: { input: 15, output: 75, verified: true } })
    expect(calls()[0]!.prompt).toContain('List no other models.')
    const view = researchView(readResearch())
    expect(view.last).toBeNull()
    expect(view.models.map((entry) => [entry.id, entry.fresh, entry.foundLast])).toEqual([['claude-opus-5-6', false, false]])
    expect((await research({ only: { provider: 'anthropic', model: 'bad name' } })).run).toMatchObject({ state: 'failed', note: expect.stringContaining('cannot be researched') })
  })
})

describe('what is kept between researches', () => {
  it('a value a later research could not find does not erase an earlier one, and the first date stays', () => {
    const first = { id: 'r1', kind: 'research' as const, at: '2026-10-03T09:00:00.000Z', researcher: 'fable', researcher_name: 'Fable', state: 'complete' as const, models: 1 }
    const found = { id: 'gpt-6-luna', provider: 'OpenAI', provider_id: 'openai', listed: false, price: { ...price(0.4, 1.6, OPENAI_PAGE), rank: 1 as const, verified: true }, context_window: null }
    let store = mergeResearch(readResearch(), first, [found])
    store = mergeResearch(store, { ...first, id: 'r2', at: '2026-10-10T09:00:00.000Z' }, [{ ...found, price: null }])
    expect(store.models).toEqual([expect.objectContaining({ id: 'gpt-6-luna', price: expect.objectContaining({ input: 0.4 }), first_seen: '2026-10-03T09:00:00.000Z', first_run: 'r1', last_seen: '2026-10-10T09:00:00.000Z', last_run: 'r2' })])
    expect(store.runs.map((run) => run.id)).toEqual(['r1', 'r2'])
  })

  it('reads a missing or damaged file as nothing found', () => {
    expect(readResearch()).toEqual({ version: 1, runs: [], models: [] })
    mkdirSync(join(home, '.config/bmn/agents/state/research'), { recursive: true })
    writeFileSync(researchResultsPath(), '{ not json')
    expect(readResearch()).toEqual({ version: 1, runs: [], models: [] })
  })
})
