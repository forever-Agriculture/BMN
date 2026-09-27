// MODULE: agent-history-claude.ts - reads and writes cleanupPeriodDays in Claude-family settings.json files (Story 31.1)
import { CLAUDE_KEEP_FOREVER_DAYS, type AgentHistoryKeepDays } from '@bmn/protocol'
import {
  ConfigWriteError,
  currentText,
  jsonIndent,
  rewrittenNumbers,
  writeConfigSafely
} from './safe-config-write'

export type ClaudeFolderRead =
  | { ok: true; currentDays: number | null; text: string | null }
  | { ok: false; failure: string }

export type ClaudeFolderWrite =
  | { ok: true; backup: string | null }
  | { ok: false; failure: string }

export function claudeSettingsPath(folder: string): string {
  return `${folder}/settings.json`
}

/** The number BMN writes for a limit: the days themselves, or a century for Never. Never 0. */
export function claudeTargetDays(keepDays: AgentHistoryKeepDays): number {
  return keepDays === null ? CLAUDE_KEEP_FOREVER_DAYS : keepDays
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** What the folder's settings.json says now; a missing file reads as Claude's default. */
export function readClaudeFolder(folder: string): ClaudeFolderRead {
  let text: string | null
  try {
    text = currentText(claudeSettingsPath(folder))
  } catch (error) {
    return { ok: false, failure: `cannot read settings.json (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
  }
  if (text === null) return { ok: true, currentDays: null, text: null }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, failure: 'settings.json is not valid JSON' }
  }
  if (!isRecord(data)) return { ok: false, failure: 'settings.json is not a JSON object' }
  const days = data.cleanupPeriodDays
  if (days === undefined) return { ok: true, currentDays: null, text }
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    return { ok: false, failure: 'cleanupPeriodDays is not a number' }
  }
  return { ok: true, currentDays: days, text }
}

/**
 * Sets `cleanupPeriodDays` and nothing else: every other key keeps its value and order, the file keeps
 * its indent, a copy of the old file is kept beside it, and a file that changed since it was read is
 * left alone. `days` below 1 is refused here, because Claude reads 0 as "keep no history".
 */
export function writeClaudeFolder(folder: string, days: number, beforeCommit?: () => void): ClaudeFolderWrite {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`cleanupPeriodDays must be a whole number of days from 1, not ${days}`)
  const read = readClaudeFolder(folder)
  if (!read.ok) return read
  const data = read.text === null ? {} : JSON.parse(read.text) as Record<string, unknown>
  if (read.text !== null && rewrittenNumbers(read.text).length > 0) {
    return { ok: false, failure: 'settings.json holds a number BMN cannot write back unchanged' }
  }
  const indent = read.text === null ? 2 : jsonIndent(read.text)
  const next = `${JSON.stringify({ ...data, cleanupPeriodDays: days }, null, indent)}\n`
  try {
    const { backup } = writeConfigSafely(claudeSettingsPath(folder), read.text, next,
      beforeCommit === undefined ? {} : { beforeCommit })
    return { ok: true, backup }
  } catch (error) {
    if (error instanceof ConfigWriteError && error.code === 'REVISION_CONFLICT') {
      return { ok: false, failure: 'settings.json changed while BMN was writing; left untouched' }
    }
    return { ok: false, failure: `cannot write settings.json (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
  }
}
