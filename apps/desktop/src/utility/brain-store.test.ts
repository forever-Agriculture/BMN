// MODULE: brain-store.test.ts - Real SQLite history, write-door, identity and search contracts
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore, type BrainContent } from './brain-store'
import {brainProjection} from './brain-snapshot'
const require = createRequire(import.meta.url)
const SQLite = require('better-sqlite3') as new (path: string) => DatabaseConnection
const content = (title='Synthetic preference'): BrainContent => ({title,kind:'preference',origin:'agent',scope:'all',markdown:'# Choice\nUse on demand.\n## Reason\nA synthetic reason.\n# Other\nOther text.'})
function fixture(open=true) { const db=new SQLite(':memory:'); const store=new BrainStore(db);store.setWriteDoor(open);return {store,db} }

describe('independent brain store',()=>{
  it('starts with a closed write door, separate from session schema',()=>{
    const {store,db}=fixture(false)
    expect(()=>store.create(content(),'session-a')).toThrow(/read-only/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('session','process_incarnation','schema_migration')").all()).toEqual([])
    expect(()=>store.delete()).toThrow(/Epic 128/)
    db.close()
  })
  it('requires the read revision, appends versions, and preserves withdrawn history',()=>{
    const {store,db}=fixture();const n=store.create(content(),'session-a')
    const edit=store.edit(n.id,n.revision,{...content(),markdown:'Changed'},'session-b')
    expect(edit.revision).toBe(2)
    expect(()=>store.edit(n.id,1,content(),'session-c')).toThrow(/revision is 2; read again/)
    const withdrawn=store.withdraw(n.id,2,'session-a')
    expect(store.search('Changed')).toEqual([])
    expect(store.read(n.id).status).toBe('withdrawn')
    expect(store.restore(n.id,withdrawn.revision,'session-a').revision).toBe(4)
    expect(store.history(n.id).map(x=>x.markdown)).toEqual([content().markdown,'Changed','Changed','Changed'])
    expect(()=>db.prepare('UPDATE brain_version SET markdown=? WHERE note=?').run('lost',n.id)).toThrow(/append-only/)
    expect(()=>db.prepare('DELETE FROM brain_version WHERE note=?').run(n.id)).toThrow(/append-only/)
    db.close()
  })
  it('enforces creation count and normalized title inside the transaction; origin cannot spoof an import',()=>{
    const {store,db}=fixture()
    const first=store.create({...content('  SyntheTIC  '),origin:'import'},'session-a')
    expect(()=>store.create(content('synthetic'),'session-b')).toThrow(/edit note/)
    store.create(content('two'),'session-a');store.create(content('three'),'session-a')
    expect(()=>store.create(content('four'),'session-a')).toThrow(/3 brain notes/)
    expect(store.edit(first.id,1,content('  SyntheTIC  '),'session-a').revision).toBe(2)
    expect(()=>store.create({...content(),scope:'project:synthetic'},'session-b')).toThrow(/project’s plan/)
    expect(store.create({...content('group'),scope:'group:one,two'},'session-b').scope).toBe('group:one,two')
    db.close()
  })
  it('resolves unique links and leaves duplicate imported titles ambiguous',()=>{
    const {store,db}=fixture(false)
    store.importNotes([
      {...content('same'),source:'one.md',status:'active'},
      {...content('same'),source:'two.md',status:'archived'},
      {...content('unique'),source:'three.md',status:'active'},
      {...content('links'),markdown:'[[same]] [[unique]] [[missing]]',source:'four.md',status:'active'}
    ])
    expect(()=>store.read('same')).toThrow(/Several imported/)
    const links=store.read('links',{links:true}).links!
    expect(links.find(x=>x.target==='same')?.resolved).toBeNull()
    expect(links.find(x=>x.target==='unique')?.resolved).toBe(store.read('unique').id)
    expect(links.find(x=>x.target==='missing')?.resolved).toBeNull()
    expect(store.read('unique',{links:true}).backlinks).toHaveLength(1)
    expect(store.search('same').filter(n=>n.title==='same')).toHaveLength(1)
    expect(store.search('same',true).filter(n=>n.title==='same')).toHaveLength(2)
    db.close()
  })
  it('returns one section with its children and limits search to ten',()=>{
    const {store,db}=fixture(); const n=store.create(content(),'session-a')
    expect(store.read(n.id,{section:'Choice'}).markdown).toBe('# Choice\nUse on demand.\n## Reason\nA synthetic reason.')
    expect(()=>store.read(n.id,{section:'Absent'})).toThrow(/section not found/)
    expect(store.search('demand')).toHaveLength(1)
    expect(store.search('" OR *')).toEqual([])
    db.close()
  })
  it('serializes competing writers on the same file without overwriting a winner',()=>{
    const dir=mkdtempSync(join(tmpdir(),'bmn-brain-'));const path=join(dir,'brain.sqlite3')
    const a=new BrainStore(new SQLite(path));a.setWriteDoor(true)
    const b=new BrainStore(new SQLite(path));const n=a.create(content(),'session-a')
    const readByB=b.read(n.id)
    a.edit(n.id,1,{...content(),markdown:'Winner'},'session-a')
    expect(()=>b.edit(n.id,readByB.revision,{...content(),markdown:'Loser'},'session-b')).toThrow(/read again/)
    expect(b.read(n.id).markdown).toBe('Winner')
    a.database.close();b.database.close();rmSync(dir,{recursive:true})
  })
})


it('reads real sections without interpreting fenced examples as headings',()=>{
 const {store,db}=fixture()
 try {
  for(const [index,fence] of ['```','~~~~'].entries()) {
   const markdown=[fence+'md','# Choice','fake',fence,'# Choice','real',fence+'md','# Example','example',fence,'## Child','child','# End','end'].join('\n')
   const note=store.create({...content('Fenced '+index),markdown},'synthetic-fences')
   expect(store.read(note.id,{section:'Choice'}).markdown).toBe(['# Choice','real',fence+'md','# Example','example',fence,'## Child','child'].join('\n'))
   expect(()=>store.read(note.id,{section:'Example'})).toThrow(/section not found/)
  }
 }finally{db.close()}
})

it('archives sources omitted from a replacement import without losing versions or tombstones',()=>{
 const {store,db}=fixture(false)
 const a={...content('Kept'),source:'vault:kept.md',status:'active' as const}
 const b={...content('Removed'),source:'vault:removed.md',status:'active' as const,markdown:'uniqueremovedterm'}
 try {
  store.importNotes([a,b]);const removed=store.read('Removed')
  store.importNotes([a]);expect(store.search('uniqueremovedterm')).toEqual([])
  expect(store.read(removed.id).status).toBe('archived')
  expect(store.history(removed.id)).toHaveLength(2)
  store.importNotes([a]);expect(store.history(removed.id)).toHaveLength(2)
  store.importNotes([a,b]);expect(store.read(removed.id)).toMatchObject({id:removed.id,status:'active',revision:3})
  store.setWriteDoor(true);store.withdraw(removed.id,3,'synthetic-session');store.setWriteDoor(false)
  store.importNotes([a]);store.importNotes([a,b]);expect(store.read(removed.id).status).toBe('withdrawn')
 }finally{db.close()}
})


it('deduplicates normalized aliases by note identity and retains real ambiguity',()=>{
 const {store,db}=fixture(false)
 try {
  const target={...content('Choices/ALPHA'),source:'vault:choices/alpha.md',status:'active' as const}
  const links={...content('Links'),source:'vault:links.md',status:'active' as const,markdown:'[[choices/alpha.md]] [[alpha]]'}
  store.importNotes([target,links])
  const id=store.read('Choices/ALPHA').id
  expect(store.read('Links',{links:true}).links?.map(link=>link.resolved)).toEqual([id,id])
  store.importNotes([target,links,{...content('Other'),source:'vault:other.md',status:'active' as const,markdown:'[[alpha]]'}])
  expect(store.read('Other',{links:true}).links?.[0]?.resolved).toBe(id)
  store.importNotes([target,links,{...content('ALPHA'),source:'vault:second.md',status:'active' as const}])
  const result=store.read('Links',{links:true}).links!
  expect(result.find(link=>link.target==='alpha')?.resolved).toBeNull()
  expect(result.find(link=>link.target==='choices/alpha.md')?.resolved).toBe(id)
 }finally{db.close()}
})

it('refuses a future brain schema without changing its saved rows',()=>{
 const {store,db}=fixture()
 try {
  const note=store.create(content(),'synthetic-session')
  db.prepare('INSERT INTO brain_migration VALUES (?,?)').run(4,'2099-01-01T00:00:00Z')
  expect(()=>new BrainStore(db)).toThrow(/newer than this build/)
  expect(store.read(note.id)).toEqual(note)
  expect(db.prepare('SELECT version FROM brain_migration ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4}])
 }finally{db.close()}
})

it('rolls back every earlier statement when a later note in an import batch fails',()=>{
 const {store,db}=fixture(false)
 const existing={...content('Existing'),source:'vault:existing.md',status:'active' as const,markdown:'Original [[Existing target]]'}
 try{
  store.importNotes([existing]);const before=brainProjection(store),search=store.search('Original')
  db.exec("CREATE TRIGGER synthetic_import_fault BEFORE INSERT ON brain_note WHEN NEW.import_source='vault:reject.md' BEGIN SELECT RAISE(ABORT,'synthetic later import failure'); END")
  expect(()=>store.importNotes([{...existing,markdown:'Changed [[New target]]'},{...content('Reject later'),source:'vault:reject.md',status:'active'}])).toThrow(/synthetic later import failure/)
  expect(brainProjection(store)).toEqual(before);expect(store.search('Original')).toEqual(search);expect(store.search('Changed')).toEqual([])
  expect(store.history('Existing')).toHaveLength(1);expect(()=>store.read('Reject later')).toThrow(/not found/)
 }finally{db.close()}
})
