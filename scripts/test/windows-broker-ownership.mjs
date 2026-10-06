// Native discriminator for launch requests handled by an already-running broker.
// All processes are synthetic; retained handles own fixture cleanup only. This
// gate deliberately fails if WMI creates a process outside the session job.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

assert.equal(process.platform, 'win32', 'Native Windows required')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable native runner required')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const system = windowsEnvironmentValue(process.env, 'SystemRoot')
assert.ok(system, 'Windows system directory required')
const powershell = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const root = mkdtempSync(join(tmpdir(), 'bmn-broker-owned-'))
try {
  const node = join(root, 'synthetic-node.exe'), fixture = join(root, 'tree.cjs'), host = join(root, 'host.cjs')
  copyFileSync(process.execPath, node)
  writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const [root,role]=process.argv.slice(2);
const record=(name,value)=>{const target=path.join(root,name+'.json');fs.writeFileSync(target+'.tmp',JSON.stringify(value));fs.renameSync(target+'.tmp',target)};
record(role,{pid:process.pid,role});
if(role==='root'){
 cp.spawn(process.execPath,[__filename,root,'direct-child'],{stdio:'ignore'});
 const request=JSON.parse(fs.readFileSync(path.join(root,'wmi-request.json'),'utf8'));
 const script='$ErrorActionPreference="Stop"; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:BMN_SYNTHETIC_WMI_COMMAND}; $r | Select-Object ReturnValue,ProcessId | ConvertTo-Json -Compress';
 const child=cp.spawnSync(request.powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,BMN_SYNTHETIC_WMI_COMMAND:request.command},encoding:'utf8',timeout:15000,windowsHide:true});
 record('wmi-result',{status:child.status,error:child.error?.name,stdout:child.stdout,stderr:child.stderr});
}
setInterval(()=>{},1000);
setTimeout(()=>process.exit(89),120000).unref(); // Bounded fixture even if its controller crashes.
`)
  writeFileSync(host, `const fs=require('node:fs'),path=require('node:path');
const pty=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const [root,node,fixture]=process.argv.slice(2);
const terminal=pty.spawn(node,[fixture,root,'root'],{cwd:root,env:{...process.env},useConpty:true,useConptyDll:true});
terminal.onData(()=>{});terminal.onExit(()=>process.exit(0));
terminal.onLifecycleError(()=>process.exit(5));
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'stop'))){clearInterval(timer);terminal.kill()}},20);
setTimeout(()=>{terminal.kill();process.exit(6)},30000).unref();
`)
  // These Windows paths cannot contain quotes or trailing slash. The arguments
  // are only this fixture's absolute file locations and constant role names.
  const command = role => [node, fixture, root, role].map(value => `"${value}"`).join(' ')
  writeFileSync(join(root, 'wmi-request.json'), JSON.stringify({ powershell, command: command('broker-child') }))
  const controller = `$ErrorActionPreference='Stop'; $c=ConvertFrom-Json ([Console]::In.ReadToEnd());
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class BrokerFixture {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint size,out uint needed);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 public static uint Integrity() {
  IntPtr token; using(var process=System.Diagnostics.Process.GetCurrentProcess()) {
   if(!OpenProcessToken(process.Handle,8,out token)) throw new System.ComponentModel.Win32Exception();
  }
  IntPtr data=IntPtr.Zero;
  try {
   uint needed; GetTokenInformation(token,25,IntPtr.Zero,0,out needed);
   data=Marshal.AllocHGlobal((int)needed);
   if(!GetTokenInformation(token,25,data,needed,out needed)) throw new System.ComponentModel.Win32Exception();
   IntPtr sid=Marshal.ReadIntPtr(data); byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
   if(count==0) throw new InvalidOperationException("Token SID has no integrity authority");
   return (uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)count-1));
  } finally {if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);CloseHandle(token);}
 }
}
'@
$handles=@(); $hostProcess=$null; $receipt=@{strictOwnership='UNVERIFIED';scope='WMI standard-user Stop discriminator'};
function Retain($pidValue) {
 $p=[Diagnostics.Process]::GetProcessById([int]$pidValue); $null=$p.Handle;
 if($p.MainModule.FileName -ne $c.node) { $p.Dispose(); throw 'Fixture executable identity mismatch' };
 return $p;
}
function WaitRecord($role) {
 $file=Join-Path $c.root ($role+'.json'); $end=[DateTime]::UtcNow.AddSeconds(15);
 while(!(Test-Path -LiteralPath $file)) {
  if($hostProcess -and $hostProcess.HasExited) {throw 'Session host exited before readiness'};
  if([DateTime]::UtcNow -ge $end) {throw 'Fixture readiness timeout'};
  Start-Sleep -Milliseconds 25;
 }
 return [IO.File]::ReadAllText($file) | ConvertFrom-Json;
}
try {
 $receipt.integrityRid=[BrokerFixture]::Integrity();
 if($receipt.integrityRid -ne 8192){throw 'Medium-integrity standard-user fixture required'};
 # Positive WMI control runs under the same standard user before the owned job.
 $control=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$c.control};
 if($control.ReturnValue -ne 0) {throw 'WMI positive control refused'};
 $p=Retain $control.ProcessId; $handles+=,$p; $controlRecord=WaitRecord 'broker-control';
 if($controlRecord.pid -ne $control.ProcessId){throw 'Positive-control receipt identity mismatch'};
 $receipt.positiveControlCreated=$true;
 $start=New-Object Diagnostics.ProcessStartInfo; $start.FileName=$c.electron;
 $start.Arguments='"'+$c.host+'" "'+$c.root+'" "'+$c.node+'" "'+$c.fixture+'"';
 $start.UseShellExecute=$false; $start.CreateNoWindow=$true;
 $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1';
 $hostProcess=[Diagnostics.Process]::Start($start); $null=$hostProcess.Handle;
 $direct=@();
 foreach($role in @('root','direct-child')) {$r=WaitRecord $role; $p=Retain $r.pid; $handles+=,$p; $direct+=,$p};
 $request=WaitRecord 'wmi-result';
 if($request.status -ne 0) {throw 'Owned WMI caller did not complete'};
 $created=$request.stdout | ConvertFrom-Json; $receipt.brokerReturnValue=$created.ReturnValue;
 if($null -eq $created.ReturnValue -or $created.ReturnValue -notin @(0,2,3)){throw 'WMI did not launch or explicitly deny the request'};
 if($created.ReturnValue -eq 0) {
  $broker=Retain $created.ProcessId; $handles+=,$broker; $r=WaitRecord 'broker-child';
  if($r.pid -ne $created.ProcessId) {throw 'Broker receipt identity mismatch'};
 }
 [IO.File]::WriteAllText((Join-Path $c.root 'stop'),'synthetic Stop');
 if(!$hostProcess.WaitForExit(10000)) {throw 'Owned host did not exit'};
 foreach($p in $direct) {if(!$p.WaitForExit(8000)) {throw 'Direct owned child survived Stop'}};
 $receipt.directOwnedChildrenExited=$true;
 $receipt.unrelatedControlAlive=!$handles[0].HasExited;
 if(!$receipt.unrelatedControlAlive) {throw 'Unrelated control was terminated'};
 $receipt.brokerChildSurvived=($created.ReturnValue -eq 0 -and !$broker.WaitForExit(1000));
 $receipt.strictOwnership=if($receipt.brokerChildSurvived){'FAIL'}else{'PASS_WMI_ROUTE_ONLY'};
} catch {$receipt.errorCategory=$_.Exception.GetType().Name; $receipt.strictOwnership='INCONCLUSIVE'}
finally {
 # Cleanup only processes whose actual handles were retained while ready.
 foreach($p in $handles) {
  if(!$p.HasExited -and ![BrokerFixture]::TerminateProcess($p.Handle,88)) {throw 'Synthetic retained-handle cleanup failed'};
  if(!$p.WaitForExit(8000)) {throw 'Synthetic fixture cleanup not confirmed'};
  $p.Dispose();
 }
 if($hostProcess) {
  if(!$hostProcess.HasExited) {if(![BrokerFixture]::TerminateProcess($hostProcess.Handle,88)){throw 'Host cleanup failed'}};
  if(!$hostProcess.WaitForExit(8000)){throw 'Host cleanup not confirmed'}; $hostProcess.Dispose();
 }
}
$receipt | ConvertTo-Json -Compress;`
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(controller, 'utf16le').toString('base64')], {
    input: JSON.stringify({ root, node, host, fixture, electron: requireApp('electron'), control: command('broker-control') }),
    encoding: 'utf8', windowsHide: true, timeout: 150000, maxBuffer: 2 * 1024 * 1024
  })
  let measurement
  try { measurement = JSON.parse(result.stdout) } catch { measurement = { strictOwnership: 'INCONCLUSIVE' } }
  mkdirSync(join(repo, 'test-results'), { recursive: true })
  writeFileSync(join(repo, 'test-results/windows-broker-ownership.json'), JSON.stringify({ ...measurement,
    exit: result.status, errorCategory: result.error?.name, stderr: result.stderr }, null, 2))
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
  assert.equal(measurement.strictOwnership, 'PASS_WMI_ROUTE_ONLY', 'WMI broker escape or incomplete measurement; strict ownership remains unresolved')
  console.log(JSON.stringify(measurement))
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
