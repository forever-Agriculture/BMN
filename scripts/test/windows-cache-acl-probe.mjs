// Temporary synthetic native Chromium ACL probe; no native module rebuild or owner profile.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

assert.equal(process.platform, 'win32')
assert.ok(process.env.BMN_PROBE_ELECTRON)
const parent = mkdtempSync(join(tmpdir(), 'bmn-cache-acl-'))
try {
  const root = join(parent, 'private')
  ensurePrivateDirectories([root])
  const fixture = join(parent, 'fixture.cjs')
  writeFileSync(fixture, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.argv[2]);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<p>Synthetic cache fixture</p>');
  setTimeout(() => app.exit(0), 1000);
}).catch(() => app.exit(1));\n`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BMN_ROOT_DIAGNOSTIC
  const electron = spawnSync(process.env.BMN_PROBE_ELECTRON, [fixture, root], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(electron.error, undefined)
  assert.equal(electron.status, 0, electron.stderr)
  const script = `$ErrorActionPreference='Stop';
$path=ConvertFrom-Json ([Console]::In.ReadToEnd());
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$root=New-Object System.IO.DirectoryInfo($path);
$items=@($root)+@($root.EnumerateFileSystemInfos());
$results=@(foreach ($item in $items) {
 $acl=$item.GetAccessControl();
 $rules=@(foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  @{sid=if ($rule.IdentityReference.Value -eq $sid) {'CURRENT_USER'} else {$rule.IdentityReference.Value}; rights=$rule.FileSystemRights.ToString(); type=$rule.AccessControlType.ToString(); inherited=$rule.IsInherited; inheritance=$rule.InheritanceFlags.ToString(); propagation=$rule.PropagationFlags.ToString()}
 });
 @{name=$item.Name; owner=if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid) {'CURRENT_USER'} else {$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value}; protected=$acl.AreAccessRulesProtected; rules=$rules}
});
ConvertTo-Json -InputObject $results -Depth 6 -Compress`
  const acl = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { input: JSON.stringify(root), encoding: 'utf8', timeout: 15_000 })
  assert.equal(acl.error, undefined)
  assert.equal(acl.status, 0, acl.stderr)
  let guard = 'passed'
  try { ensurePrivateDirectories([root]) } catch (error) { guard = error.message }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-cache-acl.json', JSON.stringify({ diagnosticOnly: true, guard, entries: JSON.parse(acl.stdout) }, null, 2))
  console.log(JSON.stringify({ diagnosticOnly: true, guard }))
} finally { rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
