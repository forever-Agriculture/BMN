// MODULE: agent-history.test.ts - the history limit: confirmation rules, Claude folder policy, the pruning runner and its schedule
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, type AgentHistorySettings } from '@bmn/protocol'
import { cursorHistoryAdapter } from './agent-history-cursor'
import {
  AgentHistory,
  DAY_MS,
  RUN_INTERVAL_MS,
  emptyHistoryState,
  isShorterLimit,
  readHistoryState,
  runningCommandLines,
  type AgentHistoryAdapter,
  type AgentHistoryState,
  type HistoryCandidate
} from './agent-history'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function daysAgo(days: number, extraMs = 0): number {
  return NOW.getTime() - days * DAY_MS - extraMs
}

interface FakeAdapter extends AgentHistoryAdapter {
  sessions: HistoryCandidate[]
  removed: string[]
  failing: Set<string>
}

function fakeAdapter(agent: 'codex' | 'opencode', sessions: HistoryCandidate[], options: { available?: false } = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    agent,
    sessions: [...sessions],
    removed: [],
    failing: new Set(),
    async available() {
      return options.available === false ? { ok: false, reason: 'threads has no updated_at' } : { ok: true, sessions: adapter.sessions.length }
    },
    async candidates(cutoff) {
      return adapter.sessions.filter((session) => session.updatedAt < cutoff)
    },
    async remove(id) {
      if (adapter.failing.has(id)) return { ok: false, reason: 'failed to delete session' }
      adapter.removed.push(id)
      adapter.sessions = adapter.sessions.filter((session) => session.id !== id)
      return { ok: true }
    }
  }
  return adapter
}

async function fixture(options: {
  settings?: Partial<AgentHistorySettings>
  adapters?: AgentHistoryAdapter[]
  /** Read at each call, so a test may change it while a run is under way. */
  live?: string[]
  commandLines?: string | (() => string)
  claudeSettings?: string | null
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bmn-history-'))
  roots.push(home)
  await mkdir(join(home, '.claude'))
  if (options.claudeSettings !== null) {
    await writeFile(join(home, '.claude', 'settings.json'), options.claudeSettings ?? '{ "model": "opus" }')
  }
  let settings: AgentHistorySettings = { ...DEFAULT_APP_SETTINGS.agentHistory, claudeConfigDirs: [], ...options.settings }
  let state: AgentHistoryState = emptyHistoryState()
  const logs: string[] = []
  const changed = vi.fn()
  const history = new AgentHistory({
    home,
    adapters: options.adapters ?? [],
    readSettings: async () => structuredClone(settings),
    writeSettings: async (next) => { settings = structuredClone(next) },
    readState: async () => structuredClone(state),
    writeState: async (next) => { state = structuredClone(next) },
    liveConversationIds: async () => new Set(options.live ?? []),
    commandLines: () => typeof options.commandLines === 'function' ? options.commandLines() : options.commandLines ?? '',
    now: () => NOW,
    log: (line) => logs.push(line),
    changed
  })
  const claudeDays = async (folder = join(home, '.claude')): Promise<unknown> =>
    (JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8')) as Record<string, unknown>).cleanupPeriodDays
  return { history, home, logs, changed, claudeDays, settings: () => settings, state: () => state }
}

describe('agent history limit', () => {
  it('orders limits with Never longest', () => {
    expect(isShorterLimit(7, 30)).toBe(true)
    expect(isShorterLimit(90, null)).toBe(true)
    expect(isShorterLimit(null, 90)).toBe(false)
    expect(isShorterLimit(30, 30)).toBe(false)
  })

  it('writes and deletes nothing before Start cleanup, and says what it would do', async () => {
    const codex = fakeAdapter('codex', [{ id: 'old', updatedAt: daysAgo(40) }, { id: 'new', updatedAt: daysAgo(2) }])
    const f = await fixture({ adapters: [codex] })

    await f.history.run()
    const status = await f.history.status()

    expect(codex.removed).toEqual([])
    expect(await f.claudeDays()).toBeUndefined()
    expect(status).toMatchObject({ keepDays: 30, confirmedKeepDays: undefined, needsConfirmation: true, running: false })
    expect(status.claude).toEqual([expect.objectContaining({
      path: join(f.home, '.claude'), name: 'Claude Code', displayPath: join(f.home, '.claude').replace(f.home, '~'),
      currentDays: null, targetDays: 30, pending: true
    })])
    expect(status.agents).toEqual([{ agent: 'codex', state: 'managed', sessions: 2, candidates: 1 }])
  })

  it('Start cleanup writes each folder that differs, confirms, and runs', async () => {
    const codex = fakeAdapter('codex', [{ id: 'old', updatedAt: daysAgo(40) }, { id: 'new', updatedAt: daysAgo(2) }])
    const f = await fixture({ adapters: [codex] })

    await f.history.confirm()
    await f.history.run()
    const status = await f.history.status()

    expect(await f.claudeDays()).toBe(30)
    expect(codex.removed).toEqual(['old'])
    expect(status.needsConfirmation).toBe(false)
    expect(status.claude[0]).toMatchObject({ currentDays: 30, pending: false, applied: { days: 30, at: NOW.toISOString() } })
    expect(status.agents[0]).toMatchObject({ sessions: 1, candidates: 0, lastRun: { deleted: 1, remaining: 0, failures: [] } })
    expect(f.logs.join('')).toContain('[BMN] agent history (30 days): codex deleted 1, 0 failed, 0 next run')
  })

  it('a shorter limit waits for confirmation while the confirmed one stays in force', async () => {
    const codex = fakeAdapter('codex', [{ id: 'ten', updatedAt: daysAgo(10) }])
    const f = await fixture({ adapters: [codex] })
    await f.history.confirm()
    await f.history.run()

    await f.history.setKeepDays(7)
    await f.history.run()
    let status = await f.history.status()

    expect(f.settings()).toMatchObject({ keepDays: 7, confirmedKeepDays: 30 })
    expect(await f.claudeDays()).toBe(30)
    expect(codex.removed).toEqual([])
    expect(status).toMatchObject({ needsConfirmation: true })
    expect(status.claude[0]).toMatchObject({ currentDays: 30, targetDays: 7, pending: true })
    expect(status.agents[0]).toMatchObject({ candidates: 1 })

    await f.history.confirm()
    await f.history.run()
    status = await f.history.status()
    expect(await f.claudeDays()).toBe(7)
    expect(codex.removed).toEqual(['ten'])
    expect(status.needsConfirmation).toBe(false)
  })

  it('a longer limit or Never applies at once to confirmed folders, never to a drifted or new one', async () => {
    const f = await fixture()
    const glm = join(f.home, '.claude-glm')
    await mkdir(glm)
    await writeFile(join(glm, 'settings.json'), '{ "cleanupPeriodDays": 30 }')
    await f.history.confirm()
    expect(await f.claudeDays()).toBe(30)

    // A folder learned after the confirmation, and a hand edit of a confirmed one.
    await f.history.learnClaudeFolder(glm)
    const drifted = join(f.home, 'drifted')
    await mkdir(drifted)
    await writeFile(join(drifted, 'settings.json'), '{ "cleanupPeriodDays": 5 }')
    await f.history.learnClaudeFolder(drifted)
    await f.history.confirm()
    expect(await f.claudeDays(drifted)).toBe(30)
    expect(await f.claudeDays(glm)).toBe(30)
    await writeFile(join(drifted, 'settings.json'), '{ "cleanupPeriodDays": 14 }')
    const newer = join(f.home, 'newer')
    await mkdir(newer)
    await writeFile(join(newer, 'settings.json'), '{ "cleanupPeriodDays": 5 }')
    await f.history.learnClaudeFolder(newer)

    await f.history.setKeepDays(90)

    expect(f.settings()).toMatchObject({ keepDays: 90, confirmedKeepDays: 90 })
    expect(await f.claudeDays()).toBe(90)
    // Confirmed while it already held 30, so it follows the owner's later change like a written one.
    expect(await f.claudeDays(glm)).toBe(90)
    expect(await f.claudeDays(drifted)).toBe(14)
    expect(await f.claudeDays(newer)).toBe(5)
    const status = await f.history.status()
    expect(status.needsConfirmation).toBe(true)
    expect(status.claude.find((folder) => folder.path === drifted)).toMatchObject({ currentDays: 14, targetDays: 90, pending: true })

    await f.history.setKeepDays(null)
    expect(await f.claudeDays()).toBe(36_500)
  })

  it('lists a folder learned after the confirmation as pending even when it already holds the limit (Astra review)', async () => {
    const f = await fixture()
    await f.history.confirm()
    const glm = join(f.home, '.claude-glm')
    await mkdir(glm)
    await writeFile(join(glm, 'settings.json'), '{ "cleanupPeriodDays": 30 }')
    await f.history.learnClaudeFolder(glm)

    const before = await f.history.status()
    expect(before.needsConfirmation).toBe(true)
    expect(before.claude.find((folder) => folder.path === glm)).toMatchObject({ currentDays: 30, targetDays: 30, pending: true })
    // Nothing follows a later change until the owner confirms it.
    await f.history.setKeepDays(90)
    expect(await f.claudeDays(glm)).toBe(30)

    await f.history.confirm()
    const after = await f.history.status()
    expect(after.needsConfirmation).toBe(false)
    expect(after.claude.find((folder) => folder.path === glm)).toMatchObject({ currentDays: 90, pending: false })
    await f.history.setKeepDays(null)
    expect(await f.claudeDays(glm)).toBe(36_500)
  })

  it('remembers learned folders that hold a settings.json, at most 8, never the home one', async () => {
    const f = await fixture()
    await f.history.learnClaudeFolder(join(f.home, '.claude'))
    await f.history.learnClaudeFolder(join(f.home, 'missing'))
    const folders: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const folder = join(f.home, `config-${index}`)
      await mkdir(folder)
      await writeFile(join(folder, 'settings.json'), '{}')
      folders.push(folder)
      await f.history.learnClaudeFolder(folder)
    }
    await f.history.learnClaudeFolder(folders[9]!)

    expect(f.settings().claudeConfigDirs).toEqual(folders.slice(2))
    const status = await f.history.status()
    expect(status.claude.map((folder) => folder.path)).toEqual([join(f.home, '.claude'), ...folders.slice(2)])
  })

  it('names an unparsable folder and skips it', async () => {
    const f = await fixture({ claudeSettings: '{ broken' })

    await f.history.confirm()
    const status = await f.history.status()

    expect(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken')
    expect(status.claude[0]).toMatchObject({ pending: true, failure: 'settings.json is not valid JSON' })
  })

  it('deletes candidates older than the cutoff, oldest first, 200 per run, skipping live, recent and running ones', async () => {
    const sessions: HistoryCandidate[] = []
    for (let index = 0; index < 250; index += 1) sessions.push({ id: `s-${String(index).padStart(3, '0')}`, updatedAt: daysAgo(31, index * 1000) })
    sessions.push({ id: 'boundary', updatedAt: daysAgo(30) }, { id: 'bound-live', updatedAt: daysAgo(60) }, { id: 'on-a-command-line', updatedAt: daysAgo(60) })
    const codex = fakeAdapter('codex', sessions)
    const f = await fixture({ adapters: [codex], live: ['bound-live'], commandLines: 'codex resume on-a-command-line\nbash' })
    await f.history.confirm()

    await f.history.run()

    expect(codex.removed).toHaveLength(200)
    // Oldest first: s-249 is the oldest of the 250.
    expect(codex.removed[0]).toBe('s-249')
    expect(codex.removed).not.toContain('boundary')
    expect(codex.removed).not.toContain('bound-live')
    expect(codex.removed).not.toContain('on-a-command-line')
    expect(f.state().runs.codex).toMatchObject({ deleted: 200, remaining: 50 })

    await f.history.run()
    expect(codex.removed).toHaveLength(250)
    expect(codex.sessions.map((session) => session.id).sort()).toEqual(['bound-live', 'boundary', 'on-a-command-line'])
  })

  it('skips anything touched within the last day even under a limit it would pass', async () => {
    const opencode = fakeAdapter('opencode', [{ id: 'today', updatedAt: NOW.getTime() - 1000 }])
    // A candidates() that ignores the cutoff must still not reach a session in use today.
    opencode.candidates = async () => opencode.sessions
    const f = await fixture({ adapters: [opencode] })
    await f.history.confirm()

    await f.history.run()

    expect(opencode.removed).toEqual([])
  })

  it('records a failed delete, does not retry it that run, and goes on', async () => {
    const codex = fakeAdapter('codex', [{ id: 'held', updatedAt: daysAgo(50) }, { id: 'free', updatedAt: daysAgo(40) }])
    codex.failing.add('held')
    const remove = vi.spyOn(codex, 'remove')
    const f = await fixture({ adapters: [codex] })
    await f.history.confirm()

    await f.history.run()

    expect(remove).toHaveBeenCalledTimes(2)
    expect(codex.removed).toEqual(['free'])
    expect(f.state().runs.codex).toMatchObject({ deleted: 1, failures: [{ id: 'held', reason: 'failed to delete session' }] })
  })

  it('runs nothing when unconfirmed or Never, and reports an unrecognised store without deleting', async () => {
    const codex = fakeAdapter('codex', [{ id: 'old', updatedAt: daysAgo(400) }])
    const broken = fakeAdapter('opencode', [{ id: 'old2', updatedAt: daysAgo(400) }], { available: false })
    const never = await fixture({ adapters: [codex, broken], settings: { keepDays: null } })

    await never.history.run()
    await never.history.confirm()
    await never.history.run()

    expect(codex.removed).toEqual([])
    expect(broken.removed).toEqual([])
    expect(await never.claudeDays()).toBe(36_500)
    const status = await never.history.status()
    expect(status.agents[1]).toEqual({ agent: 'opencode', state: 'unrecognised', detail: 'threads has no updated_at' })
  })

  it('does not list an agent that is not installed', async () => {
    const absent: AgentHistoryAdapter = {
      agent: 'codex',
      available: async () => ({ ok: false, reason: 'codex is not on PATH', absent: true }),
      candidates: async () => [],
      remove: async () => ({ ok: true })
    }
    const f = await fixture({ adapters: [absent] })

    expect((await f.history.status()).agents).toEqual([])
  })

  it('checks each session again just before deleting it: one resumed, touched or started meanwhile is kept (Astra review)', async () => {
    const codex = fakeAdapter('codex', ['e', 'f', 'g', 'h'].map((id, index) => ({ id, updatedAt: daysAgo(40 + 4 - index) })))
    const live: string[] = []
    let commandLines = 'bash'
    const f = await fixture({ adapters: [codex], live, commandLines: () => commandLines })
    const remove = codex.remove.bind(codex)
    codex.remove = async (id) => {
      const result = await remove(id)
      // While 'e' is deleted, 'f' is resumed in BMN, 'g' is used and 'h' starts on a command line.
      if (id === 'e') {
        live.push('f')
        codex.sessions = codex.sessions.map((session) => (session.id === 'g' ? { ...session, updatedAt: NOW.getTime() } : session))
        commandLines = 'codex resume h'
      }
      return result
    }
    await f.history.confirm()
    await f.history.run()

    expect(codex.removed).toEqual(['e'])
    expect(f.state().runs.codex).toMatchObject({ deleted: 1, remaining: 0, failures: [] })
  })

  it('marks each session as being deleted only while its check and delete run, failures included (Astra recheck)', async () => {
    const codex = fakeAdapter('codex', [{ id: 'a', updatedAt: daysAgo(40) }, { id: 'b', updatedAt: daysAgo(41) }])
    codex.failing.add('b')
    const f = await fixture({ adapters: [codex] })
    const seen: Array<[string, boolean, boolean]> = []
    const remove = codex.remove.bind(codex)
    codex.remove = async (id) => {
      seen.push([id, f.history.isDeleting(id), f.history.isDeleting(id === 'a' ? 'b' : 'a')])
      return remove(id)
    }
    await f.history.confirm()
    await f.history.run()

    expect(seen).toEqual([['b', true, false], ['a', true, false]])
    expect(f.history.isDeleting('a')).toBe(false)
    expect(f.history.isDeleting('b')).toBe(false)
    expect(f.state().runs.codex).toMatchObject({ deleted: 1, failures: [{ id: 'b' }] })
  })

  it('reads the agent store last in the re-check, so activity during the other reads still counts (Astra recheck)', async () => {
    const codex = fakeAdapter('codex', [{ id: 'b', updatedAt: daysAgo(40) }])
    let liveReads = 0
    const f = await fixture({ adapters: [codex] })
    const history = f.history as unknown as { options: { liveConversationIds: () => Promise<Set<string>> } }
    const live = history.options.liveConversationIds
    history.options.liveConversationIds = async () => {
      liveReads += 1
      // The re-check's own read of live bindings: the session is used right then.
      if (liveReads === 2) codex.sessions = codex.sessions.map((session) => ({ ...session, updatedAt: NOW.getTime() }))
      return live()
    }
    await f.history.confirm()
    await f.history.run()

    expect(liveReads).toBe(2)
    expect(codex.removed).toEqual([])
  })

  it('stops between deletions when BMN quits; the next run takes the rest', async () => {
    const codex = fakeAdapter('codex', [{ id: 'a', updatedAt: daysAgo(40) }, { id: 'b', updatedAt: daysAgo(41) }])
    const f = await fixture({ adapters: [codex] })
    await f.history.confirm()
    const remove = codex.remove.bind(codex)
    codex.remove = async (id) => {
      const result = await remove(id)
      f.history.stop()
      return result
    }

    await f.history.run()

    expect(codex.removed).toEqual(['b'])
    expect(f.state().runs.codex).toMatchObject({ deleted: 1, remaining: 1 })
  })

  it('starts the first run after the delay, repeats every 24 hours, and never makes start wait', async () => {
    vi.useFakeTimers()
    const codex = fakeAdapter('codex', [])
    const candidates = vi.spyOn(codex, 'candidates')
    const f = await fixture({ adapters: [codex] })
    await f.history.confirm()
    await vi.runAllTimersAsync()
    candidates.mockClear()

    f.history.startSchedule(30_000)
    expect(candidates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(candidates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RUN_INTERVAL_MS - 1)
    expect(candidates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(candidates).toHaveBeenCalledTimes(2)
    f.history.stop()
    await vi.advanceTimersByTimeAsync(RUN_INTERVAL_MS * 2)
    expect(candidates).toHaveBeenCalledTimes(2)
  })

  it('reads a damaged stored state as empty and running command lines from /proc', async () => {
    expect(readHistoryState('nonsense')).toEqual(emptyHistoryState())
    expect(readHistoryState({ applied: { '/a': { days: 30, at: 'x' }, '/b': { days: 'no' } }, runs: { codex: { at: 1 } } }))
      .toEqual({ applied: { '/a': { days: 30, at: 'x' } }, failures: {}, runs: {} })
    const proc = await mkdtemp(join(tmpdir(), 'bmn-proc-'))
    roots.push(proc)
    await mkdir(join(proc, '42'))
    await writeFile(join(proc, '42', 'cmdline'), 'opencode\0-s\0ses_0123456789abABCDEFGHIJKLMN\0')
    await mkdir(join(proc, 'self'))
    expect(runningCommandLines(proc)).toContain('opencode -s ses_0123456789abABCDEFGHIJKLMN')
  })
})

describe('Cursor in the history section (Story 31.3 AC3)', () => {
  it('shows Cursor as keeping its own history and never asks it to delete anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bmn-history-cursor-'))
    roots.push(home)
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 })
    const cursor = cursorHistoryAdapter({ home, env: { PATH: bin } })
    const remove = vi.spyOn(cursor, 'remove')
    const codex = fakeAdapter('codex', [{ id: 'old', updatedAt: daysAgo(40) }])
    const f = await fixture({ adapters: [codex, cursor] })

    await f.history.confirm()
    await f.history.run()
    const status = await f.history.status()

    expect(status.agents).toEqual([
      expect.objectContaining({ agent: 'codex', state: 'managed' }),
      { agent: 'cursor', state: 'own', detail: 'Cursor has no command to delete a chat' }
    ])
    expect(codex.removed).toEqual(['old'])
    expect(remove).not.toHaveBeenCalled()
    expect(f.logs.join('\n')).not.toContain('cursor')
  })

  it('leaves Cursor out when it is neither on PATH nor has kept a chat', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bmn-history-cursor-'))
    roots.push(home)
    expect(await cursorHistoryAdapter({ home, env: { PATH: join(home, 'none') } }).available())
      .toEqual({ ok: false, reason: 'cursor-agent is not on PATH', absent: true })
    await mkdir(join(home, '.cursor', 'chats'), { recursive: true })
    expect(await cursorHistoryAdapter({ home, env: { PATH: join(home, 'none') } }).available())
      .toMatchObject({ ok: false, own: true })
  })
})
