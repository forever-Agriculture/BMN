// MODULE: agents-team-app.test.ts - Story 73.1, 72.9: Agents › Asks reads every ask his agents and the command made: who asked, what was readable and what the teammate's own mode could read, who answered and its sub-agents, the answer with any credential masked, the project's state, the usage and why a run ended as it did, newest first; the owner's Stop of any ask, removal, export and 30-day retention; stand-in apps in BMN's real systemd scope, a synthetic team
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { appAskDetail, appAskExport, appAskRemove, appAskStop, appAsks } from '../../bin/agents-team-app.mjs'
import { teamRunsDirectory } from '../../bin/agents-check.mjs'
import { placePath } from '../../bin/agents-team-places.mjs'
import { processStart } from '../../bin/agents-supervised.mjs'
import { startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { ANSWER_KEY, SCOPES, SIGN_IN_SENTINEL, leftovers as harnessLeftovers, ownSystemd, settle, teamAskHome } from './test-fixtures/team-ask-harness'

const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const savedHome = process.env.HOME
let home: string
let stubs: string
let env: Record<string, string>
const leftovers = (): string[] => harnessLeftovers(home)
const runs = (): string => teamRunsDirectory()
const SESSION = { kind: 'session', session: 'session-made-up-1', app: 'claude' } as const

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-app-'))
})

afterEach(async () => {
  await settle(() => leftovers().length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

/** A made-up file of the asker's to give the teammate. */
const file = (name: string, text: string): string => {
  const path = join(home, 'code/shop/src', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** An ask an agent made, started as the command starts one; `now` sets when it was asked. */
const agentAsk = (question: string, fields: Partial<Parameters<typeof prepareAsk>[0]> = {}, now = new Date()) => {
  const prepared = prepareAsk({ role: 'epic-reviewer', question, askedBy: SESSION, ...fields }, { environment: env, cwd: home, home, now })
  startAsk(prepared, { timeLimitMinutes: 2 })
  return prepared
}

/** `bmn team ask` from a shell, as an agent's command runs it; it ends when the ask ends. */
const commandAsk = (question: string): Promise<{ code: number | null; stderr: string }> => new Promise((done) => {
  const child = spawn(process.execPath, [BMN, 'team', 'ask', '--role', 'epic-reviewer', '--question', question], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...ownSystemd() }, cwd: home, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('exit', (code) => done({ code, stderr }))
})

/** A run's record written by hand, as an older BMN or a refusal leaves it. */
const record = (id: string, request: Record<string, unknown>, outcome: Record<string, unknown> | null, prompt?: string): string => {
  const folder = join(runs(), id)
  mkdirSync(join(folder, 'inputs'), { recursive: true })
  writeFileSync(join(folder, 'request.json'), JSON.stringify({ id, role: 'epic-reviewer', agent: 'astra', effort: 'medium', access: 'question', data: 'private', ...request }))
  if (outcome !== null) writeFileSync(join(folder, 'outcome.json'), JSON.stringify({ version: 1, id, ...outcome }))
  if (prompt !== undefined) writeFileSync(join(folder, 'inputs/prompt.md'), prompt)
  return folder
}

/** A made-up Git project with one commit. */
const project = (): string => {
  const root = join(home, 'code/shop')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/retry.ts'), 'export const retries = 3\n')
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', GIT_AUTHOR_NAME: 'made-up', GIT_AUTHOR_EMAIL: 'made-up@example.invalid', GIT_COMMITTER_NAME: 'made-up', GIT_COMMITTER_EMAIL: 'made-up@example.invalid' } })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'made-up')
  return root
}

describe.skipIf(!SCOPES)('Agents › Asks reads his agents\' asks (73.1)', { timeout: 40_000 }, () => {
  it('lists an agent\'s ask with who asked, what was readable, who answered and its usage; opened, its whole question and the teammate\'s answer', async () => {
    const retry = file('retry.ts', 'export const retries = 3\n')
    const prepared = agentAsk('Is the retry bounded?\nIt loops on 503.', { files: [retry] })
    await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const listed = appAsks()
    expect(listed.asks[0]).toMatchObject({
      id: prepared.id, question: 'Is the retry bounded?', by: SESSION, agent: 'astra', agentName: 'Astra', effort: 'medium', role: 'epic-reviewer', data: 'private',
      reads: { form: 'codex-read-only', scope: 'computer', reach: 'any file your user can read', folder: join(prepared.folder, 'work'), files: 1, pictures: 0 }, state: 'answered',
      usage: { input: 100, cached: 10, output: 5, reasoning: 2, reportedCost: null, complete: true, incompleteReason: null }, timeLimitMinutes: 2
    })
    const line = listed.asks[0]!
    expect(Date.parse(line.keptUntil!) - Date.parse(line.endedAt!)).toBe(30 * 24 * 60 * 60 * 1000)
    expect(listed).not.toHaveProperty('limits')
    const opened = appAskDetail(prepared.id)
    expect(opened).toMatchObject({
      question: 'Is the retry bounded?\nIt loops on 503.', questionWhole: true, files: [{ path: retry, bytes: 25 }], pictures: [], project: null,
      teammate: { app: 'codex', appName: 'Codex', appVersion: '0.162.1', model: 'gpt-6-astra', sessionSource: 'thread.started' }, subagents: [], masked: []
    })
    expect(listed.asks[0]!.reads.words).toMatch(/^Codex's read-only sandbox: any file your user can read/u)
    // With no project, the teammate works in an empty folder of the run's own.
    expect(opened.answer).toBe(`codex answer ${opened.answer!.slice(13, 21)} in ${join(prepared.folder, 'work')}\n`)
    // Nothing of his sign-in is in what the app reads.
    expect(JSON.stringify([listed, opened])).not.toContain(SIGN_IN_SENTINEL)
  })

  it('opens a project ask with where it worked, the project\'s commit and tree at the start and the end, its sub-agent and the answer\'s key masked (72.9 AC5, AC6)', async () => {
    const root = project()
    const prepared = agentAsk('Is the retry bounded? SUBAGENT CREDANSWER', { project: root })
    await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const line = appAsks().asks[0]!
    expect(line).toMatchObject({ state: 'answered', reads: { form: 'codex-read-only', folder: root }, usage: { input: 140, output: 8, complete: true } })
    const opened = appAskDetail(prepared.id)
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    expect(opened.project).toEqual({ root, start: { commit, clean: true, changed: 0, reason: null }, end: { commit, clean: true, changed: 0, reason: null } })
    expect(opened.subagents).toEqual([{ session: 'eeeeeeee-0000-7000-8000-000000000000', name: 'Ada', role: 'explorer', kind: 'Codex sub-agent', model: 'gpt-6-astra', effort: 'low',
      usage: expect.objectContaining({ input: 40, cached: 4, output: 3, reasoning: 1 }), usageNote: null, ownTokens: null }])
    expect(opened.answer).toContain(`in ${root} key [credential masked by BMN: an OpenAI key]`)
    expect(opened.masked).toEqual(['an OpenAI key'])
    expect(JSON.stringify([line, opened])).not.toContain(ANSWER_KEY)
  })

  it('lists the newest first by when each was asked, also within one second, whoever asked', async () => {
    const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000)
    const early = agentAsk('Asked first?', { askedBy: { kind: 'shell' } }, new Date(second.getTime() + 100))
    const late = agentAsk('Asked second?', {}, new Date(second.getTime() + 900))
    for (const prepared of [early, late]) await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(appAsks().asks.map((entry) => [entry.question, entry.by])).toEqual([['Asked second?', SESSION], ['Asked first?', { kind: 'shell' }]])
  })

  it('a running ask from the command holds a place; the owner\'s Stop ends it, and an agent\'s, and neither is removed while it runs', async () => {
    const command = commandAsk('Is it bounded? SLEEP')
    await settle(() => appAsks().asks.some((entry) => entry.state === 'running' && entry.startedAt !== null), 15_000)
    const running = appAsks()
    expect(running.asks[0]).toMatchObject({ question: 'Is it bounded? SLEEP', by: { kind: 'shell' }, state: 'running', endedAt: null, keptUntil: null, now: expect.any(String) })
    expect(running.places.used).toBe(1)
    const id = running.asks[0]!.id
    expect(() => appAskRemove(id)).toThrow(/still running: stop it first/u)
    appAskStop(id)
    expect((await command).code).not.toBe(0)
    expect(appAsks().asks.find((entry) => entry.id === id)).toMatchObject({ state: 'stopped' })
    expect(appAsks().places.used).toBe(0)
    // An agent's ask from its own session is his to stop too.
    const theirs = agentAsk('Is the cache safe? SLEEP')
    await settle(() => appAsks().asks.some((entry) => entry.id === theirs.id && entry.startedAt !== null), 15_000)
    appAskStop(theirs.id)
    await waitAsk(theirs.folder, { timeoutMs: 15_000 })
    expect(appAsks().asks.find((entry) => entry.id === theirs.id)).toMatchObject({ by: SESSION, state: 'stopped' })
  })

  it('removes one ended ask, or every ended one, and exports the allowlisted record with the question, never the app\'s home or a sign-in', async () => {
    const asked = [agentAsk('First?'), agentAsk('Second?')]
    for (const prepared of asked) await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const [one, two] = asked.map((prepared) => prepared.id)
    const into = join(home, 'exports')
    mkdirSync(into)
    const exported = appAskExport(one!, into)
    expect(exported.output).toBe(join(into, `bmn-ask-${one}`))
    expect(exported.files).toEqual(expect.arrayContaining(['request.json', 'question.md', 'answer.md', 'outcome.json', 'inputs/prompt.md']))
    expect(exported.files.some((path) => path.startsWith('home/'))).toBe(false)
    expect(readFileSync(join(exported.output, 'question.md'), 'utf8')).toBe('First?')
    expect(() => appAskExport(one!, into)).toThrow(/already exists/u)
    expect(appAskRemove(one!)).toBe(1)
    expect(appAsks().asks.map((entry) => entry.id)).toEqual([two])
    expect(() => appAskDetail(one!)).toThrow(/no ask/u)
    expect(appAskRemove(null)).toBe(1)
    expect(appAsks().asks).toEqual([])
  })

  it('an ask is kept 30 days after it ended: the list read later removes it', async () => {
    const prepared = agentAsk('Kept?')
    await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const ended = Date.parse(appAsks().asks[0]!.endedAt!)
    expect(appAsks({ now: new Date(ended + 29 * 24 * 60 * 60 * 1000) }).asks).toHaveLength(1)
    expect(appAsks({ now: new Date(ended + 31 * 24 * 60 * 60 * 1000) }).asks).toEqual([])
    expect(existsSync(prepared.folder)).toBe(false)
  })
})

describe('what an ended run\'s record says (73.1 AC2)', () => {
  it('a refused ask says why on its line, in the refusal\'s own words', () => {
    record('20261015T090000-0000000a', { asked_by: SESSION, asked_at: '2026-10-15T09:00:00.000Z' },
      { state: 'refused', exit: 10, refusal: { code: 'CHECK_FAILED', reason: 'the check refused the command: made-up reason' }, ended_at: '2026-10-15T09:00:01.000Z' })
    expect(appAsks().asks[0]).toMatchObject({ state: 'refused', refusalCode: 'CHECK_FAILED', reason: 'the check refused the command: made-up reason', usage: null })
  })

  it('an ask whose asking command ended before its supervisor started is interrupted when the page reads it, and can then be removed (epic review)', () => {
    const id = '20261015T090000-0000000d'
    record(id, { asked_by: SESSION, asked_at: '2026-10-15T09:00:00.000Z' }, null)
    // Its place names the command that reserved it, which has ended: no process has that start.
    mkdirSync(join(runs(), '.places'), { recursive: true })
    writeFileSync(placePath(runs(), id), JSON.stringify({ version: 1, id, holder: { pid: process.pid, start: 'made-up-ended-start' }, reserved_at: '2026-10-15T09:00:00.000Z' }))
    expect(appAsks().asks[0]).toMatchObject({ id, state: 'interrupted', reason: 'the asking command ended before the run started; nothing started, and BMN never starts it again' })
    expect(appAskRemove(id)).toBe(1)
    expect(existsSync(join(runs(), id))).toBe(false)
    // One whose command still lives is left going.
    const going = '20261015T090000-0000000e'
    record(going, { asked_by: SESSION, asked_at: '2026-10-15T09:00:00.000Z' }, null)
    writeFileSync(placePath(runs(), going), JSON.stringify({ version: 1, id: going, holder: { pid: process.pid, start: processStart(process.pid) }, reserved_at: '2026-10-15T09:00:00.000Z' }))
    expect(appAsks().asks.find((line) => line.id === going)).toMatchObject({ state: 'running' })
    expect(existsSync(join(runs(), going, 'outcome.json'))).toBe(false)
  })

  it('a run made before the question had its own record shows its prompt\'s first line, and says only that is known; a not-attributed answer is not shown as the teammate\'s', () => {
    record('20261015T090000-0000000b', { asked_by: { kind: 'shell' }, asked_at: '2026-10-15T09:00:00.000Z' }, { state: 'answered', exit: 0, ended_at: '2026-10-15T09:01:00.000Z' }, 'Older question?\n\n--- file a.ts\n')
    expect(appAskDetail('20261015T090000-0000000b')).toMatchObject({ question: 'Older question?', questionWhole: false })
    const folder = record('20261015T090000-0000000c', { asked_by: SESSION, asked_at: '2026-10-15T09:00:00.000Z' },
      { state: 'not-attributed', exit: 13, reason: 'the events named a second session', ended_at: '2026-10-15T09:01:00.000Z' })
    writeFileSync(join(folder, 'answer.md'), 'Words of another session.')
    expect(appAskDetail('20261015T090000-0000000c')).toMatchObject({ answer: null, line: { state: 'not-attributed', reason: 'the events named a second session' } })
  })
})
