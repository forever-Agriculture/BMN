// Synthetic tests only: retain process handles before the action under test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export async function windowsExitObserver(entries, killIndex = -1, beforeKill = [], { overallWaitMs, diagnostic = false } = {}) {
  assert.equal(process.platform, 'win32')
  assert.ok(overallWaitMs === undefined || (Number.isInteger(overallWaitMs) && overallWaitMs >= 1 && overallWaitMs <= 15000))
  assert.ok(entries.length && entries.every(entry => Number.isInteger(entry.pid) && entry.pid > 0 && Number.isFinite(entry.creationTime)))
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < entries.length
  assert.ok(killIndex === -1 || validIndex(killIndex))
  assert.ok(beforeKill.every(step => validIndex(step.killIndex) && step.waitIndices.every(validIndex)))
  const stage = (name, index = '-1') => diagnostic ? `Write-Stage '${name}' ${index};\n` : ''
  const diagnosticPrelude = diagnostic ? `$stageWatch=[Diagnostics.Stopwatch]::StartNew(); $script:observerDiagnosticStage='import'; $script:observerDiagnosticEntryIndex=-1;
function Write-Stage([string]$name,[int]$index,[string]$hresult='none') {
 $script:observerDiagnosticStage=$name; $script:observerDiagnosticEntryIndex=$index;
 [Console]::Out.WriteLine([string]::Format('STAGE {0} {1} {2} {3}',$name,$stageWatch.ElapsedMilliseconds,$index,$hresult));
}
try {
` : ''
  const script = `$ErrorActionPreference='Stop';
${diagnosticPrelude}${stage('import')}
Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));
${stage('add-type')}
Add-Type 'using System; using System.Runtime.InteropServices; public static class HeldProcess { [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code); }';
${stage('config')}
$config=ConvertFrom-Json ([Console]::In.ReadLine()); $held=@();
try {
 ${diagnostic ? '$entryIndex=-1;' : ''}
 foreach($entry in $config.entries) {
  ${diagnostic ? "$entryIndex++; Write-Stage 'open' $entryIndex;" : ''}
  $p=[Diagnostics.Process]::GetProcessById($entry.pid); $null=$p.Handle;
  if($null -ne $entry.creationTime) {
   ${stage('start-time', '$entryIndex')}
   $created=($p.StartTime.ToUniversalTime()-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds;
   ${stage('identity', '$entryIndex')}
   if([Math]::Abs($created-$entry.creationTime) -gt 1) { $p.Dispose(); throw 'Observed process creation identity differs' };
  }
  $held+=,$p;
 }
 ${stage('ready')}
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
 $watch=[Diagnostics.Stopwatch]::StartNew();
 foreach($p in $held) {
  $budget=$(if($config.overallWaitMs){[Math]::Max(0,[int]$config.overallWaitMs-[int]$watch.ElapsedMilliseconds)}else{15000});
  if(!$p.WaitForExit($budget)) { throw 'Owned process survived lifecycle action' };
 };
 [Console]::Out.WriteLine((@{passed=$true;retainedHandles=$held.Count} | ConvertTo-Json -Compress));
} finally {
 # These handles refer only to processes created by the isolated fixture.
 $cleanup=[Diagnostics.Stopwatch]::StartNew();
 foreach($p in $held) {
  if(!$p.HasExited) {
   $null=[HeldProcess]::TerminateProcess($p.Handle,99);
   $budget=$(if($config.overallWaitMs){[Math]::Max(0,5000-[int]$cleanup.ElapsedMilliseconds)}else{5000});
   $null=$p.WaitForExit($budget);
  }; $p.Dispose();
 }
}${diagnostic ? `
} catch {
 $exception=$_.Exception; while($exception.InnerException){$exception=$exception.InnerException};
 Write-Stage $script:observerDiagnosticStage $script:observerDiagnosticEntryIndex ('0x{0:X8}' -f $exception.HResult);
 throw;
}` : ''}`
  const metadata = diagnostic ? { stages: [], stagesDropped: 0, timestamps: { spawnedAtMs: Date.now() }, stderrTail: '' } : undefined
  const child = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = '', stderr = '', stageLines = '', completionTimer, readyTimer
  let readySeen = false, readySettled = false, doneSettled = false, closed = false
  let readyResolve, readyReject, doneResolve, doneReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject })
  const diagnosed = (kind, error) => {
    if (metadata) {
      metadata.class ??= kind
      error.observerDiagnostic = metadata
    }
    return error
  }
  const settleReady = error => {
    if (readySettled) return
    readySettled = true; clearTimeout(readyTimer)
    if (error) readyReject(error)
    else readyResolve()
  }
  const settle = (error, receipt) => {
    if (doneSettled) return
    doneSettled = true; clearTimeout(readyTimer); clearTimeout(completionTimer)
    if (!readySeen) settleReady(error ?? new Error('Process observer ended before READY'))
    if (error) doneReject(error)
    else doneResolve(receipt)
  }
  const unconfirmed = () => Object.assign(new Error('Process observer termination is unconfirmed'),
    { code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
  const terminate = error => {
    child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    settle(error)
  }
  const boundCompletion = milliseconds => {
    if (overallWaitMs === undefined || doneSettled) return
    clearTimeout(completionTimer)
    completionTimer = setTimeout(() => terminate(unconfirmed()), milliseconds)
  }
  child.stdout.on('data', data => {
    if (metadata) {
      metadata.timestamps.firstStdoutAtMs ??= Date.now()
      stageLines += data
      while (stageLines.includes('\n')) {
        const end = stageLines.indexOf('\n'), line = stageLines.slice(0, end).trim(); stageLines = stageLines.slice(end + 1)
        const match = /^STAGE (import|add-type|config|open|start-time|identity|ready) (\d{1,12}) (-1|\d{1,4}) (none|0x[0-9A-F]{8})$/u.exec(line)
        if (!match) continue
        metadata.stage = match[1]; metadata.entryIndex = Number(match[3])
        if (match[4] !== 'none') metadata.hresult = match[4]
        metadata.stages.push({ stage: match[1], elapsedMs: Number(match[2]), entryIndex: Number(match[3]), hresult: match[4] })
        if (metadata.stages.length > 32) { metadata.stages.splice(8, 1); metadata.stagesDropped++ }
      }
      if (stageLines.length > 4096) stageLines = ''
    }
    if (output.length < 1024 * 1024) output += data
    if (!readySeen && output.split(/\r?\n/u).includes('READY')) {
      readySeen = true
      if (metadata) metadata.timestamps.readyAtMs = Date.now()
      settleReady()
    }
  })
  child.stderr.on('data', data => {
    if (stderr.length < 65536) stderr += data
    if (metadata) metadata.stderrTail = (metadata.stderrTail + data).slice(-2048)
  })
  child.once('error', error => terminate(diagnosed('spawn-error', error)))
  child.once('exit', () => { if (metadata) metadata.timestamps.exitedAtMs = Date.now() })
  child.once('close', code => {
    closed = true
    if (metadata) { metadata.timestamps.closedAtMs = Date.now(); metadata.helperExitCode = code }
    if (!readySeen) { settle(diagnosed('closed-before-ready', new Error('Process observer ended before READY'))); return }
    if (code !== 0) { settle(new Error(`Process observer failed: ${stderr}`)); return }
    try {
      const receipt = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{')))
      if (overallWaitMs !== undefined) assert.ok(receipt.passed === true && receipt.retainedHandles === entries.length,
        'Retained exit receipt is incomplete')
      settle(undefined, receipt)
    } catch (error) { settle(error) }
  })
  readyTimer = setTimeout(() => {
    settleReady(diagnosed('ready-timeout', new Error('Process observer readiness timeout'))); boundCompletion(10000)
    child.stdin.end('abort\n')
  }, 20000)
  void done.catch(() => {})
  child.stdin.on('error', error => terminate(diagnosed('stdin-error', error)))
  child.stdin.write(JSON.stringify({ entries, killIndex, beforeKill, overallWaitMs }) + '\n')
  try { await ready } catch (error) {
    if (overallWaitMs !== undefined) await done.catch(() => {})
    throw error
  }
  return {
    diagnostic: metadata,
    async finish() {
      boundCompletion(overallWaitMs + 10000)
      if (!closed) child.stdin.end('go\n')
      return done
    },
    async abort() {
      if (!doneSettled) {
        boundCompletion(10000)
        if (!closed && child.stdin.writable) child.stdin.end('abort\n')
      }
      await done.catch(error => { if (error.code === 'DIAGNOSTIC_CUSTODY_UNCONFIRMED') throw error })
    }
  }
}
