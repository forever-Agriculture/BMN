// MODULE: safe-config-write.mjs - backup, revision check and atomic write for agent config files, shared by bin/bmn and the utility process
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'

/** A stable failure code. Unconfirmed native replacement retains backup/staged data for recovery. */
export class ConfigWriteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const CliError = ConfigWriteError

/**
 * Absolute, but never through `resolve` or `join`: both collapse `..` as text, and a `..` has to
 * reach `linkTarget` intact or it is answered from where a link was written, not where it points.
 */
export function absoluteUncollapsed(path) {
  if (process.platform === 'win32') {
    if (/^[a-z]:[^\\/]/i.test(path) || /^[a-z]:$/i.test(path) || /^[\\/](?![\\/])/.test(path)) {
      throw new CliError('AMBIGUOUS_PATH', 'Use a fully qualified drive/UNC path or an ordinary relative config path')
    }
    return win32.isAbsolute(path) ? path : `${process.cwd()}\\${path}`
  }
  return isAbsolute(path) ? path : `${process.cwd()}/${path}`
}

/**
 * Temp file in the same folder, then rename: a crash mid-write leaves the old file intact. The
 * rename replaces whatever `path` names, so a symlinked settings file is resolved first and the
 * link itself survives, still pointing at the file that was updated. `verify` runs with the temp
 * written and the original still in place: it is the last chance to refuse rather than replace.
 */
/**
 * The file at the end of a symlink, followed even when it does not exist yet: a dotfiles repository
 * often links a settings file that is created later, and the harness reads the end of the link, so
 * that is the file BMN must write rather than the link it would otherwise replace.
 */
const MAX_LINK_HOPS = 10

export function linkTarget(path) {
  if (process.platform === 'win32') return windowsLinkTarget(path)
  // Resolved the way the kernel resolves a path: one component at a time, following each symlink as
  // it is met, so `..` after a symlink steps back from where the link landed and not from where it
  // was written. Neither `resolve()` nor `realpathSync()` can be used here - both collapse `..` as
  // text first, which lands on a different file and would overwrite whatever happens to be there.
  // Made absolute by concatenation, never by `resolve`/`join`, which would collapse the `..` in the
  // given path itself before a single link had been read.
  let pending = absoluteUncollapsed(path).split('/').filter((part) => part !== '')
  let out = ''
  let hops = 0
  while (pending.length > 0) {
    const part = pending.shift()
    if (part === '.') continue
    if (part === '..') {
      out = out.slice(0, out.lastIndexOf('/'))
      continue
    }
    const next = `${out}/${part}`
    let link
    try {
      link = readlinkSync(next)
    } catch (error) {
      // A component that is not a link is simply itself, and one that is not there at all is a
      // directory the install will create. Only a `..` after a missing component is unanswerable:
      // where it steps back to depends on what that component would have been.
      if (error.code === 'ENOENT' && pending.includes('..')) {
        throw new CliError('UNRESOLVED_LINK', `${path} leads through ${next}, which does not exist; resolve it by hand`)
      }
      out = next
      continue
    }
    hops += 1
    if (hops > MAX_LINK_HOPS) {
      throw new CliError(
        'TOO_MANY_LINKS', `${path} passes through more than ${MAX_LINK_HOPS} symlinks; resolve it by hand`
      )
    }
    const target = isAbsolute(link) ? link : `${out}/${link}`
    pending = [...target.split('/').filter((part) => part !== ''), ...pending]
    out = ''
  }
  return out === '' ? '/' : out
}

function windowsLinkTarget(path) {
  let pendingPath = absoluteUncollapsed(path)
  let hops = 0
  for (;;) {
    // Native ordinary Windows reads normalize dotdot before traversing links.
    // Device namespaces have different semantics and are refused for config writes.
    if (/^[\\/]{2}[?.][\\/]/.test(pendingPath)) throw new CliError('UNRESOLVED_LINK', 'Device namespaces are not supported for config writes')
    pendingPath = win32.normalize(pendingPath)
    const root = win32.parse(pendingPath).root
    if (!root || !win32.isAbsolute(pendingPath)) throw new CliError('UNRESOLVED_LINK', 'Config path has no fully qualified Windows root')
    const parts = pendingPath.slice(root.length).split('\\').filter(Boolean)
    if (parts.length > 512 || parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw new CliError('UNRESOLVED_LINK', 'Config path contains an unsupported Windows component')
    }
    let out = realpathSync.native(root)
    let restart = false
    for (let index = 0; index < parts.length; index++) {
      const next = win32.join(out, parts[index])
      let item
      try { item = lstatSync(next) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return win32.join(out, ...parts.slice(index))
      }
      if (item.isSymbolicLink()) {
        if (++hops > MAX_LINK_HOPS) throw new CliError('TOO_MANY_LINKS', `${path} passes through more than ${MAX_LINK_HOPS} symlinks; resolve it by hand`)
        const link = readlinkSync(next)
        pendingPath = win32.join(absoluteUncollapsed(win32.isAbsolute(link) ? link : `${out}\\${link}`), ...parts.slice(index + 1))
        restart = true
        break
      }
      if (index + 1 < parts.length && !item.isDirectory()) throw new CliError('UNRESOLVED_LINK', 'Config path traverses a non-directory component')
      out = realpathSync.native(next)
    }
    if (!restart) return out
  }
}

// Fixed source, JSON stdin: neither paths nor settings become PowerShell code.
// FileSecurity protects the staged file at creation, before any settings bytes.
const WINDOWS_CONFIG_WRITE = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=ConvertFrom-Json ([Console]::In.ReadToEnd())
$created=$false; $published=$false; $backupReserved=$false; $failureCode='IO_ERROR'; $operation='start'; $stream=$null; $originalStream=$null; $backupStream=$null; $stagedStream=$null; $publishedStream=$null
function Fingerprint($acl) {
 $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=$_.IsInherited}
 })
 $text=ConvertTo-Json -Compress -Depth 5 ([ordered]@{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=$rules})
 $hash=[System.Security.Cryptography.SHA256]::Create()
 try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
}
function StreamHash($file) {
 $file.Position=0
 $hash=[System.Security.Cryptography.SHA256]::Create()
 try { return ([BitConverter]::ToString($hash.ComputeHash($file))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
}
function OpenOriginal($path) {
 return (New-Object System.IO.FileStream($path,[IO.FileMode]::Open,[System.Security.AccessControl.FileSystemRights]'Read, ReadPermissions',([IO.FileShare]::Read -bor [IO.FileShare]::Delete),4096,[IO.FileOptions]::None))
}
function PrivateSecurity($sid) {
 $acl=New-Object System.Security.AccessControl.FileSecurity
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
 return $acl
}
try {
 if($request.mode -eq 'prepare') {
  $operation='original-exists'
  $exists=[IO.File]::Exists($request.target)
  if($exists -ne $request.existed) { $failureCode='REVISION_CONFLICT';throw 'Original changed before staging' }
  $original=$null
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if($exists) {
   $operation='original-open'
   $originalStream=OpenOriginal $request.target
   if((StreamHash $originalStream) -ne $request.expectedHash) { $failureCode='REVISION_CONFLICT';throw 'Original changed before staging' }
   $originalAcl=$originalStream.GetAccessControl()
   if($originalAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $failureCode='FOREIGN_OWNER';throw 'Original has another owner' }
   $original=Fingerprint $originalAcl
  }
  # The staged owner and protected DACL are current-user-only before bytes.
  # Never adopt foreign-owned originals or acquire privileges.
  $acl=PrivateSecurity $sid
  $expected=Fingerprint $acl
  $operation='stage-create'
  $stream=New-Object System.IO.FileStream($request.temporary,[IO.FileMode]::CreateNew,[System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions',[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$acl)
  $created=$true
  if((Fingerprint ($stream.GetAccessControl())) -ne $expected) { $failureCode='ACCESS_CONTROL_UNCONFIRMED';throw 'Staged permissions differ' }
  $bytes=[Text.Encoding]::UTF8.GetBytes($request.text)
  $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
  [Console]::Out.Write((ConvertTo-Json -Compress @{ok=$true;existed=$exists;originalDacl=$original;stagedDacl=$expected}))
 } elseif($request.mode -eq 'commit') {
  # Identity uses volume + 128-bit file ID, supporting NTFS/ReFS without PID/path guesses.
  $operation='identity-type'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BMNConfigIdentity {
 [StructLayout(LayoutKind.Sequential)] struct IdInfo { public ulong volume, low, high; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out IdInfo info,uint size);
 public static string Read(SafeFileHandle file) {
  IdInfo info;
  if(!GetFileInformationByHandleEx(file,18,out info,24)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  if(info.low==0 && info.high==0) throw new System.IO.IOException("File identity unavailable");
  return info.volume.ToString("x16")+":"+info.high.ToString("x16")+info.low.ToString("x16");
 }
}
'@
  $operation='stage-open'
  $stagedStream=New-Object System.IO.FileStream($request.temporary,[IO.FileMode]::Open,[System.Security.AccessControl.FileSystemRights]'Read, ReadPermissions, ChangePermissions',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete),4096,[IO.FileOptions]::None)
  $operation='stage-identity'
  $stagedIdentity=[BMNConfigIdentity]::Read($stagedStream.SafeFileHandle)
  if((Fingerprint ($stagedStream.GetAccessControl())) -ne $request.stagedDacl) { $failureCode='ACCESS_CONTROL_UNCONFIRMED';throw 'Staged permissions changed' }
  if($request.existed) {
   $operation='original-open'
   $originalStream=OpenOriginal $request.target
   $originalAcl=$originalStream.GetAccessControl()
   if((StreamHash $originalStream) -ne $request.expectedHash -or
      (Fingerprint $originalAcl) -ne $request.originalDacl) { $failureCode='REVISION_CONFLICT';throw 'Original changed' }
   # Reserve our UUID backup exclusively with private permissions before replacement.
   $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
   $operation='backup-reserve'
   $reservation=New-Object System.IO.FileStream($request.backup,[IO.FileMode]::CreateNew,[System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions',[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(PrivateSecurity $sid))
   $backupReserved=$true;$reservation.Dispose()
   # Retained original handle denies in-place writers. Delete sharing permits Replace,
   # so namespace writers are detected from displaced backup; this is not atomic CAS.
   # Synthetic handshake exercises the otherwise narrow namespace race in tests.
   if($request.testGate) {
    [IO.File]::WriteAllText(($request.testGate+'.waiting'),'')
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while(-not [IO.File]::Exists($request.testGate)) {
     if([DateTime]::UtcNow -gt $deadline) { throw 'Test handshake expired' }
     [Threading.Thread]::Sleep(10)
    }
   }
   $operation='replace'
   [IO.File]::Replace($request.temporary,$request.target,$request.backup,$false)
   $published=$true
   $operation='backup-open'
   $backupStream=OpenOriginal $request.backup
   $operation='backup-verify'
   if((StreamHash $backupStream) -ne $request.expectedHash -or
      (Fingerprint ($backupStream.GetAccessControl())) -ne $request.originalDacl) { $failureCode='REVISION_CONFLICT';throw 'Concurrent replacement displaced different data' }
   # Replace can add explicit copies of inherited ACEs. Restore Access only through
   # the retained staged-object handle, never repair an owner or a retargeted path.
   $failureCode='ACCESS_CONTROL_UNCONFIRMED'
   if($request.testRepairFailure) { throw 'Synthetic postpublication repair failure' }
   $operation='access-restore'
   $restore=New-Object System.Security.AccessControl.FileSecurity
   $restore.SetSecurityDescriptorBinaryForm($originalAcl.GetSecurityDescriptorBinaryForm(),[System.Security.AccessControl.AccessControlSections]::Access)
   $stagedStream.SetAccessControl($restore)
   $operation='published-open'
   $publishedStream=OpenOriginal $request.target
   if([BMNConfigIdentity]::Read($publishedStream.SafeFileHandle) -ne $stagedIdentity -or
      (Fingerprint ($stagedStream.GetAccessControl())) -ne $request.originalDacl -or
      (Fingerprint ($publishedStream.GetAccessControl())) -ne $request.originalDacl) { throw 'Replacement identity or permissions differ' }
  } else {
   if([IO.File]::Exists($request.target)) { $failureCode='REVISION_CONFLICT';throw 'A file appeared' }
   $operation='move'
   [IO.File]::Move($request.temporary,$request.target)
   $published=$true
   $operation='published-open'
   $publishedStream=OpenOriginal $request.target
   if([BMNConfigIdentity]::Read($publishedStream.SafeFileHandle) -ne $stagedIdentity -or
      (Fingerprint ($publishedStream.GetAccessControl())) -ne $request.stagedDacl) { $failureCode='ACCESS_CONTROL_UNCONFIRMED';throw 'New file identity or permissions differ' }
  }
  [Console]::Out.Write('{"ok":true}')
 } else { throw 'Unknown operation' }
} catch {
 $exception=$_.Exception
 for($depth=0;$depth -lt 8 -and $null -ne $exception.InnerException;$depth++) {$exception=$exception.InnerException}
 $errno=if($exception -is [System.ComponentModel.Win32Exception]) {$exception.NativeErrorCode} else {$exception.HResult -band 65535}
 $recovery=$published -or ($request.mode -eq 'commit' -and $errno -in @(1175,1176,1177))
 [Console]::Out.Write((ConvertTo-Json -Compress @{ok=$false;code=$failureCode;errno=$errno;created=$created;recoveryRequired=$recovery;published=$published;operation=($request.mode+':'+$operation);exceptionType=$exception.GetType().FullName}))
 exit 1
} finally {
 if($null -ne $stream) {$stream.Dispose()}
 if($null -ne $publishedStream) {$publishedStream.Dispose()}
 if($null -ne $stagedStream) {$stagedStream.Dispose()}
 if($null -ne $backupStream) {$backupStream.Dispose()}
 if($null -ne $originalStream) {$originalStream.Dispose()}
 if($backupReserved -and -not $published -and -not $recovery) { try { [IO.File]::Delete($request.backup) } catch {} }
}
`

function windowsConfigOperation(request) {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new CliError('IO_ERROR', 'Windows SystemRoot is unavailable')
  const child = spawnSync(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_CONFIG_WRITE, 'utf16le').toString('base64')],
    { input: JSON.stringify(request), encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true })
  let result
  try { result = JSON.parse(child.stdout) } catch { /* Never expose diagnostics or settings bytes. */ }
  if (child.error || child.status !== 0 || result?.ok !== true) {
    const recoveryRequired = request.mode === 'commit' && (result?.recoveryRequired === true || !result)
    const code = recoveryRequired ? 'RECOVERY_REQUIRED' : result?.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : 'IO_ERROR'
    const error = new CliError(code, code === 'REVISION_CONFLICT' ? 'Config changed before Windows replacement; it was not replaced' : 'Windows could not confirm the config operation; inspect the original and any retained backup/staged file')
    error.created = result?.created === true
    error.nativeOperation = result?.operation
    error.nativeErrorCode = result?.errno
    error.nativeExceptionType = result?.exceptionType
    error.recoveryRequired = recoveryRequired
    throw error
  }
  return result
}

export function writeAtomically(path, text, verify, backup = null) {
  const target = linkTarget(path)
  const temporary = join(dirname(target), `.${basename(target)}.bmn-${randomUUID()}.tmp`)
  if (process.platform === 'win32') {
    let prepared = false
    let committed = false
    let recoveryRequired = false
    try {
      mkdirSync(dirname(target), { recursive: true })
      const originalHash = currentText(target) === null ? null : createHash('sha256').update(readFileSync(target)).digest('hex')
      const stage = windowsConfigOperation({ mode: 'prepare', target, temporary, text, existed: originalHash !== null, expectedHash: originalHash })
      prepared = true
      verify?.(target)
      if (linkTarget(path) !== target) throw new CliError('REVISION_CONFLICT', 'Config changed target before Windows replacement')
      windowsConfigOperation({ mode: 'commit', target, temporary, backup: backup ?? backupPath(target), expectedHash: originalHash,
        testGate: process.env.NODE_ENV === 'test' ? process.env.BMN_CONFIG_WRITE_TEST_GATE : undefined,
        testRepairFailure: process.env.NODE_ENV === 'test' && process.env.BMN_CONFIG_WRITE_TEST_REPAIR_FAILURE === '1', ...stage })
      committed = true
    } catch (error) {
      prepared ||= error.created === true
      recoveryRequired = error.recoveryRequired === true
      throw error
    } finally {
      if (prepared && !committed && !recoveryRequired) {
        try { unlinkSync(temporary) } catch { /* Already committed or removed. */ }
      }
    }
    return target
  }
  try {
    // A fresh machine has no ~/.codex yet, and that is the machine this command is for.
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, text, { mode: 0o600 })
    try {
      // chmod, not a second write: the mode option applies only when the file is created.
      chmodSync(temporary, statSync(target).mode & 0o777)
    } catch {
      // A new file keeps the restrictive mode above; a hook file names the owner's own machine.
    }
    verify?.(target)
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file is already gone, or was never created.
    }
    throw error
  }
  return target
}

/** The bytes on disk now, or null when the file is gone; used to refuse an overwrite of somebody else's edit. */
export function currentText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * A JSON number literal as an exact decimal: sign, digits and a power of ten, with trailing zeros
 * removed so `1.0`, `1` and `1e0` all come out the same. Comparing these compares the numbers two
 * spellings denote, which is the only question worth asking about a rewrite.
 */
function decimalParts(token) {
  const parsed = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (parsed === null) return null
  const [, sign, whole, fraction = '', exponent = '0'] = parsed
  let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  let scale = BigInt(exponent) - BigInt(fraction.length)
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    scale += 1n
  }
  return digits === '0' ? { sign: '', digits: '0', scale: 0n } : { sign, digits, scale }
}

/**
 * Numbers `install` would write back as a different number. It reserializes the file, and
 * `JSON.stringify` does not promise the digits it was handed: `18446744073709551615` comes out as
 * `18446744073709552000`, `1000000000000000128` as `1000000000000000100`, `9007199254740993.0` as
 * `9007199254740992`, and `1e400` as `null`. Each is a silent edit to a value BMN was not asked to
 * touch, in a file it had just called fine.
 *
 * So the comparison is between the literal in the file and the literal the writer would emit, as
 * exact decimals. `1.0` becoming `1` is the same number and is allowed; the rest are not. Judging
 * this from the shape of the token was the previous version of this guard, and it was wrong in
 * both directions.
 *
 * Node hands the reviver the literal source from 21 on. `bin/bmn` runs under whatever node the
 * machine has, so where that is missing this finds nothing and `install` behaves as it always did
 * - it is a guard on a rare file, never something `check` depends on.
 */
export function rewrittenNumbers(text) {
  const changed = []
  try {
    JSON.parse(text, function compareToken(key, value, context) {
      const source = context?.source
      if (typeof value !== 'number' || typeof source !== 'string') return value
      const before = decimalParts(source)
      const after = Number.isFinite(value) ? decimalParts(JSON.stringify(value)) : null
      if (before === null || after === null || before.sign !== after.sign
        || before.digits !== after.digits || before.scale !== after.scale) {
        changed.push(source)
      }
      return value
    })
  } catch {
    return []
  }
  return changed
}

/** The indent the file already uses, so installing changes the hooks and not every other line. */
export function jsonIndent(text) {
  const match = /\n([ \t]+)"/.exec(text)
  if (match === null) return 2
  return match[1].startsWith('\t') ? '\t' : match[1].length
}

/**
 * Replaces a config file only if it still holds `expectedText` (null: it must not exist), keeping a
 * copy of any existing file at `<path>.bmn-backup-<ISO time>` first. The check runs twice: before the
 * backup and again with the replacement staged, so the window for another writer is one rename.
 * `beforeCommit` is a test seam that runs between the two checks.
 */
export function writeConfigSafely(path, expectedText, nextText, { beforeCommit, now = () => new Date(), expectedTarget } = {}) {
  const originalTarget = expectedTarget ?? linkTarget(path)
  const unchanged = () => {
    if (linkTarget(path) !== originalTarget || currentText(path) !== expectedText) {
      throw new ConfigWriteError('REVISION_CONFLICT', `${path} changed while BMN was reading it; nothing was written`)
    }
  }
  unchanged()
  let backup = null
  if (expectedText !== null) {
    backup = backupPath(process.platform === 'win32' ? originalTarget : path, now())
    if (process.platform !== 'win32') copyFileSync(path, backup, constants.COPYFILE_EXCL)
  }
  const target = writeAtomically(path, nextText, () => {
    beforeCommit?.()
    unchanged()
  }, backup)
  return { target, backup }
}

function backupPath(path, now = new Date()) {
  return `${path}.bmn-backup-${now.toISOString().replaceAll(':', '-')}-${randomUUID()}`
}
