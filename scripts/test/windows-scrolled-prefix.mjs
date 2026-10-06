// Diagnostic only: six fresh-profile prefixes never substitute for the ordinary packaged gate.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

export async function recordScrolledPrefixes(binary, budgetMs = 600_000) {
  const began = Date.now()
  const record = { diagnosticOnly: true, experiment: 'scrolled-prefix-A-B', startedAtMs: began, budgetMs, arms: [], partial: false }
  mkdirSync('test-results', { recursive: true })
  const save = () => {
    const path = 'test-results/windows-scrolled-prefix.json', temporary = path + '.tmp'
    const text = JSON.stringify(record, null, 2)
    writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, path)
    if (readFileSync(path, 'utf8') !== text) throw new Error('Diagnostic receipt readback failed')
  }
  save()
  for (const [index, arm] of ['with-fixture', 'without-fixture', 'with-fixture', 'without-fixture', 'with-fixture', 'without-fixture'].entries()) {
    const left = budgetMs - (Date.now() - began)
    if (left <= 5_000) { record.partial = true; break }
    const temporary = mkdtempSync(join(tmpdir(), 'bmn-scrolled-prefix-'))
    const profile = join(temporary, 'profile'), startedAtMs = Date.now()
    const row = { index, arm, startedAtMs, jobRelativeStartMs: startedAtMs - began }
    record.arms.push(row); save()
    try {
      ensurePrivateDirectories([profile])
      const child = spawn(binary, ['--self-test', `--scrolled-diagnostic=${arm}`],
        { env: windowsInstallerSmokeEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { if (stdout.length < 2 * 1024 * 1024) stdout += bytes.toString('utf8') })
      child.stderr.on('data', bytes => { if (stderr.length < 2 * 1024 * 1024) stderr += bytes.toString('utf8') })
      const outcome = await new Promise(resolve => {
        let fallback
        const finish = outcome => { clearTimeout(timer); clearTimeout(fallback); resolve(outcome) }
        const timer = setTimeout(() => {
          row.timedOut = true
          child.kill()
          fallback = setTimeout(() => {
            child.stdout.destroy(); child.stderr.destroy()
            finish({ termination: 'UNVERIFIED: no close event after kill' })
          }, 5_000)
        }, Math.max(1, Math.min(left - 5_000, 110_000)))
        child.once('error', error => finish({ launchError: error.code ?? 'unknown' }))
        child.once('close', (code, signal) => finish({ code, signal }))
      })
      Object.assign(row, { outcome, durationMs: Date.now() - startedAtMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })
      for (const line of stdout.split(/\r?\n/u)) {
        try {
          const receipt = JSON.parse(line)
          if (receipt.selfTest === 'scrolled-diagnostic' && receipt.diagnosticOnly === true && receipt.arm === arm) row.receipt = receipt
        } catch { /* Non-receipt output is not acceptance. */ }
      }
      if (!row.receipt) row.failure = stderr.slice(-4_000)
      if (row.timedOut && Date.now() - began >= budgetMs) record.partial = true
    } catch (error) {
      row.unavailable = error?.code ?? 'diagnostic-error'
    } finally {
      try { rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
      catch (error) { row.cleanupError = error?.code ?? 'cleanup-error' }
      save()
    }
  }
  record.durationMs = Date.now() - began
  record.partial ||= record.arms.length !== 6
  save()
  return record
}
