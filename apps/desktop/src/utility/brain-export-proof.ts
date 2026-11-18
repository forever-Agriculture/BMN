// MODULE: brain-export-proof.ts - Inspect one pinned read-only published generation, never a moving current pointer
import {constants,openSync,closeSync,lstatSync,fstatSync,readFileSync,readlinkSync,readdirSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import type {BrainImport} from './brain-store'
const hash=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex')
export function inspectBrainExport<T>(current:string,dataRoot:string,inspect:(generation:{path:string;read(name:string):Buffer;names:string[]})=>T):T {
 const root=join(dataRoot,'brain-export')
 if(current!==join(root,'current')||!lstatSync(current).isSymbolicLink())throw new Error('Brain export is not its trusted current pointer')
 const generation=readlinkSync(current)
 if(!/^[a-f0-9-]{36}$/.test(generation))throw new Error('Invalid brain export generation')
 const actualRoot=realpathSync(root),expected=join(actualRoot,generation),rootFd=openSync(actualRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
 let fd:number|undefined
 const base=(descriptor:number):string=>join(process.platform==='linux'?'/proc/self/fd':'/dev/fd',String(descriptor))
 try{
  fd=openSync(join(base(rootFd),generation),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  const identity=fstatSync(fd),pinned=base(fd)
  if(!identity.isDirectory()||identity.mode&0o222||realpathSync(current)!==expected||realpathSync(pinned)!==expected)throw new Error('Brain export generation is writable or escaped')
  const read=(name:string):Buffer=>{
   if(!name||name.includes('/')||name.includes('\\')||name==='.'||name==='..')throw new Error('Invalid brain export leaf')
   const file=openSync(join(pinned,name),constants.O_RDONLY|constants.O_NOFOLLOW)
   try{const stat=fstatSync(file);if(!stat.isFile()||stat.mode&0o222)throw new Error('Brain export file is writable or unsafe');return readFileSync(file)}finally{closeSync(file)}
  }
  const check=(path:string):void=>{
   for(const entry of readdirSync(path,{withFileTypes:true})){
    const child=join(path,entry.name),stat=lstatSync(child)
    if(stat.isSymbolicLink()||stat.mode&0o222||!stat.isDirectory()&&!stat.isFile())throw new Error('Brain export contains a writable or unsafe entry')
    if(stat.isDirectory()){const childFd=openSync(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const opened=fstatSync(childFd);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('Brain export child changed');check(base(childFd))}finally{closeSync(childFd)}}
   }
  }
  check(pinned)
  const result=inspect({path:expected,read,names:readdirSync(pinned)})
  const final=lstatSync(join(base(rootFd),generation))
  if(!final.isDirectory()||final.isSymbolicLink()||final.dev!==identity.dev||final.ino!==identity.ino||realpathSync(pinned)!==expected)throw new Error('Brain export generation disappeared during inspection')
  return result
 }finally{if(fd!==undefined)closeSync(fd);closeSync(rootFd)}
}
/** Prove source membership and text from actual files in the same published generation. */
export function verifyBrainImportExport(current:string,dataRoot:string,notes:BrainImport[]):{generation:string;sources:{source:string;note:string;sha256:string}[]} {
 return inspectBrainExport(current,dataRoot,generation=>{
  const membership=JSON.parse(generation.read('.import-set.json').toString('utf8')) as {version:number;imports:{source:string;note:string}[];notes:string[]}
  if(membership.version!==1||!Array.isArray(membership.imports)||!Array.isArray(membership.notes))throw new Error('Brain export import membership is missing')
  const expected=notes.map(note=>note.source).sort(),actual=membership.imports.map(row=>row.source).sort()
  if(JSON.stringify(expected)!==JSON.stringify(actual)||new Set(membership.notes).size!==membership.notes.length||new Set(membership.imports.map(row=>row.note)).size!==membership.imports.length)throw new Error('Brain export source-key set differs')
  const files=generation.names.filter(name=>name.endsWith('.md')).sort()
  if(JSON.stringify(files)!==JSON.stringify(membership.notes.map(id=>id+'.md').sort()))throw new Error('Brain export contains stale or missing current files')
  const history=JSON.parse(generation.read('history.json').toString('utf8')) as {notes:{id:string;import_source:string;status:string;checksum:string;markdown:string}[]}
  const sources=notes.map(source=>{
   const row=membership.imports.find(row=>row.source===source.source)!,head=history.notes.find(note=>note.id===row.note)
   if(!head||head.import_source!==source.source||!membership.notes.includes(row.note)||hash(generation.read(row.note+'.md'))!==hash(source.markdown)||head.checksum!==hash(source.markdown))throw new Error('Brain exported source file hash differs')
   return {source:source.source,note:row.note,sha256:hash(source.markdown)}
  })
  return {generation:resolve(generation.path),sources}
 })
}
