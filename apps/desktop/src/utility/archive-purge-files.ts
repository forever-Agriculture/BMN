// MODULE: archive-purge-files.ts - what the host removes from disk once the archive purge has committed
import type { ArchivePurgeResult } from './database-archive-purge'

interface PurgeFileSteps {
  savedOutput(sessionIds: readonly string[]): Promise<void>
  originals(originals: ArchivePurgeResult['originals']): Promise<{ removed: number; failed: number }>
}

/** The host's one log line for a purge: what was deleted, and how many files could not be removed. */
export function archivePurgeMessage(
  purged: Pick<ArchivePurgeResult, 'sessionIds' | 'workspaceIds'>,
  files: { removed: number; failed: number }
): string {
  return `[BMN] deleted ${purged.sessionIds.length} archived session(s), ${purged.workspaceIds.length} archived workspace(s) ` +
    `and ${files.removed} file(s)${files.failed > 0 ? `; ${files.failed} file(s) could not be removed` : ''}`
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error').slice(0, 240)

/**
 * Removes the deleted sessions' saved output and files and returns the lines to log. The records are
 * already gone and no later purge will name these files again, so each store is cleaned by itself: a
 * failure in one never leaves the other's files behind.
 */
export async function removePurgedFiles(purged: ArchivePurgeResult, steps: PurgeFileSteps): Promise<string[]> {
  const [output, files] = await Promise.allSettled([
    steps.savedOutput(purged.sessionIds),
    steps.originals(purged.originals)
  ])
  const lines = [archivePurgeMessage(purged, files.status === 'fulfilled'
    ? files.value
    : { removed: 0, failed: purged.originals.length })]
  if (output.status === 'rejected') lines.push(`[BMN] archive cleanup failed for saved output: ${reason(output.reason)}`)
  if (files.status === 'rejected') lines.push(`[BMN] archive cleanup failed for files: ${reason(files.reason)}`)
  return lines
}
