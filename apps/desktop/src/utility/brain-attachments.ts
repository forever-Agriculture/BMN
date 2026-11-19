// MODULE: brain-attachments.ts - Capture attachment bytes before binding them to a note revision
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BrainStore, BrainNote, BrainAttachmentInput, BrainAttachmentBinding } from './brain-store'
import { validateBrainObject } from './brain-snapshot'
import { brainAttachmentReferences } from './brain-attachment-references'

export type AttachmentState='captured'|'missing'|'ambiguous'|'unknown'|'legacy'
export interface RevisionAttachment extends BrainAttachmentBinding {note:string;revision:number}
const digest=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex')
const inside=(path:string):boolean=>!!path&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)
function sync(path:string):void {const fd=openSync(path,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
interface Target {path:string;state:'missing'|'ambiguous'|'unknown';file?:string;address:string;wiki:boolean}
export class BrainAttachments {
  readonly objects:string
  constructor(private readonly store:BrainStore,private readonly root:string,backupRoot:string){this.objects=join(backupRoot,'objects')}
  private read(path:string,root:string):Buffer {
    const actual=realpathSync(path),child=relative(root,actual)
    if(!inside(child))throw new Error('Brain attachment leaves its approved root')
    const expected=lstatSync(actual),fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {
      const stat=fstatSync(fd)
      if(!stat.isFile()||stat.dev!==expected.dev||stat.ino!==expected.ino)throw new Error('Brain attachment changed while opening')
      if(process.platform==='linux'&&!inside(relative(root,realpathSync('/proc/self/fd/'+fd))))throw new Error('Brain attachment moved outside its approved root')
      const bytes=readFileSync(fd),after=fstatSync(fd)
      if(bytes.length!==stat.size||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw new Error('Brain attachment changed while reading')
      return bytes
    }finally{closeSync(fd)}
  }
  private capture(bytes:Buffer):{hash:string;size:number} {
    const hash=digest(bytes),size=bytes.length,object=join(this.objects,hash)
    mkdirSync(this.objects,{recursive:true,mode:0o700});sync(dirname(this.objects));sync(dirname(dirname(this.objects)))
    if(existsSync(object)){validateBrainObject(object,{hash,size});sync(object);sync(this.objects);return {hash,size}}
    const temp=join(this.objects,'.'+hash+'.'+randomUUID()+'.tmp'),fd=openSync(temp,'wx',0o400)
    try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}
    validateBrainObject(temp,{hash,size});renameSync(temp,object);sync(this.objects)
    return {hash,size}
  }
  private targets(markdown:string,source:string|null|undefined,root:string):Target[] {
    const raw=brainAttachmentReferences(markdown)
    let inventory:string[]|undefined
    const files=():string[]=>{
      if(inventory)return inventory
      inventory=[]
      const visit=(folder:string):void=>{
        for(const entry of readdirSync(folder,{withFileTypes:true})){
          const path=join(folder,entry.name)
          if(entry.isDirectory()&&!entry.isSymbolicLink())visit(path)
          else if(entry.isFile()||entry.isSymbolicLink())inventory!.push(path)
        }
      }
      if(existsSync(root))visit(root)
      return inventory
    }
    const targets=new Map<string,Target>()
    for(const {address:text,wiki} of raw) {
      const reference=JSON.stringify([text,wiki])
      let decoded:string
      try{decoded=decodeURIComponent(text).split('#')[0]!}catch{continue}
      if(!decoded||decoded.includes('\0')||/^[a-z][a-z0-9+.-]*:/i.test(decoded)||decoded.startsWith('#'))continue
      let file:string
      if(decoded.startsWith('~/brain/files/'))file=join(root,decoded.slice(14))
      else if(decoded.startsWith('files/'))file=join(root,decoded.slice(6))
      else if(isAbsolute(decoded)){
        if(!inside(relative(root,decoded)))continue
        file=decoded
      }else if(wiki&&!decoded.includes('/')){
        const matches=files().filter(path=>basename(path)===decoded)
        const path=decoded
        if(matches.length===0&&(!decoded.includes('.')||/\.md$/i.test(decoded)))continue
        if(matches.length!==1){targets.set(reference,{path,state:matches.length?'ambiguous':'missing',address:text,wiki});continue}
        file=matches[0]!
      }else if(wiki){
        file=join(root,decoded)
      }else {
        if(/\.md$/i.test(decoded)||!decoded.includes('/'))continue
        const original=source?.replace(/^vault:/,'')
        const vault=dirname(root)
        file=resolve(vault,original?dirname(original):'',decoded)
        // Legacy root-relative ../files links also occur in notes without a source path.
        if(!original&&decoded.startsWith('../files/'))file=join(root,decoded.slice(9))
        if(!inside(relative(root,file)))continue
      }
      file=resolve(file)
      const child=relative(root,file).split(sep).join('/')
      if(!inside(child))continue
      if(!existsSync(file)){targets.set(reference,{path:child,state:'missing',address:text,wiki});continue}
      const actual=realpathSync(file)
      if(!inside(relative(root,actual)))throw new Error('Brain attachment leaves its approved root or is not a file')
      const kind=lstatSync(actual)
      // A link to a folder names no bytes to bind: it stays as text and the folder stays in files/.
      if(kind.isDirectory())continue
      if(!kind.isFile())throw new Error('Brain attachment leaves its approved root or is not a file')
      const path=relative(root,actual).split(sep).join('/')
      targets.set(reference,{path,file:actual,state:'unknown',address:text,wiki})
    }
    return [...targets.values()]
  }
  observe(markdown:string,source:string|null):BrainAttachmentInput {
    const root=existsSync(this.root)?realpathSync(this.root):resolve(this.root),targets=this.targets(markdown,source,root)
    const bindings:BrainAttachmentBinding[]=targets.map((target):BrainAttachmentBinding=>{
      if(!target.file)throw new Error('Brain attachment '+target.state+': '+target.path)
      const bytes=this.read(target.file,root)
      return {reference:(target.wiki?'wiki:':'markdown:')+target.address,path:target.path,...this.capture(bytes),state:'captured'}
    }).sort((a,b)=>Buffer.compare(Buffer.from(a.reference),Buffer.from(b.reference)))
    const after=this.targets(markdown,source,root)
    if(JSON.stringify(targets)!==JSON.stringify(after)||(existsSync(this.root)?realpathSync(this.root):resolve(this.root))!==root)throw new Error('Brain attachment target changed during capture')
    return {state:'complete',bindings}
  }
  links(note:BrainNote):{address:string;wiki:boolean;path:string}[] {
    const rows=this.store.database.prepare('SELECT reference,path,state FROM brain_attachment WHERE note=? AND revision=? ORDER BY reference').all(note.id,note.revision) as RevisionAttachment[]
    return rows.map(row=>{
      if(row.state!=='captured'||!row.reference.startsWith('wiki:')&&!row.reference.startsWith('markdown:'))throw new Error('Brain attachment coverage is unproven')
      return {wiki:row.reference.startsWith('wiki:'),address:row.reference.slice(row.reference.indexOf(':')+1),path:row.path}
    })
  }
  /** Export/backup validate committed observations; they never invent a historical binding from today's file.
   * `live` false checks only the captured objects: the return to Obsidian reads those, never today's files. */
  refresh(live=true):void {
    const database=this.store.database
    const unproven=database.prepare("SELECT v.note FROM brain_version v LEFT JOIN brain_attachment_coverage c ON c.note=v.note AND c.revision=v.revision WHERE c.state IS NULL OR c.state!='complete' LIMIT 1").get()
    if(unproven)throw new Error('Brain attachment revision coverage is unproven; historical bytes cannot be inferred on restart')
    const rows=database.prepare('SELECT * FROM brain_attachment ORDER BY note,revision,reference').all() as RevisionAttachment[]
    for(const row of rows){
      if(row.state!=='captured'||row.hash===null||row.size===null)throw new Error('Brain historical attachment coverage is unproven')
      validateBrainObject(join(this.objects,row.hash),{hash:row.hash,size:row.size})
    }
    if(!live)return
    const root=existsSync(this.root)?realpathSync(this.root):resolve(this.root)
    for(const head of this.store.currentNotes()){
      const expected=rows.filter(row=>row.note===head.id&&row.revision===head.revision)
      const targets=this.targets(head.markdown,head.import_source,root)
      if(targets.length!==expected.length)throw new Error('Brain attachment target set changed without a new note revision')
      for(const target of targets){
        const row=expected.find(row=>row.reference===(target.wiki?'wiki:':'markdown:')+target.address)
        if(!target.file)throw new Error('Brain attachment '+target.state+': '+target.path)
        if(!row||row.path!==target.path)throw new Error('Brain attachment target changed without a new note revision')
        const bytes=this.read(target.file,root)
        if(digest(bytes)!==row.hash||bytes.length!==row.size)throw new Error('Brain attachment changed without a new note revision: '+target.path)
      }
    }
  }
}
