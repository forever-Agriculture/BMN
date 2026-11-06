import { Worker } from 'node:worker_threads'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttentionRecord, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { phoneField } from './quiet-hours-delivery'
import { handoffFinished, leadConversations, linkRunSession, parseFinishedStories, parseHandoff, parseWorktrees, readDevAutoRuns, selectedEpics, worktreeText } from './dev-auto-runs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'bmn-runs-')); roots.push(root); return root
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
function repo(root: string): void {
  mkdirSync(root, { recursive: true }); git(root, 'init', '-qb', 'main')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base')
}
function file(root: string, path: string, text: string): void {
  const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text)
}
function handoff(root: string, branch: string, status = 'ACTIVE'): string {
  return `- Project / selected epics: Fixture; epics 57, 58\n- Owning checkout and branch: ${root} / ${branch}\n- Explicit user stop: none\n## Decisions and findings\n- Decided for you (decisions taken under the owner's delegation, for his review): saved decision\n  - second decision\n- Material pending findings: none\n## Resume\n- Next safe action: test\n- Status: ${status}`
}
const workspace = (root: string): WorkspaceRecord => ({ workspaceId: 'w', name: 'Fixture', defaultCwd: root, archivedAt: null, pinnedFilePaths: [], position: 0, marker: 'none', revision: 1 })

describe('read-only dev-auto runs', () => {
  it('mirrors dev-auto terminal grammar, including duplicate fields and continuation ambiguity', () => {
    for (const value of ['COMPLETE', 'complete — checked', 'COMPLETE. accepted']) expect(handoffFinished(handoff('/r', 'main', value))).toBe(true)
    for (const value of ['COMPLETE pending acceptance', 'COMPLETE\nstill blocked', 'COMPLETE\n- Status: COMPLETE']) expect(handoffFinished(handoff('/r', 'main', value))).toBe(false)
    expect(handoffFinished(handoff('/r', 'main', 'COMPLETE').replace('none', 'none\nstop'))).toBe(false)
    expect(handoffFinished(handoff('/r', 'main', 'COMPLETE') + '\n# afterward')).toBe(false)
  })
  it('parses only recorded fields, clips decisions and selects only development rows', () => {
    const parsed = parseHandoff(handoff('/r', 'main'))
    expect(parsed.decisions).toEqual(['saved decision', 'second decision'])
    expect(parseHandoff('Some prose says COMPLETE').status).toBeNull()
    expect(selectedEpics('BMN; Epics 50–52, source path')).toEqual([50, 51, 52])
    expect(parseWorktrees('worktree /a\0HEAD hash\0branch refs/heads/main\0\0worktree /b\0detached\0\0')).toEqual([
      { checkout: '/a', branch: 'main' }, { checkout: '/b', branch: null }
    ])
  })
  it('reads the run id and each decision\'s entry id and BMN record (session and key); a legacy entry has neither (Story 76.7)', () => {
    const text = (runId: string) => `- Run id: ${runId}\n\n## Decisions and findings\n\n- Decided for you (one line each):\n  - [d1] Keep JSON; reversible (bmn: 62c4ceeb-5f20-456e-936a-41d6fe8645d2/dev-auto:epic-76-1016:d1)\n  - [d12] Reworded by a later lead\n  - Legacy line [d3] (bmn: not at the end) x\n  - [d4] Kept only the key (bmn: dev-auto:epic-76-1016:d4)\n- Material pending findings: none\n`
    const parsed = parseHandoff(text('epic-76-1016'))
    expect(parsed.runId).toBe('epic-76-1016')
    expect(parsed.decisions).toEqual(['[d1] Keep JSON; reversible (bmn: 62c4ceeb-5f20-456e-936a-41d6fe8645d2/dev-auto:epic-76-1016:d1)', '[d12] Reworded by a later lead',
      'Legacy line [d3] (bmn: not at the end) x', '[d4] Kept only the key (bmn: dev-auto:epic-76-1016:d4)'])
    expect(parsed.decisionEntries).toEqual([
      { entry: 'd1', bmnKey: 'dev-auto:epic-76-1016:d1', bmnSession: '62c4ceeb-5f20-456e-936a-41d6fe8645d2' }, { entry: 'd12', bmnKey: null, bmnSession: null },
      { entry: null, bmnKey: null, bmnSession: null }, { entry: 'd4', bmnKey: 'dev-auto:epic-76-1016:d4', bmnSession: null }
    ])
    expect(parseHandoff(text('has spaces')).runId).toBeNull()
    expect(parseHandoff(handoff('/r', 'main'))).toMatchObject({ runId: null, decisionEntries: [{ entry: null, bmnKey: null, bmnSession: null }, { entry: null, bmnKey: null, bmnSession: null }] })
    // The id is read from the field before masking, so a phone-bound reader keeps the identity.
    expect(parseHandoff(text('epic-76-1016'), (value) => value.replace('Keep JSON', '***')).decisionEntries[0])
      .toEqual({ entry: 'd1', bmnKey: 'dev-auto:epic-76-1016:d1', bmnSession: '62c4ceeb-5f20-456e-936a-41d6fe8645d2' })
  })
  it('reads main and two linked trees, flags a copy, keeps legacy ownership unknown, and assigns live requests only to the right checkout', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    const child = join(main, '.claude/worktrees/child'), other = join(root, 'other')
    git(main, 'worktree', 'add', '-qb', 'child', child); git(main, 'worktree', 'add', '-qb', 'other', other)
    file(main, '.dev-auto/handoff.md', handoff(main, 'main', 'COMPLETE'))
    file(child, '.dev-auto/handoff.md', handoff(main, 'main'))
    file(other, '.dev-auto/handoff.md', handoff(other, 'other').replace(`- Owning checkout and branch: ${other} / other\n`, ''))
    file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-57: in-progress\n  57-1-local: review\n')
    const sessions = [{ sessionId: 's', workspaceId: 'w', cwd: other, archivedAt: null, lastProcess: { state: 'live', incarnationId: 'i' } }] as SessionRecord[]
    const attention = [{ requestId: 'a', sessionId: 's', incarnationId: 'i', title: 'Question', state: 'open' },
      { requestId: 'old', sessionId: 's', incarnationId: 'old', title: 'Stale', state: 'open' }] as AttentionRecord[]
    const result = await readDevAutoRuns([workspace(main)], sessions, attention, undefined, undefined, new Map([['s', other]]))
    expect(result.skipped).toBe(0)
    expect(result.runs).toHaveLength(3)
    expect(result.runs.find((run) => run.checkout === main)).toMatchObject({ finished: true, ownerItems: [], ownership: 'own' })
    expect(result.runs.find((run) => run.checkout === child)).toMatchObject({ ownership: 'copy', status: null, ownerItems: [], ownerCheckout: main })
    expect(result.runs.find((run) => run.checkout === other)).toMatchObject({ ownership: 'unknown', ownerItems: [{ requestId: 'a' }], board: { checkout: main, rows: [{ key: 'epic-57' }, { key: '57-1-local' }] } })
    expect(JSON.stringify(result)).not.toContain('Explicit user stop')
  })
  it('bounds unsafe epic IDs in an isolated worker instead of freezing its caller', async () => {
    const code = `const {parentPort}=require('node:worker_threads');const selectedEpics=${selectedEpics.toString()};
      parentPort.postMessage([selectedEpics('Epics 9007199254740992'),selectedEpics('Epics ${'9'.repeat(400)}'),selectedEpics('Epics 1-999999, 4')]);`
    const worker = new Worker(code, { eval: true })
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Epic parser exceeded its worker deadline')), 2000)
        worker.once('message', value => { clearTimeout(timer); resolve(value) })
        worker.once('error', error => { clearTimeout(timer); reject(error) })
      })
      expect(result).toEqual([[], [], Array.from({ length: 100 }, (_, n) => n + 1)])
    } finally { await worker.terminate() }
  })

  it('associates live requests by actual launch evidence after saved directories are edited', async () => {
    const root = fixture(), main = join(root, 'main'), child = join(root, 'child'); repo(main)
    git(main, 'worktree', 'add', '-qb', 'child', child)
    file(main, '.dev-auto/handoff.md', handoff(main, 'main')); file(child, '.dev-auto/handoff.md', handoff(child, 'child'))
    file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-57: in-progress\n')
    const sessions = [{ sessionId: 's', workspaceId: 'w', cwd: child, archivedAt: null, lastProcess: { state: 'live', incarnationId: 'i' } }] as SessionRecord[]
    const attention = [{ requestId: 'a', sessionId: 's', incarnationId: 'i', title: 'Original checkout request', state: 'open' }] as AttentionRecord[]
    const result = await readDevAutoRuns([workspace(main)], sessions, attention, undefined, undefined, new Map([['s', main]]))
    expect(result.runs.find(run => run.checkout === main)?.ownerItems).toEqual([{ sessionId: 's', requestId: 'a', title: 'Original checkout request' }])
    expect(result.runs.find(run => run.checkout === child)?.ownerItems).toEqual([])
    const unrelated = join(root, 'unrelated'); repo(unrelated)
    file(unrelated, '.dev-auto/handoff.md', handoff(unrelated, 'main'))
    const foreign = await readDevAutoRuns([workspace(unrelated)], [{ ...sessions[0]!, cwd: unrelated }], attention, undefined, undefined, new Map([['s', main]]))
    expect(foreign.runs.find(run => run.checkout === main)?.ownerItems.map(item => item.requestId)).toEqual(['a'])
    const unknown = await readDevAutoRuns([workspace(main)], sessions, attention, undefined, undefined, new Map())
    expect(unknown.runs.every(run => run.ownerItems.length === 0)).toBe(true)
    expect(unknown.skipped).toBeGreaterThan(0)
  })

  it('reads a tracked board from the worktree and an untracked configured board from the default checkout', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    file(main, '_bmad/bmm/config.yaml', 'implementation_artifacts: "{project-root}/planning"')
    file(main, 'planning/sprint-status.yaml', 'development_status:\n  epic-57: backlog\n')
    git(main, 'add', '_bmad', 'planning'); git(main, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'board')
    const child = join(root, 'child'); git(main, 'worktree', 'add', '-qb', 'child', child)
    file(child, '.dev-auto/handoff.md', handoff(child, 'child'))
    file(child, 'planning/sprint-status.yaml', 'development_status:\n  epic-57: review\n')
    const result = await readDevAutoRuns([workspace(child)], [], [])
    expect(result.runs[0]!.board).toMatchObject({ checkout: child, rows: [{ status: 'review' }] })
    git(child, 'rm', '--cached', 'planning/sprint-status.yaml')
    expect((await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board).toMatchObject({ checkout: main, rows: [{ status: 'backlog' }] })
  })
  it('reads BMN\'s own plan from the default checkout and a BMAD board of any size, through bmn plan\'s reader (Story 77.1)', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    file(main, '.gitignore', '/plan/\n'); git(main, 'add', '.gitignore'); git(main, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ignore')
    const child = join(root, 'child'); git(main, 'worktree', 'add', '-qb', 'child', child)
    file(child, '.dev-auto/handoff.md', handoff(child, 'child'))
    file(main, 'plan/status.yaml', 'format: bmn-plan\nschema_version: 1\nqueue:\n  - 57\ndevelopment_status:\n  epic-57: ready # go 2026-10-17\r\n  57-1-a: backlog\n  epic-60: done\n')
    expect((await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board).toMatchObject({ checkout: main, unavailable: null, rows: [{ key: 'epic-57', status: 'ready', comment: 'go 2026-10-17' }, { key: '57-1-a' }] })
    rmSync(join(main, 'plan'), { recursive: true })
    const filler = Array.from({ length: 4000 }, (_, index) => `  ${index + 100}-1-filler: done # ${'x'.repeat(150)}`).join('\n')
    file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', `development_status:\n${filler}\n  epic-57: review # last\n`)
    const board = (await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board
    expect(board).toMatchObject({ checkout: main, unavailable: null, rows: [{ key: 'epic-57', status: 'review', comment: 'last' }] })
    file(main, 'plan/status.yaml', 'format: bmn-plan\nschema_version: 1\ndevelopment_status:\n')
    expect((await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board.unavailable).toContain('both plans are present')
  })
  it('refuses BMN\'s own board that is ambiguous anywhere, even outside the run\'s epics, as bmn plan status does (Sol review F7)', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    file(main, '.gitignore', '/plan/\n'); git(main, 'add', '.gitignore'); git(main, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ignore')
    const child = join(root, 'child'); git(main, 'worktree', 'add', '-qb', 'child', child)
    file(child, '.dev-auto/handoff.md', handoff(child, 'child'))
    const board = (rest: string): string => `format: bmn-plan\nschema_version: 1\ndevelopment_status:\n  epic-57: in-progress\n  57-1-a: review\n  epic-60: in-progress\n${rest}`
    const read = async (): Promise<string | null> => (await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board.unavailable
    file(main, 'plan/status.yaml', board('  60-1-first: backlog\n'))
    expect(await read()).toBeNull()
    file(main, 'plan/status.yaml', board('  60-1-first: backlog\n  60-1-again: done\n'))
    expect(await read()).toMatch(/^Board unavailable: .*plan\/status\.yaml:8: 60-1-again is story 60\.1 again/u)
    file(main, 'plan/status.yaml', `${board('  60-1-first: backlog\n')}format: bmn-plan\n`)
    expect(await read()).toMatch(/Board unavailable: .*format/u)
    expect((await readDevAutoRuns([workspace(child)], [], [])).runs[0]!.board.rows).toEqual([])
  })
  it('rejects external symlinks, oversized and binary files, while permitting an internal regular target', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    const external = join(root, 'secret'); writeFileSync(external, 'private')
    symlinkSync(external, join(main, 'link'))
    expect((await worktreeText(main, join(main, 'link'), 64)).unavailable).toContain('outside')
    file(main, 'large', 'x'.repeat(65)); file(main, 'binary', '\0binary'); file(main, 'internal', 'fine')
    expect((await worktreeText(main, join(main, 'large'), 64)).unavailable).toContain('larger')
    expect((await worktreeText(main, join(main, 'binary'), 64)).unavailable).toContain('binary')
    symlinkSync(join(main, 'internal'), join(main, 'local'))
    expect(await worktreeText(main, join(main, 'local'), 64)).toEqual({ text: 'fine', unavailable: null })
  })
  it('counts non-repository directories and discovery overflow rather than claiming an empty complete snapshot', async () => {
    const root = fixture()
    const workspaces = Array.from({ length: 258 }, (_, index) => ({ ...workspace(root), workspaceId: String(index), defaultCwd: join(root, String(index)) }))
    const result = await readDevAutoRuns(workspaces, [], [])
    expect(result.runs).toEqual([]); expect(result.skipped).toBe(258); expect(result.issues.length).toBe(100)
  })
  it('counts worktrees beyond 64 and repositories beyond 32', async () => {
    const root = fixture(), main = join(root, 'repository'); repo(main)
    for (let index = 0; index < 65; index++) git(main, 'worktree', 'add', '-qb', `linked-${index}`, join(root, `linked-${index}`))
    const worktrees = await readDevAutoRuns([workspace(main)], [], [])
    expect(worktrees.skipped).toBe(2)
    expect(worktrees.issues.every((issue) => issue.startsWith('Worktree bound:'))).toBe(true)
    const all = [workspace(main)]
    for (let index = 0; index < 32; index++) {
      const repository = join(root, `repository-${index}`); repo(repository)
      all.push({ ...workspace(repository), workspaceId: `w-${index}` })
    }
    const repositories = await readDevAutoRuns(all, [], [])
    expect(repositories.issues.some((issue) => issue.startsWith('Repository bound:'))).toBe(true)
  }, 20_000)
})


describe('Now: Waiting on, finished stories and the run\'s session (Story 110.9)', () => {
  const lead = '6c3f0f6e-1d0b-4e8a-9a51-2c1e5b7d9f01', resumed = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
  const text = (extra: string): string => `- Project / selected epics: BMN; epics 110\n- Lead host / requested model / observed model: Claude Code ${lead} / opus / opus\n` +
    `## Progress\n- Waiting on: Marta, review\n- Finished stories (one line each, \`N.M STARTED FINISHED\` in UTC, as each is accepted):\n` +
    `  110.1 2026-11-05T15:20:00Z 2026-11-05T16:40:00Z\n  - 110.2 2026-11-05T17:00:00+02:00 2026-11-05T15:30:00Z\n  110.3 later\n` +
    `  110.4 2026-11-05T18:00:00Z 2026-11-05T17:00:00Z\n\n## Measurement\n- Lead sessions: each lead session's ID or transcript path, one per lead or resume:\n` +
    `  - ${lead}\n  - ${resumed.toUpperCase()} (resume)\n${extra}`
  it('reads Waiting on and the stamped finished stories, skipping and counting lines that do not read', () => {
    const parsed = parseHandoff(text(''))
    expect(parsed.waitingOn).toBe('Marta, review')
    expect(parsed.finishedStories).toEqual([
      { story: '110.1', startedAt: '2026-11-05T15:20:00.000Z', finishedAt: '2026-11-05T16:40:00.000Z' },
      { story: '110.2', startedAt: '2026-11-05T15:00:00.000Z', finishedAt: '2026-11-05T15:30:00.000Z' }])
    expect(parsed.skippedFinishedStories).toBe(2)
    for (const nobody of ['nobody', 'Nobody.', 'NOBODY | the person, service or session the run waits for', '']) {
      expect(parseHandoff(text('').replace('Marta, review', nobody)).waitingOn).toBeNull()
    }
  })
  it('reads an older handoff as today: no estimate source, Waits on blank', () => {
    expect(parseHandoff('- Project / selected epics: X\n- Status: ACTIVE')).toMatchObject({ waitingOn: null, finishedStories: [], skippedFinishedStories: 0, leadConversations: [] })
  })
  it('reads at most 100 finished-story lines and counts the rest as skipped', () => {
    const lines = Array.from({ length: 105 }, (_, n) => `  1.${n + 1} 2026-11-05T10:00:00Z 2026-11-05T11:00:00Z`).join('\n')
    const read = parseFinishedStories(`- Finished stories:\n${lines}\n`)
    expect(read.stories).toHaveLength(100)
    expect(read.skipped).toBe(5)
  })
  it('names the lead conversations of Lead host and Lead sessions, in order, once each', () => {
    expect(leadConversations(text(''))).toEqual([lead, resumed])
  })
  it('links a run to the session whose conversation it names, preferring a live one and then the later lead (D14)', () => {
    const at = (id: string, state: 'live' | 'exited', cwd = '/x'): SessionRecord => ({ sessionId: id, workspaceId: 'w', cwd, archivedAt: null,
      lastProcess: { state, incarnationId: `i-${id}`, exitCode: null, signal: null, detail: null } } as SessionRecord)
    const runs = { checkout: '/repo', leadConversations: [lead, resumed] }
    const none = (): string | null => null
    expect(linkRunSession(runs, [at('a', 'exited'), at('b', 'exited')], new Map([['a', [lead]], ['b', [resumed]]]), none))
      .toEqual({ sessionId: 'b', sessionLink: 'conversation' })
    expect(linkRunSession(runs, [at('a', 'live'), at('b', 'exited')], new Map([['a', [lead]], ['b', [resumed]]]), none))
      .toEqual({ sessionId: 'a', sessionLink: 'conversation' })
    // A conversation outranks the folder; the folder stands in only for exactly one live session there.
    expect(linkRunSession(runs, [at('a', 'exited'), at('c', 'live')], new Map([['a', [lead]]]), () => '/repo')).toEqual({ sessionId: 'a', sessionLink: 'conversation' })
    expect(linkRunSession({ checkout: '/repo', leadConversations: [] }, [at('c', 'live'), at('d', 'exited')], new Map(), (s) => s.sessionId === 'c' ? '/repo' : null))
      .toEqual({ sessionId: 'c', sessionLink: 'checkout' })
    // Two live sessions in the checkout, or only a stopped one there: no guess.
    expect(linkRunSession({ checkout: '/repo', leadConversations: [] }, [at('c', 'live'), at('e', 'live')], new Map(), () => '/repo'))
      .toEqual({ sessionId: null, sessionLink: null })
    expect(linkRunSession({ checkout: '/repo', leadConversations: [] }, [at('d', 'exited', '/repo')], new Map(), () => '/repo'))
      .toEqual({ sessionId: null, sessionLink: null })
    expect(linkRunSession(runs, [{ ...at('a', 'live'), archivedAt: '2026-11-05' }], new Map([['a', [lead]]]), none)).toEqual({ sessionId: null, sessionLink: null })
  })
  it('carries the link and the new fields through the bounded read', async () => {
    const root = fixture(), main = join(root, 'main'); repo(main)
    file(main, '.dev-auto/handoff.md', text(`- Owning checkout and branch: ${main} / main\n`))
    const sessions = [{ sessionId: 's', workspaceId: 'w', name: 'Lead', cwd: main, archivedAt: null, lastProcess: { state: 'exited', incarnationId: 'i' } }] as SessionRecord[]
    const result = await readDevAutoRuns([workspace(main)], sessions, [], undefined, undefined, new Map(), new Map([['s', [resumed]]]))
    expect(result.runs[0]).toMatchObject({ sessionId: 's', sessionLink: 'conversation', waitingOn: 'Marta, review', skippedFinishedStories: 2,
      finishedStories: [{ story: '110.1' }, { story: '110.2' }] })
    const unlinked = await readDevAutoRuns([workspace(main)], sessions, [], undefined, undefined, new Map(), new Map())
    expect(unlinked.runs[0]).toMatchObject({ sessionId: null, sessionLink: null })
  })
})

describe('outbound handoff fields', () => {
  it('masks whole source fields before the reader clips them and leaves ownership paths raw', () => {
    const secret = `sk-ant-${'A'.repeat(90)}`
    const prefix = 'BLOCKED '+'.'.repeat(980)
    const text = handoff('/home/owner/repo', 'main', prefix + secret)
    const local = parseHandoff(text)
    expect(local.status).toContain('sk-ant-')
    const phone = parseHandoff(text, value => phoneField(value, '/home/owner', Infinity))
    expect(phone.status).not.toContain('sk-ant-')
    expect(phone.truncatedFields).toBe(1)
    expect(phone.ownerCheckout).toBe('/home/owner/repo')
  })

  it('reports absent handoffs as incomplete for a digest while leaving the local empty view unchanged', async () => {
    const root = fixture(); repo(root)
    expect((await readDevAutoRuns([workspace(root)], [], [])).runs).toEqual([])
    const outbound = await readDevAutoRuns([workspace(root)], [], [], undefined, value => value)
    expect(outbound.runs).toEqual([]); expect(outbound.skipped).toBe(1)
    expect(outbound.issues[0]).toContain('handoff absent')
  })
})
