// MODULE: agent-history.ts - one history limit for every agent: Claude folders, the pruning runner and its schedule (Stories 31.1, 31.2)
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  MAX_CLAUDE_CONFIG_DIRS,
  MAX_DELETIONS_PER_RUN,
  type AgentHistoryAgent,
  type AgentHistoryAgentRow,
  type AgentHistoryClaudeFolder,
  type AgentHistoryKeepDays,
  type AgentHistoryRun,
  type AgentHistorySettings,
  type AgentHistoryStatus
} from '@bmn/protocol'
import {
  claudeSettingsPath,
  claudeTargetDays,
  readClaudeFolder,
  writeClaudeFolder
} from './agent-history-claude'

export const DAY_MS = 86_400_000
export const RUN_INTERVAL_MS = DAY_MS
/** OpenCode deletes a session a live process holds (docs/agent-history.md), so anything this recent is left alone. */
export const RECENT_SESSION_MS = DAY_MS

export interface HistoryCandidate {
  id: string
  /** Last activity, epoch milliseconds. */
  updatedAt: number
}

/** `absent`: the agent is not installed here, so History does not list it. */
export type AdapterAvailability =
  | { ok: true; sessions: number }
  | { ok: false; reason: string; absent?: true }
  /** Present, but the agent has no command BMN may delete its sessions with; the row says so and nothing runs. */
  | { ok: false; reason: string; own: true }

/** One agent whose sessions BMN deletes through the agent's own command. A new agent adds one of these. */
export interface AgentHistoryAdapter {
  readonly agent: AgentHistoryAgent
  available(): Promise<AdapterAvailability>
  /** Sessions whose last activity is before `cutoff` (epoch ms), in any order. */
  candidates(cutoff: number): Promise<HistoryCandidate[]>
  remove(id: string): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** What BMN remembers about its own actions, beside the setting (raw settings key, no new table). */
export interface AgentHistoryState {
  applied: Record<string, { days: number; at: string }>
  failures: Record<string, string>
  runs: Partial<Record<AgentHistoryAgent, AgentHistoryRun>>
}

export const AGENT_HISTORY_STATE_KEY = 'agentHistoryState'

export function emptyHistoryState(): AgentHistoryState {
  return { applied: {}, failures: {}, runs: {} }
}

/** A stored state that does not have this shape is treated as empty; it only feeds the status rows. */
export function readHistoryState(value: unknown): AgentHistoryState {
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
  const raw = record(value)
  const state = emptyHistoryState()
  for (const [path, entry] of Object.entries(record(raw.applied))) {
    const { days, at } = record(entry)
    if (typeof days === 'number' && typeof at === 'string') state.applied[path] = { days, at }
  }
  for (const [path, failure] of Object.entries(record(raw.failures))) {
    if (typeof failure === 'string') state.failures[path] = failure
  }
  for (const [agent, entry] of Object.entries(record(raw.runs))) {
    const { at, deleted, remaining, failures } = record(entry)
    if (typeof at === 'string' && typeof deleted === 'number' && typeof remaining === 'number' && Array.isArray(failures)) {
      state.runs[agent as AgentHistoryAgent] = {
        at, deleted, remaining,
        failures: failures.filter((failure): failure is { id: string; reason: string } =>
          typeof record(failure).id === 'string' && typeof record(failure).reason === 'string')
      }
    }
  }
  return state
}

/** Never is longest; `a` shorter than `b` is what makes a change ask again. */
export function isShorterLimit(a: AgentHistoryKeepDays, b: AgentHistoryKeepDays): boolean {
  return (a ?? Number.POSITIVE_INFINITY) < (b ?? Number.POSITIVE_INFINITY)
}

/** Every process command line now, so a session another program was started on is left alone. */
export function runningCommandLines(procRoot = '/proc'): string {
  const lines: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      lines.push(readFileSync(`${procRoot}/${entry}/cmdline`, 'latin1').replaceAll('\0', ' '))
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return lines.join('\n')
}

export interface AgentHistoryOptions {
  home: string
  adapters: readonly AgentHistoryAdapter[]
  readSettings(): Promise<AgentHistorySettings>
  writeSettings(next: AgentHistorySettings): Promise<void>
  readState(): Promise<AgentHistoryState>
  writeState(next: AgentHistoryState): Promise<void>
  /** Conversation references bound to a running BMN incarnation. */
  liveConversationIds(): Promise<ReadonlySet<string>>
  commandLines?(): string
  now?(): Date
  log?(line: string): void
  /** Called after anything the History section shows has changed. */
  changed?(): void
  setTimer?(callback: () => void, ms: number): { cancel(): void }
}

/**
 * The owner's one limit applied to every agent BMN knows. Nothing is written or deleted until the owner
 * confirms once; after that, a longer limit applies at once and a shorter one asks again.
 */
export class AgentHistory {
  private readonly options: AgentHistoryOptions
  private running: Promise<void> | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private timer: { cancel(): void } | null = null
  private stopped = false

  constructor(options: AgentHistoryOptions) {
    this.options = options
  }

  private get homeFolder(): string {
    return `${this.options.home}/.claude`
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  /** Settings changes run one at a time, so a learned folder and a limit change never overwrite each other. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.catch(() => undefined)
    return next
  }

  private folders(settings: AgentHistorySettings): string[] {
    return [...new Set([this.homeFolder, ...settings.claudeConfigDirs])]
  }

  /** A Claude hook reported where its settings live; only folders with a settings.json are remembered. */
  async learnClaudeFolder(folder: string): Promise<void> {
    if (folder === this.homeFolder) return
    await this.exclusive(async () => {
      const settings = await this.options.readSettings()
      if (settings.claudeConfigDirs.includes(folder)) return
      if (!existsSync(claudeSettingsPath(folder))) return
      const learned = [...settings.claudeConfigDirs.filter((dir) => dir !== this.homeFolder), folder]
      await this.options.writeSettings({ ...settings, claudeConfigDirs: learned.slice(-MAX_CLAUDE_CONFIG_DIRS) })
      this.options.changed?.()
    })
  }

  async status(): Promise<AgentHistoryStatus> {
    const settings = await this.options.readSettings()
    const state = await this.options.readState()
    const target = claudeTargetDays(settings.keepDays)
    const claude: AgentHistoryClaudeFolder[] = this.folders(settings).map((path) => {
      const read = readClaudeFolder(path)
      const applied = state.applied[path]
      const failure = state.failures[path] ?? (read.ok ? undefined : read.failure)
      return {
        path,
        name: path === this.homeFolder ? 'Claude Code' : basename(path) === '.claude-glm' ? 'GLM' : 'Claude',
        displayPath: path.startsWith(`${this.options.home}/`) ? `~${path.slice(this.options.home.length)}` : path,
        currentDays: read.ok ? read.currentDays : null,
        targetDays: target,
        pending: !read.ok || read.currentDays !== target,
        ...(applied === undefined ? {} : { applied }),
        ...(failure === undefined ? {} : { failure })
      }
    })
    const agents = await this.agentRows(settings.keepDays, state)
    const confirmed = settings.confirmedKeepDays
    return {
      keepDays: settings.keepDays,
      confirmedKeepDays: confirmed,
      needsConfirmation: confirmed === undefined || isShorterLimit(settings.keepDays, confirmed) ||
        claude.some((folder) => folder.pending),
      running: this.running !== null,
      claude,
      agents
    }
  }

  private async agentRows(keepDays: AgentHistoryKeepDays, state: AgentHistoryState): Promise<AgentHistoryAgentRow[]> {
    const rows: AgentHistoryAgentRow[] = []
    const protectedIds = keepDays === null ? new Set<string>() : await this.protectedIds()
    for (const adapter of this.options.adapters) {
      const lastRun = state.runs[adapter.agent]
      const run = lastRun === undefined ? {} : { lastRun }
      try {
        const available = await adapter.available()
        if (!available.ok) {
          if ('absent' in available) continue
          if ('own' in available) {
            rows.push({ agent: adapter.agent, state: 'own', detail: available.reason })
            continue
          }
          rows.push({ agent: adapter.agent, state: 'unrecognised', detail: available.reason, ...run })
          continue
        }
        const candidates = keepDays === null ? [] : this.eligible(await adapter.candidates(this.cutoff(keepDays)), protectedIds)
        rows.push({ agent: adapter.agent, state: 'managed', sessions: available.sessions, candidates: candidates.length, ...run })
      } catch (error) {
        rows.push({ agent: adapter.agent, state: 'unrecognised', detail: errorText(error), ...run })
      }
    }
    return rows
  }

  private cutoff(days: number): number {
    return this.now().getTime() - days * DAY_MS
  }

  private async protectedIds(): Promise<Set<string>> {
    return new Set(await this.options.liveConversationIds())
  }

  /** Oldest first, never a session in use: bound to a live BMN session, recent, or named on a running command line. */
  private eligible(candidates: readonly HistoryCandidate[], protectedIds: ReadonlySet<string>): HistoryCandidate[] {
    const recent = this.now().getTime() - RECENT_SESSION_MS
    const commandLines = (this.options.commandLines ?? runningCommandLines)()
    return candidates
      .filter((candidate) => !protectedIds.has(candidate.id) && candidate.updatedAt < recent &&
        !commandLines.includes(candidate.id))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
  }

  /**
   * The owner picked a limit. Before the first confirmation, and for a shorter limit, this only records
   * it. A longer limit or Never applies at once to every folder the owner already confirmed and that
   * still holds what BMN wrote; a folder that drifted or was learned since waits for Start cleanup.
   */
  async setKeepDays(keepDays: AgentHistoryKeepDays): Promise<void> {
    await this.exclusive(async () => {
      const settings = await this.options.readSettings()
      const confirmed = settings.confirmedKeepDays
      if (confirmed === undefined || isShorterLimit(keepDays, confirmed)) {
        await this.options.writeSettings({ ...settings, keepDays })
        this.options.changed?.()
        return
      }
      await this.options.writeSettings({ ...settings, keepDays, confirmedKeepDays: keepDays })
      const state = await this.options.readState()
      for (const path of this.folders(settings)) {
        const applied = state.applied[path]
        const read = readClaudeFolder(path)
        if (applied === undefined || !read.ok || read.currentDays !== applied.days) continue
        this.writeFolder(path, claudeTargetDays(keepDays), state)
      }
      await this.options.writeState(state)
      this.options.changed?.()
    })
  }

  private writeFolder(path: string, days: number, state: AgentHistoryState): void {
    const result = writeClaudeFolder(path, days)
    if (result.ok) {
      state.applied[path] = { days, at: this.now().toISOString() }
      delete state.failures[path]
    } else {
      state.failures[path] = result.failure
    }
  }

  /** Start cleanup: the owner's one confirmation. Writes every folder that differs, then starts a run. */
  async confirm(): Promise<void> {
    await this.exclusive(async () => {
      const settings = await this.options.readSettings()
      await this.options.writeSettings({ ...settings, confirmedKeepDays: settings.keepDays })
      const state = await this.options.readState()
      const target = claudeTargetDays(settings.keepDays)
      for (const path of this.folders(settings)) {
        const read = readClaudeFolder(path)
        if (read.ok && read.currentDays === target) {
          // Already right: nothing to write, but the owner has now confirmed it, so later changes follow.
          state.applied[path] = { days: target, at: this.now().toISOString() }
          delete state.failures[path]
          continue
        }
        this.writeFolder(path, target, state)
      }
      await this.options.writeState(state)
      this.options.changed?.()
    })
    void this.run()
  }

  /** One pruning run at the confirmed limit. A second call while one runs joins it. */
  run(): Promise<void> {
    if (this.running) return this.running
    const run = this.runOnce().finally(() => {
      this.running = null
      this.options.changed?.()
    })
    this.running = run
    this.options.changed?.()
    return run
  }

  private async runOnce(): Promise<void> {
    const settings = await this.options.readSettings()
    const days = settings.confirmedKeepDays
    if (days === undefined || days === null || this.stopped) return
    const protectedIds = await this.protectedIds()
    const summary: string[] = []
    for (const adapter of this.options.adapters) {
      if (this.stopped) break
      let candidates: HistoryCandidate[]
      try {
        const available = await adapter.available()
        if (!available.ok) continue
        candidates = this.eligible(await adapter.candidates(this.cutoff(days)), protectedIds)
      } catch (error) {
        summary.push(`${adapter.agent} not recognised (${errorText(error)})`)
        continue
      }
      if (candidates.length === 0) continue
      const batch = candidates.slice(0, MAX_DELETIONS_PER_RUN)
      const run: AgentHistoryRun = { at: this.now().toISOString(), deleted: 0, remaining: candidates.length - batch.length, failures: [] }
      for (const candidate of batch) {
        if (this.stopped) {
          run.remaining += batch.length - run.deleted - run.failures.length
          break
        }
        let result: Awaited<ReturnType<AgentHistoryAdapter['remove']>>
        try {
          result = await adapter.remove(candidate.id)
        } catch (error) {
          result = { ok: false, reason: errorText(error) }
        }
        if (result.ok) run.deleted += 1
        else run.failures.push({ id: candidate.id, reason: result.reason })
      }
      const state = await this.options.readState()
      state.runs[adapter.agent] = run
      await this.options.writeState(state)
      summary.push(`${adapter.agent} deleted ${run.deleted}, ${run.failures.length} failed, ${run.remaining} next run`)
    }
    if (summary.length > 0) this.options.log?.(`[BMN] agent history (${days} days): ${summary.join('; ')}\n`)
  }

  /** The first run starts after `delayMs` (after the archive purge), then every 24 hours; nothing awaits it. */
  startSchedule(delayMs = 0): void {
    const schedule = this.options.setTimer ?? ((callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms)
      handle.unref?.()
      return { cancel: () => clearTimeout(handle) }
    })
    const tick = (ms: number): void => {
      this.timer = schedule(() => {
        if (this.stopped) return
        void this.run().catch((error: unknown) => this.options.log?.(`[BMN] agent history failed: ${errorText(error)}\n`))
        tick(RUN_INTERVAL_MS)
      }, ms)
    }
    tick(delayMs)
  }

  /** Quitting stops between deletions; the next run finds what is left. */
  stop(): void {
    this.stopped = true
    this.timer?.cancel()
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
