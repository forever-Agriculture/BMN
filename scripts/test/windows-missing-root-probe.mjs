// Synthetic Windows missing-root diagnosis; never uses an owner profile.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
assert.equal(process.platform, 'win32')
const parent = mkdtempSync(join(tmpdir(), 'bmn-alias-proof-'))
try {
  const root = join(parent, 'private storage')
  ensurePrivateDirectories([root])
  const script = `$ErrorActionPreference='Stop'; $path=ConvertFrom-Json ([Console]::In.ReadToEnd());
Add-Type 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }';
$directory=New-Object System.IO.DirectoryInfo($path); $buffer=New-Object System.Text.StringBuilder(32768);
$length=[ShortPath]::GetShortPathName($directory.FullName,$buffer,32768); if ($length -eq 0 -or $length -ge 32768) { throw 'No short path' };
$short=$buffer.ToString(); $long=$directory.FullName;
$rows=@(foreach ($value in @($short,$long,[System.IO.Path]::Combine($short,'new-leaf'),[System.IO.Path]::Combine($long,'new-leaf'))) {
 $d=New-Object System.IO.DirectoryInfo($value);
 @{requested=$value; full=$d.FullName; exists=$d.Exists; parent=$d.Parent.FullName; parentExists=$d.Parent.Exists; parentReconstructed=(New-Object System.IO.DirectoryInfo($d.Parent.FullName)).FullName}
}); ConvertTo-Json -Depth 4 -Compress @{short=$short;long=$long;rows=$rows;ps=$PSVersionTable.PSVersion.ToString();clr=[System.Environment]::Version.ToString();os=[System.Environment]::OSVersion.VersionString}`
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: JSON.stringify(root), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const metadata = JSON.parse(result.stdout)
  let outcome = 'PASS'
  let guard
  const original = childProcess.spawnSync
  childProcess.spawnSync = (...args) => { const result = original(...args); guard = { status: result.status, stderr: String(result.stderr ?? '') }; return result }
  syncBuiltinESMExports()
  try { ensurePrivateDirectories([join(metadata.short, 'new-leaf')], 'win32', join(metadata.long, 'new-leaf')) } catch (error) { outcome = error.message }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports() }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-missing-root.json', JSON.stringify({ metadata, outcome, guard }, null, 2))
  console.log(JSON.stringify({ windowsMissingRoot: outcome }))
} finally { rmSync(parent, { recursive: true, force: true }) }
