// Native security acceptance on a disposable GitHub runner, never an owner machine.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Synthetic account creation is restricted to disposable CI')
const parent = mkdtempSync(join(tmpdir(), 'bmn-cross-user-'))
try {
  const root = join(parent, 'private')
  ensurePrivateDirectories([root])
  const publicFile = join(parent, 'public-fixture.txt')
  const privateFile = join(root, 'private-fixture.txt')
  writeFileSync(publicFile, 'synthetic-public')
  writeFileSync(privateFile, 'synthetic-private')
  const script = `$ErrorActionPreference='Stop'; $stage='module';
trap { [Console]::Error.WriteLine('BMN_SECURITY_TEST_STAGE='+$stage+' HRESULT='+$_.Exception.HResult); exit 1 };
$paths=ConvertFrom-Json ([Console]::In.ReadToEnd());
$stage='import-module';
Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.LocalAccounts\\Microsoft.PowerShell.LocalAccounts.psd1";
$stage='compile-fixture';
Add-Type @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CrossUser {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string user,string domain,string password,int kind,int provider,out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void Verify(string user,string password,string publicPath,string privatePath) {
  IntPtr token;
  if(!LogonUser(user,".",password,2,0,out token)) throw new Win32Exception();
  try { using(var context=WindowsIdentity.Impersonate(token)) {
   if(File.ReadAllText(publicPath)!="synthetic-public") throw new Exception("Positive control failed");
   bool read=false,write=false,delete=false;
   try { File.ReadAllText(privatePath); } catch(UnauthorizedAccessException) { read=true; }
   try { File.AppendAllText(privatePath,"forbidden"); } catch(UnauthorizedAccessException) { write=true; }
   try { File.Delete(privatePath); } catch(UnauthorizedAccessException) { delete=true; }
   if(!read||!write||!delete) throw new Exception("Synthetic private file was accessible to another account");
  }} finally { CloseHandle(token); }
 }
}
'@
$stage='public-control';
$public=New-Object System.IO.FileInfo($paths.publicFile);
$acl=$public.GetAccessControl();
$everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'Read','Allow')));
$public.SetAccessControl($acl);
$name='bmn'+[Guid]::NewGuid().ToString('N').Substring(0,10);
$password=[Guid]::NewGuid().ToString('N')+'aA9!';
$created=$false;
try {
$stage='create-account';
 $user=New-LocalUser -Name $name -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires;
 $created=$true;
$stage='group-membership';
 Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user;
$stage='impersonated-access';
 [CrossUser]::Verify($name,$password,$paths.publicFile,$paths.privateFile);
 [Console]::Out.Write('BMN_CROSS_ACCOUNT_DENIED');
} finally { if($created) { Remove-LocalUser -Name $name }; $password=$null }
`
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: JSON.stringify({ publicFile, privateFile }), encoding: 'utf8', timeout: 60000, windowsHide: true
  })
  // Keep arbitrary shell diagnostics out of receipts; no generated password is logged.
  assert.equal(result.error, undefined, 'Native account test did not finish')
  const stage = String(result.stderr ?? '').match(/BMN_SECURITY_TEST_STAGE=[a-z-]+ HRESULT=-?\d+/)?.[0] ?? 'stage unavailable'
  assert.equal(result.status, 0, `Native synthetic-account verification failed: ${stage}`)
  assert.equal(result.stdout, 'BMN_CROSS_ACCOUNT_DENIED')
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-storage-cross-user.json', JSON.stringify({ crossAccount: 'passed', positiveReadControl: true, readDenied: true, writeDenied: true, deleteDenied: true, accountRemoved: true, capabilityBearingToken: 'UNVERIFIED' }))
  console.log('PASS native ordinary-account read/write/delete denial; synthetic account removed')
} finally { rmSync(parent, { recursive: true, force: true }) }
