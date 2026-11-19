// MODULE: brain-cutover-skills.mjs - Scoped adoption and selective recovery through normal skill ownership
import {constants,closeSync,fstatSync,fsyncSync,openSync,lstatSync,mkdirSync,readFileSync,readlinkSync,symlinkSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname,join} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {installBrainCutoverOwnSkill,verifyBrainOwnSkillRow} from './agents-own-skills.mjs'
import {assertDefaultsAdmission,withDefaultsAdmission} from './defaults-admission.mjs'
import {defaultsTargetKey,optionalDefaultsOwnership,readDefaultsOwnership} from './defaults-ownership.mjs'
import {installSetupSkill,checkedBrainCutoverSkill} from './setup-skill-defaults.mjs'
import {readSetupSkillRecords,validateSetupSkillRecords,writeSetupSkillRecords} from './setup-skill-records.mjs'
import {writeCompatibleSkillMetadata} from './setup-app-skills.mjs'
import {writePrivate} from './agents-rules.mjs'
const failure=message=>new Error('Brain skill ownership conflict: '+message)
const missing=path=>{try{lstatSync(path);return false}catch(error){if(error.code==='ENOENT')return true;throw error}}
export {managedBrainSkillPath} from './brain-state.mjs'
import {managedBrainSkillPath} from './brain-state.mjs'
export function brainCutoverSkills(paths,guard){
 const environment={...process.env,HOME:paths.home,BMN_SHIPPED_SKILLS:dirname(paths.shippedSkill)}
 const targets=[{kind:'own-skills',app:'source',path:paths.managedSkill,entry:'brain'},{kind:'skills',app:'source',path:paths.claudeSkill,entry:'brain'},{kind:'skills',app:'codex',path:paths.codexSkill,entry:'brain'}]
 const ownPath=join(paths.home,'.config/bmn/agents/state/own-skills.json'),writtenPath=join(paths.home,'.config/bmn/agents/state/rules/skills-written.json')
 const codexRow={harness:'codex',skill:'brain',kind:'link',target:paths.claudeSkill}
 const observeCodexLink=()=>{
  try{
   const stat=lstatSync(paths.codexSkill)
   if(!stat.isSymbolicLink()||readlinkSync(paths.codexSkill)!==paths.claudeSkill)return null
   const current=lstatSync(paths.codexSkill)
   return current.dev===stat.dev&&current.ino===stat.ino?{device:stat.dev,inode:stat.ino}:null
  }catch(error){if(error.code==='ENOENT')return null;throw error}
 }
 const assertPaths=()=>{
  assertDefaultsAdmission()
  if(homedir()!==paths.home||paths.claudeSkill!==join(paths.home,'.claude/skills/brain')||paths.codexSkill!==join(paths.home,'.agents/skills/brain')||paths.managedSkill!==managedBrainSkillPath(paths.home)||paths.shippedSkill!==join(environment.BMN_SHIPPED_SKILLS,'brain'))throw failure('fixed home or skill destinations changed')
 }
 const read=(kind,path)=>{
  let value
  if(missing(path))value=kind==='own-skills'?{version:1,skills:{},removed:{}}:{}
  else{
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
   try{
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>1_048_576)throw failure('unsafe skill metadata')
    value=JSON.parse(readFileSync(fd,'utf8'));const after=fstatSync(fd),leaf=lstatSync(path)
    if(stat.dev!==leaf.dev||stat.ino!==leaf.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw failure('skill metadata changed while read')
   }finally{closeSync(fd)}
  }
  return validateSetupSkillRecords(kind,value)
 }
 const syncRecords=()=>{
  for(const path of [ownPath,writtenPath])if(!missing(path)){
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd)}finally{closeSync(fd)}
   const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent)}finally{closeSync(parent)}
  }
 }
 const records=()=>({own:read('own-skills',ownPath),written:read('skills-written',writtenPath)})
 const assertProof=proof=>{
  assertPaths()
  if(!proof||proof.version!==1||!isDeepStrictEqual(proof.paths,{home:paths.home,copy:paths.managedSkill,source:paths.claudeSkill,codex:paths.codexSkill})||
    !['planned','installing','complete','rollback-started','rolled-back'].includes(proof.state)||!Array.isArray(proof.installations)||proof.installations.length>3||
    proof.installations.some(row=>!targets.some(target=>isDeepStrictEqual(target,row.target))))throw failure('journal ownership scope changed')
  if(proof.legacyCodexLink!==undefined&&(proof.setupId!==null||!isDeepStrictEqual(proof.codexRow,codexRow)||
    !Number.isSafeInteger(proof.legacyCodexLink?.device)||!Number.isSafeInteger(proof.legacyCodexLink?.inode)))throw failure('journal legacy link proof changed')
 }
 const verify=(proof,restored=[])=>{
  assertProof(proof)
  const current=records(),partial=proof.state!=='complete'
  let normalOwn=false
  if(!proof.setupId&&current.own.skills.brain&&proof.ownRow?.brain){verifyBrainOwnSkillRow(current.own.skills.brain,proof.ownRow,restored);normalOwn=true}
  const codexMatches=isDeepStrictEqual(current.written[paths.codexSkill]??null,proof.codexRow)
  const codexAllowed=proof.legacyCodexLink
   ? codexMatches&&isDeepStrictEqual(observeCodexLink(),proof.legacyCodexLink)
   : codexMatches||(partial&&current.written[paths.codexSkill]===undefined)
  if(current.own.removed.brain!==undefined||!((partial&&current.own.skills.brain===undefined)||normalOwn||isDeepStrictEqual(current.own.skills.brain??null,proof.ownRow))||
    !codexAllowed)throw failure('a brain record, legacy Codex link or owner opt-out changed')
  for(const [name,row]of Object.entries(current.own.skills))if(name!=='brain'&&[paths.managedSkill,paths.claudeSkill].some(root=>row.copy===root||row.copy.startsWith(root+'/')))throw failure('another own skill depends on the brain copy')
  for(const [path,row]of Object.entries(current.written))if(path!==paths.codexSkill&&row.kind==='link'&&[paths.managedSkill,paths.claudeSkill].some(root=>row.target===root||row.target.startsWith(root+'/')))throw failure('another app entry depends on the brain copy')
  const journal=optionalDefaultsOwnership()
  if((journal?.snapshot().setupId??null)!==proof.setupId)throw failure('setup identity changed')
  if(journal){
   const state=journal.snapshot()
   if(Object.values(state.compatibility).some(row=>row.pending!==null))throw failure('unresolved normal metadata publication needs inspection')
   for(const saved of proof.installations){
    const row=state.entries[defaultsTargetKey(saved.target)]
    if(saved.stage!=='installed'||saved.optOut||saved.operation!==null)throw failure('an interrupted setup install needs inspection')
    if(row)checkedBrainCutoverSkill(saved,{setupId:proof.setupId,retiring:['rollback-started','rolled-back'].includes(proof.state),restoring:restored.includes(saved.target.path)})
    else if(!['rollback-started','rolled-back'].includes(proof.state))throw failure('a setup install disappeared')
   }
   for(const target of targets){const row=state.entries[defaultsTargetKey(target)];if(row&&!proof.installations.some(saved=>isDeepStrictEqual(saved.target,target)))throw failure('an unrecorded setup entry appeared')}
   if(proof.installations.length||proof.state==='complete')for(const kind of ['own-skills','skills-written'])readSetupSkillRecords(journal,kind)
   for(const row of Object.values(state.entries))if(!targets.some(target=>isDeepStrictEqual(target,row.target))&&row.dependencies.some(dep=>dep.status!=='released'&&proof.installations.some(saved=>saved.transaction===dep.backingInstallId)))throw failure('another destination depends on the brain copy')
  }
  const changed=[]
  if(normalOwn&&current.own.skills.brain.brain.revision>proof.ownRow.brain.revision)changed.push(paths.managedSkill)
  if(journal)for(const saved of proof.installations){const row=journal.snapshot().entries[defaultsTargetKey(saved.target)];if(row&&row.current.revision>saved.current.revision)changed.push(saved.target.path)}
  return changed
 }
 return {
  prepare:()=>withDefaultsAdmission(()=>{
   assertPaths();guard()
   const prior=records(),journal=optionalDefaultsOwnership()
   // Legacy BMN already owns this exact link. Replacing its Claude target changes
   // what it resolves to while the existing Codex entry and record stay intact.
   const priorCodex=prior.written[paths.codexSkill]
   const legacyCodexLink=!journal&&isDeepStrictEqual(priorCodex,codexRow)?observeCodexLink():null
   if(prior.own.skills.brain!==undefined||prior.own.removed.brain!==undefined||(priorCodex!==undefined&&!legacyCodexLink)||!missing(paths.managedSkill)||
     journal&&targets.some(target=>journal.snapshot().entries[defaultsTargetKey(target)]))throw failure('existing managed brain ownership or opt-out is never replaced')
   for(const path of [paths.managedSkill,paths.claudeSkill,paths.codexSkill])mkdirSync(dirname(path),{recursive:true,mode:0o700})
   return {version:1,state:'planned',paths:{home:paths.home,copy:paths.managedSkill,source:paths.claudeSkill,codex:paths.codexSkill},setupId:journal?.snapshot().setupId??null,installations:[],ownRow:null,
    codexRow:legacyCodexLink?codexRow:null,...(legacyCodexLink?{legacyCodexLink}:{})}
  }),
  install:(proof,record)=>withDefaultsAdmission(()=>{
   assertProof(proof);guard()
   if(proof.legacyCodexLink)verify(proof)
   if(!targets.every(target=>target.path===paths.codexSkill&&proof.legacyCodexLink||missing(target.path)))throw failure('rehearsed legacy entries were not held before adoption')
   proof.state='installing';record(proof)
   if(proof.setupId){
    const desires=[{kind:'tree',source:paths.shippedSkill},{kind:'link',text:paths.managedSkill},{kind:'link',text:paths.claudeSkill}]
    for(const [index,target]of targets.entries()){
     guard()
     const result=installSetupSkill(target,desires[index],{setupId:proof.setupId,cutover:true,beforePublish:()=>{
      guard();const row=readDefaultsOwnership(proof.setupId).snapshot().entries[defaultsTargetKey(target)]
      proof.installations.push(row);record(proof)
     }})
     if(result.code!=='OK'||result.state!=='installed')throw failure(result.message??'normal setup installation refused')
     proof.installations[index]=readDefaultsOwnership(proof.setupId).snapshot().entries[defaultsTargetKey(target)]
     const current=records();proof.ownRow=current.own.skills.brain??null;proof.codexRow=current.written[paths.codexSkill]??null;record(proof)
    }
   }else{
    installBrainCutoverOwnSkill({source:dirname(paths.claudeSkill),environment,guard,beforeRecord:row=>{proof.ownRow=row;record(proof)}})
    if(!proof.legacyCodexLink){
     proof.codexRow=codexRow;record(proof);guard()
     symlinkSync(paths.claudeSkill,paths.codexSkill)
     const current=records();current.written[paths.codexSkill]=codexRow;writeCompatibleSkillMetadata(current.written,join(paths.journal,'skill-ownership-audit'))
    }
   }
   syncRecords();proof.state='complete';record(proof);verify(proof)
  }),
  verify:(proof,restored=[])=>withDefaultsAdmission(()=>verify(proof,restored)),
  rollback:(proof,record,restored=[])=>withDefaultsAdmission(()=>{
   verify(proof,restored)
   if(proof.state==='rolled-back')return
   proof.state='rollback-started';record(proof)
   const current=records(),own=structuredClone(current.own),written=structuredClone(current.written)
   delete own.skills.brain
   if(!proof.legacyCodexLink)delete written[paths.codexSkill]
   const audit=join(paths.journal,'skill-ownership-audit');mkdirSync(audit,{recursive:true,mode:0o700})
   if(proof.setupId){
    for(const [kind,value]of [['own-skills',own],['skills-written',written]]){
     const journal=readDefaultsOwnership(proof.setupId)
     const previous=readSetupSkillRecords(journal,kind)
     if(!isDeepStrictEqual(previous.value,value))writeSetupSkillRecords(journal,kind,previous,value,{folder:audit})
    }
    const journal=readDefaultsOwnership(proof.setupId),observed=proof.installations.map(saved=>journal.snapshot().entries[defaultsTargetKey(saved.target)]).filter(Boolean)
    journal.removeBrainCutoverEntries(observed)
   }else{
    if(!isDeepStrictEqual(current.own,own))writePrivate(ownPath,JSON.stringify(own,null,2))
    if(!isDeepStrictEqual(current.written,written))writeCompatibleSkillMetadata(written,audit)
   }
   syncRecords();proof.state='rolled-back';record(proof)
  })
 }
}
