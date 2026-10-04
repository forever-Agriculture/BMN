import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { ListeningPort } from '@bmn/protocol'
import { portsByPreference } from './listening-ports'

export const WINDOWS_PORT_SCAN_MS = 1000

export interface WindowsPortSession {
  incarnationId: string
  exited: boolean
  pty: {
    readonly processOwnership?: 'windows-job'
    queryListeningPorts?(): Promise<readonly ListeningPort[]>
  }
}

// A timed-out native request still occupies a worker until its OS call finishes.
// One request per retained PTY prevents retries from consuming the second slot.
const pendingQueries = new WeakMap<WindowsPortSession['pty'], Promise<readonly ListeningPort[]>>()

function queryOwnedPorts(pty: WindowsPortSession['pty']): Promise<readonly ListeningPort[]> {
  const query = Promise.resolve().then(() => pty.queryListeningPorts!())
  pendingQueries.set(pty, query)
  const clear = (): void => { if (pendingQueries.get(pty) === query) pendingQueries.delete(pty) }
  // Handle both outcomes without creating an unhandled rejected finally promise.
  void query.then(clear, clear)
  return query
}

/** Only the current retained PTY job may attribute ports; failed or stale scans clear results. */
export async function scanOwnedWindowsSessionPorts(
  ids: ReadonlySet<string>, lookup: (id: string) => WindowsPortSession | undefined
): Promise<Map<string, ListeningPort[]>> {
  const result = new Map<string, ListeningPort[]>()
  if (ids.size > 256) return result
  const deadline = performance.now() + WINDOWS_PORT_SCAN_MS
  // Sequential native queries preserve the addon's bounded worker pool.
  for (const id of ids) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const session = lookup(id)
    if (!session || session.exited || session.pty.processOwnership !== 'windows-job' || !session.pty.queryListeningPorts) continue
    if (pendingQueries.has(session.pty)) continue
    const incarnation = session.incarnationId
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error('Owned port scan timed out')) }, Math.ceil(remaining))
        timer.unref()
      })
      const ports = await Promise.race([queryOwnedPorts(session.pty), timeout])
      if (lookup(id) !== session || session.exited || session.incarnationId !== incarnation || ports.length > 512) continue
      if (ports.some(port => !Number.isInteger(port.pid) || port.pid < 1 || port.pid > 0xffff_ffff ||
        !Number.isInteger(port.port) || port.port < 1 || port.port > 65535 ||
        typeof port.address !== 'string' || port.address.length > 64 || !isIP(port.address) ||
        (port.command !== null && (typeof port.command !== 'string' || port.command.length > 512)))) continue
      const kept = portsByPreference(ports)
      if (kept.length) result.set(id, kept)
    } catch {
      // Unknown ownership clears results; a total timeout ends this pass.
      if (timedOut) break
    }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  return result
}
