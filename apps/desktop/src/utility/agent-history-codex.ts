// MODULE: agent-history-codex.ts - Codex sessions for the history runner: state_5.sqlite read-only, `codex delete --force` to remove (Story 31.2)
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CodexHistoryOptions {
  home: string
  open: OpenReadOnly
  env?: NodeJS.ProcessEnv
}

/**
 * Codex 0.157.1 keeps no history limit of its own. `threads.updated_at` (epoch seconds) moves with every
 * turn, `threads.id` is the rollout UUID BMN binds, and `codex delete --force <uuid>` removes the row
 * and the rollout file, refusing a thread another Codex process holds (docs/agent-history.md).
 */
export function codexHistoryAdapter(options: CodexHistoryOptions): AgentHistoryAdapter {
  const env = options.env ?? process.env
  const codexHome = env.CODEX_HOME || `${options.home}/.codex`
  const store = `${codexHome}/state_5.sqlite`
  const binary = (): string | null => findOnPath('codex', undefined, env)
  const query = <T>(work: Parameters<typeof readOnlyQuery<T>>[2]): T => readOnlyQuery(options.open, store, work)
  return {
    agent: 'codex',
    async available() {
      if (binary() === null) return { ok: false, reason: 'codex is not on PATH', absent: true }
      if (!existsSync(store)) return { ok: false, reason: 'no state_5.sqlite yet', absent: true }
      try {
        return query((database) => {
          const missing = missingColumns(database, 'threads', ['id', 'updated_at'])
          if (missing.length > 0) return { ok: false as const, reason: `threads has no ${missing.join(', ')}` }
          const row = database.prepare('SELECT count(*) AS count FROM threads').get() as { count: number }
          return { ok: true as const, sessions: row.count }
        })
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'cannot read state_5.sqlite' }
      }
    },
    async candidates(cutoff) {
      return query((database) => (database
        .prepare('SELECT id, updated_at FROM threads WHERE updated_at < ?')
        .all(Math.floor(cutoff / 1000)) as Array<{ id: unknown; updated_at: unknown }>))
        .filter((row): row is { id: string; updated_at: number } =>
          typeof row.id === 'string' && UUID.test(row.id) && typeof row.updated_at === 'number')
        .map((row): HistoryCandidate => ({ id: row.id, updatedAt: row.updated_at * 1000 }))
    },
    async remove(id) {
      const executable = binary()
      if (executable === null) return { ok: false, reason: 'codex is not on PATH' }
      if (!UUID.test(id)) return { ok: false, reason: 'not a session UUID' }
      const result = await runAgentCommand(executable, ['delete', '--force', id], { env: agentCommandEnvironment(env), cwd: options.home })
      return result.code === 0 ? { ok: true } : { ok: false, reason: failureLine(result.output) }
    }
  }
}
