// MODULE: brain-files.test.ts - Drive backup retention, attachment bytes, readonly export and scratch restore
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,expect,it,vi } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore } from './brain-store'
import { BrainFiles,fileHash } from './brain-files'
import {verifyBrainImportExport} from './brain-export-proof'
import { restoreBrainCheck } from './brain-restore'
import { readQuickLookFile } from './quick-look'
const require=createRequire(import.meta.url)
const SQLite=require('better-sqlite3') as new(path:string,options?:{readonly:boolean})=>DatabaseConnection
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-files-'));const attachments=join(root,'vault','files');mkdirSync(attachments,{recursive:true})
 const store=new BrainStore(new SQLite(join(root,'brain.sqlite3')));const files=new BrainFiles(store,root,attachments)
 return {root,store,files,attachments,close(){store.database.close();for(const entry of readdirSync(root,{recursive:true,withFileTypes:true}))if(entry.isDirectory())chmodSync(join(entry.parentPath,entry.name),0o700);rmSync(root,{recursive:true,force:true})}}
}
describe('brain files',()=>{
 it('publishes readonly verbatim exports including withdrawn history',()=>{
  const f=fixture();try {
   f.store.importNotes([{source:'notes/synthetic.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'# Raw\nExact **text**\n',status:'active'}])
   f.store.setWriteDoor(true);const note=f.store.read('Synthetic');f.store.withdraw(note.id,1,'synthetic-session')
   const folder=f.files.export()
   expect(readFileSync(join(folder,note.id+'.md'),'utf8')).toBe(note.markdown)
   expect(statSync(folder).mode&0o222).toBe(0)
   expect(statSync(join(folder,note.id+'.md')).mode&0o222).toBe(0)
   const manifest=JSON.parse(readFileSync(join(folder,'history.json'),'utf8'))
   expect(manifest.versions).toHaveLength(2)
  }finally{f.close()}
 })
 it('backs up exact attachment content once and restores histories, links and search',()=>{
  const f=fixture();let restored:DatabaseConnection|undefined
  try {
   writeFileSync(join(f.attachments,'synthetic.txt'),'attachment bytes')
   f.store.importNotes([{source:'notes/one.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[[Other]] [attachment](files/synthetic.txt)',status:'active'},{source:'notes/two.md',title:'Other',kind:'fact',origin:'import',scope:'all',markdown:'Український приклад',status:'active'}])
   const first=f.files.snapshot('test');f.files.snapshot('test')
   expect(readdirSync(join(f.files.backupRoot,'objects'))).toHaveLength(1)
   const manifest=JSON.parse(readFileSync(join(first,'manifest.json'),'utf8'))
   expect(restoreBrainCheck(first,join(f.root,'verified-scratch'),path=>new SQLite(path))).toMatchObject({ok:true,notes:2,versions:2})
   expect(fileHash(join(first,'brain.sqlite3'))).toBe(manifest.databaseHash)
   // Query the database that restoreBrainCheck actually rebuilt, not an untouched copy.
   restored=new SQLite(join(f.root,'verified-scratch','brain.sqlite3'),{readonly:true})
   const copy=new BrainStore(restored,false)
   expect(copy.list()).toEqual(f.store.list())
   expect(copy.history('Synthetic')).toEqual(f.store.history('Synthetic'))
   expect(copy.read('Other',{links:true})).toEqual(f.store.read('Other',{links:true}))
   expect(copy.search('Український')).toEqual(f.store.search('Український'))
   for(const a of manifest.attachments)expect(fileHash(join(f.files.backupRoot,'objects',a.hash))).toBe(a.hash)
  }finally{restored?.close();f.close()}
 })
 it('makes up missed nights and retains fourteen nightly/eight weekly snapshots',()=>{
  const f=fixture();try {
   expect(f.files.scheduled(new Date('2026-01-01T04:00:00Z'))).toBeTruthy()
   expect(f.files.scheduled(new Date('2026-01-01T05:00:00Z'))).toBeNull()
   for(let i=1;i<=70;i++)f.files.scheduled(new Date(Date.UTC(2026,0,1+i,4)))
   const names=readdirSync(f.files.backupRoot)
   expect(names.filter(n=>n.startsWith('nightly-'))).toHaveLength(14)
   expect(names.filter(n=>n.startsWith('weekly-'))).toHaveLength(8)
   expect(f.files.scheduled(new Date('2026-03-20T01:00:00Z'))).toBeTruthy()
  }finally{f.close()}
 },30_000)
})

it('bounds regenerable export generations while keeping all note history',()=>{
 const f=fixture()
 try {
  f.store.importNotes([{source:'vault:synthetic.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'Original',status:'active'}])
  f.store.setWriteDoor(true)
  for(let revision=1;revision<=5;revision++) {
   f.files.export();f.store.edit('Synthetic',revision,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'Revision '+revision},'synthetic-session')
  }
  const current=f.files.export()
  expect(readdirSync(f.files.exportRoot).filter(name=>/^[a-f0-9-]{36}$/.test(name))).toHaveLength(2)
  const history=JSON.parse(readFileSync(join(current,'history.json'),'utf8'))
  expect(history.versions).toHaveLength(6)
  expect(history.versions[0].markdown).toBe('Original')
 }finally{f.close()}
})

it('retains live revision objects and every retained checkpoint while reclaiming orphan objects',()=>{
 const f=fixture()
 try {
  const attachment=join(f.attachments,'synthetic.bin');writeFileSync(attachment,'original attachment')
  f.store.importNotes([{source:'vault:synthetic.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/synthetic.bin)',status:'active'}])
  const originalHash=fileHash(attachment)
  f.files.scheduled(new Date('2026-01-01T04:00:00Z'))
  f.store.setWriteDoor(true)
  const orphan='f'.repeat(64);writeFileSync(join(f.files.backupRoot,'objects',orphan),'unreferenced synthetic object')
  for(let day=1;day<=70;day++) {
   writeFileSync(attachment,'synthetic attachment '+day)
   f.store.edit('Synthetic',day,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'[asset](files/synthetic.bin)'},'synthetic-session')
   f.files.scheduled(new Date(Date.UTC(2026,0,1+day,4)))
  }
  const required=new Set<string>()
  for(const name of readdirSync(f.files.backupRoot)) {
   if(!name.startsWith('nightly-')&&!name.startsWith('weekly-'))continue
   const manifest=JSON.parse(readFileSync(join(f.files.backupRoot,name,'manifest.json'),'utf8'))
   for(const asset of manifest.attachments)required.add(asset.hash)
  }
  for(const row of f.files.dump().attachments as {hash:string|null}[])if(row.hash)required.add(row.hash)
  expect(readdirSync(join(f.files.backupRoot,'objects')).sort()).toEqual([...required].sort())
  expect(required.has(originalHash)).toBe(true)
  expect(readdirSync(join(f.files.backupRoot,'objects'))).not.toContain(orphan)
 }finally{f.close()}
},15_000)

it.each(['omitted','extra','duplicate','size','unsafe'])('rejects a manifest that disagrees with its snapshot attachment rows (%s)',fault=>{
 const f=fixture()
 try {
  writeFileSync(join(f.attachments,'asset.bin'),'synthetic asset')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  const backup=f.files.snapshot('test'),path=join(backup,'manifest.json')
  const manifest=JSON.parse(readFileSync(path,'utf8')),original=manifest.attachments[0]
  expect(manifest.attachments).toHaveLength(1)
  if(fault==='omitted')manifest.attachments=[]
  if(fault==='extra')manifest.attachments.push({...original,note:'unrelated-id'})
  if(fault==='duplicate')manifest.attachments.push(original)
  if(fault==='size')manifest.attachments[0]={...original,size:original.size+1}
  if(fault==='unsafe')manifest.attachments[0]={...original,path:'../foreign'}
  writeFileSync(path,JSON.stringify(manifest))
  expect(()=>restoreBrainCheck(backup,join(f.root,'scratch'),path=>new SQLite(path))).toThrow(/attachment|manifest/i)
 }finally{f.close()}
})

it('refuses object collection before deleting any bytes when a retained checkpoint manifest omits an attachment',()=>{
 const f=fixture()
 try {
  writeFileSync(join(f.attachments,'asset.bin'),'synthetic original asset')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  const checkpoint=f.files.snapshot('before-import'),path=join(checkpoint,'manifest.json')
  const originalHash=fileHash(join(f.attachments,'asset.bin'))
  const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.attachments=[];writeFileSync(path,JSON.stringify(manifest))
  writeFileSync(join(f.attachments,'asset.bin'),'synthetic new asset')
  f.store.setWriteDoor(true);f.store.edit('Synthetic',1,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'[asset](files/asset.bin)'},'synthetic-session')
  expect(()=>f.files.scheduled(new Date('2026-01-01T04:00:00Z'))).toThrow(/attachment|manifest/i)
  expect(readFileSync(join(f.files.backupRoot,'objects',originalHash),'utf8')).toBe('synthetic original asset')
 }finally{f.close()}
})

it('leaves the upcoming 03:00 slot due after a pre-03:00 catch-up',()=>{
 const f=fixture()
 try {
  expect(f.files.scheduled(new Date('2026-01-02T01:00:00Z'))).toBeTruthy()
  const marker=()=>JSON.parse(readFileSync(join(f.files.backupRoot,'schedule.json'),'utf8'))
  expect(marker().day).toBe('2026-01-01')
  expect(f.files.scheduled(new Date('2026-01-02T02:59:00Z'))).toBeNull()
  expect(f.files.scheduled(new Date('2026-01-02T03:00:00Z'))).toBeTruthy()
  expect(marker().day).toBe('2026-01-02')
  expect(f.files.scheduled(new Date('2026-01-02T03:01:00Z'))).toBeNull()
  expect(readdirSync(f.files.backupRoot).filter(name=>name.startsWith('nightly-'))).toHaveLength(2)
 }finally{f.close()}
})

it('does not mark a slot successful before retained snapshot validation and retries the same slot after restart',()=>{
 const f=fixture()
 try {
  f.files.scheduled(new Date('2026-01-01T04:00:00Z'))
  const checkpoint=f.files.snapshot('before-import'),path=join(checkpoint,'manifest.json'),original=readFileSync(path,'utf8')
  const broken=JSON.parse(original);broken.databaseHash='0'.repeat(64);writeFileSync(path,JSON.stringify(broken))
  expect(()=>f.files.scheduled(new Date('2026-01-02T04:00:00Z'))).toThrow(/hash mismatch/)
  expect(JSON.parse(readFileSync(join(f.files.backupRoot,'schedule.json'),'utf8')).day).toBe('2026-01-01')
  writeFileSync(path,original)
  const restarted=new BrainFiles(f.store,f.root,f.attachments)
  expect(restarted.scheduled(new Date('2026-01-02T04:01:00Z'))).toBeTruthy()
  expect(JSON.parse(readFileSync(join(f.files.backupRoot,'schedule.json'),'utf8')).day).toBe('2026-01-02')
  expect(readdirSync(f.files.backupRoot).filter(name=>name.startsWith('nightly-'))).toHaveLength(2)
 }finally{f.close()}
})

it.each(['missing','changed'])('refuses a missing or changed current attachment without forgetting captured bytes (%s)',fault=>{
 const f=fixture()
 try {
  const asset=join(f.attachments,'asset.bin');writeFileSync(asset,'original synthetic asset')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  f.files.snapshot('before-import');const before=f.files.dump().attachments
  if(fault==='missing')rmSync(asset);else writeFileSync(asset,'changed synthetic asset')
  expect(()=>f.files.snapshot('test')).toThrow(/attachment.*(?:missing|changed)|(?:missing|changed).*attachment/i)
  expect(f.files.dump().attachments).toEqual(before)
 }finally{f.close()}
})

it.each([
 ['vault:notes/deep/note.md','![asset](../../files/folder/asset.bin)'],
 ['vault:notes/note.md','![[asset.bin]]'],
])('captures nested Markdown links and unique Obsidian basename embeds (%s)',(source,markdown)=>{
 const f=fixture()
 try {
  mkdirSync(join(f.attachments,'folder'));writeFileSync(join(f.attachments,'folder','asset.bin'),'synthetic attachment')
  f.store.importNotes([{...{title:'Synthetic',kind:'fact',origin:'import',scope:'all',status:'active' as const},source,markdown}])
  const snapshot=f.files.snapshot('test'),manifest=JSON.parse(readFileSync(join(snapshot,'manifest.json'),'utf8'))
  expect(manifest.attachments).toHaveLength(1)
  expect(manifest.attachments[0]).toMatchObject({revision:1,path:'folder/asset.bin',state:'captured'})
  expect(restoreBrainCheck(snapshot,join(f.root,'scratch'),path=>new SQLite(path)).attachments).toBe(1)
 }finally{f.close()}
})

it('refuses an ambiguous basename without choosing bytes or silently omitting the embed',()=>{
 const f=fixture()
 try {
  for(const name of ['one','two']){mkdirSync(join(f.attachments,name));writeFileSync(join(f.attachments,name,'asset.bin'),name)}
  expect(()=>f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'![[asset.bin]]',status:'active'}])).toThrow(/ambiguous.*attachment|attachment.*ambiguous/i)
  expect(f.store.list()).toEqual([])
 }finally{f.close()}
})

it('keeps the captured object and reference when a later note revision removes its attachment',()=>{
 const f=fixture()
 try {
  const asset=join(f.attachments,'asset.bin');writeFileSync(asset,'historical synthetic attachment')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  f.files.export();const hash=fileHash(asset),note=f.store.read('Synthetic')
  f.store.setWriteDoor(true);f.store.edit(note.id,1,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'Attachment removed.'},'synthetic-session')
  rmSync(asset);f.files.export()
  const backup=f.files.snapshot('test'),manifest=JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8'))
  expect(manifest.attachments).toEqual([{note:note.id,revision:1,reference:'markdown:files/asset.bin',path:'asset.bin',hash,size:Buffer.byteLength('historical synthetic attachment'),state:'captured'}])
  expect(readFileSync(join(f.files.backupRoot,'objects',hash),'utf8')).toBe('historical synthetic attachment')
  expect(restoreBrainCheck(backup,join(f.root,'scratch'),path=>new SQLite(path)).attachments).toBe(1)
 }finally{f.close()}
})

it.each(['available','unavailable'])('preserves legacy hashes with explicit uncertainty and refuses to invent authored history (%s)',availability=>{
 const f=fixture()
 try{
  const asset=join(f.attachments,'asset.bin');writeFileSync(asset,'legacy synthetic asset')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  const note=f.store.read('Synthetic'),hash=fileHash(asset),size=statSync(asset).size
  f.store.database.exec('DROP TABLE brain_attachment; DROP TABLE brain_attachment_coverage; DROP TABLE brain_import_current; CREATE TABLE brain_attachment(note TEXT NOT NULL REFERENCES brain_note(id),path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(note,path)); DELETE FROM brain_migration WHERE version>=2')
  f.store.database.prepare('INSERT INTO brain_attachment VALUES (?,?,?,?)').run(note.id,asset,hash,size)
  new BrainStore(f.store.database)
  if(availability==='unavailable')writeFileSync(asset,'Present bytes cannot prove historical coverage')
  const rows=f.store.database.prepare('SELECT * FROM brain_attachment').all()
  expect(rows).toEqual([{note:note.id,revision:1,reference:'legacy:legacy:'+asset,path:asset,hash,size,state:'legacy'}])
  expect(()=>f.files.snapshot('test')).toThrow(/coverage is unproven/)
  expect(f.store.database.prepare('SELECT * FROM brain_attachment').all()).toEqual(rows)
  expect(readFileSync(join(f.files.backupRoot,'objects',hash),'utf8')).toBe('legacy synthetic asset')
 }finally{f.close()}
})

it('captures a historical binding before its first export and makes binding and coverage rows append-only',()=>{
 const f=fixture()
 try{
  const asset=join(f.attachments,'asset.bin');writeFileSync(asset,'Original bytes before first export')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  const note=f.store.read('Synthetic'),hash=fileHash(asset);f.store.setWriteDoor(true)
  f.store.edit(note.id,1,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'Attachment removed before first export.'},'synthetic-session')
  writeFileSync(asset,'Replacement bytes')
  const backup=f.files.snapshot('test'),manifest=JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8'))
  expect(manifest.attachments).toEqual([{note:note.id,revision:1,reference:'markdown:files/asset.bin',path:'asset.bin',hash,size:Buffer.byteLength('Original bytes before first export'),state:'captured'}])
  expect(restoreBrainCheck(backup,join(f.root,'scratch'),path=>new SQLite(path)).attachments).toBe(1)
  for(const sql of ["UPDATE brain_attachment SET path='other'","DELETE FROM brain_attachment","UPDATE brain_attachment_coverage SET state='unproven'","DELETE FROM brain_attachment_coverage"])expect(()=>f.store.database.exec(sql)).toThrow(/append-only/)
 }finally{f.close()}
})

it('refuses an attachment symlink outside the approved root without copying the outside canary',()=>{
 const f=fixture()
 try {
  const outside=join(f.root,'outside.bin');writeFileSync(outside,'outside synthetic canary')
  symlinkSync(outside,join(f.attachments,'asset.bin'))
  expect(()=>f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])).toThrow(/attachment.*approved root/)
  expect(f.store.list()).toEqual([])
  expect(readFileSync(outside,'utf8')).toBe('outside synthetic canary')
  expect(f.files.dump().attachments).toEqual([])
 }finally{f.close()}
})

it('keeps one exported workspace path usable through subsequent publications',()=>{
 const f=fixture()
 try {
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'First export.',status:'active'}])
  const workspace=f.files.export(),note=f.store.read('Synthetic');f.store.setWriteDoor(true)
  for(let revision=1;revision<=3;revision++){
   f.store.edit(note.id,revision,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown:'Export '+revision},'synthetic-session')
   const current=f.files.export()
   expect(current).toBe(workspace)
   expect(readFileSync(join(workspace,note.id+'.md'),'utf8')).toBe('Export '+revision)
   expect(f.files.currentExport()).toBe(workspace)
  }
  expect(statSync(workspace).mode&0o222).toBe(0)
  expect(readdirSync(f.files.exportRoot).filter(name=>/^[a-f0-9-]{36}$/.test(name))).toHaveLength(2)
 }finally{f.close()}
})

it('ignores code examples while capturing a reference-style attachment',()=>{
 const f=fixture()
 try {
  writeFileSync(join(f.attachments,'asset.bin'),'real synthetic asset')
  const markdown=['---','example: ![[frontmatter.bin]]','---','```md','![fake](files/never.bin) ![[never.bin]]','```','`![fake](files/inline.bin)`','[real][asset]','','[asset]: files/asset.bin'].join('\n')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown,status:'active'}])
  const backup=f.files.snapshot('test'),manifest=JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8'))
  expect(manifest.attachments).toHaveLength(1)
  expect(manifest.attachments[0]).toMatchObject({path:'asset.bin',state:'captured'})
 }finally{f.close()}
})

it('pins Quick Look attachment targets to the generation actually read while one workspace follows current exports',async()=>{
 const f=fixture();vi.stubEnv('BMN_DATA_HOME',f.root)
 try {
  mkdirSync(join(f.attachments,'nested'));const asset=join(f.attachments,'nested','asset.txt');writeFileSync(asset,'asset revision one')
  const markdown='[asset](../../files/nested/asset.txt) ![[asset.txt]]'
  f.store.importNotes([{source:'vault:notes/deep/note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown,status:'active'}])
  const workspace=f.files.export(),note=f.store.read('Synthetic'),path=join(workspace,note.id+'.md')
  const read=async()=>{
   const result=await readQuickLookFile(path,{root:workspace})
   expect(result.status).toBe('ready')
   return result as Extract<Awaited<ReturnType<typeof readQuickLookFile>>,{status:'ready'}>&{linkTargets?:Record<string,string>}
  }
  const first=await read(),firstTarget=first.linkTargets?.['markdown:../../files/nested/asset.txt']
  expect(first.content).toBe(markdown);expect(firstTarget).toBeTruthy()
  expect(first.linkTargets?.['wiki:asset.txt']).toBe(firstTarget)
  expect(readFileSync(firstTarget!,'utf8')).toBe('asset revision one')
  f.store.setWriteDoor(true)
  for(let revision=1;revision<=2;revision++){
   writeFileSync(asset,'asset revision '+(revision+1))
   f.store.edit(note.id,revision,{title:'Synthetic',kind:'fact',origin:'agent',scope:'all',markdown},'synthetic-session')
   expect(f.files.export()).toBe(workspace)
   const next=await read(),target=next.linkTargets?.['markdown:../../files/nested/asset.txt']
   expect(target).toBeTruthy();expect(target).not.toBe(firstTarget)
   expect(readFileSync(target!,'utf8')).toBe('asset revision '+(revision+1))
   expect(next.content).toBe(markdown)
   if(revision===1)expect(readFileSync(firstTarget!,'utf8')).toBe('asset revision one')
  }
 }finally{vi.unstubAllEnvs();f.close()}
})

it.each(['checksum','escape','symlink'])('holds attachment navigation when generation metadata is invalid (%s)',async fault=>{
 const f=fixture();vi.stubEnv('BMN_DATA_HOME',f.root)
 try {
  writeFileSync(join(f.attachments,'asset.txt'),'captured synthetic asset')
  f.store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.txt)',status:'active'}])
  const workspace=f.files.export(),note=f.store.read('Synthetic'),path=join(workspace,note.id+'.md'),folder=realpathSync(workspace)
  const mapPath=join(folder,'.links',note.id+'.json'),map=JSON.parse(readFileSync(mapPath,'utf8'))
  const outside=join(f.root,'outside.txt');writeFileSync(outside,'outside synthetic canary')
  if(fault==='symlink'){
   chmodSync(join(folder,'assets'),0o700)
   const asset=join(folder,map.targets['markdown:files/asset.txt']);rmSync(asset);symlinkSync(outside,asset)
   chmodSync(join(folder,'assets'),0o555)
  }else{
   if(fault==='checksum')map.checksum='0'.repeat(64)
   else map.targets['markdown:files/asset.txt']='../../outside.txt'
   chmodSync(mapPath,0o600);writeFileSync(mapPath,JSON.stringify(map));chmodSync(mapPath,0o444)
  }
  const read=await readQuickLookFile(path,{root:workspace})
  expect(read.status).toBe('ready')
  if(read.status==='ready'){expect(read.content).toBe(note.markdown);expect(read.linkTargets).toEqual({})}
  expect(readFileSync(outside,'utf8')).toBe('outside synthetic canary')
 }finally{vi.unstubAllEnvs();f.close()}
})

it('keeps an object rooted solely in a retained pre-import checkpoint',()=>{
 const f=fixture()
 try{
  const asset=join(f.attachments,'checkpoint.bin');writeFileSync(asset,'Checkpoint-only original bytes')
  f.store.importNotes([{source:'vault:checkpoint.md',title:'Checkpoint',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/checkpoint.bin)',status:'active'}])
  const checkpoint=f.files.snapshot('before-import'),hash=fileHash(asset)
  const empty=new BrainStore(new SQLite(':memory:')),live=new BrainFiles(empty,f.root,f.attachments)
  try{
  const orphan='e'.repeat(64);writeFileSync(join(f.files.backupRoot,'objects',orphan),'Unreferenced synthetic bytes')
  live.scheduled(new Date('2026-01-05T04:00:00Z'))
  expect((live.dump().attachments as {hash:string|null}[]).some(row=>row.hash===hash)).toBe(false)
  expect(readFileSync(join(f.files.backupRoot,'objects',hash),'utf8')).toBe('Checkpoint-only original bytes')
  expect(readdirSync(join(f.files.backupRoot,'objects'))).not.toContain(orphan)
  expect(restoreBrainCheck(checkpoint,join(f.root,'checkpoint-restored'),path=>new SQLite(path))).toMatchObject({ok:true,notes:1,versions:1,attachments:1})
  }finally{empty.database.close()}
 }finally{f.close()}
})

it('holds GC when a published checkpoint loses its entire manifest and owns the only object reference',()=>{
 const f=fixture()
 try{
  const asset=join(f.attachments,'only.bin');writeFileSync(asset,'Only retained checkpoint bytes')
  f.store.importNotes([{source:'vault:only.md',title:'Only',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/only.bin)',status:'active'}])
  const checkpoint=f.files.snapshot('before-import'),hash=fileHash(asset)
  const empty=new BrainStore(new SQLite(':memory:')),live=new BrainFiles(empty,f.root,f.attachments)
  try{
  rmSync(join(checkpoint,'manifest.json'))
  expect(()=>live.scheduled(new Date('2026-01-05T04:00:00Z'))).toThrow(/manifest/)
  expect(readFileSync(join(f.files.backupRoot,'objects',hash),'utf8')).toBe('Only retained checkpoint bytes')
  expect(readFileSync(join(checkpoint,'brain.sqlite3')).length).toBeGreaterThan(0)
  expect(readdirSync(f.files.backupRoot)).not.toContain('schedule.json')
  }finally{empty.database.close()}
 }finally{f.close()}
})

it('replaces the complete current import set, preserves tombstones and ordinary notes, and verifies actual export files',()=>{
 const f=fixture(),base={kind:'fact',origin:'import',scope:'all',status:'active' as const},row=(source:string,markdown:string)=>({...base,source,title:source,markdown})
 try{
  f.store.importNotes([row('vault:a.md','A old'),row('vault:b.md','B kept tombstone'),row('vault:omitted.md','Omitted history')])
  f.store.setWriteDoor(true);const tombstone=f.store.withdraw('vault:b.md',1,'synthetic'),ordinary=f.store.create({title:'Ordinary',kind:'fact',origin:'agent',scope:'all',markdown:'Ordinary preserved'},'synthetic')
  f.store.setWriteDoor(false);const before=f.files.snapshot('before-import'),selected=[row('vault:a.md','A changed'),row('vault:b.md','B kept tombstone'),row('vault:c.md','C added')]
  f.store.importNotes(selected);const current=f.files.export()
  expect(verifyBrainImportExport(current,f.root,selected).sources.map(row=>row.source)).toEqual(selected.map(row=>row.source))
  expect(f.store.read(tombstone.id)).toMatchObject({status:'withdrawn',revision:2});expect(f.store.read(ordinary.id).markdown).toBe('Ordinary preserved')
  expect(f.store.read('vault:omitted.md').status).toBe('archived');expect(readdirSync(current)).not.toContain(f.store.read('vault:omitted.md').id+'.md')
  expect(restoreBrainCheck(before,join(f.root,'before-restored'),path=>new SQLite(path)).notes).toBe(4)
  const projection=JSON.stringify(f.files.dump())
  expect(()=>f.store.importNotes([row('vault:b.md','Changed tombstone')])).toThrow(/changed after withdrawal/)
  expect(JSON.stringify(f.files.dump())).toBe(projection)
  chmodSync(current,0o755);writeFileSync(join(current,'stale.md'),'Unselected stale file',{mode:0o444});chmodSync(current,0o555)
  expect(()=>verifyBrainImportExport(current,f.root,selected)).toThrow(/stale|missing/)
 }finally{f.close()}
})

it.each([1,2] as const)('rejects a schema-3 snapshot that declares manifest version %s',version=>{
 const f=fixture()
 try {
  f.store.importNotes([{source:'vault:sample.md',title:'Sample',kind:'fact',origin:'import',scope:'all',markdown:'A plain note',status:'active'}])
  const backup=f.files.snapshot('test'),path=join(backup,'manifest.json'),databasePath=join(backup,'brain.sqlite3')
  const identicalDatabase=fileHash(databasePath)
  const manifest=JSON.parse(readFileSync(path,'utf8'))
  writeFileSync(path,JSON.stringify({...manifest,version}))
  const scratch=join(f.root,'scratch')
  expect(()=>restoreBrainCheck(backup,scratch,database=>new SQLite(database))).toThrow(/format.*version/i)
  expect(readdirSync(f.root)).not.toContain('scratch')
  expect(fileHash(databasePath)).toBe(identicalDatabase)
 } finally {f.close()}
})

it.each([1,2] as const)('checks real legacy snapshot format %s and refuses uncertain historical attachments',version=>{
 const f=fixture()
 try{
  const draft={source:'vault:sample.md',title:'Sample',kind:'fact',origin:'import',scope:'all',markdown:'No attachment references',status:'active' as const}
  const asset=join(f.attachments,'synthetic.bin')
  writeFileSync(asset,'historical attachment')
  const legacy=version===1?'note TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(note,path)':
    'note TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,hash TEXT,size INTEGER,state TEXT NOT NULL,PRIMARY KEY(note,revision,path)'
  const backup=join(f.files.backupRoot,'test-legacy')
  const check=join(f.root,'scratch')
  const capture=(folder:string)=>{
   mkdirSync(folder,{recursive:true})
   const database=join(folder,'brain.sqlite3')
   f.store.database.prepare('VACUUM INTO ?').run(database)
   const manifest={version,createdAt:'2026-01-01T03:00:00Z',databaseHash:fileHash(database),
    projectionHash:createHash('sha256').update(JSON.stringify(f.files.dump())).digest('hex'),attachments:[]}
   writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest))
  }
  f.store.importNotes([draft])
  f.store.database.exec('DROP TABLE brain_attachment; DROP TABLE brain_attachment_coverage; DROP TABLE brain_import_current; CREATE TABLE brain_attachment('+legacy+')')
  f.store.database.prepare('DELETE FROM brain_migration WHERE version>?').run(version)
  capture(backup)
  expect(restoreBrainCheck(backup,check,path=>new SQLite(path))).toMatchObject({ok:true,notes:1,versions:1,attachments:0})
  const markdown='[historic](files/synthetic.bin)'
  f.store.database.exec('DROP TRIGGER brain_history_no_update')
  f.store.database.prepare('UPDATE brain_version SET markdown=?,checksum=?').run(markdown,createHash('sha256').update(markdown).digest('hex'))
  const uncertain=join(f.files.backupRoot,'uncertain-legacy')
  capture(uncertain)
  const previous=fileHash(join(uncertain,'brain.sqlite3'))
  expect(()=>restoreBrainCheck(uncertain,join(f.root,'refused'),path=>new SQLite(path))).toThrow(/coverage is unproven/)
  expect(readdirSync(f.root)).not.toContain('refused')
  expect(fileHash(join(uncertain,'brain.sqlite3'))).toBe(previous)
 }finally{f.close()}
})

it('keeps valid note and attachment links in Quick Look when another note leaves the export',async()=>{
 const f=fixture();vi.stubEnv('BMN_DATA_HOME',f.root)
 const row=(source:string,title:string,markdown:string)=>({source,title,markdown,kind:'fact',origin:'import',scope:'all',status:'active' as const})
 try {
  const asset=join(f.attachments,'shared.bin')
  writeFileSync(asset,'captured bytes')
  const main=row('vault:sample.md','Sample','[[Retained]] [[Omitted]] ![[shared.bin]]')
  const retained=row('vault:retained.md','Retained','Retained bytes')
  f.store.importNotes([main,retained,row('vault:omitted.md','Omitted','Omitted bytes'),row('vault:shared.md','shared.bin','Note with the same label')])
  const sampleId=f.store.read('Sample').id,retainedId=f.store.read('Retained').id,omittedId=f.store.read('Omitted').id
  f.store.importNotes([main,retained,row('vault:shared.md','shared.bin','Note with the same label')])
  const folder=f.files.export()
  const result=await readQuickLookFile(join(folder,sampleId+'.md'),{root:folder})
  expect(result.status).toBe('ready')
  if(result.status!=='ready')throw new Error('Quick Look did not open the exported note')
  const targets='linkTargets' in result?result.linkTargets:undefined
  expect(result.content).toBe(main.markdown)
  expect(targets?.['wiki:Omitted']).toBeUndefined()
  expect(targets?.['wiki:Retained']).toBe(join(realpathSync(folder),retainedId+'.md'))
  expect(readFileSync(targets?.['wiki:shared.bin']??asset+'.missing','utf8')).toBe('captured bytes')
  const history=JSON.parse(readFileSync(join(folder,'history.json'),'utf8'))
  expect(history.versions).toContainEqual(expect.objectContaining({note:omittedId,markdown:'Omitted bytes'}))
 } finally {vi.unstubAllEnvs();f.close()}
})

it('migrates proven empty attachment coverage from stored Markdown without reading present files',()=>{
 const f=fixture()
 try{
  f.store.importNotes([{source:'vault:plain.md',title:'Plain',kind:'fact',origin:'import',scope:'all',markdown:'Plain historical bytes. `![literal](files/not-an-asset)`',status:'active'}])
  f.store.database.exec('DROP TABLE brain_attachment; DROP TABLE brain_attachment_coverage; DROP TABLE brain_import_current; CREATE TABLE brain_attachment(note TEXT,revision INTEGER,path TEXT,hash TEXT,size INTEGER,state TEXT,PRIMARY KEY(note,revision,path)); DELETE FROM brain_migration WHERE version=3')
  new BrainStore(f.store.database)
  expect(f.store.database.prepare('SELECT state FROM brain_attachment_coverage').all()).toEqual([{state:'complete'}])
  expect(restoreBrainCheck(f.files.snapshot('test'),join(f.root,'plain-restored'),path=>new SQLite(path))).toMatchObject({ok:true,notes:1,versions:1,attachments:0})
 }finally{f.close()}
})
it.each(['missing-db','wrong-type','symlink-db','symlink-manifest','unknown-entry','hidden-weekly-stage'])('holds unsafe completed inventory and accepts a recognized hidden partial stage (%s)',fault=>{
 const f=fixture()
 try{
  f.store.importNotes([{source:'vault:plain.md',title:'Plain',kind:'fact',origin:'import',scope:'all',markdown:'Plain bytes',status:'active'}])
  const checkpoint=f.files.snapshot('before-import')
  if(fault==='missing-db')rmSync(join(checkpoint,'brain.sqlite3'))
  if(fault==='wrong-type'){rmSync(join(checkpoint,'brain.sqlite3'));mkdirSync(join(checkpoint,'brain.sqlite3'))}
  if(fault==='symlink-db'||fault==='symlink-manifest'){const name=fault==='symlink-db'?'brain.sqlite3':'manifest.json',outside=join(f.root,'outside-'+name);writeFileSync(outside,readFileSync(join(checkpoint,name)));rmSync(join(checkpoint,name));symlinkSync(outside,join(checkpoint,name))}
  if(fault==='unknown-entry')writeFileSync(join(f.files.backupRoot,'unrecognized-checkpoint'),'Unknown bytes')
  if(fault==='hidden-weekly-stage'){const stage=join(f.files.backupRoot,'.weekly-2026-01-05.11111111-1111-4111-8111-111111111111.tmp');mkdirSync(stage);writeFileSync(join(stage,'brain.sqlite3'),'Incomplete DB');expect(f.files.scheduled(new Date('2026-01-05T04:00:00Z'))).toBeTruthy()}
  else{expect(()=>f.files.scheduled(new Date('2026-01-05T04:00:00Z'))).toThrow();expect(readdirSync(f.files.backupRoot)).not.toContain('schedule.json')}
 }finally{f.close()}
})

it('holds scheduled deletion when a published checkpoint contains an unexpected entry',()=>{
 const f=fixture()
 try{
  const checkpoint=f.files.snapshot('before-import')
  expect(readdirSync(checkpoint).sort()).toEqual(['brain.sqlite3','manifest.json'])
  const foreign=join(checkpoint,'foreign-canary.txt');writeFileSync(foreign,'independent synthetic file')
  const orphan='f'.repeat(64),object=join(f.files.backupRoot,'objects',orphan);writeFileSync(object,'orphan synthetic bytes')
  expect(()=>f.files.scheduled(new Date('2026-01-01T04:00:00Z'))).toThrow(/snapshot.*entries|unexpected/i)
  expect(readFileSync(foreign,'utf8')).toBe('independent synthetic file')
  expect(readFileSync(object,'utf8')).toBe('orphan synthetic bytes')
 }finally{f.close()}
})
