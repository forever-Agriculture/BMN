// MODULE: agent-history-claude.ts - reads and writes cleanupPeriodDays in Claude-family settings.json files (Story 31.1)
import { CLAUDE_KEEP_FOREVER_DAYS, type AgentHistoryKeepDays } from '@bmn/protocol'
import {
  ConfigWriteError,
  currentText,
  jsonIndent,
  linkTarget,
  rewrittenNumbers,
  writeConfigSafely
} from './safe-config-write'
import { writeConfigInWorker } from './config-write-worker'

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
type ClaudeFolderEdit = { ok: true; path: string; expectedTarget: string; text: string | null; next: string } | { ok: false; failure: string }

function prepareClaudeFolderWrite(folder: string, days: number): ClaudeFolderEdit {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`cleanupPeriodDays must be a whole number of days from 1, not ${days}`)
  const path = claudeSettingsPath(folder)
  let expectedTarget: string
  try { expectedTarget = linkTarget(path) } catch {
    return { ok: false, failure: 'cannot resolve settings.json target; left untouched' }
  }
  const read = readClaudeFolder(folder)
  if (!read.ok) return read
  const data = read.text === null ? {} : JSON.parse(read.text) as Record<string, unknown>
  if (read.text !== null && rewrittenNumbers(read.text).length > 0) {
    return { ok: false, failure: 'settings.json holds a number BMN cannot write back unchanged' }
  }
  const indent = read.text === null ? 2 : jsonIndent(read.text)
  const next = `${JSON.stringify({ ...data, cleanupPeriodDays: days }, null, indent)}\n`
  return { ok: true, path, expectedTarget, text: read.text, next }
}

function writeFailure(error: unknown): ClaudeFolderWrite {
  if (error instanceof ConfigWriteError && error.code === 'REVISION_CONFLICT') {
    return { ok: false, failure: 'settings.json changed while BMN was writing; left untouched' }
  }
  return { ok: false, failure: `cannot confirm settings.json write (${(error as NodeJS.ErrnoException).code ?? 'error'}); inspect retained backup/staged files` }
}

export function writeClaudeFolder(folder: string, days: number, beforeCommit?: () => void): ClaudeFolderWrite {
  const edit = prepareClaudeFolderWrite(folder, days)
  if (!edit.ok) return edit
  try {
    const { backup } = writeConfigSafely(edit.path, edit.text, edit.next, { ...(beforeCommit === undefined ? {} : { beforeCommit }), expectedTarget: edit.expectedTarget })
    return { ok: true, backup }
  } catch (error) { return writeFailure(error) }
}

/** Native ACL/replacement work runs away from the terminal service's event loop. */
export async function writeClaudeFolderAsync(folder: string, days: number, modulePath: string): Promise<ClaudeFolderWrite> {
  const edit = prepareClaudeFolderWrite(folder, days)
  if (!edit.ok) return edit
  try {
    const { backup } = await writeConfigInWorker(modulePath, edit)
    return { ok: true, backup }
  } catch (error) { return writeFailure(error) }
}
