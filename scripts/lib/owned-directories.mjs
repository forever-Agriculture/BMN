// MODULE: owned-directories.mjs - Unlock directories only in an inode-bound disposable tree
import {constants,openSync,closeSync,fstatSync,fchmodSync,lstatSync,readdirSync,realpathSync,mkdtempSync,renameSync,rmSync,rmdirSync,fsyncSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
const same=(stat,identity)=>stat.dev===identity.device&&stat.ino===identity.inode
function assertRoot(root,identity){
 const entry=lstatSync(root)
 if(resolve(root)==='/'||!identity||!entry.isDirectory()||entry.isSymbolicLink()||!same(entry,identity)||realpathSync(root)!==resolve(root))throw new Error('Disposable root identity changed; kept unchanged')
}
function unlock(root,identity){
 // Windows has no POSIX directory write barrier.
 if(process.platform==='win32')return
 const descriptors=process.platform==='linux'?'/proc/self/fd':'/dev/fd'
 const visit=(path,expected)=>{
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try{
   const stat=fstatSync(fd)
   if(!stat.isDirectory()||!same(stat,expected)||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw new Error('An owned directory changed during cleanup')
   fchmodSync(fd,(stat.mode&0o7777)|0o700)
   if((fstatSync(fd).mode&0o700)!==0o700)throw new Error('Owned directory permission read-back failed')
   // Resolve each child from the open parent, never through a replaceable pathname ancestor.
   const parent=join(descriptors,String(fd))
   for(const child of readdirSync(parent,{withFileTypes:true}))if(child.isDirectory()){
    const path=join(parent,child.name),next=lstatSync(path)
    if(!next.isDirectory()||next.isSymbolicLink())throw new Error('An owned child directory changed during cleanup')
    visit(path,{device:next.dev,inode:next.ino})
   }
  }finally{closeSync(fd)}
 }
 visit(root,identity)
}
export function makeOwnedDirectoriesWritable(root,identity){
 assertRoot(root,identity);unlock(root,identity)
 const after=lstatSync(root)
 if(!after.isDirectory()||after.isSymbolicLink()||!same(after,identity))throw new Error('Disposable root identity changed before removal')
}

const absent=path=>{try{lstatSync(path);return false}catch(error){if(error.code==='ENOENT')return true;throw error}}
const syncDirectory=path=>{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd)}finally{closeSync(fd)}}
/** A durable journal can resume the same private entry, never a reused public pathname. */
export function removeOwnedDirectory(root,identity,journal){
 let state=journal?.state
 const save=phase=>{state={...state,phase};journal?.save(state)}
 if(state){
  if(state.version!==1||state.root!==root||(identity.device!==state.identity?.device||identity.inode!==state.identity?.inode)||
    dirname(state.parent)!==dirname(root)||!state.parent.startsWith(join(dirname(root),'.bmn-cleanup-'))||state.entry!==join(state.parent,'entry')||
    !['prepared','moved','removing','deleted'].includes(state.phase))throw new Error('Invalid owned cleanup journal')
 }else{
  assertRoot(root,identity)
  const parent=mkdtempSync(join(dirname(root),'.bmn-cleanup-')),stat=lstatSync(parent)
  state={version:1,root,identity,parent,entry:join(parent,'entry'),parentIdentity:{device:stat.dev,inode:stat.ino},phase:'prepared'}
  syncDirectory(dirname(root));journal?.save(state)
 }
 if(state.phase==='deleted'&&absent(state.parent))return state
 let fd
 try{
  const parent=lstatSync(state.parent)
  if(!parent.isDirectory()||parent.isSymbolicLink()||!same(parent,state.parentIdentity)||realpathSync(state.parent)!==state.parent)throw new Error('Private cleanup parent changed')
  if(process.platform!=='win32'){
   fd=openSync(state.parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
   const stat=fstatSync(fd)
   if(!same(stat,state.parentIdentity)||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid())throw new Error('Private cleanup parent changed')
  }
  const pinned=fd===undefined?state.entry:join(process.platform==='linux'?'/proc/self/fd':'/dev/fd',String(fd),'entry')
  if(state.phase==='prepared'){
   if(absent(pinned)){assertRoot(root,identity);renameSync(root,state.entry)}
   const moved=lstatSync(pinned)
   if(!moved.isDirectory()||moved.isSymbolicLink()||!same(moved,identity))throw new Error('Disposable root identity changed during quarantine')
   syncDirectory(state.parent);syncDirectory(dirname(root));save('moved')
  }
  if(state.phase==='moved'||state.phase==='removing'){
   if(!absent(pinned)){
    const moved=lstatSync(pinned)
    if(!moved.isDirectory()||moved.isSymbolicLink()||!same(moved,identity))throw new Error('Disposable root identity changed before private removal')
    save('removing');unlock(pinned,identity)
    const current=lstatSync(pinned)
    if(!current.isDirectory()||current.isSymbolicLink()||!same(current,identity))throw new Error('Disposable root identity changed before private removal')
    rmSync(pinned,{recursive:true,force:false,maxRetries:5,retryDelay:50})
   }else if(state.phase!=='removing')throw new Error('Private cleanup entry disappeared without removal intent')
   syncDirectory(state.parent);save('deleted')
  }
  if(!absent(pinned)||readdirSync(state.parent).length)throw new Error('Private cleanup parent has unexpected entries')
 }catch(error){throw new Error(`Owned cleanup stopped; entry retained at ${state.entry}: ${error.message}`,{cause:error})}
 finally{if(fd!==undefined)closeSync(fd)}
 const after=lstatSync(state.parent)
 if(!after.isDirectory()||after.isSymbolicLink()||!same(after,state.parentIdentity))throw new Error('Private cleanup parent changed after deletion')
 rmdirSync(state.parent);syncDirectory(dirname(root));return state
}
