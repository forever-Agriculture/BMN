// MODULE: agents-ipc.test.ts - Epic 60.4–60.6: the Team and Rules handlers preview an approval, update only the rules files that were shown, and re-inspect what an approval records
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LUNA_GO_PROPOSAL } from '@bmn/protocol'
import type { AgentsOutcome, AgentsPreview, AgentsShownRevision, AgentsSnapshot, ContextLimitPlan, OpenCodeGoView, JudgeTried, JudgeView, ResearchLookup, ResearchSnapshot, WebQuestionAsked, WebQuestionsSnapshot, RosterDataShape, RulesMasterPlan, RulesOutcome, RulesPlan, RulesRevertPlan, RulesSnapshot, SkillsPlan, ToolProposalView, ToolsPlan } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_RESEARCH_TOOLS_SEEN, fenceTestsPath, researchFormHash, type FenceTestEntry } from '../../bin/agents-check.mjs'
import { contextAuto, contextTests, setContextAuto } from '../../bin/agents-context.mjs'
import { fetchPublicPage } from '../../bin/agents-research.mjs'
import { judgeProposal } from '../../bin/agents-roster.mjs'
import { approveRoster, restoreGeneration, saveAndApprove } from './agents-approval'
import { fenceEndedWords, fileToApproved, installAgentsIpcHandlers, researchEndedWords, type AgentsIpcHandle } from './agents-ipc'

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
/** The port of the stand-in judge server; null as in the real app. */
let judgeTestPort: string | null
/** What the fence test started from Models does here; none is expected unless a test sets one. */
let fenceTest: NonNullable<Parameters<typeof installAgentsIpcHandlers>[1]>['fenceTest'] | null
let researchCompare: NonNullable<Parameters<typeof installAgentsIpcHandlers>[1]>['researchCompare'] | null
/** What OpenCode answers about Luna through OpenCode Go here (70.4); every call is recorded with the environment it was given. */
let openCodeGo: { listed: boolean; signedIn: boolean | null; copy: { ok: boolean; copied: boolean; message: string }; calls: Array<{ kind: string; home: string | undefined }> }
/** What installing the handlers handed back, and the notices BMN itself showed. */
let ipc: AgentsIpcHandle
let notices: { title: string; body: string }[]
/** The addresses handed to the owner's browser. */
let openedInBrowser: string[]
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
  judgeTestPort = null
  fenceTest = null
  researchCompare = null
  notices = []
  openedInBrowser = []
  openCodeGo = { listed: false, signedIn: true, copy: { ok: true, copied: false, message: 'BMN\'s OpenCode folder already holds your OpenCode Go sign-in' }, calls: [] }
  // BMN's own context testing is off here, as an owner may have it, so no test starts a stand-in app behind another test's back; its own tests switch it on.
  setContextAuto({ enabled: false })
  ipc = installAgentsIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
    senderIsAllowed: () => true, cliScript: () => SCRIPT, environment: () => ({ HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...appEnv }),
    openPath: async (path) => (existsSync(path) ? '' : 'no such file'), openExternal: async (address) => { openedInBrowser.push(address) }, resolvesPublic: async (host) => !host.startsWith('intranet.') && !host.startsWith('unknown.'), researchPages: () => researchPages,
    researchFetch: (address, limits) => (researchFetch ?? fetchPublicPage)(address, limits), researchLimitMs: () => researchLimitMs, judgeTestPort: () => judgeTestPort,
    fenceTest: async (options) => {
      if (fenceTest === null || fenceTest === undefined) throw new Error('no fence test is expected here')
      return fenceTest(options)
    },
    researchCompare: async (options) => {
      if (researchCompare === null || researchCompare === undefined) throw new Error('no comparison under a provider list is expected here')
      return researchCompare(options)
    },
    notifyApp: (notice) => { notices.push(notice) }, contextRetryLater: () => {},
    openCodeGo: {
      lists: async (options) => { openCodeGo.calls.push({ kind: 'lists', home: options?.environment?.HOME }); return { listed: openCodeGo.listed } },
      signedIn: async (options) => { openCodeGo.calls.push({ kind: 'signedIn', home: options?.environment?.HOME }); return { signedIn: openCodeGo.signedIn } },
      copy: async (options) => { openCodeGo.calls.push({ kind: 'copy', home: options?.environment?.HOME }); return openCodeGo.copy }
    }
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
    // Inspected and allowed private work, and still public: OpenCode gets public work only (owner decisions
    // 2026-10-10 and 2026-10-14), with OpenCode 2 installed too.
    stub('opencode', 'echo "opencode v2.0.28"')
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
    expect(apps[2]).toMatchObject({ versionState: 'unknown', versionNote: 'OpenCode is not installed, or its version cannot be read.' })
    // OpenCode is read like Claude Code and Codex now (owner decision 2026-10-14); Cursor still is not.
    stub('opencode', 'echo "opencode v2.0.28"')
    expect((await call<RulesSnapshot>('rules:snapshot')).apps[2]).toMatchObject({ version: '2.0.28', versionState: 'tested', versionNote: 'BMN tested how this version picks where to send data.' })
    stub('opencode', 'echo "2.1.0"')
    expect((await call<RulesSnapshot>('rules:snapshot')).apps[2]).toMatchObject({ version: '2.1.0', versionState: 'newer' })
    expect((await call<RulesSnapshot>('rules:snapshot')).apps[3]).toMatchObject({ versionState: 'unknown', versionNote: 'BMN does not check Cursor dispatches.' })
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
    writeFileSync(join(workspace, '.git/HEAD'), 'ref: refs/heads/main\n')
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
    ['the session moved to another workspace', (): void => { mkdirSync(join(home, 'code/other/.git'), { recursive: true }); writeFileSync(join(home, 'code/other/.git/HEAD'), 'ref: refs/heads/main\n'); agentProcess({ ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' }, '777', join(home, 'code/other')) }, {}],
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

describe('BMN\'s own context testing on Rules › Health (63.1)', () => {
  /** A stand-in Codex whose session record shows `window`; every start, also for its version, leaves a line. */
  const codex = (version: string, window: number): void => stub('codex', [
    'echo "$1" >> "$HOME/codex-calls"',
    `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`,
    'dir=""; prev=""', 'for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done', 'cat > /dev/null',
    'mkdir -p "$HOME/.codex/sessions/2026/10/10"',
    `printf '{"payload":{"cwd":"%s"}}\\n{"payload":{"type":"task_started","model_context_window":${window}}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/10/rollout-test.jsonl"`
  ].join('\n'))
  const calls = (name: string): string[] => (existsSync(join(home, `${name}-calls`)) ? file(`${name}-calls`).trim().split('\n') : [])
  const tests = (): number => calls('codex').filter((first) => first === 'exec').length
  /** The example team, in which only Sol (Codex) has a limit of its own, approved; the switch as a new install has it. */
  const approved = async (): Promise<void> => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    setContextAuto({ enabled: true })
  }
  const settled = (): Promise<RulesSnapshot['contextAuto']> => call('rules:context-auto', { fresh: false })

  it('tests a new version when Health reads the machine, says that it is, and then shows the test as its own and the limit as applied (AC1, AC5)', async () => {
    codex('0.161.0', 116850)
    stub('claude', 'echo "$1" >> "$HOME/claude-calls"\necho "2.1.295 (Claude Code)"')
    await approved()
    const first = await call<RulesSnapshot>('rules:snapshot')
    expect(first.contextAuto).toEqual({ enabled: true, running: 'codex' })
    expect(first.context[0]).toMatchObject({ limitProven: false, test: null, limits: [{ agent: 'Sol', limit: 272000, state: 'not-applied', reason: expect.stringContaining('BMN tests it by itself') }] })
    expect(first.context[1]).toMatchObject({ harness: 'claude', limits: [] })
    // A second read while the test runs starts no second one.
    await call<RulesSnapshot>('rules:snapshot')
    expect(await settled()).toEqual({ enabled: true, running: null })
    const after = await call<RulesSnapshot>('rules:snapshot')
    expect(after.contextAuto).toEqual({ enabled: true, running: null })
    expect(after.context[0]).toMatchObject({ limitProven: true, test: { outcome: 'pass', version: '0.161.0', by: 'bmn' }, limits: [{ agent: 'Sol', limit: 272000, state: 'applied' }] })
    expect(after.context[0]?.limits[0]).not.toHaveProperty('reason')
    await settled()
    expect([tests(), notices]).toEqual([1, []])
    // The app is updated: the next read tests the new version, once.
    codex('0.162.0', 116850)
    expect((await call<RulesSnapshot>('rules:snapshot')).contextAuto.running).toBe('codex')
    await settled()
    await call<RulesSnapshot>('rules:snapshot')
    await settled()
    expect([tests(), contextTests().map((entry) => [entry.version, entry.limit, entry.by])]).toEqual([2, [['0.161.0', 'pass', 'bmn'], ['0.162.0', 'pass', 'bmn']]])
    // Claude Code has no agent with a limit: it was asked for its version by Health, and never started.
    expect(calls('claude').every((first) => first === '--version')).toBe(true)
  })

  it('tests at the start of BMN and when an update ended, without Health, and asks no app for its version that no agent has a limit on (AC1)', async () => {
    codex('0.161.0', 116850)
    stub('claude', 'echo "$1" >> "$HOME/claude-calls"\necho "2.1.295 (Claude Code)"')
    await approved()
    rmSync(join(home, 'claude-calls'), { force: true })
    await ipc.contextAutoAtStart()
    expect([tests(), calls('claude'), contextTests().map((entry) => entry.by)]).toEqual([1, [], ['bmn']])
    codex('0.162.0', 116850)
    expect(await call('rules:context-auto', { fresh: true })).toEqual({ enabled: true, running: null })
    expect([tests(), calls('claude'), contextTests().map((entry) => entry.version)]).toEqual([2, [], ['0.161.0', '0.162.0']])
    // Nothing new: nothing started.
    await call('rules:context-auto', { fresh: true })
    await ipc.contextAutoAtStart()
    expect(tests()).toBe(2)
  })

  it('starts nothing with the switch off, says so, and tests once it is switched on (AC4)', async () => {
    codex('0.161.0', 116850)
    await approved()
    const off = await call<RulesOutcome>('rules:context-auto-set', { enabled: false })
    expect(off).toMatchObject({ ok: true, message: 'BMN no longer tests context limits by itself', snapshot: { contextAuto: { enabled: false, running: null } } })
    expect(off.snapshot.context[0]?.limits).toMatchObject([{ agent: 'Sol', state: 'not-applied', reason: expect.stringContaining("BMN's own test is switched off in Rules > Health") }])
    await ipc.contextAutoAtStart()
    await call<RulesSnapshot>('rules:snapshot')
    await call('rules:context-auto', { fresh: true })
    expect([tests(), contextAuto().enabled]).toEqual([0, false])
    // The owner's own test still runs, and is recorded as his.
    expect(await call<RulesOutcome>('rules:context-test', { harness: 'codex' })).toMatchObject({ ok: true, snapshot: { context: [{ test: { outcome: 'pass' } }, {}] } })
    expect(contextTests().map((entry) => entry.by)).toEqual([undefined])
    codex('0.162.0', 116850)
    const on = await call<RulesOutcome>('rules:context-auto-set', { enabled: true })
    expect(on).toMatchObject({ ok: true, message: 'BMN tests context limits by itself after an app update', snapshot: { contextAuto: { enabled: true, running: 'codex' } } })
    await settled()
    expect(contextTests().map((entry) => [entry.version, entry.by])).toEqual([['0.161.0', undefined], ['0.162.0', 'bmn']])
    await expect(call('rules:context-auto-set', { enabled: 'yes' })).rejects.toThrow(/true or false/)
  })

  it('tells the owner once when the test it ran failed, naming the agent (AC5)', async () => {
    codex('0.161.0', 258400)
    await approved()
    await ipc.contextAutoAtStart()
    await call<RulesSnapshot>('rules:snapshot')
    await settled()
    expect(tests()).toBe(1)
    expect(notices).toEqual([{ title: 'Codex context test failed', body: "Sol's own context limit does not hold on Codex 0.161.0: the test BMN ran by itself failed. Rules › Health has the details." }])
    const shownNow = await call<RulesSnapshot>('rules:snapshot')
    expect(shownNow.context[0]).toMatchObject({ limitProven: false, test: { outcome: 'fail', by: 'bmn' }, limits: [{ agent: 'Sol', state: 'not-applied', reason: expect.stringContaining('the context test failed on this Codex version') }] })
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
      'With a tool on the list, the check keeps every Claude Code run to exactly its own tools, once its tools test passed there; it does not judge the tools of a Codex run'])
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
    // Codex researches only where the fence test of its installed version is on record as passed (63.3).
    expect(fresh.researchers.find((agent) => agent.id === 'sol')).toMatchObject({ why: 'the fence test has not run for this version of Codex yet',
      reason: expect.stringContaining('research runs in Codex only on a version whose fence test passed') })
    expect(fresh.researcher).toBe('opus')
    // A team from before the mark: the choice of who researches waits for the owner, and BMN says whom it would name.
    expect(fresh).toMatchObject({ choice: { named: null, proposed: ['sol', 'opus', 'luna'] }, dropped: null, fenceTest: { running: false, ended: null } })
    expect((await call<ResearchSnapshot>('research:choose', { researcher: 'fable' })).researcher).toBe('fable')
    // Only a listed researcher can be picked: Sonnet is proposed, so it is not among them and the pick stands.
    expect((await call<ResearchSnapshot>('research:choose', { researcher: 'sonnet' })).researcher).toBe('fable')
    // A pick that cannot research now falls back to one that can.
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

  describe('who researches, and Codex behind its fence (63.3)', () => {
    /** The team file with `researcher: true` on each named agent's own entry, approved as the owner would. */
    const name = async (...ids: string[]): Promise<void> => {
      const text = ids.reduce((all, id) => {
        const end = all.indexOf('\n', all.indexOf('\nroles:', all.indexOf(`## ${id}\n`)) + 1)
        return `${all.slice(0, end)}\nresearcher: true${all.slice(end)}`
      }, readFileSync(rosterFile(), 'utf8'))
      writeFileSync(rosterFile(), text)
      expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
    }
    const passed = (models: string[], fields: Partial<FenceTestEntry> = {}): FenceTestEntry => ({
      harness: 'codex', at: '2026-10-10T11:00:00.000Z', version: '0.161.0', form: researchFormHash('codex'), catalog: 'bundled', verdict: 'pass', reasons: [],
      models: models.map((model) => ({ model, verdict: 'pass', tools: [...CODEX_RESEARCH_TOOLS_SEEN], reasons: [] })), ...fields
    })
    const tested = async (): Promise<ResearchSnapshot> => {
      for (let tries = 0; tries < 400; tries += 1) {
        const state = await load()
        if (!state.fenceTest.running) return state
        await pause(10)
      }
      throw new Error('the fence test did not end')
    }

    it('once the team names its researchers Models offers only those, and a pick that is no longer named falls back, said until he picks again', async () => {
      await load(true)
      await call<ResearchSnapshot>('research:choose', { researcher: 'fable' })
      await name('sol', 'opus', 'luna')
      const named = await load(true)
      expect(named.choice).toEqual({ named: ['sol', 'opus', 'luna'], proposed: [] })
      expect(named.researchers.map((agent) => [agent.id, agent.ok])).toEqual([['sol', false], ['opus', true], ['luna', false]])
      // Fable was his pick and is no longer named: none is picked, no other agent stands in for it, and the page is told whom he lost.
      expect(named).toMatchObject({ researcher: null, dropped: 'Fable' })
      expect(await load()).toMatchObject({ researcher: null, dropped: 'Fable' })
      // An agent the team does not name cannot be picked, and a research with it is refused by the check.
      expect((await call<ResearchSnapshot>('research:choose', { researcher: 'fable' }))).toMatchObject({ researcher: null, dropped: 'Fable' })
      await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
      expect((await ended()).ended).toEqual({ ok: false, text: 'Research failed: BMN did not start the run: fable is not one of the team\'s researchers (sol, opus, luna)', kept: false })
      expect(calls()).toEqual([])
      expect(await call<ResearchSnapshot>('research:choose', { researcher: 'opus' })).toMatchObject({ researcher: 'opus', dropped: null })
    })

    it('a team that names no researcher offers none, and Models picks none', async () => {
      await name('opus')
      expect((await load(true)).researcher).toBe('opus')
      await call<ResearchSnapshot>('research:choose', { researcher: 'opus' })
      // The last researcher switched off: the mark stays on the team, as `false`.
      writeFileSync(rosterFile(), readFileSync(rosterFile(), 'utf8').replace('researcher: true', 'researcher: false'))
      expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
      const none = await load(true)
      expect(none).toMatchObject({ researchers: [], researcher: null, dropped: 'Opus', choice: { named: [], proposed: [] } })
      await call<ResearchSnapshot>('research:start', { researcher: 'opus' })
      expect((await ended()).ended).toEqual({ ok: false, text: 'Research failed: BMN did not start the run: opus is not one of the team\'s researchers (the team names none)', kept: false })
      expect(calls()).toEqual([])
    })

    it('a comparison under the provider\'s own list that closes a Codex researcher is shown on the open page at once, with why', async () => {
      await name('sol', 'opus', 'luna')
      mkdirSync(dirname(fenceTestsPath()), { recursive: true })
      writeFileSync(fenceTestsPath(), `${JSON.stringify(passed(['gpt-6.1-sol', 'gpt-6-luna']))}\n`)
      const open = await load(true)
      expect(open.researchers.map((agent) => [agent.id, agent.ok])).toEqual([['sol', true], ['opus', true], ['luna', true]])
      // The comparison finds a tool BMN has not looked at, and records it where the check reads it.
      const why = 'a tool BMN has not looked at: function:functions.shell'
      researchCompare = async ({ agent }) => {
        const failed = passed([agent.model], { catalog: 'live', verdict: 'fail', at: '2026-10-11T08:01:00.000Z' })
        failed.models[0] = { model: agent.model, verdict: 'fail', tools: [...CODEX_RESEARCH_TOOLS_SEEN, 'function:functions.shell'], reasons: [why] }
        writeFileSync(fenceTestsPath(), `${readFileSync(fenceTestsPath(), 'utf8')}${JSON.stringify(failed)}\n`)
        return { ok: false, closed: true, reason: `under the provider's own model list the fence test of Codex 0.161.0 did not pass for ${agent.model}: ${why}` }
      }
      await call<ResearchSnapshot>('research:start', { researcher: 'luna' })
      // No fresh read is asked for: the page that was open hears it with the end of the research.
      const after = await ended()
      expect(after.ended).toMatchObject({ ok: false, text: expect.stringContaining('under the provider\'s own model list the fence test of Codex 0.161.0 did not pass for gpt-6-luna') })
      expect(calls()).toEqual([])
      const luna = after.researchers.find((agent) => agent.id === 'luna')!
      expect(luna.ok).toBe(false)
      expect(luna.why).toBe('Codex offers it other tools than the fence test saw')
      // Luna was his pick and can no longer research: nobody is picked in her place, and the others stand as they stood.
      expect(after.researcher).not.toBe('luna')
      expect(after.researchers.filter((agent) => agent.ok).map((agent) => agent.id)).toEqual(['sol', 'opus'])
      // Look up closes the same way.
      writeFileSync(fenceTestsPath(), `${JSON.stringify(passed(['gpt-6.1-sol', 'gpt-6-luna']))}\n`)
      expect((await load(true)).researchers.find((agent) => agent.id === 'sol')?.ok).toBe(true)
      expect(await call<{ ok: boolean }>('research:lookup', { researcher: 'sol', provider: 'openai', model: 'gpt-6.1-sol' })).toMatchObject({ ok: false })
      expect((await load()).researchers.find((agent) => agent.id === 'sol')).toMatchObject({ ok: false, why: 'Codex offers it other tools than the fence test saw' })
    })

    it('the owner starts the fence test from Models: one at a time, in the background, and its record opens the offer of exactly that Codex version', async () => {
      await name('sol', 'opus', 'luna')
      expect((await load(true)).researchers.filter((agent) => agent.ok).map((agent) => agent.id)).toEqual(['opus'])
      let release: () => void = () => {}
      let started = 0
      fenceTest = async (options) => {
        started += 1
        expect(options?.environment?.PATH).toBe(`${stubs}:/usr/bin:/bin`)
        await new Promise<void>((resolve) => { release = resolve })
        const entry = passed(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
        mkdirSync(dirname(fenceTestsPath()), { recursive: true })
        writeFileSync(fenceTestsPath(), `${JSON.stringify(entry)}\n`)
        return entry
      }
      expect((await call<ResearchSnapshot>('research:fence-test')).fenceTest).toEqual({ running: true, ended: null })
      // Pressed again while it runs, it starts nothing more.
      expect((await call<ResearchSnapshot>('research:fence-test')).fenceTest.running).toBe(true)
      await pause(20)
      expect(started).toBe(1)
      // While the test runs no research starts either: a research asks how that test stands.
      expect((await call<ResearchSnapshot>('research:start', { researcher: 'opus' })).running).toBeNull()
      expect(await call<{ ok: boolean; message: string }>('research:lookup', { researcher: 'opus', provider: 'anthropic', model: 'claude-opus-5-5' }))
        .toMatchObject({ ok: false, message: 'The Codex fence test is running. Wait for it to end.' })
      release()
      const done = await tested()
      expect(done.fenceTest).toEqual({ running: false, ended: { ok: true, text: 'The fence test of Codex 0.161.0 passed: a research run sends its provider nothing of yours.' } })
      expect(done.researchers.map((agent) => [agent.id, agent.ok, agent.fence?.compared])).toEqual([['sol', true, false], ['opus', true, undefined], ['luna', true, false]])
      expect(done.researchers.find((agent) => agent.id === 'luna')?.fence?.tools).toEqual(CODEX_RESEARCH_TOOLS_SEEN)
      // The record is of 0.161.0 alone: the next Codex version is closed again until its own test.
      stub('codex', 'echo "codex-cli 0.162.0"')
      expect((await load(true)).researchers.filter((agent) => agent.ok).map((agent) => agent.id)).toEqual(['opus'])
    })

    it('says in words how a fence test that failed, showed nothing or could not run ended', async () => {
      const failed = passed(['gpt-6-luna'], { verdict: 'fail' })
      failed.models[0] = { model: 'gpt-6-luna', verdict: 'fail', tools: [], reasons: ['reached the provider: the Codex rules file'] }
      expect(fenceEndedWords(failed)).toBe('The fence test of Codex 0.161.0 failed: gpt-6-luna: reached the provider: the Codex rules file. No Codex agent is offered as a researcher.')
      expect(fenceEndedWords({ verdict: 'inconclusive', version: null, models: [], reasons: ['codex is not installed or did not answer --version'] }))
        .toBe('The fence test of Codex showed nothing: codex is not installed or did not answer --version. No Codex agent is offered as a researcher.')
      fenceTest = async () => { throw new Error('no folder to test in') }
      await call<ResearchSnapshot>('research:fence-test')
      expect((await tested()).fenceTest.ended).toEqual({ ok: false, text: 'The fence test could not run: no folder to test in' })
    })
  })

  it('says how a research ended in words', () => {
    expect(researchEndedWords({ state: 'complete', models: 1 })).toBe('Research found 1 model.')
    expect(researchEndedWords({ state: 'partial', models: 3, note: 'Ended at the 20-minute limit.' })).toBe('Research kept 3 models. Ended at the 20-minute limit.')
    expect(researchEndedWords({ state: 'stopped', models: 0, note: 'Stopped before it finished.' })).toBe('Stopped before it finished. Nothing was kept.')
    expect(researchEndedWords({ state: 'failed', models: 0, note: 'BMN did not start the run: sonnet is proposed, not approved as active' })).toBe('Research failed: BMN did not start the run: sonnet is proposed, not approved as active')
  })
})

describe('web questions on Team › Models (64.3)', () => {
  const USES = 'https://docs.example.org/jev/uses'
  const GONE = 'https://gone.example.org/jev'
  const QUESTION = 'How do people use the Jev 1.13 model, according to public pages?'
  const ANSWER = { version: 1, answer: 'People use Jev mostly to route requests by intent.', claims: [
    { claim: 'Jev is used for intent routing.', source: USES, passage: 'Teams use Jev for intent routing: "Which team should handle this?"' },
    { claim: 'A vendor page lists four patterns.', source: GONE, passage: 'four patterns: speculative fan-out' }
  ], not_found: ['an independent accuracy measurement'] }
  /** A stand-in Claude Code that answers every prompt with plan.json's text, after its delay. */
  const researcher = (): void => {
    writeFileSync(join(stubs, 'claude'), `#!${process.execPath}
const fs = require('node:fs')
const home = process.env.HOME
if (process.argv[2] === '--version') { console.log('2.1.295 (Claude Code)'); process.exit(0) }
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(home + '/calls.log', JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\\n')
const plan = JSON.parse(fs.readFileSync(home + '/plan.json', 'utf8'))
setTimeout(() => console.log(JSON.stringify({ type: 'result', is_error: false, result: plan.text })), plan.delay ?? 0)
`)
    chmodSync(join(stubs, 'claude'), 0o755)
  }
  const plan = (delay = 0): void => writeFileSync(join(home, 'plan.json'), JSON.stringify({ text: JSON.stringify(ANSWER), delay }))
  const calls = (): { argv: string[]; prompt: string }[] =>
    (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
  const load = (): Promise<WebQuestionsSnapshot> => call('questions:load')
  const ask = (question = QUESTION): Promise<WebQuestionAsked> => call('questions:ask', { question })
  const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
  const until = async <Value>(read: () => Value | Promise<Value>, done: (value: Value) => boolean, what: string): Promise<Value> => {
    for (let tries = 0; tries < 800; tries += 1) {
      const value = await read()
      if (done(value)) return value
      await pause(25)
    }
    throw new Error(`waited in vain for ${what}`)
  }
  const idle = (): Promise<WebQuestionsSnapshot> => until(load, (state) => state.holder === null, 'the question to end')
  /** `bmn research ask` in a process of its own, as an agent in a session's shell runs it. */
  const fromShell = (extra: Record<string, string> = {}): ReturnType<typeof spawn> => {
    const child = spawn(process.execPath, [SCRIPT, 'research', 'ask', '--json'], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin!.end(QUESTION)
    return child
  }
  const exited = (child: ReturnType<typeof spawn>): Promise<number | null> => new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  })

  beforeEach(async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
    researcher()
    researchFetch = async (address) => (address === USES ? { ok: true, text: '<p>Teams use Jev for intent routing: &ldquo;Which team should handle this?&rdquo;</p>' } : { ok: false, reason: 'the site answered 404' })
  })

  it('reads as nothing asked, the switch on and the limits, before any question', async () => {
    expect(await load()).toEqual({ questions: [], holder: null, agentsMayAsk: true, today: 0, limits: { perDay: 20, minutes: 10, characters: 2000, kept: 200 } })
  })

  it('asks the owner\'s question by the command\'s own route: shown running with who asked, then answered with each claim\'s mark', async () => {
    plan(400)
    const asked = await ask()
    expect(asked).toMatchObject({ ok: true, message: null })
    expect(asked.snapshot.holder).toMatchObject({ kind: 'question', by: { kind: 'owner' }, researcher: 'Opus' })
    expect(asked.snapshot.questions).toMatchObject([{ id: asked.snapshot.holder!.id, by: { kind: 'owner' }, researcher: 'Opus', question: QUESTION, outcome: 'running' }])
    const state = await idle()
    expect(state.today).toBe(1)
    expect(state.questions).toHaveLength(1)
    expect(state.questions[0]).toMatchObject({
      by: { kind: 'owner' }, researcher: 'Opus', question: QUESTION, outcome: 'answered', answer: ANSWER.answer, notFound: ANSWER.not_found,
      claims: [{ claim: 'Jev is used for intent routing.', source: USES, mark: 'passage found on the page' }, { source: GONE, mark: 'page not readable', why: 'the site answered 404' }],
      counts: { found: 1, not_found: 0, unreadable: 1 }
    })
    expect(typeof state.questions[0]!.tookMs).toBe('number')
    // The run was a research run: the fixed frame and the question, the web tools and nothing else.
    expect(calls()).toHaveLength(1)
    expect(calls()[0]!.prompt.endsWith(`${QUESTION}\n`)).toBe(true)
    expect(calls()[0]!.argv[calls()[0]!.argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
  })

  it('shows a refusal in the command\'s own words, starts nothing, and keeps no text it refused for what it held', async () => {
    plan()
    const key = `sk-${'a1B2c3D4'.repeat(5)}`
    expect(await ask('   ')).toMatchObject({ ok: false, message: expect.stringContaining('empty') })
    expect(await ask('x '.repeat(1200))).toMatchObject({ ok: false, message: expect.stringContaining('longer than 2000 characters') })
    const secret = await ask(`Is ${key} a valid key?`)
    expect(secret).toMatchObject({ ok: false, message: expect.stringMatching(/word 2 of the question looks like a key or a password/) })
    const pathed = await ask('What is in ~/notes on a default install?')
    expect(pathed).toMatchObject({ ok: false, message: expect.stringContaining('home folder') })
    expect(JSON.stringify([secret, pathed, await load()])).not.toContain(key)
    expect((await load()).questions.map((entry) => [entry.outcome, entry.question])).toEqual([['refused', null], ['refused', null], ['refused', null], ['refused', null]])
    expect((await load()).today).toBe(0)
    expect(calls()).toEqual([])
    await expect(call('questions:ask', { question: 7 })).rejects.toThrow(/question must be text/)
  })

  it('holds Models research off while a question runs, saying why, and the other way round', async () => {
    plan(600)
    expect(await ask()).toMatchObject({ ok: true })
    const refused = await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    expect(refused.running).toBeNull()
    expect(refused.ended).toEqual({ ok: false, text: 'A web question is running, so this research did not start. Wait for it to end, or stop it.', kept: false })
    expect(await call<ResearchLookup>('research:lookup', { researcher: 'fable', provider: 'anthropic', model: 'claude-opus-5-6' }))
      .toEqual({ ok: false, message: 'A web question is running. Wait for it to end, or stop it.', model: null })
    // A second question is refused too, never queued.
    expect(await ask()).toMatchObject({ ok: false, message: expect.stringContaining('a research is running (a web question)') })
    await idle()
    expect(calls()).toHaveLength(1)
    // A research that is going refuses a question in the command's words.
    plan(600)
    const started = await call<ResearchSnapshot>('research:start', { researcher: 'fable' })
    expect(started.running).toMatchObject({ researcher: 'fable' })
    expect((await load()).holder).toMatchObject({ kind: 'research', researcher: 'Fable' })
    expect(await ask()).toMatchObject({ ok: false, message: expect.stringContaining('a research is running (Models research)') })
    await call('questions:stop')
    await until(() => call<ResearchSnapshot>('research:load', { fresh: false }), (state) => state.running === null, 'the research to end')
    expect((await load()).holder).toBeNull()
  })

  it('Stop ends a question whoever started it: the owner\'s own, and one an agent asked from a shell', async () => {
    plan(20_000)
    expect(await ask()).toMatchObject({ ok: true })
    await until(calls, (all) => all.length === 1, 'the researcher to start')
    await call('questions:stop')
    expect((await idle()).questions[0]).toMatchObject({ outcome: 'stopped', by: { kind: 'owner' } })
    // Another process asks, as an agent does in a session's shell; this window has no switch of its own for it.
    const child = fromShell({ BMN_SESSION_ID: 'session-7', CLAUDECODE: '1' })
    try {
      const running = await until(load, (state) => state.holder?.kind === 'question' && state.questions[0]?.outcome === 'running', 'the shell\'s question to run')
      expect(running.holder).toMatchObject({ by: { kind: 'session', session: 'session-7', app: 'claude' }, researcher: 'Opus' })
      expect(running.questions[0]).toMatchObject({ by: { kind: 'session', session: 'session-7', app: 'claude' }, outcome: 'running', question: QUESTION })
      await until(calls, (all) => all.length === 2, 'the researcher to start again')
      await call('questions:stop')
      expect(await exited(child)).toBe(1)
    } finally {
      child.kill('SIGKILL')
    }
    const after = await load()
    expect(after.holder).toBeNull()
    expect(after.questions.map((entry) => [entry.by.kind, entry.outcome])).toEqual([['session', 'stopped'], ['owner', 'stopped']])
  })

  it('Stop signals nothing but BMN\'s own question command: a lock another program holds is left alone', async () => {
    const other = spawn(process.execPath, ['--input-type=module', '-e', `
      import { takeResearchLock } from ${JSON.stringify(fileURLToPath(new URL('../../bin/agents-research.mjs', import.meta.url)))}
      takeResearchLock({ kind: 'question', id: 'not-the-command', at: new Date().toISOString(), researcher: 'opus', by: { kind: 'shell' } })
      process.on('SIGINT', () => { console.log('signalled'); process.exit(3) })
      console.log('held')
      setInterval(() => {}, 1000)
    `], { env: { HOME: home, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'inherit'] })
    let printed = ''
    other.stdout!.on('data', (chunk: Buffer) => { printed += String(chunk) })
    try {
      await until(() => printed, (text) => text.includes('held'), 'the other program to hold the lock')
      expect((await load()).holder).toMatchObject({ kind: 'question', id: 'not-the-command' })
      await call('questions:stop')
      await pause(300)
      expect(other.exitCode).toBeNull()
      expect(printed).not.toContain('signalled')
    } finally {
      other.kill('SIGKILL')
    }
  })

  it('the switch off refuses an agent\'s question and not the owner\'s own', async () => {
    plan()
    expect(await call<WebQuestionsSnapshot>('questions:allow', { on: false })).toMatchObject({ agentsMayAsk: false })
    const child = fromShell({ BMN_SESSION_ID: 'session-7' })
    let printed = ''
    child.stdout!.on('data', (chunk: Buffer) => { printed += String(chunk) })
    expect(await exited(child)).toBe(10)
    expect(JSON.parse(printed)).toMatchObject({ ok: false, outcome: 'refused', code: 'ASKING_OFF', message: expect.stringContaining('ask the owner') })
    expect(calls()).toEqual([])
    expect(await ask()).toMatchObject({ ok: true })
    expect((await idle()).questions.map((entry) => [entry.by.kind, entry.outcome])).toEqual([['owner', 'answered'], ['session', 'refused']])
    expect(await call<WebQuestionsSnapshot>('questions:allow', { on: true })).toMatchObject({ agentsMayAsk: true })
    await expect(call('questions:allow', { on: 'yes' })).rejects.toThrow(/on must be true or false/)
  })

  it('opens a claim\'s page in the browser by the claim\'s place in the kept record, and only an https page', async () => {
    plan()
    await ask()
    const [kept] = (await idle()).questions
    expect(await call('questions:open-page', { id: kept!.id, claim: 0 })).toEqual({ opened: true })
    expect(openedInBrowser).toEqual([USES])
    // No such claim, no such question, or an address in the file that is not an https page: nothing is opened.
    expect(await call('questions:open-page', { id: kept!.id, claim: 7 })).toEqual({ opened: false })
    expect(await call('questions:open-page', { id: 'no-such-question', claim: 0 })).toEqual({ opened: false })
    const file = join(home, '.config/bmn/agents/state/research/questions.json')
    // Nor is an address of this machine or a local network: a researcher's answer never sends his browser there.
    const local = ['https://192.168.1.1/admin', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/x', 'https://printer.local/', 'https://router/', 'https://wiki.internal/page']
    // Nor a public-looking name that leads to his own network, or to nowhere, when BMN looks it up at that moment.
    local.push('https://intranet.example.org/wiki', 'https://unknown.example.org/')
    for (const address of ['file:///etc/passwd', 'http://docs.example.org/jev', 'javascript:alert(1)', 'https://user:word@docs.example.org/', 'not an address', ...local]) {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      stored.questions[0].claims[0].source = address
      writeFileSync(file, JSON.stringify(stored))
      expect(await call('questions:open-page', { id: kept!.id, claim: 0 })).toEqual({ opened: false })
    }
    expect(openedInBrowser).toEqual([USES])
    await expect(call('questions:open-page', { id: kept!.id, claim: -1 })).rejects.toThrow(/claim must be/)
    await expect(call('questions:open-page', { id: kept!.id, claim: 'https://evil.example.org/' })).rejects.toThrow(/claim must be/)
  })

  it('removes one record or all with its text, and gives no question of the day back', async () => {
    plan()
    await ask()
    await idle()
    await ask('What is a context window, in one sentence from a public page?')
    const two = await idle()
    expect(two.questions).toHaveLength(2)
    const kept = join(home, '.config/bmn/agents/state/research/questions.json')
    const one = await call<WebQuestionsSnapshot>('questions:remove', { id: two.questions[0]!.id })
    expect(one.questions.map((entry) => entry.question)).toEqual([QUESTION])
    expect(readFileSync(kept, 'utf8')).not.toContain('context window')
    const none = await call<WebQuestionsSnapshot>('questions:remove', { id: null })
    expect(none).toMatchObject({ questions: [], today: 2 })
    expect(readFileSync(kept, 'utf8')).not.toContain('Jev')
    await expect(call('questions:remove', { id: 5 })).rejects.toThrow(/id must be a question id or null/)
  })
})

describe('read-only roles through Team and Health (63.2 AC4)', () => {
  it('holds none in a team from before the mark, says so on Health, and holds them once the owner approves the proposal', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    await call<AgentsOutcome>('agents:approve', { shown: await shown() })
    const proposed = ['focused-reviewer', 'pre-reviewer', 'epic-reviewer', 'project-pre-reviewer', 'final-reviewer', 'consultant']
    expect((await call<RulesSnapshot>('rules:snapshot')).readOnlyRoles).toEqual({ held: [], proposed })
    // The proposal as Team stages it: the mark on each proposed role, previewed with what it would change, then approved.
    const state = await snapshot()
    const data = state.file.data as RosterDataShape
    const staged: RosterDataShape = { ...data, roles: data.roles.map((role) => (proposed.includes(role.id) ? { ...role, read_only: true } : role)) }
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: staged } })
    expect(preview.valid).toBe(true)
    expect(preview.differences.map((diff) => `${diff.scope}:${diff.id}:${diff.field}`)).toEqual(proposed.map((id) => `roles:${id}:read_only`))
    expect(preview.consequences).toEqual(proposed.map((id) => `${id} runs would be refused unless they are started so that they cannot write`))
    expect((await call<RulesSnapshot>('rules:snapshot')).readOnlyRoles?.held).toEqual([])
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: staged, teamUpdate: bindings(preview) })).toMatchObject({ ok: true })
    expect(readFileSync(rosterFile(), 'utf8')).toContain('consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked, read_only: true}')
    expect((await call<RulesSnapshot>('rules:snapshot')).readOnlyRoles).toEqual({ held: proposed, proposed: [] })
    // One role freed again: the file loses the mark, and the consequence says what the check then lets through.
    const held = (await snapshot()).file.data as RosterDataShape
    const freed: RosterDataShape = { ...held, roles: held.roles.map(({ read_only: was, ...role }) => (role.id === 'consultant' || was !== true ? role : { ...role, read_only: true })) }
    expect((await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: freed } })).consequences).toEqual(['consultant runs could be started with write access again'])
  })

  it('reports no roles where no team is approved', async () => {
    expect((await call<RulesSnapshot>('rules:snapshot')).readOnlyRoles).toBeNull()
  })
})

describe('the judge on Team: BMN\'s proposal, its calls, the monthly limit and Try it (65.1 AC7, 65.3 AC1-AC2)', () => {
  const HOST = 'gateway.example.test'
  const PLANTED_KEY = 'sk-synthetic-PLANTED-ipc-0123456789'
  let server: Server
  let requests: Array<{ path: string; body: string; authorization: string | undefined }>
  let respond: (response: ServerResponse) => void
  const answer = (noul: number): string => JSON.stringify({ answers: { statement: { type: 'noul', noul } }, usage: { input_tokens: 400 } })
  const load = (): Promise<JudgeView> => call('judge:load')
  const tryIt = (data: 'public' | 'private' = 'private', text = 'All 12 tests passed.', statement = 'The text says the tests passed.'): Promise<JudgeTried> => call('judge:try', { text, statement, data })
  /** The example team with a judge whose gateway is the stand-in server's name. */
  const teamWithJudge = (runs = 'allowed'): string => {
    const once = (text: string, from: string, to: string): string => {
      if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
      return text.replace(from, to)
    }
    let text = once(EXAMPLE, 'schema_version: 2', 'schema_version: 3')
    text = once(text, 'cursor: {name: Cursor, hosts: [], private_work: public_only}\n',
      `cursor: {name: Cursor, hosts: [], private_work: public_only}\ngateway: {name: Gateway, hosts: [${HOST}], private_work: allowed}\nmaker: {name: Maker, hosts: [], private_work: ${runs}}\n`)
    text = once(text, '## roles\n', `## jev\n\n\`\`\`yaml\n${[
      'name: Jev', 'class: bishop', 'harness: bmn', 'model: jev-1.13', 'provider: gateway', 'run_by: maker', `host: ${HOST}`, 'enabled: true', 'status: active', 'roles: [judge]',
      'paid_by: per_token', 'price: {input: 0.042, output: 0, source: "https://prices.example.test/jev", as_of: 2026-10-12}'
    ].join('\n')}\n\`\`\`\n\n## roles\n`)
    return once(text, 'consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}\n',
      'consultant: {candidates: [astra@medium|high, fable@medium|high], then: blocked}\njudge: {description: answers typed questions about a text with numbers; advice only, candidates: [jev], then: skip}\n')
  }
  const approveFile = async (text: string): Promise<void> => {
    writeFileSync(rosterFile(), text)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
  }

  beforeEach(async () => {
    requests = []
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(answer(0.97))
    }
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization })
        respond(response)
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    judgeTestPort = String((server.address() as AddressInfo).port)
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: PLANTED_KEY } }))
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('BMN\'s proposal is staged, previewed with its consequences and approved like every team change', async () => {
    await approveFile(EXAMPLE)
    const state = await snapshot()
    const proposed = judgeProposal(state.file.data as never) as unknown as RosterDataShape
    expect(proposed.agents.at(-1)).toMatchObject({ id: 'jev', harness: 'bmn', provider: 'opencode-zen', run_by: 'typesafe' })
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: proposed } })
    expect(preview.errors).toEqual([])
    // Until he approves it nothing can be asked.
    expect((await tryIt()).reply).toMatchObject({ outcome: 'refused', code: 'NO_JUDGE' })
    expect(requests).toHaveLength(0)
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: proposed, teamUpdate: bindings(preview) })).toMatchObject({ ok: true })
    const after = await snapshot()
    expect(after.approved?.data.schema_version).toBe(3)
    expect(after.approved?.data.agents.at(-1)).toMatchObject({ id: 'jev', name: 'Jev', class: 'bishop', harness: 'bmn', model: 'jev-1.13', status: 'active', efforts: [], roles: ['judge'] })
    expect(after.approved?.data.roles.at(-1)).toMatchObject({ id: 'judge', candidates: ['jev'] })
    expect(file('.config/bmn/agents/roster.md')).toContain('harness: bmn')
    expect(after.file.errors).toEqual([])
  })

  it('reads as no calls and no limit before anything was asked', async () => {
    await approveFile(teamWithJudge())
    const view = await load()
    expect(view).toMatchObject({ limit: { on: false, usd: 1 }, reached: false, calls: [], current: { calls: 0, input_tokens: 0, cost_usd: 0, refused: 0, purposes: {} }, previous: { calls: 0 } })
    expect(view.current.month).toMatch(/^\d{4}-\d{2}$/)
  })

  it('Try it asks one statement by the command\'s own route and is counted like every call', async () => {
    await approveFile(teamWithJudge())
    const tried = await tryIt()
    expect(tried.reply).toEqual({ outcome: 'answered', noul: 0.97, reading: 'yes', near: false, input_tokens: 400, cost_usd: 0.0000168, took_ms: expect.any(Number), counted: 'yes', estimated: false })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: '/zen/v1/systemone', authorization: `Bearer ${PLANTED_KEY}` })
    expect(JSON.parse(requests[0]!.body)).toEqual({ model: 'jev-1.13', state: 'All 12 tests passed.', questions: { statement: { type: 'noul', instructions: 'The text says the tests passed.' } } })
    expect(tried.view.calls).toEqual([{ at: expect.any(String), by: { kind: 'owner' }, purpose: 'try-it', outcome: 'answered' }])
    expect(tried.view.current).toMatchObject({ calls: 1, input_tokens: 400, purposes: { 'try-it': { calls: 1, input_tokens: 400 } } })
    expect(JSON.stringify(tried)).not.toContain(PLANTED_KEY)
    // A number under the line reads no answer, and one beside the line says so.
    respond = (response) => response.end(answer(0.41))
    expect((await tryIt()).reply).toMatchObject({ outcome: 'answered', noul: 0.41, reading: 'no answer', near: false })
    respond = (response) => response.end(answer(0.89))
    expect((await tryIt()).reply).toMatchObject({ outcome: 'answered', reading: 'no answer', near: true })
  })

  it('is refused by the same rules: private text while a provider gets public work only, and a text too long', async () => {
    await approveFile(teamWithJudge('public_only'))
    const refused = await tryIt('private')
    expect(refused.reply).toMatchObject({ outcome: 'refused', code: 'PRIVATE_NOT_ALLOWED', message: expect.stringContaining('Maker gets public work only'), next: expect.any(String) })
    expect(requests).toHaveLength(0)
    expect(refused.view.calls).toMatchObject([{ outcome: 'refused', code: 'PRIVATE_NOT_ALLOWED', purpose: 'try-it' }])
    expect(refused.view.current).toMatchObject({ calls: 0, refused: 1 })
    // Text he says is public goes.
    expect((await tryIt('public')).reply).toMatchObject({ outcome: 'answered' })
    expect((await tryIt('public', 'x'.repeat(30_000))).reply).toMatchObject({ outcome: 'refused', code: 'TOO_LARGE' })
    await expect(call('judge:try', { text: 'a', statement: 'b', data: 'secret' })).rejects.toThrow(/data must be public or private/)
    await expect(call('judge:try', { text: 7, statement: 'b', data: 'public' })).rejects.toThrow(/text must be text/)
  })

  it('says what it could not count: an estimate where the gateway gave no count, "not counted" where the record could not be written, and a record that cannot be read (65.2 AC7)', async () => {
    await approveFile(teamWithJudge())
    // An answer with no count of tokens: counted by the size of the request, and said so.
    respond = (response) => response.end(JSON.stringify({ answers: { statement: { type: 'noul', noul: 0.97 } } }))
    const guessed = await tryIt()
    const tokens = Buffer.byteLength(requests[0]!.body) + 256
    expect(guessed.reply).toMatchObject({ outcome: 'answered', counted: 'yes', estimated: true, input_tokens: tokens, cost_usd: expect.closeTo((tokens * 0.042) / 1e6, 12) })
    expect(guessed.view.current).toMatchObject({ calls: 1, input_tokens: tokens, estimated: 1 })
    expect(guessed.view.unreadable).toBeUndefined()
    // The record's folder cannot be written: the answer still comes, and nothing says it was counted.
    const folder = join(home, '.config/bmn/agents/state/judge')
    chmodSync(folder, 0o500)
    try {
      const lost = await tryIt()
      expect(lost.reply).toMatchObject({ outcome: 'answered', noul: 0.97, counted: 'no' })
      expect(lost.view.current).toMatchObject({ calls: 1 })
    } finally {
      chmodSync(folder, 0o700)
    }
    // The record is there and cannot be read: the page says where it is, and Try it is refused before any request.
    const before = requests.length
    writeFileSync(join(folder, 'calls.json'), '{"version":1,"calls":')
    const view = await load()
    expect(view).toMatchObject({ unreadable: '~/.config/bmn/agents/state/judge/calls.json', reached: false, calls: [], current: { calls: 0 } })
    const refused = await tryIt()
    expect(refused.reply).toMatchObject({ outcome: 'refused', code: 'RECORD_UNREADABLE', message: expect.stringContaining('calls.json'), next: expect.stringContaining('moves it away') })
    expect(requests).toHaveLength(before)
    expect(readFileSync(join(folder, 'calls.json'), 'utf8')).toBe('{"version":1,"calls":')
    // A waiting line that is cut short is named by its own path.
    rmSync(join(folder, 'calls.json'))
    mkdirSync(join(folder, 'waiting'), { recursive: true })
    writeFileSync(join(folder, 'waiting/aaaaaaaa-0000-4000-8000-000000000001.json'), '{"version":1,"li')
    expect(await load()).toMatchObject({ unreadable: '~/.config/bmn/agents/state/judge/waiting/aaaaaaaa-0000-4000-8000-000000000001.json', calls: [], reached: false })
    expect((await tryIt()).reply).toMatchObject({ outcome: 'refused', code: 'RECORD_UNREADABLE' })
    rmSync(join(folder, 'waiting'), { recursive: true })
    // The record stops being readable while Try it's call is out: the answer comes, and it is said to wait beside the record.
    respond = (response) => {
      writeFileSync(join(folder, 'calls.json'), '{"version":1,"calls":')
      response.end(answer(0.97))
    }
    const waits = await tryIt()
    expect(waits.reply).toMatchObject({ outcome: 'answered', counted: 'waiting' })
    expect(waits.view.unreadable).toBe('~/.config/bmn/agents/state/judge/calls.json')
    rmSync(join(folder, 'calls.json'))
    respond = (response) => response.end(answer(0.97))
    expect((await load()).current).toMatchObject({ calls: 1 })
    // The limit's own setting cannot be read: the sums still show, the limit is not said to be off by his choice, and nothing is asked until he sets it.
    writeFileSync(join(folder, 'settings.json'), '{"version":1,"limit":{"on":"yes","usd":1}}')
    const unset = await load()
    expect(unset).toMatchObject({ limitUnreadable: '~/.config/bmn/agents/state/judge/settings.json', reached: false, current: { calls: 1 } })
    expect(unset.unreadable).toBeUndefined()
    const asked = requests.length
    expect((await tryIt()).reply).toMatchObject({ outcome: 'refused', code: 'LIMIT_UNREADABLE', message: expect.stringContaining('settings.json') })
    expect(requests).toHaveLength(asked)
    expect(readFileSync(join(folder, 'settings.json'), 'utf8')).toBe('{"version":1,"limit":{"on":"yes","usd":1}}')
    const set = await call<JudgeView>('judge:limit', { on: false, usd: 1 })
    expect(set.limitUnreadable).toBeUndefined()
    expect((await tryIt()).reply).toMatchObject({ outcome: 'answered', counted: 'yes' })
  })

  it('a failed request, a late answer and a wrong shape read no answer, in BMN\'s own words', async () => {
    await approveFile(teamWithJudge())
    respond = (response) => {
      response.writeHead(401)
      response.end(`{"error":"bad key ${PLANTED_KEY}"}`)
    }
    const failed = await tryIt()
    expect(failed.reply).toEqual({ outcome: 'failed', note: 'the approved host answered 401' })
    respond = (response) => response.end('<html>')
    expect((await tryIt()).reply).toMatchObject({ outcome: 'shape' })
    expect(JSON.stringify(await load())).not.toContain(PLANTED_KEY)
    expect((await load()).calls.map((entry) => entry.outcome)).toEqual(['shape', 'failed'])
  })

  it('the monthly limit is off by default; switched on and reached, it stops Try it and a call from a shell alike', async () => {
    await approveFile(teamWithJudge())
    expect((await tryIt()).reply).toMatchObject({ outcome: 'answered' })
    const limited = await call<JudgeView>('judge:limit', { on: true, usd: 0.00001 })
    expect(limited).toMatchObject({ limit: { on: true, usd: 0.00001 }, reached: true })
    requests = []
    expect((await tryIt()).reply).toMatchObject({ outcome: 'refused', code: 'LIMIT_REACHED', message: expect.stringContaining('asking is stopped until next month or a higher limit') })
    // The same file holds for the command in a process of its own.
    writeFileSync(join(home, 'state.txt'), 'A text.')
    writeFileSync(join(home, 'questions.json'), JSON.stringify({ q: { type: 'noul', instructions: 'It is a text.' } }))
    const shell = spawn(process.execPath, [SCRIPT, 'judge', 'ask', '--state-file', join(home, 'state.txt'), '--questions-file', join(home, 'questions.json'), '--data', 'public', '--purpose', 'dev-auto', '--json'],
      { env: { HOME: home, PATH: '/usr/bin:/bin', BMN_SESSION_ID: 'synthetic-session', BMN_JUDGE_TEST_PORT: judgeTestPort ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    shell.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    expect(await new Promise((resolve) => { shell.once('exit', resolve) })).toBe(10)
    expect(JSON.parse(out)).toMatchObject({ outcome: 'refused', code: 'LIMIT_REACHED' })
    expect(requests).toHaveLength(0)
    const view = await load()
    expect(view.calls.slice(0, 2)).toMatchObject([
      { by: { kind: 'session', session: 'synthetic-session' }, purpose: 'dev-auto', outcome: 'refused', code: 'LIMIT_REACHED' },
      { by: { kind: 'owner' }, purpose: 'try-it', outcome: 'refused', code: 'LIMIT_REACHED' }
    ])
    // A higher limit, or the switch off, lets the next call through.
    expect(await call<JudgeView>('judge:limit', { on: true, usd: 5 })).toMatchObject({ reached: false })
    expect((await tryIt()).reply).toMatchObject({ outcome: 'answered' })
    await expect(call('judge:limit', { on: true, usd: 0 })).rejects.toThrow(/above 0/)
    await expect(call('judge:limit', { on: 'yes', usd: 1 })).rejects.toThrow(/true or false/)
  })

  it('lists the newest 20 calls only', async () => {
    await approveFile(teamWithJudge())
    for (let asked = 0; asked < 22; asked += 1) await tryIt('public', `Text number ${asked}.`)
    const view = await load()
    expect(view.calls).toHaveLength(20)
    expect(view.current.calls).toBe(22)
    expect(view.calls[0]!.at >= view.calls[19]!.at).toBe(true)
  })
})

/**
 * A team with BMN's proposal of Luna (Go) taken (70.4), as the Team page's `lunaGoProposal` takes it on a team from
 * before the researcher mark (its output is pinned in luna-go-proposal.test.ts): OpenCode Go added where missing, with
 * `privateWork`, and Luna (Go) last in the role helper at her highest effort.
 */
function withLunaGo(data: RosterDataShape, privateWork: 'allowed' | 'public_only' = 'public_only'): RosterDataShape {
  const { provider, agent, role } = LUNA_GO_PROPOSAL
  const providers = data.providers.some((entry) => entry.id === provider.id) ? data.providers : [...data.providers, { ...provider, hosts: [] }]
  return {
    ...data, schema_version: 3,
    providers: providers.map((entry) => (entry.id === provider.id ? { ...entry, private_work: privateWork } : entry)),
    agents: [...data.agents, { ...agent, provider: provider.id, efforts: [...agent.efforts], roles: [role] }],
    roles: data.roles.map((entry) => (entry.id === role ? { ...entry, candidates: [...entry.candidates, `${agent.id}@${agent.efforts.at(-1)}`] } : entry))
  }
}

describe('Luna through OpenCode Go on Team (70.4)', () => {
  const COPIED = { ok: true, copied: true, message: 'BMN copied your OpenCode Go sign-in into its own OpenCode folder' }
  const kinds = (kind: string) => openCodeGo.calls.filter((entry) => entry.kind === kind)
  /** The team in the file approved, then BMN's proposal of Luna (Go) taken and approved as the page does it. */
  const approveProposal = async (): Promise<AgentsOutcome> => {
    writeFileSync(rosterFile(), EXAMPLE)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).toMatchObject({ ok: true })
    const state = await snapshot()
    const proposed = withLunaGo(state.approved?.data as RosterDataShape)
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: proposed } })
    expect(preview.errors).toEqual([])
    // Nothing is copied before he approves.
    expect(kinds('copy')).toEqual([])
    return call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: proposed, teamUpdate: bindings(preview) })
  }

  it('asks OpenCode about her with the owner\'s environment, and copies nothing for a team that names no agent on OpenCode Go', async () => {
    writeFileSync(rosterFile(), EXAMPLE)
    expect(await call<AgentsOutcome>('agents:approve', { shown: await shown() })).not.toHaveProperty('openCodeSignIn')
    openCodeGo.listed = true
    expect(await call<OpenCodeGoView>('agents:opencode-go')).toEqual({ listed: true, signedIn: null, reason: null })
    expect(openCodeGo.calls).toEqual([{ kind: 'lists', home }])
    // A yes holds while BMN runs; a no is asked again.
    await call('agents:opencode-go')
    expect(kinds('lists')).toHaveLength(1)
    expect((await call<OpenCodeGoView>('agents:opencode-go', { copy: true })).copy).toEqual({ ok: false, copied: false, message: 'The approved team names no agent on OpenCode Go, so BMN copies no sign-in' })
    expect(kinds('copy')).toEqual([])
  })

  it('copies the Go sign-in when he approves Luna (Go), says so with the approval, and copies once', async () => {
    openCodeGo.copy = COPIED
    const saved = await approveProposal()
    expect(saved).toMatchObject({ ok: true, openCodeSignIn: COPIED })
    expect(saved.snapshot.approved?.data.agents.at(-1)).toMatchObject({ id: 'luna-go', harness: 'opencode', provider: 'opencode-go', model: 'gpt-6-luna', roles: ['helper'] })
    expect(kinds('copy')).toEqual([{ kind: 'copy', home }])
    // A later approval copies nothing again, and the page reads the folder as signed in without asking OpenCode.
    const state = await snapshot()
    const approved = state.approved?.data as RosterDataShape
    const allowed = { ...approved, providers: approved.providers.map((entry) => (entry.id === 'opencode-go' ? { ...entry, private_work: 'allowed' as const } : entry)) }
    const preview = await call<AgentsPreview>('agents:preview', { request: { kind: 'staged', data: allowed } })
    expect(await call<AgentsOutcome>('agents:save', { shown: shownOf(state), data: allowed, teamUpdate: bindings(preview) })).not.toHaveProperty('openCodeSignIn')
    expect(kinds('copy')).toHaveLength(1)
    expect(await call<OpenCodeGoView>('agents:opencode-go')).toMatchObject({ signedIn: true })
    expect(kinds('signedIn')).toEqual([])
  })

  it('says with the approval why the sign-in was not copied, and Copy sign-in tries again', async () => {
    const missing = { ok: false, copied: false, message: 'OpenCode holds no OpenCode Go sign-in on this computer: sign in with `opencode auth login`, then copy it again' }
    openCodeGo.copy = missing
    openCodeGo.signedIn = false
    expect(await approveProposal()).toMatchObject({ ok: true, openCodeSignIn: missing })
    expect(await call<OpenCodeGoView>('agents:opencode-go')).toMatchObject({ signedIn: false })
    expect(kinds('signedIn')).toEqual([{ kind: 'signedIn', home }])
    openCodeGo.copy = COPIED
    expect(await call<OpenCodeGoView>('agents:opencode-go', { copy: true })).toMatchObject({ signedIn: true, copy: COPIED })
    expect(kinds('copy')).toHaveLength(2)
  })

  it('says nothing with an approval where the folder already held the sign-in', async () => {
    const saved = await approveProposal()
    expect(saved).toMatchObject({ ok: true })
    expect(saved).not.toHaveProperty('openCodeSignIn')
    expect(kinds('copy')).toHaveLength(1)
  })
})
