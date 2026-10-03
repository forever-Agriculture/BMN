// Measure real validation of accepted trees, including atomic replacement ACLs.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

assert.equal(process.platform, 'win32')
const parent = mkdtempSync(join(tmpdir(), 'bmn-storage-scale-'))
const observations = []
const original = childProcess.spawnSync
let measurement
childProcess.spawnSync = (file, args, options) => {
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes('BMN_PRIVATE_ROOTS_OK'))
  const measured = `try {\n${script}\n} finally { [Console]::Error.WriteLine(('BMN_PEAK_BYTES=' + [Diagnostics.Process]::GetCurrentProcess().PeakWorkingSet64)) }`
  const started = performance.now()
  const result = original(file, [...args.slice(0, -1), Buffer.from(measured, 'utf16le').toString('base64')], options)
  measurement = { elapsedMs: Math.round(performance.now() - started), status: result.status,
    error: result.error?.code, peakBytes: Number(String(result.stderr).match(/BMN_PEAK_BYTES=(\d+)/)?.[1]) || null }
  return result
}
syncBuiltinESMExports()
try {
  const root = join(parent, 'private')
  ensurePrivateDirectories([root])
  let existing = 0
  for (const count of [100, 1000, 9000]) {
    for (; existing < count; existing++) writeFileSync(join(root, existing + '.txt'), 'synthetic')
    let failure
    try { ensurePrivateDirectories([root]) } catch (error) { failure = error.message }
    observations.push({ entries: count + 1, ...measurement, ...(failure ? { failure } : {}) })
    assert.equal(failure, undefined, `Valid private tree with ${count} files must remain usable`)
    assert.ok(measurement.peakBytes > 0 && measurement.peakBytes < 256 * 1024 * 1024, 'Validation exceeded 256 MiB working set')
  }
  // Writes use a sibling temporary file so replacement inherits the private ACL.
  const target = join(root, '0.txt'), temporary = join(root, 'replacement.tmp')
  writeFileSync(temporary, 'atomic replacement 数据')
  renameSync(temporary, target)
  assert.equal(readFileSync(target, 'utf8'), 'atomic replacement 数据')
  ensurePrivateDirectories([root])
  observations.push({ atomicReplacement: true, ...measurement })
} finally {
  childProcess.spawnSync = original; syncBuiltinESMExports()
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-storage-scale.json', JSON.stringify(observations, null, 2))
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(JSON.stringify({ passed: true, observations }))
