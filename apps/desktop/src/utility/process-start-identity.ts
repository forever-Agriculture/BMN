// MODULE: process-start-identity.ts - an opaque per-process token that changes when a PID is reused
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/**
 * A PID alone cannot be signalled safely: between a shell exiting and the PTY reporting it, the
 * kernel may hand the same number to an unrelated process. Pairing the PID with the moment the
 * kernel started it makes a recycled PID visibly different. The token is opaque and compared only
 * for equality, so each platform reports whatever start value it can name exactly.
 */
export type ProcessStartIdentity = (pid: number) => Promise<string>

/** Field 22 of /proc/<pid>/stat, in clock ticks since boot; the command in field 2 may hold spaces. */
async function linuxProcessStartIdentity(pid: number): Promise<string> {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const commandEnd = processStat.lastIndexOf(')')
  const fieldsAfterCommand = processStat.slice(commandEnd + 2).trim().split(/\s+/)
  const startTicks = fieldsAfterCommand[19]
  if (!startTicks) throw new Error('process start ticks are unavailable')
  return `linux-proc-start:${startTicks}`
}

/** macOS has no /proc; ps reports the start time from the same kernel record, to the second. */
async function darwinProcessStartIdentity(pid: number): Promise<string> {
  const started = await new Promise<string>((resolveStart, rejectStart) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      if (error) rejectStart(new Error(`process start time is unavailable: ${error.message}`))
      else resolveStart(stdout)
    })
  })
  const startedAt = started.trim().replace(/\s+/gu, ' ')
  if (!startedAt) throw new Error('process start time is unavailable')
  return `darwin-ps-start:${startedAt}`
}

const byPlatform: Readonly<Record<string, ProcessStartIdentity>> = Object.freeze({
  linux: linuxProcessStartIdentity,
  darwin: darwinProcessStartIdentity
})

/** Chosen for the platform the app is running on; unsupported platforms never reach a PTY at all. */
export function processStartIdentityFor(platform: string): ProcessStartIdentity {
  const identify = byPlatform[platform]
  if (!identify) {
    return () => Promise.reject(new Error(`process start identity is unsupported on ${platform}`))
  }
  return identify
}

export const processStartIdentity: ProcessStartIdentity = processStartIdentityFor(process.platform)
