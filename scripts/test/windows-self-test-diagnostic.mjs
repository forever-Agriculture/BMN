// MODULE: windows-self-test-diagnostic.mjs - observation-only native run of the packaged --self-test
// The installed smoke ran `BMN.exe --self-test` for 300 s with no stderr and no
// receipt (runs 37281677152, 37296438394). This run uses the same isolated
// environment plus Chromium logging, and before stopping a run that is still
// going it records the top-level windows of the app process, so a modal error
// dialog or a stuck window is visible. It never changes the gate's result.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsInstallerSmokeEnvironment } from '../lib/windows-installed-worker.mjs'
import { systemPowerShell } from '../lib/windows-update-ui.mjs'

const windowsScript = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[Windows.Automation.AutomationElement]
$rows=@(foreach ($window in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$env:BMN_DIAGNOSTIC_PID)))) {
  [pscustomobject]@{ name=$window.Current.Name; className=$window.Current.ClassName; offscreen=$window.Current.IsOffscreen
    texts=@(foreach ($child in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) { $child.Current.Name } | Where-Object { $_ } | Select-Object -First 12) }
})
$json=ConvertTo-Json -Compress -Depth 4 -InputObject $rows
[Console]::Out.Write([regex]::Replace($json,'[^\\x00-\\x7F]',[Text.RegularExpressions.MatchEvaluator]{ param($match) '\\u{0:x4}' -f [int][char]$match.Value }))
`

function topLevelWindows(pid) {
  return new Promise(resolve => {
    const child = spawn(systemPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')],
      { env: { ...process.env, BMN_DIAGNOSTIC_PID: String(pid) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes })
    const timer = setTimeout(() => child.kill(), 30000)
    child.once('error', () => { clearTimeout(timer); resolve({ unavailable: true }) })
    child.once('exit', () => {
      clearTimeout(timer)
      try { const rows = JSON.parse(output || '[]'); resolve(Array.isArray(rows) ? rows : [rows]) } catch { resolve({ unavailable: true }) }
    })
  })
}

// eslint-disable-next-line no-control-regex
const printable = (text, limit) => text.slice(-limit).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')

export async function observeWindowsPackagedSelfTest(binary, { budgetMs = 120000 } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-self-test-diagnostic-'))
  const profile = join(temporary, 'profile')
  const started = Date.now()
  try {
    ensurePrivateDirectories([profile])
    const env = { ...windowsInstallerSmokeEnvironment(profile), ELECTRON_ENABLE_LOGGING: '1' }
    const child = spawn(binary, ['--self-test'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ spawnError: error.code ?? 'unknown' }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    let windows = null
    let outcome = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), budgetMs))])
    if (!outcome) {
      windows = await topLevelWindows(child.pid)
      child.kill()
      outcome = { ...(await exited), stoppedAfterMs: budgetMs }
    }
    const phases = [...stderr.matchAll(/\[BMN\] self-test phase: ([^\r\n]*)/gu)].map(match => match[1])
    return { nativeDiagnostic: 'packaged-self-test', observationOnly: true, budgetMs, durationMs: Date.now() - started, outcome, windows,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), phaseCount: phases.length, lastPhase: phases.at(-1) ?? null,
      failure: /\[BMN\] session self-test failed: ([^\r\n]*)/u.exec(stderr)?.[1] ?? null,
      receipt: stdout.split(/\r?\n/u).some(line => line.includes('"selfTest":"session-roundtrip"')),
      stdoutTail: printable(stdout, 1000), stderrTail: printable(stderr, 6000) }
  } catch (error) {
    return { nativeDiagnostic: 'packaged-self-test', observationOnly: true, unavailable: true, error: String(error?.message ?? error).slice(0, 500) }
  } finally {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* A stopped run can still hold files; the runner image is discarded. */ }
  }
}

export async function recordWindowsPackagedSelfTest(binary) {
  const result = await observeWindowsPackagedSelfTest(binary)
  writeFileSync(join(process.cwd(), 'test-results/windows-self-test-diagnostic.json'), JSON.stringify(result, null, 2))
  return { observationOnly: true, durationMs: result.durationMs, receipt: result.receipt ?? false, lastPhase: result.lastPhase ?? null }
}
