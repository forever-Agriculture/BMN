// MODULE: agents-ipc.test.ts - Epic 60.4–60.6: the Team and Rules handlers preview an approval, update only the rules files that were shown, and re-inspect what an approval records
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentsOutcome, AgentsPreview, AgentsShownRevision, AgentsSnapshot, ContextLimitPlan, RosterDataShape, RulesMasterPlan, RulesOutcome, RulesPlan, RulesRevertPlan, RulesSnapshot, SkillsPlan } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approveRoster, restoreGeneration, saveAndApprove } from './agents-approval'
import { fileToApproved, installAgentsIpcHandlers } from './agents-ipc'

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
  installAgentsIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
    senderIsAllowed: () => true, cliScript: () => SCRIPT, environment: () => ({ HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...appEnv }),
    openPath: async (path) => (existsSync(path) ? '' : 'no such file')
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
  function agentProcess(env: Record<string, string>, start = '777'): void {
    const folder = join(proc, '7001')
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'cmdline'), 'claude\0--resume\0')
    writeFileSync(join(folder, 'environ'), `${Object.entries({ HOME: home, PATH: '/usr/bin:/bin', ...env }).map(([key, value]) => `${key}=${value}`).join('\0')}\0`)
    writeFileSync(join(folder, 'stat'), `7001 (claude) S ${[1, 7001, 7001, 34817, 7001, ...Array(13).fill(0), start].join(' ')}\n`)
    symlinkSync(workspace, join(folder, 'cwd'))
  }

  const stop = (): Record<string, unknown> => ({ agent: 'claude', pid: 7001, start: '777', folder: workspace, workspace, providerId: 'moonshot', host: 'api.moonshot.ai', conversation: null })
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
    expect(tested).toMatchObject({ ok: true, message: `Codex skills test passed: Codex reads skills from ~/.agents/skills; Codex named a test skill placed in ${join(home, '.agents/skills')}` })
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([])
    const codex = tested.snapshot.skills.apps[1]!
    expect(codex).toMatchObject({ supported: true, location: join(home, '.agents/skills'), format: 'link', readsSource: false, kind: 'full', state: 'Missing', test: { outcome: 'pass', version: '0.161.0' }, loading: { outcome: 'pass', stale: false } })
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
    // The skills changed since the loading test: it reads stale.
    skill('gamma')
    expect((await rulesSnapshot()).skills.apps[1]).toMatchObject({ state: 'Missing', loading: { stale: true } })

    const transaction = installed.snapshot.transactions[0]!
    expect(transaction).toMatchObject({ reason: 'skills install', targets: ['codex'], state: 'complete' })
    const undo = await call<RulesPlan>('rules:plan-restore', { transaction: transaction.id })
    expect(undo.targets.map((target) => [target.harness, target.change, target.note])).toEqual([
      ['codex', 'missing', 'A skill is put back whole; its lines are not shown.'], ['codex', 'missing', 'A skill is put back whole; its lines are not shown.']
    ])
    expect(await call<RulesOutcome>('rules:restore', { transaction: transaction.id, planHash: undo.planHash })).toMatchObject({ ok: true, message: 'Put back the skills in Codex' })
    expect(readdirSync(join(home, '.agents/skills'))).toEqual([])
    await expect(call('rules:skills-test', { harness: 'vim' })).rejects.toThrow()
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
