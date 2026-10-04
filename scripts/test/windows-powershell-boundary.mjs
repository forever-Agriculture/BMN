// Diagnostic only: separate Core/Utility commands and controlled OS environments.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

export function measurePowerShellBoundary({ env, standardEnvironment, spawnSync, referenceCall, githubActions }) {
  assert.equal(process.platform, 'win32')
  assert.equal(githubActions, true, 'Disposable native runner required')
  const systemRoot = windowsEnvironmentValue(env, 'SystemRoot')
  const powershell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const input = '{"synthetic":"stdin"}'
  const bodies = [
    ['core-command', '$null=1 | Where-Object {$_} | ForEach-Object {$_}'],
    ['module-import', 'Import-Module Microsoft.PowerShell.Utility'],
    ['utility-command', "$null=ConvertFrom-Json '{}'"],
    ['autoload-disabled', "$PSModuleAutoLoadingPreference='None';try{ConvertFrom-Json '{}'}catch{[Console]::Error.Write('NF')}" ]
  ]
  const standard = { ...env, ...standardEnvironment }
  // Keep every synthetic user/config directory and change only non-secret OS keys.
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(standard[key], env[key])
  const osPath = { ...standard }
  for (const key of Object.keys(osPath)) if (key.toUpperCase() === 'PATH') delete osPath[key]
  osPath.PATH = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';')
  const cells = []
  for (const [environment, childEnv] of [['minimal', env], ['standard-machine', standard], ['standard-os-path', osPath]]) {
    for (const [name, body] of bodies) cells.push({ name: environment + '/' + name, childEnv,
      script: "[Console]::Error.Write('A');" + body + ";[Console]::Error.Write('B')", timeout: 3500, input })
  }
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
  cells.push({ name: 'minimal/full-helper-trace', childEnv: env, script: traced,
    timeout: referenceCall.options.timeout, input: referenceCall.options.input })
  return cells.map(({ name, childEnv, script, timeout, input }) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    assert.ok(args.join(' ').length + powershell.length + 100 < 32767, 'Diagnostic exceeds native command length')
    const started = Date.now()
    const raw = spawnSync(powershell, args, { env: childEnv, input, encoding: 'utf8', timeout, maxBuffer: 4096, windowsHide: true })
    return { name, elapsedMs: Date.now() - started, argumentChars: args.join(' ').length,
      status: raw.status, signal: raw.signal, error: raw.error?.code,
      stdout: String(raw.stdout ?? '').slice(-4096), stderr: String(raw.stderr ?? '').slice(-4096) }
  })
}
