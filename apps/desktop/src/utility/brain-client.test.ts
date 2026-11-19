// MODULE: brain-client.test.ts - Actual worker, SQLite, authenticated socket and backup fault checks
import { createRequire } from 'node:module'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join,resolve } from 'node:path'
import {spawnSync} from 'node:child_process'
import {runInstalledBrainCli,verifyInstalledBrainCheck} from '../main/brain-installed-check'
import {durableBrainJson} from './brain-cutover-journal'
import {randomUUID} from 'node:crypto'
import {BrainCheckCapabilities,BRAIN_INSTALLED_CHECK_BODY,type BrainCheckGrant} from './brain-check-capabilities'
import { describe,it,expect } from 'vitest'
import { ERROR_CODES } from '@bmn/protocol'
const { call } = await import('../../bin/' + 'bmn-commands.mjs') as { call(socket:string,token:string,method:string,params:Record<string,unknown>):Promise<unknown> }
import { BrainWorkerClient } from './brain-client'
import {brainJournalCommit} from '../../bin/brain-state.mjs'
import type {DatabaseConnection} from './database-initialization'
import { BrainService } from './brain-service'
import { ControlAuth, type ControlScope } from './control-auth'
import { ControlError,ControlServer,MemoryReceiptStore,type ControlHandlers } from './control-server'
const compiler=createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild') as {buildSync(options:Record<string,unknown>):void}
const content={title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'A synthetic fact'}
function cleanup(path:string):void {
 for(const entry of readdirSync(path,{recursive:true,withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())chmodSync(join(entry.parentPath,entry.name),0o700)
 rmSync(path,{recursive:true,force:true})
}
async function fixture(canWrite=()=>true,journalState?:unknown) {
 const root=mkdtempSync(join(tmpdir(),'bmn-br-'));const repo=resolve(import.meta.dirname,'../../../..')
 symlinkSync(join(repo,'apps/desktop/node_modules'),join(root,'node_modules'),'dir')
 const entry=join(root,'brain-worker.cjs')
 compiler.buildSync({entryPoints:[join(repo,'apps/desktop/src/utility/brain-worker.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs'})
 const data=join(root,'data');mkdirSync(data)
 const journal=join(root,'state','brain-cutover','journal.json');if(journalState!==undefined){mkdirSync(dirname(journal),{recursive:true});writeFileSync(journal,JSON.stringify(journalState))}
 const client=new BrainWorkerClient(entry,join(data,'brain.sqlite3'),join(root,'attachments'),journalState===undefined?undefined:journal)
 await client.initialize()
 const service=new BrainService(client,canWrite);const auth=new ControlAuth();let live=true
 const handlers={sessionExists:()=>true,isCurrentIncarnation:()=>live,brainRequest:async(scope:ControlScope,params:Record<string,unknown>)=>{
  try{return await service.request(scope,params)}catch(error){throw new ControlError(ERROR_CODES.invalidArgument,error instanceof Error?error.message:'Brain operation failed')}
 }} as unknown as ControlHandlers
 const socket=join(root,'control.sock');const checks=new BrainCheckCapabilities(client,socket,data);const server=new ControlServer({socketPath:socket,auth,brainChecks:checks,handlers,receipts:new MemoryReceiptStore()});await server.listen()
 const token=auth.sessionToken('synthetic-session','synthetic-incarnation')
 return {root,data,entry,journal,client,server,auth,socket,token,checks,revoke(){live=false},async close(){await server.close();await client.close();cleanup(root)}}
}
describe('brain worker and authenticated write door',()=>{
 it('refuses pre-cutover socket writes and delete, exposes no import or authorization command',async()=>{
  const f=await fixture();try {
   await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only/)
   await expect(call(f.socket,f.token,'brain',{command:'delete'})).rejects.toThrow(/Epic 128/)
   for(const command of ['import','write-door','authorize','cutover'])await expect(call(f.socket,f.token,'brain',{command})).rejects.toThrow(/Unknown brain/)
   await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content,session:'forged'})).rejects.toThrow(/Unknown parameter|Unexpected|not allowed/)
  }finally{await f.close()}
 })
 it('answers the Brain page reads through the real worker only after a completed switch, and the control socket offers none of them (Epic 128 D5)',async()=>{
  const f=await fixture(()=>true,{version:1,state:'running'});try {
   await f.client.importNotes([{source:'synthetic/a.md',title:'Alpha',kind:'fact',origin:'import',scope:'all',markdown:'Alpha links [[Beta]] about backup decision.',status:'active'},
    {source:'synthetic/b.md',title:'Beta',kind:'map',origin:'import',scope:'all',markdown:'Beta decision and a backup.',status:'active'}])
   // Before the switch, and with a matching receipt while the journal is still running, every page read is refused.
   await expect(f.client.pageList({})).rejects.toThrow(/after the switch/)
   const journal=await stagedCommit(f)
   expect(await f.client.commitCutover(journal.commit.payloadHash)).toMatchObject({committed:true})
   expect(await f.client.pageStatus()).toEqual({state:'not-switched'})
   await expect(f.client.pageRead('anything')).rejects.toThrow(/after the switch/)
   for(const state of ['rolling-back','rolled-back']){writeFileSync(f.journal,JSON.stringify({...journal,state}));await expect(f.client.pageList({})).rejects.toThrow(/after the switch/)}
   // A complete journal of another switch never pairs with this receipt (one reading decides both facts).
   const other={...journal,state:'complete',cutoverId:'22222222-2222-4222-8222-222222222222'};other.commit=brainJournalCommit(other,(await f.client.admission()).storeId)
   writeFileSync(f.journal,JSON.stringify(other));expect(await f.client.pageStatus()).toEqual({state:'not-switched'})
   writeFileSync(f.journal,JSON.stringify({...journal,state:'complete'}))
   expect(await f.client.pageStatus()).toEqual({state:'ready'})
   expect((await f.client.pageList({})).notes.map(n=>n.title).sort()).toEqual(['Alpha','Beta'])
   const found=await f.client.pageSearch('decision backup',false)
   expect(found.notes.map(n=>n.title).sort()).toEqual(['Alpha','Beta'])
   const alpha=found.notes.find(n=>n.title==='Alpha')!
   expect((await f.client.pageRead(alpha.id)).linksTo.map(n=>n.title)).toEqual(['Beta'])
   expect((await f.client.pageHistory(alpha.id)).map(v=>v.revision)).toEqual([1])
   expect((await f.client.pageGraph(alpha.id,{})).nodes).toHaveLength(2)
   for(const command of ['list','page-list','page-read','page-search','page-graph'])await expect(call(f.socket,f.token,'brain',{command})).rejects.toThrow(/Unknown brain/)
   await expect(call(f.socket,f.token,'app.brainPage',{command:'list'})).rejects.toThrow(/Unknown method|not allowed|invalid/i)
  }finally{await f.close()}
 })
 it('uses the authenticated session for caps and atomically refuses a racing stale writer',async()=>{
  const f=await fixture();try {
   await f.client.setWriteDoor(true)
   const first=await call(f.socket,f.token,'brain',{command:'write',revision:0,...content}) as {id:string;revision:number}
   const edits=await Promise.allSettled(['First [[First target]]','Second [[Second target]]'].map(markdown=>call(f.socket,f.token,'brain',{command:'edit',name:first.id,revision:1,...content,markdown})))
   expect(edits.filter(r=>r.status==='fulfilled')).toHaveLength(1)
   expect(edits.filter(r=>r.status==='rejected')).toHaveLength(1)
   const winner=edits.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{markdown:string}>
   const loser=edits.find(r=>r.status==='rejected') as PromiseRejectedResult
   expect(loser.reason.message).toMatch(/revision is 2; read again/)
   const coherent=await f.client.read(first.id,{links:true})
   expect(coherent).toMatchObject({revision:2,markdown:winner.value.markdown})
   expect(coherent.links).toEqual([{kind:'note',target:winner.value.markdown.startsWith('First')?'First target':'Second target',resolved:null}])
   expect((await f.client.history(first.id)).map(row=>[row.revision,row.markdown])).toEqual([[1,content.markdown],[2,winner.value.markdown]])
   expect((await f.client.search(winner.value.markdown.split(' ')[0]!)).map(row=>row.id)).toContain(first.id)
   expect((await f.client.search(winner.value.markdown.startsWith('First')?'Second':'First')).map(row=>row.id)).not.toContain(first.id)
   for(const title of ['Two','Three'])await call(f.socket,f.token,'brain',{command:'write',revision:0,...content,title})
   await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content,title:'Four',origin:'import'})).rejects.toThrow(/3 brain notes/)
   const read=await f.client.read(first.id);expect(read.session).toBe('synthetic-session');expect(read.revision).toBe(2)
   const exported=JSON.parse(readFileSync(join(f.data,'brain-export','latest.json'),'utf8')) as {folder:string}
   expect(readFileSync(join(exported.folder,first.id+'.md'),'utf8')).toBe(read.markdown)
   f.revoke();await expect(call(f.socket,f.token,'brain',{command:'read',name:first.id})).rejects.toThrow()
  }finally{await f.close()}
 })
 it('records a real backup-folder permission failure for Health and recovers on retry',async()=>{
  const f=await fixture();try {
   const path=join(f.data,'brain-backups');mkdirSync(path,{mode:0o500});chmodSync(path,0o500)
   await expect(f.client.scheduledBackup('2026-11-17T04:00:00Z')).rejects.toThrow()
   expect(JSON.parse(readFileSync(join(f.data,'brain-health.json'),'utf8')).backup).toBe('failed')
   chmodSync(path,0o700);await f.client.scheduledBackup('2026-11-17T04:00:00Z')
   expect(JSON.parse(readFileSync(join(f.data,'brain-health.json'),'utf8')).backup).toBe('ok')
  }finally{await f.close()}
 })
})

it('holds live session mutations while an uncommitted or failed rollback leaves the worker door open',async()=>{
 let committed=false;const f=await fixture(()=>committed)
 try{
  await f.client.setWriteDoor(true)
  const note=await f.client.create(content,'trusted-installed-check')
  for(const command of ['write','edit','withdraw','restore']){
   const params=command==='write'?{command,revision:0,...content,title:'Uncommitted fact'}:command==='edit'?{command,name:note.id,revision:1,...content}:{command,name:note.id,revision:1}
   await expect(call(f.socket,f.token,'brain',params)).rejects.toThrow(/read-only until/)
  }
  expect((await f.client.list()).length).toBe(1);expect((await f.client.read(note.id)).revision).toBe(1)
  committed=true
  const written=await call(f.socket,f.token,'brain',{command:'write',revision:0,...content,title:'Committed fact'}) as {revision:number}
  expect(written.revision).toBe(1)
 }finally{await f.close()}
})

it('retains an outstanding scheduled failure through a checkpoint, skipped tick and worker restart',async()=>{
 const f=await fixture();let restarted:BrainWorkerClient|undefined
 try {
  await f.client.scheduledBackup('2026-01-01T04:00:00Z')
  const backups=join(f.data,'brain-backups');chmodSync(backups,0o500)
  await expect(f.client.scheduledBackup('2026-01-02T04:00:00Z')).rejects.toThrow()
  const health=()=>JSON.parse(readFileSync(join(f.data,'brain-health.json'),'utf8'))
  expect(health().backup).toBe('failed')
  chmodSync(backups,0o700)
  await f.client.backup();expect(health().backup).toBe('failed')
  await f.client.scheduledBackup('2026-01-01T05:00:00Z');expect(health().backup).toBe('failed')
  await f.client.close()
  restarted=new BrainWorkerClient(join(f.root,'brain-worker.cjs'),join(f.data,'brain.sqlite3'),join(f.root,'attachments'))
  await restarted.initialize();await restarted.scheduledBackup('2026-01-01T06:00:00Z')
  expect(health().backup).toBe('failed')
  await restarted.scheduledBackup('2026-01-02T04:01:00Z');expect(health().backup).toBe('ok')
 }finally{await restarted?.close();await f.close()}
})

it('looks up the published export without refreshing DB attachments from a held session and refuses public backup',async()=>{
 const f=await fixture(()=>false)
 try {
  const attachments=join(f.root,'attachments');mkdirSync(attachments);writeFileSync(join(attachments,'asset.bin'),'original synthetic asset')
  await f.client.importNotes([{...content,source:'vault:note.md',status:'active',markdown:'[asset](files/asset.bin)'}])
  const before=await f.client.dump(),latest=readFileSync(join(f.data,'brain-export','latest.json'),'utf8')
  const snapshots=readdirSync(join(f.data,'brain-backups')).sort()
  writeFileSync(join(attachments,'asset.bin'),'changed external synthetic asset')
  const published=await call(f.socket,f.token,'brain',{command:'export'})
  expect(typeof published).toBe('string')
  expect(await f.client.dump()).toEqual(before)
  expect(readFileSync(join(f.data,'brain-export','latest.json'),'utf8')).toBe(latest)
  await expect(call(f.socket,f.token,'brain',{command:'backup'})).rejects.toThrow(/Unknown brain command/)
  expect(readdirSync(join(f.data,'brain-backups')).sort()).toEqual(snapshots)
 }finally{await f.close()}
})

it.each([
 {state:'complete'},
 {version:1,state:'complete',phases:['write-door','installed-checks','complete'],commit:{version:1,cutoverId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222',payloadHash:'a'.repeat(64)}}
])('holds the real worker/socket when only a completion journal is forged: %j',async state=>{
 const f=await fixture(()=>true,state)
 try{
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only|held|receipt/)
  expect(await f.client.list()).toHaveLength(0)
 }finally{await f.close()}
})
it('a private operational door Boolean cannot admit sessions before trusted recovery or commitment',async()=>{
 const f=await fixture(()=>true,{version:1,state:'running'})
 try{
  await f.client.setWriteDoor(true)
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only|held|receipt/)
  expect(await f.client.list()).toHaveLength(0)
 }finally{await f.close()}
})

async function stagedCommit(f:Awaited<ReturnType<typeof fixture>>) {
 const status=await f.client.admission()
 const journal={version:1,state:'running',cutoverId:'11111111-1111-4111-8111-111111111111',originatingCommit:'c'.repeat(40),phases:['write-barrier','source-proof','write-door','installed-checks'],watermark:'2026-01-01T00:00:00Z',paths:{journal:dirname(f.journal)},preparation:{synthetic:true},instructionProof:{rehearsed:{},observed:{}},manifest:{'note.md':'a'.repeat(64)},saved:[],modes:[],timers:{},brainHeads:{},checks:{synthetic:true},commit:{} as ReturnType<typeof brainJournalCommit>}
 journal.commit=brainJournalCommit(journal,status.storeId)
 writeFileSync(f.journal,JSON.stringify(journal))
 return journal
}
it('publishes a genuine receipt atomically, keeps a staged journal held and requires trusted recovery on every worker restart',async()=>{
 const f=await fixture(()=>true,{version:1,state:'running'});let restarted:BrainWorkerClient|undefined
 try{
  const journal=await stagedCommit(f)
  expect(await f.client.commitCutover(journal.commit.payloadHash)).toMatchObject({committed:true,open:false})
  await expect(f.client.create(content,'ordinary-session')).rejects.toThrow(/read-only/)
  journal.state='complete';writeFileSync(f.journal,JSON.stringify(journal))
  await expect(f.client.create(content,'ordinary-session')).rejects.toThrow(/read-only/)
  expect(await f.client.resumeCutover()).toMatchObject({committed:true,open:true})
  const note=await call(f.socket,f.token,'brain',{command:'write',revision:0,...content}) as {id:string}
  await f.client.close()
  restarted=new BrainWorkerClient(f.entry,join(f.data,'brain.sqlite3'),join(f.root,'attachments'),f.journal)
  await restarted.initialize()
  expect(await restarted.admission()).toMatchObject({committed:true,open:false})
  await expect(restarted.edit(note.id,1,{...content,markdown:'Held until recovery'},'session-after-restart')).rejects.toThrow(/read-only/)
  expect((await restarted.read(note.id)).revision).toBe(1)
  expect(await restarted.resumeCutover()).toMatchObject({open:true})
  expect((await restarted.edit(note.id,1,{...content,markdown:'Recovered synthetic fact'},'session-after-restart')).revision).toBe(2)
 }finally{await restarted?.close();await f.close()}
})
it('holds changed evidence and receipt copies from another store without changing heads',async()=>{
 const f=await fixture(()=>true,{version:1,state:'running'}),other=await fixture(()=>true,{version:1,state:'running'})
 try{
  const journal=await stagedCommit(f);await f.client.commitCutover(journal.commit.payloadHash)
  journal.state='complete';writeFileSync(f.journal,JSON.stringify(journal));await f.client.resumeCutover()
  const note=await f.client.create(content,'original-session'),receipt=(await f.client.admission()).receipt
  const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
  const copied=new SQLite(join(other.data,'brain.sqlite3'))
  try{copied.prepare("INSERT OR REPLACE INTO brain_meta(key,value) VALUES('cutover_receipt',?)").run(JSON.stringify(receipt));copied.prepare("UPDATE brain_meta SET value='open' WHERE key='write_door'").run()}finally{copied.close()}
  writeFileSync(other.journal,JSON.stringify(journal))
  expect(await other.client.admission()).toMatchObject({committed:false,open:false})
  await expect(other.client.resumeCutover()).rejects.toThrow(/recovery/)
  await expect(other.client.create({...content,title:'Copied receipt'},'other-session')).rejects.toThrow(/read-only/)
  journal.preparation={synthetic:false};writeFileSync(f.journal,JSON.stringify(journal))
  await expect(f.client.edit(note.id,1,{...content,markdown:'Changed source evidence'},'original-session')).rejects.toThrow(/read-only/)
  expect((await f.client.read(note.id)).revision).toBe(1)
  journal.preparation={synthetic:true};writeFileSync(f.journal,JSON.stringify(journal))
  expect(await f.client.admission()).toMatchObject({committed:true,open:false})
 }finally{await other.close();await f.close()}
})
it('durably revokes a receipt and refuses its replay even with an independently flipped operational door',async()=>{
 const f=await fixture(()=>true,{version:1,state:'running'})
 try{
  const journal=await stagedCommit(f);await f.client.commitCutover(journal.commit.payloadHash)
  journal.state='complete';writeFileSync(f.journal,JSON.stringify(journal));await f.client.resumeCutover()
  const receipt=(await f.client.admission()).receipt
  await f.client.setWriteDoor(false)
  const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection,db=new SQLite(join(f.data,'brain.sqlite3'))
  try{db.prepare("INSERT OR REPLACE INTO brain_meta(key,value) VALUES('cutover_receipt',?)").run(JSON.stringify(receipt));db.prepare("INSERT OR REPLACE INTO brain_meta(key,value) VALUES('owner_authorization','forged')").run();db.prepare("UPDATE brain_meta SET value='open' WHERE key='write_door'").run()}finally{db.close()}
  expect(await f.client.admission()).toMatchObject({committed:false,open:false})
  await expect(f.client.resumeCutover()).rejects.toThrow(/recovery/)
  await expect(f.client.commitCutover(journal.commit.payloadHash)).rejects.toThrow(/revoked/)
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only/)
  expect(await f.client.list()).toHaveLength(0)
 }finally{await f.close()}
})

it('the actual bmn help CLI reads the matching SQLite receipt and holds bare or revoked completion',async()=>{
 const f=await fixture(()=>true,{state:'complete'})
 const environment={...process.env,HOME:f.root,BMN_DATA_HOME:f.data,BMN_STATE_HOME:join(f.root,'state')}
 const brief=()=>{
  const result=spawnSync(process.execPath,[resolve(import.meta.dirname,'../../bin/bmn'),'help','agents'],{env:environment,encoding:'utf8',timeout:5000})
  expect(result.status,result.stderr).toBe(0)
  return result.stdout
 }
 try{
  expect(brief()).toContain('Brain switch: point him')
  const journal=await stagedCommit(f);await f.client.commitCutover(journal.commit.payloadHash)
  expect(brief()).toContain('Brain switch: point him')
  journal.state='complete';writeFileSync(f.journal,JSON.stringify(journal));await f.client.resumeCutover()
  expect(brief()).not.toContain('Brain switch: point him')
  await f.client.setWriteDoor(false)
  expect(brief()).toContain('Brain switch: point him')
  expect(await f.client.list()).toHaveLength(0)
 }finally{await f.close()}
})

async function installedCli(args:string[],grant:BrainCheckGrant,root:string):Promise<{code:number;output:string;error:string}>{
 try{
  const value=await runInstalledBrainCli({bin:join(import.meta.dirname,'../../bin'),grant,args,guard:()=>{},environment:{...process.env,HOME:root}})
  return {code:0,output:JSON.stringify(value),error:''}
 }catch(error){return {code:1,output:'',error:error instanceof Error?error.message:'Installed CLI failed'}}
}
it('runs actual bmn write/read/export/withdraw through an inherited scope and real socket while ordinary sessions remain held',async()=>{
 const f=await fixture(()=>false,{version:1,state:'running'}),attempt='owner-cutover-'+randomUUID(),title='cutover-check '+attempt.slice(-12),body=join(f.root,'check.md')
 try{
  await f.client.setWriteDoor(true);writeFileSync(body,BRAIN_INSTALLED_CHECK_BODY)
  const grant=f.checks.issue(attempt,title,randomUUID())
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only/)
  const write=await installedCli(['write',title,'--revision','0','--text-file',body,'--kind','check','--origin','cutover-check'],grant,f.root)
  expect(write.code,write.error).toBe(0)
  const note=JSON.parse(write.output)
  expect(note).toMatchObject({revision:1,origin:'cutover-check',session:attempt,markdown:BRAIN_INSTALLED_CHECK_BODY})
  const read=await installedCli(['read',note.id],grant,f.root);expect(read.code,read.error).toBe(0);expect(JSON.parse(read.output)).toMatchObject({id:note.id,revision:note.revision,origin:note.origin,session:note.session,markdown:note.markdown,checksum:note.checksum,status:note.status})
  const exported=await installedCli(['export'],grant,f.root);expect(exported.code,exported.error).toBe(0)
  expect(readFileSync(join(JSON.parse(exported.output),note.id+'.md'),'utf8')).toBe(BRAIN_INSTALLED_CHECK_BODY)
  const withdrawn=await installedCli(['withdraw',note.id,'--revision','1'],grant,f.root);expect(withdrawn.code,withdrawn.error).toBe(0);expect(JSON.parse(withdrawn.output)).toMatchObject({id:note.id,status:'withdrawn',revision:2})
  expect(f.checks.authenticate(grant.token)).toBe(null)
  const replay=await installedCli(['withdraw',note.id,'--revision','1'],grant,f.root);expect(replay.code).toBe(1)
  expect([write.output,write.error,read.output,exported.output,withdrawn.output,replay.error].join('')).not.toContain(grant.token)
  expect(await f.client.admission()).toMatchObject({committed:false,open:false})
 }finally{await f.close()}
})
it('rejects wrong check targets, revisions, non-brain methods and revoked scopes on the actual socket',async()=>{
 const f=await fixture(()=>false,{version:1,state:'running'})
 try{
  await f.client.setWriteDoor(true)
  for(const request of [{method:'state.snapshot',params:{}},{method:'brain',params:{command:'write',revision:0,...content}},{method:'brain',params:{command:'withdraw',name:'other-note',revision:1}}]){
   const attempt='owner-cutover-'+randomUUID(),grant=f.checks.issue(attempt,'cutover-check '+attempt.slice(-12),randomUUID())
   await expect(call(f.socket,grant.token,request.method,request.params)).rejects.toThrow(/one exact note/)
   expect(f.checks.authenticate(grant.token)).toBe(null)
  }
  const attempt='owner-cutover-'+randomUUID(),grant=f.checks.issue(attempt,'cutover-check '+attempt.slice(-12),randomUUID());f.checks.revokeAll()
  await expect(call(f.socket,grant.token,'brain',{command:'export'})).rejects.toThrow(/Invalid credential/)
  expect(await f.client.list()).toHaveLength(0)
 }finally{await f.close()}
})

it('the installed runner refuses a broken launcher, broken socket and pre-launch cancellation without a direct-write fallback',async()=>{
 const f=await fixture(()=>false,{version:1,state:'running'}),attempt='owner-cutover-'+randomUUID()
 try{
  await f.client.setWriteDoor(true)
  const grant=f.checks.issue(attempt,'cutover-check '+attempt.slice(-12),randomUUID()),body=join(f.root,'check.md'),broken=join(f.root,'broken-bin')
  writeFileSync(body,BRAIN_INSTALLED_CHECK_BODY);mkdirSync(broken);writeFileSync(join(broken,'bmn'),'#!/bin/sh\nexit 19\n',{mode:0o700})
  const args=['write','cutover-check '+attempt.slice(-12),'--revision','0','--text-file',body,'--kind','check','--origin','cutover-check']
  const options={bin:join(import.meta.dirname,'../../bin'),grant,args,guard:()=>{},environment:{...process.env,HOME:f.root}}
  await expect(runInstalledBrainCli({...options,bin:broken})).rejects.toThrow(/Installed bmn brain failed/)
  await expect(runInstalledBrainCli({...options,grant:{...grant,socketPath:join(f.root,'absent.sock')}})).rejects.toThrow(/Installed bmn brain failed/)
  const controller=new AbortController();controller.abort()
  await expect(runInstalledBrainCli({...options,signal:controller.signal})).rejects.toThrow(/cancelled/)
  expect(await f.client.list()).toHaveLength(0);f.checks.revoke(grant.id)
  expect(f.checks.authenticate(grant.token)).toBe(null)
 }finally{await f.close()}
})
it('revokes a scope on the wrong returned-note revision and expires it without admitting a session',async()=>{
 const f=await fixture(()=>false,{version:1,state:'running'})
 try{
  await f.client.setWriteDoor(true)
  const attempt='owner-cutover-'+randomUUID(),title='cutover-check '+attempt.slice(-12),grant=f.checks.issue(attempt,title,randomUUID())
  const note=await call(f.socket,grant.token,'brain',{command:'write',revision:0,title,kind:'check',origin:'cutover-check',scope:'all',markdown:BRAIN_INSTALLED_CHECK_BODY}) as {id:string}
  await call(f.socket,grant.token,'brain',{command:'export'})
  await expect(call(f.socket,grant.token,'brain',{command:'withdraw',name:note.id,revision:2})).rejects.toThrow(/one exact note/)
  expect(f.checks.authenticate(grant.token)).toBe(null);expect(await f.client.read(note.id)).toMatchObject({revision:1,status:'active'})
  let now=1000;const expiring=new BrainCheckCapabilities(f.client,f.socket,f.data,()=>now),second='owner-cutover-'+randomUUID(),temporary=expiring.issue(second,'cutover-check '+second.slice(-12),randomUUID())
  now=temporary.expires;expect(expiring.authenticate(temporary.token)).toBe(null)
  await expect(expiring.request(temporary.id,'brain',{command:'export'})).rejects.toThrow(/scope is unavailable/)
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only/)
 }finally{await f.close()}
})

it('reports a committed write when export fails and regenerates it without replaying the note revision',async()=>{
 const f=await fixture()
 try{
  await f.client.setWriteDoor(true)
  const path=join(f.data,'brain-export');chmodSync(path,0o500)
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/change saved, but export failed/)
  const notes=await f.client.list();expect(notes).toHaveLength(1);const note=notes[0]!
  expect(note).toMatchObject({revision:1,markdown:content.markdown});expect(await f.client.history(note.id)).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(f.data,'brain-health.json'),'utf8')).export).toBe('failed')
  chmodSync(path,0o700);const published=await f.client.export()
  expect(readFileSync(join(published,note.id+'.md'),'utf8')).toBe(content.markdown)
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/edit note/)
  expect(await f.client.read(note.id)).toEqual(note);expect(await f.client.history(note.id)).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(f.data,'brain-health.json'),'utf8')).export).toBe('ok')
 }finally{await f.close()}
})

it.each(['success','lost-create-reply','writable-export','lost-withdraw-return'])('drives the production installed proof with a real current symlink and exact held recovery (%s)',async fault=>{
 const f=await fixture(()=>false,{version:1,state:'running'}),attempt='owner-cutover-'+randomUUID(),intent={note:randomUUID(),attempt,title:'cutover-check '+attempt.slice(-12),body:BRAIN_INSTALLED_CHECK_BODY}
 try{
  await f.client.importNotes([{source:'vault:ordinary.md',...content,title:'Ordinary preserved',markdown:'Ordinary preserved bytes',status:'active'}])
  durableBrainJson(f.journal,{version:1,state:'running',checkIntent:intent})
  await f.client.setWriteDoor(true)
  const create=f.client.createCheck.bind(f.client),lookup=f.client.currentExport.bind(f.client)
  if(fault==='lost-create-reply')f.client.createCheck=async(...args)=>{await create(...args);throw new Error('Synthetic lost create reply')}
  if(fault==='writable-export')f.client.currentExport=async()=>{const folder=await lookup();chmodSync(folder,0o755);return folder}
  const admin=async<T>(command:string,params:Record<string,unknown>={}):Promise<T>=>{
   if(command==='issue-check')return f.checks.issue(String(params.attempt),String(params.title),String(params.noteId)) as T
   if(command==='revoke-check'){f.checks.revoke(String(params.id));if(fault==='lost-withdraw-return')throw new Error('Synthetic lost callback return');return undefined as T}
   throw new Error('Unexpected private command '+command)
  }
  const proof=verifyInstalledBrainCheck({bin:resolve(import.meta.dirname,'../../bin'),journal:dirname(f.journal),intent,admin,guard:()=>{},environment:{...process.env,HOME:f.root}})
  if(fault==='success')expect(await proof).toMatchObject({note:intent.note,export:join(f.data,'brain-export','current')})
  else await expect(proof).rejects.toThrow(fault==='lost-create-reply'?/lost create reply/:fault==='writable-export'?/writable/:/lost callback return/)
  f.checks.revokeAll();await f.client.setWriteDoor(false)
  if(fault==='writable-export'){
   await expect(f.client.recoverCheck(intent)).rejects.toThrow(/change saved, but export failed/)
   expect(await f.client.read(intent.note)).toMatchObject({revision:2,status:'withdrawn'})
   chmodSync(join(f.data,'brain-export','current'),0o555) // Repair only the corruption this synthetic fixture injected.
  }
  expect(await f.client.recoverCheck(intent)).toEqual({note:intent.note,status:'withdrawn'})
  expect(await f.client.recoverCheck(intent)).toEqual({note:intent.note,status:'withdrawn'})
  expect(await f.client.history(intent.note)).toHaveLength(2)
  expect(await f.client.read(intent.note)).toMatchObject({id:intent.note,revision:2,status:'withdrawn'})
  expect(await f.client.read('Ordinary preserved')).toMatchObject({revision:1,markdown:'Ordinary preserved bytes'})
  await expect(call(f.socket,f.token,'brain',{command:'write',revision:0,...content})).rejects.toThrow(/read-only/)
 }finally{await f.close()}
})

it.each(['rules-prior','rules-history','check-intent','legacy-receipt','malformed-receipt'])('holds altered immutable recovery evidence and never converts an uncertain receipt to absence (%s)',async fault=>{
 const f=await fixture(()=>true,{version:1,state:'running'})
 try{
  const journal=await stagedCommit(f);await f.client.commitCutover(journal.commit.payloadHash)
  journal.state='complete';writeFileSync(f.journal,JSON.stringify(journal));await f.client.resumeCutover()
  if(fault==='rules-prior'||fault==='rules-history'||fault==='check-intent'){
   const altered:Record<string,unknown>={...journal}
   if(fault==='rules-prior')altered.rules={id:'synthetic',targets:[{priorRecord:'Changed original record'}],history:null}
   if(fault==='rules-history')altered.rules={id:'synthetic',targets:[],history:{revision:99,hash:'b'.repeat(64)}}
   if(fault==='check-intent')altered.checkIntent={note:randomUUID(),attempt:'Changed attempt'}
   writeFileSync(f.journal,JSON.stringify(altered))
  }else{
   const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection,db=new SQLite(join(f.data,'brain.sqlite3'))
   try{db.prepare("UPDATE brain_meta SET value=? WHERE key='cutover_receipt'").run(fault==='legacy-receipt'?JSON.stringify({...journal.commit,version:1}):'{invalid JSON')}finally{db.close()}
  }
  expect(await f.client.admission()).toMatchObject({committed:false,open:false,receiptState:fault==='legacy-receipt'||fault==='malformed-receipt'?'invalid':'present'})
  await expect(f.client.setWriteDoor(false)).rejects.toThrow(/receipt cannot be retired/)
  await expect(f.client.create(content,'held-session')).rejects.toThrow(/read-only/)
  expect((await f.client.admission()).receiptState).not.toBe('absent')
 }finally{await f.close()}
})
