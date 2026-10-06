// Disposable CI-only WSL2 VM probe, before choosing a guest ownership design.
// Import guidance: https://learn.microsoft.com/windows/wsl/use-custom-distro
// Alpine publishes the pinned source checksum beside this mini root filesystem.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This probe imports only on a disposable CI runner')
const source = 'https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-minirootfs-3.23.0-x86_64.tar.gz'
const expected = 'ce8f782f1628d046fb6360eff880b898e5205ed91106d9d14ff4fcb97431bbde'
const executable = join(process.env.SystemRoot, 'System32', 'wsl.exe')
const root = mkdtempSync(join(tmpdir(), 'bmn-wsl-vm-spike-'))
const distribution = `BMN-Epic53-Probe-${randomUUID()}`
const receipt = { distribution, source, sha256: expected, acceptance: 'UNVERIFIED',
  vmBooted: false, measuredGuestOwnership: false, commands: [] }
const decode = bytes => bytes?.toString(bytes.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').trim().slice(0, 8000) ?? ''
const run = (args, timeout = 30000) => {
  const started = Date.now()
  try {
    const stdout = execFileSync(executable, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = { args, exit: 0, elapsedMs: Date.now() - started, stdout: decode(stdout) }
    receipt.commands.push(result)
    return result
  } catch (error) {
    const result = { args, exit: error.status ?? null, code: error.code ?? null,
      elapsedMs: Date.now() - started, stdout: decode(error.stdout), stderr: decode(error.stderr) }
    receipt.commands.push(result)
    return result
  }
}
let importAttempted = false
try {
  const existing = run(['--list', '--quiet'])
  assert.ok(!existing.stdout.split(/\r?\n/u).includes(distribution), 'Never replace a registered distribution')
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
  assert.ok(response.ok, `Root filesystem HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length < 8 * 1024 * 1024, 'Bounded mini root filesystem')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
  const archive = join(root, 'rootfs.tar')
  writeFileSync(archive, gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }))
  importAttempted = true
  const imported = run(['--import', distribution, join(root, 'distribution'), archive, '--version', '2'], 90000)
  if (imported.exit === 0) {
    const guest = run(['--distribution', distribution, '--user', 'root', '--exec', '/bin/sh', '-c',
      'uname -a; printf "PID1="; cat /proc/1/comm; printf "BOOT_ID="; cat /proc/sys/kernel/random/boot_id; cat /proc/self/cgroup; grep cgroup /proc/mounts; printf "INTEROP="; test -e /proc/sys/fs/binfmt_misc/WSLInterop && echo present || echo absent'], 30000)
    receipt.vmBooted = guest.exit === 0
    receipt.reason = guest.exit === 0
      ? 'WSL2 VM boots. Alpine lacks systemd; guest ownership and GUI interop design remain UNVERIFIED.'
      : 'Registered WSL2 VM failed to start; inspect the captured native error.'
  } else receipt.reason = 'WSL2 VM import unavailable on this runner; inspect the captured native error.'
} catch (error) {
  receipt.reason = String(error.message).slice(0, 1000)
} finally {
  // This fresh UUID was checked before our import. Clean only that registration.
  if (importAttempted) {
    const removed = run(['--unregister', distribution], 30000)
    receipt.registrationRemoved = removed.exit === 0 ||
      !run(['--list', '--quiet']).stdout.split(/\r?\n/u).includes(distribution)
  }
  try { rmSync(root, { recursive: true, force: true }) } catch { receipt.fixtureFilesRemoved = false }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-wsl-vm-spike.json', JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
assert.notEqual(receipt.registrationRemoved, false, 'Disposable WSL registration cleanup failed')
