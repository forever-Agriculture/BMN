// Diagnostic only: compare measured Utility autoload failure with explicit OS import.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

export function measurePowerShellBoundary({ env, spawnSync, referenceCall, githubActions }) {
  assert.equal(process.platform, 'win32')
  assert.equal(githubActions, true, 'Disposable native runner required')
  const systemRoot = windowsEnvironmentValue(env, 'SystemRoot')
  const powershell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const utility = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));$PSModuleAutoLoadingPreference='None';\n"
  const cells = [{ name: 'explicit-utility-json', script: "[Console]::Error.Write('A');" + utility +
    "$null=ConvertFrom-Json '{}';[Console]::Error.Write('B')", timeout: 4000, input: '{}' }]
  assert.equal(referenceCall?.exe, powershell, 'Only the captured synthetic helper can be replayed')
  const commandIndex = referenceCall.args.indexOf('-EncodedCommand')
  assert.ok(commandIndex >= 0)
  let traced = Buffer.from(referenceCall.args[commandIndex + 1], 'base64').toString('utf16le')
  for (const [anchor, marker] of [
    ["$ErrorActionPreference = 'Stop'", 'START'],
    ['$request = ConvertFrom-Json', 'JSON_BEGIN'],
    ['$paths = $request.paths', 'JSON_DONE'],
    ['$dataMatches = 0', 'KEYS_DONE'],
    ['    $directory.Create($acl)', 'CREATE_BEGIN'],
    ['    $directory.Refresh()', 'CREATE_DONE'],
    ['  $pending.Enqueue($directory)', 'SCAN_BEGIN']
  ]) {
    assert.equal(traced.split(anchor).length - 1, 1, 'Captured helper marker must match exactly once')
    traced = traced.replace(anchor, `[Console]::Error.WriteLine('${marker}');\n` + anchor)
  }
  for (const [name, prefix] of [['original/full-helper-trace', ''], ['explicit-utility/full-helper-trace', utility]]) {
    cells.push({ name, script: prefix + traced, timeout: referenceCall.options.timeout, input: referenceCall.options.input })
  }
  return cells.map(({ name, script, timeout, input }) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    assert.ok(args.join(' ').length + powershell.length + 100 < 32767, 'Diagnostic exceeds native command length')
    const started = Date.now()
    const raw = spawnSync(powershell, args, { env, input, encoding: 'utf8', timeout, maxBuffer: 4096, windowsHide: true })
    return { name, elapsedMs: Date.now() - started, argumentChars: args.join(' ').length,
      status: raw.status, signal: raw.signal, error: raw.error?.code,
      stdout: String(raw.stdout ?? '').slice(-4096), stderr: String(raw.stderr ?? '').slice(-4096) }
  })
}
