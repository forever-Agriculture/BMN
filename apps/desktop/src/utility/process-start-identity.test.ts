// MODULE: process-start-identity.test.ts - the start token names a live process and refuses a dead one
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processStartIdentity, processStartIdentityFor } from './process-start-identity'

const onLinux = process.platform === 'linux'
const expectedPrefix = 'linux-proc-start:'

/** Starts a process that outlives the assertions, and stops it afterwards. */
async function sleeper(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
  const pid = await new Promise<number>((resolvePid, rejectSpawn) => {
    child.once('spawn', () => resolvePid(child.pid as number))
    child.once('error', rejectSpawn)
  })
  return {
    pid,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop())
        child.kill('SIGKILL')
      })
  }
}

describe.skipIf(!onLinux)('process start identity', () => {
  it('names this platform and answers the same token twice for one live process', async () => {
    const child = await sleeper()
    try {
      const first = await processStartIdentity(child.pid)
      const second = await processStartIdentity(child.pid)
      expect(first.startsWith(expectedPrefix)).toBe(true)
      expect(first.length).toBeGreaterThan(expectedPrefix.length)
      expect(second).toBe(first)
    } finally {
      await child.stop()
    }
  })

  it('refuses a process that has exited, so a reused PID is never taken for the old one', async () => {
    const child = await sleeper()
    await child.stop()
    await expect(processStartIdentity(child.pid)).rejects.toThrow()
  })

  it('answers for this process, which is certainly alive', async () => {
    await expect(processStartIdentity(process.pid)).resolves.toContain(expectedPrefix)
  })
})

describe('process start identity platform selection', () => {
  it('refuses a platform with no way to read a process start time', async () => {
    await expect(processStartIdentityFor('win32')(1)).rejects.toThrow(
      'process start identity is unsupported on win32'
    )
  })
})
