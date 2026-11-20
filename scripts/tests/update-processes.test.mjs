// MODULE: update-processes.test.mjs - Story 134.2 review F3: a stopped or finished update step leaves none of its processes running
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { settleProcessGroup } from '../install/update-desktop.mjs'
import { runSelfTest } from '../smoke/packaged.mjs'

const groupAlive = (group) => { try { process.kill(-group, 0); return true } catch { return false } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('update step processes (review F3)', { timeout: 30_000 }, () => {
  it('empties a step group whose leader exited first, and leaves an unrelated process running', async () => {
    const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      // The leader exits at once; the helper it started stays in its group.
      const leader = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' })
      await new Promise((resolve) => leader.once('close', resolve))
      expect(groupAlive(leader.pid)).toBe(true)
      expect(await settleProcessGroup(leader.pid)).toBe(true)
      expect(groupAlive(leader.pid)).toBe(false)
      expect(alive(unrelated.pid)).toBe(true)
    } finally {
      unrelated.kill('SIGKILL')
    }
  })

  it('runs the self-test in its own group, keeps more than 1 MiB of output and leaves no helper behind', async () => {
    const result = await runSelfTest('/bin/sh', ['-c', 'sleep 30 & head -c 1200000 /dev/zero | tr "\\000" a; echo "[BMN] session self-test failed: synthetic" >&2; exit 3'], { env: process.env, timeoutMs: 20_000 })
    expect(result.status).toBe(3)
    expect(result.error).toBeNull()
    expect(result.stdout).toHaveLength(1_200_000)
    expect(result.stderr).toContain('[BMN] session self-test failed: synthetic')
  })

  it('kills the whole self-test group at its bound and says it timed out', async () => {
    const started = Date.now()
    const result = await runSelfTest('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { env: process.env, timeoutMs: 300 })
    expect(result.error?.message).toBe('timed out after 0.3 s')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
