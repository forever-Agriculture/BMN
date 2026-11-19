// MODULE: brain-worker.ts - The brain database's sole runtime writer, separate from session state
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BrainFiles } from './brain-files'
import {validateBrainSnapshot} from './brain-snapshot'
import type {BrainHealth} from './brain-health'
import { BrainAdmission } from './brain-admission'
import { restoreBrainCheck } from './brain-restore'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore, type BrainContent, type BrainImport } from './brain-store'
import { BrainPageReader } from './brain-page'

const port = parentPort
if (!port) throw new Error('Brain worker needs a parent port')
const { databasePath, attachmentsRoot, cutoverJournal } = workerData as { databasePath: string; attachmentsRoot?: string; cutoverJournal?:string }
if (typeof databasePath !== 'string' || !databasePath) throw new Error('Brain worker needs its database path')
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
const require = createRequire(__filename)
const SQLite = require('better-sqlite3') as new (path: string) => DatabaseConnection
const store = new BrainStore(new SQLite(databasePath))
const page = new BrainPageReader(store.database)
const admission=cutoverJournal?new BrainAdmission(store,cutoverJournal):undefined
const files = new BrainFiles(store, dirname(databasePath), attachmentsRoot ?? join(homedir(),'brain','files'))
const healthPath=join(dirname(databasePath),'brain-health.json')
const health:BrainHealth={backup:'unverified',export:'unverified',checkedAt:''}
try {
  const saved=JSON.parse(readFileSync(healthPath,'utf8')) as typeof health
  if(['ok','failed','unverified'].includes(saved.backup))health.backup=saved.backup
  if(typeof saved.backupLastSuccess==='string')health.backupLastSuccess=saved.backupLastSuccess
  if(typeof saved.backupFailureAt==='string')health.backupFailureAt=saved.backupFailureAt
  if(typeof saved.backupFailureId==='string')health.backupFailureId=saved.backupFailureId
}catch { /* No prior successful slot or failure has been observed in a fresh profile. */ }
function recordHealth():void {
  if(health.backup==='failed'&&!health.backupFailureId)health.backupFailureId=randomUUID()
  health.checkedAt=new Date().toISOString()
  const path=join(dirname(databasePath),'brain-health.json');const temp=path+'.'+randomUUID()+'.tmp',text=JSON.stringify(health)+'\n'
  writeFileSync(temp,text,{mode:0o600,flag:'wx'})
  const file=openSync(temp,'r');try{fsyncSync(file)}finally{closeSync(file)}
  renameSync(temp,path)
  const directory=openSync(dirname(path),'r');try{fsyncSync(directory)}finally{closeSync(directory)}
  if(readFileSync(path,'utf8')!==text)throw new Error('Brain Health read-back failed')
}
function reconcileBackupHealth():void {
  const completed=files.scheduledCompletion()
  if(!completed)return
  if(health.backup==='failed'&&(!health.backupFailureId||completed.resolvesFailure!==health.backupFailureId))return
  health.backup='ok';health.backupLastSuccess=completed.completedAt;delete health.backupFailureAt;delete health.backupFailureId
}

port.on('message', (request: { id: number; operation: string; args: unknown[] }) => {
  const { id, operation, args } = request
  let phase: 'operation' | 'backup' | 'export' = 'operation'
  try {
    let result: unknown
    if(['create','edit','withdraw','restore'].includes(operation))admission?.assert()
    switch (operation) {
      case 'initialize': recordHealth(); try{reconcileBackupHealth()}catch{health.backup='failed';health.backupFailureId=randomUUID();health.backupFailureAt=new Date().toISOString();recordHealth()} phase='export'; files.export(); health.export='ok'; recordHealth(); result = { open: store.isOpen(), notes: store.list().length }; break
      case 'read': result = store.read(args[0] as string, args[1] as {section?:string;links?:boolean}); break
      case 'search': result = store.search(args[0] as string, args[1] as boolean); break
      case 'list': result = store.list(); break
      case 'history': result = store.history(args[0] as string); break
      // The Brain page's reads (Epic 128): the window reaches them only through the private parent port.
      case 'page-list': result = page.list(args[0] as Parameters<BrainPageReader['list']>[0]); break
      case 'page-search': result = page.search(args[0] as string, args[1] as boolean); break
      case 'page-read': result = page.read(args[0] as string); break
      case 'page-history': result = page.history(args[0] as string); break
      case 'page-graph': result = page.graph(args[0] as string, args[1] as Parameters<BrainPageReader['graph']>[1]); break
      case 'create': result = store.create(args[0] as BrainContent, args[1] as string); break
      case 'edit': result = store.edit(args[0] as string, args[1] as number, args[2] as BrainContent, args[3] as string); break
      case 'withdraw': result = store.withdraw(args[0] as string, args[1] as number, args[2] as string); break
      case 'restore': result = store.restore(args[0] as string, args[1] as number, args[2] as string); break
      case 'delete': result = store.delete(); break
      // Only the trusted parent can send these operations. They are absent from the control socket.
      case 'startup-context': result = admission?.status().open ? store.startupContext(args[0] as string) : null; break
      case 'import': {phase='backup';const checkpoint=files.snapshot('before-import');validateBrainSnapshot(checkpoint);phase='operation';result={...store.importNotes(args[0] as BrainImport[]),checkpoint};break}
      case 'write-door': if(args[0])store.setWriteDoor(true);else if(admission)admission.revoke();else store.setWriteDoor(false); result=true; break
      case 'admission-status': result=admission?.status()??{storeId:'',committed:false,open:false,receipt:null}; break
      case 'commit-cutover': if(!admission)throw new Error('Brain cutover journal required'); result=admission.commit(args[0] as string); break
      case 'resume-cutover': if(!admission)throw new Error('Brain cutover journal required'); result=admission.resume(); break
      case 'authorize-return': if(!admission)throw new Error('Brain cutover journal required'); result=admission.authorizeReturn(); break
      case 'return-capture': {
        // The final checksummed snapshot after the door closed; the return reads it, never today's attachment files.
        if(store.isOpen())throw new Error('The brain return capture needs the closed write door')
        phase='backup';const snapshot=files.snapshot('return',new Date(),undefined,false);phase='operation'
        const projection=files.dump(),manifest=validateBrainSnapshot(snapshot) as {projectionHash?:string}
        if(createHash('sha256').update(JSON.stringify(projection)).digest('hex')!==manifest.projectionHash)throw new Error('The brain changed during the return capture')
        result={snapshot,projection,objects:join(files.backupRoot,'objects')};break
      }
      case 'create-check': {
        const content=args[0] as BrainContent
        if(content.origin!=='cutover-check'||content.kind!=='check'||content.scope!=='all'||content.markdown!=='Installed brain write/read/export check.')throw new Error('Invalid private brain check')
        result=store.create(content,args[1] as string,args[2] as string);break
      }
      case 'recover-check': {
        const intent=args[0] as {note:string;attempt:string;title:string}
        if(store.isOpen()||!/^owner-cutover-[a-f0-9-]{36}$/.test(intent.attempt)||intent.title!=='cutover-check '+intent.attempt.slice(-12)||! /^[a-f0-9-]{36}$/.test(intent.note))throw new Error('Invalid held installed check recovery')
        const selected=store.database.prepare('SELECT id FROM brain_note WHERE id=?').get(intent.note)
        if(!selected){
          if(store.list().some(note=>note.session===intent.attempt||note.title===intent.title))throw new Error('Installed check identity conflict')
          result={note:intent.note,status:'absent'};break
        }
        const history=store.history(intent.note)
        if(!history.length||history.length>2||history.some((note,index)=>note.revision!==index+1||note.session!==intent.attempt||note.title!==intent.title||note.origin!=='cutover-check'||note.kind!=='check'||note.scope!=='all'||note.markdown!=='Installed brain write/read/export check.'||(note as typeof note&{action:string}).action!==(index===0?'create':'withdraw')||note.status!==(index===0?'active':'withdrawn')))throw new Error('Installed check history conflict')
        if(history.length===1){
          // Trusted recovery stays serialized behind in-flight check writes; the ordinary door remains closed.
          store.database.transaction(()=>{store.setWriteDoor(true);try{store.withdraw(intent.note,1,intent.attempt)}finally{store.setWriteDoor(false)}})()
        }
        result={note:intent.note,status:'withdrawn'};break
      }
      case 'withdraw-check': {
        const note=store.read(args[0] as string)
        if(note.origin!=='cutover-check'||note.session!==args[2])throw new Error('Invalid private brain check target')
        result=store.withdraw(note.id,args[1] as number,args[2] as string);break
      }
      case 'snapshot': store.database.prepare('VACUUM INTO ?').run(args[0] as string); result = true; break
      case 'export-current': result=files.currentExport(); break
      case 'export': phase='export'; result = files.export(); health.export='ok'; recordHealth(); break
      case 'backup': phase='backup'; result = files.snapshot('manual'); recordHealth(); break
      case 'scheduled-backup': phase='backup'; if(health.backup==='failed'&&!health.backupFailureId)recordHealth(); result = files.scheduled(args[0] ? new Date(args[0] as string) : new Date(),health.backupFailureId??null); if(result!==null||health.backup!=='ok')reconcileBackupHealth(); recordHealth(); break // A skipped minute with Health ok re-validates nothing (S4: ~1.5 s per tick with 20 backups)
      case 'dump': result = files.dump(); break
      case 'restore-check': result = restoreBrainCheck(args[0] as string,args[1] as string,path=>new SQLite(path)); break
      case 'close': store.database.close(); result = true; break
      default: throw new Error('Unknown brain worker operation')
    }
    if (['create','edit','withdraw','restore','import','create-check','withdraw-check','recover-check'].includes(operation)) { phase='export'; files.export(operation!=='recover-check'); health.export='ok'; recordHealth() }
    port.postMessage({ id, result,...(admission&&operation!=='close'?{admission:admission.status()}:{}) })
  } catch (error) {
    if(phase==='backup'){health.backup='failed';health.backupFailureAt=new Date().toISOString();health.backupFailureId=randomUUID()}
    if(phase==='export')health.export='failed'
    if(phase!=='operation')try {recordHealth()}catch { /* The caller still receives the original I/O failure. */ }
    port.postMessage({id,...(admission&&operation!=='close'?{admission:admission.status()}:{}),error:{message:phase==='export' && ['create','edit','withdraw','restore','import','create-check','withdraw-check','recover-check'].includes(operation)?'Brain change saved, but export failed; read the current revision before retrying':error instanceof Error ? error.message : 'Brain operation failed',code:phase==='export' && ['create','edit','withdraw','restore','import','create-check','withdraw-check','recover-check'].includes(operation)?'EXPORT_AFTER_COMMIT':(error as {code?:string}).code ?? 'IO_ERROR'}})
  }
})
