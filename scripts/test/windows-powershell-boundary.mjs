// Diagnostic only: seven bounded cells with synthetic stdin and a disposable profile.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

export function measurePowerShellBoundary({ env, plainNode, spawnSync, referenceArgumentBytes, githubActions }) {
  assert.equal(process.platform, 'win32')
  assert.equal(githubActions, true, 'Disposable native runner required')
  const powershell = join(windowsEnvironmentValue(env, 'SystemRoot'), 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const start = "[Console]::Error.WriteLine('A');\n"
  const setter = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false);\n"
  const read = "$value=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('READ_DONE');[Console]::Out.Write($value);\n"
  const input = '{"synthetic":"stdin"}'
  const cells = [
    ['startup', start],
    ['error-preference', start + "$ErrorActionPreference='Stop';[Console]::Error.WriteLine('B');"],
    ['input-encoding', start + setter + "[Console]::Error.WriteLine('C');"],
    ['pipe-eof', start + read],
    ['redirected-encoding-guard', start + 'if(-not [Console]::IsInputRedirected){' + setter + '}\n' + read],
    ['plain-node-input-encoding', start + setter + "[Console]::Error.WriteLine('C');"],
    ['long-argv-startup', start + '#' + 'x'.repeat(Math.ceil(referenceArgumentBytes * 3 / 16))]
  ]
  return cells.map(([name, script]) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    assert.ok(args.join(' ').length + powershell.length + 100 < 32767, 'Diagnostic exceeds native command length')
    const started = Date.now()
    const options = { env, input, encoding: 'utf8', timeout: 8000, maxBuffer: 4096, windowsHide: true }
    let result
    if (name === 'plain-node-input-encoding') {
      const nodeEnv = { ...env }; delete nodeEnv.ELECTRON_RUN_AS_NODE
      const program = "const r=require('node:child_process').spawnSync(process.argv[1],JSON.parse(process.argv[2]),{env:process.env,input:process.argv[3],encoding:'utf8',timeout:8000,maxBuffer:4096,windowsHide:true});console.log(JSON.stringify({status:r.status,signal:r.signal,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}))"
      const outer = spawnSync(plainNode, ['-e', program, powershell, JSON.stringify(args), input],
        { env: nodeEnv, encoding: 'utf8', timeout: 9500, maxBuffer: 8192, windowsHide: true })
      try { result = JSON.parse(outer.stdout) }
      catch { result = { status: outer.status, signal: outer.signal, error: outer.error?.code, stderr: outer.stderr } }
    } else {
      const raw = spawnSync(powershell, args, options)
      result = { status: raw.status, signal: raw.signal, error: raw.error?.code, stdout: raw.stdout, stderr: raw.stderr }
    }
    return { name, elapsedMs: Date.now() - started, argumentChars: args.join(' ').length,
      ...result, stdout: String(result.stdout ?? '').slice(-4096), stderr: String(result.stderr ?? '').slice(-4096) }
  })
}
