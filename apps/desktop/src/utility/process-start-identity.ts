// MODULE: process-start-identity.ts - an opaque per-process token that changes when a PID is reused
import { readFile } from 'node:fs/promises'

/**
 * A PID alone cannot be signalled safely: between a shell exiting and the PTY reporting it, the
 * kernel may hand the same number to an unrelated process. Pairing the PID with the moment the
 * kernel started it makes a recycled PID visibly different. The token is opaque and compared only
 * for equality.
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

const byPlatform: Readonly<Record<string, ProcessStartIdentity>> = Object.freeze({
  linux: linuxProcessStartIdentity
})

/** Chosen for the platform the app is running on; unsupported platforms reject identity lookup. */
export function processStartIdentityFor(platform: string): ProcessStartIdentity {
  const identify = byPlatform[platform]
  if (!identify) {
    return () => Promise.reject(new Error(`process start identity is unsupported on ${platform}`))
  }
  return identify
}

export const processStartIdentity: ProcessStartIdentity = processStartIdentityFor(process.platform)
