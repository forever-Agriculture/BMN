// Only fresh, synthetic test files may opt into this elevated-runner ownership setup.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { windowsEnvironmentValue } from '../../bin/windows-env.mjs'

export function ownWindowsFixtureFile(root: string, path: string): void {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') return
  const canonicalRoot = realpathSync.native(root), canonicalFile = realpathSync.native(path)
  const inside = relative(canonicalRoot, canonicalFile)
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Fixture file must remain inside its fresh root')
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Fixture must be one ordinary synthetic file')
  const systemRoot = windowsEnvironmentValue(process.env, 'SystemRoot')
  assert.ok(systemRoot)
  const source = `$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));$PSModuleAutoLoadingPreference='None';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$path=ConvertFrom-Json ([Console]::In.ReadToEnd());$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[IO.File]::GetAccessControl($path);$acl.SetOwner($sid);[IO.File]::SetAccessControl($path,$acl);[Console]::Out.Write(([IO.File]::GetAccessControl($path).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value))`
  const result = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { input: JSON.stringify(path), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, 'Synthetic owner setup must execute')
  assert.equal(result.stdout.trim(), 'True', 'Synthetic file owner must match current user')
}
