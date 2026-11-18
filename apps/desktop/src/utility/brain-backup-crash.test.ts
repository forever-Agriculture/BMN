// MODULE: brain-backup-crash.test.ts - Real process interruption and durability barriers around backup publication
import {createRequire} from 'node:module'
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {it,expect} from 'vitest'
const compiler=createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild') as {buildSync(options:Record<string,unknown>):void}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'bmn-backup-crash-')),entry=join(root,'backup.cjs'),preload=join(root,'fault.cjs')
 symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(root,'node_modules'),'dir')
 compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/backup-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
 writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_BACKUP_ROOT,point=process.env.BMN126_BACKUP_POINT
if(!root||!path.basename(root).startsWith('bmn-backup-crash-'))throw new Error('Owned synthetic backup root required')
const backup=path.join(root,'brain-backups'),synced=new Set(),events=[]
const sync=fs.fsyncSync;fs.fsyncSync=fd=>{const result=sync(fd);const target=fs.readlinkSync('/proc/self/fd/'+fd);synced.add(target);events.push(['sync',target]);return result}
const kill=at=>{fs.writeFileSync(path.join(root,'interrupted.json'),JSON.stringify({at,events}));process.kill(process.pid,'SIGKILL')}
const copy=fs.copyFileSync;fs.copyFileSync=(source,target,...args)=>{const result=copy(source,target,...args);if(point==='weekly-copy'&&path.basename(target)==='brain.sqlite3'&&path.basename(path.dirname(target)).includes('weekly-'))kill(point);return result}
const rename=fs.renameSync;fs.renameSync=(source,target,...args)=>{
 const name=path.basename(target),nightly=/^nightly-/.test(name),weekly=/^weekly-/.test(name)
 if(nightly||weekly){
  if(point==='barriers')for(const required of [path.join(source,'brain.sqlite3'),path.join(source,'manifest.json'),source,...(nightly?[path.join(backup,'objects')]:[])])if(!synced.has(required))throw new Error('Missing durability barrier: '+required)
  if(point==='barriers'&&!path.basename(source).startsWith('.'))throw new Error('Published staging directory is not hidden')
  events.push(['publish',target]);synced.delete(backup)
 }
 if(target===path.join(backup,'schedule.json')){
  if(point==='barriers'&&!synced.has(backup))throw new Error('Backup parent was not synced before schedule publication')
  if(point==='schedule-marker')kill(point)
 }
 const result=rename(source,target,...args)
 if(point==='retire-publish'&&name.startsWith('.retired-'))kill(point)
 if(synced.delete(source))synced.add(target)
 if((nightly&&point==='nightly-publish')||(weekly&&point==='weekly-publish'))kill(point)
 return result
}
require('node:module').syncBuiltinESMExports()
`)
 const run=(mode:string,point?:string)=>spawnSync(process.execPath,[...(point?['--require',preload]:[]),entry,mode,root],{env:{...process.env,BMN126_BACKUP_ROOT:root,...(point?{BMN126_BACKUP_POINT:point}:{})},encoding:'utf8',timeout:10_000})
 return {root,run,close:()=>rmSync(root,{recursive:true,force:true})}
}
it.skipIf(process.platform!=='linux')('syncs DB, objects, manifest and directories before publication and schedule success',()=>{
 const f=fixture();try{const result=f.run('empty','barriers');expect(result.status,result.stderr).toBe(0)}finally{f.close()}
})
it.skipIf(process.platform!=='linux').each(['weekly-copy','nightly-publish','weekly-publish','schedule-marker'])('recovers a real process interrupted at %s without counting partial staging',point=>{
 const f=fixture()
 try{
  const seed=f.run('seed');expect(seed.status,seed.stderr).toBe(0)
  const interrupted=f.run('run',point);expect(interrupted.signal,interrupted.stderr).toBe('SIGKILL')
  expect(JSON.parse(readFileSync(join(f.root,'interrupted.json'),'utf8')).at).toBe(point)
  const backup=join(f.root,'brain-backups'),marker=()=>JSON.parse(readFileSync(join(backup,'schedule.json'),'utf8'))
  expect(marker().day).toBe('2026-01-01')
  const before=f.run('verify');expect(before.status,before.stderr).toBe(0)
  const retry=f.run('run');expect(retry.status,retry.stderr).toBe(0)
  expect(marker().day).toBe('2026-01-05')
  expect(readdirSync(backup).filter(name=>/^nightly-/.test(name))).toHaveLength(2)
  expect(readdirSync(backup).filter(name=>/^weekly-/.test(name))).toHaveLength(2)
  const verified=f.run('verify');expect(verified.status,verified.stderr).toBe(0);expect(JSON.parse(verified.stdout).count).toBe(4)
  if(point==='weekly-copy')expect(readdirSync(backup).some(name=>name.startsWith('.weekly-')&&existsSync(join(backup,name,'brain.sqlite3')))).toBe(true)
 }finally{f.close()}
})

it.skipIf(process.platform!=='linux')('recovers after moving an expired scheduled checkpoint out of the published inventory',()=>{
 const f=fixture()
 try{
  const seed=f.run('seed-retention');expect(seed.status,seed.stderr).toBe(0)
  const killed=f.run('run-retention','retire-publish');expect(killed.signal,killed.stderr).toBe('SIGKILL')
  expect(JSON.parse(readFileSync(join(f.root,'interrupted.json'),'utf8')).at).toBe('retire-publish')
  const backup=join(f.root,'brain-backups')
  expect(readdirSync(backup).some(name=>name.startsWith('.retired-'))).toBe(true)
  const retried=f.run('run-retention');expect(retried.status,retried.stderr).toBe(0)
  expect(readdirSync(backup).filter(name=>/^nightly-/.test(name))).toHaveLength(14)
  const verified=f.run('verify');expect(verified.status,verified.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(backup,'schedule.json'),'utf8')).day).toBe('2026-01-15')
 }finally{f.close()}
},20_000)
