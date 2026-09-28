// MODULE: codex-usage.ts - reads Codex's plan windows from the tail of its own session file (Story 37.2)
import { open } from 'node:fs/promises'
import { MAX_USAGE_WINDOWS, type UsageWindow } from '@bmn/protocol'

/** How far back from the end the reader looks before it gives up (Story 37.1 AC3). */
export const CODEX_USAGE_READ_LIMIT = 256 * 1024
const CHUNK = 64 * 1024

/**
 * The plan windows of one `token_count` line (empty when it carries none), or null when the line is
 * anything else. Only `rate_limits.primary` and `.secondary` are read; token totals, credits and every
 * other line of the transcript are never kept (Epic 37 owner decision).
 */
export function codexUsageFromLine(line: string): UsageWindow[] | null {
  // Cheap tests first: most lines are conversation, and they are never parsed.
  if (!line.includes('"token_count"') || !line.includes('"event_msg"')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.type !== 'event_msg' || !isObject(parsed.payload) ||
    parsed.payload.type !== 'token_count') return null
  const limits = isObject(parsed.payload.rate_limits) ? parsed.payload.rate_limits : {}
  const windows: UsageWindow[] = []
  for (const name of ['primary', 'secondary']) {
    const window = limits[name]
    if (!isObject(window)) continue
    const { used_percent: used, window_minutes: minutes, resets_at: resets } = window
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1000) continue
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 527_040) continue
    // Epoch seconds, as measured on codex-cli 0.157.1.
    if (typeof resets !== 'number' || !Number.isFinite(resets) || resets < 1e9 || resets > 1e10) continue
    windows.push({ minutes, usedPercent: used, resetsAt: new Date(resets * 1000).toISOString() })
  }
  return windows.slice(0, MAX_USAGE_WINDOWS)
}

/**
 * The newest `token_count` line's windows, read backwards from the end of the file in 64 KiB steps and
 * never further than `limit` bytes. Null when the file cannot be read or holds no such line that far back.
 */
export async function readCodexUsage(path: string, limit = CODEX_USAGE_READ_LIMIT): Promise<UsageWindow[] | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const size = (await handle.stat()).size
    const floor = Math.max(0, size - limit)
    let end = size
    // Bytes after the last newline seen so far: the start of a line that began in an earlier chunk.
    let carry = Buffer.alloc(0)
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      const joined = Buffer.concat([chunk.subarray(0, bytesRead), carry])
      let cut = joined.length
      for (let index = joined.length - 1; index >= 0; index -= 1) {
        if (joined[index] !== 0x0a) continue
        const found = codexUsageFromLine(joined.subarray(index + 1, cut).toString('utf8'))
        if (found !== null) return found
        cut = index
      }
      carry = joined.subarray(0, cut)
      end = start
    }
    // The file's first line has no newline before it; a line cut by the limit is never complete.
    return floor === 0 ? codexUsageFromLine(carry.toString('utf8')) : null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
