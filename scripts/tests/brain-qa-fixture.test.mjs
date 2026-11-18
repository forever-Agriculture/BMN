// MODULE: brain-qa-fixture.test.mjs - Guarded fixture setup and actual worker backup failure
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,statSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {prepareBrainQaFixture,releaseBrainQaFixture} from '../test/brain-qa-fixture.mjs'
import {makeOwnedDirectoriesWritable} from '../lib/owned-directories.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
it.each([false,true])('guards reservations and uses the actual worker with writable backup=%s',async writable=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-fixture-')),root=join(parent,'workload'),run=join(parent,'evidence'),runId='brain-fixture-unit'
 const stat=lstatSync(parent);let worker
 try{
  mkdirSync(root);mkdirSync(join(run,'bench'),{recursive:true});writeFileSync(join(root,'.bmn-qa-run'),runId)
  const seed=JSON.stringify({id:'brain-unit',kind:'brain-v1',...(writable?{useExportWorkspace:true,backupFailure:false}:{})})+'\n';writeFileSync(join(run,'bench/seed.json'),seed)
  const config={root,run,runId,packaged:false,qaInput:{runId,fixture:{id:'brain-unit',seedSha256:hash(seed),adapterSha256:hash(readFileSync(new URL('../test/brain-qa-fixture.mjs',import.meta.url)))}}}
  writeFileSync(join(run,'bench/seed.json'),seed+' ')
  await expect(prepareBrainQaFixture(config)).rejects.toThrow(/reserved/);expect(existsSync(join(root,'data/bmn/brain.sqlite3'))).toBe(false)
  writeFileSync(join(run,'bench/seed.json'),seed)
  const seeded=await prepareBrainQaFixture(config)
  expect(readFileSync(join(seeded.export,seeded.note+'.md'),'utf8')).toBe(seeded.markdown)
  expect(seeded.defaultCwd).toBe(writable?seeded.export:null)
  expect(statSync(seeded.export).mode&0o222).toBe(0);expect(Boolean(lstatSync(seeded.backup.path).mode&0o222)).toBe(writable)
  worker=new Worker(resolve('apps/desktop/out/main/brain-worker.js'),{workerData:{databasePath:join(root,'data/bmn/brain.sqlite3'),attachmentsRoot:join(root,'home/brain/files')}})
  let id=0
  const ask=operation=>new Promise((resolveRequest,reject)=>{worker.once('message',resolveRequest);worker.once('error',reject);worker.postMessage({id:++id,operation,args:[]})})
  expect((await ask('initialize')).error).toBeUndefined()
  const backup=await ask('scheduled-backup')
  const health=JSON.parse(readFileSync(join(root,'data/bmn/brain-health.json'),'utf8'))
  if(writable){
   expect(backup.error).toBeUndefined();expect(backup.result).toContain('nightly-')
   expect(health.backup).toBe('ok')
  }else{expect(backup.error).toBeDefined();expect(health.backup).toBe('failed')}
  await ask('close');await worker.terminate();worker=null
  releaseBrainQaFixture(config);expect(lstatSync(seeded.backup.path).mode&0o7777).toBe(seeded.backup.priorMode)
 }finally{if(worker)await worker.terminate();makeOwnedDirectoriesWritable(parent,{device:stat.dev,inode:stat.ino});rmSync(parent,{recursive:true,force:true})}
},15_000)
