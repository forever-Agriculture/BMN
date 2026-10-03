// Native security acceptance on a disposable GitHub runner, never an owner machine.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Synthetic account creation is restricted to disposable CI')
const parent = mkdtempSync(join(tmpdir(), 'bmn-cross-user-'))
const pipeFlag = process.argv.indexOf('--pipes')
const pipes = pipeFlag < 0 ? [] : JSON.parse(readFileSync(process.argv[pipeFlag + 1], 'utf8'))
assert.ok(Array.isArray(pipes) && pipes.every(pipe => typeof pipe === 'string' && pipe.startsWith('\\\\.\\pipe\\bmn-conpty-')))
try {
  const root = join(parent, 'private')
  ensurePrivateDirectories([root])
  const publicFile = join(parent, 'public-fixture.txt')
  const privateFile = join(root, 'private-fixture.txt')
  const foreignStaging = join(parent, 'foreign-staging')
  mkdirSync(foreignStaging)
  const foreignFile = join(foreignStaging, 'foreign-owned.txt')
  writeFileSync(publicFile, 'synthetic-public')
  writeFileSync(privateFile, 'synthetic-private')
  const script = `$ErrorActionPreference='Stop'; $stage='module';
trap { [Console]::Error.WriteLine('BMN_SECURITY_TEST_STAGE='+$stage+' HRESULT='+$_.Exception.HResult); exit 1 };
$paths=ConvertFrom-Json ([Console]::In.ReadToEnd());
$stage='compile-fixture';
Add-Type @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CrossUser {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct UserInfo {
  public string name; public string password; public uint passwordAge; public uint privilege;
  public string home; public string comment; public uint flags; public string script;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MemberInfo { public string name; }
 [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserAdd(string server,uint level,ref UserInfo info,out uint parameter);
 [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserDel(string server,string user);
 [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetLocalGroupAddMembers(string server,string group,uint level,ref MemberInfo info,uint count);
 public static void Create(string name,string password) {
  var info=new UserInfo {name=name,password=password,privilege=1,flags=0x201}; uint parameter;
  uint status=NetUserAdd(null,1,ref info,out parameter);
  if(status!=0) throw new Win32Exception((int)status);
 }
 public static void JoinUsers(string name) {
  string group=new SecurityIdentifier("S-1-5-32-545").Translate(typeof(NTAccount)).Value;
  group=group.Substring(group.LastIndexOf((char)92)+1);
  var member=new MemberInfo {name=Environment.MachineName+(char)92+name};
  uint status=NetLocalGroupAddMembers(null,group,3,ref member,1);
  if(status!=0) throw new Win32Exception((int)status);
 }
 public static void Delete(string name) {
  uint status=NetUserDel(null,name); if(status!=0) throw new Win32Exception((int)status);
 }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string user,string domain,string password,int kind,int provider,out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 public static void PipeAccess(string[] paths,bool denied) {
  foreach(string path in paths) {
   IntPtr handle=CreateFile(path,0xC0000000,0,IntPtr.Zero,3,0,IntPtr.Zero);
   int error=Marshal.GetLastWin32Error();
   if(handle!=new IntPtr(-1)) { CloseHandle(handle); if(denied) throw new Exception("Private terminal pipe accepted another account"); }
   else if(!denied || error!=5) throw new Win32Exception(error);
  }
 }
 public static void VerifyPipes(string user,string password,string[] paths) {
  IntPtr token;
  if(!LogonUser(user,".",password,3,0,out token)) throw new Win32Exception();
  try { using(var context=WindowsIdentity.Impersonate(token)) { PipeAccess(paths,true); } }
  finally { CloseHandle(token); }
  // Positive control after the denied attempts: these are live, connectable pipes.
  PipeAccess(paths,false);
 }
 public static void CreateForeignFile(string user,string password,string path) {
  IntPtr token;
  if(!LogonUser(user,".",password,3,0,out token)) throw new Win32Exception();
  try { using(var context=WindowsIdentity.Impersonate(token)) {
   File.WriteAllText(path,"synthetic-foreign-owned");
   if(File.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)).Value!=WindowsIdentity.GetCurrent().User.Value)
    throw new Exception("Foreign-owner positive control failed");
  }} finally { CloseHandle(token); }
 }
 public static void Verify(string user,string password,string publicPath,string privatePath) {
  IntPtr token;
  if(!LogonUser(user,".",password,3,0,out token)) throw new Win32Exception();
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
$staging=New-Object System.IO.DirectoryInfo($paths.foreignStaging);
$acl=$staging.GetAccessControl();
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'FullControl','ContainerInherit, ObjectInherit','None','Allow')));
$staging.SetAccessControl($acl);
$name='bmn'+[Guid]::NewGuid().ToString('N').Substring(0,10);
$password=[Guid]::NewGuid().ToString('N')+'aA9!';
$created=$false;
try {
$stage='create-account';
 [CrossUser]::Create($name,$password);
 $created=$true;
$stage='group-membership';
 [CrossUser]::JoinUsers($name);
$stage='impersonated-access';
 [CrossUser]::Verify($name,$password,$paths.publicFile,$paths.privateFile);
 $stage='foreign-owner';
 [CrossUser]::CreateForeignFile($name,$password,$paths.foreignFile);
 # Leave an otherwise acceptable ACL, so rejection specifically tests ownership.
 $foreign=New-Object System.IO.FileInfo($paths.foreignFile);
 $acl=$foreign.GetAccessControl();
 $foreignOwner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
 $acl.SetAccessRuleProtection($true,$false);
 foreach($rule in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) { $null=$acl.RemoveAccessRuleSpecific($rule) };
 $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current,'FullControl','Allow')));
 $foreign.SetAccessControl($acl);
 if($foreign.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $foreignOwner) { throw 'Foreign ownership changed during fixture preparation' };
 if($paths.pipes.Count -gt 0) {
  $stage='private-pipes';
  [CrossUser]::VerifyPipes($name,$password,[string[]]$paths.pipes);
 }
 [Console]::Out.Write('BMN_CROSS_ACCOUNT_DENIED');
} finally { if($created) { [CrossUser]::Delete($name) }; $password=$null }
`
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: JSON.stringify({ publicFile, privateFile, foreignStaging, foreignFile, pipes }), encoding: 'utf8', timeout: 60000, windowsHide: true
  })
  // Keep arbitrary shell diagnostics out of receipts; no generated password is logged.
  assert.equal(result.error, undefined, 'Native account test did not finish')
  const stage = String(result.stderr ?? '').match(/BMN_SECURITY_TEST_STAGE=[a-z-]+ HRESULT=-?\d+/)?.[0] ?? 'stage unavailable'
  assert.equal(result.status, 0, `Native synthetic-account verification failed: ${stage}`)
  assert.equal(result.stdout, 'BMN_CROSS_ACCOUNT_DENIED')
  // Same-volume rename retains the original owner. The real storage guard must
  // refuse this foreign-owned descendant rather than silently take it over.
  const movedForeignFile = join(root, 'foreign-owned.txt')
  renameSync(foreignFile, movedForeignFile)
  assert.throws(() => ensurePrivateDirectories([root]), /could not secure/)
  assert.equal(readFileSync(movedForeignFile, 'utf8'), 'synthetic-foreign-owned')
  mkdirSync('test-results', { recursive: true })
  writeFileSync(`test-results/${pipes.length ? 'windows-pty-pipes' : 'windows-storage-cross-user'}.json`, JSON.stringify({ crossAccount: 'passed', positiveReadControl: true, readDenied: true, writeDenied: true, deleteDenied: true, foreignOwnerRefused: true, foreignDataPreserved: true, accountRemoved: true, privatePipesDenied: pipes.length, ownerPipePositiveControl: pipes.length > 0, capabilityBearingToken: 'UNVERIFIED' }))
  console.log('PASS native ordinary-account read/write/delete denial; synthetic account removed')
} finally { rmSync(parent, { recursive: true, force: true }) }
