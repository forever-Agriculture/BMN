// MODULE: database-hook-card-store.ts - Story 113.5 AC3: one text-free row per card call of a hook run, newest rows kept
import { HOOK_CARD_LIMITS, type HookCardRecord } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'

export interface HookCardRunCall {
  runId: string
  sessionId: string
  incarnationId: string | null
  agent: string
  event: string
  cards: readonly HookCardRecord[]
}

/**
 * Keeps what each card call of one hook run came to: ids, the call, its outcome and the rule a refusal named. No title,
 * body, prompt, answer or reason text is stored (113.5 AC3). A run reported twice keeps its first rows. Past the row
 * limit the oldest rows go, so dev-auto's interruptions.py reads a bounded, recent window.
 */
export function recordHookCards(database: DatabaseConnection, call: HookCardRunCall, now: string): { recorded: number } {
  if (call.cards.length === 0) return { recorded: 0 }
  // ON CONFLICT, not OR IGNORE: only a repeated run is skipped; a row breaking a CHECK still fails.
  const insert = database.prepare(`INSERT INTO hook_card_record(run_id, position, session_id, incarnation_id, agent, event, method,
    request_key, kind, tool_call_id, outcome, rule_source, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, position) DO NOTHING`)
  let recorded = 0
  database.transaction(() => {
    call.cards.slice(0, HOOK_CARD_LIMITS.perRun).forEach((card, position) => {
      recorded += Number(insert.run(call.runId, position, call.sessionId, call.incarnationId, call.agent, call.event, card.method, card.requestKey,
        card.kind, card.toolCallId, card.outcome, card.ruleSource, now).changes)
    })
    database.prepare(`DELETE FROM hook_card_record WHERE rowid IN (SELECT rowid FROM hook_card_record ORDER BY rowid DESC LIMIT -1 OFFSET ?)`)
      .run(HOOK_CARD_LIMITS.rows)
  })()
  return { recorded }
}

export const HOOK_CARD_OPERATIONS = Object.freeze({ recordHookCards })
