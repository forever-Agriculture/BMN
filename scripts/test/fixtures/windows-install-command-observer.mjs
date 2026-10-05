// Fixture-only instrumentation. Every intercepted call still invokes the original
// subprocess API; receipts contain categories and OS command metadata, not errors.
import { readFileSync } from 'node:fs'
import { installedCimPreflightSource } from './windows-installed-cim-preflight.mjs'
import { powerShellSourceSha256, sha256, windowsEnvironmentFingerprint } from './windows-subprocess-provenance.mjs'
import { candidateQueryPrefix, exactInstalledQueries, originalQueryPrefix } from './windows-installed-query-source.mjs'
const marker = 'BMN_INSTALL_DIAGNOSTIC:'
const prefix = originalQueryPrefix
const observerSha256 = sha256(readFileSync(new URL(import.meta.url)))
const queryFenceSha256 = sha256(readFileSync(new URL('./windows-installed-query-source.mjs', import.meta.url)))
const preflightSha256 = powerShellSourceSha256(installedCimPreflightSource)
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
  [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:'+ (ConvertTo-Json -Compress @{kind='stage';stage='resolve-command';name=$name}));
  $matches=@(Get-Command -Name $name -ListImported -All -ErrorAction Stop);
  foreach($command in $matches){
  $base=if($command.Module){$command.Module.ModuleBase}else{$null};
  $assembly=if($command.ImplementingType){$command.ImplementingType.Assembly}else{$null};
  $identity=if($assembly){$assembly.GetName()}else{$null};
  [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:'+(ConvertTo-Json -Compress @{
   kind='dependency';name=$name;matches=$matches.Count;source=$command.Source;commandType=$command.CommandType.ToString();
   moduleBase=(BMNDiagnosticPath $base);moduleType=if($command.Module){$command.Module.ModuleType.ToString()}else{$null};
   moduleVersion=if($command.Module){$command.Module.Version.ToString()}else{$null};
   assemblyPath=if($assembly){BMNDiagnosticPath $assembly.Location}else{$null};
   assemblyName=if($identity){$identity.Name}else{$null};assemblyVersion=if($identity){$identity.Version.ToString()}else{$null};
   assemblyPublicKeyToken=if($identity){([BitConverter]::ToString($identity.GetPublicKeyToken())).Replace('-','').ToLowerInvariant()}else{$null}
  }));
  }
 }catch {
  $actual=$_.Exception;for($i=0;$i -lt 8 -and $actual.InnerException;$i++){$actual=$actual.InnerException};
  [Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:{"kind":"dependency-failure","name":"'+$name+'","hresult":'+$actual.HResult+'}');
 }
};$__bmnStage='operation';[Console]::Error.WriteLine('BMN_INSTALL_DIAGNOSTIC:'+ (ConvertTo-Json -Compress @{kind='stage';stage='operation'}));
`

export function observeWindowsInstallCommands(actualSpawn, record, binding = {}) {
  let sequence = 0
  const failures = []
  const fail = (id, phase, category) => {
    if (failures.length < 32) failures.push({ id, phase, category })
    else failures[31] = { id, phase, category: 'diagnostic-failure-overflow' }
  }
  const persist = (id, row) => { try { record(row) } catch { fail(id, row.phase, 'recording-failed') } }
  const observe = (executable, args, options) => {
    if (!/[\\/]powershell\.exe$/iu.test(executable) || !Array.isArray(args) || !args.includes('-EncodedCommand')) {
      return actualSpawn(executable, args, options)
    }
    const index = args.indexOf('-EncodedCommand') + 1, original = Buffer.from(args[index], 'base64').toString('utf16le')
    const sourceSha256 = powerShellSourceSha256(original)
    const query = exactInstalledQueries.get(sourceSha256)
    const directOriginal = original.startsWith(prefix) && query?.variant === 'original'
    const directCandidate = original.startsWith(candidateQueryPrefix) && query?.variant === 'candidate'
    const directQuery = directOriginal || directCandidate
    const explicitPreflight = sourceSha256 === preflightSha256
    const operation = explicitPreflight ? 'explicit-cim-preflight' : directQuery ? query.operation
      : original.includes('BMN_PRIVATE_ROOTS_OK') ? 'private-directory' : 'other-powershell'
    const began = performance.now(), id = ++sequence
    const environment = options?.env ?? process.env
    let environmentFingerprint
    try { environmentFingerprint = windowsEnvironmentFingerprint(environment) }
    catch { fail(id, 'begin', 'ambiguous-environment'); throw new Error('Windows subprocess environment cannot be identified') }
    let executableSha256 = null
    try { executableSha256 = sha256(readFileSync(executable)) }
    catch { if (process.platform === 'win32') fail(id, 'begin', 'executable-identity-unavailable') }
    const bindingComplete = /^[a-f0-9]{40}$/u.test(binding.candidateCommit ?? '') && /^[a-f0-9]{64}$/u.test(binding.artifactSha256 ?? '')
    const provenance = { candidateCommit: bindingComplete ? binding.candidateCommit : 'UNVERIFIED',
      artifactSha256: bindingComplete ? binding.artifactSha256 : 'UNVERIFIED', bindingComplete,
      observerSha256, queryFenceSha256, sourceSha256, encodedArgumentSha256: sha256(Buffer.from(args[index], 'ascii')), executableSha256,
      executablePathFingerprint: sha256(Buffer.from(executable.toLowerCase(), 'utf16le')), orderedFlags: args.slice(0, index - 1),
      cwdFingerprint: sha256(Buffer.from(String(options?.cwd ?? process.cwd()), 'utf16le')),
      inputBytes: options?.input === undefined ? 0 : Buffer.byteLength(options.input),
      inputSha256: options?.input === undefined ? null : sha256(Buffer.from(options.input)),
      shell: options?.shell ?? 'NODE_DEFAULT', stdio: options?.stdio ?? 'NODE_DEFAULT',
      environmentFingerprint, environmentEncoding: 'UTF8-JSON-sorted-lowercase-name-string-value-pairs',
      encoding: options?.encoding ?? 'NODE_DEFAULT', timeout: options?.timeout ?? 'NODE_DEFAULT',
      maxBuffer: options?.maxBuffer ?? 'NODE_DEFAULT', windowsHide: options?.windowsHide ?? 'NODE_DEFAULT',
      directOriginal, directCandidate, explicitPreflight }
    persist(id, { id, operation, phase: 'begin', ...provenance })
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
    const observedArgs = directQuery || explicitPreflight ? args : [...args]
    if (!directQuery && !explicitPreflight) observedArgs[index] = Buffer.from(script, 'utf16le').toString('base64')
    let result, threw = false
    try { result = actualSpawn(executable, observedArgs, options); return result }
    catch (error) { threw = true; throw error }
    finally {
      const metadata = []
      for (const line of String(result?.stderr ?? '').split(/\r?\n/u)) {
        if (!line.startsWith(marker)) continue
        if (line.length > 8192 || metadata.length >= 16) { fail(id, 'end', 'metadata-clipped'); continue }
        try {
          const row = JSON.parse(line.slice(marker.length))
          if (!['stage', 'dependency', 'dependency-failure', 'failure'].includes(row.kind)) { fail(id, 'end', 'metadata-invalid-kind'); continue }
          // Fixed OS metadata only: paths must be trusted normalized categories.
          const allowed = new Set(['kind', 'stage', 'name', 'matches', 'source', 'commandType', 'moduleBase', 'moduleType',
            'moduleVersion', 'assemblyPath', 'assemblyName', 'assemblyVersion', 'assemblyPublicKeyToken', 'exceptionType', 'hresult', 'nativeErrorCode'])
          if (Object.keys(row).some(key => !allowed.has(key)) || Object.values(row).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
            fail(id, 'end', 'metadata-invalid-schema'); continue
          }
          for (const key of ['moduleBase', 'assemblyPath']) {
            if (typeof row[key] === 'string' && !/^(?:PSHOME|SYSTEMROOT)(?:\/[A-Za-z0-9_./-]+)?$|^OUTSIDE_TRUSTED_ROOTS$/u.test(row[key])) {
              row[key] = 'OUTSIDE_TRUSTED_ROOTS'; fail(id, 'end', 'metadata-untrusted-path')
            }
          }
          if (Object.entries(row).some(([key, value]) => typeof value === 'string' && !['moduleBase', 'assemblyPath'].includes(key) && !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value))) {
            fail(id, 'end', 'metadata-invalid-value'); continue
          }
          metadata.push(row)
        } catch { fail(id, 'end', 'metadata-malformed') }
      }
      let environmentUnchanged = false
      try { environmentUnchanged = windowsEnvironmentFingerprint(environment) === environmentFingerprint }
      catch { fail(id, 'end', 'ambiguous-environment') }
      if (!environmentUnchanged) fail(id, 'end', 'environment-changed')
      persist(id, { id, operation, phase: 'end', ...provenance, environmentUnchanged,
        elapsedMs: Math.round(performance.now() - began), exitCode: result?.status ?? null,
        ownedProcessPid: result?.pid ?? null, exitObserved: result?.status !== null && result?.status !== undefined || Boolean(result?.signal),
        spawnThrew: threw, signal: result?.signal ?? null, launchError: result?.error?.code ?? null,
        stdoutBytes: Buffer.byteLength(result?.stdout ?? ''), stderrBytes: Buffer.byteLength(result?.stderr ?? ''), metadata })
    }
  }
  Object.defineProperty(observe, 'diagnosticFailures', { get: () => failures.map(row => ({ ...row })) })
  return observe
}
