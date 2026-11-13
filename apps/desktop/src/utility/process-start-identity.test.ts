// MODULE: process-start-identity.test.ts - the start token names a live process and refuses a dead one
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processStartIdentity, processStartIdentityFor, testRestartProcessIdentity } from './process-start-identity'

const onLinux = process.platform === 'linux'
const expectedPrefix = 'linux-proc-start:'

describe('isolated restart spawn record', () => {
  it('requires both the test-host flag and explicit own-state path, preserving the ordinary reader', () => {
    const identify = async () => 'synthetic-start'
    expect(testRestartProcessIdentity([], { BMN_TEST_RESTART_SPAWN_RECORD: '/outside' }, '/state', identify)).toBe(identify)
    expect(testRestartProcessIdentity(['--bmn-test-host'], {}, '/state', identify)).toBe(identify)
    expect(() => testRestartProcessIdentity(['--bmn-test-host'], { BMN_TEST_RESTART_SPAWN_RECORD: '/outside' }, '/state', identify)).toThrow('Invalid restart test record path')
  })

  it('records the exact launched PID and unchanged identity, and never records a failed identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-restart-spawn-'))
    try {
      const path = join(root, 'restart-spawn-identities.jsonl')
      const identify = testRestartProcessIdentity(['--bmn-test-host'], { BMN_TEST_RESTART_SPAWN_RECORD: path }, root,
        async pid => { if (pid === 2) throw new Error('gone'); return 'linux-proc-start:123' })
      expect(existsSync(path)).toBe(false)
      await expect(identify(456)).resolves.toBe('linux-proc-start:123')
      await expect(identify(2)).rejects.toThrow('gone')
      const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(1)
      expect(records[0]).toEqual({ pid: 456, identity: 'linux-proc-start:123', at: expect.any(String) })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses a symlink instead of writing outside the instance state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-restart-spawn-'))
    try {
      const path = join(root, 'restart-spawn-identities.jsonl'), target = join(root, 'unrelated')
      symlinkSync(target, path)
      const identify = testRestartProcessIdentity(['--bmn-test-host'], { BMN_TEST_RESTART_SPAWN_RECORD: path }, root, async () => 'start')
      await expect(identify(456)).rejects.toThrow()
      expect(existsSync(target)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

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
