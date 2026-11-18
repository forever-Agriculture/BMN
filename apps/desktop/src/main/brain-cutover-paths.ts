// MODULE: brain-cutover-paths.ts - Validate the entire recovery target/backup set against trusted fixed roots
import {lstatSync} from 'node:fs'
import {dirname,isAbsolute,join,relative} from 'node:path'
import {managedBrainSkillPath} from '../../bin/brain-state.mjs'
import {brainAbsentRestoreIntent,brainPathFingerprint,brainRestorePrefix,type BrainCutoverPaths} from '../utility/brain-cutover-journal'
function failure(detail:string):never {throw new Error('Unapproved brain recovery path or target: '+detail)}
function parents(path:string,root:string):void {
 const child=relative(root,dirname(path))
 if(isAbsolute(child)||child==='..'||child.startsWith('../'))failure(path)
 let current=root
 for(const name of ['',...child.split('/').filter(Boolean)]){
  if(name)current=join(current,name)
  const stat=lstatSync(current)
  if(!stat.isDirectory()||stat.isSymbolicLink())failure(current)
 }
}
export function assertBrainRecoveryPaths(value:unknown,state:unknown,expected:{home:string;state:string;skills:string}):asserts value is BrainCutoverPaths {
 if(!value||typeof value!=='object')failure('missing paths')
 const paths=value as BrainCutoverPaths,home=expected.home,journal=join(expected.state,'brain-cutover')
 const fixed={home,vault:join(home,'brain'),journal,master:join(home,'.config/bmn/agents/global-rules.md'),claudeRules:join(home,'.claude/CLAUDE.md'),codexRules:join(home,'.codex/AGENTS.md'),claudeSkill:join(home,'.claude/skills/brain'),codexSkill:join(home,'.agents/skills/brain'),managedSkill:managedBrainSkillPath(home),shippedSkill:join(expected.skills,'brain')}
 for(const [key,path]of Object.entries(fixed))if(paths[key as keyof typeof fixed]!==path)failure(key)
 if(!Array.isArray(paths.indexes)||new Set(paths.indexes).size!==paths.indexes.length)failure('indexes')
 for(const path of paths.indexes){if(typeof path!=='string'||!isAbsolute(path)||!/^[-A-Za-z0-9_.]+\/memory\/MEMORY\.md$/.test(relative(join(home,'.claude/projects'),path)))failure('memory index')}
 const record=state as {version?:unknown;saved?:unknown;modes?:unknown;timers?:unknown;timerProgress?:unknown;recoveryWritten?:Record<string,string>}
 if(!record||record.version!==1||!Array.isArray(record.saved)||!Array.isArray(record.modes)||!record.timers||typeof record.timers!=='object'||Array.isArray(record.timers))failure('journal structure')
 if(record.recoveryWritten!==undefined&&(!record.recoveryWritten||typeof record.recoveryWritten!=='object'||Array.isArray(record.recoveryWritten)||Object.entries(record.recoveryWritten).some(([path,written])=>path!==paths.managedSkill||typeof written!=='string')))failure('normal refresh recovery evidence')
 const targets=new Set([paths.master,paths.claudeRules,paths.codexRules,paths.claudeSkill,paths.codexSkill,paths.managedSkill,join(paths.vault,'ARCHIVE.md'),...paths.indexes]),seen=new Set<string>()
 for(const [index,raw]of record.saved.entries()){
  const item=raw as Record<string,unknown>
  if(!item||typeof item.path!=='string'||!targets.has(item.path)||seen.has(item.path)||typeof item.mode!=='number'||!Number.isInteger(item.mode)||item.mode<0||item.mode>0o7777||typeof item.original!=='string'||item.written!==undefined&&typeof item.written!=='string')failure('saved target')
  seen.add(item.path);parents(item.path,home)
  if(item.held!==undefined){
   const held=item.held as Record<string,unknown>
   if(![paths.claudeSkill,paths.codexSkill].includes(item.path)||!held||held.path!==join(journal,'held',String(index))||typeof held.dev!=='number'||!Number.isSafeInteger(held.dev)||held.dev<0||typeof held.ino!=='number'||!Number.isSafeInteger(held.ino)||held.ino<=0)failure('held legacy skill')
   parents(held.path as string,journal)
   try{
    const stat=lstatSync(held.path as string)
    if(stat.dev!==held.dev||stat.ino!==held.ino||brainPathFingerprint(held.path as string)!==item.original)failure('held legacy skill identity')
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  if(item.restore!==undefined){
   const restore=item.restore as Record<string,unknown>,prefix=brainRestorePrefix(item.path)
   if(!restore||typeof restore.temporary!=='string'||dirname(restore.temporary)!==dirname(item.path)||!restore.temporary.startsWith(prefix)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(restore.temporary.slice(prefix.length))||!['planned','writing','staged','restored'].includes(String(restore.phase))||restore.original!==item.original||(!brainAbsentRestoreIntent(item.allowMissing,{targetDev:restore.targetDev,targetIno:restore.targetIno,written:restore.written})&&restore.written!==(record.recoveryWritten?.[item.path]??item.written))||typeof restore.targetDev!=='number'||!Number.isSafeInteger(restore.targetDev)||typeof restore.targetIno!=='number'||!Number.isSafeInteger(restore.targetIno)||restore.targetDev<0||restore.targetIno<0||restore.device!==undefined&&(typeof restore.device!=='number'||!Number.isSafeInteger(restore.device)||restore.device<0)||restore.inode!==undefined&&(typeof restore.inode!=='number'||!Number.isSafeInteger(restore.inode)||restore.inode<=0)||(restore.device===undefined)!==(restore.inode===undefined))failure('restore staging intent')
   if(restore.abandoned!==undefined){
    if(!Array.isArray(restore.abandoned))failure('retained restore stages')
    const stages=new Set([restore.temporary])
    for(const raw of restore.abandoned){
     const old=raw as Record<string,unknown>
     if(!old||typeof old.temporary!=='string'||dirname(old.temporary)!==dirname(item.path)||!old.temporary.startsWith(prefix)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(old.temporary.slice(prefix.length))||stages.has(old.temporary)||typeof old.device!=='number'||!Number.isSafeInteger(old.device)||old.device<0||typeof old.inode!=='number'||!Number.isSafeInteger(old.inode)||old.inode<=0)failure('retained restore stages')
     stages.add(old.temporary)
    }
   }
  }
  if(item.backup!==null){
   if(item.backup!==join(journal,'saved',String(index)))failure('backup location')
   const backup=item.backup as string;parents(backup,journal)
   const stat=lstatSync(backup)
   if(stat.isSymbolicLink()||!!item.folder!==stat.isDirectory()||(!stat.isFile()&&!stat.isDirectory())||brainPathFingerprint(backup)!==item.original)failure('backup identity')
  }else if(item.link!==undefined&&typeof item.link!=='string')failure('saved link')
 }
 for(const raw of record.modes){
  const item=raw as Record<string,unknown>
  if(!item||typeof item.path!=='string'||typeof item.mode!=='number'||!Number.isInteger(item.mode)||item.mode<0||item.mode>0o7777||typeof item.dev!=='number'||!Number.isSafeInteger(item.dev)||typeof item.ino!=='number'||!Number.isSafeInteger(item.ino)||item.ino<=0)failure('saved mode')
  const child=relative(paths.vault,item.path)
  if(isAbsolute(child)||child==='..'||child.startsWith('../')||['files','.git'].some(name=>child===name||child.startsWith(name+'/')))failure('vault mode location')
  parents(item.path,home)
 }
 for(const [name,raw]of Object.entries(record.timers)){
  const timer=raw as {enabled?:unknown;active?:unknown;identity?:unknown}
  if(!['brain-autocommit','brain-daily-note','brain-daily-rollup'].includes(name)||!timer||typeof timer.enabled!=='boolean'||typeof timer.active!=='boolean'||
    timer.identity!==undefined&&(typeof timer.identity!=='string'||!/^[a-f0-9]{64}$/.test(timer.identity)))failure('timer')
 }
 if(record.timerProgress!==undefined){
  if(!record.timerProgress||typeof record.timerProgress!=='object'||Array.isArray(record.timerProgress))failure('timer progress')
  const pair=(value:unknown)=>!!value&&typeof value==='object'&&typeof (value as {enabled?:unknown}).enabled==='boolean'&&typeof (value as {active?:unknown}).active==='boolean'
  for(const [name,value]of Object.entries(record.timerProgress)){
   const row=value as {identity?:unknown;state?:unknown;after?:unknown}
   if(!Object.hasOwn(record.timers,name)||!row||typeof row.identity!=='string'||!/^[a-f0-9]{64}$/.test(row.identity)||
     !pair(row.state)||row.after!==undefined&&!pair(row.after))failure('timer transition')
  }
 }
}
