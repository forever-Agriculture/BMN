// MODULE: session-status.ts - the owner-facing label for a session's latest process incarnation
import type { SessionProcessStatus } from '@bmn/protocol'

/**
 * Labels a session's latest incarnation from the host's recorded evidence only:
 * - interrupted: an application-lifecycle cause ended or lost the process (with source/evidence);
 * - stopped: the owner's explicit per-session Stop produced an observed signal;
 * - exited: the process ended on its own with the reported exit code.
 */
export function sessionProcessLabel(status: SessionProcessStatus | null): string {
  if (!status) return 'Not started'
  switch (status.state) {
    case 'live':
      return 'Process live'
    case 'interrupted':
      return status.detail ? `Interrupted · ${status.detail}` : 'Interrupted'
    case 'exited':
      if (status.signal !== null && status.signal !== 0) {
        return status.exitCode === null || status.exitCode === 0
          ? `Process stopped · signal ${status.signal}`
          : `Process stopped · signal ${status.signal} · code ${status.exitCode}`
      }
      return status.exitCode === null ? 'Process exited · exit code not recorded' : `Process exited · code ${status.exitCode}`
  }
}
