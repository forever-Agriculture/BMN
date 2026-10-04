// Diagnostic only: constructor/setter controls and a trusted-module full-helper probe.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

export function measurePowerShellBoundary({ env, spawnSync, referenceCall, githubActions }) {
  assert.equal(process.platform, 'win32')
  assert.equal(githubActions, true, 'Disposable native runner required')
  const powershell = join(windowsEnvironmentValue(env, 'SystemRoot'), 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const start = "[Console]::Error.WriteLine('A');\n"
  const setter = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false);\n"
  const read = "$value=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('READ_DONE');[Console]::Out.Write($value);\n"
  const input = '{"synthetic":"stdin"}'
  const cells = [
    ['new-object-only', start + "$encoder=New-Object System.Text.UTF8Encoding($false);[Console]::Error.WriteLine('C');"],
    ['static-input-encoding', start + '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);\n' + read],
    ['trusted-modules-input-encoding', start + setter + read],
    ['trusted-modules-full-helper', null]
  ]
  return cells.map(([name, script]) => {
    const fullHelper = name === 'trusted-modules-full-helper'
    assert.ok(!fullHelper || referenceCall?.exe === powershell, 'Only the captured synthetic helper can be replayed')
    const args = fullHelper ? referenceCall.args
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    assert.ok(args.join(' ').length + powershell.length + 100 < 32767, 'Diagnostic exceeds native command length')
    const started = Date.now()
    const childEnv = { ...env }
    if (name.startsWith('trusted-modules-')) {
      // Probe only the OS module directory; no owner module/config path is copied.
      for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PSMODULEPATH') delete childEnv[key]
      childEnv.PSModulePath = join(windowsEnvironmentValue(env, 'SystemRoot'), 'System32/WindowsPowerShell/v1.0/Modules')
    }
    const options = fullHelper ? { ...referenceCall.options, env: childEnv }
      : { env: childEnv, input, encoding: 'utf8', timeout: 8000, maxBuffer: 4096, windowsHide: true }
    const raw = spawnSync(powershell, args, options)
    const result = { status: raw.status, signal: raw.signal, error: raw.error?.code, stdout: raw.stdout, stderr: raw.stderr }
    return { name, elapsedMs: Date.now() - started, argumentChars: args.join(' ').length,
      ...result, stdout: String(result.stdout ?? '').slice(-4096), stderr: String(result.stderr ?? '').slice(-4096) }
  })
}
