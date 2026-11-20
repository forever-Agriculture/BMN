// MODULE: update-processes.test.mjs - Story 134.2 review F3: a stopped or finished update step leaves none of its processes running
import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveFiles, settleProcessGroup } from '../install/update-desktop.mjs'
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

  it('keeps its bound when a helper that left the group holds the output open (recheck F3)', async () => {
    const started = Date.now()
    // The helper gets a session of its own, so it leaves the self-test's group, and keeps its stdout open for 20 s.
    const helper = `const c = require('node:child_process').spawn('sleep', ['20'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); process.stderr.write('HELPER ' + c.pid + '\\n'); c.unref()`
    const unrelated = spawn('sleep', ['20'], { stdio: 'ignore' })
    let helperPid = null
    try {
      const result = await runSelfTest(process.execPath, ['-e', helper], { env: process.env, timeoutMs: 500 })
      helperPid = Number(/HELPER (\d+)/u.exec(result.stderr)?.[1]) || null
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(result.error?.message).toBe('timed out after 0.5 s')
      expect(helperPid).not.toBeNull()
    } finally {
      // Only this test's own helper is stopped; any other process stays (recheck 2).
      if (helperPid) { try { process.kill(helperPid, 'SIGKILL') } catch { /* gone */ } }
      expect(alive(unrelated.pid)).toBe(true)
      unrelated.kill('SIGKILL')
    }
  })
})

describe('the launch path a failed install restores (recheck F2)', () => {
  it('puts the desktop entry and launcher back byte for byte, mode included, and removes one that did not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launch-path-'))
    try {
      const entry = join(root, 'bmn.desktop'), launcher = join(root, 'bmn-launcher'), absent = join(root, 'new-file')
      writeFileSync(entry, 'Exec=old launcher\n', { mode: 0o644 })
      writeFileSync(launcher, '#!/bin/sh\nold\n', { mode: 0o755 })
      const saved = saveFiles([entry, launcher, absent])
      writeFileSync(entry, 'Exec=incompatible\n')
      writeFileSync(launcher, 'broken')
      writeFileSync(absent, 'left by the installer')
      // The restore runs under a strict umask in a process of its own: umask is process-wide (recheck 2).
      const restore = `import('${new URL('../install/update-desktop.mjs', import.meta.url).href}').then(({ restoreFiles }) => restoreFiles(JSON.parse(process.argv[1]).map((file) => ({ ...file, bytes: file.bytes === null ? null : Buffer.from(file.bytes, 'base64') }))))`
      const shown = JSON.stringify(saved.map((file) => ({ ...file, bytes: file.bytes === null ? null : file.bytes.toString('base64') })))
      const restored = spawnSync('/bin/sh', ['-c', 'umask 077; exec "$0" -e "$1" "$2"', process.execPath, restore, shown], { encoding: 'utf8', timeout: 60_000 })
      expect(restored.status, restored.stderr).toBe(0)
      expect(readFileSync(entry, 'utf8')).toBe('Exec=old launcher\n')
      expect(readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\nold\n')
      expect(statSync(launcher).mode & 0o777).toBe(0o755)
      expect(() => statSync(absent)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
