// Windows mode bits do not restrict other users. Apply and read back a protected DACL
// before opening BMN state. Paths are data passed through stdin, never PowerShell code.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { homedir } from 'node:os'

const WINDOWS_PRIVATE_DIRECTORY = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
$paths = $request.paths
$chromiumDataRoot = $request.chromiumDataRoot
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# Electron 44 / Chromium lpacContentNetworkService. This is a restricted-token
# capability, never an owner or ordinary user. See docs/windows-storage-security.md.
$networkCapability = 'S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417'
$trustedPrincipals = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
try {
  $installer = New-Object System.Security.Principal.NTAccount('NT SERVICE', 'TrustedInstaller')
  $trustedPrincipals += $installer.Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch { }
function Assert-SafeOwner($security) {
  if ($trustedPrincipals -notcontains $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Another account owns BMN storage or an ancestor' }
}
function Assert-SafeAncestors($directory) {
  # Never follow a root or ancestor junction while establishing private storage.
  for ($parent = $directory; $null -ne $parent; $parent = $parent.Parent) {
    if ($parent.Exists -and (($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'BMN roots cannot traverse junctions or symlinks' }
    if ($parent.Exists) {
      $security = $parent.GetAccessControl()
      Assert-SafeOwner $security
      $replaceRights = [System.Security.AccessControl.FileSystemRights]'Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
      foreach ($entry in $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        $trusted = $trustedPrincipals -contains $entry.IdentityReference.Value
        $applies = ($entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
        if (-not $trusted -and $applies -and $entry.AccessControlType -eq 'Allow' -and ($entry.FileSystemRights -band $replaceRights) -ne 0) { throw 'BMN root can be replaced through an unsafe ancestor' }
      }
    }
  }
}
foreach ($path in $paths) {
  $directory = New-Object System.IO.DirectoryInfo($path)
  Assert-SafeAncestors $directory
  if (-not $directory.Exists) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    $directory.Create($acl)
    # Exists cached the missing state; reload before inspecting attributes and ancestry.
    $directory.Refresh()
  }
  Assert-SafeAncestors $directory
  # Existing directories are validated, never repaired or adopted by changing ACLs.
  $actual = $directory.GetAccessControl()
  if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $actual.AreAccessRulesProtected) { throw 'BMN root is not private storage owned by this account' }
  $pending = New-Object 'System.Collections.Generic.Queue[System.IO.FileSystemInfo]'
  $pending.Enqueue($directory)
  $discovered = 1
  while ($pending.Count -gt 0) {
    $item = $pending.Dequeue()
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'BMN storage contains an unverified link' }
    $security = $item.GetAccessControl()
    Assert-SafeOwner $security
    $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $userRules = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value })
    if ($userRules.Count -ne 1 -or $userRules[0].AccessControlType -ne 'Allow' -or $userRules[0].FileSystemRights -ne 'FullControl' -or $userRules[0].PropagationFlags -ne 'None') { throw 'BMN storage ACL verification failed' }
    $chromiumItem = $false
    if ($chromiumDataRoot -and $directory.FullName.Equals($chromiumDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      foreach ($name in @('Cache', 'Network', 'Shared Dictionary')) {
        $prefix = [System.IO.Path]::Combine($directory.FullName, $name)
        if ($item.FullName.Equals($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or $item.FullName.StartsWith($prefix + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { $chromiumItem = $true }
      }
    }
    foreach ($rule in $rules) {
      if ($rule.IdentityReference.Value -eq $sid.Value) { continue }
      if (-not $chromiumItem -or $rule.IdentityReference.Value -ne $networkCapability -or $rule.AccessControlType -ne 'Allow') { throw 'BMN storage ACL verification failed' }
      $direct = [int]$rule.FileSystemRights -eq 1245631 -and $rule.InheritanceFlags -eq 'None' -and $rule.PropagationFlags -eq 'None'
      $template = $item -is [System.IO.DirectoryInfo] -and [int]$rule.FileSystemRights -eq -536805376 -and $rule.InheritanceFlags -eq 'ContainerInherit, ObjectInherit' -and $rule.PropagationFlags -eq 'InheritOnly'
      if (-not $direct -and -not $template) { throw 'BMN Chromium storage ACL verification failed' }
    }
    if ($item -is [System.IO.DirectoryInfo]) {
      if ($userRules[0].InheritanceFlags -ne 'ContainerInherit, ObjectInherit') { throw 'BMN storage ACL does not protect new children' }
      $entries = $item.EnumerateFileSystemInfos().GetEnumerator()
      try {
        while ($entries.MoveNext()) {
          if ($discovered -ge 10000) { throw 'BMN directory security check exceeded its entry limit' }
          $discovered++
          $pending.Enqueue($entries.Current)
        }
      } finally { $entries.Dispose() }
    }
  }
}
[Console]::Out.Write('BMN_PRIVATE_ROOTS_OK')
`

export function ensurePrivateDirectories(
  roots: readonly string[], platform: NodeJS.Platform = process.platform, chromiumDataRoot?: string
): void {
  if (platform !== 'win32') {
    for (const root of roots) {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
    }
    return
  }
  if (chromiumDataRoot) {
    const data = win32.resolve(chromiumDataRoot).toLowerCase()
    let matches = 0
    for (const root of roots) {
      const candidate = win32.resolve(root).toLowerCase()
      if (candidate === data) matches++
      else if (candidate.startsWith(data.endsWith('\\') ? data : data + '\\') || data.startsWith(candidate.endsWith('\\') ? candidate : candidate + '\\')) {
        throw new Error('BMN Windows data folders must not overlap the Chromium data folder')
      }
    }
    if (matches !== 1) throw new Error('BMN Windows Chromium data folder must be a distinct application root')
  }
  for (const root of roots) {
    const normalized = win32.resolve(root).toLowerCase()
    const protectedRoots = [win32.parse(root).root, homedir(), process.env.LOCALAPPDATA, process.env.SystemRoot]
      .filter((path): path is string => !!path).map((path) => win32.resolve(path).toLowerCase())
    if (!win32.isAbsolute(root) || protectedRoots.includes(normalized)) {
      throw new Error('BMN Windows data roots must be dedicated absolute application directories')
    }
  }
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable')
  const result = spawnSync(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WINDOWS_PRIVATE_DIRECTORY, 'utf16le').toString('base64')
  ], { input: JSON.stringify({ paths: [...new Set(roots)], chromiumDataRoot: chromiumDataRoot && win32.resolve(chromiumDataRoot) }), encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true })
  if (result.error || result.status !== 0 || result.stdout !== 'BMN_PRIVATE_ROOTS_OK') {
    // Do not expose shell diagnostics, which may contain environment or path data.
    throw new Error('BMN could not secure its Windows data folders. Use new dedicated folders on an ACL-capable local drive, or existing private BMN folders without unverified links; Windows PowerShell must be available.')
  }
}
