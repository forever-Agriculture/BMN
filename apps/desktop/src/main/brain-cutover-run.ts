// MODULE: brain-cutover-run.ts - Plain local operations performed only after the window/service grant
import {brainAtomicRename} from '../utility/brain-cutover-files'
import {verifyBrainImportExport} from '../utility/brain-export-proof'
import {verifyInstalledBrainCheck} from './brain-installed-check'
import {deliverBrainCutover} from './brain-cutover-delivery'
import {assertBrainRecoveryPaths} from './brain-cutover-paths'
import {brainTimerTransitions,observeBrainTimer,type BrainTimerCommand} from './brain-cutover-timers'
import {brainReceiptMatches,managedBrainSkillPath} from '../../bin/brain-state.mjs'
import type {BrainAdmissionStatus} from '../utility/brain-admission'
import {brainStartTextGroups,validateBrainStartText,brainStartTextBytes,assertBrainStartTextDidNotGrow} from './brain-cutover-preparation'
import {assertBrainCutoverPermit,type BrainCutoverPermit} from './brain-cutover-authorization'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {BrainCutoverJournal,durableBrainJson,type BrainCutoverPaths} from '../utility/brain-cutover-journal'
import type {BrainWorkerClient} from '../utility/brain-client'
import type {BrainNote} from '../utility/brain-store'
import type {BrainLabel,BrainProjectHome} from '../utility/brain-import'
const execute=promisify(execFile)
declare const __BMN_BUILD_COMMIT__:string
interface CutoverConfiguration {
 version:1;labels:BrainLabel[];projects:BrainProjectHome[];changes:{before:string;after:string}[]
 indexes:string[];instructionLines:Record<string,string[]>;startText:{app:string;project:string;paths:string[]}[]
}
export function brainInstructionLines(home=homedir()):Record<string,string[]> {
 const paths=[join(home,'.config/bmn/agents/global-rules.md'),join(home,'.claude/CLAUDE.md'),join(home,'.codex/AGENTS.md'),join(home,'.claude/skills/brain/SKILL.md'),join(home,'.agents/skills/brain/SKILL.md'),join(home,'.codex/skills/brain/SKILL.md'),join(home,'brain/CLAUDE.md'),join(home,'code/Project2/b2buster-ai/CLAUDE.md')]
 paths.push(...brainStartTextGroups(home).flatMap(group=>group.paths))
 const memory=join(home,'.claude/projects')
 const visit=(folder:string):void=>{
  if(!existsSync(folder)||lstatSync(folder).isSymbolicLink()||!lstatSync(folder).isDirectory())return
  for(const entry of readdirSync(folder,{withFileTypes:true})){
   if(entry.isDirectory())visit(join(folder,entry.name))
   else if(entry.isFile()&&entry.name.endsWith('.md'))paths.push(join(folder,entry.name))
  }
 }
 if(existsSync(memory))for(const project of readdirSync(memory,{withFileTypes:true}))if(project.isDirectory())visit(join(memory,project.name,'memory'))
 return Object.fromEntries(paths.filter(p=>existsSync(p)).sort().map(path=>[path,readFileSync(path,'utf8').split('\n').filter(line=>line.includes('~/brain')||line.includes(join(home,'brain')))] as const).filter(([,lines])=>lines.length))
}
interface BrainCutoverRuntime {state:string;bin:string;skills:string;home?:string;admin:<T>(command:string,params?:Record<string,unknown>)=>Promise<T>;guard?:()=>void}
export function brainCutoverCommitted(state:string,admission?:BrainAdmissionStatus):boolean {
 try{const journal=JSON.parse(readFileSync(join(state,'brain-cutover','journal.json'),'utf8'));return admission?.committed===true&&journal.state==='complete'&&brainReceiptMatches(journal,admission.receipt)}catch{return false}
}
export function brainCutoverAvailable(state:string,admission:BrainAdmissionStatus):boolean {
 if(admission.open||admission.committed||admission.receiptState!=='absent'||existsSync(join(state,'brain-cutover-recovery-error.json')))return false
 const file=join(state,'brain-cutover','journal.json')
 if(!existsSync(file))return !admission.retired
 try{return JSON.parse(readFileSync(file,'utf8')).state==='rolled-back'}catch{return false}
}
export async function recoverBrainCutover(options:BrainCutoverRuntime):Promise<unknown> {
 const file=join(options.state,'brain-cutover','journal.json')
 if(!existsSync(file))return {skipped:true}
 try {
  const saved=JSON.parse(readFileSync(file,'utf8')),state=saved.state
  if(state==='complete'){
   const status=await options.admin<BrainAdmissionStatus>('admission-status')
   if(!status.committed&&!status.retired)throw new Error('The completed brain journal has no matching worker receipt; writes remain held')
  }
  if(state==='rolled-back'){rmSync(join(options.state,'brain-cutover-recovery-error.json'),{force:true});return {skipped:true}}
  const result=await withBrainCutoverLock(options,manager=>executeBrainCutover(options,manager,undefined,true))
  rmSync(join(options.state,'brain-cutover-recovery-error.json'),{force:true})
  return result
 }catch(error){
  durableBrainJson(join(options.state,'brain-cutover-recovery-error.json'),{failed:true,checkedAt:new Date().toISOString()})
  throw error
 }
}
/** Resolve only the live application's exact failed decision, with the recovery lock held. */
export async function settleBrainRollback(options:BrainCutoverRuntime,payloadHash:string):Promise<boolean> {
 return withBrainCutoverLock(options,async manager=>{
  const file=join(options.state,'brain-cutover','journal.json')
  if(!existsSync(file))return false
  const saved=JSON.parse(readFileSync(file,'utf8'))
  if(!['rolled-back','rolling-back'].includes(saved.state)||saved.commit?.payloadHash!==payloadHash)return false
  const absent=(status:BrainAdmissionStatus)=>status.receiptState==='absent'&&status.receipt===null&&!status.open&&!status.committed&&!status.retired
  const matches=(record:typeof saved,status:BrainAdmissionStatus)=>record.cutoverId===saved.cutoverId&&record.commit?.payloadHash===payloadHash&&
    record.commit.storeId===status.storeId&&brainReceiptMatches(record,record.commit)
  const initial=await options.admin<BrainAdmissionStatus>('admission-status')
  if(!absent(initial)||!matches(saved,initial))return false
  if(saved.state==='rolling-back')await executeBrainCutover(options,manager,undefined,true)
  const final=await options.admin<BrainAdmissionStatus>('admission-status'),durable=JSON.parse(readFileSync(file,'utf8'))
  if(durable.state!=='rolled-back'||!absent(final)||!matches(durable,final))return false
  rmSync(join(options.state,'brain-cutover-recovery-error.json'),{force:true})
  return true
 })
}
export async function runBrainCutover(options:BrainCutoverRuntime&{permit:BrainCutoverPermit}):Promise<unknown> {
 assertBrainCutoverPermit(options.permit)
 if(!options.permit.preparation?.value||createHash('sha256').update(options.permit.preparation.text).digest('hex')!==options.permit.preparation.sha256)throw new Error('The checked brain preparation is missing or changed')
 return withBrainCutoverLock(options,manager=>executeBrainCutover(options,manager,options.permit,false))
}
/** The desktop entry's return action must reach this very build before a switch counts (126.9 AC5). */
export function brainReturnLauncherPresent(home:string,binary=process.execPath,environment=process.env):string {
 const entry=join(environment.XDG_DATA_HOME||join(home,'.local/share'),'applications','bmn.desktop')
 const lines=readFileSync(entry,'utf8').split(/\r?\n/u),exec=lines.find(line=>line.startsWith('Exec="')&&line.endsWith('" --brain-return'))
 if(!lines.includes('Actions=brain-return;')||!lines.includes('[Desktop Action brain-return]')||!exec||realpathSync(exec.slice(6,-16))!==realpathSync(binary))throw new Error('The recovery launcher for the return to Obsidian is missing; no switch made')
 return entry
}
/** Trusted main recovery only; no CLI, socket or generic Rules action exposes it. */
export async function rollbackBrainCutover(options:BrainCutoverRuntime):Promise<unknown> {
 return withBrainCutoverLock(options,manager=>executeBrainCutover(options,manager,undefined,true,true))
}
async function withBrainCutoverLock<T>(options:BrainCutoverRuntime,work:(manager:BrainTimerCommand)=>Promise<T>):Promise<T> {
 mkdirSync(options.state,{recursive:true,mode:0o700})
 const locker=spawn('/usr/bin/python3',['-I',join(options.bin,'brain-cutover-peer.py'),'lock',join(options.state,'brain-cutover.lock')],{stdio:['pipe','pipe','pipe']})
 const closed=new Promise<void>(resolve=>locker.once('close',()=>resolve()))
 try{
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('The brain recovery lock did not open')),5000)
   locker.once('error',error=>{clearTimeout(timer);reject(error)})
   locker.once('exit',()=>{clearTimeout(timer);reject(new Error('The brain cutover or recovery is already running'))})
   locker.stdout.once('data',(data:Buffer)=>{clearTimeout(timer);if(data.toString().trim()==='LOCKED')resolve();else reject(new Error('Invalid brain lock response'))})
   locker.stderr.resume()
  })
  const manager:BrainTimerCommand=(operation,unit)=>new Promise((resolve,reject)=>{
   // The child keeps the lock pipe open if the main process dies while systemctl is running.
   const guarded=spawn('/usr/bin/python3',['-I','-c','import os, subprocess, sys; os.fstat(3); subprocess.run(sys.argv[1:], timeout=25, check=True)',
    '/usr/bin/systemctl','--user',operation,unit],{stdio:['ignore','ignore','ignore',locker.stdin]})
   guarded.once('error',reject)
   guarded.once('close',code=>{if(code===0)resolve();else reject(new Error('Brain timer command did not settle: '+operation+' '+unit))})
  })
  return await work(manager)
 }finally{
  locker.stdin.end()
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([closed,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('The brain lock helper did not exit')),5000)})])}finally{if(timer)clearTimeout(timer)}
 }
}
async function executeBrainCutover(options:BrainCutoverRuntime,manager:BrainTimerCommand,permit:BrainCutoverPermit|undefined,recoveryOnly:boolean,forceRollback=false):Promise<unknown> {
 if(!recoveryOnly)assertBrainCutoverPermit(permit)
 const home=options.home??homedir()
 const journalRoot=join(options.state,'brain-cutover')
 const recoveryState=recoveryOnly?JSON.parse(readFileSync(join(journalRoot,'journal.json'),'utf8')):undefined
 const saved=recoveryState?.paths as unknown
 if(recoveryOnly)assertBrainRecoveryPaths(saved,recoveryState,{home,state:options.state,skills:options.skills})
 const recoveredPaths=saved as BrainCutoverPaths|undefined
 const config=(recoveryOnly?recoveryState.preparation??{version:1,labels:[],projects:[],changes:[],indexes:recoveredPaths?.indexes??[],instructionLines:{},startText:[]}:permit!.preparation!.value) as CutoverConfiguration
 if(config.version!==1||!Array.isArray(config.labels)||!Array.isArray(config.projects)||!Array.isArray(config.changes)||!Array.isArray(config.indexes)||!Array.isArray(config.startText)||!config.instructionLines)throw new Error('Invalid brain rehearsal preparation')
 if(!recoveryOnly){validateBrainStartText(config.startText,home);const checked=JSON.parse(readFileSync(join(options.skills,'brain','master-lines.json'),'utf8'));if(JSON.stringify(config.changes)!==JSON.stringify(checked.changes))throw new Error('The proposed master changes differ from Astra’s reviewed wording')}
 if(existsSync(join(journalRoot,'journal.json'))){const previous=JSON.parse(readFileSync(join(journalRoot,'journal.json'),'utf8'));if(previous.state==='complete'&&!recoveryOnly){if(!brainCutoverCommitted(options.state,await options.admin<BrainAdmissionStatus>('admission-status')))throw new Error('The completed brain journal has no matching receipt');return {ok:true,alreadyComplete:true}};if(previous.state==='rolled-back'&&!recoveryOnly)renameSync(journalRoot,journalRoot+'-'+randomUUID())}
 const paths:BrainCutoverPaths=recoveredPaths??{home,vault:join(home,'brain'),journal:journalRoot,master:join(home,'.config/bmn/agents/global-rules.md'),claudeRules:join(home,'.claude/CLAUDE.md'),codexRules:join(home,'.codex/AGENTS.md'),claudeSkill:join(home,'.claude/skills/brain'),codexSkill:join(home,'.agents/skills/brain'),managedSkill:managedBrainSkillPath(home),shippedSkill:join(options.skills,'brain'),indexes:config.indexes}
 const rules=await import(pathToFileURL(join(options.bin,'agents-rules.mjs')).href) as typeof import('../../bin/agents-rules.mjs')
 const admission=await import(pathToFileURL(join(options.bin,'defaults-admission.mjs')).href) as typeof import('../../bin/defaults-admission.mjs')
 const skillInstaller=await import(pathToFileURL(join(options.bin,'brain-cutover-skills.mjs')).href) as typeof import('../../bin/brain-cutover-skills.mjs')
 const admin=options.admin
 const brain={
  admission:()=>admin<BrainAdmissionStatus>('admission-status'),commitCutover:(payloadHash:string)=>admin<BrainAdmissionStatus>('commit-cutover',{payloadHash}),resumeCutover:()=>admin<BrainAdmissionStatus>('resume-cutover'),
  setWriteDoor:(open:boolean)=>admin<void>(open?'open-door':'close-door'),
  importNotes:(notes:Parameters<BrainWorkerClient['importNotes']>[0])=>admin<Awaited<ReturnType<BrainWorkerClient['importNotes']>>>('import',{notes}),
  list:()=>admin<BrainNote[]>('list'),read:(name:string)=>admin<BrainNote>('read',{name}),
  export:()=>admin<string>('export'),backup:()=>admin<string>('backup'),returnCapture:()=>admin<Awaited<ReturnType<BrainWorkerClient['returnCapture']>>>('return-capture'),restoreCheck:(backup:string,scratch:string)=>admin<Awaited<ReturnType<BrainWorkerClient['restoreCheck']>>>('restore-check',{backup,scratch})
 }
 const beforeBytes=recoveryOnly?[]:brainStartTextBytes(config.startText as Parameters<typeof brainStartTextBytes>[0])
 const timers=brainTimerTransitions(observeBrainTimer,manager)
 let checks:Record<string,unknown>={}
 const journal=new BrainCutoverJournal(paths,{skills:skillInstaller.brainCutoverSkills(paths,()=>assertBrainCutoverPermit(permit)),atomicRename:brainAtomicRename(options.bin),
  decide:async(payloadHash:string)=>{assertBrainCutoverPermit(permit);await permit.decide(payloadHash)},
  brain,guard:()=>{assertBrainCutoverPermit(permit);options.guard?.()},commit:()=>{assertBrainCutoverPermit(permit);permit.commit()},
  instructionProof:async()=>{const observed=brainInstructionLines(home);if(JSON.stringify(observed)!==JSON.stringify(config.instructionLines))throw new Error('Vault instruction lines differ from the six rehearsals; no switch made');return {rehearsed:config.instructionLines,observed}},
  pauseWriters:async(record,progress)=>{
   await timers.pause(record,progress)
   // Obsidian saves continuously. Ask its own windows to close before making the archive read-only.
   await execute('/usr/bin/python3',['-I',join(options.bin,'brain-vault-writers.py'),'--close-obsidian'],{timeout:35_000})
  },
  restoreTimers:timers.restore,
  writers:async()=>JSON.parse((await execute('/usr/bin/python3',['-I',join(options.bin,'brain-vault-writers.py'),paths.vault],{maxBuffer:1024*1024})).stdout),
  rulesAdmission:work=>admission.withDefaultsAdmission(work),
  preflightRules:async owned=>rules.preflightCutoverRules(owned),
  preflightTimers:timers.preflight,
  rollbackRules:async owned=>rules.rollbackCutoverRules(owned,join(journalRoot,'rules-transaction-audit')),
  renderRules:async record=>{
   if(rules.targetPath('claude')!==paths.claudeRules||rules.targetPath('codex')!==paths.codexRules)throw new Error('Rules destinations differ from the rehearsed inventory')
   const result=await rules.installRules(['claude','codex'],{yes:true,asJson:true,cutover:true,beforeTransaction:owned=>{assertBrainCutoverPermit(permit);record(owned)},beforeTarget:()=>assertBrainCutoverPermit(permit)})
   if(result.code!=='OK')throw new Error('Brain Rules installation failed: '+result.code)
  },
  recoverCheck:intent=>admin('recover-check',{note:intent.note,attempt:intent.attempt,title:intent.title}),
  importProof:async(current,notes)=>{const grantRoot=await admin<string>('data-root');return verifyBrainImportExport(current,grantRoot,notes)},
  installedProof:async intent=>{
   assertBrainCutoverPermit(permit)
   const installed=await verifyInstalledBrainCheck({bin:options.bin,journal:journalRoot,intent,admin,guard:()=>assertBrainCutoverPermit(permit),...(permit.signal?{signal:permit.signal}:{})})
   const backup=await brain.backup(),restored=await brain.restoreCheck(backup,join(journalRoot,'restore-'+randomUUID()))
   validateBrainStartText(config.startText,home)
   const afterBytes=brainStartTextBytes(config.startText);assertBrainStartTextDidNotGrow(beforeBytes,afterBytes)
   const launcher=brainReturnLauncherPresent(home)
   checks={...installed,backup,restored,beforeBytes,afterBytes,launcher};return checks
  },
  afterSwitch:async(proof,originatingCommit)=>{
   await deliverBrainCutover({state:options.state,project:join(home,'code','BMN'),bin:options.bin,proof,commit:originatingCommit??''})
  }
 },config,recoveryOnly?undefined:__BMN_BUILD_COMMIT__,recoveryState)
 if(recoveryOnly){
  const status=recoveryState.commit?await brain.admission():null
  if(status&&!status.committed&&!status.retired&&(status.receiptState!=='absent'||status.open))throw new Error('The brain commit receipt is uncertain; recovery remains held')
  // A return the owner confirmed continues even when BMN stopped before it closed the door.
  if(!forceRollback&&status?.committed&&recoveryState.state!=='rolling-back'&&status.returnAuthorized!==recoveryState.cutoverId){await journal.resumeCommitted();await journal.deliver();return {delivered:true}}
  await journal.rollback();return {rolledBack:true}
 }
 return journal.run(config.labels,config.projects,config.changes)
}
