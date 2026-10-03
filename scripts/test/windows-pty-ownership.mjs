// Native job ownership acceptance. All processes and files are synthetic.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
assert.equal(process.platform, 'win32')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const root = mkdtempSync(join(tmpdir(), 'bmn-owned-pty-'))
try {
  const fixture = join(root, 'tree.cjs')
  const host = join(root, 'host.cjs')
  writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const [dir,role,...args]=process.argv.slice(2);
fs.writeFileSync(path.join(dir,role+'.json'),JSON.stringify({pid:process.pid,args}));
if(role!=='grandchild') cp.spawn(process.execPath,[__filename,dir,role==='root'?'child':'grandchild'],{stdio:'ignore',detached:true});
setInterval(()=>{if(role==='root'&&fs.existsSync(path.join(dir,'natural')))process.exit(47)},20);
`)
  writeFileSync(host, `const fs=require('node:fs'),path=require('node:path');
const pty=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const [dir,node,fixture,mode]=process.argv.slice(2);
const args=mode==='silent'?['-e','setInterval(()=>{},1000)']:mode==='immediate'?['-e','process.exit(47)']:[fixture,dir,'root','space value','雪','%PATH%','^&','quote"value','C:\\\\with space\\\\'];
const terminal=pty.spawn(node,args,{cwd:dir,env:{...process.env},useConpty:true,useConptyDll:true});
fs.writeFileSync(path.join(dir,'host.json'),JSON.stringify({pid:process.pid,root:terminal.pid,identity:terminal.processStartIdentity,queried:mode==='immediate'?null:pty.queryProcessStartIdentity(terminal.pid)}));
terminal.onData(()=>{});
terminal.onLifecycleError(error=>fs.writeFileSync(path.join(dir,'error.json'),JSON.stringify({error})));
terminal.onExit(exit=>{fs.writeFileSync(path.join(dir,'exit.json'),JSON.stringify(exit));process.exit(0)});
const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'stop'))){clearInterval(timer);terminal.kill()}},20);
setTimeout(()=>{terminal.kill();process.exitCode=3},20000).unref();
`)
  // The controller retains OS process handles before requesting termination. It
  // never opens a PID later to decide which process to kill or calls taskkill.
  const controller = `$ErrorActionPreference='Stop'; $config=ConvertFrom-Json ([Console]::In.ReadToEnd());
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class OwnedFixture {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
  public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string executable;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int[] ConsoleChildren(uint parent) {
  IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
  if(snapshot==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
  try {
   var ids=new List<int>(); var entry=new ProcessEntry {size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};
   if(!Process32FirstW(snapshot,ref entry)) throw new System.ComponentModel.Win32Exception();
   do { if(entry.parent==parent && string.Equals(entry.executable,"OpenConsole.exe",StringComparison.OrdinalIgnoreCase)) ids.Add((int)entry.pid); } while(Process32NextW(snapshot,ref entry));
   return ids.ToArray();
  } finally { CloseHandle(snapshot); }
 }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code);
}
'@
function StartFixture($exe,$arguments) {
 $start=New-Object System.Diagnostics.ProcessStartInfo;
 $start.FileName=$exe; $start.Arguments=$arguments; $start.UseShellExecute=$false; $start.CreateNoWindow=$true;
 $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1';
 $p=[Diagnostics.Process]::Start($start); $null=$p.Handle; return $p;
}
function WaitFile($file,$hostProcess) {
 $end=[DateTime]::UtcNow.AddSeconds(12);
 while(!(Test-Path -LiteralPath $file)) {
  if($hostProcess.HasExited) { throw 'Host exited before fixture ready' };
  if([DateTime]::UtcNow -gt $end) { throw 'Fixture readiness timeout' }; Start-Sleep -Milliseconds 25;
 }
 # Atomic writes below prevent partial JSON reads.
 return [IO.File]::ReadAllText($file) | ConvertFrom-Json;
}
$results=@();
foreach($mode in @('natural','stop','crash','silent','immediate')) {
 $dir=Join-Path $config.root $mode; $null=New-Item -ItemType Directory -Path $dir;
 $hostProcess=$null; $sentinel=$null; $observed=@(); $started=[DateTime]::UtcNow;
 try {
  $sentinel=StartFixture $config.node '-e "setInterval(()=>{},1000)"';
  $arguments='"'+$config.host+'" "'+$dir+'" "'+$config.node+'" "'+$config.fixture+'" '+$mode;
  $hostProcess=StartFixture $config.electron $arguments;
  $record=WaitFile (Join-Path $dir 'host.json') $hostProcess;
  if($record.identity -notmatch '^windows-filetime:[0-9]+$' -or ($mode -ne 'immediate' -and $record.identity -ne $record.queried)) { throw 'Creation identity mismatch' };
  if($mode -ne 'immediate') {
   $p=[Diagnostics.Process]::GetProcessById($record.root); $null=$p.Handle; $observed+=,$p;
  }
  $consoleHandles=0;
  if($mode -ne 'immediate') {
   foreach($consolePid in [OwnedFixture]::ConsoleChildren($hostProcess.Id)) {
    $p=[Diagnostics.Process]::GetProcessById($consolePid); $null=$p.Handle; $observed+=,$p; $consoleHandles++;
   }
   if($consoleHandles -eq 0) { throw 'OpenConsole observer was not established' };
  }
  if($mode -in @('natural','stop','crash')) {
   foreach($role in @('child','grandchild')) {
    $r=WaitFile (Join-Path $dir ($role+'.json')) $hostProcess;
    $p=[Diagnostics.Process]::GetProcessById($r.pid); $null=$p.Handle; $observed+=,$p;
   }
   $r=[IO.File]::ReadAllText((Join-Path $dir 'root.json')) | ConvertFrom-Json;
   $expected=@('space value','雪','%PATH%','^&','quote"value','C:\\with space\\');
   if(($r.args | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress)) { throw 'Argument round-trip mismatch' };
  }
  if($mode -eq 'crash') {
   if(![OwnedFixture]::TerminateProcess($hostProcess.Handle,77)) { throw 'Fixture host termination failed' };
  } elseif($mode -eq 'natural') { [IO.File]::WriteAllText((Join-Path $dir 'natural'),'go') }
  elseif($mode -ne 'immediate') { [IO.File]::WriteAllText((Join-Path $dir 'stop'),'go') };
  foreach($p in $observed) { if(!$p.WaitForExit(8000)) { throw 'Owned descendant survived' } };
  if(!$hostProcess.WaitForExit(8000)) { throw 'Host exit timeout' };
  if($sentinel.HasExited) { throw 'Unrelated sentinel was terminated' };
  $exit=$null;
  if($mode -ne 'crash') {
   $exit=[IO.File]::ReadAllText((Join-Path $dir 'exit.json')) | ConvertFrom-Json;
   $expectedCode=1; if($mode -in @('natural','immediate')) { $expectedCode=47 };
   if($exit.exitCode -ne $expectedCode) { throw 'Incorrect root exit status' };
  }
  $results+=@{mode=$mode;passed=$true;retainedProcessHandles=$observed.Count;openConsoleHandles=$consoleHandles;sentinelAlive=$true;exit=$exit;elapsedMs=([DateTime]::UtcNow-$started).TotalMilliseconds};
 } finally {
  # Only retained handles of this fixture's processes can be terminated here.
  foreach($p in @($hostProcess,$sentinel)+$observed) {
   if($null -ne $p) { if(!$p.HasExited) { $null=[OwnedFixture]::TerminateProcess($p.Handle,99); $null=$p.WaitForExit(3000) }; $p.Dispose() }
  }
 }
}
$results | ConvertTo-Json -Depth 8 -Compress;
`
  // Fixtures publish JSON atomically, including when the shell exits immediately.
  for (const file of [fixture, host]) {
    const source = readFileSync(file, 'utf8').replaceAll('fs.writeFileSync(', 'publish(')
    writeFileSync(file, `function publish(file,data){fs.writeFileSync(file+'.tmp',data);fs.renameSync(file+'.tmp',file)}\n${source}`)
  }
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(controller, 'utf16le').toString('base64')], {
    input: JSON.stringify({ root, host, fixture, node: process.execPath, electron: requireApp('electron') }), encoding: 'utf8', timeout: 120000, windowsHide: true
  })
  mkdirSync(join(repo, 'test-results'), { recursive: true })
  const receipt = { status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }
  writeFileSync(join(repo, 'test-results/windows-pty-ownership.json'), JSON.stringify(receipt, null, 2))
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout)
  assert.equal(rows.length, 5)
  assert.ok(rows.every(row => row.passed))
  console.log('PASS owned native tree cleanup: natural exit, Stop, host crash, silent and immediate shells')
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
