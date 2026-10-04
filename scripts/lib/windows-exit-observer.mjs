// Synthetic tests only: retain process handles before the action under test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export async function windowsExitObserver(entries, killIndex = -1, beforeKill = []) {
  assert.equal(process.platform, 'win32')
  assert.ok(entries.length && entries.every(entry => Number.isInteger(entry.pid) && entry.pid > 0 && Number.isFinite(entry.creationTime)))
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < entries.length
  assert.ok(killIndex === -1 || validIndex(killIndex))
  assert.ok(beforeKill.every(step => validIndex(step.killIndex) && step.waitIndices.every(validIndex)))
  const script = `$ErrorActionPreference='Stop';
Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));
Add-Type 'using System; using System.Runtime.InteropServices; public static class HeldProcess { [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code); }';
$config=ConvertFrom-Json ([Console]::In.ReadLine()); $held=@();
try {
 foreach($entry in $config.entries) {
  $p=[Diagnostics.Process]::GetProcessById($entry.pid); $null=$p.Handle;
  if($null -ne $entry.creationTime) {
   $created=($p.StartTime.ToUniversalTime()-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds;
   if([Math]::Abs($created-$entry.creationTime) -gt 1) { $p.Dispose(); throw 'Observed process creation identity differs' };
  }
  $held+=,$p;
 }
 [Console]::Out.WriteLine('READY');
 if([Console]::In.ReadLine() -ne 'go') { throw 'Observation aborted' };
 foreach($step in $config.beforeKill) {
  if($null -eq $config.entries[$step.killIndex].creationTime) { throw 'Termination requires creation identity' };
  if(![HeldProcess]::TerminateProcess($held[$step.killIndex].Handle,77)) { throw 'Synthetic utility crash failed' };
  foreach($index in $step.waitIndices) { if(!$held[$index].WaitForExit(15000)) { throw 'Owned process survived utility crash' } };
 }
 if($config.killIndex -ge 0) {
  if($null -eq $config.entries[$config.killIndex].creationTime) { throw 'Termination requires creation identity' };
  if(![HeldProcess]::TerminateProcess($held[$config.killIndex].Handle,77)) { throw 'Synthetic host crash failed' };
 }
 foreach($p in $held) { if(!$p.WaitForExit(15000)) { throw 'Owned process survived lifecycle action' } };
 [Console]::Out.WriteLine((@{passed=$true;retainedHandles=$held.Count} | ConvertTo-Json -Compress));
} finally {
 # These handles refer only to processes created by the isolated fixture.
 foreach($p in $held) { if(!$p.HasExited) { $null=[HeldProcess]::TerminateProcess($p.Handle,99); $null=$p.WaitForExit(5000) }; $p.Dispose() }
}`
  const child = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = '', stderr = ''
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.stdout.on('data', data => { output += data; if (output.includes('READY')) readyResolve() })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => { child.stdin.end('abort\n'); readyReject(new Error('Process observer readiness timeout')) }, 20000)
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { readyReject(error); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) { const error = new Error(`Process observer failed: ${stderr}`); readyReject(error); reject(error); return }
      const line = output.split(/\r?\n/).find(line => line.startsWith('{'))
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    })
  })
  // Failure can arrive before the caller begins the lifecycle action.
  void done.catch(() => {})
  child.stdin.write(JSON.stringify({ entries, killIndex, beforeKill }) + '\n')
  await ready
  clearTimeout(timer)
  return {
    async finish() { child.stdin.end('go\n'); return done },
    async abort() { if (child.exitCode === null) child.stdin.end('abort\n'); await done.catch(() => {}) }
  }
}
