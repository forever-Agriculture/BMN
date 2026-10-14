// MODULE: agents-fence.test.ts - Stories 63.3 and 70.3: the fence test of a Codex and an OpenCode research run, over stand-in apps and the loopback stand-in for their provider; no provider and no real app is reached
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_RESEARCH_TOOLS_SEEN, OPENCODE_RESEARCH_TOOLS_SEEN, bindSession, bindingPath, evaluateResearch, fenceStanding, fenceTests, fenceTestsPath, prepareResearchRun, researchFormHash, researchRunsDirectory, type FenceTestEntry } from '../../bin/agents-check.mjs'
import { FENCE_MARKERS, compareUnderProviderList, fenceDirectory, fenceSubjects, markersIn, providerModelList, runFenceTest } from '../../bin/agents-fence.mjs'
import { readQuestions, runAsk } from '../../bin/agents-ask.mjs'
import { answerText, researchArgv, researchers, runResearch } from '../../bin/agents-research.mjs'
import { openCodeFolder, openCodeFolderProblem, openCodeSession } from '../../bin/agents-opencode.mjs'
import { processLives } from '../../bin/agents-supervised.mjs'
import type { RosterAgent } from '../../bin/agents-roster.mjs'
import { readApproved, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const FAKE = fileURLToPath(new URL('./test-fixtures/agents/fake-codex.mjs', import.meta.url))
const FAKE_OPENCODE = fileURLToPath(new URL('./test-fixtures/agents/fake-opencode.mjs', import.meta.url))
const NOW = new Date('2026-10-10T12:00:00.000Z')

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

/** How the stand-in Codex behaves in this test; see fake-codex.mjs. */
function codex(mode: Record<string, unknown> = {}): void {
  writeFileSync(join(stubs, 'codex-mode.json'), JSON.stringify(mode))
}

const agents = (...ids: string[]): RosterAgent[] => readApproved().data.agents.filter((agent) => ids.includes(agent.id))
const test = (options: Parameters<typeof runFenceTest>[0] = {}) => runFenceTest({ agents: agents('luna'), environment: env, now: NOW, limitMs: 20_000, ...options })
/** The research command as it was built on 0d9a91b, before this story: the owner's own Codex folder and seven switches. */
const AS_BUILT = (agent: RosterAgent, { environment, run }: { environment: Record<string, string | undefined>; run: { folder: string } }): string[] => ['/usr/bin/env', '-i', `HOME=${environment.HOME}`, `PATH=${environment.PATH}`,
  'codex', 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-c', 'mcp_servers={}', '-c', 'web_search="live"', '-c', 'features.shell_tool=false',
  '-c', 'features.unified_exec=false', '-c', 'features.multi_agent=false', '-c', 'features.apps=false', '-c', 'features.plugins=false',
  '-m', agent.model, '-c', 'model_reasoning_effort="max"', '-o', `${run.folder}/answer.md`, '-']

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-fence-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  // Started by this very Node, wherever the machine keeps it: the program path below holds no real Codex.
  writeFileSync(join(stubs, 'codex'), readFileSync(FAKE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`))
  chmodSync(join(stubs, 'codex'), 0o755)
  writeFileSync(join(stubs, 'claude'), '#!/bin/sh\necho "2.1.295 (Claude Code)"\n')
  chmodSync(join(stubs, 'claude'), 0o755)
  codex()
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), EXAMPLE)
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('the fence test of a Codex research run (63.3 AC2, AC3)', () => {
  it('passes with the research form for Sol, Luna and Astra, records it against the version and the form, and opens the offer', async () => {
    expect(researchers({ environment: env, now: NOW }).filter((entry) => entry.harness === 'codex').map((entry) => [entry.id, entry.ok, entry.why])).toEqual([
      ['sol', false, 'the fence test has not run for this version of Codex yet'], ['astra', false, 'the fence test has not run for this version of Codex yet'],
      ['luna', false, 'the fence test has not run for this version of Codex yet']])
    const entry = await runFenceTest({ environment: env, now: NOW, limitMs: 20_000 })
    expect(entry, JSON.stringify(entry)).toMatchObject({ harness: 'codex', version: '0.161.0', form: researchFormHash('codex'), catalog: 'bundled', verdict: 'pass', renewal: 'through-link', reasons: [] })
    expect(entry.models.map((model) => [model.model, model.verdict, model.reasons])).toEqual([['gpt-6.1-sol', 'pass', []], ['gpt-6-astra', 'pass', []], ['gpt-6-luna', 'pass', []]])
    // Every tool the stand-in Codex offers was called, the ones inside its script tool too, and each is one BMN has looked at.
    for (const model of entry.models) expect(model.tools).toEqual([...CODEX_RESEARCH_TOOLS_SEEN].sort())
    expect(fenceTests()).toEqual([entry])
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: true, live: null, tools: [...CODEX_RESEARCH_TOOLS_SEEN].sort() })
    // The record is of exactly that version: any other stays closed.
    expect(fenceStanding('codex', '0.162.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'untested' })
    expect(researchers({ environment: env, now: NOW }).filter((entry) => entry.harness === 'codex').map((entry) => [entry.id, entry.ok, entry.fence?.compared])).toEqual([
      ['sol', true, false], ['astra', true, false], ['luna', true, false]])
    // The throwaway home folders are gone, and nothing was written beside the record.
    expect(readdirSync(fenceDirectory())).toEqual([])
    expect(readFileSync(fenceTestsPath(), 'utf8')).not.toMatch(/FENCE-[A-Z]+-[0-9a-f]{8}/)
  }, 60_000)

  it('fails as the command was built on 0d9a91b: the rules file, the skills and a picture reach the provider', async () => {
    const entry = await test({ argvOf: AS_BUILT, record: true })
    expect(entry.verdict).toBe('fail')
    const reasons = entry.models[0]!.reasons.join('\n')
    expect(reasons).toContain(`reached the provider: ${FENCE_MARKERS.RULES}, ${FENCE_MARKERS.SKILL} and ${FENCE_MARKERS.AGENTSKILL}`)
    expect(reasons).toContain('a picture was sent to the provider')
    expect(reasons).toContain('a tool gave back a planted file: unoffered-view_image, script-attempts and exec:view_image')
    expect(reasons).toContain('a tool BMN has not looked at: ')
    expect(reasons).toContain('exec:view_image')
    expect(reasons).toContain('function:clock.sleep')
    // It is not the research form, so even its record counts for nothing.
    expect(entry.form).toBe('other')
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'untested' })
  }, 60_000)

  it('a tool that is new fails the test, so an update that adds one closes the offer until it is looked at', async () => {
    expect((await test()).verdict).toBe('pass')
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')?.ok).toBe(true)
    codex({ version: '0.163.0', extraTools: ['read_file'] })
    // The new version has no record yet.
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')).toMatchObject({ ok: false, why: 'the fence test has not run for this version of Codex yet' })
    const entry = await test()
    expect(entry).toMatchObject({ version: '0.163.0', verdict: 'fail' })
    expect(entry.models[0]!.reasons).toEqual(['a tool BMN has not looked at: function:functions.read_file'])
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')).toMatchObject({ ok: false, why: 'the fence test of this version of Codex did not pass',
      reason: expect.stringContaining('a tool BMN has not looked at: function:functions.read_file') })
  }, 60_000)

  it.each([
    ['a tool gives back a planted file', { extraTools: ['read_file'], extraToolReads: 'SENTINEL-HOME.txt' }, 'a tool gave back a planted file: unoffered-read_file and offered-function:functions.read_file'],
    ['a tool inside the script tool gives back a planted file', { resourceReadsFiles: true }, 'a tool gave back a planted file: script-attempts and exec:read_mcp_resource'],
    // Only the start of each result is printed, so the script looks through the whole of it itself.
    ['a tool inside the script tool gives back a planted file after words of its own', { resourceReadsFiles: true, resourceLead: 900 }, 'a tool gave back a planted file: exec:read_mcp_resource'],
    // A file that is not text comes back as its bytes in base64, with no sign before them: the script looks for that form too.
    ['a tool inside the script tool gives back a planted file as base64 after words of its own', { resourceReadsFiles: true, resourceBlob: true, resourceLead: 900 }, 'a tool gave back a planted file: exec:read_mcp_resource'],
    ['the web tool opens an address on this computer by itself', { webFetchesLocal: true }, 'a tool fetched an address on this computer'],
    ['a tool is offered only once the run is under way', { lateTools: ['read_file'] }, 'offered but not called: function:read_file\na tool BMN has not looked at: function:read_file'],
    ['something is written', { writes: true }, 'written during the run: .local/state/bmn/research/runs/fence-main/cwd/fence-written-script.txt'],
    ['a hook runs whatever the run switches off', { runsHooks: 'always' }, 'a hook ran']
  ])('fails when %s', async (_name, mode, reason) => {
    codex(mode)
    const entry = await test({ renewal: false })
    expect(entry.verdict).toBe('fail')
    expect(entry.models[0]!.reasons.join('\n')).toContain(reason)
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'failed' })
  }, 60_000)

  it.each([
    ['offers a tool', { renewalTools: ['read_file'] }, 'a tool BMN has not looked at: function:functions.read_file'],
    ['sends a planted file', { renewalSendsHomeRules: true }, `reached the provider: ${FENCE_MARKERS.HOMEDOC}`]
  ])('the run that renews the sign-in is read like the others: one that %s only there fails the test', async (_name, mode, reason) => {
    codex(mode)
    const entry = await test()
    expect(entry).toMatchObject({ verdict: 'fail', renewal: 'through-link' })
    expect(entry.models[0]!.reasons.join('\n')).toContain(reason)
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'failed' })
    // Without the renewal run the same Codex shows nothing of it: that run is where it happens.
    expect((await test({ renewal: false })).verdict).toBe('pass')
  }, 60_000)

  it('a hook that ran also put its text before the provider', async () => {
    codex({ runsHooks: 'always' })
    expect((await test({ renewal: false })).models[0]!.reasons.join('\n')).toContain(`reached the provider: ${FENCE_MARKERS.HOOK}`)
    // A version that only keeps to the switch runs none: the run switches hooks off, and its own Codex folder holds none.
    codex({ runsHooks: true })
    expect((await test({ renewal: false })).verdict).toBe('pass')
  }, 60_000)

  it('fails when a sign-in renewal replaces the link, which would leave the owner\'s own file with the old sign-in (63.3 AC5)', async () => {
    codex({ renewalReplacesLink: true })
    const entry = await test()
    expect(entry).toMatchObject({ verdict: 'fail', renewal: 'link-replaced' })
    expect(entry.reasons).toEqual([expect.stringContaining('replaced the link with a file of its own')])
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'failed', reasons: [expect.stringContaining('replaced the link')] })
  }, 60_000)

  it('shows nothing, and opens nothing, where Codex stops at a setting it does not know or never reaches the stand-in', async () => {
    codex({ unknownSettings: ['include_environment_context'] })
    const stopped = await test({ renewal: false })
    expect(stopped.verdict).toBe('inconclusive')
    expect(stopped.models[0]!.reasons).toEqual([expect.stringContaining('Codex did not finish the run (code 1: error: unknown configuration field include_environment_context')])
    codex({ silent: true })
    const silent = await test({ renewal: false })
    expect(silent).toMatchObject({ verdict: 'inconclusive' })
    expect(silent.models[0]!.reasons).toEqual(['Codex never asked the stand-in for an answer'])
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna').passed).toBe(false)
    rmSync(join(stubs, 'codex'))
    expect(await test()).toMatchObject({ verdict: 'inconclusive', version: null, models: [], reasons: ['codex is not installed or did not answer --version'] })
  }, 60_000)

  it('finds a marker plainly and inside base64, at any byte alignment', () => {
    const markers = { HOME: 'FENCE-HOME-1a2b3c4d', RULES: 'FENCE-RULES-1a2b3c4d' }
    expect(markersIn('nothing here', markers)).toEqual([])
    expect(markersIn(`a line with ${markers.RULES} in it`, markers)).toEqual(['RULES'])
    for (const lead of ['', 'x', 'xy']) expect(markersIn(Buffer.from(`${lead}${markers.HOME}\n`).toString('base64'), markers)).toEqual(['HOME'])
  })

  it('covers each Codex model of the approved team once', () => {
    const data = readApproved().data
    expect(fenceSubjects(data).map((agent) => agent.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
    expect(fenceSubjects({ agents: [...data.agents, { ...data.agents.find((agent) => agent.id === 'luna')!, id: 'luna-2' }] }).map((agent) => agent.id)).toEqual(['sol', 'astra', 'luna'])
  })
})

describe('the tool list under the provider\'s own model list (63.3 AC6)', () => {
  const LISTED = [{ slug: 'gpt-6-luna', base_instructions: 'You are Luna.', experimental_supported_tools: ['clock'] }, { slug: 'gpt-6-astra', base_instructions: 'You are Astra.', experimental_supported_tools: [] }]
  const compare = (options: Partial<Parameters<typeof compareUnderProviderList>[0]> = {}) =>
    compareUnderProviderList({ agent: agents('luna')[0]!, environment: env, now: NOW, test: (inner) => runFenceTest({ ...inner, limitMs: 20_000 }), ...options })

  it('asks Codex for the list through a folder that holds only the link, and takes it only as fetched', async () => {
    codex({ providerModels: LISTED })
    expect(await providerModelList({ environment: env })).toEqual({ ok: true, models: LISTED })
    // With no answer from the provider Codex falls back to the list it was built with: that is not the provider's.
    codex({})
    expect(await providerModelList({ environment: env })).toEqual({ ok: false, reason: 'Codex did not get the provider\'s model list' })
    codex({ providerModels: LISTED, listFails: true })
    expect(await providerModelList({ environment: env })).toEqual({ ok: false, reason: 'Codex could not be asked for the provider\'s model list' })
    expect(readdirSync(fenceDirectory())).toEqual([])
  })

  it('compares once per entry of the list: the same tools open the first run, and the same entry is not compared again', async () => {
    codex({ providerModels: LISTED })
    expect(await compare()).toEqual({ ok: false, reason: 'the fence test of Codex 0.161.0 has not passed for gpt-6-luna' })
    await test()
    expect(await compare()).toEqual({ ok: true, compared: true })
    const kept = fenceTests()
    expect(kept.map((entry) => [entry.catalog, entry.verdict])).toEqual([['bundled', 'pass'], ['live', 'pass']])
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: true, live: { same: true, entry: kept[1]!.models[0]!.catalog_entry } })
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')?.fence?.compared).toBe(true)
    expect(await compare()).toEqual({ ok: true, compared: false })
    expect(fenceTests()).toHaveLength(2)
  }, 60_000)

  it('writes each of the comparison\'s own runs into the lock before it starts, and starts none where that fails', async () => {
    await test()
    codex({ providerModels: LISTED, logsStarts: true })
    const seen: boolean[] = []
    expect(await compare({ register: (supervisor) => { seen.push(processLives(supervisor)) } })).toEqual({ ok: true, compared: true })
    // Asking for the list is one run, and the test under it is several more: each had a living supervisor when it was written down.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((lives) => lives)).toBe(true)
    const starts = readFileSync(join(stubs, 'codex-starts.log'), 'utf8')
    // The lock's record cannot be written: Codex is not even asked for the list, and nothing is compared.
    expect(await providerModelList({ environment: env, register: () => { throw new Error('no record') } })).toEqual({ ok: false, reason: 'Codex could not be asked for the provider\'s model list' })
    codex({ providerModels: [{ slug: 'gpt-6-luna', base_instructions: 'You are Luna, changed.' }], logsStarts: true })
    let asked = 0
    const closed = await compare({ register: () => { asked += 1; if (asked > 1) throw new Error('no record') } })
    expect(closed.ok).toBe(false)
    expect(readFileSync(join(stubs, 'codex-starts.log'), 'utf8')).toBe(starts)
  }, 60_000)

  it('a tool the provider\'s list adds closes the offer, and no run starts', async () => {
    await test()
    codex({ providerModels: [{ slug: 'gpt-6-luna', base_instructions: 'You are Luna.', experimental_supported_tools: ['clock', 'read_file'] }] })
    const result = await compare()
    expect(result).toMatchObject({ ok: false, closed: true, reason: expect.stringContaining('under the provider\'s own model list the fence test of Codex 0.161.0 did not pass for gpt-6-luna') })
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: false, why: 'live' })
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')).toMatchObject({ ok: false, why: 'Codex offers it other tools than the fence test saw' })
    const run = prepareResearchRun('A prompt.\n', { now: NOW, harness: 'codex', environment: env })
    const argv = researchArgv(agents('luna')[0]!, { environment: env, run })
    expect(evaluateResearch({ agent: 'luna', argv, stdin: run.prompt, cwd: run.cwd }, { environment: env, cwd: run.cwd, now: NOW })).toMatchObject({ code: 'ROUTE_UNSUPPORTED', detail: 'fence-live' })
    // Astra's own standing is not touched by Luna's.
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-astra').why).toBe('untested')
  }, 60_000)

  it.each([
    ['never asks for the list', { skipsProviderList: true }, 'Codex did not ask the stand-in for the model list, so nothing was compared under it'],
    ['asks for the list and goes on with the one it was built with', { ignoresProviderList: true }, 'Codex did not use the model list the stand-in served, so nothing was compared under it']
  ])('a comparison counts only where Codex was seen to use the list: one that %s compares nothing, opens nothing and closes nothing', async (_name, mode, why) => {
    await test()
    // The provider's entry names one tool more; a Codex that does not use the entry offers the tested tools all the same.
    codex({ providerModels: [{ slug: 'gpt-6-luna', base_instructions: 'You are Luna.', experimental_supported_tools: ['clock', 'read_file'] }], ...mode })
    const result = await compare()
    expect(result).toEqual({ ok: false, closed: false, reason: `under the provider's own model list the fence test of Codex 0.161.0 did not pass for gpt-6-luna: ${why}` })
    expect(fenceTests().map((entry) => [entry.catalog, entry.verdict])).toEqual([['bundled', 'pass'], ['live', 'inconclusive']])
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: true, live: null })
    expect(researchers({ environment: env, now: NOW }).find((entry) => entry.id === 'luna')?.fence?.compared).toBe(false)
    // Asked again, it is compared again: nothing was remembered as compared.
    expect((await compare()).ok).toBe(false)
    expect(fenceTests()).toHaveLength(3)
  }, 60_000)

  it('follows the entry by the instructions Codex sends on: the template of Codex 0.162 where the entry has one, the older field where it has not', async () => {
    await test()
    // The 0.162 form: Codex sends the template and never the older field, so a line added to the older field alone would not come back.
    codex({ providerModels: [{ slug: 'gpt-6-luna', base_instructions: 'You are Luna.', model_messages: { instructions_template: 'You are Luna, from the template.' }, experimental_supported_tools: ['clock'] }] })
    expect(await compare()).toEqual({ ok: true, compared: true })
    // An entry with the template alone is followed the same way.
    codex({ providerModels: [{ slug: 'gpt-6-luna', model_messages: { instructions_template: 'You are Luna, from the template.' }, experimental_supported_tools: ['clock'] }] })
    expect(await compare()).toEqual({ ok: true, compared: true })
    expect(fenceTests().map((entry) => [entry.catalog, entry.verdict])).toEqual([['bundled', 'pass'], ['live', 'pass'], ['live', 'pass']])
  }, 60_000)

  it('an entry BMN cannot follow into the run compares nothing either', async () => {
    await test()
    codex({ providerModels: [{ slug: 'gpt-6-luna', experimental_supported_tools: ['clock'] }] })
    expect(await compare()).toEqual({ ok: false, closed: false,
      reason: 'under the provider\'s own model list the fence test of Codex 0.161.0 did not pass for gpt-6-luna: the model list gives this model no entry BMN can follow into the run, so nothing was compared under it' })
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna')).toMatchObject({ passed: true, live: null })
  }, 60_000)

  it('Stop reaches the comparison: the list is not waited for, a test under way is ended, and nothing of it is kept', async () => {
    await test()
    codex({ providerModels: LISTED })
    const before = new AbortController()
    before.abort()
    expect(await compare({ signal: before.signal })).toMatchObject({ ok: false, stopped: true })
    // Stopped while the list is asked for.
    const during = new AbortController()
    const asking = compare({ signal: during.signal, modelList: (options) => new Promise((resolve) => { options?.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped' })) }) })
    during.abort()
    expect(await asking).toMatchObject({ ok: false, stopped: true })
    // Stopped while the test under the list runs: its Codex is ended at once and no record is written.
    const running = new AbortController()
    const startedAt = Date.now()
    const tested = compare({ signal: running.signal, test: (inner) => { setTimeout(() => running.abort(), 150); return runFenceTest({ ...inner, limitMs: 20_000 }) } })
    expect(await tested).toMatchObject({ ok: false, stopped: true })
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(fenceTests().map((entry) => entry.catalog)).toEqual(['bundled'])
    expect(readdirSync(fenceDirectory())).toEqual([])
    // What is left of the research's time is all the comparison gets.
    const seen: (number | undefined)[] = []
    await compare({ limitMs: 5_000, modelList: async (options) => { seen.push(options?.limitMs); return { ok: false, reason: 'no list' } } })
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen[0]).toBeLessThanOrEqual(5_000)
  }, 60_000)

  it('the time limit is one moment for the whole comparison: a run under way is ended at it, no later run starts, and nothing of it is kept', async () => {
    await test()
    // A Codex that takes four seconds before it asks anything, and a comparison with a second and a half in all.
    codex({ providerModels: LISTED, logsStarts: true, startDelayMs: 4000 })
    const startedAt = Date.now()
    const result = await compareUnderProviderList({ agent: agents('luna')[0]!, environment: env, now: NOW, limitMs: 1500 })
    expect(result).toEqual({ ok: false, stopped: true, reason: 'the time ran out before the tools were compared under the provider\'s own model list' })
    expect(Date.now() - startedAt).toBeLessThan(3500)
    // The first run was ended at the limit; the three that would have followed it were never started.
    expect(readFileSync(join(stubs, 'codex-starts.log'), 'utf8')).toBe('run\n')
    expect(fenceTests().map((entry) => entry.catalog)).toEqual(['bundled'])
    expect(readdirSync(fenceDirectory())).toEqual([])
    // With no time left nothing is started at all, the question for the list included.
    const asked: number[] = []
    expect(await compare({ limitMs: 0, modelList: async () => { asked.push(1); return { ok: false, reason: 'no list' } } })).toMatchObject({ ok: false, stopped: true })
    expect(asked).toEqual([])
    // A test of its own, with no such moment, gives each run its time as before.
    rmSync(join(stubs, 'codex-starts.log'))
    codex({ logsStarts: true })
    expect((await test({ renewal: false })).verdict).toBe('pass')
    expect(readFileSync(join(stubs, 'codex-starts.log'), 'utf8')).toBe('run\nrun\nrun\nrun\n')
  }, 60_000)

  it('cannot compare without the list, or for a model the list does not name: no run starts, and nothing is closed', async () => {
    await test()
    expect(await compare()).toEqual({ ok: false, reason: 'Codex did not get the provider\'s model list, so its tool list could not be compared with the tested one' })
    codex({ providerModels: [{ slug: 'gpt-6-astra' }] })
    expect(await compare()).toEqual({ ok: false, reason: 'the provider\'s model list does not name gpt-6-luna, so its tool list could not be compared with the tested one' })
    expect(fenceStanding('codex', '0.161.0', 'gpt-6-luna').passed).toBe(true)
  }, 60_000)
})

describe('the fence test of an OpenCode research run (70.3)', () => {
  const LUNA_GO = '## luna-go\n\n```yaml\nname: Luna (Go)\nclass: pawn\nharness: opencode\nmodel: gpt-6-luna\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low, high]\nroles: [helper]\n```\n\n## roles'
  /** How the stand-in OpenCode behaves in this test; see fake-opencode.mjs. */
  const opencode = (mode: Record<string, unknown> = {}): void => writeFileSync(join(stubs, 'opencode-mode.json'), JSON.stringify(mode))
  const testOpenCode = (options: Parameters<typeof runFenceTest>[0] = {}) => runFenceTest({ harness: 'opencode', environment: env, now: NOW, limitMs: 20_000, ...options })
  const lunaGo = () => agents('luna-go')[0] as RosterAgent
  const offer = () => researchers({ environment: env, now: NOW }).filter((entry) => entry.harness === 'opencode').map((entry) => [entry.id, entry.ok, entry.why])
  const research = (argv?: string[]) => {
    const run = prepareResearchRun('Made-up research prompt.\n', { now: NOW, harness: 'opencode', environment: env })
    return evaluateResearch({ agent: 'luna-go', argv: argv ?? researchArgv(lunaGo(), { environment: env, run, version: '2.0.29' }), stdin: run.prompt, cwd: run.cwd }, { environment: env, cwd: run.cwd, now: NOW })
  }

  beforeEach(() => {
    writeFileSync(join(stubs, 'opencode'), readFileSync(FAKE_OPENCODE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`))
    chmodSync(join(stubs, 'opencode'), 0o755)
    opencode()
    // OpenCode Go may see private work in this team, so research on it is judged by the fence alone.
    const text = EXAMPLE.replace('opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [], private_work: allowed}').replace('## roles', LUNA_GO)
    writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
    const generation = (JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')) as { generation: number }).generation
    approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  })

  it('passes for the team\'s OpenCode model, records it against the version and the form, and opens the offer', async () => {
    expect(offer()).toEqual([['luna-go', false, 'the fence test has not run for this version of OpenCode yet']])
    const entry = await testOpenCode()
    expect(entry, JSON.stringify(entry)).toMatchObject({ harness: 'opencode', version: '2.0.29', form: researchFormHash('opencode'), catalog: 'bundled', verdict: 'pass', reasons: [] })
    expect(entry.models.map((model) => [model.model, model.verdict, model.reasons, model.tools])).toEqual([['opencode-go/gpt-6-luna', 'pass', [], [...OPENCODE_RESEARCH_TOOLS_SEEN]]])
    expect(fenceStanding('opencode', '2.0.29', 'opencode-go/gpt-6-luna')).toMatchObject({ passed: true, tools: [...OPENCODE_RESEARCH_TOOLS_SEEN] })
    expect(fenceStanding('opencode', '2.0.30', 'opencode-go/gpt-6-luna')).toMatchObject({ passed: false, why: 'untested' })
    expect(offer()).toEqual([['luna-go', true, undefined]])
    expect(readdirSync(fenceDirectory())).toEqual([])
    expect(readFileSync(fenceTestsPath(), 'utf8')).not.toMatch(/FENCE-[A-Z]+-[0-9a-f]{8}/)
    // BMN's own OpenCode folder, where real runs start, was not touched: the test plants a folder of its own.
    expect(existsSync(openCodeFolder())).toBe(false)
  }, 60_000)

  it.each([
    ['the owner\'s rules file reaches the provider', { leaks: true }, 'reached the provider: the OpenCode rules file'],
    ['a tool BMN has not looked at is offered', { extraTool: 'bash' }, 'a tool BMN has not looked at: function:bash'],
    ['a file is written in the home folder', { writes: true }, 'written during the run: fake-opencode-wrote.txt'],
    ['the search reaches an address on this computer', { fetchesLocal: true }, 'a tool fetched an address on this computer']
  ])('fails where %s, and the offer stays closed', async (_name, mode, reason) => {
    opencode(mode)
    const entry = await testOpenCode()
    expect(entry.verdict, JSON.stringify(entry)).toBe('fail')
    expect(entry.models[0]?.reasons).toContain(reason)
    expect(offer()).toEqual([['luna-go', false, 'the fence test of this version of OpenCode did not pass']])
  }, 60_000)

  it('refuses research until the fence passed, with Codex\'s words; a different tool list closes it again (AC2, AC3)', async () => {
    expect(research()).toMatchObject({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED', detail: 'fence-untested',
      message: 'research runs in OpenCode only on a version whose fence test passed, and none is on record for opencode 2.0.29 with opencode-go/gpt-6-luna: the owner runs `bmn roster fence`, or picks a researcher on Claude Code' })
    expect((await testOpenCode()).verdict).toBe('pass')
    const passed = research()
    expect(passed.verdict, JSON.stringify(passed)).toBe('PASS')
    expect(passed.receipt).toMatchObject({ mode: 'research', harness: 'opencode', model: 'opencode-go/gpt-6-luna', effort: 'low', fence: { form: researchFormHash('opencode'), tools: [...OPENCODE_RESEARCH_TOOLS_SEEN] } })
    // The run was put in BMN's own folder, as `roster role` does.
    expect(openCodeFolderProblem()).toBeNull()
    // A later record of the same version and model with other tools, as a comparison under another list would write it.
    const [tested] = fenceTests()
    const other = { ...tested, catalog: 'live', verdict: 'fail', models: [{ model: 'opencode-go/gpt-6-luna', verdict: 'fail', tools: ['function:websearch', 'function:webfetch'], reasons: ['the tools differ'] }] }
    writeFileSync(fenceTestsPath(), `${readFileSync(fenceTestsPath(), 'utf8')}${JSON.stringify(other)}\n`)
    expect(research()).toMatchObject({ code: 'ROUTE_UNSUPPORTED', detail: 'fence-live',
      message: 'under the provider\'s own model list OpenCode 2.0.29 offers opencode-go/gpt-6-luna other tools than the fence test saw (the tools differ), so no research runs there until that is looked at' })
  }, 60_000)

  it('accepts exactly the research form', async () => {
    expect((await testOpenCode()).verdict).toBe('pass')
    const run = prepareResearchRun('Made-up research prompt.\n', { now: NOW, harness: 'opencode', environment: env })
    const argv = researchArgv(lunaGo(), { environment: env, run, version: '2.0.29' })
    const refused = (changed: string[]) => evaluateResearch({ agent: 'luna-go', argv: changed, stdin: run.prompt, cwd: run.cwd }, { environment: env, cwd: run.cwd, now: NOW })
    expect(refused(argv.map((part) => (part === 'bmn-researcher' ? 'bmn-helper' : part)))).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'a research run runs BMN\'s research agent (--agent bmn-researcher)' })
    expect(refused(argv.slice(0, -2))).toMatchObject({ code: 'ROUTE_UNSUPPORTED', message: 'a research run names its title (--title), so OpenCode makes no request of its own to name the session' })
    expect(refused([...argv.slice(0, 2), 'FOO=1', ...argv.slice(2)]).message).toMatch(/^a research run's env -i carries only PATH, HOME, .*, not FOO$/)
    expect(refused(argv.map((part) => (part === 'opencode-go/gpt-6-luna#low' ? 'opencode-go/gpt-6-luna#high' : part)))).toMatchObject({ verdict: 'PASS' })
    expect(refused([...argv, '--auto']).code).toBe('ROUTE_UNSUPPORTED')
  }, 60_000)

  it('covers each OpenCode model of the approved team once, and reads the answer from the last text event', () => {
    expect(fenceSubjects(readApproved().data, 'opencode').map((agent) => agent.id)).toEqual(['luna-go'])
    expect(fenceSubjects(readApproved().data).map((agent) => agent.id)).toEqual(['sol', 'astra', 'luna'])
    const events = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n')
    expect(answerText('opencode', events({ type: 'step_start' }, { type: 'text', part: { text: 'first' } }, { type: 'text', part: { text: '{"version":1}' } }), { folder: '' })).toEqual({ ok: true, text: '{"version":1}' })
    expect(answerText('opencode', events({ type: 'step_start' }), { folder: '' })).toEqual({ ok: false, reason: 'OpenCode printed no answer' })
    expect(answerText('opencode', events({ type: 'error', error: { type: 'provider.auth', message: 'made-up refusal' } }), { folder: '' })).toEqual({ ok: false, reason: 'OpenCode reported an error: made-up refusal' })
    expect(answerText('opencode', 'not json', { folder: '' })).toEqual({ ok: false, reason: 'OpenCode printed a line that is not JSON' })
  })

  describe('the session of a research run (70.4 AC4)', () => {
    const SESSION = 'ses_0123456789abFakeOpenCode01'
    const ANSWER = JSON.stringify({ version: 1, answer: 'People use Jev mostly to route requests by intent.', claims: [], not_found: ['an independent measurement'] })
    const ask = (now: () => Date = () => NOW) => runAsk({ question: 'How do people use the Jev 1.13 model, according to public pages?', agent: 'luna-go', owner: true, environment: env, now,
      fetchPage: async () => ({ ok: false, reason: 'no page in this test' }) })
    const receiptOf = (run: string) => join(researchRunsDirectory(), run, 'receipt.json')
    const bindingOf = (receipt: string) => JSON.parse(readFileSync(bindingPath(JSON.parse(readFileSync(receipt, 'utf8')).receipt_hash), 'utf8')) as { session_id: string }

    it('is read from the events: the one OpenCode id they all name', () => {
      const events = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n')
      expect(openCodeSession(events({ type: 'step_start', sessionID: SESSION }, { type: 'text', sessionID: SESSION, part: { text: 'x' } }))).toBe(SESSION)
      expect(openCodeSession(events({ type: 'step_start', sessionID: SESSION }, { type: 'text', sessionID: 'ses_0123456789abFakeOpenCode02' }))).toBeNull()
      expect(openCodeSession(events({ type: 'step_start', sessionID: '019a2f6e-1c2b-7d3e-8f40-123456789abc' }))).toBeNull()
      expect(openCodeSession(events({ type: 'step_start' }))).toBeNull()
      expect(openCodeSession(`${events({ type: 'step_start', sessionID: SESSION })}\nnot json`)).toBeNull()
    })

    it('is bound to the run\'s check and kept with the question; a second binding is refused, as for a dispatch', async () => {
      expect((await testOpenCode()).verdict).toBe('pass')
      opencode({ answer: ANSWER })
      const asked = await ask()
      expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, outcome: 'answered', session: SESSION })
      expect(asked.note).toBeUndefined()
      const receipt = receiptOf(asked.run!)
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ mode: 'research', harness: 'opencode' })
      expect(bindingOf(receipt)).toMatchObject({ session_id: SESSION })
      expect(readQuestions().find((entry) => entry.id === asked.id)).toMatchObject({ outcome: 'answered', session: SESSION })
      expect(() => bindSession(receipt, SESSION, { now: NOW })).toThrow('this receipt is already bound to a session; a binding is accepted once')
    }, 60_000)

    it('leaves the answer standing where the session cannot be bound, and says why', async () => {
      expect((await testOpenCode()).verdict).toBe('pass')
      opencode({ answer: ANSWER, sessions: true })
      const two = await ask()
      expect(two, JSON.stringify(two)).toMatchObject({ ok: true, outcome: 'answered', note: 'OpenCode named no single session, so the run is bound to none.' })
      expect(two).not.toHaveProperty('session')
      // The binding comes after the ten minutes its check allows: refused, and the answer stands.
      opencode({ answer: ANSWER })
      let calls = 0
      const late = await ask(() => (calls++ === 0 ? NOW : new Date(NOW.getTime() + 11 * 60_000)))
      expect(late, JSON.stringify(late)).toMatchObject({ ok: true, outcome: 'answered', session: SESSION,
        note: `BMN could not bind session ${SESSION} to the run's check: a session is bound within 10 minutes of the check that preceded it; start a fresh checked dispatch.` })
      expect(existsSync(bindingPath(JSON.parse(readFileSync(receiptOf(late.run!), 'utf8')).receipt_hash))).toBe(false)
    }, 60_000)

    it('is bound for each run of a Models research', async () => {
      expect((await testOpenCode()).verdict).toBe('pass')
      opencode({ answer: JSON.stringify({ version: 1, models: [] }) })
      const listed = () => (existsSync(researchRunsDirectory()) ? readdirSync(researchRunsDirectory()) : [])
      const before = new Set(listed())
      const { run } = await runResearch({ researcher: 'luna-go', environment: env, now: () => NOW, fetchPage: async () => ({ ok: false, reason: 'no page in this test' }) })
      const runs = listed().filter((name) => !before.has(name))
      expect(runs.length, JSON.stringify(run)).toBeGreaterThan(0)
      for (const name of runs) expect(bindingOf(receiptOf(name))).toMatchObject({ session_id: SESSION })
      expect(run.note ?? '').not.toContain('bind')
    }, 60_000)
  })
})

/** The real OpenCode on this computer, for the opt-in run below (BMN_OPENCODE_REAL=1); empty when either is missing. */
const REAL_OPENCODE = process.env.BMN_OPENCODE_REAL === '1'
  ? (() => {
      try {
        return realpathSync(execFileSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' }).trim())
      } catch {
        return ''
      }
    })()
  : ''

describe.runIf(REAL_OPENCODE !== '')('the fence test on the installed OpenCode (70.3, BMN_OPENCODE_REAL=1)', () => {
  it('passes for Luna through OpenCode Go: only web search is offered, and none of the planted files reaches the stand-in', async () => {
    const luna = { ...agents('luna')[0], id: 'luna-go', name: 'Luna (Go)', harness: 'opencode', model: 'gpt-6-luna', provider: 'opencode-go', efforts: ['low', 'high'] } as RosterAgent
    const entry = await runFenceTest({ harness: 'opencode', agents: [luna], environment: { HOME: home, PATH: `${dirname(REAL_OPENCODE)}:/usr/bin:/bin` }, now: NOW, limitMs: 90_000 })
    // The record, made-up markers only, can be kept beside a run's evidence.
    if (process.env.BMN_OPENCODE_FENCE_RECORD !== undefined) writeFileSync(process.env.BMN_OPENCODE_FENCE_RECORD, `${JSON.stringify(entry, null, 2)}\n`)
    expect(entry, JSON.stringify(entry)).toMatchObject({ harness: 'opencode', form: researchFormHash('opencode'), verdict: 'pass', reasons: [] })
    expect(entry.models.map((model) => [model.model, model.verdict, model.tools])).toEqual([['opencode-go/gpt-6-luna', 'pass', [...OPENCODE_RESEARCH_TOOLS_SEEN]]])
  }, 180_000)

  it('fails when the same run reads the owner\'s own OpenCode folder: his plugin loads and his MCP server starts', async () => {
    const luna = { ...agents('luna')[0], id: 'luna-go', name: 'Luna (Go)', harness: 'opencode', model: 'gpt-6-luna', provider: 'opencode-go', efforts: ['low', 'high'] } as RosterAgent
    const entry = await runFenceTest({
      harness: 'opencode', agents: [luna], environment: { HOME: home, PATH: `${dirname(REAL_OPENCODE)}:/usr/bin:/bin` }, now: NOW, limitMs: 90_000, record: false,
      argvOf: (agent, options) => researchArgv(agent, options).map((part) => (part.startsWith('XDG_CONFIG_HOME=') ? `XDG_CONFIG_HOME=${options.environment.HOME}/.config` : part))
    })
    expect(entry.form).toBe('other')
    expect(entry.verdict, JSON.stringify(entry)).toBe('fail')
    expect(entry.models[0]?.reasons).toEqual(expect.arrayContaining(['a plugin of the owner\'s was loaded', 'an MCP server of the owner\'s was started']))
  }, 180_000)
})

describe('`bmn roster fence`', () => {
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...env, HOME: home }, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })

  it('runs the test for the team\'s Codex models, says what it showed in plain lines and exits 0 only on a pass', async () => {
    const passed = await run(['roster', 'fence'])
    expect(passed.code, passed.stdout + passed.stderr).toBe(0)
    expect(passed.stdout).toContain('Codex 0.161.0: the fence test passed.')
    expect(passed.stdout).toContain('gpt-6-luna: passed')
    expect(passed.stdout).toContain('Tools Codex keeps offering: custom:functions.exec, exec:apply_patch')
    expect(passed.stdout).toContain('The team\'s Codex researchers are offered on this version.')
    expect((JSON.parse(readFileSync(fenceTestsPath(), 'utf8').trim()) as FenceTestEntry).verdict).toBe('pass')
    codex({ extraTools: ['read_file'] })
    const failed = await run(['roster', 'fence', '--json'])
    expect(failed.code).toBe(10)
    expect(JSON.parse(failed.stdout)).toMatchObject({ verdict: 'fail', version: '0.161.0' })
    expect((await run(['roster', 'fence', '--help'])).stdout).toContain('No provider is called and none of your files is read.')
    expect((await run(['roster', 'fence', 'extra'])).code).toBe(2)
    expect(existsSync(join(home, '.codex'))).toBe(false)
  }, 120_000)
})
