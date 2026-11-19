// MODULE: brain-qa-fixture.mjs - Reserved synthetic brain data for lead-run bench QA
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {chmodSync,closeSync,constants,existsSync,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {atomicJson} from '../qa/bench-lib.mjs'
import {linkedNotes,seedSwitchedBrain} from './brain-page-fixture.mjs'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
/** The reserved adapter: this file and the Brain page fixture it seeds with (Epic 128). */
export const brainQaAdapterBytes=()=>Buffer.concat([readFileSync(fileURLToPath(import.meta.url)),readFileSync(fileURLToPath(new URL('./brain-page-fixture.mjs',import.meta.url)))])
function reserved(config){
 if(!config.qaInput)return false
 const bytes=readFileSync(join(config.run,'bench/seed.json')),seed=JSON.parse(bytes)
 if(seed.kind!=='brain-v1')return false
 if(config.packaged)throw new Error('The brain QA fixture requires the reserved source build')
 if(realpathSync(config.root)!==config.root||readFileSync(join(config.root,'.bmn-qa-run'),'utf8')!==config.runId||
  config.qaInput.runId!==config.runId||hash(bytes)!==config.qaInput.fixture.seedSha256||
  hash(brainQaAdapterBytes())!==config.qaInput.fixture.adapterSha256)throw new Error('Brain QA fixture differs from its reserved root, seed or adapter')
 return true
}
/** Data is seeded before QA starts, using the candidate's actual worker. No Brain IPC is replaced. */
export async function prepareBrainQaFixture(config){
 if(!reserved(config))return null
 const seed=JSON.parse(readFileSync(join(config.run,'bench/seed.json'),'utf8'))
 if(seed.backupFailure!==undefined&&typeof seed.backupFailure!=='boolean')throw new Error('Invalid brain backup fixture')
 if(seed.useExportWorkspace!==undefined&&typeof seed.useExportWorkspace!=='boolean')throw new Error('Invalid brain workspace fixture')
 if(seed.clockStart!==undefined)throw new Error('A brain clock fixture is not supported by this bench')
 if(seed.notes!==undefined&&seed.notes!=='linked-switched')throw new Error('Unknown brain notes fixture')
 const data=join(config.root,'data/bmn'),databasePath=join(data,'brain.sqlite3'),attachments=join(config.root,'home/brain/files')
 if(existsSync(databasePath))throw new Error('Brain QA requires a fresh synthetic database')
 // Epic 128: a switched synthetic brain with linked notes, every status and a name not in the brain, for the Brain page.
 if(seed.notes==='linked-switched'){
  const seeded=await seedSwitchedBrain({dataRoot:data,stateRoot:join(config.root,'state/bmn'),notes:linkedNotes()})
  const backup=join(data,'brain-backups'),stat=lstatSync(backup)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Brain QA backup fixture is not its own directory')
  const installed={version:1,runId:config.runId,id:config.qaInput.fixture.id,notes:seeded.notes,switched:true,defaultCwd:null,
   backup:{path:backup,device:stat.dev,inode:stat.ino,priorMode:stat.mode&0o7777}}
  atomicJson(join(config.run,'bench/brain-seed-install.json'),installed)
  if(JSON.stringify(JSON.parse(readFileSync(join(config.run,'bench/brain-seed-install.json'),'utf8')))!==JSON.stringify(installed))throw new Error('Brain QA seed read-back failed')
  return installed
 }
 mkdirSync(attachments,{recursive:true,mode:0o700})
 const entry=join(repo,'apps/desktop/out/main/brain-worker.js');if(!lstatSync(entry).isFile())throw new Error('The reserved built brain worker is missing')
 const worker=new Worker(entry,{workerData:{databasePath,attachmentsRoot:attachments}})
 const pending=new Map();let sequence=0,failure=null,closing=false
 worker.on('message',value=>{const request=pending.get(value.id);if(!request)return;pending.delete(value.id);clearTimeout(request.timer);if(value.error)request.reject(new Error(value.error.message));else request.resolve(value.result)})
 const failed=error=>{failure=error;for(const request of pending.values()){clearTimeout(request.timer);request.reject(error)}pending.clear()}
 worker.on('error',failed)
 worker.on('exit',code=>{if(!closing)failed(new Error('Brain QA worker exited '+code))})
 const request=(operation,args=[])=>failure?Promise.reject(failure):new Promise((resolveRequest,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Brain QA worker timed out'))},10_000)
  pending.set(id,{resolve:resolveRequest,reject,timer});worker.postMessage({id,operation,args})
 })
 try{
  await request('initialize')
  const markdown='# Synthetic preference\n\nUse short, concrete explanations.\n\n## Example\nAn example for the isolated bench.\n'
  await request('import',[[{source:'qa/synthetic-preference.md',title:'Synthetic preference',kind:'preference',origin:'import',scope:'all',markdown,status:'active',source_time:'2026-01-01T00:00:00.000Z'}]])
  const folder=await request('export'),notes=await request('list'),note=notes.find(item=>item.title==='Synthetic preference')
  if(!note||readFileSync(join(folder,note.id+'.md'),'utf8')!==markdown)throw new Error('Brain QA seed export differs from its fixture')
  const backup=join(data,'brain-backups'),stat=lstatSync(backup)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Brain QA backup fixture is not its own directory')
  const installed={version:1,runId:config.runId,id:config.qaInput.fixture.id,note:note.id,title:note.title,markdown,export:folder,defaultCwd:seed.useExportWorkspace?folder:null,
   backup:{path:backup,device:stat.dev,inode:stat.ino,priorMode:stat.mode&0o7777}}
  // Teardown knows the exact inode before it is made unwritable, including a startup failure.
  atomicJson(join(config.run,'bench/brain-seed-install.json'),installed)
  if(JSON.stringify(JSON.parse(readFileSync(join(config.run,'bench/brain-seed-install.json'),'utf8')))!==JSON.stringify(installed))throw new Error('Brain QA seed read-back failed')
  if(seed.backupFailure!==false)chmodSync(backup,0o500)
  return installed
 }finally{closing=true;try{if(!failure)await request('close')}finally{await worker.terminate()}}
}
/** Restore only this fixture's owned directory so the normal bench root cleanup can remove it. */
export function releaseBrainQaFixture(config){
 if(!reserved(config))return
 const receipt=join(config.run,'bench/brain-seed-install.json')
 if(!existsSync(receipt))return
 const record=JSON.parse(readFileSync(receipt,'utf8')),path=join(config.root,'data/bmn/brain-backups')
 if(record.runId!==config.runId||record.backup.path!==path)throw new Error('Foreign brain QA teardown receipt')
 const stat=lstatSync(path)
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==record.backup.device||stat.ino!==record.backup.inode)throw new Error('Brain QA backup fixture identity changed')
 if(!Number.isInteger(record.backup.priorMode)||record.backup.priorMode<0||record.backup.priorMode>0o7777)throw new Error('Invalid brain QA fixture mode')
 const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
 try{
  const opened=fstatSync(fd)
  if(!opened.isDirectory()||opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('Brain QA backup fixture identity changed while opening')
  fchmodSync(fd,record.backup.priorMode)
  const current=lstatSync(path)
  if(current.dev!==stat.dev||current.ino!==stat.ino||current.isSymbolicLink()||(fstatSync(fd).mode&0o7777)!==record.backup.priorMode)throw new Error('Brain QA backup fixture identity changed during mode restoration')
 }finally{closeSync(fd)}
}
