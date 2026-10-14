// MODULE: agent-history-opencode.ts - OpenCode sessions for the history runner: opencode.db read-only, `opencode session delete` to remove (Story 31.2)
import { existsSync } from 'node:fs'
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
 * session's children with it, so only top-level sessions are offered; `--standalone` runs the delete
 * on a private server instead of the shared background service.
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
 * `available()`, which reads the installed version; a version that cannot be read counts as OpenCode 1.
 */
export function openCodeHistoryAdapter(options: OpenCodeHistoryOptions): AgentHistoryAdapter {
  const env = options.env ?? process.env
  const store = `${env.XDG_DATA_HOME || `${options.home}/.local/share`}/opencode/opencode.db`
  const binary = (): string | null => findOnPath('opencode', env.PATH)
  const query = <T>(work: Parameters<typeof readOnlyQuery<T>>[2]): T => readOnlyQuery(options.open, store, work)
  let layout = OPENCODE_1
  return {
    agent: 'opencode',
    async available() {
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'opencode is not on PATH', absent: true }
      if (!existsSync(store)) return { ok: false, reason: 'no opencode.db yet', absent: true }
      const version = await runAgentCommand(executable, ['--version'], { env: agentCommandEnvironment(env), cwd: options.home, timeoutMs: 10_000 })
      const major = version.code === 0 ? Number(/(\d+)\.\d+\.\d+/.exec(version.output)?.[1] ?? NaN) : NaN
      layout = major >= 2 ? OPENCODE_2 : OPENCODE_1
      const { table } = layout
      try {
        return query((database) => {
          const missing = missingColumns(database, table, ['id', 'time_updated', ...(layout.topLevelOnly ? ['parent_id'] : [])])
          if (missing.length > 0) return { ok: false as const, reason: `${table} has no ${missing.join(', ')}` }
          const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
          return { ok: true as const, sessions: row.count }
        })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'cannot read opencode.db' }
      }
    },
    async candidates(cutoff) {
      const { table, topLevelOnly } = layout
      return query((database) => (database
        .prepare(`SELECT id, time_updated FROM ${table} WHERE time_updated < ?${topLevelOnly ? ' AND parent_id IS NULL' : ''}`)
        .all(cutoff) as Array<{ id: unknown; time_updated: unknown }>))
        .filter((row): row is { id: string; time_updated: number } =>
          typeof row.id === 'string' && SESSION_ID.test(row.id) && typeof row.time_updated === 'number')
        .map((row): HistoryCandidate => ({ id: row.id, updatedAt: row.time_updated }))
    },
    async remove(id) {
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'opencode is not on PATH' }
      if (!SESSION_ID.test(id)) return { ok: false, reason: 'not an OpenCode session id' }
      const result = await runAgentCommand(executable, ['session', 'delete', id, ...layout.deleteFlags], { env: agentCommandEnvironment(env), cwd: options.home })
      return result.code === 0 ? { ok: true } : { ok: false, reason: failureLine(result.output) }
    }
  }
}
