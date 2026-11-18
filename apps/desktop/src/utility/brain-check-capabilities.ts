// MODULE: brain-check-capabilities.ts - In-memory, one-note installed-check authority; no session can issue it
import {randomBytes,randomUUID} from 'node:crypto'
import type {BrainWorkerClient} from './brain-client'
import type {BrainNote} from './brain-store'
export const BRAIN_INSTALLED_CHECK_BODY='Installed brain write/read/export check.'
export interface BrainCheckGrant {id:string;token:string;socketPath:string;dataRoot:string;expires:number}
interface Scope extends BrainCheckGrant {attempt:string;title:string;noteId:string;phase:'unused'|'creating'|'created'|'exported'|'withdrawing';note?:BrainNote}
export interface BrainCheckTransport {authenticate(token:unknown):string|null;request(id:string,method:string,params:unknown):Promise<unknown>}
export class BrainCheckCapabilities implements BrainCheckTransport {
 private readonly scopes=new Map<string,Scope>()
 constructor(private readonly client:Pick<BrainWorkerClient,'createCheck'|'withdrawCheck'|'currentExport'>,private readonly socketPath:string,private readonly dataRoot:string,private readonly now=Date.now){}
 private live(id:string):Scope {
  const scope=this.scopes.get(id)
  if(!scope||this.now()>=scope.expires){this.scopes.delete(id);throw new Error('The installed brain check scope is unavailable')}
  return scope
 }
 issue(attempt:string,title:string,noteId:string):BrainCheckGrant {
  for(const [id,scope]of this.scopes)if(this.now()>=scope.expires)this.scopes.delete(id)
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(noteId)||this.scopes.size||!/^owner-cutover-[a-f0-9-]{36}$/.test(attempt)||title!=='cutover-check '+attempt.slice(-12))throw new Error('Invalid or overlapping installed brain check')
  const grant={id:randomUUID(),token:'bc1.'+randomBytes(32).toString('hex'),socketPath:this.socketPath,dataRoot:this.dataRoot,expires:this.now()+120_000}
  this.scopes.set(grant.id,{...grant,attempt,title,noteId,phase:'unused'});return grant
 }
 revoke(id:string):void {this.scopes.delete(id)}
 revokeAll():void {this.scopes.clear()}
 authenticate(token:unknown):string|null {
  if(typeof token!=='string'||!/^bc1\.[a-f0-9]{64}$/.test(token))return null
  for(const [id,scope]of this.scopes){if(this.now()>=scope.expires){this.scopes.delete(id);continue}if(scope.token===token)return id}
  return null
 }
 async request(id:string,method:string,raw:unknown):Promise<unknown> {
  const scope=this.live(id)
  const refuse=():never=>{this.revoke(id);throw new Error('The installed check can only create, export and withdraw its one exact note')}
  if(method!=='brain'||!raw||typeof raw!=='object'||Array.isArray(raw))return refuse()
  const params=raw as Record<string,unknown>
  const exact=(expected:Record<string,unknown>)=>Object.keys(params).length===Object.keys(expected).length&&Object.keys(expected).every(key=>params[key]===expected[key])
  if(scope.phase==='unused'&&exact({command:'write',revision:0,title:scope.title,kind:'check',origin:'cutover-check',scope:'all',markdown:BRAIN_INSTALLED_CHECK_BODY})){
   scope.phase='creating'
   try{
    const note=await this.client.createCheck({title:scope.title,kind:'check',origin:'cutover-check',scope:'all',markdown:BRAIN_INSTALLED_CHECK_BODY},scope.attempt,scope.noteId)
    this.live(id)
    if(note.id!==scope.noteId||note.revision!==1||note.origin!=='cutover-check'||note.markdown!==BRAIN_INSTALLED_CHECK_BODY||note.session!==scope.attempt)throw new Error('The installed brain check result differs')
    scope.note=note;scope.phase='created';return note
   }catch(error){this.revoke(id);throw error}
  }
  if(scope.phase==='created'&&exact({command:'export'})){
   scope.phase='exported';try{const folder=await this.client.currentExport();this.live(id);return folder}catch(error){this.revoke(id);throw error}
  }
  if(scope.phase==='exported'&&scope.note&&exact({command:'withdraw',name:scope.note.id,revision:scope.note.revision})){
   scope.phase='withdrawing';try{return await this.client.withdrawCheck(scope.note.id,scope.note.revision,scope.attempt)}finally{this.revoke(id)}
  }
  return refuse()
 }
}
