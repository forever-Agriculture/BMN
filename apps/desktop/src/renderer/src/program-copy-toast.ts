// MODULE: program-copy-toast.ts - the words and pacing of the toast after a program copies to the clipboard (Story 42.1)

/** Copies closer together than this share one toast: a yank in a loop is not a stream of announcements. */
export const PROGRAM_COPY_BURST_MS = 1_000

export function programCopyMessage(sessionName: string, characters: number): string {
  return `Copied from ${sessionName} (${characters} ${characters === 1 ? 'character' : 'characters'})`
}

/**
 * Says whether a copy at `at` opens a new toast or belongs to the burst already showing, in which case the toast only
 * updates to the latest copy, the text the clipboard now holds.
 */
export function createProgramCopyBurst(): (at: number) => 'new' | 'same' {
  let last = Number.NEGATIVE_INFINITY
  return (at) => {
    const burst = at - last < PROGRAM_COPY_BURST_MS
    last = at
    return burst ? 'same' : 'new'
  }
}
