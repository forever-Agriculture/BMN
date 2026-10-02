// Native regression: sandboxed Chromium cache ACLs and strict durable-data policy.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'

assert.equal(process.platform, 'win32')
assert.ok(process.env.BMN_PROBE_ELECTRON)
// Only this disposable synthetic fixture may expose PowerShell failure details.
const originalSpawnSync = childProcess.spawnSync
childProcess.spawnSync = (executable, args, options) => {
  if (args.includes('-EncodedCommand')) {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    if (script.includes('BMN_PRIVATE_ROOTS_OK')) {
      args = [...args]
      args[args.length - 1] = Buffer.from(`trap { [Console]::Error.WriteLine('SYNTHETIC_ACL_ITEM=' + $item.FullName); throw };\n${script}`, 'utf16le').toString('base64')
    }
  }
  const result = originalSpawnSync(executable, args, options)
  if (result.status !== 0) console.error(JSON.stringify({ syntheticAclFailure: true, status: result.status, stderr: result.stderr, error: result.error?.code }))
  return result
}
syncBuiltinESMExports()
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
  const electron = spawnSync(process.env.BMN_PROBE_ELECTRON, [fixture, root], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(electron.error, undefined)
  assert.equal(electron.status, 0, electron.stderr)
  const script = `$ErrorActionPreference='Stop';
$path=ConvertFrom-Json ([Console]::In.ReadToEnd());
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$root=New-Object System.IO.DirectoryInfo($path);
$items=@($root)+@($root.EnumerateFileSystemInfos('*', [System.IO.SearchOption]::AllDirectories));
if ($items.Count -gt 1000) { throw 'Synthetic probe entry bound exceeded' }
$results=@(foreach ($item in $items) {
 $acl=$item.GetAccessControl();
 $rules=@(foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  @{sid=if ($rule.IdentityReference.Value -eq $sid) {'CURRENT_USER'} else {$rule.IdentityReference.Value}; rights=$rule.FileSystemRights.ToString(); mask=[int]$rule.FileSystemRights; type=$rule.AccessControlType.ToString(); inherited=$rule.IsInherited; inheritance=$rule.InheritanceFlags.ToString(); propagation=$rule.PropagationFlags.ToString()}
 });
 @{name=$item.FullName.Substring($root.FullName.Length); directory=($item -is [System.IO.DirectoryInfo]); owner=if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid) {'CURRENT_USER'} else {$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value}; protected=$acl.AreAccessRulesProtected; rules=$rules}
});
ConvertTo-Json -InputObject $results -Depth 6 -Compress`
  const acl = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { input: JSON.stringify(root), encoding: 'utf8', timeout: 15_000 })
  assert.equal(acl.error, undefined)
  assert.equal(acl.status, 0, acl.stderr)
  assert.throws(() => ensurePrivateDirectories([root]), /could not secure/, 'strict durable-data policy must reject Chromium capability grants')
  ensurePrivateDirectories([root], process.platform, root)
  const second = spawnSync(process.env.BMN_PROBE_ELECTRON, [fixture, root], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(second.error, undefined)
  assert.equal(second.status, 0, second.stderr)
  ensurePrivateDirectories([root], process.platform, root)
  const guard = 'passed-after-Chromium-and-restart'
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-cache-acl.json', JSON.stringify({ chromiumAclRegression: true, guard, entries: JSON.parse(acl.stdout) }, null, 2))
  console.log(JSON.stringify({ chromiumAclRegression: true, guard }))
} finally { rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
