// MODULE: brain-restore.ts - Verify a snapshot by restoring only into a fresh scratch folder
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrainFiles,fileHash } from './brain-files'
import { BrainStore,brainHash } from './brain-store'
import { validateBrainSnapshot, validateBrainObject } from './brain-snapshot'
import type { DatabaseConnection } from './database-initialization'
export function restoreBrainCheck(backup:string,scratch:string,open:(path:string)=>DatabaseConnection):{ok:true;notes:number;versions:number;attachments:number} {
  const manifest=validateBrainSnapshot(backup)
  if(existsSync(scratch))throw new Error('Brain restore check requires a new scratch folder')
  mkdirSync(scratch,{recursive:true,mode:0o700});copyFileSync(join(backup,'brain.sqlite3'),join(scratch,'brain.sqlite3'))
  const database=open(join(scratch,'brain.sqlite3'))
  try {
    const store=new BrainStore(database,false);const files=new BrainFiles(store,scratch,join(scratch,'unused-source'))
    const projection=()=>createHash('sha256').update(JSON.stringify(files.dump())).digest('hex')
    if(projection()!==manifest.projectionHash)throw new Error('Brain restored projection hash mismatch')
    for(const note of store.list())for(const revision of store.history(note.id))if(brainHash(revision.markdown)!==revision.checksum)throw new Error('Brain restored version checksum mismatch')
    store.rebuildProjections()
    if(projection()!==manifest.projectionHash)throw new Error('Brain rebuilt links differ from the backup')
    // Search rebuilt from every retained head, with withdrawn heads deliberately absent.
    for(const note of store.list()) {
      const count=database.prepare('SELECT count(*) AS count FROM brain_search WHERE note=?').get(note.id) as {count:number}
      if(count.count!==(note.status==='withdrawn'?0:1))throw new Error('Brain search rebuild lost a note')
    }
    const attachments=join(scratch,'attachments');mkdirSync(attachments,{mode:0o700})
    const captured=manifest.attachments.filter(a=>a.hash!==null&&a.size!==null&&(manifest.version===1||a.state==='captured'))
    for(const attachment of captured) {
      if(attachment.hash===null||attachment.size===null)throw new Error('Invalid brain backup attachment content')
      const object=join(dirname(backup),'objects',attachment.hash)
      validateBrainObject(object,{hash:attachment.hash,size:attachment.size})
      const target=join(attachments,attachment.hash)
      if(!existsSync(target))copyFileSync(object,target)
      if(fileHash(target)!==attachment.hash)throw new Error('Brain restored attachment hash mismatch')
    }
    const dump=files.dump()
    return {ok:true,notes:dump.notes.length,versions:dump.versions.length,attachments:captured.length}
  }finally{database.close()}
}
