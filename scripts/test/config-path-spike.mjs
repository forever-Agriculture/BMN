// Synthetic filesystem measurement; does not read or change any harness profile.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'bmn-config-path-measurement-'))
const receipt = { platform: process.platform, acceptance: 'INCONCLUSIVE', paths: [], acl: 'UNVERIFIED' }
const inspect = (name, path) => {
  const result = { name }
  for (const [key, probe] of Object.entries({
    contents: () => readFileSync(path, 'utf8'),
    link: () => readlinkSync(path),
    nativeRealpath: () => realpathSync.native(path),
    realpath: () => realpathSync(path),
    identity: () => { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}` }
  })) {
    try { result[key] = probe() } catch (error) { result[key] = { code: error.code } }
  }
  receipt.paths.push(result)
}
const powershell = (action, paths) => {
  const script = `$ErrorActionPreference='Stop';
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);
$request=ConvertFrom-Json ([Console]::In.ReadToEnd());
if($request.action -eq 'protect') {
 $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
 $acl=New-Object System.Security.AccessControl.FileSecurity;
 $acl.SetAccessRuleProtection($true,$false);
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));
 [System.IO.File]::SetAccessControl($request.paths[0],$acl);
};
$result=@($request.paths | ForEach-Object { (Get-Acl -LiteralPath $_).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) });
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $result));`
  const child = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ action, paths }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}
try {
  mkdirSync(join(root, 'real', 'nested'), { recursive: true })
  writeFileSync(join(root, 'target.json'), 'OUTSIDE_LINK_TARGET')
  writeFileSync(join(root, 'real', 'target.json'), 'INSIDE_LINK_TARGET')
  symlinkSync(join(root, 'real', 'nested'), join(root, 'branch'), 'dir')
  symlinkSync('branch/../target.json', join(root, 'settings.json'), 'file')
  symlinkSync(join('..', 'target.json'), join(root, 'real', 'nested', 'settings.json'), 'file')
  symlinkSync('missing/../target.json', join(root, 'missing-parent.json'), 'file')
  symlinkSync(join(root, 'later.json'), join(root, 'missing-leaf.json'), 'file')
  inspect('given-directory-link-dotdot', `${join(root, 'branch')}/../target.json`)
  inspect('file-link-directory-link-dotdot', join(root, 'settings.json'))
  inspect('directory-link-relative-file-link', join(root, 'branch', 'settings.json'))
  inspect('file-link-missing-parent-dotdot', join(root, 'missing-parent.json'))
  inspect('file-link-missing-leaf', join(root, 'missing-leaf.json'))
  if (process.platform === 'win32') {
    const original = join(root, 'acl-original.json')
    const temporary = join(root, 'acl-temporary.json')
    const replaced = join(root, 'acl-replaced.json')
    writeFileSync(original, 'ORIGINAL')
    const [expected] = powershell('protect', [original])
    copyFileSync(original, temporary)
    writeFileSync(temporary, 'REPLACEMENT')
    writeFileSync(replaced, 'OTHER')
    renameSync(temporary, replaced)
    const [actual] = powershell('read', [replaced])
    receipt.acl = { copyWriteRenamePreservesDacl: actual === expected, expected, actual }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/config-path-spike.json', JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
