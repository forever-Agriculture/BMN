// MODULE: process-start-identity.ts - an opaque per-process token that changes when a PID is reused
import { readFile } from 'node:fs/promises'
import { appendFileSync, closeSync, constants, openSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A PID alone cannot be signalled safely: between a shell exiting and the PTY reporting it, the
 * kernel may hand the same number to an unrelated process. Pairing the PID with the moment the
 * kernel started it makes a recycled PID visibly different. The token is opaque and compared only
 * for equality.
 */
type ProcessStartIdentity = (pid: number) => Promise<string>

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

/** An isolated restart test records the root the host actually spawned; no process discovery. */
export function testRestartProcessIdentity(
  argv: readonly string[], environment: NodeJS.ProcessEnv, stateRoot: string,
  identify: ProcessStartIdentity = processStartIdentity
): ProcessStartIdentity {
  const path = environment.BMN_TEST_RESTART_SPAWN_RECORD
  if (!argv.includes('--bmn-test-host') || !path) return identify
  if (path !== join(stateRoot, 'restart-spawn-identities.jsonl')) throw new Error('Invalid restart test record path')
  return async pid => {
    const identity = await identify(pid)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try { appendFileSync(fd, JSON.stringify({ pid, identity, at: new Date().toISOString() }) + '\n') }
    finally { closeSync(fd) }
    return identity
  }
}
