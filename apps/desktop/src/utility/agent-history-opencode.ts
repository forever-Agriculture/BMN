// MODULE: agent-history-opencode.ts - OpenCode sessions for the history runner: opencode.db read-only, `opencode session delete` to remove (Story 31.2)
import { existsSync, realpathSync, statSync } from 'node:fs'
import type { AgentHistoryAdapter, HistoryCandidate } from './agent-history'
import {
  agentCommandEnvironment,
  failureLine,
  findOnPath,
  missingColumns,
  readOnlyQuery,
  runAgentCommand,
  type OpenReadOnly
} from './agent-history-store'

// OpenCode 1.18.31 session IDs (bin/bmn OPENCODE_REFERENCE); OpenCode 2.0.28 keeps the same form.
const SESSION_ID = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/

export interface OpenCodeHistoryOptions {
  home: string
  open: OpenReadOnly
  env?: NodeJS.ProcessEnv
}

/**
 * Where an OpenCode version keeps its sessions and how its `session delete` is called. OpenCode 2
 * copies the sessions of 1 into `session_v2` and writes only there, has no `--pure`, and deletes a
 * session's children with it, so only top-level sessions are counted and offered, each with its whole
 * family: aged by the family's newest activity and kept while any of it is in use. `--standalone` runs
 * the delete on a private server instead of the shared background service.
 */
interface Layout { table: 'session' | 'session_v2'; topLevelOnly: boolean; deleteFlags: readonly string[] }
const OPENCODE_1: Layout = { table: 'session', topLevelOnly: false, deleteFlags: ['--pure'] }
const OPENCODE_2: Layout = { table: 'session_v2', topLevelOnly: true, deleteFlags: ['--standalone'] }

/**
 * OpenCode 1.18.32 lists sessions only for the current project, so BMN reads every project's sessions from
 * its database (`time_updated`, epoch ms) and deletes with `opencode session delete <id>`, which works
 * from any directory. It does not refuse a session a live process holds, which is why the runner skips
 * recent ones (docs/agent-history.md). On OpenCode 1, `--pure` keeps the owner's plugins, BMN's own
 * included, out of it; OpenCode 2 never loads BMN's terminal plugin for a delete. Each pass starts with
 * `available()`, which picks the layout from the installed version; a version that cannot be read counts
 * as OpenCode 1. A run always asks the binary. The status view, which looks on every read, reuses the
 * last answer while the binary on PATH is the same unchanged file; a failed read is never reused. The layout
 * travels with each look (`pass`), so a status look that ends while a run is under way cannot change the
 * table or the delete flags that run uses; a caller that hands no layout back gets OpenCode 1's.
 */
export function openCodeHistoryAdapter(options: OpenCodeHistoryOptions): AgentHistoryAdapter {
  const env = options.env ?? process.env
  const store = `${env.XDG_DATA_HOME || `${options.home}/.local/share`}/opencode/opencode.db`
  const binary = (): string | null => findOnPath('opencode', env.PATH)
  const query = <T>(work: Parameters<typeof readOnlyQuery<T>>[2]): T => readOnlyQuery(options.open, store, work)
  let known: { binary: string; layout: Layout } | null = null
  const layoutOf = async (executable: string, fresh: boolean): Promise<Layout> => {
    let identity: string
    try {
      const file = statSync(executable)
      identity = `${realpathSync(executable)}:${file.size}:${file.mtimeMs}`
    } catch {
      identity = executable
    }
    if (!fresh && known?.binary === identity) return known.layout
    const version = await runAgentCommand(executable, ['--version'], { env: agentCommandEnvironment(env), cwd: options.home, timeoutMs: 10_000 })
    const major = version.code === 0 ? Number(/(\d+)\.\d+\.\d+/.exec(version.output)?.[1] ?? NaN) : NaN
    const picked = major >= 2 ? OPENCODE_2 : OPENCODE_1
    known = version.code === 0 ? { binary: identity, layout: picked } : null
    return picked
  }
  return {
    agent: 'opencode',
    async available(look) {
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'opencode is not on PATH', absent: true }
      if (!existsSync(store)) return { ok: false, reason: 'no opencode.db yet', absent: true }
      const layout = await layoutOf(executable, look?.fresh === true)
      const { table } = layout
      try {
        return query((database) => {
          const missing = missingColumns(database, table, ['id', 'time_updated', ...(layout.topLevelOnly ? ['parent_id'] : [])])
          if (missing.length > 0) return { ok: false as const, reason: `${table} has no ${missing.join(', ')}` }
          const row = database.prepare(`SELECT count(*) AS count FROM ${table}${layout.topLevelOnly ? ' WHERE parent_id IS NULL' : ''}`).get() as { count: number }
          return { ok: true as const, sessions: row.count, pass: layout }
        })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'cannot read opencode.db' }
      }
    },
    async candidates(cutoff, pass) {
      const layout = layoutFrom(pass)
      if (layout.topLevelOnly) return familyCandidates(query((database) => database.prepare(familyQuery(layout.table)).all(cutoff)))
      const { table } = layout
      return query((database) => (database
        .prepare(`SELECT id, time_updated FROM ${table} WHERE time_updated < ?`)
        .all(cutoff) as Array<{ id: unknown; time_updated: unknown }>))
        .filter((row): row is { id: string; time_updated: number } =>
          typeof row.id === 'string' && SESSION_ID.test(row.id) && typeof row.time_updated === 'number')
        .map((row): HistoryCandidate => ({ id: row.id, updatedAt: row.time_updated }))
    },
    async remove(id, pass) {
      const layout = layoutFrom(pass)
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'opencode is not on PATH' }
      if (!SESSION_ID.test(id)) return { ok: false, reason: 'not an OpenCode session id' }
      const result = await runAgentCommand(executable, ['session', 'delete', id, ...layout.deleteFlags], { env: agentCommandEnvironment(env), cwd: options.home })
      return result.code === 0 ? { ok: true } : { ok: false, reason: failureLine(result.output) }
    }
  }
}

function layoutFrom(pass: unknown): Layout {
  return pass === OPENCODE_2 ? OPENCODE_2 : OPENCODE_1
}

/**
 * Top-level sessions whose whole family (every session below it by `parent_id`) was last active before
 * the cutoff, with the members and how many of them have no time.
 */
function familyQuery(table: string): string {
  return `WITH RECURSIVE family(root, id, time_updated) AS (
      SELECT id, id, time_updated FROM ${table} WHERE parent_id IS NULL
      UNION
      SELECT family.root, child.id, child.time_updated FROM ${table} AS child JOIN family ON child.parent_id = family.id
    )
    SELECT root AS id, max(time_updated) AS time_updated, group_concat(id, ' ') AS members,
      sum(typeof(time_updated) NOT IN ('integer', 'real')) AS undated
    FROM family GROUP BY root HAVING max(time_updated) < ?`
}

/** familyQuery's rows as candidates; a family with a member that is not a session id or has no time is left alone. */
function familyCandidates(rows: unknown[]): HistoryCandidate[] {
  const candidates: HistoryCandidate[] = []
  for (const row of rows as Array<{ id: unknown; time_updated: unknown; members: unknown; undated: unknown }>) {
    if (typeof row.id !== 'string' || !SESSION_ID.test(row.id) || typeof row.time_updated !== 'number' || row.undated !== 0) continue
    const members = typeof row.members === 'string' ? row.members.split(' ') : []
    if (!members.every((member) => SESSION_ID.test(member))) continue
    const family = members.filter((member) => member !== row.id)
    candidates.push({ id: row.id, updatedAt: row.time_updated, ...(family.length > 0 ? { family } : {}) })
  }
  return candidates
}
