// MODULE: brain-files.ts - Atomic exports, content-addressed attachments and restorable snapshots
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, renameSync, rmSync, statSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import type { BrainStore } from './brain-store'
import { brainProjection, validateBrainSnapshot, validateBrainObject } from './brain-snapshot'
import { BrainAttachments, type RevisionAttachment } from './brain-attachments'
import {brainCheckpointInventory} from './brain-backup-inventory'
export interface BrainScheduleSuccess {version:2;day:string;week:string;completedAt:string;resolvesFailure:string|null}
export const fileHash = (path:string):string => createHash('sha256').update(readFileSync(path)).digest('hex')
function atomic(path:string,body:string):void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700})
  const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,body,{mode:0o600,flag:'wx'})
  const fd=openSync(temp,'r');try{fsyncSync(fd)}finally{closeSync(fd)}
  renameSync(temp,path)
  if(readFileSync(path,'utf8')!==body)throw new Error('Brain state read-back failed')
  const parent=openSync(dirname(path),'r');try{fsyncSync(parent)}finally{closeSync(parent)}
}
function syncPath(path:string):void {const fd=openSync(path,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
function week(date:Date):string {
  const monday=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));return monday.toISOString().slice(0,10)
}
export class BrainFiles {
  readonly backupRoot:string
  readonly exportRoot:string
  constructor(private readonly store:BrainStore,readonly dataRoot:string,readonly attachmentsRoot:string) {
    this.backupRoot=join(dataRoot,'brain-backups');this.exportRoot=join(dataRoot,'brain-export')
    const capture=new BrainAttachments(store,attachmentsRoot,this.backupRoot)
    store.configureAttachments((content,source)=>capture.observe(content.markdown,source))
  }
  dump() {
    return brainProjection(this.store)
  }
  refreshAttachments(live=true):void {new BrainAttachments(this.store,this.attachmentsRoot,this.backupRoot).refresh(live)}
  currentExport():string {
    const current=join(this.exportRoot,'current'),entry=lstatSync(current)
    if(!entry.isSymbolicLink())throw new Error('Brain export has no valid published pointer')
    const id=readlinkSync(current)
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Brain export has no valid published generation')
    const path=join(this.exportRoot,id),folder=lstatSync(path)
    if(!folder.isDirectory()||folder.isSymbolicLink()||folder.mode&0o222||realpathSync(current)!==path||!existsSync(join(path,'history.json')))throw new Error('Brain published export is unavailable')
    return current
  }
  export(live=true):string {
    this.refreshAttachments(live)
    mkdirSync(this.exportRoot,{recursive:true,mode:0o700})
    const id=randomUUID();const temp=join(this.exportRoot,'.'+id);const dest=join(this.exportRoot,id)
    mkdirSync(temp,{mode:0o700})
    try {
      const dump=this.dump(),notes=this.store.currentNotes(),capture=new BrainAttachments(this.store,this.attachmentsRoot,this.backupRoot)
      const exportedIds=new Set(notes.map(note=>note.id))
      const assets=join(temp,'assets'),maps=join(temp,'.links');mkdirSync(assets,{mode:0o700});mkdirSync(maps,{mode:0o700})
      for(const note of notes) {
        const path=join(temp,note.id+'.md');writeFileSync(path,note.markdown,{mode:0o444,flag:'wx'});syncPath(path)
        const targets:Record<string,string>={}
        for(const reference of capture.links(note)){
          const row=(dump.attachments as RevisionAttachment[]).find(row=>row.note===note.id&&row.revision===note.revision&&row.reference===(reference.wiki?'wiki:':'markdown:')+reference.address&&row.state==='captured')
          if(!row||row.hash===null||row.size===null)throw new Error('Brain export attachment has no captured revision')
          const extension=extname(row.path).toLowerCase(),suffix=/^\.[a-z0-9]{1,10}$/.test(extension)?extension:'.bin'
          const target='assets/'+row.hash+suffix,object=join(capture.objects,row.hash),copy=join(temp,target)
          validateBrainObject(object,{hash:row.hash,size:row.size})
          if(!existsSync(copy)){copyFileSync(object,copy);chmodSync(copy,0o444);validateBrainObject(copy,{hash:row.hash,size:row.size});syncPath(copy)}
          targets[(reference.wiki?'wiki:':'markdown:')+reference.address]=target
        }
        for(const link of dump.links as {note:string;kind:string;target:string;resolved:string|null}[])if(link.note===note.id&&link.kind==='note'&&link.resolved&&exportedIds.has(link.resolved)){
          const address='wiki:'+link.target
          if(!Object.hasOwn(targets,address))targets[address]=link.resolved+'.md'
        }
        const map=join(maps,note.id+'.json');writeFileSync(map,JSON.stringify({version:1,checksum:note.checksum,targets})+'\n',{mode:0o444,flag:'wx'});syncPath(map)
      }
      chmodSync(assets,0o555);chmodSync(maps,0o555);syncPath(assets);syncPath(maps)
      const imported=join(temp,'.import-set.json');writeFileSync(imported,JSON.stringify({version:1,imports:this.store.currentImportSet(),notes:notes.map(note=>note.id)})+'\n',{mode:0o444,flag:'wx'});syncPath(imported)
      writeFileSync(join(temp,'history.json'),JSON.stringify(dump,null,2)+'\n',{mode:0o444,flag:'wx'});syncPath(join(temp,'history.json'));syncPath(temp)
      chmodSync(temp,0o555);renameSync(temp,dest)
      const current=join(this.exportRoot,'current'),pointer=join(this.exportRoot,'.current-'+id)
      if(existsSync(current)||(()=>{try{return lstatSync(current).isSymbolicLink()}catch{return false}})())this.currentExport()
      symlinkSync(id,pointer,'dir');renameSync(pointer,current);syncPath(this.exportRoot)
      atomic(join(this.exportRoot,'latest.json'),JSON.stringify({folder:current,generation:dest,createdAt:new Date().toISOString()})+'\n')
      this.pruneExports(dest)
      return current
    } catch(error) {if(existsSync(temp)){chmodSync(temp,0o700);rmSync(temp,{recursive:true})}throw error}
  }
  /** Exports are projections; history remains in SQLite and in the current export. */
  private pruneExports(current:string):void {
    const generations=readdirSync(this.exportRoot).filter(name=>/^[a-f0-9-]{36}$/.test(name))
      .map(name=>join(this.exportRoot,name))
      .filter(path=>lstatSync(path).isDirectory()&&existsSync(join(path,'history.json')))
      .sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)
    const retained=[current,...generations.filter(path=>path!==current)].slice(0,2)
    for(const path of generations)if(!retained.includes(path)){
      for(const name of ['assets','.links']){const child=join(path,name);if(existsSync(child)){const entry=lstatSync(child);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('Brain export projection directory changed');chmodSync(child,0o700)}}
      chmodSync(path,0o700);rmSync(path,{recursive:true})
    }
  }
  private pruneBackupObjects():void {
    const referenced=new Set<string>()
    for(const attachment of this.store.database.prepare('SELECT * FROM brain_attachment').all() as RevisionAttachment[])if(attachment.hash!==null){
      referenced.add(attachment.hash)
      if(attachment.state==='captured'&&attachment.size!==null)validateBrainObject(join(this.backupRoot,'objects',attachment.hash),{hash:attachment.hash,size:attachment.size})
    }
    // Read every completed snapshot, including explicit manual/import checkpoints.
    // An unreadable manifest aborts collection before a single object is removed.
    for(const folder of brainCheckpointInventory(this.backupRoot)) {
      const manifest=validateBrainSnapshot(folder)
      for(const attachment of manifest.attachments){
        if(attachment.hash!==null)referenced.add(attachment.hash)
      }
    }
    const objects=join(this.backupRoot,'objects')
    for(const name of readdirSync(objects))if(/^[a-f0-9]{64}$/.test(name)&&!referenced.has(name)&&lstatSync(join(objects,name)).isFile())rmSync(join(objects,name))
  }
  snapshot(label:string,now=new Date(),slot?:string,live=true):string {
    if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid brain snapshot label')
    this.refreshAttachments(live)
    mkdirSync(this.backupRoot,{recursive:true,mode:0o700})
    if(slot!==undefined&&(label!=='nightly'||slot!=='nightly-'+now.toISOString().slice(0,10)))throw new Error('Invalid brain backup slot')
    const id=slot??label+'-'+now.toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()
    const temp=join(this.backupRoot,'.'+id+'.'+randomUUID()+'.tmp');const dest=join(this.backupRoot,id)
    if(existsSync(dest)){validateBrainSnapshot(dest);return dest}
    mkdirSync(temp,{mode:0o700})
    try {
      const database=join(temp,'brain.sqlite3')
      this.store.database.prepare('VACUUM INTO ?').run(database);syncPath(database)
      const attachments=this.store.database.prepare('SELECT * FROM brain_attachment ORDER BY note,revision,reference').all() as RevisionAttachment[]
      const objects=join(this.backupRoot,'objects');mkdirSync(objects,{recursive:true,mode:0o700})
      for(const attachment of attachments)if(attachment.state==='captured'&&attachment.hash!==null&&attachment.size!==null)validateBrainObject(join(objects,attachment.hash),{hash:attachment.hash,size:attachment.size})
      syncPath(objects)
      const projection=JSON.stringify(this.dump())
      atomic(join(temp,'manifest.json'),JSON.stringify({version:3,createdAt:now.toISOString(),databaseHash:fileHash(database),projectionHash:createHash('sha256').update(projection).digest('hex'),attachments},null,2)+'\n')
      renameSync(temp,dest);syncPath(this.backupRoot);return dest
    }catch(error){rmSync(temp,{recursive:true,force:true});throw error}
  }
  /** A legacy marker cannot resolve a failure whose ordering it never recorded. */
  scheduledCompletion():BrainScheduleSuccess|null {
    const path=join(this.backupRoot,'schedule.json')
    if(!existsSync(path))return null
    const value=JSON.parse(readFileSync(path,'utf8')) as BrainScheduleSuccess
    if(value.version!==2)return null
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value.day)||value.week!==week(new Date(value.day+'T03:00:00Z'))||
      !Number.isFinite(Date.parse(value.completedAt))||value.resolvesFailure!==null&&!/^[a-f0-9-]{36}$/.test(value.resolvesFailure))throw new Error('Invalid Brain scheduled completion receipt')
    brainCheckpointInventory(this.backupRoot)
    validateBrainSnapshot(join(this.backupRoot,'nightly-'+value.day));validateBrainSnapshot(join(this.backupRoot,'weekly-'+value.week))
    return value
  }
  /** Most recent due 03:00 UTC slot; pre-03:00 startup catches up yesterday. */
  scheduled(now=new Date(),resolvesFailure:string|null=null):string|null {
    const due=new Date(now)
    if(!Number.isFinite(due.getTime()))throw new Error('Invalid brain backup clock')
    due.setUTCHours(3,0,0,0)
    if(due.getTime()>now.getTime())due.setUTCDate(due.getUTCDate()-1)
    const day=due.toISOString().slice(0,10),currentWeek=week(due)
    const lastFile=join(this.backupRoot,'schedule.json')
    const last=existsSync(lastFile)?JSON.parse(readFileSync(lastFile,'utf8')) as {day:string;week:string}:null
    if(last?.day&&last.day>=day)return null
    // Fixed completed slot names make a retry after publication/GC failure idempotent.
    const path=this.snapshot('nightly',due,'nightly-'+day)
    const weekly=join(this.backupRoot,'weekly-'+currentWeek)
    if(!existsSync(weekly)) {
      const temp=join(this.backupRoot,'.weekly-'+currentWeek+'.'+randomUUID()+'.tmp')
      mkdirSync(temp,{mode:0o700})
      try {
        copyFileSync(join(path,'brain.sqlite3'),join(temp,'brain.sqlite3'));syncPath(join(temp,'brain.sqlite3'))
        copyFileSync(join(path,'manifest.json'),join(temp,'manifest.json'));syncPath(join(temp,'manifest.json'))
        syncPath(temp);renameSync(temp,weekly);syncPath(this.backupRoot)
      }catch(error){rmSync(temp,{recursive:true,force:true});throw error}
    }
    // Validate every retained checkpoint before deleting snapshots or object bytes.
    const completed=brainCheckpointInventory(this.backupRoot).map(path=>path.slice(this.backupRoot.length+1))
    for(const [pattern,keep] of [[/^nightly-\d{4}-\d{2}-\d{2}(?:T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36})?$/,14],[/^weekly-\d{4}-\d{2}-\d{2}$/,8]] as const) {
      const names=completed.filter(name=>pattern.test(name)).sort().reverse()
      for(const name of names.slice(keep)){
        const retired=join(this.backupRoot,'.retired-'+randomUUID())
        renameSync(join(this.backupRoot,name),retired);syncPath(this.backupRoot)
        rmSync(retired,{recursive:true});syncPath(this.backupRoot)
      }
    }
    syncPath(this.backupRoot)
    this.pruneBackupObjects()
    syncPath(join(this.backupRoot,'objects'))
    // This receipt means publication, retention and object validation all succeeded.
    atomic(lastFile,JSON.stringify({version:2,day,week:currentWeek,completedAt:new Date().toISOString(),resolvesFailure} satisfies BrainScheduleSuccess)+'\n')
    return path
  }
}
