// MODULE: brain-bench-deletion-probe.mjs - Actual bench deletion races and process-crash recovery
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {removeOwnedDirectory} from '../lib/owned-directories.mjs'
export function probeBrainBenchDeletion(repo,{baseline=false}={}){
const harness=mkdtempSync(join(tmpdir(),'bmn-d19-bench-')),stat=lstatSync(harness)
const results=[]
try{
 const runner=join(harness,'run.mjs'),fault=join(harness,'fault.cjs')
 writeFileSync(runner,`import {readFileSync} from 'node:fs';import * as cleanup from ${JSON.stringify(repo+'/scripts/qa/bench-state.mjs')};const config=JSON.parse(readFileSync(process.argv[2],'utf8'));cleanup.deleteRoot(config);if(!${baseline}&&!cleanup.rootDeletionComplete(config))throw Error('Completion lacks deletion proof');console.log('PASS bound deletion');`)
 writeFileSync(fault,`const fs=require('node:fs'),path=require('node:path');const base=process.env.BMN126_TEST_ROOT,mode=process.env.BMN126_TEST_FAULT;if(!base||!path.basename(path.dirname(path.dirname(base))).startsWith('bmn-d19-bench-'))throw Error('Owned synthetic root required');let once=false;const rename=fs.renameSync,rm=fs.rmSync;const foreign=()=>{if(fs.existsSync(base))rename(base,base+'-retained');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'foreign'),'Foreign canary');fs.chmodSync(base,mode==='before-rm'||mode==='before-rename-writable'?0o755:0o555)};fs.renameSync=(a,b,...rest)=>{if(!once&&a===base&&(mode==='before-rename'||mode==='before-rename-writable')){once=true;foreign()}const value=rename(a,b,...rest);if(a===base&&mode==='after-rename')process.kill(process.pid,'SIGKILL');return value};fs.rmSync=(p,...rest)=>{if(!once&&(p===base||p.endsWith('/entry'))){once=true;if(mode==='before-rm')foreign();if(mode==='during-rm'){fs.unlinkSync(path.join(p,'one'));process.kill(process.pid,'SIGKILL')}const value=rm(p,...rest);if(mode==='after-rm')process.kill(process.pid,'SIGKILL');return value}return rm(p,...rest)};require('node:module').syncBuiltinESMExports();`)
 for(const mode of baseline?['before-rm']:['normal','before-rename','before-rename-writable','before-rm','after-rename','during-rm','after-rm']){
  const caseRoot=join(harness,mode);mkdirSync(caseRoot);const root=join(caseRoot,'root'),run=join(caseRoot,'run');mkdirSync(root);mkdirSync(run);writeFileSync(join(root,'.bmn-qa-run'),'synthetic');writeFileSync(join(root,'one'),'One');writeFileSync(join(root,'two'),'Two');const parent=lstatSync(caseRoot),owned=lstatSync(root),config={runId:'synthetic',run,root,tempParent:caseRoot,tempParentIdentity:{device:parent.dev,inode:parent.ino},rootIdentity:{device:owned.dev,inode:owned.ino}};const file=join(caseRoot,'config.json');writeFileSync(file,JSON.stringify(config))
  const execute=mode=>spawnSync(process.execPath,['--require',fault,runner,file],{env:{...process.env,BMN126_TEST_ROOT:root,BMN126_TEST_FAULT:mode},encoding:'utf8',timeout:10000})
  const first=execute(mode)
  if(baseline){assert.equal(first.status,0,first.stderr);assert.equal(existsSync(root),false);assert.equal(readFileSync(join(root+'-retained','one'),'utf8'),'One');results.push({mode,red:true,reason:'Original deleteRoot removed a writable foreign replacement through the public path'});continue}
  if(mode==='normal'){assert.equal(first.status,0,first.stderr);assert.ok(!existsSync(root))}
  else if((mode==='before-rename'||mode==='before-rename-writable')){
   assert.notEqual(first.status,0);const journal=JSON.parse(readFileSync(join(run,'root-deletion-intent.json'),'utf8'));assert.equal(journal.cleanup.phase,'prepared');const held=existsSync(journal.cleanup.entry)?journal.cleanup.entry:root;assert.equal(readFileSync(join(held,'foreign'),'utf8'),'Foreign canary');assert.equal(lstatSync(held).mode&0o777,mode==='before-rename-writable'?0o755:0o555);assert.equal(readFileSync(root+'-retained/one','utf8'),'One');const retry=execute('resume');assert.notEqual(retry.status,0);assert.equal(lstatSync(held).mode&0o777,mode==='before-rename-writable'?0o755:0o555)
  }else if(mode==='before-rm'){
   assert.notEqual(first.status,0);assert.equal(readFileSync(join(root,'foreign'),'utf8'),'Foreign canary');assert.equal(lstatSync(root).mode&0o777,0o755);assert.equal(JSON.parse(readFileSync(join(run,'root-deletion-intent.json'),'utf8')).cleanup.phase,'deleted')
  }else{
   assert.equal(first.signal,'SIGKILL',first.stderr);const retry=execute('resume');assert.equal(retry.status,0,retry.stderr);assert.ok(!existsSync(root));assert.equal(JSON.parse(readFileSync(join(run,'root-deletion-intent.json'),'utf8')).cleanup.phase,'deleted');assert.equal(execute('resume').status,0)
  }
  results.push({mode,pass:true})
 }
 return {ok:true,results,scope:'Actual deleteRoot, synthetic component only; no QA app/cgroup launch'}
}finally{removeOwnedDirectory(harness,{device:stat.dev,inode:stat.ino})}

}
