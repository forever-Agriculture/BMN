// Temporary Story53.1 diagnostic: synthetic roots only; no owner profile or secrets.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

assert.equal(process.platform, 'win32', 'This diagnostic needs native Windows')
const originalSpawn = childProcess.spawnSync
const results = []
let mode = 'inherited'
childProcess.spawnSync = (executable, args, options) => {
  const env = { ...process.env }
  if (mode === 'without-psmodulepath') {
    for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name]
  }
  const start = performance.now()
  const result = originalSpawn(executable, args, { ...options, env })
  results.push({ mode, elapsedMs: Math.round(performance.now() - start), status: result.status,
    errorCode: result.error?.code, signal: result.signal,
    stdout: String(result.stdout ?? '').slice(0, 8000), stderr: String(result.stderr ?? '').slice(0, 8000) })
  return result
}
syncBuiltinESMExports()
const { ensurePrivateDirectories } = await import('../../apps/desktop/src/utility/private-directory.ts')
try {
  for (mode of ['inherited', 'without-psmodulepath']) {
    const parent = mkdtempSync(join(tmpdir(), 'bmn-root-probe-'))
    try {
      ensurePrivateDirectories([join(parent, 'data 数据')])
      results.at(-1).rootCheck = 'passed'
    } catch (error) {
      results.at(-1).rootCheck = 'failed'
      results.at(-1).error = error.message
    } finally { rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
} finally {
  childProcess.spawnSync = originalSpawn
  syncBuiltinESMExports()
}
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/windows-root-probe.json', JSON.stringify({ diagnosticOnly: true, results }, null, 2))
console.log(JSON.stringify({ diagnosticOnly: true, cases: results.map(({ mode, status, rootCheck, elapsedMs }) => ({ mode, status, rootCheck, elapsedMs })) }))
