// Story 53.4/53.6: actual native launcher cleanup and embedded OpenCode Bun deadlines.
// All processes, profiles and files are synthetic; no OpenCode provider entrypoint runs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msvcEnvironment } from '../lib/msvc.mjs'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable native runner only')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), 'bmn-cli-owned-雪 space-'))
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const resultFile = join(repo, 'test-results/windows-cli-ownership.json')
const result = { status: 'FAIL', checks: [] }
let cleanupError
let controllerBackstop
const run = (exe, argv, options = {}) => {
  // The backstop outlives every original/fixed observation. Only controller
  // completion, failure or timeout closes it, including partially retained trees.
  const command = controllerBackstop && exe === powershell ? controllerBackstop : exe
  const args = command === controllerBackstop ? [exe, ...argv] : argv
  assert.ok(command.length + args.join(' ').length + 1024 < 32767, 'Fixture command exceeds the native command-line limit')
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options })
  if (exe === powershell && r.stderr) (result.processDiagnostics ??= []).push(r.stderr)
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  return r.stdout
}
try {
  const env = msvcEnvironment()
  const fixture = join(root, 'runtime.cjs')
  writeFileSync(fixture, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const dir=process.env.BMN_FIXTURE_DIR,role=process.argv[2]||'root';
function publish(name,data){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(data));fs.renameSync(p+'.tmp',p)}
publish(role+'.json',{pid:process.pid});
if(role!=='grandchild')cp.spawn(process.execPath,[__filename,role==='root'?'child':'grandchild'],{stdio:'ignore',detached:true});
setInterval(()=>{if(role==='root'&&fs.existsSync(path.join(dir,'natural')))process.exit(17)},20);
`)
  const previous = readFileSync(new URL('./fixtures/windows-cli-launcher-baseline.c', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(createHash('sha256').update(previous).digest('hex'), '6839f21f6a8bd79f55393ff3a4f1bd3a40ba5a1b2cd8f35db557b412631e2f40')
  result.baseline = { commit: 'a332ac00e5e7bf743fc389c61a8d997a2ea85217', sha256: '6839f21f6a8bd79f55393ff3a4f1bd3a40ba5a1b2cd8f35db557b412631e2f40' }
  const oldSource = join(root, 'original.c'); writeFileSync(oldSource, previous)
  for (const [name, source] of [['original', oldSource], ['fixed', join(repo, 'apps/desktop/native/windows-cli/bmn-launcher.c')]]) {
    const directory = join(root, name); mkdirSync(directory)
    run('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/DUNICODE', '/D_UNICODE', source,
      `/Fe:${join(directory, 'bmn.exe')}`, `/Fo:${join(directory, 'launcher.obj')}`, '/link', '/SUBSYSTEM:CONSOLE'], { cwd: directory, env })
    writeFileSync(join(directory, 'bmn.runtime'), `${process.execPath}\r\n${fixture}\r\n`)
  }
  const faults = join(root, 'faults'); mkdirSync(faults)
  run('cl.exe', ['/nologo', '/W4', '/WX', '/O2', '/MT', '/DUNICODE', '/D_UNICODE', '/DBMN_CLI_OWNERSHIP_TEST',
    join(repo, 'apps/desktop/native/windows-cli/bmn-launcher.c'), `/Fe:${join(faults, 'bmn.exe')}`,
    `/Fo:${join(faults, 'launcher.obj')}`, '/link', '/SUBSYSTEM:CONSOLE'], { cwd: faults, env })
  writeFileSync(join(faults, 'bmn.runtime'), `${process.execPath}\r\n${fixture}\r\n`)
  // Probe exactly the shipped decoding form before any controller creates files.
  // Code units keep diagnostic output independent of PowerShell's stdout encoding.
  const utf8Input = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);'
  const utility = `$ErrorActionPreference='Stop';
foreach($module in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
 Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$module,$module+'.psd1'));
};$PSModuleAutoLoadingPreference='None';
function CheckCommand($name,$source,$type='Cmdlet') {
 $command=Get-Command -Name $name -ErrorAction Stop;
 if($command.Source -cne $source -or $command.CommandType -ne $type){throw ('Unexpected fixture command: '+$name)};
 if($source -ne 'Microsoft.PowerShell.Core') {
  $expected=[IO.Path]::Combine($PSHOME,'Modules',$source);
  if(!$command.Module.ModuleBase.Equals($expected,[StringComparison]::OrdinalIgnoreCase)){throw ('Unexpected fixture module path: '+$name)};
 }
}
foreach($name in @('Import-Module','Get-Command','Get-Module','ForEach-Object')) {CheckCommand $name 'Microsoft.PowerShell.Core'};
foreach($name in @('Start-Sleep','Add-Type','ConvertFrom-Json','ConvertTo-Json')) {CheckCommand $name 'Microsoft.PowerShell.Utility'};
CheckCommand 'Join-Path' 'Microsoft.PowerShell.Management';
[Console]::Error.WriteLine((ConvertTo-Json -Compress @{version=$PSVersionTable.PSVersion.ToString();is64Bit=[Environment]::Is64BitProcess;modules=@(Get-Module|ForEach-Object{@{name=$_.Name;version=$_.Version.ToString();path=$_.ModuleBase}})}));
`
  const rootCodeUnits = Array.from({ length: root.length }, (_, index) => root.charCodeAt(index))
  const configInput = values => JSON.stringify({ root, rootCodeUnits, ...values })
  const decoded = prefix => JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + utility + `$config=ConvertFrom-Json ([Console]::In.ReadToEnd());[Console]::Out.Write((ConvertTo-Json -Compress @{rootCodeUnits=@($config.root.ToCharArray()|ForEach-Object{[int]$_});launcherExists=[IO.File]::Exists([IO.Path]::Combine($config.root,'original','bmn.exe'));encoding=[Console]::InputEncoding.WebName}))`, 'utf16le').toString('base64')], { input: configInput({}) }))
  const originalInput = decoded(''), fixedInput = decoded(utf8Input)
  result.checks.push({ name: 'Unicode stdin decoding original RED/fixed GREEN', original: originalInput, fixed: fixedInput })
  assert.notDeepEqual(originalInput.rootCodeUnits, rootCodeUnits, 'Original decoding hypothesis must reproduce before proceeding')
  assert.equal(originalInput.launcherExists, false)
  assert.deepEqual(fixedInput.rootCodeUnits, rootCodeUnits)
  assert.equal(fixedInput.launcherExists, true)
  const readConfig = utf8Input + utility + `$config=ConvertFrom-Json ([Console]::In.ReadToEnd());if([string]::Join(',',([int[]]@($config.root.ToCharArray()|ForEach-Object{[int]$_}))) -cne [string]::Join(',',([int[]]$config.rootCodeUnits))){throw 'Fixture root Unicode decoding mismatch'};`
  const controller = readConfig + `
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OwnedCliFixture {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code);
}
'@
function ReadReady($file,$launcher) {
 $end=[DateTime]::UtcNow.AddSeconds(10);
 while(![IO.File]::Exists($file)) { if($launcher.HasExited){throw 'Launcher exited before ready'};if([DateTime]::UtcNow -gt $end){throw 'Readiness timeout'};Start-Sleep -Milliseconds 20 };
 return ConvertFrom-Json ([IO.File]::ReadAllText($file));
}
function CleanupProcesses($processes,$primaryError) {
 $errors=[Collections.Generic.List[string]]::new();
 foreach($p in $processes) {if($null -ne $p) {
  try {
   if(!$p.HasExited) {
    if(![OwnedCliFixture]::TerminateProcess($p.Handle,99)){throw 'Retained fixture termination failed'};
    if(!$p.WaitForExit(5000)){throw 'Retained fixture cleanup timeout'};
   }
  } catch {$errors.Add($_.Exception.Message)}
  finally {try {$p.Dispose()} catch {$errors.Add($_.Exception.Message)}}
 }}
 if($errors.Count -gt 0) {
  [Console]::Error.WriteLine((ConvertTo-Json -Compress @{cleanupErrors=@($errors.ToArray())}));
  if(!$primaryError){throw 'Fixture cleanup incomplete'};
 }
}
$rows=@();
foreach($version in @('original','fixed')) {foreach($mode in @('natural','terminate')) {
 $dir=Join-Path $config.root ($version+'-'+$mode);$null=[IO.Directory]::CreateDirectory($dir);$held=@();$launcher=$null;$sentinel=$null;$primaryError=$null;
 try {
  $start=[Diagnostics.ProcessStartInfo]::new();$start.UseShellExecute=$false;$start.CreateNoWindow=$true;
  $start.FileName=$config.node;$start.Arguments='-e "setInterval(()=>{},1000)"';$sentinel=[Diagnostics.Process]::Start($start);$null=$sentinel.Handle;
  $start.FileName=Join-Path (Join-Path $config.root $version) 'bmn.exe';$start.Arguments='';$start.EnvironmentVariables['BMN_FIXTURE_DIR']=$dir;
  if(![IO.File]::Exists($start.FileName)){throw ('Fixture executable missing before Start: '+$start.FileName)};
  $launcher=[Diagnostics.Process]::Start($start);$null=$launcher.Handle;
  foreach($role in @('root','child','grandchild')) {
   $record=ReadReady (Join-Path $dir ($role+'.json')) $launcher;
   $p=[Diagnostics.Process]::GetProcessById($record.pid);$null=$p.Handle;$held+=,$p;
  }
  if($mode -eq 'natural'){[IO.File]::WriteAllText((Join-Path $dir 'natural'),'go')}
  else{if(![OwnedCliFixture]::TerminateProcess($launcher.Handle,77)){throw 'Retained launcher termination failed'}};
  if(!$launcher.WaitForExit(8000)){throw 'Launcher failed to exit'};
  if($mode -eq 'natural' -and $launcher.ExitCode -ne 17){throw 'Exit code was not preserved'};
  $allExited=$true;foreach($p in $held){if(!$p.WaitForExit(2000)){$allExited=$false}};
  if($sentinel.HasExited){throw 'Unrelated sentinel was killed'};
  if($version -eq 'fixed' -and !$allExited){throw 'Owned runtime tree survived'};
  if($version -eq 'original' -and $allExited){throw 'Original defect was not reproduced'};
  $rows+=@{version=$version;mode=$mode;retainedHandles=$held.Count;allExited=$allExited;sentinelAlive=$true;launcherExit=$launcher.ExitCode};
 } catch {$primaryError=$_;throw} finally {CleanupProcesses (@($launcher,$sentinel)+$held) $primaryError}
}}
foreach($boundary in @('created','resumed')) {
 $dir=Join-Path $config.root ('fault-'+$boundary);$null=[IO.Directory]::CreateDirectory($dir);$launcher=$null;$runtime=$null;$primaryError=$null;
 try {
  $start=[Diagnostics.ProcessStartInfo]::new();$start.UseShellExecute=$false;$start.CreateNoWindow=$true;
  $start.FileName=Join-Path $config.root 'faults/bmn.exe';$start.EnvironmentVariables['BMN_FIXTURE_DIR']=$dir;
  $start.EnvironmentVariables['BMN_CLI_TEST_BOUNDARY']=$boundary;$record=Join-Path $dir 'creation.pid';$start.EnvironmentVariables['BMN_CLI_TEST_RECORD']=$record;
  if(![IO.File]::Exists($start.FileName)){throw ('Fixture executable missing before Start: '+$start.FileName)};
  $launcher=[Diagnostics.Process]::Start($start);$null=$launcher.Handle;
  $runtimePid=ReadReady $record $launcher;$runtime=[Diagnostics.Process]::GetProcessById($runtimePid);$null=$runtime.Handle;
  if(![OwnedCliFixture]::TerminateProcess($launcher.Handle,77)){throw 'Boundary launcher termination failed'};
  if(!$launcher.WaitForExit(8000) -or !$runtime.WaitForExit(8000)){throw 'Creation boundary leaked suspended/resumed runtime'};
  $rows+=@{mode=$boundary;version='fault';retainedHandles=1;allExited=$true};
 } catch {$primaryError=$_;throw} finally {CleanupProcesses (@($launcher,$runtime)) $primaryError}
}
$rows|ConvertTo-Json -Depth 5 -Compress;
`
  // A distinct outer lifetime protects even the baseline's deliberately leaked
  // descendants when a controller aborts before retaining all their handles.
  const fallback = join(root, 'fallback'); mkdirSync(fallback)
  const driver = join(fallback, 'driver.cjs')
  writeFileSync(driver, `const cp=require('node:child_process');
if(process.argv[2]==='--self-test') {
 cp.spawn(process.execPath,[process.argv[3]],{stdio:'ignore',env:{...process.env,BMN_FIXTURE_DIR:process.argv[4]}});
 setInterval(()=>{},1000);
} else {
 const child=cp.spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit',windowsHide:true});
 process.exit(child.error||child.signal?1:child.status??1);
}
`)
  copyFileSync(join(root, 'fixed/bmn.exe'), join(fallback, 'bmn.exe'))
  writeFileSync(join(fallback, 'bmn.runtime'), `${process.execPath}\r\n${driver}\r\n`)
  controllerBackstop = join(fallback, 'bmn.exe')
  const fallbackProof = controller.slice(0, controller.indexOf('$rows=@();')) + `
$held=@();$outer=$null;$sentinel=$null;$primaryError=$null;
try {
 $start=[Diagnostics.ProcessStartInfo]::new();$start.UseShellExecute=$false;$start.CreateNoWindow=$true;
 $start.FileName=$config.node;$start.Arguments='-e "setInterval(()=>{},1000)"';$sentinel=[Diagnostics.Process]::Start($start);$null=$sentinel.Handle;
 $start.FileName=$config.backstop;$start.Arguments='--self-test "'+$config.fixture+'" "'+$config.directory+'"';
 $outer=[Diagnostics.Process]::Start($start);$null=$outer.Handle;
 foreach($role in @('root','child','grandchild')) {
  $row=ReadReady (Join-Path $config.directory ($role+'.json')) $outer;
  $p=[Diagnostics.Process]::GetProcessById($row.pid);$null=$p.Handle;$held+=,$p;
 }
 if(![OwnedCliFixture]::TerminateProcess($outer.Handle,77)){throw 'Backstop controller termination failed'};
 if(!$outer.WaitForExit(5000)){throw 'Backstop launcher remained live'};
 foreach($p in $held){if(!$p.WaitForExit(5000)){throw 'Backstop leaked a retained descendant'}};
 if($sentinel.HasExited){throw 'Backstop terminated unrelated sentinel'};
 [Console]::Out.Write((ConvertTo-Json -Compress @{retainedHandles=$held.Count;allExited=$true;sentinelAlive=$true}));
} catch {$primaryError=$_;throw} finally {CleanupProcesses (@($outer,$sentinel)+$held) $primaryError}
`
  const proofDirectory = join(root, 'fallback-proof'); mkdirSync(proofDirectory)
  const fallbackRows = JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fallbackProof, 'utf16le').toString('base64')], {
    input: configInput({ node: process.execPath, backstop: join(fallback, 'bmn.exe'), fixture, directory: proofDirectory })
  }))
  assert.deepEqual(fallbackRows, { retainedHandles: 3, allExited: true, sentinelAlive: true })
  result.checks.push({ name: 'controller termination backstop cleans retained descendants and preserves unrelated sentinel', ...fallbackRows })
  const rows = JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(controller, 'utf16le').toString('base64')], {
    input: configInput({ node: process.execPath })
  }))
  assert.equal(rows.length, 6)
  assert.ok(rows.every(row => row.retainedHandles === (row.version === 'fault' ? 1 : 3)))
  result.checks.push({ name: 'retained-handle cleanup baseline RED/fixed GREEN', rows })
  // Download one pinned public OpenCode binary into this disposable fixture only.
  const url = 'https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-windows-x64-baseline.zip'
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  assert.equal(response.ok, true, `Public fixture download HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(archive).digest('hex')
  assert.equal(sha256, 'cd852831bd094c2df2eb379eb98bed7a63db7f823a7caf277c732cdac33cbdb6')
  const archiveModule = "Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1'));CheckCommand 'Expand-Archive' 'Microsoft.PowerShell.Archive' 'Function';"
  run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(utf8Input + utility + archiveModule, 'utf16le').toString('base64')])
  const zip = join(root, 'opencode.zip'), unpacked = join(root, 'opencode'); writeFileSync(zip, archive)
  const expand = readConfig + archiveModule + 'Expand-Archive -LiteralPath $config.archive -DestinationPath $config.destination'
  run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(expand, 'utf16le').toString('base64')], {
    input: configInput({ archive: zip, destination: unpacked })
  })
  const executable = readdirSync(unpacked, { recursive: true }).find(path => String(path).endsWith('opencode.exe'))
  assert.ok(executable); const bun = join(unpacked, executable)
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp', 'comspec'].includes(key.toLowerCase())))
  for (const name of ['home', 'config', 'cache', 'data', 'state']) mkdirSync(join(root, 'profile', name), { recursive: true })
  Object.assign(clean, { BUN_BE_BUN: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', HOME: join(root, 'profile/home'), USERPROFILE: join(root, 'profile/home'),
    APPDATA: join(root, 'profile/config'), LOCALAPPDATA: join(root, 'profile/data'), XDG_CONFIG_HOME: join(root, 'profile/config'),
    XDG_CACHE_HOME: join(root, 'profile/cache'), XDG_DATA_HOME: join(root, 'profile/data'), XDG_STATE_HOME: join(root, 'profile/state'),
    PATH: `${join(root, 'fixed')};${join(process.env.SystemRoot, 'System32')}` })
  const runtime = run(bun, ['--version'], { env: clean }).trim()
  assert.match(runtime, /^\d+\.\d+\.\d+$/, 'Record the actual native embedded runtime')
  const plugin = run(process.execPath, [join(repo, 'apps/desktop/bin/bmn'), 'hooks', 'print', 'opencode'], { env: clean })
  const start = plugin.indexOf('  const nativeRun = '), end = plugin.indexOf('\n  // An answer BMN', start)
  assert.ok(start >= 0 && end > start)
  const helper = plugin.slice(start, end).replace('  const nativeRun =', 'export const nativeRun =')
  writeFileSync(join(root, 'native-run.ts'), helper)
  const simple = join(root, 'simple.cjs')
  writeFileSync(simple, `const mode=process.env.BMN_FIXTURE_MODE;
if(mode==='stall'||mode==='blocked'){setInterval(()=>{},1000)}
else if(mode==='stdout'||mode==='stderr'){process[mode].write(Buffer.alloc(1024*1024+1));setInterval(()=>{},1000)}
else{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),raw,pin:process.env.BMN_OPENCODE_SESSION_ID}));process.exitCode=mode==='nonzero'?17:0})}
`)
  writeFileSync(join(root, 'fixed/bmn.runtime'), `${process.execPath}\r\n${simple}\r\n`)
  const probeFile = join(root, 'bun-probe.json')
  writeFileSync(join(root, 'probe.ts'), `import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {nativeRun} from './native-run.ts';
const rows=[];const argv=['','雪 Київ','space value','quote"value','%PATH%','^&','trailing\\\\'];const raw='line1\\n雪 "quote"';
const env={...process.env,BMN_OPENCODE_SESSION_ID:'synthetic-pin'};
const echo=await nativeRun(argv,raw,{...env,BMN_FIXTURE_MODE:'echo'},3000);
assert.equal(echo.exitCode,0);assert.deepEqual(JSON.parse(echo.stdout.toString()),{argv,raw,pin:'synthetic-pin'});rows.push('literal argv/raw stdin/pin');
assert.equal((await nativeRun([], '', {...env,BMN_FIXTURE_MODE:'nonzero'},3000)).exitCode,17);rows.push('truthful nonzero');
for(const mode of ['stall','blocked','stdout','stderr']){const started=Date.now();const value=await nativeRun([],mode==='blocked'?'x'.repeat(1024*1024):'',{...env,BMN_FIXTURE_MODE:mode},1000);assert.equal(value.exitCode,1);assert.equal(value.stdout.length,0);assert.ok(Date.now()-started<8000);rows.push(mode+' bounded kill/reap')}
assert.equal((await nativeRun([],'x'.repeat(1024*1024+1),env,1000)).exitCode,1);rows.push('oversize rejected');
assert.equal((await nativeRun([],'',{...env,PATH:process.env.SystemRoot+'\\\\System32'},1000)).exitCode,1);rows.push('missing exe settles');
writeFileSync(process.argv[2],JSON.stringify({runtime:Bun.version,platform:process.platform,checks:rows,status:'PASS'}));
`)
  // The Bun probe itself is in the verified ConPTY outer job. Killing a stuck
  // fixture host therefore closes its job handle, including launcher/runtime trees.
  const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
  const host = join(root, 'owned-bun-host.cjs')
  writeFileSync(host, `const pty=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const env=${JSON.stringify(clean)};
const terminal=pty.spawn(${JSON.stringify(bun)},['run',${JSON.stringify(join(root, 'probe.ts'))},${JSON.stringify(probeFile)}],{cwd:${JSON.stringify(root)},env,useConpty:true,useConptyDll:true});
if(!/^windows-filetime:[0-9]+$/.test(terminal.processStartIdentity)){terminal.kill();throw new Error('Outer job identity missing')}
let output='';terminal.onData(data=>{output=(output+data).slice(-32768)});let timedOut=false;
const timer=setTimeout(()=>{timedOut=true;terminal.kill()},60000);
terminal.onLifecycleError(error=>console.error(error));
terminal.onExit(exit=>{clearTimeout(timer);if(exit.exitCode!==0)console.error(output);process.exit(timedOut?3:exit.exitCode)});
`)
  run(requireApp('electron'), [host], { env: { ...clean, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90000 })
  const probe = JSON.parse(readFileSync(probeFile, 'utf8')); assert.equal(probe.checks.length, 8)
  assert.equal(probe.runtime, runtime); assert.equal(probe.platform, 'win32')
  result.checks.push({ name: 'real embedded Bun/native launcher component', url, sha256, ...probe, helperSha256: createHash('sha256').update(helper).digest('hex') })
  // Combine the real Bun helper, launcher job and inherited descendant pipes.
  // The controller opens every process handle before allowing overflow or Stop.
  const controlled = join(root, 'controlled.cjs')
  writeFileSync(controlled, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const dir=process.env.BMN_FIXTURE_DIR,role=process.argv[2]||'root';
function publish(name,data){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(data));fs.renameSync(p+'.tmp',p)}
publish(role+'.json',{pid:process.pid});
if(role!=='grandchild')cp.spawn(process.execPath,[__filename,role==='root'?'child':'grandchild'],{stdio:['ignore','inherit','inherit'],detached:true});
let emitted=false;setInterval(()=>{if(role==='root'&&!emitted&&fs.existsSync(path.join(dir,'release'))){emitted=true;if(process.env.BMN_FIXTURE_CASE==='overflow')process.stderr.write(Buffer.alloc(1024*1024+1))}},20);
`)
  writeFileSync(join(root, 'fixed/bmn.runtime'), `${process.execPath}\r\n${controlled}\r\n`)
  const combinedProbe = join(root, 'combined.ts')
  writeFileSync(combinedProbe, `import assert from 'node:assert/strict';import {writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {nativeRun} from './native-run.ts';
const [dir,mode]=process.argv.slice(2);const real=Bun.spawn;
function publish(name,data){const p=join(dir,name);writeFileSync(p+'.tmp',JSON.stringify(data));renameSync(p+'.tmp',p)}
Bun.spawn=((...args)=>{const child=real(...args);publish('launcher.json',{pid:child.pid});return child}) as typeof Bun.spawn;
const result=await nativeRun([], '', {...process.env,BMN_FIXTURE_DIR:dir,BMN_FIXTURE_CASE:mode},10000);
assert.equal(result.exitCode,mode==='launcher-crash'?77:1);assert.equal(result.stdout.length,0);publish('component.json',{exitCode:result.exitCode,emptyOutput:true});
`)
  const combinedHost = join(root, 'combined-host.cjs')
  writeFileSync(combinedHost, `const fs=require('node:fs'),path=require('node:path');const pty=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const [dir,mode]=process.argv.slice(2);function publish(name,data){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(data));fs.renameSync(p+'.tmp',p)}
const terminal=pty.spawn(${JSON.stringify(bun)},['run',${JSON.stringify(combinedProbe)},dir,mode],{cwd:${JSON.stringify(root)},env:${JSON.stringify(clean)},useConpty:true,useConptyDll:true});
publish('bun.json',{pid:terminal.pid,identity:terminal.processStartIdentity});let output='';terminal.onData(data=>{output=(output+data).slice(-32768)});let watchdog=false;
const timer=setTimeout(()=>{watchdog=true;terminal.kill()},30000);const stop=setInterval(()=>{if(fs.existsSync(path.join(dir,'stop'))){clearInterval(stop);terminal.kill()}},20);
terminal.onLifecycleError(error=>publish('lifecycle-error.json',{error}));
terminal.onExit(exit=>{clearTimeout(timer);clearInterval(stop);publish('exit.json',{...exit,watchdog,outputTail:output});process.exit(0)});
`)
  const combinedController = controller.slice(0, controller.indexOf('$rows=@();')) + `
$rows=@();
foreach($mode in @('timeout','overflow','launcher-crash','stop')) {
 $dir=Join-Path $config.root ('combined-'+$mode);$null=[IO.Directory]::CreateDirectory($dir);$hostProcess=$null;$held=@();$launcher=$null;$primaryError=$null;
 try {
  $start=[Diagnostics.ProcessStartInfo]::new();$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.FileName=$config.electron;
  $start.Arguments='"'+$config.host+'" "'+$dir+'" '+$mode;$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1';
  $hostProcess=[Diagnostics.Process]::Start($start);$null=$hostProcess.Handle;
  foreach($role in @('bun','launcher','root','child','grandchild')) {
   $record=ReadReady (Join-Path $dir ($role+'.json')) $hostProcess;
   if($role -eq 'bun' -and $record.identity -notmatch '^windows-filetime:[0-9]+$'){throw 'Outer job identity missing'};
   $p=[Diagnostics.Process]::GetProcessById($record.pid);$null=$p.Handle;$held+=,$p;if($role -eq 'launcher'){$launcher=$p};
  }
  if($mode -eq 'launcher-crash'){if(![OwnedCliFixture]::TerminateProcess($launcher.Handle,77)){throw 'Retained launcher crash failed'}}
  elseif($mode -eq 'stop'){[IO.File]::WriteAllText((Join-Path $dir 'stop'),'go')}
  else{[IO.File]::WriteAllText((Join-Path $dir 'release'),'go')};
  if(!$hostProcess.WaitForExit(15000)){throw 'Combined fixture host timeout'};
  foreach($p in $held){if(!$p.WaitForExit(8000)){throw 'Combined helper leaked an owned process'}};
  $exit=ReadReady (Join-Path $dir 'exit.json') $hostProcess;
  if($exit.watchdog -or [IO.File]::Exists((Join-Path $dir 'lifecycle-error.json'))){throw 'Safety watchdog/lifecycle failure is not success'};
  if($mode -ne 'stop'){$component=ReadReady (Join-Path $dir 'component.json') $hostProcess;if(!$component.emptyOutput -or $exit.exitCode -ne 0){throw 'Combined helper did not settle truthfully'}};
  $rows+=@{mode=$mode;retainedHandles=$held.Count;allExited=$true;watchdog=$false;outerExit=$exit.exitCode};
 } catch {$primaryError=$_;throw} finally {CleanupProcesses (@($hostProcess)+$held) $primaryError}
}
$rows|ConvertTo-Json -Depth 5 -Compress;
`
  const combined = JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(combinedController, 'utf16le').toString('base64')], {
    input: configInput({ host: combinedHost, electron: requireApp('electron') })
  }))
  assert.equal(combined.length, 4)
  assert.ok(combined.every(row => row.retainedHandles === 5 && row.allExited && !row.watchdog))
  result.checks.push({ name: 'real Bun/outer job/launcher/descendant-pipe cleanup', rows: combined })
  result.status = 'PASS'
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  try { if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  catch (error) { cleanupError = error; result.cleanupError = String(error); result.status = 'FAIL' }
  result.fixtureRemoved = !existsSync(root)
  mkdirSync(dirname(resultFile), { recursive: true }); writeFileSync(resultFile, JSON.stringify(result, null, 2))
}
if (cleanupError) throw cleanupError
console.log('PASS native CLI launcher cleanup and actual embedded Bun deadlines')
