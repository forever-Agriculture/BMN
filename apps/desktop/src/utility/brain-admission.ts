// MODULE: brain-admission.ts - Worker-owned durable commit publication and held-until-recovered admission
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {brainJournalCommit,brainReceiptMatches,type BrainCommitReceipt} from '../../bin/brain-state.mjs'
import {BrainError,type BrainStore} from './brain-store'
export interface BrainAdmissionStatus {storeId:string;committed:boolean;open:boolean;receipt:BrainCommitReceipt|null;receiptState?:'absent'|'present'|'invalid';retired?:BrainCommitReceipt;returnAuthorized?:string}
export class BrainAdmission {
 private recovered=false
 readonly storeId:string
 constructor(private readonly store:BrainStore,private readonly journal:string) {
  store.database.pragma('synchronous = FULL')
  store.database.prepare("INSERT OR IGNORE INTO brain_meta(key,value) VALUES('store_id',?)").run(randomUUID())
  this.storeId=this.meta('store_id')!
 }
 private meta(key:string):string|undefined {return (this.store.database.prepare('SELECT value FROM brain_meta WHERE key=?').get(key) as {value:string}|undefined)?.value}
 private receipt():BrainCommitReceipt|null {try{const value=JSON.parse(this.meta('cutover_receipt')??'null') as BrainCommitReceipt|null;return value?.version===2&&/^[a-f0-9-]{36}$/.test(value.cutoverId)&&/^[a-f0-9-]{36}$/.test(value.storeId)&&/^[a-f0-9]{64}$/.test(value.payloadHash)?value:null}catch{return null}}
 private saved():Record<string,unknown> {return JSON.parse(readFileSync(this.journal,'utf8')) as Record<string,unknown>}
 status():BrainAdmissionStatus {
  const receipt=this.receipt();let committed=false,complete=false
  try{const saved=this.saved();complete=saved.state==='complete';committed=receipt?.storeId===this.storeId&&this.meta('cutover_revoked:'+receipt.cutoverId)===undefined&&brainReceiptMatches(saved,receipt)}catch{/* Missing or malformed evidence stays held. */}
  if(!committed)this.recovered=false
  let retired:BrainCommitReceipt|undefined
  try{
   const saved=this.saved(),commit=saved.commit as BrainCommitReceipt|undefined
   if(commit?.storeId===this.storeId){
    const old=JSON.parse(this.meta('cutover_revoked:'+commit.cutoverId)??'null') as (BrainCommitReceipt&{revoked?:boolean})|null
    if(old?.revoked===true&&brainReceiptMatches(saved,{...old,revoked:false})&&['version','cutoverId','storeId','payloadHash'].every(key=>old[key as keyof BrainCommitReceipt]===commit[key as keyof BrainCommitReceipt]))retired=commit
   }
  }catch{/* Retirement is evidence of closed admission, never start authority. */}
  let returnAuthorized:string|undefined
  const bound=committed?receipt:retired
  if(bound){try{const record=JSON.parse(this.meta('cutover_return:'+bound.cutoverId)??'null') as {payloadHash?:string}|null;if(record?.payloadHash===bound.payloadHash)returnAuthorized=bound.cutoverId}catch{/* An unreadable record authorizes nothing. */}}
  const raw=this.meta('cutover_receipt'),receiptState=raw===undefined?'absent':receipt&&receipt.version===2?'present':'invalid'
  return {storeId:this.storeId,committed,receiptState,open:committed&&complete&&this.recovered&&this.store.isOpen(),receipt,...(retired?{retired}:{}),...(returnAuthorized?{returnAuthorized}:{})}
 }
 assert():void {if(!this.status().open)throw new BrainError('CUTOVER_PENDING','The brain is read-only: its matching commit receipt and trusted recovery are required')}
 /** This inherited-port operation publishes a decision already made by the live main process. */
 commit(expectedHash:string):BrainAdmissionStatus {
  const saved=this.saved(),receipt=brainJournalCommit(saved,this.storeId)
  if(receipt.payloadHash!==expectedHash||!brainReceiptMatches(saved,receipt))throw new Error('Brain staged commit payload changed')
  const prior=this.receipt()
  if(this.meta('cutover_receipt')!==undefined&&!prior)throw new Error('Malformed prior brain receipt requires inspection')
  if(this.meta('cutover_revoked:'+receipt.cutoverId)!==undefined)throw new Error('The brain commit receipt was revoked')
  if(prior&&JSON.stringify(prior)!==JSON.stringify(receipt))throw new Error('Another brain commit receipt requires recovery')
  this.store.database.transaction(()=>{
   this.store.database.prepare("INSERT INTO brain_meta(key,value) VALUES('cutover_receipt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(receipt))
   this.store.setWriteDoor(true)
  })()
  // Publishing the door does not admit this process until the complete journal is read back.
  return this.status()
 }
 resume():BrainAdmissionStatus {
  this.recovered=false
  const status=this.status()
  if(!status.committed||!this.store.isOpen()||this.saved().state!=='complete')throw new Error('Brain recovery did not prove the committed journal/receipt pair')
  this.recovered=true;return this.status()
 }
 /** The owner's confirmed return, recorded by the live main process before rollback closes the door. */
 authorizeReturn():BrainAdmissionStatus {
  const status=this.status()
  if(!status.committed||!status.receipt)throw new Error('Only a completed brain switch can be returned')
  this.store.database.prepare('INSERT OR IGNORE INTO brain_meta(key,value) VALUES(?,?)').run('cutover_return:'+status.receipt.cutoverId,JSON.stringify({payloadHash:status.receipt.payloadHash,at:new Date().toISOString()}))
  return this.status()
 }
 revoke():void {
  this.recovered=false
  this.store.database.transaction(()=>{
   const receipt=this.receipt()
   if(this.meta('cutover_receipt')!==undefined&&!receipt)throw new Error('Malformed brain receipt cannot be retired')
   if(receipt){
    if(receipt.storeId!==this.storeId||!brainReceiptMatches(this.saved(),receipt))throw new Error('Mismatched brain receipt cannot be retired')
    this.store.database.prepare('INSERT OR REPLACE INTO brain_meta(key,value) VALUES(?,?)').run('cutover_revoked:'+receipt.cutoverId,JSON.stringify({...receipt,revoked:true}))
    this.store.database.prepare("DELETE FROM brain_meta WHERE key='cutover_receipt'").run()
   }
   this.store.setWriteDoor(false)
  })()
 }
}
