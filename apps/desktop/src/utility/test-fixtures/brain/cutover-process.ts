// MODULE: cutover-process.ts - Disposable-process crash fixture; never a product entry point
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync} from 'node:fs'
import {join,basename,resolve} from 'node:path'
import {BrainStore} from '../../brain-store'
import {BrainFiles} from '../../brain-files'
import {verifyBrainImportExport} from '../../brain-export-proof'
import {BrainAdmission} from '../../brain-admission'
import {brainCutoverSkills} from '../../../../bin/brain-cutover-skills.mjs'
import {withDefaultsAdmission} from '../../../../bin/defaults-admission.mjs'
import {brainAtomicRename} from '../../brain-cutover-files'
import {BrainCutoverJournal,type BrainCutoverPaths} from '../../brain-cutover-journal'
import type {DatabaseConnection} from '../../database-initialization'
const [mode,rawRoot,rawCrash]=process.argv.slice(2),root=resolve(rawRoot??'')
if(!['run','run-fail','run-rollback','status','recover','recover-crash'].includes(mode??'')||!basename(root).startsWith('bmn-brain-crash-'))throw new Error('Synthetic crash fixture root required')
process.env.HOME=root
const paths=JSON.parse(readFileSync(join(root,'paths.json'),'utf8')) as BrainCutoverPaths
if(paths.home!==root||paths.vault!==join(root,'vault'))throw new Error('Invalid synthetic fixture')
const SQLite=createRequire(__filename)('better-sqlite3') as new(path:string)=>DatabaseConnection
const store=new BrainStore(new SQLite(join(root,'brain.sqlite3'))),files=new BrainFiles(store,root,join(paths.vault,'files'))
let count=0
const admission=new BrainAdmission(store,join(paths.journal,'journal.json'))
 const brain={returnCapture:async()=>{if(store.isOpen())throw new Error('The brain return capture needs the closed write door');const snapshot=files.snapshot('return',new Date(),undefined,false);return {snapshot,projection:files.dump() as never,objects:join(files.backupRoot,'objects')}},admission:async()=>admission.status(),commitCutover:async(hash:string)=>admission.commit(hash),resumeCutover:async()=>admission.resume(),setWriteDoor:async(open:boolean)=>{if(open)store.setWriteDoor(true);else admission.revoke()},importNotes:async(...args:Parameters<BrainStore['importNotes']>)=>{const checkpoint=files.snapshot('before-import');return {...store.importNotes(...args),checkpoint}},list:async()=>store.list(),read:async(...args:Parameters<BrainStore['read']>)=>store.read(...args),create:async(...args:Parameters<BrainStore['create']>)=>store.create(...args),withdraw:async(...args:Parameters<BrainStore['withdraw']>)=>store.withdraw(...args),export:async()=>files.export(),backup:async()=>files.snapshot('manual'),restoreCheck:async()=>({ok:true as const,notes:0,versions:0,attachments:0})}
const guard=()=>{count++;if(mode==='run'&&count===Number(rawCrash))process.kill(process.pid,'SIGKILL')}
const journal=new BrainCutoverJournal(paths,{skills:brainCutoverSkills(paths,guard),rulesAdmission:work=>withDefaultsAdmission(work),atomicRename:brainAtomicRename(resolve(process.cwd(),'apps/desktop/bin')),brain,
 guard,decide:async()=>{},commit:()=>{},
 instructionProof:async()=>{},recoverCheck:async intent=>{if(store.list().some(note=>note.id===intent.note))throw new Error('Unexpected check note in no-create crash fixture');return {status:'absent'}},importProof:async(current,notes)=>verifyBrainImportExport(current,root,notes),pauseWriters:async record=>{record({synthetic:{enabled:true,active:true}});writeFileSync(join(root,'timer.txt'),'disabled')},
 restoreTimers:async states=>{if(states.synthetic)writeFileSync(join(root,'timer.txt'),'enabled');if(mode==='recover-crash')process.kill(process.pid,'SIGKILL')},
 writers:async()=>({blockers:[],unknown:[]}),renderRules:async()=>{writeFileSync(paths.claudeRules,'bmn brain');writeFileSync(paths.codexRules,'bmn brain')},
 installedProof:async()=>{if(mode==='run-fail'){writeFileSync(join(root,'restore-started.flag'),'synthetic');throw new Error('Synthetic installed check failure')}return {synthetic:true}},afterSwitch:async()=>{writeFileSync(join(root,'delivery.txt'),'complete')}
},{synthetic:true},'c'.repeat(40))
async function main(){
 try{
  if(mode==='status'){console.log(JSON.stringify(admission.status()));return}
  if(mode==='run'||mode==='run-fail'||mode==='run-rollback')await journal.run([{source:join(paths.vault,'note.md'),source_kind:'vault',label:'brain'}],[],[{before:'Old vault instructions with many words.',after:'bmn brain'}])
  else await journal.rollback()
  if(mode==='run-rollback'){writeFileSync(join(root,'restore-started.flag'),'synthetic committed recovery');admission.authorizeReturn();await journal.rollback()}
  console.log(JSON.stringify({count,open:store.isOpen()}))
 }finally{store.database.close()}
}
void main().catch(error=>{console.error(error);process.exitCode=1})
