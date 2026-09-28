// MODULE: codex-usage.test.ts - the bounded backwards read of Codex's token_count lines (Story 37.2)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_USAGE_READ_LIMIT, codexUsageFromLine, readCodexUsage } from './codex-usage'

/** The shape codex-cli 0.157.1 writes (recorded 2026-09-28, docs/usage-sources.md), with synthetic values. */
function tokenCount(primary: unknown, secondary: unknown = null): string {
  return JSON.stringify({
    timestamp: '2026-09-28T12:00:00.000Z',
    ordinal: 7,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 },
        last_token_usage: { input_tokens: 600, output_tokens: 40, total_tokens: 640 },
        model_context_window: 258_400
      },
      rate_limits: { limit_id: 'synthetic', primary, secondary, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'synthetic' }
    }
  })
}
const WEEK = { used_percent: 42.4, window_minutes: 10_080, resets_at: 1_790_900_000 }
const FIVE_HOURS = { used_percent: 91, window_minutes: 300, resets_at: 1_790_610_000 }
const message = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: 'token_count is only a word here' }] } })

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bmn-codex-usage-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('codexUsageFromLine', () => {
  it('keeps only the plan windows of a token_count line', () => {
    expect(codexUsageFromLine(tokenCount(WEEK, FIVE_HOURS))).toEqual([
      { minutes: 10_080, usedPercent: 42.4, resetsAt: new Date(1_790_900_000_000).toISOString() },
      { minutes: 300, usedPercent: 91, resetsAt: new Date(1_790_610_000_000).toISOString() }
    ])
  })

  it('reads no other line, even one that mentions token_count, and no malformed window', () => {
    expect(codexUsageFromLine(message)).toBeNull()
    expect(codexUsageFromLine('{"type":"event_msg","payload":{"type":"token_count"')).toBeNull()
    expect(codexUsageFromLine(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'token_count' } }))).toBeNull()
    // A token_count line without limits (an API key) is found, and names no window.
    expect(codexUsageFromLine(tokenCount(null))).toEqual([])
    expect(codexUsageFromLine(tokenCount({ ...WEEK, used_percent: -1 }))).toEqual([])
    expect(codexUsageFromLine(tokenCount({ ...WEEK, window_minutes: 1.5 }))).toEqual([])
    expect(codexUsageFromLine(tokenCount({ ...WEEK, resets_at: 1_790_900_000_000 }))).toEqual([])
    expect(codexUsageFromLine(tokenCount({ ...WEEK, resets_at: '1790900000' }))).toEqual([])
  })
})

describe('readCodexUsage', () => {
  const file = (lines: string[], trailingNewline = true): string => {
    const path = join(root, 'rollout-2026-09-28T12-00-00-01a0e82f-81fe-7f70-b2d6-df18576f6cb9.jsonl')
    writeFileSync(path, lines.join('\n') + (trailingNewline ? '\n' : ''))
    return path
  }

  it('takes the newest token_count line, reading from the end', async () => {
    const path = file([tokenCount({ ...WEEK, used_percent: 10 }), message, tokenCount(WEEK), message, message])
    await expect(readCodexUsage(path)).resolves.toEqual([expect.objectContaining({ usedPercent: 42.4 })])
  })

  it('finds a line that spans read chunks, the file\'s first line, and a last line without a newline', async () => {
    const padding = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(100_000) } })
    await expect(readCodexUsage(file([message, tokenCount(WEEK), padding]))).resolves.toHaveLength(1)
    await expect(readCodexUsage(file([tokenCount(WEEK)], false))).resolves.toHaveLength(1)
    await expect(readCodexUsage(file([message, tokenCount(FIVE_HOURS)], false))).resolves.toEqual([
      expect.objectContaining({ minutes: 300 })
    ])
  })

  it('stops after 256 KiB from the end, and never parses a line cut by that limit', async () => {
    const filler = Array.from({ length: 40 }, () => JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(8_000) } }))
    const path = file([tokenCount(WEEK), ...filler])
    await expect(readCodexUsage(path)).resolves.toBeNull()
    await expect(readCodexUsage(path, CODEX_USAGE_READ_LIMIT * 2)).resolves.toHaveLength(1)
  })

  it('reads as nothing when the file is missing or empty', async () => {
    await expect(readCodexUsage(join(root, 'missing.jsonl'))).resolves.toBeNull()
    await expect(readCodexUsage(file([], false))).resolves.toBeNull()
  })
})
