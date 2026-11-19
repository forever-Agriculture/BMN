// MODULE: brain-qa-fixture.test.mjs - Guarded fixture setup and actual worker backup failure
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,statSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {brainQaAdapterBytes,prepareBrainQaFixture,releaseBrainQaFixture} from '../test/brain-qa-fixture.mjs'
import {makeOwnedDirectoriesWritable} from '../lib/owned-directories.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
it.each([false,true])('guards reservations and uses the actual worker with writable backup=%s',async writable=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-fixture-')),root=join(parent,'workload'),run=join(parent,'evidence'),runId='brain-fixture-unit'
 const stat=lstatSync(parent);let worker
 try{
  mkdirSync(root);mkdirSync(join(run,'bench'),{recursive:true});writeFileSync(join(root,'.bmn-qa-run'),runId)
  const seed=JSON.stringify({id:'brain-unit',kind:'brain-v1',...(writable?{useExportWorkspace:true,backupFailure:false}:{})})+'\n';writeFileSync(join(run,'bench/seed.json'),seed)
  const config={root,run,runId,packaged:false,qaInput:{runId,fixture:{id:'brain-unit',seedSha256:hash(seed),adapterSha256:hash(brainQaAdapterBytes())}}}
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
it('seeds a switched synthetic brain with linked notes for the Brain page (Epic 128)',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-fixture-')),root=join(parent,'workload'),run=join(parent,'evidence'),runId='brain-fixture-linked'
 const stat=lstatSync(parent);let worker
 try{
  mkdirSync(root);mkdirSync(join(run,'bench'),{recursive:true});writeFileSync(join(root,'.bmn-qa-run'),runId)
  const seed=JSON.stringify({id:'brain-page',kind:'brain-v1',notes:'linked-switched',viewport:'brain-wide'})+'\n';writeFileSync(join(run,'bench/seed.json'),seed)
  const config={root,run,runId,packaged:false,qaInput:{runId,fixture:{id:'brain-page',seedSha256:hash(seed),adapterSha256:hash(brainQaAdapterBytes())}}}
  const seeded=await prepareBrainQaFixture(config)
  expect(seeded).toMatchObject({switched:true,notes:12})
  const journal=join(root,'state/bmn/brain-cutover/journal.json')
  expect(JSON.parse(readFileSync(journal,'utf8'))).toMatchObject({state:'complete',delivered:true})
  worker=new Worker(resolve('apps/desktop/out/main/brain-worker.js'),{workerData:{databasePath:join(root,'data/bmn/brain.sqlite3'),attachmentsRoot:join(root,'home/brain/files'),cutoverJournal:journal}})
  let id=0
  const ask=(operation,args=[])=>new Promise((resolveRequest,reject)=>{worker.once('message',resolveRequest);worker.once('error',reject);worker.postMessage({id:++id,operation,args})})
  expect((await ask('admission-status')).result.committed).toBe(true)
  const list=(await ask('page-list',[{}])).result
  expect(list).toMatchObject({total:10,withdrawn:1})
  const plan=list.notes.find(note=>note.title==='Backup plan')
  expect((await ask('page-read',[plan.id])).result.linksTo.length).toBeGreaterThan(3)
  await ask('close');await worker.terminate();worker=null
  releaseBrainQaFixture(config);expect(lstatSync(seeded.backup.path).mode&0o7777).toBe(seeded.backup.priorMode)
  // The fixture refuses the owner's real roots.
  const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
  const {homedir}=await import('node:os')
  await expect(seedSwitchedBrain({dataRoot:join(homedir(),'.local/share/bmn'),stateRoot:join(parent,'s'),notes:[]})).rejects.toThrow(/non-test root/)
 }finally{if(worker)await worker.terminate();makeOwnedDirectoriesWritable(parent,{device:stat.dev,inode:stat.ino});rmSync(parent,{recursive:true,force:true})}
},20_000)
