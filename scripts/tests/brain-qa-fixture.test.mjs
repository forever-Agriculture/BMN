// MODULE: brain-qa-fixture.test.mjs - Guarded fixture setup and actual worker backup failure
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,lstatSync,statSync,rmSync} from 'node:fs'
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
it('refuses the owner real roots through a symbolic link or .. as well (pre-review)',async()=>{
 const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
 const {homedir}=await import('node:os')
 const {symlinkSync}=await import('node:fs')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-alias-'))
 try{
  symlinkSync(join(homedir(),'.local'),join(parent,'alias'))
  await expect(seedSwitchedBrain({dataRoot:join(parent,'alias/share/bmn-never'),stateRoot:join(parent,'s'),notes:[]})).rejects.toThrow(/non-test root/)
  await expect(seedSwitchedBrain({dataRoot:`${parent}/../../..${homedir()}/.config/bmn-never`,stateRoot:join(parent,'s'),notes:[]})).rejects.toThrow(/non-test root/)
  expect(existsSync(join(homedir(),'.local/share/bmn-never'))).toBe(false)
 }finally{rmSync(parent,{recursive:true,force:true})}
})
it('needs fresh fixture destinations: an existing journal or a redirected folder is refused before any write (review)',async()=>{
 const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
 const {symlinkSync}=await import('node:fs')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-dest-'))
 try{
  mkdirSync(join(parent,'state/brain-cutover'),{recursive:true});writeFileSync(join(parent,'state/brain-cutover/journal.json'),'{"state":"keep"}')
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state'),notes:[]})).rejects.toThrow(/fresh destination/)
  expect(readFileSync(join(parent,'state/brain-cutover/journal.json'),'utf8')).toBe('{"state":"keep"}')
  expect(existsSync(join(parent,'data'))).toBe(false)
  mkdirSync(join(parent,'elsewhere'));mkdirSync(join(parent,'state2'));symlinkSync(join(parent,'elsewhere'),join(parent,'state2/brain-cutover'))
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data2'),stateRoot:join(parent,'state2'),notes:[]})).rejects.toThrow(/fresh destination|redirected/)
  expect(readdirSync(join(parent,'elsewhere'))).toEqual([])
 }finally{rmSync(parent,{recursive:true,force:true})}
})
it('seeds the dense brain with 1,000 notes and 3,000 distinct stored links (review)',async()=>{
 const {seedSwitchedBrain,denseNotes}=await import('../test/brain-page-fixture.mjs')
 const {createRequire}=await import('node:module')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-dense-')),stat=lstatSync(parent)
 try{
  const seeded=await seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state'),notes:denseNotes(),withdraw:[]})
  expect(seeded.notes).toBe(1000)
  const SQLite=createRequire(resolve('apps/desktop/package.json'))('better-sqlite3'),db=new SQLite(seeded.databasePath,{readonly:true})
  try{expect(db.prepare("SELECT count(*) n FROM brain_link WHERE kind='note' AND resolved IS NOT NULL").get().n).toBe(3000)}finally{db.close()}
 }finally{makeOwnedDirectoriesWritable(parent,{device:stat.dev,inode:stat.ino});rmSync(parent,{recursive:true,force:true})}
},60_000)
it('refuses a redirected root and a dangling link at the database before making anything (recheck 8)',async()=>{
 const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
 const {symlinkSync}=await import('node:fs')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-root-'))
 try{
  mkdirSync(join(parent,'elsewhere'));symlinkSync(join(parent,'elsewhere'),join(parent,'state'))
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state'),notes:[]})).rejects.toThrow(/redirected/)
  expect(readdirSync(join(parent,'elsewhere'))).toEqual([]);expect(existsSync(join(parent,'data'))).toBe(false)
  mkdirSync(join(parent,'data2'));symlinkSync(join(parent,'nowhere'),join(parent,'data2/brain.sqlite3'))
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data2'),stateRoot:join(parent,'state2'),notes:[]})).rejects.toThrow(/fresh destination/)
  expect(existsSync(join(parent,'state2'))).toBe(false);expect(existsSync(join(parent,'nowhere'))).toBe(false)
 }finally{rmSync(parent,{recursive:true,force:true})}
})
it('refuses a dangling link at the state root before making the data root (recheck 2, finding 8)',async()=>{
 const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
 const {symlinkSync}=await import('node:fs')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-dangling-'))
 try{
  symlinkSync(join(parent,'nowhere'),join(parent,'state'))
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state'),notes:[]})).rejects.toThrow(/redirected/)
  expect(existsSync(join(parent,'data'))).toBe(false);expect(existsSync(join(parent,'nowhere'))).toBe(false)
  expect(readdirSync(parent).sort()).toEqual(['state'])
 }finally{rmSync(parent,{recursive:true,force:true})}
})

it('refuses a file where a root folder should be before making the data root (review 2026-11-20)',async()=>{
 const {seedSwitchedBrain}=await import('../test/brain-page-fixture.mjs')
 const parent=mkdtempSync(join(tmpdir(),'bmn-brain-file-root-'))
 try{
  writeFileSync(join(parent,'state'),'not a folder')
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state'),notes:[]})).rejects.toThrow(/blocked/)
  await expect(seedSwitchedBrain({dataRoot:join(parent,'data'),stateRoot:join(parent,'state','inner'),notes:[]})).rejects.toThrow(/blocked/)
  expect(readdirSync(parent).sort()).toEqual(['state'])
 }finally{rmSync(parent,{recursive:true,force:true})}
})
