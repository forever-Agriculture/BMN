// MODULE: windows-config-writer.mjs - synthetic native ACL, sharing and replacement race acceptance
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { writeAtomically, writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

assert.equal(process.platform, 'win32', 'Native Windows required')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable runner only')
const root = mkdtempSync(join(tmpdir(), 'bmn-config-native-'))
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const receipts = { defaultOwner: null, checks: [] }
const children = new Set()
// Read-only diagnostics for this disposable fixture. Do not change ownership,
// enable privileges, or infer a cleanup repair from an undifferentiated error 5.
const cleanupDiagnosticSource = `
$ErrorActionPreference='Stop'
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CleanupAccess {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFileAttributesW(string p);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(IntPtr h,out Info i);
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint attrs,cl,ch,al,ah,wl,wh,volume,sizeh,sizel,links,indexh,indexl;}
}
'@
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$attrs=[CleanupAccess]::GetFileAttributesW($r.path);$attrError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$probes=@();$identity=$null
foreach($entry in @(@('READ_ATTRIBUTES',128),@('WRITE_DAC',262144),@('WRITE_OWNER',524288),@('WRITE_ATTRIBUTES',256),@('DELETE',65536))) {
 $h=[CleanupAccess]::CreateFileW($r.path,[uint32]$entry[1],7,[IntPtr]::Zero,3,33554432,[IntPtr]::Zero)
 $error=[Runtime.InteropServices.Marshal]::GetLastWin32Error();$ok=$h -ne [IntPtr](-1)
 try {
  $probes+=@{access=$entry[0];mask=$entry[1];opened=$ok;error=if($ok){0}else{$error}}
  if($ok -and $entry[0] -eq 'READ_ATTRIBUTES') {
   $info=New-Object CleanupAccess+Info
   if([CleanupAccess]::GetFileInformationByHandle($h,[ref]$info)) {$identity=@{volume=$info.volume;indexHigh=$info.indexh;indexLow=$info.indexl}}
  }
 } finally {if($ok){[void][CleanupAccess]::CloseHandle($h)}}
}
$security=$null
try {
 $a=if($r.directory){[IO.Directory]::GetAccessControl($r.path)}else{[IO.File]::GetAccessControl($r.path)}
 $security=@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;sddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)}
} catch {$security=@{readable=$false;hresult=$_.Exception.HResult}}
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 6 @{sid=$sid;attributes=$attrs;attributeError=if($attrs -eq [uint32]::MaxValue){$attrError}else{0};readonly=($attrs -band 1) -ne 0;identity=$identity;security=$security;probes=$probes}))
`
const aclSource = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$phase='setup';try {
if($r.replaceWith) {$phase='replace-racing-target';[IO.File]::Replace($r.replaceWith,$r.path,$r.displaced,$false)}
if($r.ownerOnly) {$a=[IO.File]::GetAccessControl($r.path);$a.SetOwner($sid);[IO.File]::SetAccessControl($r.path,$a)}
if($r.protect) {
 $acl=if($r.directory) {New-Object Security.AccessControl.DirectorySecurity} else {New-Object Security.AccessControl.FileSecurity}
 $owner=if($r.foreign) { New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544') } else {$sid}
 $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
 if($r.denyDelete) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Delete','Deny')))}
 if($r.denyChildDelete) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'DeleteSubdirectoriesAndFiles','Deny')))}
 if($r.unsafeParent) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),'DeleteSubdirectoriesAndFiles','Allow')))}
 $phase='set-access-control'
 if($r.directory) {[IO.Directory]::SetAccessControl($r.path,$acl)} else {[IO.File]::SetAccessControl($r.path,$acl)}
}
$phase='readback'
$acl=if($r.directory) {[IO.Directory]::GetAccessControl($r.path)} else {[IO.File]::GetAccessControl($r.path)}
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
 @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType;inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags}
})
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 5 @{user=$sid.Value;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=$rules}))
} catch {$e=$_.Exception;for($i=0;$i -lt 8 -and $e.InnerException;$i++){$e=$e.InnerException};[Console]::Out.Write((ConvertTo-Json -Compress @{ok=$false;operation=$phase;exceptionType=$e.GetType().FullName;hresult=$e.HResult}));exit 1}
`
function acl(path, options = {}) {
  const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclSource, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path, ...options }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  let result
  try { result = JSON.parse(child.stdout) } catch { /* Preserve only stable synthetic metadata below. */ }
  if (child.status !== 0) {
    receipts.fixtureFailure = { fixturePhase: options.phase ?? 'read', relativePath: relative(root, path) || '.', directory: options.directory === true, ...result }
    if (options.phase === 'fixture-cleanup') {
      const diagnostic = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanupDiagnosticSource, 'utf16le').toString('base64')],
        { input: JSON.stringify({ path, directory: options.directory === true }), encoding: 'utf8', timeout: 15000, windowsHide: true })
      let metadata
      try { metadata = JSON.parse(diagnostic.stdout) } catch { /* No raw paths/errors in receipts. */ }
      receipts.fixtureFailure.accessDiagnostic = { exitCode: diagnostic.status, launchError: diagnostic.error?.code ?? null, metadata: metadata ?? null }
    }
  }
  assert.equal(child.status, 0, `Synthetic ACL fixture failed (${options.phase ?? 'read'})`)
  return result
}
function file(name, text) {
  const path = join(root, name); writeFileSync(path, text)
  receipts.defaultOwner ??= acl(path)
  acl(path, { protect: true }); return path
}
function temps() { return readdirSync(root).filter(name => name.endsWith('.tmp')) }
async function check(name, callback) {
  await callback(); receipts.checks.push({ name, status: 'PASS' })
}
async function waitFor(path) {
  const deadline = Date.now() + 12000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, 'Synthetic handshake timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const workerSource = `const {workerData:d,parentPort} = require('node:worker_threads');
(async()=>{try {const {writeConfigSafely}=await import(d.moduleUrl); parentPort.postMessage({ok:true,result:writeConfigSafely(d.path,d.expected,d.next)})}
catch(e){parentPort.postMessage({ok:false,code:e.code,recoveryRequired:e.recoveryRequired===true})}})();`
function workerWrite(path, expected, next, gate) {
  const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl: new URL('../../apps/desktop/bin/safe-config-write.mjs', import.meta.url).href, path, expected, next },
    env: { ...process.env, NODE_ENV: 'test', BMN_CONFIG_WRITE_TEST_GATE: gate } })
  const exited = once(worker, 'exit')
  let received = false
  const result = new Promise((resolve, reject) => {
    worker.once('message', message => { received = true; resolve(message) })
    worker.once('error', reject)
    worker.once('exit', code => { if (!received || code !== 0) reject(new Error('Synthetic config worker failed')) })
  })
  return { worker, result, exited }
}
try {
  // Diagnostic only: independently vary retained stage and reservation handles.
  // Do not mutate the product or interpret matrix completion as acceptance.
  const productSource = readFileSync(new URL('../../apps/desktop/bin/safe-config-write.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const helperStart = productSource.indexOf('function EnsureNativeHelpers {')
  const helperEnd = productSource.indexOf("\ntry {\n if($request.mode", helperStart)
  assert.ok(helperStart > 0 && helperEnd > helperStart)
  const helper = productSource.slice(helperStart, helperEnd)
  const matrix = `$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$r=ConvertFrom-Json ([Console]::In.ReadToEnd());
${helper}
EnsureNativeHelpers
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$results=@()
foreach($stageHeld in @($false,$true)) {foreach($backupMode in @('absent','retained','disposed')) {
 $backupHeld=$backupMode -ne 'absent'
 $directory=[IO.Path]::Combine($r.root,('matrix-'+$stageHeld+'-'+$backupMode));[IO.Directory]::CreateDirectory($directory)|Out-Null
 $target=[IO.Path]::Combine($directory,'target.json');$stage=[IO.Path]::Combine($directory,'stage.tmp');$backup=[IO.Path]::Combine($directory,'backup.json')
 [IO.File]::WriteAllText($target,'BEFORE');$original=[IO.File]::GetAccessControl($target);$original.SetOwner($sid);[IO.File]::SetAccessControl($target,$original)
 $private=New-Object Security.AccessControl.FileSecurity;$private.SetOwner($sid);$private.SetAccessRuleProtection($true,$false);$private.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
 foreach($path in @($stage,$backup)) {$f=New-Object IO.FileStream($path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'Write,ReadPermissions,ReadAttributes',[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$private);try {if($path -eq $stage){$bytes=[Text.Encoding]::UTF8.GetBytes('AFTER');$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}}finally{$f.Dispose()}}
 $held=$null;$staged=$null;$reserved=$null;$operation='original-open';$errorCode=$null;$exceptionType=$null;$published=$false
 try {
  $held=New-Object IO.FileStream($target,[IO.FileMode]::Open,[Security.AccessControl.FileSystemRights]'Read,ReadPermissions',([IO.FileShare]::Read -bor [IO.FileShare]::Delete),4096,[IO.FileOptions]::None)
  if($stageHeld){$operation='stage-metadata';$staged=[BMNConfigIdentity]::Metadata($stage)}
  if($backupHeld){$operation='backup-metadata';$reserved=[BMNConfigIdentity]::Metadata($backup)}
  if($backupMode -eq 'disposed'){$operation='backup-check-dispose';$reservationId=[BMNConfigIdentity]::Read($reserved);if(-not $reservationId){throw 'Unconfirmed identity'};$reserved.Dispose();$reserved=$null}
  $operation='replace';[IO.File]::Replace($stage,$target,$backup,$false);$published=$true
 } catch {$e=$_.Exception;for($i=0;$i -lt 8 -and $e.InnerException;$i++){$e=$e.InnerException};$errorCode=if($e -is [ComponentModel.Win32Exception]){$e.NativeErrorCode}else{$e.HResult -band 65535};$exceptionType=$e.GetType().FullName}
 finally {foreach($handle in @($reserved,$staged,$held)){if($null -ne $handle){$handle.Dispose()}}}
 $results+=@{stageHeld=$stageHeld;backupHeld=$backupHeld;backupMode=$backupMode;operation=$operation;errno=$errorCode;exceptionType=$exceptionType;published=$published;target=if([IO.File]::Exists($target)){[IO.File]::ReadAllText($target)}else{$null};backup=if([IO.File]::Exists($backup)){[IO.File]::ReadAllText($backup)}else{$null};stageExists=[IO.File]::Exists($stage)}
}}
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 5 @($results)));`
  const encoded = Buffer.from(matrix, 'utf16le').toString('base64')
  assert.ok(encoded.length < 32000, 'Diagnostic fixed program must fit native command limits')
  const varied = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { input: JSON.stringify({ root }), encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(varied.status, 0, 'Native six-case metadata-handle matrix must execute')
  receipts.retainedHandleMatrix = JSON.parse(varied.stdout)
  assert.equal(receipts.retainedHandleMatrix.length, 6)
  for (const result of receipts.retainedHandleMatrix.filter(row => row.backupMode === 'disposed')) {
    assert.equal(result.published, true); assert.equal(result.target, 'AFTER'); assert.equal(result.backup, 'BEFORE')
  }
  // Raw native measurement keeps inherited-ACL diagnosis separate from product gates.
  const inherited = join(root, 'inherited.json'), staged = join(root, 'inherited.stage'), backup = join(root, 'inherited.backup')
  writeFileSync(inherited, 'BEFORE')
  const measure = `$ErrorActionPreference='Stop';$r=ConvertFrom-Json ([Console]::In.ReadToEnd());$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
function Describe($path) {$a=[IO.File]::GetAccessControl($path);return @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;sddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')}}
$a=[IO.File]::GetAccessControl($r.path);$a.SetOwner($sid);[IO.File]::SetAccessControl($r.path,$a);$before=Describe $r.path;
$private=New-Object Security.AccessControl.FileSecurity;$private.SetOwner($sid);$private.SetAccessRuleProtection($true,$false);$private.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));
$f=New-Object IO.FileStream($r.stage,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]'Write,ReadPermissions',[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$private);$bytes=[Text.Encoding]::UTF8.GetBytes('AFTER');$f.Write($bytes,0,$bytes.Length);$f.Flush($true);$f.Dispose();
$held=New-Object IO.FileStream($r.path,[IO.FileMode]::Open,[Security.AccessControl.FileSystemRights]'Read,ReadPermissions',([IO.FileShare]::Read -bor [IO.FileShare]::Delete),4096,[IO.FileOptions]::None);
try {[IO.File]::Replace($r.stage,$r.path,$r.backup,$false)}finally{$held.Dispose()};
[Console]::Out.Write((ConvertTo-Json -Depth 5 -Compress @{before=$before;after=(Describe $r.path);backup=(Describe $r.backup)}));`
  const measured = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(measure, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path: inherited, stage: staged, backup }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(measured.status, 0, 'Raw inherited-ACL measurement must execute')
  receipts.inheritedReplacement = JSON.parse(measured.stdout)
  const baselineCommit = 'ea4e3a778e262b8ef8b56a8f9ad821b496c01035'
  const response = await fetch(`https://raw.githubusercontent.com/forever-Agriculture/BMN/${baselineCommit}/apps/desktop/bin/safe-config-write.mjs`, { signal: AbortSignal.timeout(30000) })
  assert.equal(response.ok, true, 'Pinned public task baseline must be readable')
  const baselineSource = await response.text()
  assert.ok(Buffer.byteLength(baselineSource) < 64 * 1024)
  assert.equal(createHash('sha256').update(baselineSource).digest('hex'), '70c6db7b563652924718af80f4b87b9992d48ed8a354af52f45523ff54168047')
  const marker = 'error.created = result?.created === true'
  assert.equal(baselineSource.split(marker).length, 2)
  const baselineModule = join(root, 'baseline-writer.mjs')
  // Observer-only metadata addition; native source and failure behavior stay original.
  writeFileSync(baselineModule, baselineSource.replace(marker, marker + '; error.nativePhase = result?.code; error.published = result?.published'))
  const { writeConfigSafely: baselineWrite } = await import(pathToFileURL(baselineModule).href)
  await check('RED original product rejects inherited ACL after publication', () => {
    const path = join(root, 'baseline-inherited.json'); writeFileSync(path, 'BEFORE')
    const before = acl(path, { ownerOnly: true })
    let failure
    try { baselineWrite(path, 'BEFORE', 'AFTER') } catch (error) { failure = error }
    assert.equal(failure?.code, 'RECOVERY_REQUIRED')
    assert.equal(failure?.nativePhase, 'ACCESS_CONTROL_UNCONFIRMED'); assert.equal(failure?.published, true)
    assert.equal(readFileSync(path, 'utf8'), 'AFTER')
    const names = readdirSync(root).filter(name => name.startsWith('baseline-inherited.json.bmn-backup-'))
    assert.equal(names.length, 1); assert.equal(readFileSync(join(root, names[0]), 'utf8'), 'BEFORE')
    receipts.inheritedProductRed = { baselineCommit, nativePhase: failure.nativePhase, published: true, before, after: acl(path), backup: acl(join(root, names[0])) }
  })
  await check('RED oversized fixed program fails native launch before changing the target', async () => {
    const commit = 'be4ed316c6bd46fe89b216ccb1cb2d62e31d9044'
    const response = await fetch(`https://raw.githubusercontent.com/forever-Agriculture/BMN/${commit}/apps/desktop/bin/safe-config-write.mjs`, { signal: AbortSignal.timeout(30000) })
    assert.equal(response.ok, true)
    const source = await response.text(); assert.ok(Buffer.byteLength(source) < 64 * 1024)
    assert.equal(createHash('sha256').update(source).digest('hex'), '51c8b8217cf47b5fa473e99927a4c044281e585977c65c160be9e1998d397e4d')
    const observer = '    error.nativeExceptionType = result?.exceptionType'
    assert.equal(source.split(observer).length, 2)
    const modulePath = join(root, 'oversized-baseline.mjs')
    writeFileSync(modulePath, source.replace(observer, observer + '\n    error.nativeLaunchError = child.error?.code'))
    const { writeConfigSafely: oversizedWrite } = await import(pathToFileURL(modulePath).href)
    const path = file('oversized.json', 'BEFORE'), before = acl(path), names = readdirSync(root).sort()
    let failure
    try { oversizedWrite(path, 'BEFORE', 'OURS') } catch (error) { failure = error }
    assert.equal(failure?.code, 'IO_ERROR'); assert.equal(typeof failure?.nativeLaunchError, 'string')
    assert.equal(failure?.nativeOperation, undefined)
    assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(acl(path), before)
    assert.deepEqual(readdirSync(root).sort(), names)
    receipts.commandLimitRed = { commit, launchError: failure.nativeLaunchError, unchanged: true }
  })
  await check('RED original worker loses mixed-case SystemRoot with uppercase environment', async () => {
    const path = file('worker-environment-red.json', 'BEFORE')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'systemroot'))
    env.SYSTEMROOT = process.env.SystemRoot
    const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');
(async()=>{const info={keys:Object.keys(process.env).filter(name=>name.toLowerCase()==='systemroot'),exactPresent:typeof process.env.SystemRoot==='string'};
try{const {writeConfigSafely}=await import(d.moduleUrl);writeConfigSafely(d.path,'BEFORE','OURS');parentPort.postMessage({...info,ok:true})}
catch(e){parentPort.postMessage({...info,ok:false,code:e.code,reason:e.message==='Windows SystemRoot is unavailable'?'MISSING_SYSTEMROOT':'OTHER'})}})();`,
      { eval: true, env, workerData: { moduleUrl: pathToFileURL(baselineModule).href, path } })
    const exited = once(worker, 'exit'), message = once(worker, 'message')
    const [result] = await message; receipts.uppercaseWorkerRed = result; assert.equal((await exited)[0], 0)
    assert.deepEqual(result, { keys: ['SYSTEMROOT'], exactPresent: false, ok: false, code: 'IO_ERROR', reason: 'MISSING_SYSTEMROOT' })
    assert.equal(readFileSync(path, 'utf8'), 'BEFORE')
  })
  await check('GREEN current writer accepts uppercase SystemRoot in a native worker', async () => {
    const path = file('worker-environment-green.json', 'BEFORE')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'systemroot'))
    env.SYSTEMROOT = process.env.SystemRoot
    const worker = new Worker(workerSource, { eval: true, env, workerData: {
      moduleUrl: new URL('../../apps/desktop/bin/safe-config-write.mjs', import.meta.url).href, path, expected: 'BEFORE', next: 'OURS' } })
    const exited = once(worker, 'exit'), message = once(worker, 'message')
    const [result] = await message; assert.equal((await exited)[0], 0)
    assert.equal(result.ok, true); assert.equal(readFileSync(path, 'utf8'), 'OURS')
    assert.equal(readFileSync(result.result.backup, 'utf8'), 'BEFORE')
    receipts.uppercaseWorkerGreen = { published: true, backupPreserved: true }
  })
  await check('GREEN inherited original and backup keep exact owner/ACE flags/protection', () => {
    const path = join(root, 'green-inherited.json'); writeFileSync(path, 'BEFORE')
    const before = acl(path, { ownerOnly: true })
    const result = writeConfigSafely(path, 'BEFORE', 'AFTER')
    assert.equal(readFileSync(path, 'utf8'), 'AFTER'); assert.equal(readFileSync(result.backup, 'utf8'), 'BEFORE')
    assert.deepEqual(acl(path), before); assert.deepEqual(acl(result.backup), before)
    receipts.inheritedProductGreen = { before, after: acl(path), backup: acl(result.backup) }
  })
  await check('refuses a parent with ordinary-account namespace mutation without changing permissions', () => {
    const directory = join(root, 'unsafe-parent'); mkdirSync(directory)
    const path = join(directory, 'settings.json'); writeFileSync(path, 'BEFORE')
    acl(path, { protect: true }); acl(directory, { directory: true, protect: true, unsafeParent: true })
    try {
      // The immutable baseline accepted this unsafe namespace; candidate must refuse.
      const baseline = baselineWrite(path, 'BEFORE', 'AFTER')
      assert.equal(readFileSync(path, 'utf8'), 'AFTER'); assert.equal(readFileSync(baseline.backup, 'utf8'), 'BEFORE')
      writeFileSync(path, 'BEFORE')
      const before = acl(path), parent = acl(directory, { directory: true }), names = readdirSync(directory).sort()
      let failure
      try { writeConfigSafely(path, 'BEFORE', 'OURS') } catch (error) { failure = error }
      assert.equal(failure?.nativeOperation, 'prepare:ancestors')
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(acl(path), before)
      assert.deepEqual(acl(directory, { directory: true }), parent); assert.deepEqual(readdirSync(directory).sort(), names)
    } finally { acl(directory, { directory: true, protect: true }) }
  })
  await check('protected original and backup preserve owner/DACL with Unicode', () => {
    const path = file('existing.json', 'BEFORE 雪'), before = acl(path)
    const result = writeConfigSafely(path, 'BEFORE 雪', 'AFTER 雪')
    assert.equal(readFileSync(path, 'utf8'), 'AFTER 雪')
    assert.equal(readFileSync(result.backup, 'utf8'), 'BEFORE 雪')
    assert.deepEqual(acl(path), before); assert.deepEqual(acl(result.backup), before)
    assert.deepEqual(temps(), [])
  })
  await check('staged file current-owner private before publication', () => {
    const path = file('stage.json', 'BEFORE')
    writeConfigSafely(path, 'BEFORE', 'AFTER', { beforeCommit: () => {
      const names = temps(); assert.equal(names.length, 1)
      const security = acl(join(root, names[0]))
      assert.equal(security.owner, security.user); assert.equal(security.protected, true)
      assert.deepEqual(security.rules, [{ sid: security.user, rights: 2032127, type: 0, inherited: false, inheritance: 0, propagation: 0 }])
    } })
  })
  await check('new file is private and has no backup', () => {
    const path = join(root, 'new.json'), result = writeConfigSafely(path, null, 'NEW')
    assert.equal(result.backup, null)
    const security = acl(path)
    assert.equal(security.owner, security.user); assert.equal(security.protected, true)
    assert.deepEqual(security.rules, [{ sid: security.user, rights: 2032127, type: 0, inherited: false, inheritance: 0, propagation: 0 }])
  })
  await check('foreign-owned original refused before staging', () => {
    const path = file('foreign.json', 'FOREIGN'); acl(path, { protect: true, foreign: true })
    const before = acl(path); assert.notEqual(before.owner, before.user)
    assert.throws(() => writeConfigSafely(path, 'FOREIGN', 'OURS'))
    assert.equal(readFileSync(path, 'utf8'), 'FOREIGN'); assert.deepEqual(acl(path), before); assert.deepEqual(temps(), [])
    acl(path, { protect: true })
  })
  await check('denied replacement preserves data/ACL and cleans owned stage', () => {
    const directory = join(root, 'denied'); mkdirSync(directory)
    const path = join(directory, 'settings.json'); writeFileSync(path, 'BEFORE')
    receipts.denialDiagnostic = [{ phase: 'initial-parent', security: acl(directory, { directory: true }) }, { phase: 'initial-child', security: acl(path) }]
    // Explicitly protect the child before removing parent inheritance.
    acl(path, { protect: true, denyDelete: true, phase: 'protect-child' })
    receipts.denialDiagnostic.push({ phase: 'protected-child', security: acl(path) })
    acl(directory, { directory: true, protect: true, denyChildDelete: true, phase: 'protect-parent' })
    receipts.denialDiagnostic.push({ phase: 'protected-parent', security: acl(directory, { directory: true }) }, { phase: 'child-after-parent', security: acl(path) })
    const before = acl(path)
    let prepared = false
    try {
      let failure
      try { writeConfigSafely(path, 'BEFORE', 'OURS', { beforeCommit: () => { prepared = true } }) } catch (error) { failure = error }
      assert.equal(prepared, true, 'Preparation must succeed before the denied publication')
      assert.equal(failure?.nativeOperation, 'commit:replace')
      assert.equal(failure?.nativeErrorCode, 5, 'Replace must report access denied')
      receipts.denialFailure = { operation: failure.nativeOperation, errno: failure.nativeErrorCode, exceptionType: failure.nativeExceptionType }
      assert.equal(before.rules.some(rule => rule.sid === before.user && rule.type === 1 && (rule.rights & 65536) !== 0), true)
      const parent = acl(directory, { directory: true })
      assert.equal(parent.rules.some(rule => rule.sid === parent.user && rule.type === 1 && (rule.rights & 64) !== 0), true)
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(acl(path), before)
      assert.deepEqual(readdirSync(directory), ['settings.json'])
    } finally { acl(path, { protect: true }); acl(directory, { directory: true, protect: true }) }
  })
  await check('existing write handle refuses publication without truncation', async () => {
    const path = file('sharing.json', 'BEFORE')
    const script = `$ErrorActionPreference='Stop';$r=ConvertFrom-Json ([Console]::In.ReadLine());$f=[IO.File]::Open($r.path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);[Console]::Out.WriteLine('READY');[Console]::Out.Flush();try {[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}`
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.add(child); const exited = once(child, 'exit')
    child.stdin.write(`${JSON.stringify({ path })}\n`)
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Sharing fixture startup timed out')), 10000)
        child.stdout.once('data', data => { clearTimeout(deadline); if (data.toString().includes('READY')) resolve(); else reject(new Error('Sharing fixture failed')) })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
      })
      assert.throws(() => writeConfigSafely(path, 'BEFORE', 'OURS'))
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.deepEqual(temps(), [])
    } finally { child.stdin.end('RELEASE\n'); await exited; children.delete(child) }
  })
  await check('failed preparation cleans its exclusively created stage', () => {
    const path = join(root, 'prepare-failure.json')
    assert.throws(() => writeAtomically(path, undefined))
    assert.equal(existsSync(path), false); assert.deepEqual(temps(), [])
  })
  await check('denied owned-stage cleanup retains private recovery data', () => {
    const directory = join(root, 'cleanup-denied'); mkdirSync(directory)
    const path = join(directory, 'settings.json'); writeFileSync(path, 'BEFORE'); acl(path, { protect: true })
    let stage, failure
    try {
      try { writeConfigSafely(path, 'BEFORE', 'OURS', { beforeCommit: () => {
        stage = join(directory, readdirSync(directory).find(name => name.endsWith('.tmp')))
        acl(stage, { protect: true, denyDelete: true })
        acl(directory, { directory: true, protect: true, denyChildDelete: true })
        throw new Error('Synthetic refusal')
      } }) } catch (error) { failure = error }
      assert.equal(failure?.code, 'RECOVERY_REQUIRED')
      assert.equal(failure?.nativeOperation, 'cleanup:owned-stage-cleanup')
      assert.equal(failure?.nativeErrorCode, 5)
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.equal(readFileSync(stage, 'utf8'), 'OURS')
    } finally {
      if (stage) acl(stage, { protect: true })
      acl(directory, { directory: true, protect: true })
    }
  })
  await check('postpublication repair failure retains recovery bytes and backup', () => {
    const path = file('repair-failure.json', 'BEFORE')
    const oldMode = process.env.NODE_ENV, oldFailure = process.env.BMN_CONFIG_WRITE_TEST_REPAIR_FAILURE
    process.env.NODE_ENV = 'test'; process.env.BMN_CONFIG_WRITE_TEST_REPAIR_FAILURE = '1'
    try {
      let failure
      try { writeConfigSafely(path, 'BEFORE', 'OURS') } catch (error) { failure = error }
      assert.equal(failure?.code, 'RECOVERY_REQUIRED'); assert.equal(failure?.recoveryRequired, true)
      assert.equal(readFileSync(path, 'utf8'), 'OURS')
      const names = readdirSync(root).filter(name => name.startsWith('repair-failure.json.bmn-backup-'))
      assert.equal(names.length, 1); assert.equal(readFileSync(join(root, names[0]), 'utf8'), 'BEFORE')
    } finally {
      if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode
      if (oldFailure === undefined) delete process.env.BMN_CONFIG_WRITE_TEST_REPAIR_FAILURE; else process.env.BMN_CONFIG_WRITE_TEST_REPAIR_FAILURE = oldFailure
    }
  })
  await check('retained original handle rejects a racing in-place writer', async () => {
    const path = file('inplace.json', 'BEFORE'), gate = join(root, 'inplace.release')
    const pending = workerWrite(path, 'BEFORE', 'OURS', gate)
    try {
      await waitFor(`${gate}.waiting`)
      assert.throws(() => writeFileSync(path, 'THEIRS'))
      writeFileSync(gate, '')
      assert.equal((await pending.result).ok, true)
      assert.equal(readFileSync(path, 'utf8'), 'OURS')
    } finally { writeFileSync(gate, ''); await pending.exited }
  })
  await check('backup reservation substitution preserves the unrelated replacement', async () => {
    const path = file('backup-substitution.json', 'BEFORE'), gate = join(root, 'backup-substitution.release')
    const pending = workerWrite(path, 'BEFORE', 'OURS', gate)
    try {
      await waitFor(`${gate}.waiting`)
      const names = readdirSync(root).filter(name => name.startsWith('backup-substitution.json.bmn-backup-'))
      assert.equal(names.length, 1)
      const replacement = join(root, names[0]); rmSync(replacement); writeFileSync(replacement, 'UNRELATED')
      const replacementSecurity = acl(replacement, { phase: 'replacement-before-worker' })
      writeFileSync(gate, '')
      assert.deepEqual(await pending.result, { ok: false, code: 'REVISION_CONFLICT', recoveryRequired: false })
      assert.equal(readFileSync(path, 'utf8'), 'BEFORE'); assert.equal(readFileSync(replacement, 'utf8'), 'UNRELATED')
      receipts.unrelatedBackupSecurity = acl(replacement, { phase: 'replacement-after-worker' })
      assert.deepEqual(receipts.unrelatedBackupSecurity, replacementSecurity)
      assert.deepEqual(temps(), [])
    } finally { writeFileSync(gate, ''); await pending.exited }
  })
  await check('namespace race retains displaced edit and reports recovery without rollback', async () => {
    const path = file('rename.json', 'BEFORE'), substitute = file('substitute.json', 'THEIRS'), gate = join(root, 'rename.release')
    const pending = workerWrite(path, 'BEFORE', 'OURS', gate)
    try {
      await waitFor(`${gate}.waiting`)
      // MoveFileEx/Node rename cannot overwrite this held original on Windows.
      // A second File.Replace is the native namespace writer the contract must detect.
      const displaced = join(root, 'racing-original.json')
      acl(path, { replaceWith: substitute, displaced, phase: 'namespace-race' })
      assert.equal(readFileSync(displaced, 'utf8'), 'BEFORE')
      assert.equal(readFileSync(path, 'utf8'), 'THEIRS'); writeFileSync(gate, '')
      assert.deepEqual(await pending.result, { ok: false, code: 'RECOVERY_REQUIRED', recoveryRequired: true })
      assert.equal(readFileSync(path, 'utf8'), 'OURS')
      const backups = readdirSync(root).filter(name => name.startsWith('rename.json.bmn-backup-'))
      assert.equal(backups.length, 1); assert.equal(readFileSync(join(root, backups[0]), 'utf8'), 'THEIRS')
    } finally { writeFileSync(gate, ''); await pending.exited }
  })
  receipts.status = 'PASS'
} catch (error) {
  receipts.status = 'FAIL'; receipts.failure = { name: error.name, code: error.code ?? null, message: error.message, operation: error.nativeOperation ?? null, errno: error.nativeErrorCode ?? null, exceptionType: error.nativeExceptionType ?? null, launchError: error.nativeLaunchError ?? null }
  process.exitCode = 1
} finally {
  for (const child of children) child.kill() // Retained native child handle; never PID lookup/kill.
  // Restore only this fixture's tree, using directory security for directories.
  // Include nested matrix files and the root; never suppress restoration failure.
  try {
    const restore = path => {
      const info = lstatSync(path)
      assert.equal(info.isSymbolicLink(), false, 'Synthetic cleanup refuses unexpected links')
      const directory = info.isDirectory()
      // Restore the synthetic caller's write-attributes right before clearing readonly.
      acl(path, { protect: true, directory, phase: 'fixture-cleanup' })
      chmodSync(path, directory ? 0o700 : 0o600)
      if (directory) for (const name of readdirSync(path)) restore(join(path, name))
    }
    restore(root)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    receipts.cleanup = { removed: !existsSync(root) }
    assert.equal(receipts.cleanup.removed, true)
  } catch (error) {
    receipts.cleanup = { removed: false, code: error.code ?? null, message: error.message }
    receipts.status = 'FAIL'; process.exitCode = 1
  }
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/windows-config-writer.json', JSON.stringify(receipts, null, 2))
}
console.log(JSON.stringify(receipts))
