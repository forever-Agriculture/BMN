// Read-only identities for isolated native diagnostics; no tokens, command lines or privilege changes.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = `$ErrorActionPreference='Stop'
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/CimCmdlets/CimCmdlets.psd1'))
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
function File-Identity($path) {
  $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($path)
  @{ path=$path; fileVersion=$version.FileVersion; productVersion=$version.ProductVersion; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
}
$process=[Diagnostics.Process]::GetProcessById([int]$r.hostPid)
try { $modules=@($process.Modules | Where-Object { $_.ModuleName -ieq 'conpty.dll' } | ForEach-Object { File-Identity $_.FileName }) } finally { $process.Dispose() }
$anchors=@([int]$r.hostPid)
$chain=@(); $pidToRead=[int]$r.shellPid
for($depth=0;$depth -lt 4 -and $pidToRead -gt 0;$depth++) {
  $p=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$pidToRead)
  if(-not $p) { break }
  $chain+=@{ pid=$p.ProcessId; parentPid=$p.ParentProcessId; imageName=$p.Name }
  if($pidToRead -eq [int]$r.hostPid) { break }
  $anchors+=$pidToRead; $pidToRead=[int]$p.ParentProcessId
}
$hosts=@()
foreach($parent in ($anchors | Select-Object -Unique)) {
  foreach($p in @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId = '+$parent+" AND (Name = 'OpenConsole.exe' OR Name = 'conhost.exe')"))) {
    if($p.ExecutablePath) { $hosts+=@{ pid=$p.ProcessId; parentPid=$p.ParentProcessId; image=(File-Identity $p.ExecutablePath) } }
  }
}
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 6 @{ hostPid=$r.hostPid; shellPid=$r.shellPid; loadedConpty=$modules; consoleCandidates=$hosts; shellParentChain=$chain; association='owned-ancestor-candidates, not a session-host proof' }))`

export async function conptyIdentity(hostPid: number, shellPid: number): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') return { platform: process.platform, unavailable: 'not Windows' }
  if (![hostPid, shellPid].every(pid => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff)) {
    return { unavailable: 'invalid diagnostic process identity' }
  }
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows'
  return new Promise(resolve => {
    const child = spawn(join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = '', settled = false, terminationTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const finish = (value: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(terminationTimer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      terminationTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
        finish({ unavailable: 'identity query exceeded 8 seconds', terminationUnconfirmed: true })
      }, 2_000)
    }, 8_000)
    child.stdout.on('data', bytes => { if (output.length < 64 * 1024) output += bytes.toString('utf8') })
    child.stderr.resume()
    child.on('error', () => finish({ unavailable: 'identity query did not launch', ...(child.pid ? { terminationUnconfirmed: true } : {}) }))
    child.stdin.on('error', () => {})
    child.once('close', code => {
      if (timedOut) { finish({ unavailable: 'identity query exceeded 8 seconds', terminationConfirmed: true }); return }
      if (code !== 0) { finish({ unavailable: 'identity query failed', exitCode: code }); return }
      try { finish(JSON.parse(output) as Record<string, unknown>) }
      catch { finish({ unavailable: 'identity query returned no valid record' }) }
    })
    child.stdin.end(JSON.stringify({ hostPid, shellPid }))
  })
}
