// MODULE: brain-backup-health.test.mjs - Kill the actual worker after durable schedule success and before Health publication
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,symlinkSync,lstatSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {it,expect} from 'vitest'
import {removeOwnedDirectory} from '../lib/owned-directories.mjs'
const repo=resolve(import.meta.dirname,'../..'),require=createRequire(join(repo,'apps/desktop/package.json')),compiler=createRequire(require.resolve('vite'))('esbuild')
it.skipIf(process.platform!=='linux')('reconciles exactly the resolved backup failure after a real crash, preserving a newer failure through skip and private success',()=>{
 const harness=mkdtempSync(join(tmpdir(),'bmn-d19-health-')),stat=lstatSync(harness),root=join(harness,'draft-data'),entry=join(harness,'worker.cjs'),control=join(harness,'control.cjs'),preload=join(harness,'fault.cjs')
 try{
  symlinkSync(join(repo,'apps/desktop/node_modules'),join(harness,'node_modules'),'dir');mkdirSync(root);mkdirSync(join(root,'files'))
  compiler.buildSync({entryPoints:[join(repo,'apps/desktop/src/utility/brain-worker.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  writeFileSync(control,"const {Worker}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path');const [entry,root,mode,preload]=process.argv.slice(2),worker=new Worker(entry,{workerData:{databasePath:path.join(root,'brain.sqlite3'),attachmentsRoot:path.join(root,'files')},...(mode==='crash'?{execArgv:['--require',preload]}:{})});const pending=new Map();let next=0;worker.on('message',r=>{const p=pending.get(r.id);pending.delete(r.id);if(r.error)p.reject(Error(r.error.message));else p.resolve(r.result)});worker.on('error',e=>{console.error(e);process.exit(1)});const ask=(operation,args=[])=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});worker.postMessage({id,operation,args})});(async()=>{await ask('initialize');if(mode==='private')await ask('backup');const result=await ask('scheduled-backup',['2026-01-05T04:00:00Z']);const health=JSON.parse(fs.readFileSync(path.join(root,'brain-health.json'),'utf8'));await ask('close');await worker.terminate();console.log(JSON.stringify({result,health}));})().catch(e=>{console.error(e);process.exit(1)});")
  writeFileSync(preload,"const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_HEALTH_ROOT;if(!root||!path.basename(path.dirname(root)).startsWith('bmn-d19-health-'))throw Error('Owned synthetic health root required');let marker=false;const rename=fs.renameSync;fs.renameSync=(a,b,...args)=>{const r=rename(a,b,...args);if(b===path.join(root,'brain-backups/schedule.json'))marker=true;return r};const sync=fs.fsyncSync;fs.fsyncSync=fd=>{const r=sync(fd);if(marker&&fs.readlinkSync('/proc/self/fd/'+fd)===path.join(root,'brain-backups')){fs.writeFileSync(path.join(root,'interrupted.json'),JSON.stringify({after:'schedule marker parent fsync',marker:JSON.parse(fs.readFileSync(path.join(root,'brain-backups/schedule.json'),'utf8'))}));process.kill(process.pid,'SIGKILL')}return r};require('node:module').syncBuiltinESMExports();")
  const prior={backup:'failed',export:'ok',checkedAt:'2026-01-04T00:00:00Z',backupFailureAt:'2026-01-04T00:00:00Z',backupFailureId:'11111111-1111-4111-8111-111111111111'}
  writeFileSync(join(root,'brain-health.json'),JSON.stringify(prior))
  const run=mode=>spawnSync(process.execPath,[control,entry,root,mode,preload],{env:{...process.env,BMN126_HEALTH_ROOT:root},encoding:'utf8',timeout:10_000})
  const crashed=run('crash');expect(crashed.signal,crashed.stderr).toBe('SIGKILL')
  expect(JSON.parse(readFileSync(join(root,'interrupted.json'),'utf8'))).toMatchObject({after:'schedule marker parent fsync',marker:{version:2,resolvesFailure:prior.backupFailureId}})
  const count=()=>readdirSync(join(root,'brain-backups')).filter(name=>/^(nightly|weekly)-/.test(name)).length,before=count()
  const recovered=run('restart');expect(recovered.status,recovered.stderr).toBe(0)
  const value=JSON.parse(recovered.stdout);expect(value.result).toBeNull();expect(value.health.backup).toBe('ok');expect(value.health.backupFailureId).toBeUndefined();expect(count()).toBe(before)
  const newer={...prior,backupFailureId:'22222222-2222-4222-8222-222222222222',backupFailureAt:'2026-01-06T00:00:00Z'}
  writeFileSync(join(root,'brain-health.json'),JSON.stringify(newer));const skipped=run('private');expect(skipped.status,skipped.stderr).toBe(0)
  expect(JSON.parse(skipped.stdout)).toMatchObject({result:null,health:{backup:'failed',backupFailureId:newer.backupFailureId,backupFailureAt:newer.backupFailureAt}})
  expect(count()).toBe(before)
 }finally{removeOwnedDirectory(harness,{device:stat.dev,inode:stat.ino})}
})
