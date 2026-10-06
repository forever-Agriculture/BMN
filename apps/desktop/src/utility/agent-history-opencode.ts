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

// OpenCode 1.18.31 session IDs (bin/bmn OPENCODE_REFERENCE).
const SESSION_ID = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/

export interface OpenCodeHistoryOptions {
  home: string
  open: OpenReadOnly
  env?: NodeJS.ProcessEnv
}

/**
 * OpenCode 1.18.32 lists sessions only for the current project, so BMN reads every project's sessions from
 * its database (`time_updated`, epoch ms) and deletes with `opencode session delete <id>`, which works
 * from any directory. It does not refuse a session a live process holds, which is why the runner skips
 * recent ones (docs/agent-history.md). `--pure` keeps the owner's plugins, BMN's own included, out of it.
 */
export function openCodeHistoryAdapter(options: OpenCodeHistoryOptions): AgentHistoryAdapter {
  const env = options.env ?? process.env
  const store = `${env.XDG_DATA_HOME || `${options.home}/.local/share`}/opencode/opencode.db`
  const binary = (): string | null => findOnPath('opencode', undefined, env)
  const query = <T>(work: Parameters<typeof readOnlyQuery<T>>[2]): T => readOnlyQuery(options.open, store, work)
  return {
    agent: 'opencode',
    async available() {
      if (binary() === null) return { ok: false, reason: 'opencode is not on PATH', absent: true }
      if (!existsSync(store)) return { ok: false, reason: 'no opencode.db yet', absent: true }
      try {
        return query((database) => {
          const missing = missingColumns(database, 'session', ['id', 'time_updated'])
          if (missing.length > 0) return { ok: false as const, reason: `session has no ${missing.join(', ')}` }
          const row = database.prepare('SELECT count(*) AS count FROM session').get() as { count: number }
          return { ok: true as const, sessions: row.count }
        })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'cannot read opencode.db' }
      }
    },
    async candidates(cutoff) {
      return query((database) => (database
        .prepare('SELECT id, time_updated FROM session WHERE time_updated < ?')
        .all(cutoff) as Array<{ id: unknown; time_updated: unknown }>))
        .filter((row): row is { id: string; time_updated: number } =>
          typeof row.id === 'string' && SESSION_ID.test(row.id) && typeof row.time_updated === 'number')
        .map((row): HistoryCandidate => ({ id: row.id, updatedAt: row.time_updated }))
    },
    async remove(id) {
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'opencode is not on PATH' }
      if (!SESSION_ID.test(id)) return { ok: false, reason: 'not an OpenCode session id' }
      const result = await runAgentCommand(executable, ['session', 'delete', id, '--pure'], { env: agentCommandEnvironment(env), cwd: options.home })
      return result.code === 0 ? { ok: true } : { ok: false, reason: failureLine(result.output) }
    }
  }
}
