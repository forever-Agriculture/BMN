// Native kernel lease proof on a disposable Windows runner; no installation,
// owner profile, registry or scheduled task is changed by this acceptance gate.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable native runner required')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const root = mkdtempSync(join(tmpdir(), 'bmn-native-install-lease-'))
const worker = join(root, 'lease-worker.cjs'), output = join(root, 'result.json')
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATH'].flatMap(key => {
  const value = windowsEnvironmentValue(process.env, key)
  return value ? [[key, value]] : []
}))
env.ELECTRON_RUN_AS_NODE = '1'
env.HOME = root; env.USERPROFILE = root
env.APPDATA = join(root, 'config'); env.LOCALAPPDATA = join(root, 'data')
mkdirSync(env.APPDATA); mkdirSync(env.LOCALAPPDATA)
try {
  writeFileSync(worker, `const assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process');
const requireApp=require('node:module').createRequire(${JSON.stringify(join(repo, 'apps/desktop/package.json'))});
const native=requireApp('node-pty/lib/utils').loadNativeModule('conpty').module;
assert.equal(native.bmnInstallLeaseVersion,1);
const lock=${JSON.stringify(join(root, 'run.lock'))},output=${JSON.stringify(output)};
if(process.argv.includes('--hold')){global.lease=native.acquireInstallLease(lock,false);process.stdout.write('READY\\n');setInterval(()=>{},1000)}
else{const nativeProcessTrace=[];
 const cp=require('node:child_process'),originalSpawnSync=cp.spawnSync;
 cp.spawnSync=(exe,args,options)=>{const started=Date.now(),encoded=args.indexOf('-EncodedCommand');
  if(encoded!==-1){let source=Buffer.from(args[encoded+1],'base64').toString('utf16le');
   for(const marker of ["$request = ConvertFrom-Json", "$directories = @", "for ($rootIndex = 0;", "  Assert-SafeAncestors $directory", "  if (-not $directory.Exists)", "  $actual = $directory.GetAccessControl()", "  while ($pending.Count -gt 0)"]){
    if(!source.includes(marker))throw new Error('Private-directory phase marker changed: '+marker);
    source=source.split(marker).join("[Console]::Error.WriteLine('"+('BMN_LEASE_PHASE '+marker).replaceAll("'","''")+"');\\n"+marker)}
   args=[...args];args[encoded+1]=Buffer.from(source,'utf16le').toString('base64')}
  const result=originalSpawnSync(exe,args,options);
  nativeProcessTrace.push({elapsedMs:Date.now()-started,argumentBytes:args.reduce((n,arg)=>n+Buffer.byteLength(arg,'utf16le'),0),status:result.status,signal:result.signal,
   launchError:result.error?.code??null,stdout:String(result.stdout??'').slice(-4096),stderr:String(result.stderr??'').slice(-4096)});return result};
 require('node:module').syncBuiltinESMExports();
 (async()=>{
 const checks=[],children=[];let shared,exclusive;
 const privateDirectories=await import(${JSON.stringify(new URL('../../apps/desktop/src/utility/private-directory.ts', import.meta.url).href)});
 const busy=fn=>assert.throws(fn,e=>e.windowsError===32);
 const check=(name,fn)=>{fn();checks.push({name,status:'PASS'})};
 try{
  native.protectApplicationLifetime();
  shared=native.acquireInstallLease(lock,false);
  check('same-process shared lease blocks exclusive update',()=>busy(()=>native.acquireInstallLease(lock,true)));
  const child=spawn(process.execPath,[__filename,'--hold'],{env:process.env,stdio:['ignore','pipe','pipe']});children.push(child);
  const exit=new Promise(resolve=>child.once('exit',resolve));let text='',stderr='';child.stderr.on('data',d=>stderr+=d);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Shared lease child did not become ready: '+stderr)),10000);
   child.once('error',e=>{clearTimeout(timer);reject(e)});child.stdout.on('data',d=>{text+=d;if(text.includes('READY')){clearTimeout(timer);resolve()}});
   child.once('exit',()=>{clearTimeout(timer);if(!text.includes('READY'))reject(new Error('Shared child exited: '+stderr))})});
  shared.close();shared=undefined;
  check('other process retains startup lease after caller closes its handle',()=>busy(()=>native.acquireInstallLease(lock,true)));
  child.kill('SIGKILL');await exit;
  exclusive=native.acquireInstallLease(lock,true);
  check('crash releases only the terminated child lease',()=>busy(()=>native.acquireInstallLease(lock,false)));
  exclusive.close();exclusive=undefined;
  shared=native.acquireInstallLease(lock,false);shared.close();shared=undefined;
  checks.push({name:'new startup acquires after completed update',status:'PASS'});
  const foreign=${JSON.stringify(join(root, 'inherited.lock'))};fs.writeFileSync(foreign,'');
  check('inherited or foreign security is refused without adoption',()=>assert.throws(()=>native.acquireInstallLease(foreign,false),/security/));
  const link=${JSON.stringify(join(root, 'linked.lock'))};fs.linkSync(lock,link);
  check('hard-linked lease is refused',()=>assert.throws(()=>native.acquireInstallLease(lock,false),/ordinary/));
  fs.unlinkSync(link);
  const protectedRoot=${JSON.stringify(join(root, 'protected'))};
  privateDirectories.provisionPrivateDirectories([protectedRoot],'win32');
  let rootLease,dataLease;
  try {
   rootLease=native.acquireInstallLease(require('node:path').join(protectedRoot,'run.lock'),true);
   dataLease=native.acquireInstallLease(require('node:path').join(protectedRoot,'update.lock'),true);
   check('full ACL scan remains available while private kernel lock handles are held',()=>privateDirectories.ensurePrivateDirectories([protectedRoot],'win32'));
  } finally {dataLease?.close();rootLease?.close();}

  fs.writeFileSync(output,JSON.stringify({status:'PASS',platform:process.platform,checks,nativeProcessTrace}));
 }finally{shared?.close();exclusive?.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve))}}
})().catch(error=>{fs.writeFileSync(output,JSON.stringify({status:'FAIL',name:error.name,message:error.message,nativeProcessTrace}));process.exitCode=1})}
`)
  const child = spawn(requireApp('electron'), [worker], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''; child.stderr.on('data', part => { stderr += part })
  child.stdout.resume()
  const exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const code = await exit.finally(() => clearTimeout(timer))
  const receipt = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { status: 'FAIL', message: stderr.slice(-4000) }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-install-leases.json', JSON.stringify(receipt, null, 2))
  assert.equal(code, 0, stderr); assert.equal(receipt.status, 'PASS')
  console.log(JSON.stringify(receipt))
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
