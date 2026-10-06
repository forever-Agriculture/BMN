// One existing durable-queue case, isolated from inventory concurrency, to
// distinguish functional failure from its five-second unit fixture deadline.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable native runner required')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
mkdirSync(join(repo, 'test-results'), { recursive: true })
const report = join(repo, 'test-results/windows-source-queue-timing-unit.json')
const started = Date.now()
const child = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run',
  'scripts/tests/windows-source-update.test.mjs', '-t',
  'deduplicates durable requests and resumes exactly their intended clean commit',
  '--maxWorkers=1', '--testTimeout=30000', '--reporter=json', '--outputFile.json=' + report],
{ cwd: repo, encoding: 'utf8', timeout: 40000, windowsHide: true, maxBuffer: 1024 * 1024 })
let unit
try { unit = JSON.parse(readFileSync(report, 'utf8')) } catch { /* Preserve a missing-report failure. */ }
const receipt = { scope: 'one synthetic existing durable queue case; diagnostic deadline only',
  elapsedMs: Date.now() - started, exit: child.status, error: child.error?.code,
  passed: unit?.numPassedTests, failed: unit?.numFailedTests,
  stderr: String(child.stderr ?? '').slice(-2000) }
writeFileSync(join(repo, 'test-results/windows-source-queue-timing.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
assert.ok(!child.error && child.status === 0 && receipt.passed === 1 && receipt.failed === 0)
