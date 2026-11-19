// MODULE: brain-cutover-journal.ts - One durable journal and rollback for the owner-authorized move
import {createHash,randomUUID} from 'node:crypto'
import type {BrainAtomicRename} from './brain-cutover-files'
import type {BrainCutoverSkills,BrainSkillOwnership} from '../../bin/brain-cutover-skills.mjs'
import {brainJournalCommit,type BrainCommitReceipt} from '../../bin/brain-state.mjs'
import {constants,fchmodSync,fstatSync,ftruncateSync,chmodSync,closeSync,cpSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,readlinkSync,renameSync,symlinkSync,writeFileSync} from 'node:fs'
import type {Stats} from 'node:fs'
import {basename,dirname,join,relative} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {prepareVaultImport,vaultManifest,type BrainLabel,type BrainProjectHome} from './brain-import'
import {protectedVaultManifest,type BrainProtectedManifest} from './brain-protected-vault'
import {publishBrainReturn,stageBrainReturn,type BrainReturnManifest} from './brain-return'
import type {CutoverRulesOwnership} from '../../bin/agents-rules.mjs'
import type {BrainImport} from './brain-store'
import type {BrainWorkerClient} from './brain-client'
export interface BrainCheckIntent {note:string;attempt:string;title:string;body:string}
export interface BrainCutoverPaths {home:string;vault:string;journal:string;master:string;claudeRules:string;codexRules:string;claudeSkill:string;codexSkill:string;managedSkill:string;shippedSkill:string;indexes:string[]}
interface FileRestoreIntent {temporary:string;phase:'planned'|'writing'|'staged'|'restored';original:string;written:string;targetDev:number;targetIno:number;device?:number;inode?:number;abandoned?:{temporary:string;device:number;inode:number}[]}
interface SavedFile {held?:{path:string;dev:number;ino:number};restore?:FileRestoreIntent;path:string;backup:string|null;mode:number;link?:string;folder?:boolean;original?:string;written?:string;allowMissing?:boolean}
export interface BrainTimerState {enabled:boolean;active:boolean;identity?:string}
export type BrainTimerStates=Record<string,BrainTimerState>
export interface BrainTimerProgress {identity:string;state:Pick<BrainTimerState,'enabled'|'active'>;after?:Pick<BrainTimerState,'enabled'|'active'>}
export type BrainTimerProgressMap=Record<string,BrainTimerProgress>
interface Journal {returnManifest?:BrainReturnManifest;returnFolder?:string;returnLift?:{path:string;mode:number}[];returnInboxCreated?:boolean;timerProgress?:BrainTimerProgressMap;recoveryWritten?:Record<string,string>;checkIntent?:BrainCheckIntent;preImportCheckpoint?:string;importProof?:unknown;version:1;cutoverId?:string;commit?:BrainCommitReceipt;state:'running'|'complete'|'rolling-back'|'rolled-back';phases:string[];saved:SavedFile[];modes:{path:string;mode:number;dev?:number;ino?:number}[];timers:BrainTimerStates;manifest:Record<string,string>|null;protectedManifest?:BrainProtectedManifest;watermark:string;paths?:BrainCutoverPaths;preparation?:unknown;instructionProof?:unknown;brainHeads?:Record<string,number>;delivered?:boolean;checks?:unknown;skills?:BrainSkillOwnership;rules?:CutoverRulesOwnership;originatingCommit?:string;error?:string}
const missingEntry=JSON.stringify(['missing'])
export function brainAbsentRestoreIntent(allowMissing:unknown,intent:{targetDev:unknown;targetIno:unknown;written:unknown}):boolean {
 return allowMissing===true&&intent.targetDev===0&&intent.targetIno===0&&intent.written===missingEntry
}
export const BRAIN_MEMORY_POINTER='\n~/brain read-only; bmn brain.\n'
export function durableBrainJson(path:string,value:unknown):void {
 const text=JSON.stringify(value,null,2)+'\n';mkdirSync(dirname(path),{recursive:true,mode:0o700})
 const temporary=path+'.'+randomUUID()+'.tmp';const fd=openSync(temporary,'wx',0o600)
 try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}
 renameSync(temporary,path);if(readFileSync(path,'utf8')!==text)throw new Error('Brain journal read-back failed')
 const directory=openSync(dirname(path),'r');try{fsyncSync(directory)}finally{closeSync(directory)}
}
export interface BrainCutoverOperations {
 skills:BrainCutoverSkills
 atomicRename(request:BrainAtomicRename):void
 guard():void
 decide(payloadHash:string):Promise<void>
 commit():void
 brain:Pick<BrainWorkerClient,'admission'|'commitCutover'|'resumeCutover'|'setWriteDoor'|'importNotes'|'list'|'read'|'export'|'backup'|'restoreCheck'|'returnCapture'>
 pauseWriters(record:(state:BrainTimerStates)=>void,progress:(name:string,state:BrainTimerProgress)=>void):Promise<void>
 preflightTimers?(state:BrainTimerStates,progress:BrainTimerProgressMap):Promise<void>
 preflightRules?(owned:CutoverRulesOwnership):Promise<void>
 restoreTimers(state:BrainTimerStates,prior:BrainTimerProgressMap,progress:(name:string,state:BrainTimerProgress)=>void):Promise<void>
 writers():Promise<{blockers:unknown[];unknown:number[]}>
 rulesAdmission?(work:()=>Promise<void>):Promise<void>
 rollbackRules?(owned:CutoverRulesOwnership):Promise<void>
 renderRules(record:(owned:CutoverRulesOwnership)=>void):Promise<void>
 instructionProof():Promise<unknown>
 installedProof(intent:BrainCheckIntent):Promise<unknown>
 recoverCheck?(intent:BrainCheckIntent):Promise<unknown>
 importProof?(current:string,notes:BrainImport[]):Promise<unknown>
 afterSwitch(checks:unknown,originatingCommit?:string):Promise<void>
 now?():number
 sleep?(milliseconds:number):Promise<void>
}
export class BrainCutoverJournal {
 private readonly file:string
 private state:Journal
 constructor(private readonly paths:BrainCutoverPaths,private readonly operations:BrainCutoverOperations,preparation?:unknown,originatingCommit?:string,recovered?:unknown) {
  this.file=join(paths.journal,'journal.json')
  this.state=recovered!==undefined?recovered as Journal:existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')) as Journal:{version:1,cutoverId:randomUUID(),state:'running',phases:[],saved:[],modes:[],timers:{},manifest:null,watermark:new Date().toISOString(),paths,...(originatingCommit===undefined?{}:{originatingCommit}),...(preparation===undefined?{}:{preparation})}
 }
 private save(){durableBrainJson(this.file,this.state)}
 private recordTimer=(name:string,progress:BrainTimerProgress):void=>{
  this.state.timerProgress??={};this.state.timerProgress[name]=progress;this.save()
 }
 private phase(name:string){if(name!=='rollback')this.operations.guard();this.state.phases.push(name);this.save()}
 private remember(path:string):void {
  if(this.state.saved.some(s=>s.path===path))return
  const original=brainPathFingerprint(path)
  let entry:SavedFile
  if(!existsSync(path)&&!safeLink(path))entry={path,backup:null,mode:0o600}
  else {
   const stat=lstatSync(path);const backup=join(this.paths.journal,'saved',String(this.state.saved.length));mkdirSync(dirname(backup),{recursive:true,mode:0o700})
   if(stat.isSymbolicLink())entry={path,backup:null,mode:stat.mode&0o7777,link:readlinkSync(path)}
   else{cpSync(path,backup,{recursive:stat.isDirectory(),dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});entry={path,backup,mode:stat.mode&0o7777,folder:stat.isDirectory()}}
  }
  if(brainPathFingerprint(path)!==original||entry.backup&&brainPathFingerprint(entry.backup)!==original)throw new Error('Cutover target changed while its backup was captured')
  if(entry.backup){syncBrainTree(entry.backup);syncBrainDirectory(dirname(entry.backup))}
  entry.original=original;this.state.saved.push(entry);this.save()
 }
 private planned(path:string,written:string,allowMissing=false):void {
  const saved=this.state.saved.find(s=>s.path===path)
  if(!saved)throw new Error('Missing cutover target backup')
  saved.written=written;saved.allowMissing=allowMissing;this.save()
 }
 private rules(work:()=>Promise<void>):Promise<void>{return this.operations.rulesAdmission?this.operations.rulesAdmission(work):work()}
 private barrier():void {
  const visit=(path:string):void=>{
   const stat=lstatSync(path);if(stat.isSymbolicLink())return
   const child=relative(this.paths.vault,path);if(['files','.git'].some(p=>child===p||child.startsWith(p+'/')))return
   if(!this.state.modes.some(m=>m.path===path)){this.state.modes.push({path,mode:stat.mode&0o7777,dev:stat.dev,ino:stat.ino});this.save()}
   // Close directories first: a new path cannot race the walk.
   chmodSync(path,(stat.mode&0o7777)&~0o222)
   if(stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name))
  };visit(this.paths.vault)
 }
 private verifyBarrier():void {
  for(const entry of this.state.modes){const stat=lstatSync(entry.path);if(stat.isSymbolicLink()||stat.mode&0o222||entry.dev!==stat.dev||entry.ino!==stat.ino)throw new Error('The vault write barrier or inode changed')}
 }
 async run(labels:BrainLabel[],projects:BrainProjectHome[],changes:{before:string;after:string}[]):Promise<unknown> {
  if(existsSync(this.file))throw new Error('An earlier brain cutover journal must be recovered first')
  const vault=lstatSync(this.paths.vault);if(!vault.isDirectory()||vault.isSymbolicLink())throw new Error('The vault must be a real directory for the write barrier')
  const initialAdmission=await this.operations.brain.admission()
  if(initialAdmission.receipt)throw new Error('An earlier brain receipt must be recovered first')
  this.save()
  let publicationAttempted=false,published=false
  try {
   await this.operations.brain.setWriteDoor(false)
   await this.rules(async()=>{this.state.skills=this.operations.skills.prepare();this.save()})
   this.state.instructionProof=await this.operations.instructionProof();this.phase('instruction-proof')
   // Record original timers before stopping any of them.
   await this.operations.pauseWriters(state=>{this.state.timers=state;this.save()},this.recordTimer);this.phase('pause-writers')
   this.remember(join(this.paths.vault,'ARCHIVE.md'))
   const archive='# Brain archive\n\nThis vault is read-only. Use `bmn brain`; attachments stay in `files/`.\n'
   this.planned(join(this.paths.vault,'ARCHIVE.md'),brainTextFingerprint(archive,0o444))
   writeFileSync(join(this.paths.vault,'ARCHIVE.md'),archive,{flag:'wx',mode:0o444})
   this.barrier();this.phase('write-barrier')
   const now=this.operations.now??Date.now,sleep=this.operations.sleep??delay,deadline=now()+600_000
   for(;;){this.operations.guard();const writers=await this.operations.writers();if(!writers.blockers.length&&!writers.unknown.length)break;if(now()>=deadline)throw new Error('Vault writers or unreadable process handles did not drain within ten minutes');await sleep(250)}
   this.verifyBarrier();this.phase('drain')
   this.state.protectedManifest=await protectedVaultManifest(this.paths.vault,()=>this.operations.guard())
   this.state.manifest=vaultManifest(this.paths.vault);this.phase('manifest')
   const prepared=prepareVaultImport(this.paths.vault,labels,projects)
   if(JSON.stringify(prepared.manifest)!==JSON.stringify(this.state.manifest))throw new Error('Vault changed before import')
   const importedBatch=await this.operations.brain.importNotes(prepared.notes)
   if(!importedBatch.checkpoint)throw new Error('The pre-import checkpoint was not reported')
   this.state.preImportCheckpoint=importedBatch.checkpoint;this.phase('snapshot');this.phase('re-import')
   const current=await this.operations.brain.export()
   if(!this.operations.importProof)throw new Error('Actual published import file proof is required')
   this.state.importProof=await this.operations.importProof(current,prepared.notes);this.save()
   if(JSON.stringify(vaultManifest(this.paths.vault))!==JSON.stringify(this.state.manifest))throw new Error('Vault changed during import')
   this.verifyBarrier()
   if(JSON.stringify(await protectedVaultManifest(this.paths.vault,()=>this.operations.guard()))!==JSON.stringify(this.state.protectedManifest))throw new Error('Protected vault source changed during import')
   this.phase('source-proof')
   await this.rules(async()=>{
    for(const path of [this.paths.master,this.paths.claudeRules,this.paths.codexRules])this.remember(path)
    let master=readFileSync(this.paths.master,'utf8')
    const beforeBytes=Buffer.byteLength(master)
    for(const change of changes){if(master.split(change.before).length!==2)throw new Error('The reviewed master brain lines changed; no switch made');master=master.replace(change.before,change.after)}
    if(Buffer.byteLength(master)>=beforeBytes)throw new Error('The brain master wording did not get shorter')
    this.planned(this.paths.master,brainTextFingerprint(master,lstatSync(this.paths.master).mode&0o7777))
    durableBrainText(this.paths.master,master);this.phase('master')
    await this.operations.renderRules(owned=>{
     if(owned.targets.some(target=>![this.paths.claudeRules,this.paths.codexRules].includes(target.path)))throw new Error('The Rules target differs from the rehearsed inventory')
     this.state.rules=owned
     for(const target of owned.targets)this.planned(target.path,brainTextFingerprint(target.writtenText,target.mode))
     this.save()
    })
    // Synthetic operations without Rules transactions still record their final state.
    for(const path of [this.paths.claudeRules,this.paths.codexRules])if(!this.state.saved.find(s=>s.path===path)!.written)this.planned(path,brainPathFingerprint(path))
    this.phase('rendered-rules')
   })
   await this.rules(async()=>{
    const skills=this.state.skills!
    this.operations.skills.verify(skills)
    const links=skills.legacyCodexLink?[this.paths.claudeSkill]:[this.paths.claudeSkill,this.paths.codexSkill]
    for(const path of [...links,this.paths.managedSkill,...this.paths.indexes])this.remember(path)
    this.planned(this.paths.managedSkill,brainPathFingerprint(this.paths.shippedSkill),true)
    this.planned(this.paths.claudeSkill,JSON.stringify(['link',this.paths.managedSkill]),true)
    if(!skills.legacyCodexLink)this.planned(this.paths.codexSkill,JSON.stringify(['link',this.paths.claudeSkill]),true)
    for(const path of links){
     if(!existsSync(path)&&!safeLink(path))continue
     const stat=lstatSync(path),index=this.state.saved.findIndex(saved=>saved.path===path),saved=this.state.saved[index]!
     if(!stat.isDirectory()&&!stat.isSymbolicLink())throw new Error('The rehearsed legacy brain skill must be a folder or link')
     const held=join(this.paths.journal,'held',String(index));mkdirSync(dirname(held),{recursive:true,mode:0o700})
     saved.held={path:held,dev:stat.dev,ino:stat.ino};this.save();this.operations.guard()
     this.operations.atomicRename({operation:'no-replace',source:path,target:held,sourceIdentity:{dev:stat.dev,ino:stat.ino},targetIdentity:null})
    }
    this.operations.skills.install(skills,proof=>{this.operations.guard();this.state.skills=proof;this.save()})
    for(const path of [this.paths.managedSkill,...links]){
     const saved=this.state.saved.find(saved=>saved.path===path)!
     if(brainPathFingerprint(path)!==saved.written)throw new Error('Normal brain skill installation differs from its journal plan')
     syncBrainTree(path);syncBrainDirectory(dirname(path))
    }
   });this.phase('skill');this.phase('codex-link')
   for(const index of this.paths.indexes){const body=readFileSync(index,'utf8');if(!body.includes(BRAIN_MEMORY_POINTER.trim())){this.planned(index,brainTextFingerprint(body+BRAIN_MEMORY_POINTER,lstatSync(index).mode&0o7777));durableBrainText(index,body+BRAIN_MEMORY_POINTER)}}
   this.phase('memory-indexes');this.phase('timers');this.phase('modes')
   this.state.brainHeads=Object.fromEntries((await this.operations.brain.list()).map(n=>[n.id,n.revision]));this.save()
   await this.operations.brain.setWriteDoor(true);this.phase('write-door')
   const attempt='owner-cutover-'+randomUUID()
   this.state.checkIntent={note:randomUUID(),attempt,title:'cutover-check '+attempt.slice(-12),body:'Installed brain write/read/export check.'};this.save()
   this.state.checks=await this.operations.installedProof(this.state.checkIntent);this.phase('installed-checks')
   if(JSON.stringify(await protectedVaultManifest(this.paths.vault,()=>this.operations.guard()))!==JSON.stringify(this.state.protectedManifest))throw new Error('Protected vault source changed after switch')
   this.verifyBarrier();this.operations.guard()
   const skillProof=this.state.skills!
   if(skillProof.legacyCodexLink)await this.rules(async()=>{this.operations.skills.verify(skillProof)})
   this.state.commit=brainJournalCommit(this.state,initialAdmission.storeId);this.save()
   this.operations.guard();await this.operations.decide(this.state.commit.payloadHash);publicationAttempted=true
   const committed=await this.operations.brain.commitCutover(this.state.commit.payloadHash)
   if(!committed.committed)throw new Error('The brain worker did not publish its commit receipt')
   published=true;this.state.state='complete';this.state.phases.push('complete');this.save()
   await this.operations.brain.resumeCutover()
   this.operations.commit()
   await this.deliver()
   return {ok:true,phases:this.state.phases}
  }catch(error){
   this.state.error=error instanceof Error?error.message:'Brain cutover failed'
   try{this.save()}catch{/* Recovery must still run when diagnostic storage is unavailable. */}
   if(publicationAttempted&&!published){
    const current=await this.operations.brain.admission().catch(()=>null)
    if(!current)throw new Error('The brain commit result is uncertain; trusted recovery must resolve it with writes held',{cause:error})
    if(!current.committed&&(current.receiptState!=='absent'||current.open))throw new Error('The brain commit result is not a definitive absence; writes stay held',{cause:error})
    published=current.committed
   }
   if(!published&&this.state.state!=='complete')try{await this.rollback()}catch(recovery){throw new Error('Brain rollback incomplete after '+(error instanceof Error?error.message:'cutover failure')+': '+(recovery instanceof Error?recovery.message:'recovery failed'),{cause:recovery})}
   throw error
  }
 }
 async resumeCommitted():Promise<void> {
  if(!(await this.operations.brain.admission()).committed)throw new Error('The brain commit receipt does not match the saved journal')
  if(this.state.state!=='complete'){this.state.state='complete';this.state.phases.push('complete');this.save()}
  await this.operations.brain.resumeCutover()
 }
 async deliver():Promise<void> {
  if(this.state.state!=='complete'||this.state.delivered)return
  if(!(await this.operations.brain.admission()).committed)throw new Error('Brain completion reporting requires the current matching receipt')
  await this.operations.afterSwitch(this.state.checks,this.state.originatingCommit);this.state.delivered=true;this.save()
 }
 private restoreFile(saved:SavedFile,current:string,original:string):void {
  if(!saved.backup||saved.folder)throw new Error('A regular-file backup is required')
  const owned=lstatSync(saved.path)
  if(!owned.isFile()||owned.isSymbolicLink())throw new Error('Rollback conflict: regular target changed '+saved.path)
  if(!saved.restore){
   saved.restore={temporary:brainRestorePrefix(saved.path)+randomUUID(),phase:'planned',original,written:current,targetDev:owned.dev,targetIno:owned.ino};this.save()
  }
  const intent=saved.restore
  if(intent.original!==original||intent.written!==current||owned.dev!==intent.targetDev||owned.ino!==intent.targetIno)throw new Error('Rollback conflict: restore intent or target inode changed '+saved.path)
  let created=false,fd:number
  try{fd=openSync(intent.temporary,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;fd=openSync(intent.temporary,constants.O_RDWR|constants.O_NOFOLLOW)}
  try{
   const stat=fstatSync(fd)
   if(!stat.isFile()||stat.uid!==process.getuid?.())throw new Error('Rollback conflict: restore staging entry changed')
   if(!created&&(intent.device===undefined||intent.inode===undefined)&&!(intent.phase==='planned'&&stat.size===0&&(stat.mode&0o7777)===0o600))throw new Error('Rollback conflict: unowned restore staging entry')
   if(!created&&intent.device!==undefined&&(stat.dev!==intent.device||stat.ino!==intent.inode))throw new Error('Rollback conflict: restore staging inode changed')
   if(created||intent.device===undefined){
    intent.device=stat.dev;intent.inode=stat.ino;fchmodSync(fd,0o600);fsyncSync(fd);syncBrainDirectory(dirname(saved.path));this.save()
   }
   if(intent.phase==='staged'){
    if(brainPathFingerprint(intent.temporary)!==original)throw new Error('Rollback conflict: completed restore staging bytes changed')
   }else{
    intent.phase='writing';this.save()
    const source=openSync(saved.backup,constants.O_RDONLY|constants.O_NOFOLLOW)
    let bytes:Buffer
    try{
     const before=fstatSync(source)
     if(!before.isFile())throw new Error('Rollback backup is not a regular file')
     bytes=readFileSync(source)
     const after=fstatSync(source)
     if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Rollback backup changed while reading')
    }finally{closeSync(source)}
    if(JSON.stringify(['file',saved.mode,createHash('sha256').update(bytes).digest('hex')])!==original)throw new Error('Rollback backup fingerprint differs')
    ftruncateSync(fd,0);writeFileSync(fd,bytes);fchmodSync(fd,saved.mode);fsyncSync(fd)
    if(brainPathFingerprint(intent.temporary)!==original)throw new Error('Rollback staging read-back failed')
    intent.phase='staged';this.save()
   }
  }finally{closeSync(fd)}
  const target=lstatSync(saved.path)
  if(target.dev!==intent.targetDev||target.ino!==intent.targetIno||brainPathFingerprint(saved.path)!==current)throw new Error('Rollback conflict: target changed before atomic replacement')
  this.operations.atomicRename({operation:'exchange',source:intent.temporary,target:saved.path,sourceIdentity:{dev:intent.device!,ino:intent.inode!},targetIdentity:{dev:intent.targetDev,ino:intent.targetIno}})
  this.finishRestore(saved,original)
 }
 private finishRestore(saved:SavedFile,original:string):void {
  const intent=saved.restore
  if(!intent)return
  if(brainPathFingerprint(saved.path)!==original)throw new Error('Rollback target read-back failed')
  if(intent.targetIno!==0){
   const displaced=lstatSync(intent.temporary)
   if(displaced.dev!==intent.targetDev||displaced.ino!==intent.targetIno||brainPathFingerprint(intent.temporary)!==intent.written)throw new Error('Rollback conflict: displaced entry changed; preserved at '+intent.temporary)
  }
  if(original!==JSON.stringify(['missing'])&&intent.device!==undefined){
   const installed=lstatSync(saved.path)
   if(installed.dev!==intent.device||installed.ino!==intent.inode)throw new Error('Rollback conflict: restored inode changed')
  }
  intent.phase='restored';this.save()
 }
 private restoreEntry(saved:SavedFile,current:string,original:string):void {
  const missing=JSON.stringify(['missing'])
  let owned:Stats|undefined
  try{owned=lstatSync(saved.path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(!saved.restore){
   saved.restore={temporary:brainRestorePrefix(saved.path)+randomUUID(),phase:'planned',original,written:current,targetDev:owned?.dev??0,targetIno:owned?.ino??0};this.save()
  }
  const intent=saved.restore
  if(intent.original!==original||intent.written!==current||intent.targetDev!==(owned?.dev??0)||intent.targetIno!==(owned?.ino??0))throw new Error('Rollback conflict: restore entry identity changed')
  if(original===missing){
   if(!owned)throw new Error('Rollback conflict: missing owned removal target')
   this.operations.atomicRename({operation:'no-replace',source:saved.path,target:intent.temporary,sourceIdentity:{dev:owned.dev,ino:owned.ino},targetIdentity:null})
   this.finishRestore(saved,original);return
  }
  if(saved.link===undefined&&(!saved.backup||!saved.folder))throw new Error('A directory or symlink backup is required')
  // A partially copied stage is never deleted or confused with the live skill.
  // Retain it under its recorded nonce and prepare a fresh copy on the next recovery.
  if(existsSync(intent.temporary)||safeLink(intent.temporary)){
   const stage=lstatSync(intent.temporary)
   if(intent.device!==undefined&&(stage.dev!==intent.device||stage.ino!==intent.inode))throw new Error('Rollback conflict: restore staging inode changed')
   if(brainPathFingerprint(intent.temporary)!==original){
    if(intent.phase!=='writing'||intent.device!==undefined)throw new Error('Rollback conflict: restore staging entry changed')
    intent.abandoned??=[];intent.abandoned.push({temporary:intent.temporary,device:stage.dev,inode:stage.ino});intent.temporary=brainRestorePrefix(saved.path)+randomUUID();this.save()
   }
  }
  if(!existsSync(intent.temporary)&&!safeLink(intent.temporary)){
   intent.phase='writing';this.save()
   if(saved.link!==undefined)symlinkSync(saved.link,intent.temporary)
   else{
    if(brainPathFingerprint(saved.backup!)!==original)throw new Error('Rollback backup changed')
    cpSync(saved.backup!,intent.temporary,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false})
    if(brainPathFingerprint(saved.backup!)!==original)throw new Error('Rollback backup changed during staging')
   }
  }
  if(brainPathFingerprint(intent.temporary)!==original)throw new Error('Rollback staging read-back failed')
  syncBrainTree(intent.temporary);syncBrainDirectory(dirname(saved.path))
  const stage=lstatSync(intent.temporary);intent.device=stage.dev;intent.inode=stage.ino;intent.phase='staged';this.save()
  if(brainPathFingerprint(saved.path)!==current)throw new Error('Rollback conflict: target changed before atomic exchange')
  this.operations.atomicRename({operation:owned?'exchange':'no-replace',source:intent.temporary,target:saved.path,sourceIdentity:{dev:stage.dev,ino:stage.ino},targetIdentity:owned?{dev:owned.dev,ino:owned.ino}:null})
  this.finishRestore(saved,original)
 }

 // A return to an absent path needs no copied stage. The held inode proves both
 // the pending rename and a completed rename whose reply or journal save was lost.
 private heldRestoreState(saved:SavedFile):'returned'|'return-to-absent'|null {
  const held=saved.held
  if(!held)return null
  const atHeld=brainOptionalEntry(held.path),atTarget=brainOptionalEntry(saved.path)
  const same=(entry:Stats|undefined)=>entry?.dev===held.dev&&entry.ino===held.ino
  if(atHeld&&(!same(atHeld)||brainPathFingerprint(held.path)!==saved.original))throw new Error('Rollback conflict: held legacy entry changed '+saved.path)
  if(!atHeld){
   if(!same(atTarget)||brainPathFingerprint(saved.path)!==saved.original)throw new Error('Rollback conflict: original held inode is missing '+saved.path)
   if(saved.restore&&!brainAbsentRestoreIntent(saved.allowMissing,saved.restore))throw new Error('Rollback conflict: unexpected restoration of held entry '+saved.path)
   return 'returned'
  }
  if(atTarget){
   const intent=saved.restore
   if(brainPathFingerprint(saved.path)===saved.original&&saved.original!==saved.written&&
     !(intent?.device===atTarget.dev&&intent.inode===atTarget.ino))throw new Error('Rollback conflict: original bytes at the wrong inode '+saved.path)
   return null
  }
  if(!saved.allowMissing||saved.restore&&!brainAbsentRestoreIntent(saved.allowMissing,saved.restore))throw new Error('Rollback conflict: held skill target disappeared '+saved.path)
  return 'return-to-absent'
 }

 private recoveryRestored():string[] {
  const restored:string[]=[]
  for(const saved of this.state.saved){
   if(this.heldRestoreState(saved)==='returned'){restored.push(saved.path);continue}
   if(!saved.restore||brainPathFingerprint(saved.path)!==saved.original)continue
   const intent=saved.restore
   if(intent.targetIno!==0){const displaced=lstatSync(intent.temporary);if(displaced.dev!==intent.targetDev||displaced.ino!==intent.targetIno||brainPathFingerprint(intent.temporary)!==intent.written)throw new Error('Rollback conflict: displaced entry changed '+intent.temporary)}
   if(saved.original!==JSON.stringify(['missing'])){const target=lstatSync(saved.path);if(target.dev!==intent.device||target.ino!==intent.inode)throw new Error('Rollback conflict: restored inode changed '+saved.path)}
   restored.push(saved.path)
  }
  return restored
 }
 private async preflightRecovery():Promise<void> {
  const restored=this.recoveryRestored(),successors=this.state.skills?this.operations.skills.verify(this.state.skills,restored):[]
  for(const item of this.state.modes){
   let stat:Stats
   try{stat=lstatSync(item.path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&this.state.saved.some(saved=>saved.path===item.path&&saved.original===JSON.stringify(['missing'])))continue;throw error}
   const mode=stat.mode&0o7777
   if(stat.isSymbolicLink()||item.dev!==stat.dev||item.ino!==stat.ino||mode!==item.mode&&mode!==(item.mode&~0o222))throw new Error('Rollback conflict: vault inode or mode changed '+item.path)
  }
  for(const saved of this.state.saved){
   const original=saved.original??(saved.link!==undefined?JSON.stringify(['link',saved.link]):saved.backup?brainPathFingerprint(saved.backup):JSON.stringify(['missing']))
   if(saved.backup&&brainPathFingerprint(saved.backup)!==original)throw new Error('Rollback conflict: saved backup changed '+saved.path)
   this.heldRestoreState(saved)
   const current=brainPathFingerprint(saved.path),written=this.state.recoveryWritten?.[saved.path]??saved.written
   if(saved.restore){
    const intent=saved.restore
    const absent=brainAbsentRestoreIntent(saved.allowMissing,intent)
    if(intent.original!==original||!absent&&intent.written!==written)throw new Error('Rollback conflict: staging evidence changed '+saved.path)
    if(!restored.includes(saved.path)){
     const target=brainOptionalEntry(saved.path)
     if((target?.dev??0)!==intent.targetDev||(target?.ino??0)!==intent.targetIno)throw new Error('Rollback conflict: target inode changed '+saved.path)
     if(existsSync(intent.temporary)||safeLink(intent.temporary)){const stage=lstatSync(intent.temporary);if(intent.device!==undefined&&(stage.dev!==intent.device||stage.ino!==intent.inode)||intent.phase==='staged'&&brainPathFingerprint(intent.temporary)!==original)throw new Error('Rollback conflict: stage changed '+saved.path)}
    }
   }
   if(current===original)continue
   if(this.paths.indexes.includes(saved.path)&&saved.backup&&existsSync(saved.path)){
    const body=readFileSync(saved.path,'utf8'),prior=readFileSync(saved.backup,'utf8')
    if(!body.includes(BRAIN_MEMORY_POINTER)||body===prior+BRAIN_MEMORY_POINTER||body.split(BRAIN_MEMORY_POINTER).length===2)continue
   }
   if(current===written||saved.allowMissing&&current===JSON.stringify(['missing']))continue
   if(successors.includes(saved.path)&&!saved.restore){this.state.recoveryWritten??={};this.state.recoveryWritten[saved.path]=current;continue}
   throw new Error('Rollback conflict: independently changed '+saved.path)
  }
  if(this.state.rules)await this.operations.preflightRules?.(this.state.rules)
  await this.operations.preflightTimers?.(this.state.timers,this.state.timerProgress??{})
  this.save()
 }

 /** Re-holds whatever an interrupted publish left open, before anything else in the return runs. */
 private reholdReturnLift():void {
  for(const item of this.state.returnLift??[])if(existsSync(item.path))chmodSync(item.path,item.mode)
  if(this.state.returnLift){delete this.state.returnLift;this.save()}
 }
 /**
  * Opens only the inbox (or the vault root while creating a new inbox) for one no-replace publish and holds it
  * again afterwards. What it opens is journalled first, so a crash in between is re-held on the next attempt.
  */
 private publishReturn():void {
  const inbox=join(this.paths.vault,'inbox'),opens:{path:string;open:number;held:number}[]=[]
  const recorded=(path:string)=>{
   const item=this.state.modes.find(row=>row.path===path),stat=lstatSync(path)
   if(!item)return undefined
   if(stat.isSymbolicLink()||item.dev!==stat.dev||item.ino!==stat.ino||![item.mode,item.mode&~0o222].includes(stat.mode&0o7777))throw new Error('Rollback conflict: vault inode or mode changed '+path)
   return {path,open:item.mode,held:item.mode&~0o222}
  }
  const creating=!existsSync(inbox)
  if(creating){const root=recorded(this.paths.vault);if(root)opens.push(root);opens.push({path:inbox,open:0o755,held:0o555})}
  else{const own=recorded(inbox)??(this.state.returnInboxCreated?{path:inbox,open:0o755,held:0o555}:undefined);if(own)opens.push(own)}
  this.state.returnLift=opens.map(item=>({path:item.path,mode:item.held}))
  if(creating)this.state.returnInboxCreated=true
  this.save()
  try{
   for(const item of opens)if(item.path!==inbox||!creating)chmodSync(item.path,item.open)
   if(creating)mkdirSync(inbox,{mode:0o755})
   const target=publishBrainReturn(join(this.paths.journal,'return-stage'),this.paths.vault,this.state.returnManifest!,(source,destination)=>{
    const stat=lstatSync(source)
    this.operations.atomicRename({operation:'no-replace',source,target:destination,sourceIdentity:{dev:stat.dev,ino:stat.ino},targetIdentity:null})
   })
   if(target&&this.state.returnFolder!==target)this.state.returnFolder=target
  }finally{this.reholdReturnLift()}
 }

 async rollback():Promise<void> {
  const admitted=await this.operations.brain.admission()
  if(this.state.state==='complete'&&!admitted.committed&&!admitted.retired)throw new Error('Whole brain recovery requires the matching current or retired worker receipt')
  // A committed switch returns only on the owner's confirmed return, recorded by the worker; a journal state alone never starts one.
  if(admitted.committed&&admitted.returnAuthorized!==this.state.cutoverId)throw new Error('The brain switch is complete and no confirmed return is recorded; recovery stays held')
  const errors:string[]=[]
  const attempt=async(work:()=>unknown|Promise<unknown>):Promise<void>=>{try{await work()}catch(error){errors.push(error instanceof Error?error.message:'Rollback operation failed')}}
  // The worker serializes this after every already admitted write. Its durable
  // revocation is mandatory before either old write path or timer can return.
  await this.operations.brain.setWriteDoor(false)
  this.state.state='rolling-back';this.save()
  this.reholdReturnLift()
  if(this.state.checkIntent){
   if(!this.operations.recoverCheck)throw new Error('Exact installed check recovery is required before rollback')
   await this.operations.recoverCheck(this.state.checkIntent)
  }
  try{
   // The frozen snapshot taken after the door closed is the return's only input; today's attachment files are not read.
   const capture=await this.operations.brain.returnCapture()
   const check=this.state.checkIntent?.note
   const changes=capture.projection.versions.filter(n=>this.state.brainHeads&&n.revision>(this.state.brainHeads[n.note]??0)&&n.note!==check)
   durableBrainJson(join(this.paths.journal,'brain-changes.json'),changes);durableBrainJson(join(this.paths.journal,'return-snapshot.json'),{snapshot:capture.snapshot})
   // Every post-switch note returns to Obsidian as new Markdown; the vault's own files are never replaced.
   if(this.state.brainHeads){
    const manifest=stageBrainReturn({projection:capture.projection,objects:capture.objects,heads:this.state.brainHeads,...(check?{checkNote:check}:{}),cutoverId:this.state.cutoverId??'unnamed',stage:join(this.paths.journal,'return-stage')})
    if(this.state.returnManifest&&JSON.stringify(this.state.returnManifest)!==JSON.stringify(manifest))throw new Error('Brain return stage differs from its journalled manifest')
    if(!this.state.returnManifest){this.state.returnManifest=manifest;this.save()}
   }
  }catch(error){
   // Without the durable delta the old setup stays held. A retry keeps all DB history.
   throw new Error('Brain rollback incomplete: post-switch capture failed',{cause:error})
  }
  await attempt(()=>this.rules(async()=>{
  await this.preflightRecovery()
  // Publish the returned notes while every old writer is still held; a failure here restores nothing.
  if(this.state.returnManifest?.notes.length)this.publishReturn()
  // Restore writable directory modes before restoring files. Preserve any newer index text.
  for(const item of this.state.modes)await attempt(()=>{
   let expected:ReturnType<typeof lstatSync>
   try{expected=lstatSync(item.path)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'&&this.state.saved.some(saved=>saved.path===item.path&&saved.original===JSON.stringify(['missing'])))return
    throw error
   }
   if(expected.isSymbolicLink()||item.dev!==expected.dev||item.ino!==expected.ino)throw new Error('Rollback conflict: vault inode changed '+item.path)
   const fd=openSync(item.path,constants.O_RDONLY|constants.O_NOFOLLOW|(expected.isDirectory()?constants.O_DIRECTORY:0))
   try{
    const stat=fstatSync(fd),mode=stat.mode&0o7777
    if(item.dev!==stat.dev||item.ino!==stat.ino||!(mode===item.mode||mode===(item.mode&~0o222)))throw new Error('Rollback conflict: vault inode or mode changed '+item.path)
    if(mode!==item.mode){fchmodSync(fd,item.mode);fsyncSync(fd)}
    if((fstatSync(fd).mode&0o7777)!==item.mode)throw new Error('Brain rollback mode read-back failed')
   }finally{closeSync(fd)}
  })
  const restore=(saved:SavedFile):void=>{
   const current=brainPathFingerprint(saved.path)
   const original=saved.original??(saved.link!==undefined?JSON.stringify(['link',saved.link]):saved.backup?brainPathFingerprint(saved.backup):JSON.stringify(['missing']))
   const heldState=this.heldRestoreState(saved)
   if(heldState){
    const held=saved.held!
    if(heldState==='return-to-absent'){
     this.operations.atomicRename({operation:'no-replace',source:held.path,target:saved.path,sourceIdentity:{dev:held.dev,ino:held.ino},targetIdentity:null})
     if(this.heldRestoreState(saved)!=='returned')throw new Error('Rollback conflict: held skill was not returned '+saved.path)
    }
    syncBrainDirectory(dirname(held.path));syncBrainDirectory(dirname(saved.path))
    return
   }
   if(current===original){if(saved.restore)this.finishRestore(saved,original);return}
   if(this.paths.indexes.includes(saved.path)&&existsSync(saved.path)&&saved.backup&&saved.written){
    const body=readFileSync(saved.path,'utf8'),prior=readFileSync(saved.backup,'utf8')
    if(!body.includes(BRAIN_MEMORY_POINTER))return // An earlier recovery already removed only our pointer.
    if(body!==prior+BRAIN_MEMORY_POINTER&&body.split(BRAIN_MEMORY_POINTER).length===2){durableBrainText(saved.path,body.replace(BRAIN_MEMORY_POINTER,''));return}
   }
   const written=this.state.recoveryWritten?.[saved.path]??saved.written
   if(written&&current!==written&&!(saved.allowMissing&&current===JSON.stringify(['missing'])))throw new Error('Rollback conflict: independently changed '+saved.path)
   if(!saved.written&&saved.original)throw new Error('Rollback conflict: no cutover write owns '+saved.path)
   if(saved.backup&&!saved.folder){this.restoreFile(saved,current,original);return}
   this.restoreEntry(saved,current,original)
  }
  // An inbox the return created was held like the vault; it opens with the vault.
  if(this.state.returnInboxCreated&&!errors.length)await attempt(()=>{const inbox=join(this.paths.vault,'inbox');if(existsSync(inbox))chmodSync(inbox,0o755)})
  for(const saved of [...this.state.saved].reverse())await attempt(()=>restore(saved))
  if(this.state.rules&&this.operations.rollbackRules)await attempt(()=>this.operations.rollbackRules!(this.state.rules!))
  if(this.state.skills&&!errors.length)await attempt(()=>this.operations.skills.rollback(this.state.skills!,proof=>{this.state.skills=proof;this.save()},this.recoveryRestored()))
  }))
  if(!errors.length)await attempt(()=>this.operations.restoreTimers(this.state.timers,this.state.timerProgress??{},this.recordTimer))
  if(errors.length){this.state.error=errors.join('; ');try{this.save()}catch{/* Durable worker revocation keeps admission held. */}throw new Error('Brain rollback incomplete: '+errors.join('; '))}
  this.state.state='rolled-back';this.phase('rollback')
 }
}
function syncBrainTree(path:string):void {
 const stat=lstatSync(path)
 if(stat.isSymbolicLink())return
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|(stat.isDirectory()?constants.O_DIRECTORY:0))
 try{
  const pinned=fstatSync(fd);if(pinned.dev!==stat.dev||pinned.ino!==stat.ino)throw new Error('Rollback staging inode changed during sync')
  if(stat.isDirectory())for(const name of readdirSync(path))syncBrainTree(join(path,name))
  fsyncSync(fd)
 }finally{closeSync(fd)}
}
function syncBrainDirectory(path:string):void {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd)}finally{closeSync(fd)}}
function brainOptionalEntry(path:string):Stats|undefined {
 try{return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
function safeLink(path:string):boolean {try{return lstatSync(path).isSymbolicLink()}catch{return false}}
export function durableBrainText(path:string,text:string):void {
 const temporary=path+'.'+randomUUID()+'.tmp',mode=existsSync(path)?lstatSync(path).mode&0o7777:0o600
 mkdirSync(dirname(path),{recursive:true,mode:0o700})
 writeFileSync(temporary,text,{mode,flag:'wx'});const fd=openSync(temporary,'r');try{fchmodSync(fd,mode);fsyncSync(fd)}finally{closeSync(fd)};renameSync(temporary,path);syncBrainDirectory(dirname(path))
 if(readFileSync(path,'utf8')!==text)throw new Error('Brain cutover text read-back failed')
}

export function brainRestorePrefix(path:string):string{return join(dirname(path),'.'+basename(path)+'.brain-restore-')}
export function brainTextFingerprint(text:string,mode:number):string {return JSON.stringify(['file',mode,createHash('sha256').update(text).digest('hex')])}
export function brainPathFingerprint(path:string):string {
 let stat:ReturnType<typeof lstatSync>
 try{stat=lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return JSON.stringify(['missing']);throw error}
 if(stat.isSymbolicLink())return JSON.stringify(['link',readlinkSync(path)])
 if(stat.isFile())return JSON.stringify(['file',stat.mode&0o7777,createHash('sha256').update(readFileSync(path)).digest('hex')])
 if(stat.isDirectory())return JSON.stringify(['directory',stat.mode&0o7777,readdirSync(path).sort().map(name=>[name,brainPathFingerprint(join(path,name))])])
 throw new Error('Unsupported cutover target type')
}
