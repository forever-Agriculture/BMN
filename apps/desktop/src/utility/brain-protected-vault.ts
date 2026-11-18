// MODULE: brain-protected-vault.ts - Yielding no-follow proof of every vault entry except the owned archive note
import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {lstat,open,readdir,readlink,realpath} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative} from 'node:path'
export type BrainProtectedManifest=Record<string,unknown>
/** Import exclusions are separate: .git, .obsidian, files and symlink identities are protected here. */
export async function protectedVaultManifest(root:string,guard:()=>void=()=>{}):Promise<BrainProtectedManifest> {
 const original=await lstat(root)
 if(!original.isDirectory()||original.isSymbolicLink())throw new Error('The protected vault root must be a real directory')
 const canonical=await realpath(root),manifest:BrainProtectedManifest={}
 const inside=(actual:string):void=>{const child=relative(canonical,actual);if(isAbsolute(child)||child==='..'||child.startsWith('../'))throw new Error('A protected vault entry escaped the vault')}
 const visit=async(path:string):Promise<void>=>{
  guard();inside(await realpath(dirname(path===root?join(root,'entry'):path)))
  const stat=await lstat(path),key=relative(root,path)||'.',identity={mode:stat.mode&0o7777,dev:stat.dev,ino:stat.ino}
  if(stat.isSymbolicLink()){
   const target=await readlink(path),after=await lstat(path)
   if(after.dev!==stat.dev||after.ino!==stat.ino||after.ctimeMs!==stat.ctimeMs)throw new Error('A protected vault link changed during its proof')
   manifest[key]={kind:'link',...identity,target};guard();return
  }
  if(!stat.isDirectory()&&!stat.isFile())throw new Error('Unsupported protected vault entry')
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|(stat.isDirectory()?constants.O_DIRECTORY:0))
  try{
   const opened=await file.stat()
   if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('A protected vault inode changed during its proof')
   // Descriptor identity is checked before reading any bytes, including after an ancestor replacement.
   const actual=process.platform==='linux'?await realpath('/proc/self/fd/'+file.fd):await realpath(path)
   inside(actual)
   if(stat.isDirectory()){
    const directory=process.platform==='linux'?'/proc/self/fd/'+file.fd:path
    const names=(await readdir(directory)).sort()
    manifest[key]={kind:'directory',...identity}
    for(const name of names){if(path===root&&name==='ARCHIVE.md')continue;await visit(join(path,name))}
    if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(names))throw new Error('A protected vault directory changed during its proof')
   }else{
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0
    for(;;){guard();const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;hash.update(buffer.subarray(0,bytesRead))}
    manifest[key]={kind:'file',...identity,size,sha256:hash.digest('hex')}
   }
   const after=await file.stat(),named=await lstat(path)
   if(after.dev!==stat.dev||after.ino!==stat.ino||named.dev!==stat.dev||named.ino!==stat.ino||(after.mode&0o7777)!==identity.mode||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('A protected vault entry changed during its proof')
  }finally{await file.close()}
  guard()
 }
 await visit(root)
 return manifest
}
