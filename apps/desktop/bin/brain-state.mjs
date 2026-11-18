// MODULE: brain-state.mjs - Pure journal/worker-receipt matching; files never issue start authority
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH=/^[a-f0-9]{64}$/
const COMMIT=/^[a-f0-9]{40,64}$/
let verifiedReceipt=()=>null
/** Entry points inject a read-only worker/DB result; the Rules graph never imports a store. */
export function configureBrainReceiptReader(reader){verifiedReceipt=reader}
export function managedBrainSkillPath(home=homedir(),environment=process.env){return join(environment.XDG_DATA_HOME||join(home,'.local/share'),'bmn/skills/brain')}
export function brainStateRoot(environment=process.env,home=homedir()) {
 return environment.BMN_STATE_HOME??environment.AITERM_STATE_HOME??join(environment.XDG_STATE_HOME??join(home,'.local/state'),'bmn')
}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical)
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]))
 return value
}
export function brainEvidenceHash(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}
/** Reporting flags/errors may change. Every source, target and final-check receipt stays bound. */
export function brainJournalCommit(journal,storeId){
 if(journal?.version!==1||!UUID.test(journal.cutoverId)||!UUID.test(storeId)||!COMMIT.test(journal.originatingCommit)||!Array.isArray(journal.phases)||!['write-barrier','source-proof','write-door','installed-checks'].every(phase=>journal.phases.includes(phase)))throw new Error('Brain commit evidence is incomplete')
 const evidence={phases:journal.phases.filter(phase=>!['complete','rollback'].includes(phase))}
 for(const key of ['watermark','paths','preparation','instructionProof','manifest','protectedManifest','saved','modes','timers','brainHeads','checks','skills','rules','checkIntent','preImportCheckpoint','importProof'])evidence[key]=journal[key]??null
 // Recovery progress never changes the original rollback evidence.
 evidence.saved=journal.saved?.map(row=>{const saved={...row};delete saved.restore;return saved})??null
 if(journal.skills){const skills={...journal.skills};delete skills.state;evidence.skills=skills}
 return {version:2,cutoverId:journal.cutoverId,storeId,payloadHash:brainEvidenceHash({version:2,cutoverId:journal.cutoverId,storeId,originatingCommit:journal.originatingCommit,evidence})}
}
export function brainReceiptMatches(journal,receipt){
 try{
  if(!['running','complete','rolling-back','rolled-back'].includes(journal?.state)||receipt?.version!==2||receipt.revoked===true||!HASH.test(receipt.payloadHash)||!journal.commit)return false
  const expected=brainJournalCommit(journal,receipt.storeId)
  return ['version','cutoverId','storeId','payloadHash'].every(key=>receipt[key]===expected[key]&&journal.commit[key]===expected[key])
 }catch{return false}
}
export function brainSwitchComplete(environment=process.env,home=homedir()) {
 try{
  const root=brainStateRoot(environment,home),journal=JSON.parse(readFileSync(join(root,'brain-cutover','journal.json'),'utf8')),receipt=verifiedReceipt(root)
  return journal.state==='complete'&&receipt?.open===true&&brainReceiptMatches(journal,receipt)
 }catch{return false}
}
