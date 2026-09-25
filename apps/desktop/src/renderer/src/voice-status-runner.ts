// MODULE: voice-status-runner.ts - publish only the newest requested voice status
import type { VoiceStatus } from '@bmn/protocol'

export type VoiceStatusEvent =
  | { kind: 'status'; status: VoiceStatus }
  | { kind: 'unavailable'; cause: unknown }

/**
 * Status requests can resolve out of order — a response that captured a download error before
 * Dismiss can arrive after the Dismiss's own refresh and restore the dismissed error — so only
 * the newest request's result is published, the same contract as the hook-check runner.
 */
export function createVoiceStatusRunner(
  read: () => Promise<VoiceStatus>,
  publish: (event: VoiceStatusEvent) => void
): { run(): Promise<void>; cancel(): void } {
  let sequence = 0
  return {
    async run(): Promise<void> {
      const request = ++sequence
      try {
        const status = await read()
        if (request === sequence) publish({ kind: 'status', status })
      } catch (cause) {
        if (request === sequence) publish({ kind: 'unavailable', cause })
      }
    },
    cancel(): void { sequence += 1 }
  }
}
