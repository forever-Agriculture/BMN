// MODULE: brain-cli.test.ts - Read-only CLI parity and strict mutation framing
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe,it,expect } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore } from './brain-store'
const require=createRequire(import.meta.url)
const SQLite=require('better-sqlite3') as new(path:string)=>DatabaseConnection
const cli=join(import.meta.dirname,'../../bin/bmn')
describe('brain CLI on its actual read-only runtime',()=>{
 it('reads without BMN, preserves section/link parity and refuses writes without a live session',()=>{
  const root=mkdtempSync(join(tmpdir(),'bmn-brain-cli-'));const data=join(root,'data','bmn');mkdirSync(data,{recursive:true})
  const db=new SQLite(join(data,'brain.sqlite3'));const store=new BrainStore(db)
  store.importNotes([{source:'one.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'# Choice\nOn demand.\n```md\n# Example\nNot a section.\n```\n## Why\nA synthetic reason.\n# End\nOther.',status:'active'}]);db.close()
  const env:NodeJS.ProcessEnv={...process.env,HOME:root,XDG_DATA_HOME:join(root,'data')};delete env.BMN_CONTROL_SOCKET;delete env.BMN_TOKEN;delete env.AITERM_CONTROL_SOCKET;delete env.AITERM_TOKEN
  const run=(...args:string[])=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',cli,'brain',...args],{env,encoding:'utf8'})
  try {
   const read=run('read','Synthetic','--json');expect(read.status).toBe(0);expect(JSON.parse(read.stdout).markdown).toContain('On demand.')
   const section=JSON.parse(run('read','Synthetic','--section','Choice','--json').stdout);expect(section.markdown).toBe('# Choice\nOn demand.\n```md\n# Example\nNot a section.\n```\n## Why\nA synthetic reason.')
   expect(JSON.parse(run('search','demand','--json').stdout)).toHaveLength(1)
   expect(run('search','demand','--revision','3').status).toBe(1)
   expect(run('backup').stderr).toContain('Unknown brain command')
   const text=join(root,'synthetic.md');writeFileSync(text,'Synthetic new note')
   const refused=run('write','New','--revision','0','--text-file',text);expect(refused.status).toBe(1);expect(refused.stderr).toContain('running BMN')
   expect(run('--help').stdout.trim().split('\n').length).toBeLessThan(40)
   expect(readFileSync(join(data,'brain.sqlite3'))).toBeTruthy()
  }finally{rmSync(root,{recursive:true,force:true})}
 })
})

it.each(['read','history'])('keeps a CLI read on one SQLite snapshot during a real competing commit (%s)',command=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-cli-race-'))
 const data=join(root,'data','bmn');mkdirSync(data,{recursive:true})
 const databasePath=join(data,'brain.sqlite3'),proof=join(root,'writer.json'),preload=join(root,'writer.mjs')
 const db=new SQLite(databasePath),store=new BrainStore(db)
 store.importNotes([
  {source:'one.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[[OldTarget]]',status:'active'},
  {source:'two.md',title:'Incoming',kind:'fact',origin:'import',scope:'all',markdown:'[[Synthetic]]',status:'active'}
 ])
 const note=store.read('Synthetic');db.close()
 // The reader's first real SELECT establishes the interleaving. A separate SQLite
 // connection then commits a new revision before the CLI asks for history/links.
 writeFileSync(preload,`
import {DatabaseSync} from 'node:sqlite'
import {writeFileSync} from 'node:fs'
const original=DatabaseSync.prototype.prepare
let changed=false
DatabaseSync.prototype.prepare=function(sql){
 const statement=original.call(this,sql),all=statement.all
 if(sql.includes('WHERE n.id=? OR n.normalized_title=?'))statement.all=function(...args){
  const rows=all.apply(this,args)
  if(!changed&&rows.length){
   changed=true
   const writer=new DatabaseSync(${JSON.stringify(databasePath)})
   try{
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare(\`INSERT INTO brain_version SELECT note,revision+1,action,title,kind,origin,session,scope,superseded_by,?,checksum,recorded_at,source_time,status FROM brain_version WHERE note=? AND revision=1\`).run('[[NewTarget]]',${JSON.stringify(note.id)})
    writer.prepare('UPDATE brain_note SET head_revision=2 WHERE id=?').run(${JSON.stringify(note.id)})
    writer.exec('DELETE FROM brain_link')
    writer.prepare("INSERT INTO brain_link VALUES (?,'note','NewTarget',NULL)").run(${JSON.stringify(note.id)})
    writer.exec('COMMIT')
    writeFileSync(${JSON.stringify(proof)},JSON.stringify({committedRevision:2}))
   }finally{writer.close()}
  }
  return rows
 }
 return statement
}
`)
 const env:NodeJS.ProcessEnv={...process.env,HOME:root,XDG_DATA_HOME:join(root,'data')}
 delete env.BMN_DATA_HOME;delete env.AITERM_DATA_HOME
 try {
  const args=command==='read'?['read','Synthetic','--links','--json']:['history','Synthetic','--json']
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--import',preload,cli,'brain',...args],{env,encoding:'utf8'})
  expect(result.status,result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(proof,'utf8'))).toEqual({committedRevision:2})
  const read=JSON.parse(result.stdout)
  if(command==='read'){
   expect(read.revision).toBe(1);expect(read.markdown).toBe('[[OldTarget]]')
   expect(read.links).toEqual([{kind:'note',target:'OldTarget',resolved:null}])
   expect(read.backlinks).toHaveLength(1)
  }else expect(read.map((version:{revision:number})=>version.revision)).toEqual([1])
  const current=new SQLite(databasePath)
  try{expect(new BrainStore(current,false).read(note.id).revision).toBe(2)}finally{current.close()}
 }finally{rmSync(root,{recursive:true,force:true})}
})
