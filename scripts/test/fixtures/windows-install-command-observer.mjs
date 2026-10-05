// Fixture-only instrumentation. Every intercepted call still invokes the original
// subprocess API; receipts contain categories and OS command metadata, not errors.
const marker = 'BMN_INSTALL_DIAGNOSTIC:'
const prefix = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));\n"
const dependencies = String.raw`
$__bmnStage='dependencies';
function BMNDiagnosticPath($path) {
 if(!$path){return $null}
 foreach($entry in @(@('PSHOME',$PSHOME),@('SYSTEMROOT',$env:SystemRoot))) {
  $root=$entry[1].TrimEnd([IO.Path]::DirectorySeparatorChar);
  if($path.Equals($root,[StringComparison]::OrdinalIgnoreCase)){return $entry[0]}
  if($path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){return $entry[0]+'/'+$path.Substring($root.Length+1).Replace([char]92,[char]47)}
 }
 return 'OUTSIDE_TRUSTED_ROOTS'
}
foreach($name in @('Import-Module','Get-Command','Get-CimInstance','Select-Object','ConvertTo-Json')) {
 try {
  $command=Get-Command -Name $name -ErrorAction Stop;
  $base=if($command.Module){$command.Module.ModuleBase}else{$null};
  $assembly=if($command.ImplementingType){$command.ImplementingType.Assembly}else{$null};
  $identity=if($assembly){$assembly.GetName()}else{$null};
  [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:'+(ConvertTo-Json -Compress @{
   kind='dependency';name=$name;source=$command.Source;commandType=$command.CommandType.ToString();
   moduleBase=(BMNDiagnosticPath $base);moduleType=if($command.Module){$command.Module.ModuleType.ToString()}else{$null};
   moduleVersion=if($command.Module){$command.Module.Version.ToString()}else{$null};
   assemblyPath=if($assembly){BMNDiagnosticPath $assembly.Location}else{$null};
   assemblyName=if($identity){$identity.Name}else{$null};assemblyVersion=if($identity){$identity.Version.ToString()}else{$null};
   assemblyPublicKeyToken=if($identity){([BitConverter]::ToString($identity.GetPublicKeyToken())).Replace('-','').ToLowerInvariant()}else{$null}
  }));
 }catch {
  $actual=$_.Exception;for($i=0;$i -lt 8 -and $actual.InnerException;$i++){$actual=$actual.InnerException};
  [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:{"kind":"dependency-failure","name":"'+$name+'","hresult":'+$actual.HResult+'}');
 }
};$__bmnStage='operation';
`

export function observeWindowsInstallCommands(actualSpawn, record) {
  let sequence = 0
  return (executable, args, options) => {
    if (!/[\\/]powershell\.exe$/iu.test(executable) || !Array.isArray(args) || !args.includes('-EncodedCommand')) {
      return actualSpawn(executable, args, options)
    }
    const index = args.indexOf('-EncodedCommand') + 1, original = Buffer.from(args[index], 'base64').toString('utf16le')
    const operation = original.includes('BMN_PRIVATE_ROOTS_OK') ? 'private-directory'
      : original.includes("Name='BMN-worker.exe'") ? 'observe-mapped-engines'
      : original.includes("Name='BMN.exe'") ? 'observe-apps' : 'other-powershell'
    const began = performance.now(), id = ++sequence
    record({ id, operation, phase: 'begin' })
    // The original explicit Utility import and body remain unchanged. Only the
    // worker's known prefix gains command metadata in the same private context.
    const body = original.startsWith(prefix) ? original.replace(prefix, prefix + dependencies) : original
    const stage = original.startsWith(prefix) ? 'utility-import' : 'private-directory-operation'
    const script = `$__bmnStage='${stage}';try {\n` + body + String.raw`
} catch {
 $actual=$_.Exception;for($i=0;$i -lt 8 -and $actual.InnerException;$i++){$actual=$actual.InnerException};
 $type=$actual.GetType().Name;if($type -notmatch '^[A-Za-z0-9_]{1,64}$'){$type='UNKNOWN'};
 $code=if($actual -is [ComponentModel.Win32Exception]){$actual.NativeErrorCode}else{'null'};
 [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:{"kind":"failure","stage":"'+$__bmnStage+'","exceptionType":"'+$type+'","hresult":'+$actual.HResult+',"nativeErrorCode":'+$code+'}');exit 1;
}`
    const observedArgs = [...args]; observedArgs[index] = Buffer.from(script, 'utf16le').toString('base64')
    let result
    try { result = actualSpawn(executable, observedArgs, options); return result }
    finally {
      const metadata = []
      for (const line of String(result?.stderr ?? '').split(/\r?\n/u)) {
        if (!line.startsWith(marker) || line.length > 8192 || metadata.length >= 16) continue
        try { metadata.push(JSON.parse(line.slice(marker.length))) } catch { /* Non-protocol output is never persisted. */ }
      }
      record({ id, operation, phase: 'end', elapsedMs: Math.round(performance.now() - began), exitCode: result?.status ?? null,
        signal: result?.signal ?? null, launchError: result?.error?.code ?? null, stderrBytes: Buffer.byteLength(result?.stderr ?? ''), metadata })
    }
  }
}
