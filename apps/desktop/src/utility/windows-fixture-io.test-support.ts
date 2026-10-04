// Windows equivalents of local synthetic replacement and permission fixtures.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { windowsEnvironmentValue } from '../../bin/windows-env.mjs'

function operate(root: string, path: string, mode: 'replace' | 'directory-access' | 'file-access' | 'inspect', options: Record<string, unknown> = {}): Record<string, boolean> {
  assert.equal(process.platform, 'win32')
  const canonicalRoot = realpathSync.native(root)
  for (const value of [path, ...(typeof options.source === 'string' ? [options.source] : [])]) {
    const inside = relative(canonicalRoot, realpathSync.native(value))
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Synthetic target must remain inside its fresh fixture root')
    assert.equal(lstatSync(value).isSymbolicLink(), false)
  }
  if (mode === 'file-access') {
    assert.equal(lstatSync(path).isFile(), true)
    assert.equal(lstatSync(path).nlink, 1)
  }
  const systemRoot = windowsEnvironmentValue(process.env, 'SystemRoot')
  assert.ok(systemRoot)
  const source = `$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$r=ConvertFrom-Json ([Console]::In.ReadToEnd());$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
if($r.mode -eq 'replace') {[IO.File]::Replace($r.source,$r.path,$null,$false)}
if($r.mode -eq 'directory-access') {$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));if($r.denied){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'CreateFiles,CreateDirectories','Deny')))};[IO.Directory]::SetAccessControl($r.path,$a)}
if($r.mode -eq 'file-access') {$a=New-Object Security.AccessControl.FileSecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));if($r.denied){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadData','Deny')))};[IO.File]::SetAccessControl($r.path,$a)}
$a=if([IO.Directory]::Exists($r.path)){[IO.Directory]::GetAccessControl($r.path)}else{[IO.File]::GetAccessControl($r.path)};$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$other=@($rules|Where-Object{$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value});$allows=@($rules|Where-Object{$_.AccessControlType -eq 'Allow'});[Console]::Out.Write((ConvertTo-Json -Compress @{currentUserOnlyAllow=($other.Count -eq 0 -and $allows.Count -gt 0);deniedReadData=(@($rules|Where-Object{$_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0}).Count -gt 0)}))`
  const result = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path, mode, ...options }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, 'Synthetic native filesystem operation must execute')
  return JSON.parse(result.stdout) as Record<string, boolean>
}

export function replaceWindowsFixtureFile(root: string, source: string, target: string): void {
  operate(root, target, 'replace', { source })
}
export function denyWindowsFixtureDirectoryWrites(root: string, path: string, denied: boolean): void {
  operate(root, path, 'directory-access', { denied })
}
export function denyWindowsFixtureFileReads(root: string, path: string, denied: boolean): void {
  const result = operate(root, path, 'file-access', { denied })
  assert.equal(result.currentUserOnlyAllow, true)
  assert.equal(result.deniedReadData, denied)
}
export function windowsFixtureAllowsOnlyCurrentUser(root: string, path: string): boolean {
  return operate(root, path, 'inspect').currentUserOnlyAllow === true
}
