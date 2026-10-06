// The diagnostic controller must retain the existing Windows job identities before terminal actions.
import { queryApplicationLifetimeProcesses } from 'node-pty'
import type { Readable } from 'node:stream'

export const DIAGNOSTIC_CUSTODY_ACK = 'SCROLLED-CUSTODY-READY\n'

export function waitForDiagnosticCustodyAck(input: Readable, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.off('data', data); input.off('end', ended); input.off('error', failed)
      input.pause()
      if (error) reject(error)
      else resolve()
    }
    const data = (bytes: Buffer | string) => {
      text += bytes.toString()
      if (text.length > 256 || !DIAGNOSTIC_CUSTODY_ACK.startsWith(text)) {
        finish(new Error('Diagnostic custody acknowledgement is invalid')); return
      }
      if (text === DIAGNOSTIC_CUSTODY_ACK) finish()
    }
    const ended = () => finish(new Error('Diagnostic controller ended before custody was acknowledged'))
    const failed = () => finish(new Error('Diagnostic controller input failed'))
    const timer = setTimeout(() => finish(new Error('Diagnostic custody acknowledgement exceeded its deadline')), timeoutMs)
    input.on('data', data); input.once('end', ended); input.once('error', failed)
    input.resume()
  })
}

export type DiagnosticJobSnapshot = ReturnType<typeof queryApplicationLifetimeProcesses>

export async function armDiagnosticCustody(arm: string): Promise<DiagnosticJobSnapshot | undefined> {
  if (process.platform !== 'win32') return undefined
  // MAX-RATE-DONE precedes SCROLLED. One quiescent snapshot here covers both positions.
  const first = queryApplicationLifetimeProcesses()
  await new Promise(resolve => setTimeout(resolve, 100))
  const snapshot = queryApplicationLifetimeProcesses()
  const identityKey = (value: typeof snapshot) => JSON.stringify([...value.entries]
    .sort((left, right) => left.pid - right.pid).map(entry => [entry.pid, entry.creationFileTime]))
  if (first.listed !== first.identified || snapshot.listed !== snapshot.identified || identityKey(first) !== identityKey(snapshot)) {
    throw new Error('Diagnostic application job did not reach a complete quiescent snapshot')
  }
  console.log(JSON.stringify({ selfTest: 'scrolled-diagnostic-custody', diagnosticOnly: true,
    arm, mainPid: process.pid, snapshot,
    limits: ['job members only; outside services and WSL are not witnessed', 'late spawns need separate exit evidence'] }))
  await waitForDiagnosticCustodyAck(process.stdin)
  return snapshot
}

/** Departures are safe; any new live identity after the controller armed is unconfirmed custody. */
export function countDiagnosticLateMembers(armed: DiagnosticJobSnapshot, current: DiagnosticJobSnapshot): number | null {
  const valid = (snapshot: DiagnosticJobSnapshot) => {
    if (snapshot.listed < 1 || snapshot.listed > 1024 || snapshot.listed !== snapshot.identified ||
        snapshot.entries.length !== snapshot.listed) return false
    const seen = new Set<number>()
    return snapshot.entries.every(entry => {
      if (!Number.isInteger(entry.pid) || entry.pid <= 0 || seen.has(entry.pid) || !/^[1-9][0-9]*$/u.test(entry.creationFileTime)) return false
      seen.add(entry.pid); return true
    })
  }
  if (!valid(armed) || !valid(current)) return null
  const keys = new Set(armed.entries.map(entry => `${entry.pid}:${entry.creationFileTime}`))
  return current.entries.filter(entry => !keys.has(`${entry.pid}:${entry.creationFileTime}`)).length
}
export function diagnosticLateMembers(armed: DiagnosticJobSnapshot | undefined): number | null {
  if (process.platform !== 'win32') return 0
  if (!armed) return null
  try { return countDiagnosticLateMembers(armed, queryApplicationLifetimeProcesses()) }
  catch { return null }
}
