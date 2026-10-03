// Exercise real bundled ConPTY backpressure and bounded Stop, never owner sessions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
assert.equal(process.platform, 'win32')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const root = mkdtempSync(join(tmpdir(), 'bmn-pty-pressure-'))
try {
  const host = join(root, 'host.cjs')
  writeFileSync(host, `const assert=require('node:assert/strict'),fs=require('node:fs');
const pty=require(${JSON.stringify(requireApp.resolve('node-pty'))});
const [node,root]=process.argv.slice(2),rows=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=8000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('PTY pressure timeout');await delay(20)}}
const options={cwd:root,env:{...process.env},cols:80,rows:24,useConpty:true,useConptyDll:true};
(async()=>{
 for(const mode of ['drain','paused-stop']){
  let bytes=0,exit,error; const before=process.memoryUsage().rss;
  const program="const chunk='x'.repeat(32768);function pump(){while(process.stdout.write(chunk)){};process.stdout.once('drain',pump)};pump()";
  const terminal=pty.spawn(node,['-e',program],options);
  terminal.onData(data=>{bytes+=Buffer.byteLength(data)});terminal.onExit(value=>exit=value);terminal.onLifecycleError(value=>error=value);
  try{
   await waitFor(()=>bytes>=65536);
   if(mode==='paused-stop')terminal.pause();
   const startedBytes=bytes;await delay(1000);
   if(mode==='paused-stop')assert.equal(bytes,startedBytes,'Paused output still delivered');
   const growth=process.memoryUsage().rss-before;
   assert.ok(growth<64*1024*1024,'Output pressure grew host RSS by 64MiB');
   const stopStarted=Date.now();terminal.kill();await waitFor(()=>exit||error);
   assert.equal(error,undefined);assert.equal(exit.exitCode,1);
   rows.push({mode,bytes,rssGrowthBytes:growth,stopMs:Date.now()-stopStarted,exit});
  }finally{if(!exit)terminal.kill()}
 }
 // Repeated immediate exits exercise callback registration and output-EOF races.
 for(let i=0;i<8;i++){
  let exit,error;const started=Date.now();const terminal=pty.spawn(node,['-e','process.exit(47)'],options);
  terminal.onData(()=>{});terminal.onExit(value=>exit=value);terminal.onLifecycleError(value=>error=value);
  try{await waitFor(()=>exit||error);assert.equal(error,undefined);assert.equal(exit.exitCode,47);rows.push({mode:'immediate',iteration:i,elapsedMs:Date.now()-started,exit})}
  finally{if(!exit)terminal.kill()}
 }
 // Native startup failures must unwind their pipes/workers and leave subsequent
 // launches usable. The external controller also bounds the host's final exit.
 for(let i=0;i<4;i++){
  assert.throws(()=>pty.spawn(root+'/missing-program.exe',[],options),/Create atomically owned terminal process/);
  assert.throws(()=>pty.spawn(node,[],{...options,cwd:root+'/missing-directory'}),/Create atomically owned terminal process/);
  rows.push({mode:'failed-start',iteration:i,missingProgram:true,missingDirectory:true});
 }
 fs.writeFileSync(root+'/receipt.json',JSON.stringify(rows));
})().catch(error=>{console.error(error);process.exitCode=1});
`)
  const result = spawnSync(requireApp('electron'), [host, process.execPath, root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 100000, windowsHide: true
  })
  mkdirSync(join(repo, 'test-results'), { recursive: true })
  const receipt = { status: result.status, error: result.error?.message, stderr: result.stderr,
    observations: (() => { try { return JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8')) } catch { return [] } })() }
  writeFileSync(join(repo, 'test-results/windows-pty-pressure.json'), JSON.stringify(receipt, null, 2))
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(receipt.observations.length, 14)
  console.log('PASS native output pressure, paused Stop and immediate-exit races')
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
