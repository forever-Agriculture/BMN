// MODULE: agents-research.test.ts - Story 60.10 (first release): model research over a synthetic team, stub researchers and made-up pages; no provider and no real site is reached
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_RESEARCH_CONFIG, researchRunsDirectory } from '../../bin/agents-check.mjs'
import {
  MAX_LISTED, answerText, chooseResearcher, chosenResearcher, fetchPublicPage, isPublicAddress, mergeResearch, pageText, parseAnswer, priceShown, readResearch,
  researchArgv, researchBatches, researchEffort, researchPrompt, researchResultsPath, researchSubjects, researchView, researchers, runResearch, sourceRank,
  verifyModels, windowShown, type AnsweredModel, type PageRead, type ResearchBatch
} from '../../bin/agents-research.mjs'
import { parseRoster } from '../../bin/agents-roster.mjs'
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
fs.appendFileSync(home + '/calls.log', JSON.stringify({ app: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), files: fs.readdirSync('.'), prompt }) + '\\n')
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
const calls = (): { app: string; argv: string[]; env: Record<string, string>; cwd: string; files: string[]; prompt: string }[] =>
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
    expect(researchArgv(luna, { environment: env, run: { folder: '/run' } })).toEqual(['/usr/bin/env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, 'codex', 'exec', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', ...CODEX_RESEARCH_CONFIG.flatMap((entry) => ['-c', entry]), '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="max"', '-o', '/run/answer.md', '-'])
  })
})

describe('who may research (60.10 AC1)', () => {
  it('offers the active agents whose run the check would pass, and says why the others cannot', () => {
    const edited = EXAMPLE.replace('enabled: false\nstatus: active\nefforts: []\nroles: [helper]', 'enabled: true\nstatus: active\nefforts: [low]\nroles: [helper]')
      .replace('## roles', '## kimi\n\n```yaml\nname: Kimi\nclass: pawn\nharness: opencode\nmodel: kimi-k3\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low]\nroles: [helper]\n```\n\n## roles')
    expect(edited).not.toBe(EXAMPLE)
    approve(edited)
    const found = researchers({ environment: env, now: NOW })
    expect(found.filter((entry) => entry.ok).map((entry) => entry.id)).toEqual(['sol', 'opus', 'astra', 'fable', 'luna'])
    // Proposed agents are not offered at all; a public-only provider needs a verified fence; OpenCode has no research form.
    expect(found.map((entry) => entry.id)).not.toContain('sonnet')
    expect(found.find((entry) => entry.id === 'glm')).toMatchObject({ ok: false, reason: expect.stringContaining('fence') })
    expect(found.find((entry) => entry.id === 'kimi')).toMatchObject({ ok: false, reason: 'OpenCode has no research form BMN can check' })
  })

  it('remembers the researcher the owner picked', () => {
    expect(chosenResearcher()).toBeNull()
    chooseResearcher('luna')
    expect(chosenResearcher()).toBe('luna')
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

  it('a Codex agent researches through its own form and writes the answer beside the prompt', async () => {
    plan(FULL)
    const result = await research({ researcher: 'astra' })
    expect(result.run).toMatchObject({ state: 'complete', researcher_name: 'Astra', models: 9 })
    const first = calls()[0]!
    expect(first.app).toBe('codex')
    expect(first.argv.slice(0, 5)).toEqual(['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only'])
    expect(first.argv).toEqual(expect.arrayContaining(['web_search="live"', 'features.shell_tool=false', 'mcp_servers={}', 'gpt-6-astra', 'model_reasoning_effort="low"']))
    expect(first.argv.at(-1)).toBe('-')
    expect(first.files).toEqual([])
    expect(Object.keys(first.env).filter((name) => !['HOME', 'PATH'].includes(name) && !name.startsWith('__'))).toEqual([])
    expect(first.argv[first.argv.indexOf('-o') + 1]).toBe(join(first.cwd, '..', 'answer.md'))
  })

  it('an agent whose context limit the owner\'s test proved researches with that limit in its command', async () => {
    // Sol has a context limit; once its setting is proven on this Codex version, every run of Sol must carry it.
    writeFileSync(join(home, '.config/bmn/agents/state/context-tests.jsonl'), `${JSON.stringify({ harness: 'codex', version: '0.161.0', limit: 'pass', compact: 'pass' })}\n`)
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'sol')).toEqual({ id: 'sol', name: 'Sol', harness: 'codex', ok: true })
    plan(FULL)
    const result = await research({ researcher: 'sol' })
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
