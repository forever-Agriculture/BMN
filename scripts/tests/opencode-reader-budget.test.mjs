// MODULE: opencode-reader-budget.test.mjs - Real subprocess deadline and cancellation on a flat project
import assert from 'node:assert/strict'
import {test} from 'vitest'
import {execFile} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
const exec=promisify(execFile),source=fileURLToPath(new URL('../../apps/desktop/bin/opencode-project-reader.mjs',import.meta.url))
for(const mode of ['deadline','cancel'])test('flat grep obeys '+mode+' and reaps its controlled real subprocess',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-reader-budget-'))
 try{
  const program=join(root,'probe.mjs')
  writeFileSync(program,`
import assert from 'node:assert/strict';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync}from'node:fs';import{join}from'node:path';
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)},project=join(root,'project'),pids=join(root,'pids'),delay=join(root,'delay.py');mkdirSync(project);for(let i=0;i<(mode==='deadline'?10:3);i++)writeFileSync(join(project,i+'.txt'),'needle\\n');
writeFileSync(delay,'import os,sys,time\\nwith open('+JSON.stringify(pids)+',"a") as f: f.write(str(os.getpid())+"\\\\n")\\ntime.sleep(0.6)\\nos.execv("/usr/bin/grep",["grep",*sys.argv[1:]])\\n');
const sync=cp.execFileSync,async=cp.execFile;cp.execFileSync=(command,args,options)=>command==='/usr/bin/grep'?sync('/usr/bin/python3',[delay,...args],options):sync(command,args,options);cp.execFile=(command,args,options,callback)=>command==='/usr/bin/grep'?async('/usr/bin/python3',[delay,...args],options,callback):async(command,args,options,callback);syncBuiltinESMExports();
const{openProjectReader}=await import(${JSON.stringify(source)}),fds=readdirSync('/proc/self/fd').length,reader=openProjectReader(project),controller=new AbortController();const timer=mode==='cancel'?setTimeout(()=>controller.abort(),50):null;const start=performance.now();let refused=false;
try{await reader.grep('needle','.','**/*',{signal:controller.signal})}catch(error){assert.match(error.message,/BMN read-only/);refused=true}finally{clearTimeout(timer);reader.close()}
const elapsed=performance.now()-start;assert(refused,'operation must refuse rather than return late/partial results');assert(elapsed<(mode==='cancel'?1200:6000),'aggregate operation deadline exceeded');await new Promise(r=>setImmediate(r));assert.equal(readdirSync('/proc/self/fd').length,fds,'descriptors leaked');assert(existsSync(pids));for(const pid of readFileSync(pids,'utf8').trim().split('\\n').map(Number)){let gone=false;try{process.kill(pid,0)}catch(error){gone=error.code==='ESRCH'}assert(gone,'grep subprocess survived')};console.log(JSON.stringify({mode,elapsed,refused,childrenGone:true,descriptorsClosed:true}));
`)
  const result=await exec(process.execPath,[program],{timeout:12000,maxBuffer:65536})
  const row=JSON.parse(result.stdout.trim());assert.equal(row.refused,true)
 }finally{rmSync(root,{recursive:true,force:true})}
},15000)
