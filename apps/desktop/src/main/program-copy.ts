// MODULE: program-copy.ts - clipboard writes live programs ask for with OSC 52, under the owner's setting (Story 42.1)
import type { ProgramCopyMessage, ProgramCopyNotice, ProgramCopyTarget } from '@bmn/protocol'

export interface ProgramCopyActions {
  /** The owner's choice, read at each copy so turning it off takes effect at once. */
  allowed(): Promise<boolean>
  /** Writes one target as plain text; false when this platform has no such target (the primary selection off Linux). */
  write(target: ProgramCopyTarget, text: string): Promise<boolean>
  announce(notice: ProgramCopyNotice): void
}

/**
 * Carries out copies one at a time, in the order the programs asked, so an earlier write never lands after a later
 * one. Nothing goes back to the program: it learns neither the outcome nor what the clipboard held.
 */
export function createProgramCopy(actions: ProgramCopyActions): (message: ProgramCopyMessage) => Promise<void> {
  let queue = Promise.resolve()
  return (message) => {
    queue = queue
      .then(async () => {
        if (!(await actions.allowed())) return
        let written = false
        for (const target of message.targets) {
          if (await actions.write(target, message.text)) written = true
        }
        if (written) actions.announce({ sessionId: message.sessionId, characters: [...message.text].length })
      })
      // A host that is gone or a clipboard that refused says nothing to the program; the next copy still runs.
      .catch(() => undefined)
    return queue
  }
}
