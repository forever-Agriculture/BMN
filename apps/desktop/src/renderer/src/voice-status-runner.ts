// MODULE: voice-status-runner.ts - publish only the newest requested voice status, without starving slow polls
import type { VoiceStatus } from '@bmn/protocol'

export type VoiceStatusEvent =
  | { kind: 'status'; status: VoiceStatus }
  | { kind: 'unavailable'; cause: unknown }

/**
 * Status requests can resolve out of order — a response that captured a download error before
 * Dismiss can arrive after the Dismiss's own refresh and restore the dismissed error. Explicit
 * `run()` refreshes are newest-wins: each request owns a token, and only the current token may
 * publish or clear the pending gate, so an obsolete read finishes harmlessly. The interval calls
 * `poll()`, which skips while a request is pending instead of invalidating it — a read slower than
 * the poll tick must still publish (a superseding chain of polls would starve it).
 */
export function createVoiceStatusRunner(
  read: () => Promise<VoiceStatus>,
  publish: (event: VoiceStatusEvent) => void
): { run(): Promise<void>; poll(): Promise<void>; cancel(): void } {
  let sequence = 0
  let pending = false
  const issue = async (): Promise<void> => {
    const request = ++sequence
    pending = true
    try {
      const status = await read()
      if (request === sequence) publish({ kind: 'status', status })
    } catch (cause) {
      if (request === sequence) publish({ kind: 'unavailable', cause })
    } finally {
      if (request === sequence) pending = false
    }
  }
  return {
    run: issue,
    async poll(): Promise<void> {
      if (!pending) await issue()
    },
    cancel(): void {
      sequence += 1
      pending = false
    }
  }
}
