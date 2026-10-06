// Observation only, disposable native CI. No PTY, owner profile, or acceptance substitution.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'
import { systemPowerShell } from '../lib/windows-update-ui.mjs'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

const statements = {
  A1: ["Write-Output 'synthetic'"],
  A2: ["[Console]::Out.WriteLine('synthetic')", "Write-Output 'synthetic'"],
  A3: ["Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))", "Write-Output 'synthetic'"],
  A4: ["Microsoft.PowerShell.Utility\\Write-Output 'synthetic'"],
  A5: ["Write-Output 'synthetic'"], A6: ["Write-Output 'synthetic'"], A7: ["Write-Output 'synthetic'"],
  A8: ['$null=Get-Process -Id $PID']
}
export function discoveryScript(cell) {
  assert.ok(Object.hasOwn(statements, cell))
  return "$ErrorActionPreference='Stop'; $loadedBefore=@(Get-Module Microsoft.PowerShell.Utility).Count; $durations=@();\n" +
    statements[cell].map(statement => `$watch=[Diagnostics.Stopwatch]::StartNew(); ${statement}; $durations+=,$watch.ElapsedMilliseconds;`).join('\n') + `
$loadedAfter=@(Get-Module Microsoft.PowerShell.Utility).Count;
$paths=@($env:PSModulePath -split ';'); $directories=0; $unavailable=0;
foreach($path in $paths){try{$directories+=[IO.Directory]::GetDirectories($path).Length}catch{$unavailable++}};
[Console]::Out.WriteLine([string]::Format('{{"durationsMs":[{0}],"loadedBefore":{1},"loadedAfter":{2},"modulePathEntries":{3},"moduleDirectories":{4},"unavailableDirectories":{5}}}',[string]::Join(',',$durations),$loadedBefore,$loadedAfter,$paths.Count,$directories,$unavailable));`
}
export async function recordWindowsPowerShellDiscovery(budgetMs = 360_000) {
  assert.equal(process.platform, 'win32'); assert.equal(process.env.GITHUB_ACTIONS, 'true')
  const began = Date.now(), record = { observationOnly: true, diagnosticOnly: true, budgetMs, repetitions: 2, results: [] }
  for (let repetition = 0; repetition < 2; repetition++) {
    const root = mkdtempSync(join(tmpdir(), 'bmn-discovery-'))
    let custody = true
    try {
      for (const cell of Object.keys(statements)) {
        const left = budgetMs - (Date.now() - began)
        if (left < 5_000) { record.partial = true; break }
        const profile = join(root, cell === 'A5' ? 'A1' : cell)
        ensurePrivateDirectories([profile])
        const environment = cell === 'A6' ? { ...process.env } : cell === 'A7'
          ? { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'localappdata')), LOCALAPPDATA: profile }
          : windowsInstallerSmokeEnvironment(profile)
        const child = spawn(systemPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(discoveryScript(cell), 'utf16le').toString('base64')],
        { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = '', timedOut = false, exitObserved = false, closeObserved = false
        child.stdout.on('data', bytes => { if (stdout.length < 65536) stdout += bytes.toString('utf8') })
        child.stderr.resume(); child.once('exit', () => { exitObserved = true })
        const started = Date.now()
        const outcome = await new Promise(resolve => {
          let fallback
          const finish = result => { clearTimeout(timer); clearTimeout(fallback); resolve(result) }
          const timer = setTimeout(() => {
            timedOut = true; child.kill()
            fallback = setTimeout(() => finish({ terminationUnconfirmed: true }), 5000)
          }, Math.min(60_000, left - 5_000))
          child.once('error', error => finish({ launchError: error.code ?? 'unknown' }))
          child.once('close', code => { closeObserved = true; finish({ code }) })
        })
        let measurements
        try { measurements = JSON.parse(stdout.split(/\r?\n/u).find(line => line.startsWith('{'))) } catch { /* Unavailable is not a measurement. */ }
        record.results.push({ repetition, cell, profile: cell === 'A5' ? 'A1-reused' : 'fresh',
          environment: ['A6', 'A7'].includes(cell) ? cell === 'A6' ? 'full-disposable-CI' : 'full-fresh-local' : 'minimal',
          elapsedMs: Date.now() - started, timedOut, outcome, measurements })
        if (child.pid && (!exitObserved || !closeObserved)) {
          custody = false; child.stdout.destroy(); child.stderr.destroy(); child.kill()
          throw Object.assign(new Error('Discovery child custody is unconfirmed; profile retained'),
            { code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED', diagnostic: record })
        }
      }
    } finally {
      if (custody) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      else record.profileRetained = root
    }
    if (record.partial) break
  }
  record.durationMs = Date.now() - began
  record.partial = record.partial || record.results.length !== 16 || record.results.some(row =>
    row.timedOut || row.outcome.code !== 0 || !row.measurements)
  return record
}
