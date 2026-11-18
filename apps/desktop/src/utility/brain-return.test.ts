// MODULE: brain-return.test.ts - Post-switch notes rebuilt from recorded revisions and published once as new Markdown
import {createRequire} from 'node:module'
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import type {DatabaseConnection} from './database-initialization'
import {BrainStore} from './brain-store'
import {BrainFiles} from './brain-files'
import {brainAtomicRename} from './brain-cutover-files'
import {brainReturnFolderName,brainReturnSlug,publishBrainReturn,stageBrainReturn,type BrainReturnProjection} from './brain-return'
const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
const atomic=brainAtomicRename(join(import.meta.dirname,'../../bin'))
const rename=(source:string,target:string):void=>{const stat=lstatSync(source);atomic({operation:'no-replace',source,target,sourceIdentity:{dev:stat.dev,ino:stat.ino},targetIdentity:null})}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-return-')),vault=join(root,'vault'),attachments=join(vault,'files');mkdirSync(attachments,{recursive:true})
 const store=new BrainStore(new SQLite(join(root,'brain.sqlite3')));const files=new BrainFiles(store,root,attachments)
 // The frozen input the worker returns after closing its door: checksummed snapshot first, then its projection.
 const capture=()=>{files.snapshot('return',new Date(),undefined,false);return {projection:files.dump() as unknown as BrainReturnProjection,objects:join(files.backupRoot,'objects')}}
 return {root,vault,attachments,store,files,capture,close(){store.database.close();for(const entry of readdirSync(root,{recursive:true,withFileTypes:true}))if(entry.isDirectory())chmodSync(join(entry.parentPath,entry.name),0o700);rmSync(root,{recursive:true,force:true})}}
}
it('returns the captured attachment bytes after the live file was replaced, with the note linking to them',()=>{
 const f=fixture()
 try{
  f.store.importNotes([{source:'notes/old.md',title:'Old',kind:'fact',origin:'import',scope:'all',markdown:'Unchanged.',status:'active'}])
  f.store.setWriteDoor(true)
  const heads=Object.fromEntries(f.store.list().map(note=>[note.id,note.revision]))
  writeFileSync(join(f.attachments,'diagram.txt'),'synthetic attachment bytes')
  const note=f.store.create({title:'Діаграма / plan',kind:'fact',origin:'synthetic',scope:'all',markdown:'See [diagram](files/diagram.txt) and ![[files/diagram.txt]].\n'},'synthetic-session')
  // Replaced before the return is asked for: an export would now refuse, the frozen capture must not.
  writeFileSync(join(f.attachments,'diagram.txt'),'replaced later')
  expect(()=>f.files.export()).toThrow(/changed without a new note revision/)
  f.store.setWriteDoor(false)
  const {projection,objects}=f.capture(),cutoverId='0b5e4c2e-1111-4222-8333-444455556666'
  const stage=join(f.root,'stage'),manifest=stageBrainReturn({projection,objects,heads,cutoverId,stage})
  expect(manifest.notes.map(n=>n.id)).toEqual([note.id])
  const asset=Object.keys(manifest.files).find(name=>name.startsWith('assets/'))!
  expect(readFileSync(join(stage,asset),'utf8')).toBe('synthetic attachment bytes')
  const target=publishBrainReturn(stage,f.vault,manifest,rename)
  const body=readFileSync(join(target,manifest.notes[0]!.file),'utf8')
  expect(body).toContain('See [diagram]('+asset+') and ![[inbox/'+brainReturnFolderName(cutoverId)+'/'+asset+']].')
  expect(body).toContain('attachments: {"diagram.txt":"'+asset+'"}')
  expect(readFileSync(join(target,asset),'utf8')).toBe('synthetic attachment bytes')
  expect(readFileSync(join(f.attachments,'diagram.txt'),'utf8')).toBe('replaced later')
  expect(readFileSync(join(target,'README.md'),'utf8')).toContain('[['+manifest.notes[0]!.file.slice(0,-3)+']]')
  expect(publishBrainReturn(stage,f.vault,manifest,rename)).toBe(target)
 }finally{f.close()}
})
it('rewrites reference-style attachment links but leaves code examples alone',()=>{
 const f=fixture()
 try{
  f.store.setWriteDoor(true)
  writeFileSync(join(f.attachments,'pic.txt'),'picture bytes')
  f.store.create({title:'Links',kind:'fact',origin:'synthetic',scope:'all',markdown:'See [pic][p].\n\n[p]: files/pic.txt\n\nExample: `[x](files/pic.txt)`\n'},'synthetic-session')
  f.store.setWriteDoor(false)
  const {projection,objects}=f.capture(),stage=join(f.root,'stage'),manifest=stageBrainReturn({projection,objects,heads:{},cutoverId:'links',stage})
  const asset=Object.keys(manifest.files).find(name=>name.startsWith('assets/'))!
  const body=readFileSync(join(stage,manifest.notes[0]!.file),'utf8')
  expect(body).toContain('[p]: '+asset+'\n');expect(body).toContain('Example: `[x](files/pic.txt)`')
 }finally{f.close()}
})
it('returns an edit to an archived import that a later import omitted',()=>{
 const f=fixture()
 try{
  const row=(source:string,title:string)=>({source,title,kind:'fact',origin:'import',scope:'all',markdown:title+' text.',status:'active' as const})
  f.store.importNotes([row('notes/kept.md','Kept'),row('notes/gone.md','Gone')])
  f.store.importNotes([row('notes/kept.md','Kept')])
  f.store.setWriteDoor(true)
  const heads=Object.fromEntries(f.store.list().map(note=>[note.id,note.revision]))
  const gone=f.store.list().find(note=>note.import_source==='notes/gone.md')!
  expect(f.store.currentNotes().some(note=>note.id===gone.id)).toBe(false)
  f.store.edit(gone.id,gone.revision,{title:'Gone',kind:'fact',origin:'import',scope:'all',markdown:'Edited after it left the import.\n'},'synthetic-session')
  f.store.setWriteDoor(false)
  const {projection,objects}=f.capture(),stage=join(f.root,'stage')
  const manifest=stageBrainReturn({projection,objects,heads,cutoverId:'archived',stage})
  expect(manifest.notes.map(n=>[n.id,n.importSource])).toEqual([[gone.id,'notes/gone.md']])
  expect(readFileSync(join(stage,manifest.notes[0]!.file),'utf8')).toMatch(/edits_vault_note: "notes\/gone.md"[\s\S]*Edited after it left the import.\n$/)
 }finally{f.close()}
})
it('reuses a stage only for its own switch and adopts only a target that matches its manifest exactly',()=>{
 const f=fixture()
 try{
  f.store.setWriteDoor(true)
  f.store.create({title:'After',kind:'fact',origin:'synthetic',scope:'all',markdown:'After.\n'},'synthetic-session')
  f.store.setWriteDoor(false)
  const {projection,objects}=f.capture(),stage=join(f.root,'stage')
  const manifest=stageBrainReturn({projection,objects,heads:{},cutoverId:'first',stage})
  expect(()=>stageBrainReturn({projection,objects,heads:{},cutoverId:'second',stage})).toThrow(/another switch/)
  // A target that appears between the copy and the rename is never replaced, and the copy is cleaned up.
  const target=join(f.vault,'inbox',brainReturnFolderName('first'))
  expect(()=>publishBrainReturn(stage,f.vault,manifest,(source,destination)=>{mkdirSync(destination);writeFileSync(join(destination,'foreign.md'),'Foreign.\n');rename(source,destination)})).toThrow(/differs from its manifest/)
  expect(readdirSync(target)).toEqual(['foreign.md'])
  expect(readdirSync(join(f.vault,'inbox'))).toEqual([brainReturnFolderName('first')])
  rmSync(target,{recursive:true})
  // An interrupted copy leaves nothing; two retries publish once.
  expect(()=>publishBrainReturn(stage,f.vault,manifest,()=>{throw new Error('synthetic interruption')})).toThrow(/synthetic interruption/)
  expect(readdirSync(join(f.vault,'inbox'))).toEqual([])
  expect(publishBrainReturn(stage,f.vault,manifest,rename)).toBe(target)
  expect(publishBrainReturn(stage,f.vault,manifest,rename)).toBe(target)
  // The manifest's own text is part of the verification.
  writeFileSync(join(target,'.manifest.json'),readFileSync(join(target,'.manifest.json'),'utf8').replace('"first"','"forged"'))
  expect(()=>publishBrainReturn(stage,f.vault,manifest,rename)).toThrow(/\.manifest\.json/)
 }finally{f.close()}
})
it('writes nothing when no note changed after the switch',()=>{
 const f=fixture()
 try{
  f.store.setWriteDoor(true)
  f.store.create({title:'Before',kind:'fact',origin:'synthetic',scope:'all',markdown:'Before.'},'synthetic-session')
  const heads=Object.fromEntries(f.store.list().map(note=>[note.id,note.revision]))
  f.store.setWriteDoor(false)
  const {projection,objects}=f.capture(),stage=join(f.root,'stage'),manifest=stageBrainReturn({projection,objects,heads,cutoverId:'none',stage})
  expect(manifest.notes).toEqual([])
  expect(publishBrainReturn(stage,f.vault,manifest,rename)).toBe('')
  expect(existsSync(join(f.vault,'inbox'))).toBe(false)
 }finally{f.close()}
})
it('names files readably in English and Ukrainian',()=>{
 expect(brainReturnSlug('Діаграма / plan: v2')).toBe('діаграма-plan-v2')
 expect(brainReturnSlug('***')).toBe('note')
})
