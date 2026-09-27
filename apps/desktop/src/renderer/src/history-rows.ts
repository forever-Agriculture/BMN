// MODULE: history-rows.ts - the words Preferences → History shows: values, pending changes, run results and the one confirm sentence
import {
  CLAUDE_KEEP_FOREVER_DAYS,
  MAX_DELETIONS_PER_RUN,
  type AgentHistoryAgent,
  type AgentHistoryAgentRow,
  type AgentHistoryClaudeFolder,
  type AgentHistoryKeepDays,
  type AgentHistoryStatus
} from '@bmn/protocol'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const AGENT_NAMES: Readonly<Record<AgentHistoryAgent, string>> = Object.freeze({
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
})

/** `28 Sep`, in the owner's local time. */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** `28 Sep 14:02`, in the owner's local time. */
export function shortDateTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${shortDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function keepLabel(days: AgentHistoryKeepDays): string {
  return days === null ? 'Never' : `${days} days`
}

/** A `cleanupPeriodDays` value as the owner reads it; unset is Claude's own default. */
export function claudeDaysLabel(days: number | null): string {
  if (days === null) return 'Claude default'
  if (days >= CLAUDE_KEEP_FOREVER_DAYS) return 'Never'
  return days === 1 ? '1 day' : `${days} days`
}

export function sessionsLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`
}

/** Column 3 of a row: either a pending `now → next`, or a settled value with an optional date. */
export type HistoryValue =
  | { kind: 'pending'; now: string; next: string }
  | { kind: 'settled'; text: string; title?: string }

export function folderValue(folder: AgentHistoryClaudeFolder): HistoryValue {
  if (folder.pending) {
    return { kind: 'pending', now: claudeDaysLabel(folder.currentDays), next: claudeDaysLabel(folder.targetDays) }
  }
  const value = claudeDaysLabel(folder.currentDays)
  if (folder.applied && folder.applied.days === folder.currentDays) {
    return { kind: 'settled', text: `${value} · applied ${shortDate(folder.applied.at)}`, title: folder.applied.at }
  }
  return { kind: 'settled', text: value }
}

export function agentValue(row: AgentHistoryAgentRow, status: AgentHistoryStatus): HistoryValue {
  if (row.state === 'own') return { kind: 'settled', text: 'keeps its own history' }
  if (row.state === 'unrecognised') return { kind: 'settled', text: 'not recognised' }
  const candidates = row.candidates ?? 0
  if (status.needsConfirmation && status.keepDays !== null) {
    return { kind: 'settled', text: `${candidates} to delete` }
  }
  const run = row.lastRun
  if (run === undefined) return { kind: 'settled', text: candidates === 0 ? 'nothing to delete' : `${candidates} next run` }
  const left = run.remaining > 0 ? ` · ${run.remaining} next run` : ''
  return { kind: 'settled', text: `${run.deleted} deleted ${shortDateTime(run.at)}${left}`, title: run.at }
}

/** The muted second line under a row, or null. Detail goes in its title. */
export function agentFailure(row: AgentHistoryAgentRow): { text: string; title: string } | null {
  if (row.state === 'unrecognised') {
    return { text: `not recognised: ${row.detail ?? 'unknown store'}`, title: row.detail ?? '' }
  }
  const failures = row.lastRun?.failures ?? []
  if (failures.length === 0) return null
  const first = failures[0]!
  return {
    text: `${failures.length} failed: ${first.reason}`,
    title: failures.map((failure) => `${failure.id}: ${failure.reason}`).join('\n')
  }
}

/** Sessions Start cleanup would delete now, across every managed agent. */
export function pendingDeletions(status: AgentHistoryStatus): number {
  if (status.keepDays === null) return 0
  return status.agents.reduce((sum, row) => sum + (row.state === 'managed' ? row.candidates ?? 0 : 0), 0)
}

/** The one sentence beside Start cleanup, counts included. */
export function confirmSentence(status: AgentHistoryStatus): string {
  const deletions = pendingDeletions(status)
  const folders = status.claude.filter((folder) => folder.pending).length
  const batches = status.agents.some((row) => (row.candidates ?? 0) > MAX_DELETIONS_PER_RUN) ? ', in batches of 200' : ''
  const write = folders === 0 ? '' : `Sets ${folders === 1 ? '1 Claude folder' : `${folders} Claude folders`} to ${keepLabel(status.keepDays)}`
  if (deletions === 0) return write === '' ? `Applies ${keepLabel(status.keepDays)} to every agent.` : `${write}.`
  const remove = `${deletions === 1 ? 'Deletes 1 session' : `Deletes ${deletions} sessions`} for good${batches}.`
  return write === '' ? remove : `${write}; ${remove.charAt(0).toLowerCase()}${remove.slice(1)}`
}

/** The help line under Keep agent history; while a shorter limit waits, it says which one is in force. */
export function keepHelp(status: AgentHistoryStatus): string {
  const confirmed = status.confirmedKeepDays
  if (confirmed !== undefined && confirmed !== status.keepDays) {
    return `${keepLabel(confirmed)} stays in force until you confirm ${keepLabel(status.keepDays)}`
  }
  return 'Each agent deletes sessions untouched longer.'
}
