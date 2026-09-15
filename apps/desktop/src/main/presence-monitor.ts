// MODULE: presence-monitor.ts - tells whether the owner is at the machine from desktop input idle time
import { execFile } from 'node:child_process'

export interface OwnerPresence {
  away: boolean
}

/** Claude Code treats a terminal interaction within the last minute as the owner watching; this matches it. */
export const AWAY_AFTER_MS = 60_000
/** While away, the return is noticed within this long. */
const AWAY_CHECK_MS = 2_000
/** Checks again this often while the idle time cannot be read. */
const UNKNOWN_CHECK_MS = 15_000

export function parseMutterIdletime(stdout: string): number | null {
  const match = /\(uint64 (\d+),\)/.exec(stdout)
  return match ? Number(match[1]) : null
}

/**
 * GNOME on Wayland hides input from XWayland, so Electron's powerMonitor idle time only ever grows there. Mutter's
 * idle monitor reports the real value.
 */
export function readMutterIdleMs(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      [
        'call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor',
        '--object-path', '/org/gnome/Mutter/IdleMonitor/Core', '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'
      ],
      { timeout: 2_000 },
      (error, stdout) => resolve(error ? null : parseMutterIdletime(stdout))
    )
  })
}

export function createPresenceMonitor(options: {
  /** Milliseconds since the last desktop input, or null when it cannot be read. */
  readIdleMs(): Promise<number | null>
  onChange(presence: OwnerPresence): void
  schedule(callback: () => void, ms: number): () => void
  awayAfterMs?: number
}): { start(): void; stop(): void; current(): OwnerPresence } {
  const awayAfterMs = options.awayAfterMs ?? AWAY_AFTER_MS
  let away = false
  let running = false
  let cancel: (() => void) | undefined
  const check = async (): Promise<void> => {
    const idle = await options.readIdleMs().catch(() => null)
    if (!running) return
    const next = idle !== null && idle >= awayAfterMs
    if (next !== away) {
      away = next
      options.onChange({ away })
    }
    // Idle time only grows in real time, so a present owner cannot turn away before the rest of the threshold passes.
    const wait = idle === null ? UNKNOWN_CHECK_MS : away ? AWAY_CHECK_MS : awayAfterMs - idle
    cancel = options.schedule(() => void check(), Math.max(wait, 1_000))
  }
  return {
    start: () => {
      if (running) return
      running = true
      void check()
    },
    stop: () => {
      running = false
      cancel?.()
      cancel = undefined
    },
    current: () => ({ away })
  }
}
