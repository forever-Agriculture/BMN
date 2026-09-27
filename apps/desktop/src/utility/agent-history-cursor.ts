// MODULE: agent-history-cursor.ts - Cursor's row in the history section: it keeps its own chats, and BMN deletes none (Story 31.3 AC3)
import { existsSync } from 'node:fs'
import type { AgentHistoryAdapter } from './agent-history'
import { findOnPath } from './agent-history-store'

export interface CursorHistoryOptions {
  home: string
  env?: NodeJS.ProcessEnv
}

/**
 * cursor-agent 2026.09.26-dd393fe keeps each chat under `~/.cursor/chats/<md5 of the workspace>/<id>/` and has
 * no command to delete one (its `delete` subcommands are for automations and environments; docs/agent-control.md).
 * BMN never removes an agent's files itself, so the row only says Cursor keeps its own history.
 */
export function cursorHistoryAdapter(options: CursorHistoryOptions): AgentHistoryAdapter {
  const env = options.env ?? process.env
  return {
    agent: 'cursor',
    async available() {
      if (findOnPath('cursor-agent', env.PATH) === null && !existsSync(`${options.home}/.cursor/chats`)) {
        return { ok: false, reason: 'cursor-agent is not on PATH', absent: true }
      }
      return { ok: false, reason: 'Cursor has no command to delete a chat', own: true }
    },
    async candidates() {
      return []
    },
    async remove() {
      return { ok: false, reason: 'Cursor has no command to delete a chat' }
    }
  }
}
