// MODULE: brain-return.ts - Stage and publish BMN-era brain changes as new Markdown for the return to Obsidian
import {createHash,randomUUID} from 'node:crypto'
import {chmodSync,closeSync,constants,copyFileSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs'
import {extname,join,posix,relative} from 'node:path'
import {brainAttachmentSpans} from './brain-attachment-references'

/** The frozen projection the worker captured after closing its write door (history.json's shape). */
export interface BrainReturnProjection {
  notes:{id:string;revision:number;status:string;import_source?:string|null}[]
  versions:{note:string;revision:number;title:string;kind:string;origin:string;scope:string;status:string;markdown:string;checksum:string;recorded_at:string;superseded_by?:string|null}[]
  attachments:{note:string;revision:number;reference?:string;path:string;hash:string|null;size:number|null;state?:string}[]
}
export interface BrainReturnManifest {version:2;cutoverId:string;files:Record<string,string>;notes:{id:string;revision:number;file:string;status:string;importSource:string|null}[]}
export interface BrainReturnStageInput {projection:BrainReturnProjection;objects:string;heads:Record<string,number>;checkNote?:string;cutoverId:string;stage:string}
/** A rename that fails when the target exists (renameat2 RENAME_NOREPLACE in production). */
export type BrainReturnRename=(source:string,target:string)=>void

const sha256=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex')
const manifestText=(manifest:BrainReturnManifest):string=>JSON.stringify(manifest,null,2)+'\n'
function syncPath(path:string):void {const fd=openSync(path,constants.O_RDONLY|(lstatSync(path).isDirectory()?constants.O_DIRECTORY:0));try{fsyncSync(fd)}finally{closeSync(fd)}}
function listFiles(root:string,folder=root):string[] {
  const out:string[]=[]
  for(const entry of readdirSync(folder,{withFileTypes:true})){
    const path=join(folder,entry.name)
    if(entry.isSymbolicLink())throw new Error('Brain return folder holds a link: '+relative(root,path))
    if(entry.isDirectory())out.push(...listFiles(root,path));else if(entry.isFile())out.push(relative(root,path))
  }
  return out.sort()
}
export function brainReturnSlug(title:string):string {
  const slug=title.normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,60).replace(/-+$/,'')
  return slug||'note'
}
/** The folder name inside the vault's inbox; stable for one cutover so a retried return finds its own work. */
export const brainReturnFolderName=(cutoverId:string):string=>'from-bmn-brain-'+cutoverId.replace(/[^a-zA-Z0-9-]/g,'').slice(0,36)
/** Notes changed after the switch: new, edited or withdrawn, in id order. */
function changedNotes(input:Pick<BrainReturnStageInput,'projection'|'heads'|'checkNote'>):BrainReturnProjection['notes'] {
  return input.projection.notes.filter(note=>note.id!==input.checkNote&&note.revision>(input.heads[note.id]??0)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
}
/** Point the note's real attachment links (never code examples) at the returned copies. */
function relink(markdown:string,assets:Map<string,string>,folder:string):string {
  let out=markdown
  for(const span of brainAttachmentSpans(markdown).reverse()){
    const asset=assets.get((span.wiki?'wiki:':'markdown:')+span.address)
    if(asset)out=out.slice(0,span.from)+(span.wiki?folder+'/'+asset:asset)+out.slice(span.to)
  }
  return out
}

/** The exact files a return writes, derived only from the frozen projection and its verified objects. */
function planBrainReturn(input:BrainReturnStageInput):{manifest:BrainReturnManifest;contents:Map<string,Buffer>} {
  const manifest:BrainReturnManifest={version:2,cutoverId:input.cutoverId,files:{},notes:[]},contents=new Map<string,Buffer>()
  const folder='inbox/'+brainReturnFolderName(input.cutoverId),used=new Set<string>()
  const add=(name:string,body:Buffer):void=>{contents.set(name,body);manifest.files[name]=sha256(body)}
  for(const head of changedNotes(input)){
    const version=input.projection.versions.find(row=>row.note===head.id&&row.revision===head.revision)
    if(!version||sha256(version.markdown)!==version.checksum)throw new Error('Brain return has no verified revision for '+head.id)
    let file=brainReturnSlug(version.title)+'-'+head.id.slice(0,8)+'.md'
    for(let n=2;used.has(file);n++)file=brainReturnSlug(version.title)+'-'+head.id.slice(0,8)+'-'+n+'.md'
    used.add(file)
    const attachments:Record<string,string>={},missing:string[]=[],byReference=new Map<string,string>()
    for(const row of input.projection.attachments.filter(row=>row.note===head.id&&row.revision===head.revision)){
      if(row.state!=='captured'||row.hash===null||row.size===null){missing.push(row.path);continue}
      const bytes=readFileSync(join(input.objects,row.hash))
      if(bytes.length!==row.size||sha256(bytes)!==row.hash)throw new Error('Brain return attachment object changed: '+row.path)
      const suffix=/^\.[a-z0-9]{1,10}$/.test(extname(row.path).toLowerCase())?extname(row.path).toLowerCase():'.bin'
      const asset='assets/'+row.hash+suffix
      if(!contents.has(asset))add(asset,bytes)
      attachments[row.path]=asset
      byReference.set(row.reference??'markdown:'+row.path,asset)
    }
    const front=['---',
      'bmn_brain_id: '+JSON.stringify(head.id),'bmn_brain_revision: '+head.revision,'bmn_brain_status: '+JSON.stringify(version.status),
      'title: '+JSON.stringify(version.title),'kind: '+JSON.stringify(version.kind),'origin: '+JSON.stringify(version.origin),'scope: '+JSON.stringify(version.scope),
      'recorded_at: '+JSON.stringify(version.recorded_at),
      ...(head.import_source?['edits_vault_note: '+JSON.stringify(head.import_source)]:[]),
      ...(version.superseded_by?['superseded_by: '+JSON.stringify(version.superseded_by)]:[]),
      ...(Object.keys(attachments).length?['attachments: '+JSON.stringify(attachments)]:[]),
      ...(missing.length?['attachments_not_captured: '+JSON.stringify(missing)]:[]),
      '---',''].join('\n')
    add(file,Buffer.from(front+relink(version.markdown,byReference,folder)))
    manifest.notes.push({id:head.id,revision:head.revision,file,status:version.status,importSource:head.import_source??null})
  }
  add('README.md',Buffer.from(['# Notes from the BMN brain','','Written or changed in BMN after the switch; copied back on the return to Obsidian.',
    'An edited vault note keeps its original file; its BMN version is here, named in `edits_vault_note`.','',
    ...manifest.notes.map(n=>'- [['+n.file.slice(0,-3)+']] '+n.status+(n.importSource?' (edits '+n.importSource+')':'')),''].join('\n')))
  return {manifest,contents}
}

/**
 * Write every note changed after the switch as new Markdown, rebuilt from its recorded head revision and that
 * revision's captured attachment objects, never from today's files. A saved stage is reused only when its
 * manifest is exactly what the frozen projection produces now.
 */
export function stageBrainReturn(input:BrainReturnStageInput):BrainReturnManifest {
  const {manifest,contents}=planBrainReturn(input)
  if(existsSync(input.stage)){
    const saved=JSON.parse(readFileSync(join(input.stage,'.manifest.json'),'utf8')) as BrainReturnManifest
    if(manifestText(saved)!==manifestText(manifest))throw new Error('Brain return stage belongs to another switch or differs from the frozen snapshot')
    verifyBrainReturnFolder(input.stage,manifest)
    return manifest
  }
  const temp=input.stage+'.'+randomUUID()+'.tmp'
  mkdirSync(temp,{recursive:true,mode:0o700})
  try{
    for(const [name,body] of contents){const path=join(temp,name);mkdirSync(join(path,'..'),{recursive:true,mode:0o700});writeFileSync(path,body,{flag:'wx',mode:0o600});syncPath(path)}
    writeFileSync(join(temp,'.manifest.json'),manifestText(manifest),{flag:'wx',mode:0o600});syncPath(join(temp,'.manifest.json'));syncPath(temp)
    renameSync(temp,input.stage);syncPath(join(input.stage,'..'))
  }catch(error){rmSync(temp,{recursive:true,force:true});throw error}
  verifyBrainReturnFolder(input.stage,manifest)
  return manifest
}

/** Exactly the manifest's files with their hashes, plus the manifest's own exact text; anything else is a conflict. */
export function verifyBrainReturnFolder(folder:string,manifest:BrainReturnManifest):void {
  for(const name of Object.keys(manifest.files))if(!name||name.startsWith('/')||name.includes('\\')||posix.normalize(name)!==name||name.startsWith('..')||name==='.manifest.json')throw new Error('Brain return manifest names an unsafe path: '+name)
  const expected=[...Object.keys(manifest.files),'.manifest.json'].sort(),actual=listFiles(folder)
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Brain return folder differs from its manifest: '+folder)
  if(readFileSync(join(folder,'.manifest.json'),'utf8')!==manifestText(manifest))throw new Error('Brain return file changed: .manifest.json')
  for(const [name,hash] of Object.entries(manifest.files))if(sha256(readFileSync(join(folder,name)))!==hash)throw new Error('Brain return file changed: '+name)
}

/**
 * Copy the staged folder into `<vault>/inbox/<name>` as one new folder. Nothing in the vault is replaced: the final
 * rename refuses an existing target, a retry adopts only a folder that verifies against this manifest.
 */
export function publishBrainReturn(stage:string,vault:string,manifest:BrainReturnManifest,rename:BrainReturnRename,mode=0o644):string {
  const inbox=join(vault,'inbox'),target=join(inbox,brainReturnFolderName(manifest.cutoverId))
  if(!manifest.notes.length)return ''
  verifyBrainReturnFolder(stage,manifest)
  if(existsSync(target)){verifyBrainReturnFolder(target,manifest);return target}
  mkdirSync(inbox,{recursive:true,mode:0o755})
  const temp=join(inbox,'.'+brainReturnFolderName(manifest.cutoverId)+'.'+randomUUID()+'.tmp')
  mkdirSync(temp,{mode:0o755})
  try{
    for(const name of [...Object.keys(manifest.files),'.manifest.json']){
      const destination=join(temp,name);mkdirSync(join(destination,'..'),{recursive:true,mode:0o755})
      copyFileSync(join(stage,name),destination,constants.COPYFILE_EXCL);chmodSync(destination,mode)
      syncPath(destination)
    }
    verifyBrainReturnFolder(temp,manifest);syncPath(temp)
    rename(temp,target);syncPath(inbox)
  }catch(error){
    rmSync(temp,{recursive:true,force:true})
    if(!existsSync(target))throw error
    // Only a folder holding exactly this return is adopted; anything else at the name holds the return.
    verifyBrainReturnFolder(target,manifest)
  }
  verifyBrainReturnFolder(target,manifest)
  return target
}
