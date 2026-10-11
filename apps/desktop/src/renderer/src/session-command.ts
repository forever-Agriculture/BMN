// MODULE: session-command.ts - Story 60.13: types one command into a new shell session only once its shell reads a command line, and says when it reads one again; kept pure for tests

/** How a press that runs a command in a new session went: typed with its Enter, nothing typed because the shell never read a command line, or no session at all. */
export type CommandStart = 'typed' | 'not-reading' | 'failed'

/**
 * Opens a new shell session and runs `command` there; `onEnded` is told once that shell reads a command line
 * again. `left` ends the wait for the shell: the owner went away from where he pressed, so nothing is typed after it.
 */
export type RunInSession = (name: string, command: string, onEnded: () => void, left: AbortSignal) => Promise<CommandStart>

/**
 * What bash writes around every command line it reads: its line editor turns bracketed paste on when it starts
 * to read one and off once it has it. A start-up file that reads the terminal itself writes neither.
 */
const PASTE_MODE = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34] // ESC [ ? 2 0 0 4
const ON = 0x68 // h
const OFF = 0x6c // l

/**
 * Follows one session's output, chunk by chunk: for each time its shell started to read a command line
 * `true`, and for each time it took one `false`, in the order written.
 */
export function lineReading(): (bytes: Uint8Array) => boolean[] {
  let matched = 0
  return (bytes) => {
    const changes: boolean[] = []
    for (const byte of bytes) {
      if (matched === PASTE_MODE.length) {
        if (byte === ON) changes.push(true)
        else if (byte === OFF) changes.push(false)
        matched = 0
      }
      matched = byte === PASTE_MODE[matched] ? matched + 1 : byte === PASTE_MODE[0] ? 1 : 0
    }
    return changes
  }
}

export interface SessionCommandRun {
  /** Output of any session, given from before the new one is asked for: its first bytes can arrive before its name is known here. */
  output(attachmentId: string, bytes: Uint8Array): void
  /** A session ended. */
  exit(attachmentId: string): void
  /**
   * Names the session that was made. Answers true once the command was typed with its Enter, which happens only
   * while its shell reads a command line; false when it did not within the wait, or ended first: nothing is typed then.
   */
  typeInto(attachmentId: string, send: (bytes: Uint8Array) => void): Promise<boolean>
  /** The owner went away before the command was typed: it will not be. Changes nothing once it was typed. */
  leave(): void
  /** Settles once that shell reads a command line again after the command, its session ended or the watch ran out; never where nothing was typed. */
  ended: Promise<void>
}

interface Clock { set(run: () => void, ms: number): unknown; clear(timer: unknown): void }

const REAL_CLOCK: Clock = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

/** One command for one new session. Nothing here opens the session or decides the command: it is typed as given, with its Enter. */
export function sessionCommandRun(command: string, limits: { readyWithinMs: number; watchForMs: number }, clock: Clock = REAL_CLOCK): SessionCommandRun {
  const followers = new Map<string, (bytes: Uint8Array) => boolean[]>()
  const reading = new Map<string, boolean>()
  const gone = new Set<string>()
  let own: string | null = null
  let onReading: (() => void) | null = null
  let onGone: (() => void) | null = null
  let onLeft: (() => void) | null = null
  let left = false
  let finish = (): void => {}
  const ended = new Promise<void>((resolve) => { finish = resolve })
  return {
    ended,
    output(attachmentId, bytes) {
      if (own !== null && attachmentId !== own) return
      let follow = followers.get(attachmentId)
      if (follow === undefined) followers.set(attachmentId, follow = lineReading())
      for (const reads of follow(bytes)) {
        reading.set(attachmentId, reads)
        if (reads && attachmentId === own) onReading?.()
      }
    },
    exit(attachmentId) {
      gone.add(attachmentId)
      if (attachmentId === own) onGone?.()
    },
    leave() {
      left = true
      onLeft?.()
    },
    typeInto(attachmentId, send) {
      own = attachmentId
      for (const other of [...followers.keys()]) if (other !== attachmentId) followers.delete(other)
      return new Promise<boolean>((resolve) => {
        const type = (): void => {
          try {
            send(new TextEncoder().encode(`${command}\r`))
          } catch {
            // The session cannot be typed into: nothing ran, and the output this was called from is not held up.
            leave()
            return
          }
          clock.clear(waiting)
          const over = (): void => {
            clock.clear(watching)
            onReading = onGone = null
            finish()
          }
          const watching = clock.set(over, limits.watchForMs)
          onReading = onGone = over
          onLeft = null
          resolve(true)
        }
        const leave = (): void => {
          clock.clear(waiting)
          onReading = onGone = onLeft = null
          resolve(false)
        }
        const waiting = clock.set(leave, limits.readyWithinMs)
        if (left || gone.has(attachmentId)) leave()
        else if (reading.get(attachmentId) === true) type()
        else {
          onReading = type
          onGone = onLeft = leave
        }
      })
    }
  }
}

/** Where a press on a button that runs a command in a new session stands. */
export type CommandPress = 'idle' | 'opening' | CommandStart

/** Whether that button takes a press: once, and again only where no session could be opened, so no second session runs the command beside the first. */
export function takesPress(press: CommandPress): boolean {
  return press === 'idle' || press === 'failed'
}
