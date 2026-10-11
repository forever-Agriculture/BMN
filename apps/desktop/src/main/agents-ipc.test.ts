// MODULE: agents-ipc.test.ts - Epic 60.4–60.6: the Team and Rules handlers preview an approval, update only the rules files that were shown, and re-inspect what an approval records
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentsOutcome, AgentsPreview, AgentsShownRevision, AgentsSnapshot, ContextLimitPlan, ResearchLookup, ResearchSnapshot, RosterDataShape, RulesMasterPlan, RulesOutcome, RulesPlan, RulesRevertPlan, RulesSnapshot, SkillsPlan, ToolProposalView, ToolsPlan } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchPublicPage } from '../../bin/agents-research.mjs'
import { approveRoster, restoreGeneration, saveAndApprove } from './agents-approval'
import { fileToApproved, installAgentsIpcHandlers, researchEndedWords } from './agents-ipc'

const FIXTURE = readFileSync(fileURLToPath(new URL('../utility/test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
/** BMN cannot inspect where OpenCode sends data, so the team these tests approve records it on the owner's word. */
const EXAMPLE = FIXTURE.replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}')
const SCRIPT = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const MASTER = '# Rules\n\nThe team: <!-- bmn:team -->.\n\n<!-- bmn:public -->\nAnswer first.\n<!-- /bmn:public -->\n'

let home: string
let stubs: string
let handlers: Map<string, (event: never, params?: unknown) => unknown>
/** What the app's own environment holds beside HOME and PATH, for the test that needs more. */
let appEnv: Record<string, string>
/** The folder the self-test serves cited `.test` pages from; null as in the real app. */
let researchPages: string | null
let researchFetch: typeof fetchPublicPage | null
let researchLimitMs: number | undefined
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }

function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-agents-ipc-')))
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  stub('claude', 'echo "2.1.295 (Claude Code)"')
  stub('codex', 'echo "codex-cli 0.161.0"')
  process.env.HOME = home
  process.env.PATH = `${stubs}:/usr/bin:/bin`
  delete process.env.XDG_CONFIG_HOME
  handlers = new Map()
  appEnv = {}
  researchPages = null
  researchFetch = null
  researchLimitMs = undefined
  installAgentsIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
    senderIsAllowed: () => true, cliScript: () => SCRIPT, environment: () => ({ HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...appEnv }),
    openPath: async (path) => (existsSync(path) ? '' : 'no such file'), researchPages: () => researchPages,
    researchFetch: (address, limits) => (researchFetch ?? fetchPublicPage)(address, limits), researchLimitMs: () => researchLimitMs
  })
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

const rosterFile = (): string => join(home, '.config/bmn/agents/roster.md')
const call = async <Result>(channel: string, params: Record<string, unknown> = {}): Promise<Result> => await handlers.get(`aiterm:${channel}`)?.(undefined as never, params) as Result
const snapshot = (): Promise<AgentsSnapshot> => call('agents:snapshot')
const shownOf = (state: AgentsSnapshot): AgentsShownRevision => ({ generation: state.approved?.generation ?? null, fileHash: state.file.hash as string, link: state.file.link, directory: state.file.directory })
const shown = async (): Promise<AgentsShownRevision> => shownOf(await snapshot())
const activate = (data: RosterDataShape, id: string): RosterDataShape => ({ ...data, agents: data.agents.map((agent) => (agent.id === id ? { ...agent, status: 'active' as const } : agent)) })
const bindings = (preview: AgentsPreview) => preview.teamUpdate.map((target) => ({ harness: target.harness, binding: target.binding }))
const file = (path: string): string => readFileSync(join(home, path), 'utf8')

/** A team approved from the file, the rules saved and installed into the four apps. */
async function approvedAndInstalled(): Promise<AgentsSnapshot> {
  writeFileSync(rosterFile(), EXAMPLE)
  const first = await call<AgentsOutcome>('agents:approve', { shown: await shown() })
  expect(first).toMatchObject({ ok: true, message: 'Approved · version 1' })
  expect(await call<RulesOutcome>('rules:save-master', { text: MASTER, expectedHash: null, expectedLink: null })).toMatchObject({ ok: true })
  const plan = await call<RulesPlan>('rules:plan-install')
  expect(plan.targets.map((target) => [target.harness, target.rendering])).toEqual([['claude', 'full'], ['codex', 'full'], ['opencode', 'public'], ['cursor', 'public']])
  expect(await call<RulesOutcome>('rules:install', { planHash: plan.planHash })).toMatchObject({ ok: true })
  expect(file('.claude/CLAUDE.md')).toContain('The team: Claude Code (Opus, Fable), Codex (Sol, Astra, Luna) (roles, efforts and limits: `bmn team`).')
  return snapshot()
}

describe('a new install and the team file', () => {
  it('starts a team with no agents and nothing approved, once', async () => {
    const started = await call<AgentsOutcome>('agents:start')
    expect(started).toMatchObject({ ok: true, message: 'Team file created' })
    expect(started.snapshot).toMatchObject({ home, approved: null, file: { exists: true, data: { agents: [], roles: [{ id: 'lead' }, { id: 'designer' }, { id: 'helper' }, { id: 'reviewer' }, { id: 'advisor' }] } } })
    expect(await call<AgentsOutcome>('agents:start')).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(await call('agents:open-file')).toEqual({ ok: true, path: rosterFile() })
  })

  it('saves an agent\'s notes into the file without approving anything, and refuses when the file moved', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    const before = await shown()
    const saved = await call<AgentsOutcome>('agents:notes', { shown: before, agent: 'astra', text: 'Design eye.' })
    expect(saved).toMatchObject({ ok: true, snapshot: { approved: null, file: { prose: { astra: 'Design eye.' } } } })
    expect(await call<AgentsOutcome>('agents:notes', { shown: before, agent: 'astra', text: 'Stale.' })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(readFileSync(rosterFile(), 'utf8')).not.toContain('Stale.')
  })
})

describe('what an approving control would approve (60.5 AC7)', () => {
  it('previews staged data with its differences and consequences, and no rules files while none is installed', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const data = (await snapshot()).file.data as RosterDataShape
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: activate(data, 'haiku') } })
    expect(preview).toMatchObject({ valid: true, errors: [], teamUpdate: [], consequences: ['Haiku could be given work', 'Haiku could receive private work'] })
    expect(preview.differences.map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toEqual(['agent:haiku:status'])
    expect((await snapshot()).approved?.generation).toBe(1)
  })

  it('shows the owner the exact folder an exception would allow, before and after', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    writeFileSync(rosterFile(), EXAMPLE.replace('folder: /synthetic/EXCEPTION-SENTINEL-FOLDER', 'folder: /synthetic/another-workspace')
      .replace('zai-synthetic: {provider: zai', 'zai-second: {provider: zai, folder: /synthetic/second-workspace}\nzai-synthetic: {provider: zai'))
    const outside = await snapshot()
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'file' } })
    for (const differences of [outside.differences, preview.differences]) {
      expect(differences).toEqual([
        { scope: 'exceptions', id: 'zai-synthetic', field: 'folder', kind: 'changed', before: { present: true, value: '/synthetic/EXCEPTION-SENTINEL-FOLDER' }, after: { present: true, value: '/synthetic/another-workspace' } },
        { scope: 'exceptions', id: 'zai-second', field: null, kind: 'added', after: { present: true, value: { provider: 'zai', folder: '/synthetic/second-workspace' } } }
      ])
    }
  })

  it('says why staged data would not be a valid team instead of previewing it', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    const data = (await snapshot()).file.data as RosterDataShape
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: { ...data, agents: data.agents.map((agent) => (agent.id === 'astra' ? { ...agent, roles: [...agent.roles, 'lead'] } : agent)) } } })
    expect(preview.valid).toBe(false)
    expect(preview.errors.map((issue) => issue.code)).toContain('CLASS_CANNOT_LEAD')
    expect(preview.teamUpdate).toEqual([])
  })
})

describe('an approval that changes the Team phrase (60.4 AC6)', () => {
  it('lists each rules file that would change, and updates exactly those when they were shown', async () => {
    const state = await approvedAndInstalled()
    const staged = activate(state.file.data as RosterDataShape, 'haiku')
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    expect(preview.teamUpdate.map((target) => [target.harness, target.path, target.kind])).toEqual([
      ['claude', join(home, '.claude/CLAUDE.md'), 'full'], ['codex', join(home, '.codex/AGENTS.md'), 'full']
    ])
    expect(preview.teamUpdate[0]?.diff).toContain('+The team: Claude Code (Opus, Fable, Haiku), Codex (Sol, Astra, Luna)')
    const outcome = await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: staged, teamUpdate: bindings(preview) })
    expect(outcome).toMatchObject({ ok: true, message: 'Approved · version 2', rulesUpdate: { written: ['claude', 'codex'], skipped: [] } })
    expect(file('.claude/CLAUDE.md')).toContain('Claude Code (Opus, Fable, Haiku)')
    expect(file('.codex/AGENTS.md')).toContain('Claude Code (Opus, Fable, Haiku)')
    const transaction = (outcome as Extract<AgentsOutcome, { ok: true }>).rulesUpdate?.transaction as string
    const rules = await call<RulesSnapshot>('rules:snapshot')
    expect(rules.transactions[0]).toMatchObject({ id: transaction, reason: 'team update', targets: ['claude', 'codex'], state: 'complete' })
    expect(rules.health).toMatchObject({ state: 'checked', ok: true })
    // Undo is the ordinary restore of that one transaction.
    const undo = await call<RulesPlan>('rules:plan-restore', { transaction })
    expect(await call<RulesOutcome>('rules:restore', { transaction, planHash: undo.planHash })).toMatchObject({ ok: true, message: 'Put back the rules in Claude Code and Codex' })
    expect(file('.claude/CLAUDE.md')).not.toContain('Haiku')
  })

  it('an approval that showed no rules files updates none', async () => {
    const state = await approvedAndInstalled()
    const before = file('.claude/CLAUDE.md')
    const outcome = await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: activate(state.file.data as RosterDataShape, 'haiku') })
    expect(outcome).toMatchObject({ ok: true, message: 'Approved · version 2' })
    expect(Object.hasOwn(outcome, 'rulesUpdate')).toBe(false)
    expect(file('.claude/CLAUDE.md')).toBe(before)
    expect((await call<RulesSnapshot>('rules:snapshot')).health).toMatchObject({ ok: false })
  })

  it('leaves a rules file that changed after it was shown for Install, and still approves', async () => {
    const state = await approvedAndInstalled()
    const staged = activate(state.file.data as RosterDataShape, 'haiku')
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    writeFileSync(join(home, '.codex/AGENTS.md'), `${file('.codex/AGENTS.md')}\nA line added by hand.\n`)
    const outcome = await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: staged, teamUpdate: bindings(preview) })
    expect(outcome).toMatchObject({ ok: true, rulesUpdate: { written: ['claude'], skipped: ['codex'] } })
    expect(file('.codex/AGENTS.md')).toContain('A line added by hand.')
    expect(file('.codex/AGENTS.md')).not.toContain('Haiku')
  })

  it('Keep on an outside change shows and updates the rules files the same way', async () => {
    const state = await approvedAndInstalled()
    writeFileSync(rosterFile(), readFileSync(rosterFile(), 'utf8').replace(/(name: Sonnet[\s\S]*?status: )proposed/, '$1active'))
    const outside = await snapshot()
    expect(outside.differences?.map((diff) => `${diff.id}:${diff.field}`)).toEqual(['sonnet:status'])
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'sections', scope: ['sonnet'] } })
    expect(preview.teamUpdate.map((target) => target.harness)).toEqual(['claude', 'codex'])
    const kept = await call<AgentsOutcome>('agents:approve', { shown: shownOf(outside), scope: ['sonnet'], teamUpdate: bindings(preview) })
    expect(kept).toMatchObject({ ok: true, message: 'Kept · version 2', rulesUpdate: { written: ['claude', 'codex'] } })
    expect(file('.claude/CLAUDE.md')).toContain('Claude Code (Opus, Fable, Sonnet)')
    expect(state.approved?.generation).toBe(1)
  })

  it('Restore… shows and updates them too, and the team file follows the restored version', async () => {
    const state = await approvedAndInstalled()
    const staged = activate(state.file.data as RosterDataShape, 'haiku')
    await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: staged, teamUpdate: bindings(await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })) })
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'restore', number: 1 } })
    expect(preview.teamUpdate.map((target) => target.harness)).toEqual(['claude', 'codex'])
    expect(preview.consequences).toEqual(['Haiku could no longer be given work', 'Haiku could no longer receive private work'])
    const restored = await call<AgentsOutcome>('agents:restore', { shown: await shown(), number: 1, teamUpdate: bindings(preview) })
    expect(restored).toMatchObject({ ok: true, message: 'Version 1 restored as version 3', rulesUpdate: { written: ['claude', 'codex'] }, snapshot: { differences: [] } })
    expect(file('.claude/CLAUDE.md')).not.toContain('Haiku')
    expect(restored.snapshot.file.data?.agents.find((agent) => agent.id === 'haiku')?.status).toBe('proposed')
    expect(restored.snapshot.history.slice(0, 2).map((entry) => [entry.number, entry.kind, entry.summary])).toEqual([[3, 'restore', 'Restored version 1'], [2, 'approval', 'Haiku could be given work · 1 more']])
  })
})

describe('restoring while the team file holds changes nobody reviewed', () => {
  it('refuses, so the restore never puts the file back over edits its sheet did not show', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const state = await snapshot()
    await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: activate(state.file.data as RosterDataShape, 'haiku') })
    const edited = readFileSync(rosterFile(), 'utf8').replace('browser: {candidates: [luna@max], then: lead}', 'browser: {candidates: [luna@max], then: skip}')
    writeFileSync(rosterFile(), edited)
    const refused = await call<AgentsOutcome>('agents:restore', { shown: await shown(), number: 1 })
    expect(refused).toMatchObject({ ok: false, code: 'PENDING_CHANGES', message: 'Keep or revert the changes made outside BMN first.', snapshot: { approved: { generation: 2 } } })
    expect(readFileSync(rosterFile(), 'utf8')).toBe(edited)
    // Reverted, the same restore goes through.
    await call<AgentsOutcome>('agents:revert', { shown: await shown(), scope: null })
    expect(await call<AgentsOutcome>('agents:restore', { shown: await shown(), number: 1 })).toMatchObject({ ok: true, message: 'Version 1 restored as version 3' })
  })
})

describe('a restore replaces only the file the owner was shown', () => {
  it('keeps an edit made after the restore was shown, even one that lands while it publishes', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const state = await snapshot()
    await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: activate(state.file.data as RosterDataShape, 'haiku') })
    const before = await shown()
    // The lock is held and the file was checked: an edit lands before BMN puts the file back.
    const edited = readFileSync(rosterFile(), 'utf8').replace('browser: {candidates: [luna@max], then: lead}', 'browser: {candidates: [luna@max], then: skip}')
    const restored = restoreGeneration(before, 1, { checkInspectedRoutes: () => {}, beforePointer: () => writeFileSync(rosterFile(), edited) })
    expect(restored.number).toBe(3)
    // What the handler does next: the file is not the one that was shown, so it stays and its differences show.
    expect(fileToApproved(before)).toBe(true)
    expect(readFileSync(rosterFile(), 'utf8')).toBe(edited)
    expect((await snapshot()).differences?.map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toContain('roles:browser:then')
  })

  it('after approved state was lost, restores the version and leaves the file\'s own edits to keep or revert; its sheet lists the restored team', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const edited = readFileSync(rosterFile(), 'utf8').replace('browser: {candidates: [luna@max], then: lead}', 'browser: {candidates: [luna@max], then: skip}')
    writeFileSync(rosterFile(), edited)
    writeFileSync(join(home, '.config/bmn/agents/state/current'), '{ not json')
    expect(await snapshot()).toMatchObject({ approved: null, approvalProblem: { code: 'STATE_CORRUPT', lastGood: 1 }, differences: null })
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'restore', number: 1 } })
    expect(preview.restored?.roles.find((role) => role.id === 'browser')).toMatchObject({ then: 'lead' })
    const restored = await call<AgentsOutcome>('agents:restore', { shown: await shown(), number: 1 })
    expect(restored).toMatchObject({ ok: true, message: 'Version 1 restored as version 2 · the team file still holds later edits; keep or revert each', snapshot: { approved: { generation: 2 } } })
    expect(readFileSync(rosterFile(), 'utf8')).toBe(edited)
    expect(restored.snapshot.differences?.map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toEqual(['roles:browser:then'])
  })
})

describe('a version that was written and never put into effect', () => {
  it('stays marked after a later approval, and when the first approval never finished', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    // The first approval stops between its two writes: a version on disk, nothing in effect.
    const first = await shown()
    expect(() => approveRoster(first, { checkInspectedRoutes: () => {}, beforePointer: () => { throw new Error('stopped') } })).toThrow('stopped')
    expect((await snapshot()).history.map((entry) => [entry.number, entry.unfinished === true, entry.summary])).toEqual([[1, true, undefined]])
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true, message: 'Approved · version 2' })
    const state = await snapshot()
    expect(() => saveAndApprove(shownOf(state), activate(state.file.data as RosterDataShape, 'haiku') as never, { checkInspectedRoutes: () => {}, beforePointer: () => { throw new Error('stopped') } })).toThrow('stopped')
    // The file holds the unfinished edit as a pending difference; keeping it publishes version 4 after version 2.
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true, message: 'Approved · version 4' })
    expect((await snapshot()).history.map((entry) => [entry.number, entry.unfinished === true])).toEqual([[4, false], [3, true], [2, false], [1, true]])
    // Approved state lost and approved again: the versions that did take effect keep their place.
    writeFileSync(join(home, '.config/bmn/agents/state/current'), '{ not json')
    expect((await snapshot()).history.map((entry) => entry.unfinished === true)).toEqual([false, false, false, false])
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true, message: 'Approved · version 5' })
    expect((await snapshot()).history.map((entry) => [entry.number, entry.unfinished === true])).toEqual([[5, false], [4, false], [3, true], [2, false], [1, true]])
  })
})

describe('restoring past an agent that was added since (60.2 AC6)', () => {
  it('approves the earlier version, leaves the team file alone and says what still shows', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const added = `${readFileSync(rosterFile(), 'utf8').replace('\n## roles\n', '\n## nova\n\n```yaml\nname: Nova\nclass: pawn\nharness: codex\nmodel: gpt-6-nova\nprovider: openai\nhost: default\nenabled: true\nstatus: active\nefforts: [low]\nroles: []\n```\n\n## roles\n')}`
    writeFileSync(rosterFile(), added)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true, message: 'Approved · version 2' })
    const restored = await call<AgentsOutcome>('agents:restore', { shown: await shown(), number: 1 })
    expect(restored).toMatchObject({ ok: true, message: 'Version 1 restored as version 3 · the team file still holds later edits; keep or revert each' })
    expect(readFileSync(rosterFile(), 'utf8')).toBe(added)
    expect(restored.snapshot.differences?.map((diff) => `${diff.id}:${diff.kind}`)).toEqual(['nova:added'])
  })
})

describe('an approval inspects again what it records (60.3 AC3, 60.6 AC4)', () => {
  it('refuses to record as inspected a destination BMN cannot inspect', async () => {
    writeFileSync(rosterFile(), FIXTURE)
    const refused = await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    expect(refused).toMatchObject({ ok: false, code: 'ROUTE_CHANGED', snapshot: { approved: null } })
    expect((refused as Extract<AgentsOutcome, { ok: false }>).message).toContain('OpenCode sends data to an unknown destination')
  })

  it('refuses a destination recorded as inspected once the app sends data elsewhere', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.com/v1"\n')
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: false, code: 'ROUTE_CHANGED', message: expect.stringContaining('Codex sends data to proxy.example.com') })
    rmSync(join(home, '.codex/config.toml'))
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
  })

  it('reads OpenCode as unknown on Health and at approval when the app\'s environment names another OpenCode configuration, and never plans its full rules', async () => {
    writeFileSync(rosterFile(), FIXTURE.replace('opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [], private_work: allowed}'))
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    writeFileSync(join(home, '.config/opencode/opencode.json'), '{ "model": "opencode-go/kimi-k3" }')
    const opencode = async () => (await call<RulesSnapshot>('rules:snapshot')).apps[2]
    expect(await opencode()).toMatchObject({ harness: 'opencode', basis: 'default', provider: 'opencode-go' })
    for (const [name, value] of [['OPENCODE_CONFIG', join(home, 'other.json')], ['OPENCODE_CONFIG_CONTENT', '{"model":"proxy/x","provider":{"proxy":{"options":{"apiKey":"KEY-SENTINEL"}}}}']] as const) {
      appEnv = { [name]: value }
      const view = await opencode()
      expect(view).toMatchObject({ basis: 'unknown', provider: null })
      expect(JSON.stringify(view)).not.toContain('KEY-SENTINEL')
      expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: false, code: 'ROUTE_CHANGED', snapshot: { approved: null } })
    }
    appEnv = {}
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
    expect(await call<RulesOutcome>('rules:save-master', { text: MASTER, expectedHash: null, expectedLink: null })).toMatchObject({ ok: true })
    // Inspected and allowed private work, and still public: BMN checks no OpenCode request (owner decision 2026-10-10).
    const planned = async () => (await call<RulesPlan>('rules:plan-install')).targets.find((target) => target.harness === 'opencode')
    expect(await planned()).toMatchObject({ rendering: 'public' })
    appEnv = { OPENCODE_CONFIG: join(home, 'other.json') }
    expect(await planned()).toMatchObject({ rendering: 'public' })
    expect(existsSync(join(home, '.config/opencode/AGENTS.md'))).toBe(false)
  })

  it('supports every installed app version and says whether BMN tested it (owner decision 2026-10-10)', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const rows = async () => (await call<RulesSnapshot>('rules:snapshot')).apps.map((app) => [app.harness, app.version, app.versionState])
    expect(await rows()).toEqual([['claude', '2.1.295', 'tested'], ['codex', '0.161.0', 'tested'], ['opencode', null, 'unknown'], ['cursor', null, 'unknown']])
    stub('codex', 'echo "codex-cli 0.170.0"')
    stub('claude', 'echo "2.1.200 (Claude Code)"')
    const apps = (await call<RulesSnapshot>('rules:snapshot')).apps
    expect(apps[1]).toMatchObject({ version: '0.170.0', versionState: 'newer', versionNote: 'Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.', basis: 'default', provider: 'openai' })
    expect(apps[0]).toMatchObject({ version: '2.1.200', versionState: 'other', versionNote: 'Not the version BMN tested (2.1.295). BMN reads where it sends data the same way on every version.' })
    expect(apps[2]).toMatchObject({ versionState: 'unknown', versionNote: 'BMN does not check OpenCode dispatches.' })
    stub('codex', 'echo "codex-cli"')
    expect((await call<RulesSnapshot>('rules:snapshot')).apps[1]).toMatchObject({ version: null, versionState: 'unknown', versionNote: 'Codex is not installed, or its version cannot be read.' })
  })

  it('names the program PATH selects for each app, past BMN\'s own commands, and none where the app is not installed (60.6: Update…)', async () => {
    const programs = async () => (await call<RulesSnapshot>('rules:snapshot')).apps.map((app) => [app.harness, app.program, app.programTarget])
    expect(await programs()).toEqual([['claude', join(stubs, 'claude'), undefined], ['codex', join(stubs, 'codex'), undefined], ['opencode', null, undefined], ['cursor', null, undefined]])
    // BMN's own folder holds a `codex` that only hands over to the next one: the program updated is the one after it.
    appEnv = { PATH: `${dirname(SCRIPT)}:${stubs}:/usr/bin:/bin` }
    expect(existsSync(join(dirname(SCRIPT), 'codex'))).toBe(true)
    expect((await programs())[1]).toEqual(['codex', join(stubs, 'codex'), undefined])
    // An app installed as a link is shown with where the link leads.
    mkdirSync(join(home, 'versions'))
    writeFileSync(join(home, 'versions/cursor-1.2.3'), '#!/bin/sh\necho "1.2.3"\n')
    chmodSync(join(home, 'versions/cursor-1.2.3'), 0o755)
    symlinkSync(join(home, 'versions/cursor-1.2.3'), join(stubs, 'cursor-agent'))
    expect((await programs())[3]).toEqual(['cursor', join(stubs, 'cursor-agent'), join(home, 'versions/cursor-1.2.3')])
  })

  it('inspects with the environment a session\'s shell ends up with, read again before each call (60.6/60.7: an app found only through the shell\'s settings)', async () => {
    // Started from the desktop, BMN's own PATH lacks the folder the owner's shell adds; the app lives there.
    const shellOnly = join(home, 'shell-only')
    mkdirSync(shellOnly)
    writeFileSync(join(shellOnly, 'opencode'), '#!/bin/sh\necho "1.2.3"\n')
    chmodSync(join(shellOnly, 'opencode'), 0o755)
    let asked = 0
    let source: { env: NodeJS.ProcessEnv; source: 'shell' | 'app'; reason?: string } = { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, source: 'app', reason: 'bash did not answer in 5 seconds' }
    const own = new Map<string, (event: never, params: Record<string, unknown>) => unknown>()
    installAgentsIpcHandlers({ handle: (channel, listener) => { own.set(channel, listener) } }, {
      senderIsAllowed: () => true, cliScript: () => SCRIPT,
      sessionEnvironment: { current: () => source, refresh: async () => { asked += 1; if (asked > 1) source = { env: { HOME: home, PATH: `${shellOnly}:${stubs}:/usr/bin:/bin` }, source: 'shell' } } }
    })
    const read = async (): Promise<RulesSnapshot> => await own.get('aiterm:rules:snapshot')?.(undefined as never, {}) as RulesSnapshot
    // The shell could not be asked: BMN's own environment stands in, and the page is told why.
    const first = await read()
    expect(asked).toBe(1)
    expect(first.ownEnvironment).toBe('bash did not answer in 5 seconds')
    expect(first.apps[2]).toMatchObject({ harness: 'opencode', version: null, program: null })
    // Asked again before the next call, the shell answers: its PATH is the one inspected with.
    const second = await read()
    expect(asked).toBe(2)
    expect(second.ownEnvironment).toBeUndefined()
    expect(second.apps[2]).toMatchObject({ harness: 'opencode', version: '1.2.3', program: join(shellOnly, 'opencode') })
    expect(second.apps[0]).toMatchObject({ version: '2.1.295', program: join(stubs, 'claude') })
  })

  it('a version list kept from the earlier rule saves like any other field, with nothing inspected for it', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const state = await snapshot()
    const data = state.file.data as RosterDataShape
    const listed: RosterDataShape = { ...data, harness_routes: data.harness_routes.map((route) => (route.harness === 'codex' ? { ...route, accepted_versions: ['0.170.0'] } : route)) }
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: listed })).toMatchObject({ ok: true })
    expect((await snapshot()).approved?.data.harness_routes.find((route) => route.harness === 'codex')?.accepted_versions).toEqual(['0.170.0'])
  })
})

describe('a link on the way to the team file or the rules (R60-NFR2)', () => {
  const stores = () => ({ a: join(home, 'store-a'), b: join(home, 'store-b') })
  const agents = (): string => join(home, '.config/bmn/agents')
  /** `~/.config/bmn/agents` is a link to one folder; `retarget` copies that folder and points the link at the copy. */
  function linked(): void {
    rmSync(agents(), { recursive: true })
    mkdirSync(stores().a)
    symlinkSync(stores().a, agents())
  }
  function retarget(): void {
    cpSync(stores().a, stores().b, { recursive: true })
    rmSync(agents())
    symlinkSync(stores().b, agents())
  }
  const back = (): void => {
    rmSync(agents())
    rmSync(stores().b, { recursive: true })
    symlinkSync(stores().a, agents())
  }

  it('says which folder really holds the team file and refuses every approving control once the link leads to a copy', async () => {
    linked()
    writeFileSync(rosterFile(), EXAMPLE)
    const first = await snapshot()
    expect(first.file).toMatchObject({ link: null, directory: stores().a })
    retarget()
    expect(await call<AgentsOutcome>('agents:approve', { shown: shownOf(first) })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    // Nothing was approved in the copy (only the lock an approval takes was made there).
    expect(existsSync(join(stores().b, 'state/current'))).toBe(false)
    back()
    expect(await call<AgentsOutcome>('agents:approve', { shown: shownOf(first) })).toMatchObject({ ok: true })
    const approved = await snapshot()
    const data = approved.file.data as RosterDataShape
    retarget()
    const before = readFileSync(join(stores().b, 'roster.md'), 'utf8')
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(approved), data: activate(data, 'haiku') })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(await call<AgentsOutcome>('agents:notes', { shown: shownOf(approved), agent: 'astra', text: 'Written into the copy.' })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(await call<AgentsOutcome>('agents:revert', { shown: shownOf(approved), scope: null })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(await call<AgentsOutcome>('agents:restore', { shown: shownOf(approved), number: 1 })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(readFileSync(join(stores().b, 'roster.md'), 'utf8')).toBe(before)
    back()
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(approved), data: activate(data, 'haiku') })).toMatchObject({ ok: true })
  })

  it('refuses to save the rules into a copy of the folder their diff was shown for', async () => {
    linked()
    expect(await call<RulesOutcome>('rules:save-master', { text: MASTER, expectedHash: null, expectedLink: null })).toMatchObject({ ok: true })
    const next = MASTER.replace('Answer first.', 'Answer first, plainly.')
    const plan = await call<RulesMasterPlan>('rules:plan-master', { text: next })
    expect(plan).toMatchObject({ valid: true, expectedLink: null, expectedDirectory: stores().a })
    retarget()
    const save = { text: next, expectedHash: plan.expectedHash, expectedLink: plan.expectedLink, expectedDirectory: plan.expectedDirectory }
    expect(await call<RulesOutcome>('rules:save-master', save)).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(readFileSync(join(stores().b, 'global-rules.md'), 'utf8')).toBe(MASTER)
    back()
    expect(await call<RulesOutcome>('rules:save-master', save)).toMatchObject({ ok: true })
    expect(readFileSync(join(stores().a, 'global-rules.md'), 'utf8')).toBe(next)
    // Restoring an earlier version is bound the same way.
    const revert = await call<RulesRevertPlan>('rules:plan-revert-master', { revision: 1 })
    expect(revert).toMatchObject({ ok: true, expectedDirectory: stores().a })
    retarget()
    expect(await call<RulesOutcome>('rules:save-master', { text: revert.text, expectedHash: revert.expectedHash, expectedLink: revert.expectedLink, expectedDirectory: revert.expectedDirectory }))
      .toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(readFileSync(join(stores().b, 'global-rules.md'), 'utf8')).toBe(next)
  })
})

describe('the rules snapshot (60.6)', () => {
  it('says when the rules were saved, and that there are none before the first save', async () => {
    expect(await call<RulesSnapshot>('rules:snapshot')).toMatchObject({ home, master: { exists: false, savedAt: null }, health: { state: 'failed' } })
    await call<RulesOutcome>('rules:save-master', { text: MASTER, expectedHash: null, expectedLink: null })
    const rules = await call<RulesSnapshot>('rules:snapshot')
    expect(rules.master).toMatchObject({ exists: true, text: MASTER })
    expect(Date.parse(rules.master.savedAt ?? '')).toBeGreaterThan(Date.now() - 60_000)
  })
})

describe('Allow here on a stopped prompt (60.8 AC3)', () => {
  const GUARDED = EXAMPLE.replace('zai: {name: Z.ai', 'moonshot: {name: Moonshot AI, hosts: [api.moonshot.ai], private_work: public_only}\nzai: {name: Z.ai')
  let proc: string
  let workspace: string

  /** One agent process as Linux reports it, in a process table the handlers read instead of /proc. */
  function agentProcess(env: Record<string, string>, start = '777', cwd = workspace): void {
    const folder = join(proc, '7001')
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'cmdline'), 'claude\0--resume\0')
    writeFileSync(join(folder, 'environ'), `${Object.entries({ HOME: home, PATH: '/usr/bin:/bin', ...env }).map(([key, value]) => `${key}=${value}`).join('\0')}\0`)
    writeFileSync(join(folder, 'stat'), `7001 (claude) S ${[1, 7001, 7001, 34817, 7001, ...Array(13).fill(0), start].join(' ')}\n`)
    symlinkSync(cwd, join(folder, 'cwd'))
  }

  const stop = (): Record<string, unknown> => ({ agent: 'claude', pid: 7001, start: '777', folder: workspace, processFolder: workspace, workspace, providerId: 'moonshot', host: 'api.moonshot.ai', conversation: null })
  const allow = (shownStop: Record<string, unknown> = stop()): Promise<AgentsOutcome> => call('agents:guard-allow', { stop: shownStop })

  beforeEach(async () => {
    proc = join(home, 'proc')
    workspace = join(home, 'code/app')
    mkdirSync(join(workspace, '.git'), { recursive: true })
    installAgentsIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
      senderIsAllowed: () => true, cliScript: () => SCRIPT, environment: () => ({ HOME: home, PATH: `${stubs}:/usr/bin:/bin` }), procRoot: proc
    })
    writeFileSync(rosterFile(), GUARDED)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
  })

  it('asks about the same session again and records that provider in that workspace as a new version', async () => {
    agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' })

    const result = await allow()

    expect(result).toMatchObject({ ok: true, message: 'Moonshot AI allowed in this workspace · version 2' })
    expect(result.snapshot.approved?.data.exceptions).toContainEqual({ id: expect.stringMatching(/^moonshot-[0-9a-f]{8}$/), provider: 'moonshot', folder: workspace })
    expect(result.snapshot.differences).toEqual([])
    // The same press again finds the session allowed, so there is nothing left to record.
    expect(await allow()).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', message: 'This session changed since the prompt was stopped. Send the prompt again.' })
  })

  it.each([
    ['the session now sends work elsewhere', (): void => agentProcess({}), {}],
    ['another process took the pid', (): void => agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' }, '999'), {}],
    ['the process is gone', (): void => rmSync(join(proc, '7001'), { recursive: true, force: true }), {}],
    // Same destination, and a folder the card's own workspace would still cover: only the process tells that the session moved.
    ['the session moved to another folder', (): void => { mkdirSync(join(workspace, 'sub')); agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' }, '777', join(workspace, 'sub')) }, {}],
    ['the session moved to another workspace', (): void => { mkdirSync(join(home, 'code/other/.git'), { recursive: true }); agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' }, '777', join(home, 'code/other')) }, {}],
    ['the card says the process was somewhere else', (): void => undefined, { processFolder: '/synthetic/elsewhere' }],
    ['the card named another provider', (): void => undefined, { providerId: 'zai' }],
    ['the card named another workspace', (): void => undefined, { workspace: '/synthetic/elsewhere' }]
  ])('refuses and approves nothing when %s', async (_label, change, shownChange) => {
    agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' })
    change()

    const result = await allow({ ...stop(), ...shownChange })

    expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(result.snapshot.approved?.generation).toBe(1)
    expect(readFileSync(rosterFile(), 'utf8')).toBe(GUARDED)
  })

  it('refuses a stop that names no session, provider or workspace', async () => {
    await expect(allow({ agent: 'claude' })).rejects.toThrow(/does not name a session, a provider and a workspace/)
  })
})

describe('context limits on Rules › Health (60.9 AC1, AC3)', () => {
  const codexTest = (window: number) => [
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi',
    'dir=""; prev=""', 'for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done', 'cat > /dev/null',
    'mkdir -p "$HOME/.codex/sessions/2026/10/10"',
    `printf '{"payload":{"cwd":"%s"}}\\n{"payload":{"type":"task_started","model_context_window":${window}}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/10/rollout-test.jsonl"`
  ].join('\n')

  it('shows each app\'s default and who shares its file, and changes nothing before the owner\'s test passed on that version', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), '# mine\nmodel_context_window = 380000\nmodel_auto_compact_token_limit = 342000\n')
    const before = await call<RulesSnapshot>('rules:snapshot')
    expect(before.context).toMatchObject([
      { harness: 'codex', path: join(home, '.codex/config.toml'), exists: true, limit: 380000, compact: 342000, version: '0.161.0', limitProven: false, compactProven: false, test: null, agents: ['Sol', 'Astra', 'Luna'] },
      { harness: 'claude', path: join(home, '.claude/settings.json'), exists: false, limit: null, version: '2.1.295', limitProven: false, min: 100000, max: 1000000, agents: ['Opus', 'Fable'] }
    ])
    const refused = await call<ContextLimitPlan>('rules:context-plan', { harness: 'codex', limit: 272000, compact: null })
    expect(refused).toMatchObject({ ok: false, code: 'NOT_SUPPORTED_YET', planHash: null })
    expect(await call<RulesOutcome>('rules:context-apply', { harness: 'codex', limit: 272000, compact: null, planHash: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'NOT_SUPPORTED_YET' })
    expect(file('.codex/config.toml')).toContain('380000')
  })

  it('runs the owner\'s test through the app, then shows the diff and writes exactly what was shown', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), '# mine\nmodel_context_window = 380000\n\n[projects."/x"]\ntrust_level = "trusted"\n')
    stub('codex', codexTest(116850))
    const tested = await call<RulesOutcome>('rules:context-test', { harness: 'codex' })
    expect(tested).toMatchObject({ ok: true, message: 'Codex context test passed: asked for 123000; the session record shows 116850' })
    expect(tested.snapshot.context[0]).toMatchObject({ limitProven: true, compactProven: false, test: { outcome: 'pass', version: '0.161.0' } })
    const plan = await call<ContextLimitPlan>('rules:context-plan', { harness: 'codex', limit: 272000, compact: null })
    expect(plan).toMatchObject({ ok: true, path: join(home, '.codex/config.toml') })
    expect(plan.diff).toContain('-model_context_window = 380000\n+model_context_window = 272000')
    expect(file('.codex/config.toml')).toContain('380000')
    // Another size than the one shown is not what was confirmed.
    expect(await call<RulesOutcome>('rules:context-apply', { harness: 'codex', limit: 300000, compact: null, planHash: plan.planHash })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    const done = await call<RulesOutcome>('rules:context-apply', { harness: 'codex', limit: 272000, compact: null, planHash: plan.planHash })
    expect(done).toMatchObject({ ok: true, message: 'Codex\'s default context limit changed. Sessions started before this keep their old limit.' })
    expect(done.snapshot.context[0]).toMatchObject({ limit: 272000 })
    expect(file('.codex/config.toml')).toBe('# mine\nmodel_context_window = 272000\n\n[projects."/x"]\ntrust_level = "trusted"\n')
    // A failed test on the same version takes the setting away again.
    stub('codex', codexTest(258400))
    const failed = await call<RulesOutcome>('rules:context-test', { harness: 'codex' })
    expect(failed).toMatchObject({ ok: true, message: expect.stringContaining('Codex context test failed') })
    expect(failed.snapshot.context[0]).toMatchObject({ limitProven: false })
    expect(await call<ContextLimitPlan>('rules:context-plan', { harness: 'codex', limit: null, compact: null })).toMatchObject({ ok: false, code: 'NOT_SUPPORTED_YET' })
  })

  it('refuses an app BMN has no setting for and a size that is not a number of tokens', async () => {
    await expect(call('rules:context-plan', { harness: 'opencode', limit: 1, compact: null })).rejects.toThrow(/codex, claude/)
    await expect(call('rules:context-plan', { harness: 'codex', limit: -5, compact: null })).rejects.toThrow(/positive whole number/)
    await expect(call('rules:context-test', { harness: 'cursor' })).rejects.toThrow(/codex, claude/)
  })
})

describe('skills on Rules › Skills and Health (60.11 AC1-AC5)', () => {
  /** A stub Codex that names the skills in ~/.agents/skills, whatever home folder it is started in. */
  const codexLister = [
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi',
    '[ "$1 $2" = "debug prompt-input" ] || exit 4',
    'for d in "$HOME"/.agents/skills/*/; do [ -f "${d}SKILL.md" ] && echo "skill $(basename "$d")"; done',
    'exit 0'
  ].join('\n')
  const skill = (name: string): void => {
    mkdirSync(join(home, '.claude/skills', name), { recursive: true })
    writeFileSync(join(home, '.claude/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic skill ${name}.\n---\n\nSYNTHETIC-BODY ${name}\n`)
  }
  const rulesSnapshot = (): Promise<RulesSnapshot> => call('rules:snapshot')

  it('writes nothing before the owner\'s test, then installs as one transaction that Undo puts back', async () => {
    await approvedAndInstalled()
    skill('alpha')
    skill('beta')
    stub('codex', codexLister)
    const before = (await rulesSnapshot()).skills
    expect(before.source).toEqual({ path: join(home, '.claude/skills'), readable: true })
    expect(before.skills.map((entry) => [entry.name, entry.description, entry.states])).toEqual([['alpha', 'Synthetic skill alpha.', {}], ['beta', 'Synthetic skill beta.', {}]])
    expect(before.apps.map((app) => [app.harness, app.supported, app.state, app.testable])).toEqual([
      ['claude', false, 'Not supported yet', true], ['codex', false, 'Not supported yet', true], ['opencode', false, 'Not supported yet', true], ['cursor', false, 'Not supported yet', false]
    ])
    expect(await call<SkillsPlan>('rules:skills-plan')).toMatchObject({ ok: false, code: 'SKILLS_UNSUPPORTED', targets: [] })

    const tested = await call<RulesOutcome>('rules:skills-test', { harness: 'codex' })
    expect(tested).toMatchObject({ ok: true, message: `Codex skills test passed: Codex reads skills from ~/.agents/skills; Codex lists a test skill placed in ${join(home, '.agents/skills')}; no prompt was sent, so this shows the app finds a skill there, not that a model uses it` })
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([])
    const codex = tested.snapshot.skills.apps[1]!
    expect(codex).toMatchObject({ supported: true, location: join(home, '.agents/skills'), format: 'link', readsSource: false, kind: 'full', state: 'Missing', test: { outcome: 'pass', version: '0.161.0' }, loadTestable: true, listing: { outcome: 'pass', stale: false }, loading: null })
    expect(tested.snapshot.skills).toMatchObject({ pending: 2, exposed: 0 })
    expect(tested.snapshot.skills.skills.map((entry) => entry.states)).toEqual([{ codex: 'missing' }, { codex: 'missing' }])

    const plan = await call<SkillsPlan>('rules:skills-plan')
    expect(plan).toMatchObject({ ok: true, exposed: [] })
    expect(plan.targets.map((target) => [target.harness, target.skill, target.kind, target.note, target.diff])).toEqual([
      ['codex', 'alpha', 'adds the skill', 'A link to the skill in the skills folder.', ''], ['codex', 'beta', 'adds the skill', 'A link to the skill in the skills folder.', '']
    ])
    expect(JSON.stringify([before, tested, plan])).not.toContain('SYNTHETIC-BODY')
    expect(await call<RulesOutcome>('rules:skills-install', { planHash: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    const installed = await call<RulesOutcome>('rules:skills-install', { planHash: plan.planHash })
    expect(installed).toMatchObject({ ok: true, message: 'Changed 2 skill entries. Sessions started before this keep the skills they had.' })
    expect(readlinkSync(join(home, '.agents/skills/alpha'))).toBe(join(home, '.claude/skills/alpha'))
    expect(installed.snapshot.skills).toMatchObject({ pending: 0, exposed: 0 })
    expect(installed.snapshot.skills.apps[1]).toMatchObject({ state: 'Linked' })
    // The loading test is its own record: a stand-in that answers no prompt leaves it inconclusive, and the listing pass does not stand in for it.
    const loaded = await call<RulesOutcome>('rules:skills-loading-test', { harness: 'codex' })
    expect(loaded).toMatchObject({ ok: true, message: 'Codex skill loading test was inconclusive: codex did not answer (timeout or error)' })
    expect(loaded.snapshot.skills.apps[1]).toMatchObject({ listing: { outcome: 'pass' }, loading: { outcome: 'inconclusive', stale: false } })
    expect(readdirSync(join(home, '.agents/skills')).sort()).toEqual(['alpha', 'beta'])
    // The skills changed since the tests: both read stale.
    skill('gamma')
    expect((await rulesSnapshot()).skills.apps[1]).toMatchObject({ state: 'Missing', listing: { stale: true }, loading: { stale: true } })

    const transaction = installed.snapshot.transactions[0]!
    expect(transaction).toMatchObject({ reason: 'skills install', targets: ['codex'], state: 'complete' })
    const undo = await call<RulesPlan>('rules:plan-restore', { transaction: transaction.id })
    expect(undo.targets.map((target) => [target.harness, target.change, target.note])).toEqual([
      ['codex', 'missing', 'A skill is put back whole; its lines are not shown.'], ['codex', 'missing', 'A skill is put back whole; its lines are not shown.']
    ])
    expect(await call<RulesOutcome>('rules:restore', { transaction: transaction.id, planHash: undo.planHash })).toMatchObject({ ok: true, message: 'Put back the skills in Codex' })
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([])
    await expect(call('rules:skills-test', { harness: 'vim' })).rejects.toThrow()
    await expect(call('rules:skills-loading-test', { harness: 'vim' })).rejects.toThrow()
  })

  it('previews which apps a staged skills change reaches, and approves it with the team', async () => {
    await approvedAndInstalled()
    skill('alpha')
    const data = (await snapshot()).file.data as RosterDataShape
    const staged: RosterDataShape = { ...data, skills: [{ id: 'alpha', public: true, only: ['codex', 'opencode'] }] }
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    expect(preview.valid).toBe(true)
    expect(preview.differences).toEqual([{ scope: 'skills', id: 'alpha', field: null, kind: 'added', after: { present: true, value: { public: true, only: ['codex', 'opencode'] } } }])
    expect(preview.consequences).toEqual(['Skill alpha would reach OpenCode', 'Skill alpha would no longer reach Claude Code'])
    const approved = await call<AgentsOutcome>('agents:save', { shown: await shown(), data: staged, teamUpdate: bindings(preview) })
    expect(approved).toMatchObject({ ok: true })
    expect(file('.config/bmn/agents/roster.md')).toContain('## skills\n\n```yaml\npublic: [alpha]\nonly: {alpha: [codex, opencode]}\n```')
    expect(((await snapshot()).approved?.data as RosterDataShape).skills).toEqual([{ id: 'alpha', public: true, only: ['codex', 'opencode'] }])
  })
})

describe('tools on Rules › Tools and Health (60.12 AC1-AC6)', () => {
  const SECRET = 'sk-SYNTHETIC-SECRET-9f8e7d6c5b4a'
  /** A stand-in Codex: its list repeats its settings file, and a run told to take only its own tools names only those. */
  const codexTools = [
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi',
    'alone=""; own=""',
    'while [ "$1" = "-c" ]; do case "$2" in "mcp_servers={}") alone=1;; mcp_servers.*.command=*) own="${2#mcp_servers.}"; own="${own%%.*}";; esac; shift 2; done',
    '[ "$1 $2" = "mcp list" ] || exit 4',
    '[ -n "$alone" ] || cat "$HOME/.codex/config.toml" 2>/dev/null',
    '[ -z "$own" ] || echo "$own"',
    'exit 0'
  ].join('\n')
  const OWN = `model = "gpt-6.1-sol"\n\n[mcp_servers.search]\ncommand = "search-tool"\nenv = { SEARCH_KEY = "${SECRET}" }\n`
  const rulesSnapshot = (): Promise<RulesSnapshot> => call('rules:snapshot')

  it('writes nothing before the owner\'s test, proposes what the apps hold without a value, then installs entry by entry and Undo puts the file back', async () => {
    await approvedAndInstalled()
    stub('codex', codexTools)
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/config.toml'), OWN, { mode: 0o600 })
    const before = (await rulesSnapshot()).tools
    expect(before).toMatchObject({ pending: 0, exposed: 0, blocked: 0, tools: [] })
    expect(before.apps.map((app) => [app.harness, app.supported, app.state, app.reason, app.path.replace(home, '~'), app.kind])).toEqual([
      ['claude', false, 'Not supported yet', 'no test has run on Claude Code 2.1.295', '~/.claude.json', 'full'],
      ['codex', false, 'Not supported yet', 'no test has run on Codex 0.161.0', '~/.codex/config.toml', 'full'],
      ['opencode', false, 'Not supported yet', 'OpenCode is not installed, or its version cannot be read', '~/.config/opencode/opencode.jsonc', 'public'],
      ['cursor', false, 'Not supported yet', 'Cursor is not installed, or its version cannot be read', '~/.cursor/mcp.json', 'public']
    ])

    // What Codex already holds is proposed as a tool kept to Codex, without the value its entry held.
    const found = await call<{ ok: boolean; proposals: ToolProposalView[] }>('rules:tools-proposals')
    expect(found).toEqual({ ok: true, proposals: [{
      id: 'search', state: 'secret', apps: ['codex'], tool: { id: 'search', name: 'Search', command: 'search-tool', apps: ['codex'] },
      notes: ['holds a value inline (Codex env.SEARCH_KEY): move this value into an environment variable; it was left out and the tool cannot be installed until then']
    }] })

    const data = (await snapshot()).file.data as RosterDataShape
    const staged: RosterDataShape = { ...data, tools: [{ id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', public: true }, found.proposals[0]!.tool!] }
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    expect(preview.valid).toBe(true)
    expect(preview.differences.map((diff) => [diff.scope, diff.id, diff.kind])).toEqual([['tools', 'docs', 'added'], ['tools', 'search', 'added']])
    expect(preview.consequences).toEqual(['Tool Docs would reach Claude Code, Codex, OpenCode and Cursor', 'Tool Search would reach Codex',
      'With a tool on the list, the check passes a run only in Claude Code, once its tools test passed there; a Codex run is refused until BMN has such a test for Codex'])
    expect(await call<AgentsOutcome>('agents:save', { shown: await shown(), data: staged, teamUpdate: bindings(preview) })).toMatchObject({ ok: true })
    expect(file('.config/bmn/agents/roster.md')).toContain('## tools\n\n```yaml\ndocs: {name: Docs, url: "https://docs.example.test/mcp", public: true}\nsearch: {name: Search, command: search-tool, apps: [codex]}\n```')
    expect(await call<ToolsPlan>('rules:tools-plan')).toMatchObject({ ok: false, code: 'TOOLS_UNSUPPORTED', planHash: null, targets: [] })
    expect(file('.codex/config.toml')).toBe(OWN)

    const tested = await call<RulesOutcome>('rules:tools-test', { harness: 'codex' })
    expect(tested).toMatchObject({ ok: true, message: 'Codex tools test passed: Codex reads its tools from ~/.codex/config.toml; its own list names the environment variable a tool is given (the tool was not started); BMN has no test yet that shows which tools a run of Codex starts with, so a run cannot be kept to its own tools' })
    expect(readdirSync(home).filter((name) => name.startsWith('.bmn-tools-test-'))).toEqual([])
    expect(file('.codex/config.toml')).toBe(OWN)
    expect(tested.snapshot.tools).toMatchObject({ pending: 1, exposed: 0, blocked: 1 })
    expect(tested.snapshot.tools.apps[1]).toMatchObject({ supported: true, state: 'Differs', variable: true, isolation: false, test: { outcome: 'pass', version: '0.161.0' }, unlisted: [] })
    expect(tested.snapshot.tools.tools).toEqual([
      { id: 'docs', states: { codex: 'missing' }, details: {} },
      { id: 'search', states: { codex: 'unmanaged' }, details: { codex: 'it holds a value inline (env.SEARCH_KEY): move it into an environment variable, then name the variable in the tool' } }
    ])

    const plan = await call<ToolsPlan>('rules:tools-plan')
    expect(plan).toMatchObject({ ok: true, removeUnlisted: false, exposed: [] })
    expect(plan.targets).toEqual([{ harness: 'codex', tool: 'docs', path: join(home, '.codex/config.toml'), action: 'set', words: 'adds the tool', before: null, after: '[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"' }])
    // The entry that holds a value is left alone, and the plan says what to do about it.
    expect(plan.blocked).toEqual([{ harness: 'codex', tool: 'search', fix: 'it holds a value inline (env.SEARCH_KEY): move it into an environment variable, then name the variable in the tool' }])
    expect(await call<RulesOutcome>('rules:tools-install', { planHash: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(file('.codex/config.toml')).toBe(OWN)
    const installed = await call<RulesOutcome>('rules:tools-install', { planHash: plan.planHash })
    expect(installed).toMatchObject({ ok: true, message: 'Changed 1 tool entry. Sessions started before this keep the tools they had. 1 could not be changed.' })
    // Only the one entry was added: every byte the file held is still there.
    expect(file('.codex/config.toml')).toBe(`${OWN}\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n`)
    expect(installed.snapshot.tools).toMatchObject({ pending: 0, blocked: 1 })
    expect(installed.snapshot.tools.tools[0]).toEqual({ id: 'docs', states: { codex: 'current' }, details: {} })
    // No value an entry held reached the page, in any answer.
    expect(JSON.stringify([before, found, preview, tested, plan, installed])).not.toContain(SECRET)

    const transaction = installed.snapshot.transactions[0]!
    expect(transaction).toMatchObject({ reason: 'tools install', targets: ['codex'], state: 'complete' })
    const undo = await call<RulesPlan>('rules:plan-restore', { transaction: transaction.id })
    expect(undo.targets).toEqual([{ harness: 'codex', path: join(home, '.codex/config.toml'), kind: 'removed (it was not there)', change: 'missing', diff: '', note: 'Only this entry changes; the rest of the file stays as it is now.', entry: 'docs' }])
    expect(file('.codex/config.toml')).toContain('[mcp_servers.docs]')
    expect(await call<RulesOutcome>('rules:restore', { transaction: transaction.id, planHash: undo.planHash })).toMatchObject({ ok: true, message: 'Put back the tools in Codex' })
    expect(file('.codex/config.toml')).toBe(OWN)
    await expect(call('rules:tools-test', { harness: 'vim' })).rejects.toThrow()
  })

  it('removes entries that are not on the list only when asked, each shown first', async () => {
    await approvedAndInstalled()
    stub('codex', codexTools)
    mkdirSync(join(home, '.codex'), { recursive: true })
    const kept = 'model = "gpt-6.1-sol"\n\n[mcp_servers.old]\ncommand = "old-tool"\n'
    writeFileSync(join(home, '.codex/config.toml'), kept, { mode: 0o600 })
    const data = (await snapshot()).file.data as RosterDataShape
    const staged: RosterDataShape = { ...data, tools: [{ id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp' }] }
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    expect(await call<AgentsOutcome>('agents:save', { shown: await shown(), data: staged, teamUpdate: bindings(preview) })).toMatchObject({ ok: true })
    const tested = await call<RulesOutcome>('rules:tools-test', { harness: 'codex' })
    expect(tested.snapshot.tools.apps[1]).toMatchObject({ supported: true, unlisted: [{ id: 'old', state: 'unmanaged', managed: false }] })
    // An ordinary install leaves the entry BMN did not write.
    expect((await call<ToolsPlan>('rules:tools-plan')).targets.map((target) => [target.tool, target.action])).toEqual([['docs', 'set']])
    const plan = await call<ToolsPlan>('rules:tools-plan', { removeUnlisted: true })
    expect(plan).toMatchObject({ ok: true, removeUnlisted: true })
    expect(plan.targets.map((target) => [target.tool, target.action, target.before, target.after])).toEqual([
      ['docs', 'set', null, '[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"'], ['old', 'remove', '[mcp_servers.old]\ncommand = "old-tool"', null]
    ])
    // The plan that was shown is the one that is installed: the same hash without the removal is refused.
    expect(await call<RulesOutcome>('rules:tools-install', { planHash: plan.planHash })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(file('.codex/config.toml')).toBe(kept)
    expect(await call<RulesOutcome>('rules:tools-install', { planHash: plan.planHash, removeUnlisted: true })).toMatchObject({ ok: true, message: 'Changed 2 tool entries. Sessions started before this keep the tools they had.' })
    expect(file('.codex/config.toml')).toBe('model = "gpt-6.1-sol"\n\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n')
    const state = await rulesSnapshot()
    expect(state.tools).toMatchObject({ pending: 0, exposed: 0, blocked: 0 })
    const undo = await call<RulesPlan>('rules:plan-restore', { transaction: state.transactions[0]!.id })
    expect(undo.targets.map((target) => [target.entry, target.change])).toEqual([['old', 'entry'], ['docs', 'missing']])
    expect(await call<RulesOutcome>('rules:restore', { transaction: state.transactions[0]!.id, planHash: undo.planHash })).toMatchObject({ ok: true })
    expect(file('.codex/config.toml')).toBe(kept)
  })
})

describe('Skills and Tools when the approved team cannot be read (R60-NFR1)', () => {
  it('say so on both pages and propose nothing, instead of judging a team without marks or tools', async () => {
    await approvedAndInstalled()
    writeFileSync(join(home, '.config/bmn/agents/state/current'), '{ not json')
    const rules = await call<RulesSnapshot>('rules:snapshot')
    expect(rules.skills).toMatchObject({ source: { readable: false }, skills: [], apps: [] })
    expect(rules.skills.source.detail).toMatch(/approved/i)
    expect(rules.tools).toMatchObject({ tools: [], apps: [] })
    expect(rules.tools.error).toBe(rules.skills.source.detail)
    const found = await call<{ ok: boolean; message?: string; proposals: ToolProposalView[] }>('rules:tools-proposals')
    expect(found).toMatchObject({ ok: false, proposals: [] })
    expect(found.message).toBe(rules.tools.error)
  })
})

describe('research on Team › Models (60.10)', () => {
  const PAGE = 'https://prices.example.test/anthropic'
  const price = (input: number, output: number) => ({ input, output, source: PAGE, as_of: '2026-10-10' })
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, provider: 'Anthropic', listed: false, price: 'unavailable', context_window: 'unavailable', ...extra })
  const ANTHROPIC = JSON.stringify({ version: 1, models: [
    entry('claude-fable-5-1', { price: price(20, 100) }), entry('claude-haiku-5-5'), entry('claude-opus-5-5', { price: price(15, 75) }), entry('claude-sonnet-5-5', { price: price(3, 99) }),
    entry('claude-opus-5-6', { listed: true, price: price(15, 75) })
  ] })
  const unavailable = (ids: string[], provider: string): string => JSON.stringify({ version: 1, models: ids.map((id) => ({ ...entry(id), provider })) })
  const FULL: Record<string, { text: string; delay?: number }> = {
    'claude-fable-5-1': { text: ANTHROPIC }, 'gpt-6-astra': { text: unavailable(['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'], 'OpenAI') }, 'glm-5.3': { text: unavailable(['glm-5.3'], 'Z.ai') }
  }
  /** A stand-in Claude Code: it records how it was started and answers from plan.json, by a model named in the prompt. */
  const researcher = (): void => {
    writeFileSync(join(stubs, 'claude'), `#!${process.execPath}
const fs = require('node:fs')
const home = process.env.HOME
if (process.argv[2] === '--version') { console.log('2.1.295 (Claude Code)'); process.exit(0) }
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(home + '/calls.log', JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), path: process.env.PATH, cwd: process.cwd(), prompt }) + '\\n')
const plan = JSON.parse(fs.readFileSync(home + '/plan.json', 'utf8'))
const key = Object.keys(plan).find((model) => prompt.includes('- ' + model + '\\n'))
const entry = plan[key] ?? { text: 'no plan' }
setTimeout(() => console.log(JSON.stringify({ type: 'result', is_error: false, result: entry.text })), entry.delay ?? 0)
`)
    chmodSync(join(stubs, 'claude'), 0o755)
  }
  const plan = (entries: Record<string, { text: string; delay?: number }>): void => writeFileSync(join(home, 'plan.json'), JSON.stringify(entries))
  const calls = (): { argv: string[]; env: string[]; path: string; cwd: string; prompt: string }[] =>
    (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
  const load = (fresh = false): Promise<ResearchSnapshot> => call('research:load', { fresh })
  const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
  const ended = async (): Promise<ResearchSnapshot> => {
    for (let tries = 0; tries < 400; tries += 1) {
      const state = await load()
      if (state.running === null) return state
      await pause(25)
    }
    throw new Error('the research did not end')
  }

  beforeEach(async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
    researcher()
    researchPages = join(home, 'pages')
    mkdirSync(join(researchPages, 'prices.example.test'), { recursive: true })
    writeFileSync(join(researchPages, 'prices.example.test/anthropic'),
      '<p>Prices per 1M tokens.</p><ul><li>claude-opus-5-5: input $15, output $75</li><li>claude-fable-5-1: input $20, output $100</li><li>claude-sonnet-5-5: input $3, output $15</li><li>claude-opus-5-6: input $15, output $75</li></ul>')
  })

  it('offers who may research, keeps the owner\'s pick, and asks no app on a plain read', async () => {
    const plain = await load()
    expect(plain).toMatchObject({ last: null, previousAt: null, models: [], researchers: [], researcher: null, running: null, ended: null })
    const fresh = await load(true)
    expect(fresh.researchers.map((agent) => [agent.id, agent.harness, agent.ok])).toEqual([['sol', 'codex', false], ['opus', 'claude', true], ['astra', 'codex', false], ['fable', 'claude', true], ['luna', 'codex', false]])
    // Research runs in Claude Code only until another app's fence is verified on its installed version.
    expect(fresh.researchers.find((agent) => agent.id === 'sol')?.reason).toContain('research runs in Codex only on a version whose fence BMN verified')
    expect(fresh.researcher).toBe('opus')
    expect((await call<ResearchSnapshot>('research:choose', { researcher: 'fable' })).researcher).toBe('fable')
    // A pick that can no longer research falls back to one that can.
    expect((await call<ResearchSnapshot>('research:choose', { researcher: 'sonnet' })).researcher).toBe('opus')
    expect((await call<ResearchSnapshot>('research:choose', { researcher: 'astra' })).researcher).toBe('opus')
    expect(calls()).toEqual([])
  })

  it('runs in the background, says how far it is, and keeps what BMN confirmed on the cited pages', async () => {
    plan({ ...FULL, 'gpt-6-astra': { ...FULL['gpt-6-astra']!, delay: 400 } })
    await load(true)
    const started = await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    expect(started).toMatchObject({ running: { researcher: 'fable', lookup: false }, ended: null, researcher: 'fable' })
    // Pressing again while it runs starts nothing more.
    expect((await call<ResearchSnapshot>('research:start', { researcher: 'opus' })).running).toMatchObject({ researcher: 'fable' })
    expect(await call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-opus-5-6' })).toEqual({ ok: false, message: 'A research is going. Wait for it to end, or stop it.', model: null })
    const state = await ended()
    expect(state.ended).toEqual({ ok: true, text: 'Research found 9 models.', kept: true })
    expect(state.last).toMatchObject({ researcher: 'Fable', state: 'complete', models: 9 })
    const byId = Object.fromEntries(state.models.map((model) => [model.id, model]))
    expect(byId['claude-opus-5-5']).toMatchObject({ providerId: 'anthropic', fresh: true, foundLast: true, price: { input: 15, output: 75, source: PAGE, rank: 2, verified: true } })
    // The page shows another output price for this model: kept, marked, never offered as a fact.
    expect(byId['claude-sonnet-5-5']!.price).toMatchObject({ verified: false, why: 'the page does not show this price beside the model' })
    expect(byId['claude-haiku-5-5']).toMatchObject({ price: null, contextWindow: null })
    expect(byId['claude-opus-5-6']).toMatchObject({ price: { verified: true } })
    const run = calls()
    expect(run).toHaveLength(3)
    for (const one of run) {
      expect(one.env.filter((name) => !name.startsWith('__')).sort()).toEqual(['HOME', 'PATH'])
      expect(one.path.split(':')).not.toContain(dirname(SCRIPT))
      expect(one.argv.slice(0, 5)).toEqual(['-p', '--model', 'claude-fable-5-1', '--effort', 'low'])
      expect(one.prompt).not.toMatch(/SENTINEL|Owner's notes/)
    }
  })

  it('Stop ends the run and keeps what the earlier runs found', async () => {
    plan({ ...FULL, 'gpt-6-astra': { ...FULL['gpt-6-astra']!, delay: 60_000 } })
    await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    for (let tries = 0; tries < 400 && calls().length < 2; tries += 1) await pause(25)
    expect((await call<ResearchSnapshot>('research:stop')).running).not.toBeNull()
    const state = await ended()
    // The owner stopped it: that is how he asked it to end, not a failure.
    expect(state.ended).toEqual({ ok: true, text: 'Research kept 5 models. Stopped before it finished.', kept: true })
    expect(state.last).toMatchObject({ state: 'partial', models: 5, note: 'Stopped before it finished.' })
    expect(calls()).toHaveLength(2)
    // Stop with nothing going is not an error.
    expect((await call<ResearchSnapshot>('research:stop')).running).toBeNull()
  })

  it('Look up researches one name and hands back what BMN confirmed', async () => {
    plan({ 'claude-opus-5-6': { text: JSON.stringify({ version: 1, models: [entry('claude-opus-5-6', { price: price(15, 75) })] }) } })
    const result = await call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-opus-5-6' })
    expect(result).toMatchObject({ ok: true, message: 'Looked up claude-opus-5-6.', model: { id: 'claude-opus-5-6', providerId: 'anthropic', price: { input: 15, output: 75, verified: true } } })
    expect(calls()[0]!.prompt).toContain('List no other models.')
    // One name is not a research of the team.
    expect((await load()).last).toBeNull()
    plan({ 'claude-nova-9': { text: 'I do not know this model.' } })
    expect(await call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-nova-9' })).toEqual({ ok: false, message: 'Look up found nothing: Anthropic: the answer is not one JSON object', model: null })
    expect(await call<ResearchLookup>('research:lookup', { researcher: 'sonnet', provider: 'anthropic', model: 'claude-nova-9' })).toMatchObject({ ok: false, message: expect.stringContaining('BMN did not start the run: sonnet is proposed') })
  })

  it('Stop reaches a page that is being read, for a research and for a look up', async () => {
    const asked: { address: string; timeoutMs: number | undefined }[] = []
    // A site that never answers: the read ends only when Stop reaches it.
    researchFetch = (address, limits) => new Promise((resolve) => {
      asked.push({ address, timeoutMs: limits?.timeoutMs })
      limits?.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'the research was stopped' }), { once: true })
    })
    plan(FULL)
    await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    for (let tries = 0; tries < 400 && asked.length === 0; tries += 1) await pause(25)
    expect(asked).toEqual([{ address: PAGE, timeoutMs: 10_000 }])
    await call<ResearchSnapshot>('research:stop')
    const state = await ended()
    expect(state.ended).toEqual({ ok: true, text: 'Research kept 5 models. Stopped before it finished.', kept: true })
    expect(state.models.find((model) => model.id === 'claude-opus-5-5')!.price).toMatchObject({ verified: false, why: 'the research was stopped' })
    expect(calls()).toHaveLength(1)
    asked.length = 0
    plan({ 'claude-opus-5-6': { text: JSON.stringify({ version: 1, models: [entry('claude-opus-5-6', { price: price(15, 75) })] }) } })
    const looking = call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-opus-5-6' })
    for (let tries = 0; tries < 400 && asked.length === 0; tries += 1) await pause(25)
    expect(asked).toHaveLength(1)
    await call<ResearchSnapshot>('research:stop')
    expect(await looking).toMatchObject({ ok: true, model: { id: 'claude-opus-5-6', price: { verified: false, why: 'the research was stopped' } } })
    expect((await load()).running).toBeNull()
  })

  it('the time limit reaches the last page too: what it could not read is kept unconfirmed and the research is not called finished', async () => {
    researchLimitMs = 4000
    const given: number[] = []
    // A site that answers nothing for as long as it is given.
    researchFetch = (_address, limits) => new Promise((resolve) => {
      given.push(limits?.timeoutMs ?? -1)
      setTimeout(() => resolve({ ok: false, reason: 'the page did not answer in time' }), limits?.timeoutMs ?? 60_000)
    })
    plan({ 'claude-opus-5-6': { text: JSON.stringify({ version: 1, models: [entry('claude-opus-5-6', { price: price(15, 75) })] }) } })
    const found = await call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-opus-5-6' })
    expect(given).toHaveLength(1)
    expect(given[0]).toBeGreaterThan(0)
    expect(given[0]).toBeLessThanOrEqual(4000)
    expect(found).toMatchObject({ ok: true, model: { price: { verified: false, why: 'the page did not answer in time' } } })
    plan(FULL)
    const started = Date.now()
    await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    const state = await ended()
    expect(Date.now() - started).toBeLessThan(8000)
    expect(state.last).toMatchObject({ state: 'partial', note: 'Ended at the 20-minute limit.' })
    expect(state.ended).toMatchObject({ ok: false, kept: true })
  }, 20_000)

  it('outside the self-test a reserved test address is never read, so nothing it shows counts', async () => {
    researchPages = null
    plan(FULL)
    await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    const state = await ended()
    expect(state.models.find((model) => model.id === 'claude-opus-5-5')!.price).toMatchObject({ verified: false, why: 'not a public address' })
  })

  it('says how a research ended in words', () => {
    expect(researchEndedWords({ state: 'complete', models: 1 })).toBe('Research found 1 model.')
    expect(researchEndedWords({ state: 'partial', models: 3, note: 'Ended at the 20-minute limit.' })).toBe('Research kept 3 models. Ended at the 20-minute limit.')
    expect(researchEndedWords({ state: 'stopped', models: 0, note: 'Stopped before it finished.' })).toBe('Stopped before it finished. Nothing was kept.')
    expect(researchEndedWords({ state: 'failed', models: 0, note: 'BMN did not start the run: sonnet is proposed, not approved as active' })).toBe('Research failed: BMN did not start the run: sonnet is proposed, not approved as active')
  })
})
