// MODULE: backup-process.ts - Real SQLite backup interruption fixture using only its guarded synthetic root
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {basename,join,resolve} from 'node:path'
import {mkdirSync,writeFileSync,readdirSync,lstatSync} from 'node:fs'
import {BrainStore} from '../../brain-store'
import {BrainFiles} from '../../brain-files'
import {restoreBrainCheck} from '../../brain-restore'
import type {DatabaseConnection} from '../../database-initialization'
const [mode,rawRoot]=process.argv.slice(2),root=resolve(rawRoot??'')
if(!['seed','run','verify','empty','seed-retention','run-retention'].includes(mode??'')||!basename(root).startsWith('bmn-backup-crash-'))throw new Error('Owned synthetic backup root required')
const SQLite=createRequire(__filename)('better-sqlite3') as new(path:string)=>DatabaseConnection
const store=new BrainStore(new SQLite(join(root,'brain.sqlite3'))),attachments=join(root,'files'),files=new BrainFiles(store,root,attachments)
try{
 if(mode==='seed'||mode==='seed-retention'){
  mkdirSync(attachments);writeFileSync(join(attachments,'asset.bin'),'Synthetic preserved bytes')
  store.importNotes([{source:'vault:note.md',title:'Synthetic',kind:'fact',origin:'import',scope:'all',markdown:'[asset](files/asset.bin)',status:'active'}])
  const days=mode==='seed-retention'?14:1
  for(let day=1;day<=days;day++)files.scheduled(new Date(Date.UTC(2026,0,day,4)))
 }else if(mode==='run-retention')files.scheduled(new Date('2026-01-15T04:00:00Z'))
 else if(mode==='run'||mode==='empty')files.scheduled(new Date('2026-01-05T04:00:00Z'))
 else{
  let count=0
  for(const name of readdirSync(files.backupRoot))if(/^(nightly|weekly)-/.test(name)&&lstatSync(join(files.backupRoot,name)).isDirectory()){
   const restored=restoreBrainCheck(join(files.backupRoot,name),join(root,'scratch-'+randomUUID()),path=>new SQLite(path))
   if(!restored.ok||restored.notes!==1||restored.attachments!==1)throw new Error('Completed checkpoint is not fully restorable')
   count++
  }
  console.log(JSON.stringify({count}))
 }
}finally{store.database.close()}
