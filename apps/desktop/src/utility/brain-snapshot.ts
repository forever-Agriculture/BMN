// MODULE: brain-snapshot.ts - One fail-closed validator for retained snapshot rows and objects
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { BrainStore } from './brain-store'
import { brainAttachmentReferences } from './brain-attachment-references'
import type { DatabaseConnection } from './database-initialization'

export interface BrainAttachment {note:string;path:string;hash:string|null;size:number|null;revision?:number;state?:'captured'|'missing'|'ambiguous'|'unknown'|'legacy';reference?:string}
export interface BrainSnapshotManifest {version:1|2|3;createdAt:string;databaseHash:string;projectionHash:string;attachments:BrainAttachment[]}
const hash=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex')
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
function snapshotFormat(database:DatabaseConnection):BrainSnapshotManifest['version'] {
  const versions=(database.prepare('SELECT version FROM brain_migration ORDER BY version').all() as {version:number}[]).map(row=>row.version)
  const format=versions.length
  if((format!==1&&format!==2&&format!==3)||versions.some((version,index)=>version!==index+1))throw new Error('Unsupported brain snapshot database format')
  const columns=(table:string)=>(database.prepare('PRAGMA table_info('+table+')').all() as {name:string}[]).map(column=>column.name).sort().join(',')
  const attachmentColumns=['hash,note,path,size','hash,note,path,revision,size,state','hash,note,path,reference,revision,size,state']
  if(columns('brain_attachment')!==attachmentColumns[format-1]||
    columns('brain_attachment_coverage')!==(format===3?'note,revision,state':'')||
    columns('brain_import_current')!==(format===3?'note,source':''))throw new Error('Brain snapshot database format has inconsistent tables')
  return format
}

export function brainProjection(store:BrainStore) {
  const columns=store.database.prepare('PRAGMA table_info(brain_attachment)').all() as {name:string}[]
  const current=columns.some(column=>column.name==='reference'),order=current?'note,revision,reference':columns.some(column=>column.name==='revision')?'note,revision,path':'note,path'
  const prior={notes:store.list(),versions:store.database.prepare('SELECT * FROM brain_version ORDER BY note,revision').all(),links:store.database.prepare('SELECT * FROM brain_link ORDER BY note,kind,target').all(),attachments:store.database.prepare('SELECT * FROM brain_attachment ORDER BY '+order).all()}
  return current?{...prior,coverage:store.database.prepare('SELECT * FROM brain_attachment_coverage ORDER BY note,revision').all(),imports:store.currentImportSet()}:prior
}
function attachmentRows(value:unknown,version:1|2|3):BrainAttachment[] {
  if(!Array.isArray(value))throw new Error('Invalid brain snapshot attachment manifest')
  const seen=new Set<string>()
  const rows=value.map((entry:unknown)=>{
    if(!entry||typeof entry!=='object')throw new Error('Invalid brain snapshot attachment row')
    const row=entry as Record<string,unknown>,captured=version===1||row.state==='captured'
    if(typeof row.note!=='string'||!row.note||typeof row.path!=='string'||!row.path||row.path.includes('\0'))throw new Error('Invalid brain snapshot attachment row')
    if(version===1?(!isAbsolute(row.path)||resolve(row.path)!==row.path):(isAbsolute(row.path)||row.path==='..'||row.path.startsWith('../')||row.path.includes('\\')||posix.normalize(row.path)!==row.path))throw new Error('Unsafe brain snapshot attachment path')
    if(captured?(!validHash(row.hash)||!Number.isSafeInteger(row.size)||(row.size as number)<0):((row.hash!==null&&!validHash(row.hash))||(row.size!==null&&(!Number.isSafeInteger(row.size)||(row.size as number)<0))))throw new Error('Invalid brain snapshot attachment content')
    if(version>=2&&(!Number.isSafeInteger(row.revision)||(row.revision as number)<1||!['captured','missing','ambiguous','unknown'].includes(row.state as string)))throw new Error('Invalid brain snapshot attachment revision or state')
    if(version===3&&(typeof row.reference!=='string'||!row.reference||row.reference.includes('\0')||!/^(?:wiki|markdown):/.test(row.reference)))throw new Error('Unproven or invalid authored attachment reference')
    const key=JSON.stringify([row.note,row.revision??null,version===3?row.reference:row.path])
    if(seen.has(key))throw new Error('Duplicate brain snapshot attachment row')
    seen.add(key)
    return version===1?{note:row.note,path:row.path,hash:row.hash,size:row.size} as BrainAttachment:{note:row.note,revision:row.revision,...(version===3?{reference:row.reference}:{}),path:row.path,hash:row.hash,size:row.size,state:row.state} as BrainAttachment
  })
  return rows.sort((a,b)=>a.note<b.note?-1:a.note>b.note?1:(a.revision??0)-(b.revision??0)||(a.path<b.path?-1:a.path>b.path?1:0))
}
export function validateBrainObject(path:string,expected:{hash:string;size:number}):void {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const stat=fstatSync(fd)
    if(!stat.isFile()||stat.size!==expected.size)throw new Error('Brain backup attachment size mismatch')
    const bytes=readFileSync(fd)
    if(bytes.length!==expected.size||hash(bytes)!==expected.hash)throw new Error('Brain backup attachment hash mismatch')
  }finally{closeSync(fd)}
}
function snapshotBytes(path:string):{bytes:Buffer;device:number;inode:number} {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{
  const before=fstatSync(fd)
  if(!before.isFile())throw new Error('Brain snapshot entry is not a regular file')
  const bytes=readFileSync(fd),after=fstatSync(fd),leaf=lstatSync(path)
  if(leaf.isSymbolicLink()||leaf.dev!==before.dev||leaf.ino!==before.ino||after.size!==before.size||bytes.length!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Brain snapshot file changed while read')
  return {bytes,device:before.dev,inode:before.ino}
 }finally{closeSync(fd)}
}
/** A corrupt retained snapshot aborts GC before any object is removed. */
export function validateBrainSnapshot(backup:string):BrainSnapshotManifest {
  const folder=lstatSync(backup)
  if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('Brain snapshot is not a real directory')
  const inventory=()=>{if(JSON.stringify(readdirSync(backup).sort())!==JSON.stringify(['brain.sqlite3','manifest.json']))throw new Error('Unexpected brain snapshot entries (expected database and manifest only)')}
  inventory()
  const manifestFile=snapshotBytes(join(backup,'manifest.json')),manifest=JSON.parse(manifestFile.bytes.toString('utf8')) as BrainSnapshotManifest
  if(![1,2,3].includes(manifest.version)||!validHash(manifest.databaseHash)||!validHash(manifest.projectionHash))throw new Error('Invalid brain backup manifest')
  const databasePath=join(backup,'brain.sqlite3')
  const databaseFile=snapshotBytes(databasePath)
  if(hash(databaseFile.bytes)!==manifest.databaseHash)throw new Error('Brain backup database hash mismatch')
  const attachments=attachmentRows(manifest.attachments,manifest.version)
  if(manifest.version>=2&&attachments.some(row=>row.state!=='captured'))throw new Error('Brain restored attachment coverage is unproven')
  const require=createRequire(__filename)
  const SQLite=require('better-sqlite3') as new(path:string,options:{readonly:boolean;fileMustExist:boolean})=>DatabaseConnection
  const database=new SQLite(databasePath,{readonly:true,fileMustExist:true})
  try {
    const format=snapshotFormat(database)
    if(format!==manifest.version)throw new Error('Brain snapshot database format differs from its manifest version')
    const projection=brainProjection(new BrainStore(database,false))
    if(hash(JSON.stringify(projection))!==manifest.projectionHash)throw new Error('Brain restored projection hash mismatch')
    if(JSON.stringify(attachmentRows(projection.attachments,format))!==JSON.stringify(attachments))throw new Error('Brain snapshot attachment manifest differs from database rows')
    if(format===3){
      const missing=database.prepare("SELECT v.note FROM brain_version v LEFT JOIN brain_attachment_coverage c ON c.note=v.note AND c.revision=v.revision WHERE c.state IS NULL OR c.state!='complete' LIMIT 1").get()
      if(missing)throw new Error('Brain restored revision attachment coverage is unproven')
    }else{
      // Legacy rows did not prove coverage of the Markdown authored in each revision.
      const revisions=projection.versions as {markdown:string}[]
      if(attachments.length||revisions.some(revision=>brainAttachmentReferences(revision.markdown).length!==0))throw new Error('Legacy brain snapshot revision attachment coverage is unproven')
    }
  }finally{database.close()}
  for(const attachment of attachments)if(attachment.hash!==null&&attachment.size!==null&&(manifest.version===1||attachment.state==='captured'))validateBrainObject(join(dirname(backup),'objects',attachment.hash),{hash:attachment.hash,size:attachment.size})
  inventory()
  const finalFolder=lstatSync(backup),finalDb=snapshotBytes(databasePath),finalManifest=snapshotBytes(join(backup,'manifest.json'))
  if(finalFolder.isSymbolicLink()||finalFolder.dev!==folder.dev||finalFolder.ino!==folder.ino||finalDb.device!==databaseFile.device||finalDb.inode!==databaseFile.inode||hash(finalDb.bytes)!==manifest.databaseHash||finalManifest.device!==manifestFile.device||finalManifest.inode!==manifestFile.inode||!finalManifest.bytes.equals(manifestFile.bytes))throw new Error('Brain snapshot changed during validation')
  return {...manifest,attachments}
}
