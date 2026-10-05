// Read-only, separate diagnostic. It never changes the installer's module state.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { windowsEnvironmentValue } from '../../../apps/desktop/bin/windows-env.mjs'
export const installedCimPreflightSource = String.raw`
$ErrorActionPreference='Stop';$stage='manifest';$manifests=[Collections.Generic.List[object]]::new();$commands=[Collections.Generic.List[object]]::new();
function DiagnosticPath($path){
 if(!$path){return $null};foreach($entry in @(@('PSHOME',$PSHOME),@('SYSTEMROOT',$env:SystemRoot))){
  $root=$entry[1].TrimEnd([char]92);if($path.Equals($root,[StringComparison]::OrdinalIgnoreCase)){return $entry[0]};
  if($path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){return $entry[0]+'/'+$path.Substring($root.Length+1).Replace([char]92,[char]47)}
 };return 'OUTSIDE_TRUSTED_ROOTS'
}
function Stage($name){$script:stage=$name;[Console]::Error.WriteLine('BMN_CIM_STAGE:'+ $name)}
try{
 foreach($name in @('Microsoft.PowerShell.Utility','CimCmdlets')){
  Stage ('manifest:'+ $name);$folder=[IO.Path]::Combine($PSHOME,'Modules',$name);$path=[IO.Path]::Combine($folder,$name+'.psd1');
  $file=[IO.FileInfo]::new($path);$available=$file.Exists;
  $row=@{name=$name;path=(DiagnosticPath $path);available=$available;sha256=$null};
  if($available){
   if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 1048576){throw 'Manifest is outside diagnostic bounds'};
   $hash=[Security.Cryptography.SHA256]::Create();$stream=$file.OpenRead();try{$row.sha256=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hash.Dispose()}
  };$manifests.Add($row);if(!$available){throw 'Required manifest is unavailable'};
  Stage ('import:'+ $name);Import-Module $path;
 };$PSModuleAutoLoadingPreference='None';Stage 'commands';
 $expected=@{'Import-Module'='Microsoft.PowerShell.Core';'Get-Command'='Microsoft.PowerShell.Core';'Get-CimInstance'='CimCmdlets';'Select-Object'='Microsoft.PowerShell.Utility';'ConvertTo-Json'='Microsoft.PowerShell.Utility'};
 $faults=0;
 foreach($name in @('Import-Module','Get-Command','Get-CimInstance','Select-Object','ConvertTo-Json')){
  Stage ('command:'+ $name);$matches=@(Get-Command -Name $name -ListImported -All -ErrorAction SilentlyContinue);
  if($matches.Count -ne 1){$faults++};
  if($matches.Count -eq 0){$commands.Add(@{name=$name;matches=0});continue};
  foreach($command in $matches){
   $assembly=if($command.ImplementingType){$command.ImplementingType.Assembly}else{$null};$identity=if($assembly){$assembly.GetName()}else{$null};
   $row=@{name=$name;matches=$matches.Count;source=$command.Source;commandType=$command.CommandType.ToString();
    moduleBase=if($command.Module){DiagnosticPath $command.Module.ModuleBase}else{$null};moduleType=if($command.Module){$command.Module.ModuleType.ToString()}else{$null};moduleVersion=if($command.Module){$command.Module.Version.ToString()}else{$null};
    assemblyPath=if($assembly){DiagnosticPath $assembly.Location}else{$null};assemblyName=if($identity){$identity.Name}else{$null};assemblyVersion=if($identity){$identity.Version.ToString()}else{$null};assemblyPublicKeyToken=if($identity){([BitConverter]::ToString($identity.GetPublicKeyToken())).Replace('-','').ToLowerInvariant()}else{$null}};
   $commands.Add($row);
   if($row.source -cne $expected[$name] -or $row.commandType -cne 'Cmdlet'){$faults++};
  }
 };
 # Metadata is retained in full before validating the named import/type contract.
 if($faults -ne 0){throw 'Missing or ambiguous imported command dependencies'};
 Stage 'query';$ids=@(Get-CimInstance Win32_Process -Filter "Name='BMN.exe'" | Select-Object -ExpandProperty ProcessId);
 Stage 'serialize';[Console]::Out.Write((ConvertTo-Json -Depth 8 -Compress @{scope='installed-cim-preflight-only';completed=$true;manifests=@($manifests);commands=@($commands);processIds=$ids}));
}catch{
 $actual=$_.Exception;for($i=0;$i -lt 8 -and $actual.InnerException;$i++){$actual=$actual.InnerException};$type=$actual.GetType().Name;if($type -notmatch '^[A-Za-z0-9_]{1,64}$'){$type='UNKNOWN'};
 $code=if($actual -is [ComponentModel.Win32Exception]){$actual.NativeErrorCode}else{'null'};
 if(Get-Command -Name ConvertTo-Json -ListImported -ErrorAction SilentlyContinue){
  [Console]::Out.Write((ConvertTo-Json -Depth 8 -Compress @{scope='installed-cim-preflight-only';completed=$false;failureStage=$stage;exceptionType=$type;hresult=$actual.HResult;nativeErrorCode=if($code -eq 'null'){$null}else{$code};manifests=@($manifests);commands=@($commands)}));
 }else{[Console]::Out.Write('{"scope":"installed-cim-preflight-only","completed":false,"failureStage":"'+$stage+'","exceptionType":"'+$type+'","hresult":'+$actual.HResult+',"nativeErrorCode":'+$code+'}');};exit 1
}`

export function measureInstalledCimPreflight(environment) {
  assert.equal(process.platform, 'win32'); assert.equal(environment.GITHUB_ACTIONS, 'true')
  const system = windowsEnvironmentValue(environment, 'SystemRoot'); assert.ok(system)
  const before = createHash('sha256').update(JSON.stringify(Object.entries(environment).sort())).digest('hex')
  const started = performance.now()
  const result = spawnSync(join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(installedCimPreflightSource, 'utf16le').toString('base64')],
    { env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true })
  const stages = String(result.stderr ?? '').split(/\r?\n/u).filter(line => /^BMN_CIM_STAGE:[A-Za-z0-9_.:-]{1,128}$/u.test(line)).slice(-20)
  let observed
  try { observed = JSON.parse(result.stdout); assert.equal(observed.scope, 'installed-cim-preflight-only') }
  catch { observed = { scope: 'installed-cim-preflight-only', completed: false, invalidOrMissingReceipt: true } }
  const after = createHash('sha256').update(JSON.stringify(Object.entries(environment).sort())).digest('hex')
  return { ...observed, environmentFingerprint: before, environmentUnchanged: before === after, stages, exitCode: result.status,
    signal: result.signal, launchError: result.error?.code ?? null, ownedProcessPid: result.pid, exitObserved: result.status !== null || result.signal !== null,
    elapsedMs: Math.round(performance.now() - started), stderrBytes: Buffer.byteLength(result.stderr ?? ''), productionInstallerAcceptance: 'UNVERIFIED' }
}
