// A bounded metadata snapshot, separate from live hook observations. No payloads or replay.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HOOK_EVENT_AGENTS, HOOK_EVENT_EFFECTS, HOOK_EVENT_LOG_LIMIT, type HookEventRecord } from '@bmn/protocol'

export const HOOK_HISTORY_FILE = 'hook-events.json'
export const HOOK_HISTORY_MAX_BYTES = 1024 * 1024
export const HOOK_HISTORY_MAX_ROWS = 1024
const EVENTS = new Set(['other', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'Interrupt', 'PreCompact', 'PostCompact',
  'sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd', 'session.created', 'session.idle',
  'session.compacted', 'permission.asked', 'permission.updated', 'permission.replied', 'question.asked',
  'question.replied', 'question.rejected', 'osc:9', 'osc:777', 'osc:99'])
const SOURCES = new Set(['other', 'startup', 'resume', 'clear', 'compact', 'manual', 'auto', 'subagent'])
const TOOLS = new Set(['other', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Task', 'Agent',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode',
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'task', 'webfetch', 'websearch', 'question',
  'request_user_input', 'request_user_input_async', 'functions.request_user_input', 'functions.request_user_input_async',
  'exec_command', 'apply_patch'])
const FIELDS = ['sessionId', 'incarnationId', 'agent', 'event', 'source', 'toolName', 'repeat', 'effects', 'observedAt']
const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const label = (value: string | null, allowed: Set<string>): string | null => value === null ? null : allowed.has(value) ? value : 'other'

function validRow(value: unknown): value is HookEventRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === FIELDS.length && FIELDS.every(key => key in row) && id(row.sessionId) &&
    (row.incarnationId === null || id(row.incarnationId)) && (HOOK_EVENT_AGENTS as readonly unknown[]).includes(row.agent) &&
    typeof row.event === 'string' && EVENTS.has(row.event) &&
    (row.source === null || typeof row.source === 'string' && SOURCES.has(row.source)) &&
    (row.toolName === null || typeof row.toolName === 'string' && TOOLS.has(row.toolName)) &&
    (row.repeat === null || Number.isInteger(row.repeat) && Number(row.repeat) >= 1 && Number(row.repeat) <= 20) &&
    Array.isArray(row.effects) && row.effects.length <= HOOK_EVENT_EFFECTS.length &&
    new Set(row.effects).size === row.effects.length && row.effects.every(effect => (HOOK_EVENT_EFFECTS as readonly unknown[]).includes(effect)) &&
    typeof row.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt) &&
    Number.isFinite(Date.parse(row.observedAt)) && new Date(row.observedAt).toISOString() === row.observedAt
}

/** An explicit metadata projection; never copy arbitrary keys from a live event. */
export function retainedHookEvent(event: HookEventRecord): HookEventRecord | null {
  const row: HookEventRecord = {
    sessionId: event.sessionId, incarnationId: event.incarnationId, agent: event.agent,
    event: label(event.event, EVENTS)!, source: label(event.source, SOURCES), toolName: label(event.toolName, TOOLS),
    repeat: event.repeat === null ? null : Math.min(20, Math.max(1, Math.trunc(event.repeat))),
    effects: [...new Set(event.effects)].filter(effect => (HOOK_EVENT_EFFECTS as readonly unknown[]).includes(effect)),
    observedAt: event.observedAt
  }
  return validRow(row) ? row : null
}

/** Input is streamed into at most 1,025 rows; ties retain observation order. */
export function boundedHookHistory(input: Iterable<HookEventRecord>): HookEventRecord[] {
  const rows: HookEventRecord[] = []
  const counts = new Map<string, number>()
  const remove = (index: number): void => {
    const removed = rows.splice(index, 1)[0]!
    const count = counts.get(removed.sessionId)! - 1
    if (count === 0) counts.delete(removed.sessionId)
    else counts.set(removed.sessionId, count)
  }
  for (const row of input) {
    let lo = 0, hi = rows.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (rows[middle]!.observedAt <= row.observedAt) lo = middle + 1
      else hi = middle
    }
    rows.splice(lo, 0, row)
    const count = (counts.get(row.sessionId) ?? 0) + 1
    counts.set(row.sessionId, count)
    if (count > HOOK_EVENT_LOG_LIMIT) remove(rows.findIndex(entry => entry.sessionId === row.sessionId))
    if (rows.length > HOOK_HISTORY_MAX_ROWS) remove(0)
  }
  return rows
}

export class HookEventHistory {
  private earlier: HookEventRecord[] = []
  private loaded = false
  private dirty = false
  private stopped = false
  private timer: NodeJS.Timeout | undefined
  private writer: Promise<void> | undefined
  unavailable = false

  constructor(private readonly options: {
    root: string
    sessionExists(sessionId: string): boolean
    live(): Iterable<HookEventRecord>
    /** A controlled filesystem replacement seam for failure/interleaving tests. */
    replace?: typeof rename
    /** A controlled open seam for filesystem replacement tests. */
    openFile?: typeof open
  }) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      // Windows ignores NOFOLLOW: establish an ordinary pathname and compare the opened identity before reading.
      const path = join(this.options.root, HOOK_HISTORY_FILE)
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > HOOK_HISTORY_MAX_BYTES) {
        throw new Error('Invalid history file')
      }
      handle = await (this.options.openFile ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 ||
        stat.size > HOOK_HISTORY_MAX_BYTES) throw new Error('History changed while opening')
      const bytes = Buffer.alloc(stat.size + 1)
      let read = 0
      while (read < bytes.length) {
        const part = await handle.read(bytes, read, bytes.length - read, read)
        if (part.bytesRead === 0) break
        read += part.bytesRead
      }
      const after = await lstat(path)
      if (read !== stat.size || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
        after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new Error('History changed during read')
      }
      const snapshot: unknown = JSON.parse(bytes.subarray(0, read).toString('utf8'))
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid snapshot')
      const saved = snapshot as { version?: unknown; rows?: unknown }
      if (Object.keys(snapshot).length !== 2 || saved.version !== 1 || !Array.isArray(saved.rows) ||
        saved.rows.length > HOOK_HISTORY_MAX_ROWS || !saved.rows.every(validRow)) throw new Error('Invalid history rows')
      this.earlier = boundedHookHistory(saved.rows.filter(row => this.options.sessionExists(row.sessionId)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable = true
      this.earlier = []
    } finally {
      await handle?.close().catch(() => undefined)
    }
    // Filtered rows and invalid snapshots are replaced once, after normal session enumeration.
    this.markDirty()
  }

  history(sessionId: string): HookEventRecord[] {
    return this.options.sessionExists(sessionId) ? this.earlier.filter(row => row.sessionId === sessionId) : []
  }

  sessionsChanged(): void {
    const before = this.earlier.length
    this.earlier = this.earlier.filter(row => this.options.sessionExists(row.sessionId))
    if (before !== this.earlier.length) this.markDirty()
  }

  markDirty(): void {
    if (!this.loaded || this.stopped) return
    this.dirty = true
    if (this.writer || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 200)
    this.timer.unref()
  }

  private *sample(): Generator<HookEventRecord> {
    for (const row of this.earlier) if (this.options.sessionExists(row.sessionId)) yield row
    for (const event of this.options.live()) {
      if (!this.options.sessionExists(event.sessionId)) continue
      const row = retainedHookEvent(event)
      if (row) yield row
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.writer) return this.writer
    if (!this.loaded || !this.dirty) return
    this.writer = this.writeLoop().finally(() => {
      this.writer = undefined
      if (this.dirty && !this.stopped) this.markDirty()
    })
    return this.writer
  }

  private async writeLoop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      const rows = boundedHookHistory(this.sample())
      const retained = new Set(rows)
      this.earlier = this.earlier.filter(row => retained.has(row))
      const temporary = join(this.options.root, `.${HOOK_HISTORY_FILE}.${randomUUID()}.tmp`)
      try {
        const bytes = JSON.stringify({ version: 1, rows })
        if (Buffer.byteLength(bytes) > HOOK_HISTORY_MAX_BYTES) throw new Error('History exceeds byte cap')
        await mkdir(this.options.root, { recursive: true, mode: 0o700 })
        // The Windows state root is secured before the utility starts; new files inherit its owner-only DACL.
        if (process.platform !== 'win32') await chmod(this.options.root, 0o700)
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        await (this.options.replace ?? rename)(temporary, join(this.options.root, HOOK_HISTORY_FILE))
      } catch {
        this.unavailable = true
        this.dirty = false
        await unlink(temporary).catch(() => undefined)
        break // Retry only on a later dirty event, never spin after a failing write.
      }
    }
  }

  /** Reuse the service's existing close point; pending I/O cannot hold termination indefinitely. */
  async close(): Promise<void> {
    this.stopped = true
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.flush(), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); timer.unref() })])
    if (timer) clearTimeout(timer)
  }
}
