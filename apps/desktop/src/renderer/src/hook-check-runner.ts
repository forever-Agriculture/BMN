// MODULE: hook-check-runner.ts - publish only the newest requested configuration snapshot
import type { HookCheckReport } from '@bmn/protocol'

export type HookCheckEvent =
  | { kind: 'started' }
  | { kind: 'checked'; report: HookCheckReport }
  | { kind: 'unavailable'; cause: unknown }

export function createHookCheckRunner(
  read: () => Promise<HookCheckReport>,
  publish: (event: HookCheckEvent) => void
): { run(): Promise<void>; cancel(): void } {
  let sequence = 0
  return {
    async run(): Promise<void> {
      const request = ++sequence
      publish({ kind: 'started' })
      try {
        const report = await read()
        if (request === sequence) publish({ kind: 'checked', report })
      } catch (cause) {
        if (request === sequence) publish({ kind: 'unavailable', cause })
      }
    },
    cancel(): void { sequence += 1 }
  }
}
