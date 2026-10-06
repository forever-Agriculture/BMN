// MODULE: file-replace.ts - Atomic replacement that leaves no temporary file behind and says when a target is locked.
// Windows refuses to replace a file another program holds open (EPERM, EBUSY or EACCES from rename). The target
// keeps its previous complete contents either way; these helpers remove the staged copy and turn that refusal into
// an error a person can act on, keeping the original code for callers that branch on it.
import { renameSync, rmSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'

const WINDOWS_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** The error to report for a refused replacement of `target`: a locked target is named as such; anything else is unchanged. */
export function replacementError(error: unknown, target: string, platform: NodeJS.Platform = process.platform): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === undefined || !(code === 'EBUSY' || (platform === 'win32' && WINDOWS_LOCK_CODES.has(code)))) return error
  const locked = new Error(`${target} is in use or locked by another program; close it there and try again (${code})`,
    { cause: error }) as NodeJS.ErrnoException
  locked.code = code
  return locked
}

/** Moves a fully written `temporary` over `target`; on failure the temporary is removed and the target is untouched. */
export async function replaceFile(temporary: string, target: string,
  { platform = process.platform, move = rename }: { platform?: NodeJS.Platform; move?: typeof rename } = {}): Promise<void> {
  try {
    await move(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw replacementError(error, target, platform)
  }
}

/** Synchronous `replaceFile`. */
export function replaceFileSync(temporary: string, target: string,
  { platform = process.platform, move = renameSync }: { platform?: NodeJS.Platform; move?: typeof renameSync } = {}): void {
  try {
    move(temporary, target)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* nothing staged remains to remove */ }
    throw replacementError(error, target, platform)
  }
}
