// MODULE: brain-import.test.ts - Verbatim import, archive selection, unchanged sources and re-import identity
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,it,expect } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore } from './brain-store'
import { prepareVaultImport,verifyVaultImport } from './brain-import'
const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
describe('triaged vault import',()=>{
 it('keeps active text verbatim, archives hubs/daily/templates and changes no source bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'bmn-brain-import-'))
  const store=new BrainStore(new SQLite(':memory:'))
  try {
   for(const folder of ['notes','projects','daily','templates','files'])mkdirSync(join(root,folder))
   writeFileSync(join(root,'notes','keeper.md'),'# Exact\nA **synthetic** keeper.\n')
   for(const folder of ['projects','daily','templates'])writeFileSync(join(root,folder,'archive.md'),'# Archived '+folder+'\n')
   writeFileSync(join(root,'notes','dropped.md'),'A synthetic status note')
   writeFileSync(join(root,'files','synthetic.bin'),Buffer.from([0,1,2,255]))
   const labels=[{source:join(root,'notes','keeper.md'),source_kind:'vault' as const,label:'brain' as const}]
   const batch=prepareVaultImport(root,labels,[{name:'Synthetic project',repository:'/synthetic/project',summary:'A synthetic project',board:'/synthetic/project/plan/status.yaml',rules:'/synthetic/project/AGENTS.md',archive:join(root,'projects','archive.md')}])
   expect(batch.active).toBe(2);expect(batch.archived).toBe(3)
   store.importNotes(batch.notes)
   expect(store.read('keeper').markdown).toBe(readFileSync(join(root,'notes','keeper.md'),'utf8'))
   expect(store.read('Project map').markdown).toContain('/synthetic/project/plan/status.yaml')
   expect(store.read('Project map',{links:true}).links).toContainEqual({kind:'project',target:'/synthetic/project/plan/status.yaml',resolved:null})
   expect(store.search('Archived').filter(n=>n.title==='archive')).toEqual([]);expect(store.search('Archived',true).filter(n=>n.title==='archive')).toHaveLength(3)
   const before=store.read('keeper')
   expect(store.importNotes(batch.notes).imported).toBe(0);expect(store.read('keeper').id).toBe(before.id);expect(store.read('keeper').revision).toBe(1)
   verifyVaultImport(root,batch.manifest)
   writeFileSync(join(root,'notes','keeper.md'),'A changed source')
   expect(()=>verifyVaultImport(root,batch.manifest)).toThrow(/hash proof/)
  }finally{store.database.close();rmSync(root,{recursive:true,force:true})}
 })
 it('preserves withdrawal tombstones, and atomically refuses a changed withdrawn source',()=>{
  const store=new BrainStore(new SQLite(':memory:'))
  const note={source:'vault:one.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'Original',status:'active' as const,source_time:'2026-11-17T00:00:00Z'}
  try {
   store.importNotes([note]);store.setWriteDoor(true);const n=store.read('Synthetic');store.withdraw(n.id,1,'synthetic-session');store.setWriteDoor(false)
   expect(store.importNotes([note]).withdrawn).toBe(1);expect(store.read(n.id).status).toBe('withdrawn')
   expect(()=>store.importNotes([{...note,markdown:'Changed after withdrawal'}])).toThrow(/source changed after withdrawal/)
   expect(store.history(n.id)).toHaveLength(2);expect(store.read(n.id).markdown).toBe('Original')
  }finally{store.database.close()}
 })
})

it('includes nested ARCHIVE.md notes in the unchanged-source proof',()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-manifest-'))
 try {
  mkdirSync(join(root,'notes'));writeFileSync(join(root,'notes','ARCHIVE.md'),'Original nested note')
  const batch=prepareVaultImport(root,[],[])
  writeFileSync(join(root,'notes','ARCHIVE.md'),'Changed nested note')
  expect(()=>verifyVaultImport(root,batch.manifest)).toThrow(/hash proof/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
