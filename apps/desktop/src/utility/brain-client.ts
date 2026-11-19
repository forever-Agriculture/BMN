// MODULE: brain-client.ts - Typed requests to the brain's independent owning worker
import { Worker } from 'node:worker_threads'
import type { BrainAdmissionStatus } from './brain-admission'
import { BrainError, type BrainContent, type BrainImport, type BrainNote, type BrainLink } from './brain-store'
import type { BrainGraph, BrainPageList, BrainPageNote, BrainPageSearch, BrainPageVersion } from './brain-page'
type ReadNote = BrainNote & { links?: BrainLink[]; backlinks?: BrainLink[] }
export class BrainWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, {resolve(value:unknown):void;reject(error:Error):void}>()
  admissionState:BrainAdmissionStatus|null=null
  private nextId=1
  private closed=false
  private failure: Error | undefined
  constructor(entry: string, databasePath: string, attachmentsRoot?: string,cutoverJournal?:string) {
    this.worker=new Worker(entry,{workerData:{databasePath,attachmentsRoot,cutoverJournal}})
    this.worker.on('message',(response:{id:number;result?:unknown;error?:{code:string;message:string};admission?:BrainAdmissionStatus})=>{
      if(response.admission)this.admissionState=response.admission
      const pending=this.pending.get(response.id);if(!pending)return
      this.pending.delete(response.id)
      if(response.error)pending.reject(new BrainError(response.error.code,response.error.message))
      else pending.resolve(response.result)
    })
    this.worker.on('error',error=>this.fail(error))
    this.worker.on('exit',code=>{if(!this.closed)this.fail(new Error(`Brain worker exited (${code})`))})
  }
  initialize() { return this.request('initialize') as Promise<{open:boolean;notes:number}> }
  read(name:string,options:{section?:string;links?:boolean}={}) {return this.request('read',[name,options]) as Promise<ReadNote>}
  search(query:string,archived=false) {return this.request('search',[query,archived]) as Promise<{id:string;title:string;summary:string;score:number}[]>}
  startupContext(project: string) { return this.request('startup-context', [project]) as Promise<string | null> }
  list() {return this.request('list') as Promise<BrainNote[]>}
  history(name:string) {return this.request('history',[name]) as Promise<BrainNote[]>}
  pageStatus() {return this.request('page-status') as Promise<{state:'ready'|'not-switched'}>}
  pageList(options:{archived?:boolean;withdrawn?:boolean;offset?:number}) {return this.request('page-list',[options]) as Promise<BrainPageList>}
  pageSearch(query:string,archived:boolean) {return this.request('page-search',[query,archived]) as Promise<BrainPageSearch>}
  pageRead(id:string) {return this.request('page-read',[id]) as Promise<BrainPageNote>}
  pageHistory(id:string) {return this.request('page-history',[id]) as Promise<BrainPageVersion[]>}
  pageGraph(id:string,options:{depth?:1|2|3;archived?:boolean}) {return this.request('page-graph',[id,options]) as Promise<BrainGraph>}
  create(content:BrainContent,session:string) {return this.request('create',[content,session]) as Promise<BrainNote>}
  edit(name:string,revision:number,content:BrainContent,session:string) {return this.request('edit',[name,revision,content,session]) as Promise<BrainNote>}
  withdraw(name:string,revision:number,session:string) {return this.request('withdraw',[name,revision,session]) as Promise<BrainNote>}
  restore(name:string,revision:number,session:string) {return this.request('restore',[name,revision,session]) as Promise<BrainNote>}
  delete() {return this.request('delete')}
  importNotes(notes:BrainImport[]) {return this.request('import',[notes]) as Promise<{imported:number;unchanged:number;withdrawn:number;checkpoint:string}>}
  admission() {return this.request('admission-status') as Promise<BrainAdmissionStatus>}
  commitCutover(payloadHash:string) {return this.request('commit-cutover',[payloadHash]) as Promise<BrainAdmissionStatus>}
  resumeCutover() {return this.request('resume-cutover') as Promise<BrainAdmissionStatus>}
  authorizeReturn() {return this.request('authorize-return') as Promise<BrainAdmissionStatus>}
  returnCapture() {return this.request('return-capture') as Promise<{snapshot:string;projection:import('./brain-return').BrainReturnProjection;objects:string}>}
  createCheck(content:BrainContent,session:string,noteId:string) {return this.request('create-check',[content,session,noteId]) as Promise<BrainNote>}
  recoverCheck(intent:{note:string;attempt:string;title:string}) {return this.request('recover-check',[intent]) as Promise<{note:string;status:'absent'|'withdrawn'}>}
  withdrawCheck(name:string,revision:number,session:string) {return this.request('withdraw-check',[name,revision,session]) as Promise<BrainNote>}
  setWriteDoor(open:boolean) {return this.request('write-door',[open]) as Promise<void>}
  snapshot(path:string) {return this.request('snapshot',[path]) as Promise<boolean>}
  export() {return this.request('export') as Promise<string>}
  currentExport() {return this.request('export-current') as Promise<string>}
  backup() {return this.request('backup') as Promise<string>}
  scheduledBackup(now?:string) {return this.request('scheduled-backup',now?[now]:[]) as Promise<string|null>}
  dump() {return this.request('dump')}
  restoreCheck(backup:string,scratch:string) {return this.request('restore-check',[backup,scratch]) as Promise<{ok:true;notes:number;versions:number;attachments:number}>}
  async close():Promise<void> {
    if(this.closed)return
    try {await this.request('close')} finally {this.closed=true;await this.worker.terminate()}
  }
  private request(operation:string,args:unknown[]=[]):Promise<unknown> {
    if(this.failure)return Promise.reject(this.failure)
    if(this.closed)return Promise.reject(new Error('Brain worker is closed'))
    const id=this.nextId++
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject})
      try{this.worker.postMessage({id,operation,args})}catch(error){this.pending.delete(id);reject(error)}
    })
  }
  private fail(error:Error) {this.admissionState=null;this.failure ??=error;for(const p of this.pending.values())p.reject(error);this.pending.clear()}
}
