// MODULE: database-hook-card-store.test.ts - Story 113.5 AC3: text-free hook card records, first rows kept, newest rows kept
import { createRequire } from 'node:module'
import { HOOK_CARD_LIMITS, type HookCardRecord } from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordHookCards } from './database-hook-card-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const T0 = '2026-11-08T15:00:00.000Z'
let database: DatabaseConnection
beforeEach(() => { database = new BetterSqlite3(':memory:'); initializeDatabase(database, T0) })
afterEach(() => database.close())

const RUN = '0b6f5a52-7f0e-4c1e-9a43-2f0a8f5b7c11'
const card = (over: Partial<HookCardRecord> = {}): HookCardRecord => ({ method: 'open', requestKey: 'claude:question', kind: 'question', toolCallId: 'toolu_1', outcome: 'opened', ruleSource: null, ...over })
const rows = () => database.prepare('SELECT * FROM hook_card_record ORDER BY rowid').all() as Record<string, unknown>[]

describe('recordHookCards (Story 113.5 AC3)', () => {
  it('keeps one row per card call with ids and outcomes only', () => {
    expect(recordHookCards(database, { runId: RUN, sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'PreToolUse', cards: [card(), card({ method: 'withdraw', requestKey: 'claude:turn', kind: null, toolCallId: null, outcome: 'unchanged' })] }, T0)).toEqual({ recorded: 2 })
    expect(rows()).toEqual([
      { run_id: RUN, position: 0, session_id: 's1', incarnation_id: 'i1', agent: 'claude', event: 'PreToolUse', method: 'open', request_key: 'claude:question', kind: 'question', tool_call_id: 'toolu_1', outcome: 'opened', rule_source: null, observed_at: T0 },
      { run_id: RUN, position: 1, session_id: 's1', incarnation_id: 'i1', agent: 'claude', event: 'PreToolUse', method: 'withdraw', request_key: 'claude:turn', kind: null, tool_call_id: null, outcome: 'unchanged', rule_source: null, observed_at: T0 }
    ])
    // No column can hold a title, body, prompt, answer or reason.
    expect(Object.keys(rows()[0]!).sort()).toEqual(['agent', 'event', 'incarnation_id', 'kind', 'method', 'observed_at', 'outcome', 'position', 'request_key', 'rule_source', 'run_id', 'session_id', 'tool_call_id'])
  })

  it('records a refusal with its rule, and the database refuses a rule on anything else', () => {
    recordHookCards(database, { runId: RUN, sessionId: 's1', incarnationId: null, agent: 'codex', event: 'PreToolUse', cards: [card({ requestKey: 'codex:question', outcome: 'refused', ruleSource: 'away-question-refusal' })] }, T0)
    expect(rows()[0]).toMatchObject({ outcome: 'refused', rule_source: 'away-question-refusal', incarnation_id: null })
    expect(() => recordHookCards(database, { runId: '1b6f5a52-7f0e-4c1e-9a43-2f0a8f5b7c11', sessionId: 's1', incarnationId: null, agent: 'codex', event: 'PreToolUse', cards: [card({ ruleSource: 'away-question-refusal' })] }, T0)).toThrow()
  })

  it('a run reported twice keeps its first rows; an empty run writes nothing', () => {
    const call = { runId: RUN, sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'Stop', cards: [card({ outcome: 'withdrew', method: 'withdraw' })] }
    recordHookCards(database, call, T0)
    expect(recordHookCards(database, { ...call, cards: [card()] }, T0)).toEqual({ recorded: 0 })
    expect(recordHookCards(database, { ...call, runId: '2b6f5a52-7f0e-4c1e-9a43-2f0a8f5b7c11', cards: [] }, T0)).toEqual({ recorded: 0 })
    expect(rows().map(row => row.outcome)).toEqual(['withdrew'])
  })

  it('keeps only the newest rows past the limit', () => {
    const limit = HOOK_CARD_LIMITS.rows
    const insert = database.prepare(`INSERT INTO hook_card_record(run_id, position, session_id, incarnation_id, agent, event, method, request_key, kind, tool_call_id, outcome, rule_source, observed_at)
      VALUES (?, 0, 's1', NULL, 'claude', 'Stop', 'withdraw', 'claude:turn', NULL, NULL, 'withdrew', NULL, ?)`)
    database.transaction(() => { for (let index = 0; index < limit; index++) insert.run(`old-${index}`, T0) })()
    recordHookCards(database, { runId: RUN, sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'PreToolUse', cards: [card()] }, T0)
    expect((database.prepare('SELECT COUNT(*) AS n FROM hook_card_record').get() as { n: number }).n).toBe(limit)
    expect(database.prepare("SELECT run_id FROM hook_card_record WHERE run_id = 'old-0'").get()).toBeUndefined()
    expect(database.prepare('SELECT run_id FROM hook_card_record WHERE run_id = ?').get(RUN)).toBeDefined()
  })
})
