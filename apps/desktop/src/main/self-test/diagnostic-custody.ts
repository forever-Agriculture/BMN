// The diagnostic controller must retain the existing Windows job identities before terminal actions.
import { queryApplicationLifetimeProcesses } from 'node-pty'
import type { Readable } from 'node:stream'

export const DIAGNOSTIC_CUSTODY_ACK = 'SCROLLED-CUSTODY-READY\n'

type InputObservation = { event: string; atMs: number; readable: boolean; readableEnded: boolean; destroyed: boolean; flowing: boolean | null }

export function waitForDiagnosticCustodyAck(input: Readable, timeoutMs = 20_000,
  observe?: (observation: InputObservation) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = '', settled = false
    const note = (event: string) => {
      try { observe?.({ event, atMs: Date.now(), readable: input.readable, readableEnded: input.readableEnded,
        destroyed: input.destroyed, flowing: input.readableFlowing }) } catch { /* Tracing never changes the barrier. */ }
    }
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
      note('data')
      text += bytes.toString()
      if (text.length > 256 || !DIAGNOSTIC_CUSTODY_ACK.startsWith(text)) {
        finish(new Error('Diagnostic custody acknowledgement is invalid')); return
      }
      if (text === DIAGNOSTIC_CUSTODY_ACK) { note('acknowledged'); finish() }
    }
    const ended = () => { note('end'); finish(new Error('Diagnostic controller ended before custody was acknowledged')) }
    const failed = () => { note('error'); finish(new Error('Diagnostic controller input failed')) }
    const timer = setTimeout(() => { note('deadline'); finish(new Error('Diagnostic custody acknowledgement exceeded its deadline')) }, timeoutMs)
    input.on('data', data); input.once('end', ended); input.once('error', failed)
    note('before-resume')
    input.resume()
    note('after-resume')
  })
}

export type DiagnosticJobSnapshot = ReturnType<typeof queryApplicationLifetimeProcesses>

export async function armDiagnosticCustody(arm: string): Promise<DiagnosticJobSnapshot | undefined> {
  if (process.platform !== 'win32') return undefined
  // MAX-RATE-DONE precedes SCROLLED. One quiescent snapshot here covers both positions.
  const firstStartedAtMs = Date.now()
  const first = queryApplicationLifetimeProcesses()
  const firstReturnedAtMs = Date.now()
  await new Promise(resolve => setTimeout(resolve, 100))
  const secondStartedAtMs = Date.now()
  const snapshot = queryApplicationLifetimeProcesses()
  const secondReturnedAtMs = Date.now()
  // Output happens after both existing queries; it never changes their refusal predicate.
  const recordSnapshot = (index: number, value: DiagnosticJobSnapshot, startedAtMs: number, returnedAtMs: number) => {
    try {
      if (value.entries.length > 1024) return
      const text = JSON.stringify({ selfTest: 'scrolled-diagnostic-job-snapshot', diagnosticOnly: true, arm,
        mainPid: process.pid, index, startedAtMs, returnedAtMs,
        snapshot: { listed: value.listed, identified: value.identified, entries: value.entries.map(entry => ({
          pid: entry.pid, creationTimeMs: entry.creationTimeMs, creationFileTime: entry.creationFileTime })) } })
      if (Buffer.byteLength(text, 'utf8') <= 128 * 1024) console.log(text)
    } catch { /* Metadata cannot replace the original refusal or authorize custody. */ }
  }
  recordSnapshot(0, first, firstStartedAtMs, firstReturnedAtMs)
  recordSnapshot(1, snapshot, secondStartedAtMs, secondReturnedAtMs)
  const identityKey = (value: typeof snapshot) => JSON.stringify([...value.entries]
    .sort((left, right) => left.pid - right.pid).map(entry => [entry.pid, entry.creationFileTime]))
  if (first.listed !== first.identified || snapshot.listed !== snapshot.identified || identityKey(first) !== identityKey(snapshot)) {
    throw new Error('Diagnostic application job did not reach a complete quiescent snapshot')
  }
  console.log(JSON.stringify({ selfTest: 'scrolled-diagnostic-custody', diagnosticOnly: true,
    arm, mainPid: process.pid, snapshot,
    limits: ['job members only; outside services and WSL are not witnessed', 'late spawns need separate exit evidence'] }))
  let observations = 0
  await waitForDiagnosticCustodyAck(process.stdin, 20_000, observation => {
    if (observations++ < 16) console.log(JSON.stringify({ selfTest: 'scrolled-diagnostic-input', diagnosticOnly: true,
      arm, descriptor: process.stdin.fd, isTTY: process.stdin.isTTY === true, ...observation }))
  })
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
