import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkTarget, windowsConfigFailureMessage, writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'bmn-config-writer-')); roots.push(root); return root }
const windowsAcl = (path, protect = false) => {
  const script = `$ErrorActionPreference='Stop';
Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);
$request=ConvertFrom-Json ([Console]::In.ReadToEnd());
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
if($request.protect) {
 $security=New-Object System.Security.AccessControl.FileSecurity;
 $security.SetOwner($sid);$security.SetAccessRuleProtection($true,$false);
 $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));
 [IO.File]::SetAccessControl($request.path,$security);
};
$actual=[IO.File]::GetAccessControl($request.path);
$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
 @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inherited=$_.IsInherited}
});
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 @{user=$sid.Value;owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$actual.AreAccessRulesProtected;rules=$rules}));`
  const child = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path, protect }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  expect(child.status, child.stderr).toBe(0)
  return JSON.parse(child.stdout)
}

describe('shared config writer', () => {
  it('preserves a protected existing file and its backup with literal Unicode data', () => {
    const root = fixture(), path = join(root, 'settings.json')
    const original = '{"foreign":"KEEP 雪"}\n', next = '{"foreign":"KEEP 雪","days":30}\n'
    writeFileSync(path, original)
    const acl = process.platform === 'win32' ? windowsAcl(path, true) : (chmodSync(path, 0o640), null)
    const result = writeConfigSafely(path, original, next)
    expect(readFileSync(path, 'utf8')).toBe(next)
    expect(readFileSync(result.backup, 'utf8')).toBe(original)
    expect(dirname(result.backup)).toBe(dirname(result.target))
    expect(result.backup.slice(dirname(result.backup).length + 1)).not.toContain(':')
    if (acl) {
      expect(windowsAcl(path)).toEqual(acl)
      expect(windowsAcl(result.backup)).toEqual(acl)
    } else expect(lstatSync(path).mode & 0o777).toBe(0o640)
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  }, 15000)

  it('creates a new private file without a backup', () => {
    const root = fixture(), path = join(root, 'fresh', 'settings.json')
    const result = writeConfigSafely(path, null, '{"days":7}\n')
    expect(result.backup).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{"days":7}\n')
    if (process.platform === 'win32') {
      const acl = windowsAcl(path)
      expect(acl.owner).toBe(acl.user)
      expect(acl.protected).toBe(true)
      expect(acl.rules).toEqual([{ sid: acl.user, rights: 2032127, type: 'Allow', inherited: false }])
    } else expect(lstatSync(path).mode & 0o777).toBe(0o600)
  }, 15000)

  it('keeps another writer’s edit and removes only its staged file', () => {
    const root = fixture(), path = join(root, 'settings.json')
    writeFileSync(path, 'BEFORE')
    if (process.platform === 'win32') windowsAcl(path, true)
    expect(() => writeConfigSafely(path, 'BEFORE', 'OURS', {
      beforeCommit: () => writeFileSync(path, 'THEIRS')
    })).toThrow(/changed/)
    expect(readFileSync(path, 'utf8')).toBe('THEIRS')
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  }, 15000)

  it('refuses a same-content symlink retarget and changes neither destination', () => {
    const root = fixture(), first = join(root, 'first.json'), second = join(root, 'second.json'), path = join(root, 'settings.json')
    writeFileSync(first, 'SAME'); writeFileSync(second, 'SAME'); symlinkSync(first, path, 'file')
    if (process.platform === 'win32') { windowsAcl(first, true); windowsAcl(second, true) }
    expect(() => writeConfigSafely(path, 'SAME', 'OURS', { beforeCommit: () => {
      unlinkSync(path); symlinkSync(second, path, 'file')
    } })).toThrow(/changed/)
    expect(readFileSync(first, 'utf8')).toBe('SAME')
    expect(readFileSync(second, 'utf8')).toBe('SAME')
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
  }, 15000)

  it('does not delete an unrelated replacement of its staged file after a refusal', () => {
    const root = fixture(), path = join(root, 'settings.json')
    writeFileSync(path, 'BEFORE')
    if (process.platform === 'win32') windowsAcl(path, true)
    let replacement
    expect(() => writeConfigSafely(path, 'BEFORE', 'OURS', { beforeCommit: () => {
      const staged = readdirSync(root).filter(name => name.endsWith('.tmp'))
      expect(staged).toHaveLength(1)
      replacement = join(root, staged[0])
      unlinkSync(replacement); writeFileSync(replacement, 'UNRELATED')
      throw new Error('Synthetic refusal')
    } })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('BEFORE')
    expect(readFileSync(replacement, 'utf8')).toBe('UNRELATED')
  }, 15000)

  it('refuses to publish an unrelated staged object even without a callback exception', () => {
    const root = fixture(), path = join(root, 'settings.json')
    writeFileSync(path, 'BEFORE')
    if (process.platform === 'win32') windowsAcl(path, true)
    let replacement
    expect(() => writeConfigSafely(path, 'BEFORE', 'OURS', { beforeCommit: () => {
      const staged = readdirSync(root).filter(name => name.endsWith('.tmp'))
      expect(staged).toHaveLength(1)
      replacement = join(root, staged[0])
      unlinkSync(replacement); writeFileSync(replacement, 'UNRELATED')
    } })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('BEFORE')
    expect(readFileSync(replacement, 'utf8')).toBe('UNRELATED')
  }, 15000)

  it('retains a replacement stage symlink and never deletes its destination', () => {
    const root = fixture(), path = join(root, 'settings.json'), foreign = join(root, 'foreign.json')
    writeFileSync(path, 'BEFORE'); writeFileSync(foreign, 'UNRELATED')
    if (process.platform === 'win32') windowsAcl(path, true)
    let replacement
    expect(() => writeConfigSafely(path, 'BEFORE', 'OURS', { beforeCommit: () => {
      replacement = join(root, readdirSync(root).find(name => name.endsWith('.tmp')))
      unlinkSync(replacement); symlinkSync(foreign, replacement, 'file')
      throw new Error('Synthetic refusal')
    } })).toThrow()
    expect(lstatSync(replacement).isSymbolicLink()).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('UNRELATED')
    expect(readFileSync(path, 'utf8')).toBe('BEFORE')
  }, 15000)

  it('binds a write to the target captured before reading even when contents match', () => {
    const root = fixture(), first = join(root, 'first.json'), second = join(root, 'second.json'), path = join(root, 'settings.json')
    writeFileSync(first, 'SAME'); writeFileSync(second, 'SAME'); symlinkSync(first, path, 'file')
    if (process.platform === 'win32') { windowsAcl(first, true); windowsAcl(second, true) }
    const expectedTarget = linkTarget(path), expectedText = readFileSync(path, 'utf8')
    unlinkSync(path); symlinkSync(second, path, 'file')
    expect(() => writeConfigSafely(path, expectedText, 'OURS', { expectedTarget })).toThrow(/changed/)
    expect(readFileSync(first, 'utf8')).toBe('SAME')
    expect(readFileSync(second, 'utf8')).toBe('SAME')
  }, 15000)

  it('writes the destination the native filesystem reads for directory-link dotdot', () => {
    const root = fixture()
    mkdirSync(join(root, 'real', 'nested'), { recursive: true })
    symlinkSync(join(root, 'real', 'nested'), join(root, 'branch'), 'dir')
    const outer = join(root, 'settings.json'), inner = join(root, 'real', 'settings.json')
    writeFileSync(outer, 'OUTER'); writeFileSync(inner, 'INNER')
    if (process.platform === 'win32') { windowsAcl(outer, true); windowsAcl(inner, true) }
    const path = `${join(root, 'branch')}/../settings.json`
    const expected = readFileSync(path, 'utf8')
    const target = process.platform === 'win32' ? outer : inner
    const untouched = process.platform === 'win32' ? inner : outer
    const sentinel = readFileSync(untouched, 'utf8')
    expect(linkTarget(path)).toBe(realpathSync.native(target))
    writeConfigSafely(path, expected, 'UPDATED')
    expect(readFileSync(target, 'utf8')).toBe('UPDATED')
    expect(readFileSync(untouched, 'utf8')).toBe(sentinel)
  }, 15000)

  it('keeps a dangling file link and creates its destination', () => {
    const root = fixture(), path = join(root, 'settings.json'), target = join(root, 'later.json')
    symlinkSync(target, path, 'file')
    writeConfigSafely(path, null, 'CREATED')
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('CREATED')
  }, 15000)
})

describe('Windows config write failures', () => {
  it('names a config another program holds open, and keeps the other messages', () => {
    for (const errno of [32, 33, 1224]) {
      expect(windowsConfigFailureMessage('IO_ERROR', errno)).toBe(
        'The config file is in use or locked by another program; close it there and try again. It was not replaced')
    }
    expect(windowsConfigFailureMessage('IO_ERROR', 5)).toMatch(/^Windows could not confirm the config operation/)
    expect(windowsConfigFailureMessage('RECOVERY_REQUIRED', 32)).toMatch(/^Windows could not confirm the config operation/)
    expect(windowsConfigFailureMessage('REVISION_CONFLICT', 32)).toBe('Config changed before Windows replacement; it was not replaced')
  })
})
