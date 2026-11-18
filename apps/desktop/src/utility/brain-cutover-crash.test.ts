// MODULE: brain-cutover-crash.test.ts - Kill actual processes between cutover mutations and records
import {createRequire} from 'node:module'
import {chmodSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {it,expect} from 'vitest'
import type {BrainCutoverPaths} from './brain-cutover-journal'
const compiler=createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild') as {buildSync(options:Record<string,unknown>):void}
function fixture(codexFolder=false){
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-crash-')),vault=join(root,'vault');mkdirSync(vault);mkdirSync(join(vault,'files'));mkdirSync(join(vault,'.git'));writeFileSync(join(vault,'note.md'),'A synthetic personal fact.\n')
 const paths:BrainCutoverPaths={home:root,vault,journal:join(root,'journal'),master:join(root,'master'),claudeRules:join(root,'CLAUDE.md'),codexRules:join(root,'AGENTS.md'),claudeSkill:join(root,'.claude/skills/brain'),codexSkill:join(root,'.agents/skills/brain'),managedSkill:join(root,'.local/share/bmn/skills/brain'),shippedSkill:join(root,'resources/skills/brain'),indexes:[join(root,'MEMORY.md')]}
 for(const path of [paths.master,paths.claudeRules,paths.codexRules,...paths.indexes])writeFileSync(path,'Old vault instructions with many words.\n')
 for(const path of [paths.claudeSkill,paths.shippedSkill]){mkdirSync(path,{recursive:true});writeFileSync(join(path,'SKILL.md'),path===paths.claudeSkill?'old vault skill':'bmn brain')}
 mkdirSync(join(paths.codexSkill,'..'),{recursive:true});if(codexFolder){mkdirSync(paths.codexSkill);writeFileSync(join(paths.codexSkill,'SKILL.md'),'Original synthetic Codex folder')}else symlinkSync(paths.claudeSkill,paths.codexSkill);writeFileSync(join(root,'timer.txt'),'enabled');writeFileSync(join(root,'paths.json'),JSON.stringify(paths))
 const before=Object.fromEntries([paths.master,paths.claudeRules,paths.codexRules,paths.indexes[0]!,join(paths.claudeSkill,'SKILL.md'),join(vault,'note.md')].map(p=>[p,{text:readFileSync(p,'utf8'),mode:lstatSync(p).mode&0o7777}]))
 return {root,paths,before,cleanup(){for(const entry of readdirSync(root,{recursive:true,withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())chmodSync(join(entry.parentPath,entry.name),0o700);rmSync(root,{recursive:true,force:true})}}
}
it('rolls back every pre-commit crash and can recover a crash inside rollback',()=>{
 const harness=mkdtempSync(join(tmpdir(),'bmn-brain-harness-')),entry=join(harness,'crash.cjs')
 try{
  symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(harness,'node_modules'),'dir')
  compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/cutover-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  const run=(mode:string,root:string,crash=0)=>spawnSync(process.execPath,[entry,mode,root,String(crash)],{encoding:'utf8',timeout:10_000})
  const control=fixture();let boundaries=0
  try{const result=run('run',control.root);expect(result.status,result.stderr).toBe(0);boundaries=JSON.parse(result.stdout).count;expect(boundaries).toBeGreaterThan(15)}finally{control.cleanup()}
  for(let boundary=1;boundary<=boundaries;boundary++){
   const f=fixture()
   try{
    expect(run('run',f.root,boundary).signal,'boundary '+boundary).toBe('SIGKILL')
    if(boundary===boundaries)expect(run('recover-crash',f.root).signal).toBe('SIGKILL')
    const recovered=run('recover',f.root);expect(recovered.status,recovered.stderr).toBe(0);expect(JSON.parse(recovered.stdout).open).toBe(false)
    for(const [path,expected]of Object.entries(f.before)){expect(readFileSync(path,'utf8'),'boundary '+boundary+': '+path).toBe(expected.text);expect(lstatSync(path).mode&0o7777).toBe(expected.mode)}
    expect(readFileSync(join(f.root,'timer.txt'),'utf8')).toBe('enabled');expect(lstatSync(f.paths.codexSkill).isSymbolicLink()).toBe(true)
    expect(existsSync(join(f.paths.vault,'ARCHIVE.md'))).toBe(false);expect(existsSync(join(f.root,'delivery.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
   }finally{f.cleanup()}
  }
 }finally{rmSync(harness,{recursive:true,force:true})}
},90_000)

it.each(['master','claudeSkill','codexSkill'] as const)('recovers an actual crash immediately after restoring %s',key=>{
 const harness=mkdtempSync(join(tmpdir(),'bmn-brain-file-restore-')),entry=join(harness,'crash.cjs'),preload=join(harness,'fault.cjs'),f=fixture(true)
 try{
  symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(harness,'node_modules'),'dir')
  compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/cutover-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_SYNTHETIC_RESTORE_ROOT
if(!root||!path.basename(root).startsWith('bmn-brain-crash-'))throw new Error('Synthetic owned root required')
const paths=JSON.parse(fs.readFileSync(path.join(root,'paths.json'),'utf8'))
const crash=(operation,target)=>{if(path.resolve(target)===paths[process.env.BMN126_SYNTHETIC_RESTORE_KEY]&&fs.existsSync(path.join(root,'restore-started.flag'))){fs.writeFileSync(path.join(root,'restore-crashed.json'),JSON.stringify({operation,target}));process.kill(process.pid,'SIGKILL')}}
const remove=fs.rmSync;fs.rmSync=(target,...args)=>{const result=remove(target,...args);crash('remove',target);return result}
const rename=fs.renameSync;fs.renameSync=(source,target,...args)=>{const result=rename(source,target,...args);crash('rename',target);return result}
const cp=require('node:child_process'),spawn=cp.spawnSync;cp.spawnSync=(file,args,options)=>{const result=spawn(file,args,options);if(result.status===0&&String(args).includes('brain-cutover-files.py')){const request=JSON.parse(options.input);crash('atomic-'+request.operation,request.target)}return result}
require('node:module').syncBuiltinESMExports()
`)
  const crashed=spawnSync(process.execPath,['--require',preload,entry,'run-fail',f.root],{env:{...process.env,BMN126_SYNTHETIC_RESTORE_ROOT:f.root,BMN126_SYNTHETIC_RESTORE_KEY:key},encoding:'utf8',timeout:10_000})
  expect(crashed.signal,crashed.stderr).toBe('SIGKILL')
  expect(JSON.parse(readFileSync(join(f.root,'restore-crashed.json'),'utf8')).target).toBe(f.paths[key])
  const recovered=spawnSync(process.execPath,[entry,'recover',f.root],{encoding:'utf8',timeout:10_000})
  expect(recovered.status,recovered.stderr).toBe(0)
  for(const [path,before]of Object.entries(f.before))expect(readFileSync(path,'utf8')).toBe(before.text)
  expect(readFileSync(join(f.paths.codexSkill,'SKILL.md'),'utf8')).toBe('Original synthetic Codex folder')
  expect(lstatSync(f.paths.master).mode&0o7777).toBe(f.before[f.paths.master]!.mode)
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.cleanup();rmSync(harness,{recursive:true,force:true})}
})

it.each(['before-return','after-return','legacy-intent','foreign-inode'] as const)('recovers an interrupted held skill without replacing an unrelated inode (%s)',mode=>{
 const f=fixture(),harness=mkdtempSync(join(tmpdir(),'bmn-brain-held-skill-'))
 const entry=join(harness,'crash.cjs'),preload=join(harness,'fault.cjs')
 try{
  const original=lstatSync(f.paths.claudeSkill)
  symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(harness,'node_modules'),'dir')
  compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/cutover-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),child=require('node:child_process')
const root=process.argv[3]
if(!root||!path.basename(root).startsWith('bmn-brain-crash-'))throw new Error('Synthetic owned root required')
const paths=JSON.parse(fs.readFileSync(path.join(root,'paths.json'),'utf8'))
const spawn=child.spawnSync
child.spawnSync=(file,args,options)=>{
 const request=String(args).includes('brain-cutover-files.py')?JSON.parse(options.input):null
 const returning=request?.operation==='no-replace'&&request.target===paths.claudeSkill
 if(returning&&process.env.BMN126_HELD_TEST==='before-return')process.kill(process.pid,'SIGKILL')
 const result=spawn(file,args,options)
 if(result.status===0&&request?.operation==='no-replace'&&(request.source===paths.claudeSkill||returning&&process.env.BMN126_HELD_TEST==='after-return'))process.kill(process.pid,'SIGKILL')
 return result
}
require('node:module').syncBuiltinESMExports()
`)
  const run=(operation:string,phase?:string)=>spawnSync(process.execPath,[...(phase?['--require',preload]:[]),entry,operation,f.root],{env:{...process.env,BMN126_HELD_TEST:phase},encoding:'utf8',timeout:10_000})
  const moves=run('run','outbound')
  expect(moves.signal,moves.stderr).toBe('SIGKILL')
  expect(existsSync(f.paths.claudeSkill)).toBe(false)
  const journalPath=join(f.paths.journal,'journal.json'),journal=JSON.parse(readFileSync(journalPath,'utf8'))
  const saved=journal.saved.find((row:{path:string})=>row.path===f.paths.claudeSkill)
  expect(lstatSync(saved.held.path).ino).toBe(original.ino)
  if(mode==='legacy-intent'){
   saved.restore={temporary:join(f.paths.claudeSkill,'../.brain.brain-restore-11111111-1111-4111-8111-111111111111'),phase:'planned',original:saved.original,written:JSON.stringify(['missing']),targetDev:0,targetIno:0}
   writeFileSync(journalPath,JSON.stringify(journal))
  }else if(mode==='foreign-inode'){
   mkdirSync(f.paths.claudeSkill,{mode:original.mode&0o7777});writeFileSync(join(f.paths.claudeSkill,'SKILL.md'),'old vault skill')
   const foreign=lstatSync(f.paths.claudeSkill)
   const refused=run('recover')
   expect(refused.status,refused.stdout).toBe(1)
   expect(refused.stderr).toMatch(/original bytes at the wrong inode/)
   expect(lstatSync(f.paths.claudeSkill).ino).toBe(foreign.ino)
   expect(lstatSync(saved.held.path).ino).toBe(original.ino)
   expect(readFileSync(join(f.root,'timer.txt'),'utf8')).toBe('disabled')
   return
  }else{
   const interrupted=run('recover',mode)
   expect(interrupted.signal,interrupted.stderr).toBe('SIGKILL')
   expect(existsSync(f.paths.claudeSkill)).toBe(mode==='after-return')
  }
  const recovered=run('recover')
  expect(recovered.status,recovered.stderr).toBe(0)
  expect(lstatSync(f.paths.claudeSkill)).toMatchObject({dev:original.dev,ino:original.ino})
  expect(readFileSync(join(f.paths.claudeSkill,'SKILL.md'),'utf8')).toBe('old vault skill')
  expect(JSON.parse(readFileSync(journalPath,'utf8')).state).toBe('rolled-back')
  expect(readFileSync(join(f.root,'timer.txt'),'utf8')).toBe('enabled')
 }finally{f.cleanup();rmSync(harness,{recursive:true,force:true})}
},30_000)

it('recovers an actual process crash in the middle of restoring a skill directory',()=>{
 const harness=mkdtempSync(join(tmpdir(),'bmn-brain-directory-restore-')),entry=join(harness,'crash.cjs'),preload=join(harness,'fault.cjs'),f=fixture()
 try{
  writeFileSync(join(f.paths.claudeSkill,'SECOND.md'),'Second original synthetic file')
  symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(harness,'node_modules'),'dir')
  compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/cutover-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_SYNTHETIC_RESTORE_ROOT
if(!root||!path.basename(root).startsWith('bmn-brain-crash-'))throw new Error('Synthetic owned root required')
const paths=JSON.parse(fs.readFileSync(path.join(root,'paths.json'),'utf8')),copy=fs.cpSync
fs.cpSync=(source,target,...args)=>{
 if(fs.existsSync(path.join(root,'restore-started.flag'))&&(target===paths.claudeSkill||String(target).startsWith(path.join(path.dirname(paths.claudeSkill),'.'+path.basename(paths.claudeSkill)+'.brain-restore-')))&&fs.lstatSync(source).isDirectory()){
  fs.mkdirSync(target);const first=fs.readdirSync(source).sort()[0];copy(path.join(source,first),path.join(target,first),...args)
  fs.writeFileSync(path.join(root,'directory-partial.json'),JSON.stringify({source,target,first}));process.kill(process.pid,'SIGKILL')
 }
 return copy(source,target,...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const crashed=spawnSync(process.execPath,['--require',preload,entry,'run-fail',f.root],{env:{...process.env,BMN126_SYNTHETIC_RESTORE_ROOT:f.root},encoding:'utf8',timeout:10_000})
  expect(crashed.signal,crashed.stderr).toBe('SIGKILL');expect(existsSync(join(f.root,'directory-partial.json'))).toBe(true)
  const recovered=spawnSync(process.execPath,[entry,'recover',f.root],{encoding:'utf8',timeout:10_000})
  expect(recovered.status,recovered.stderr).toBe(0)
  expect(readFileSync(join(f.paths.claudeSkill,'SKILL.md'),'utf8')).toBe('old vault skill')
  expect(readFileSync(join(f.paths.claudeSkill,'SECOND.md'),'utf8')).toBe('Second original synthetic file')
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.cleanup();rmSync(harness,{recursive:true,force:true})}
})

it('recovers a crash after durable worker revocation while the journal still says complete',()=>{
 const harness=mkdtempSync(join(tmpdir(),'bmn-brain-retired-recovery-')),entry=join(harness,'crash.cjs'),preload=join(harness,'fault.cjs'),f=fixture()
 try{
  symlinkSync(resolve(import.meta.dirname,'../../node_modules'),join(harness,'node_modules'),'dir')
  compiler.buildSync({entryPoints:[join(import.meta.dirname,'test-fixtures/brain/cutover-process.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']})
  writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_SYNTHETIC_RESTORE_ROOT
if(!root||!path.basename(root).startsWith('bmn-brain-crash-'))throw new Error('Synthetic owned root required')
const paths=JSON.parse(fs.readFileSync(path.join(root,'paths.json'),'utf8')),rename=fs.renameSync
fs.renameSync=(source,target,...args)=>{
 if(target===path.join(paths.journal,'journal.json')&&fs.existsSync(path.join(root,'restore-started.flag'))&&JSON.parse(fs.readFileSync(source,'utf8')).state==='rolling-back')process.kill(process.pid,'SIGKILL')
 return rename(source,target,...args)
}
require('node:module').syncBuiltinESMExports()
`)
  const crashed=spawnSync(process.execPath,['--require',preload,entry,'run-rollback',f.root],{env:{...process.env,BMN126_SYNTHETIC_RESTORE_ROOT:f.root},encoding:'utf8',timeout:10_000})
  expect(crashed.signal,crashed.stderr).toBe('SIGKILL');expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('complete')
  const status=spawnSync(process.execPath,[entry,'status',f.root],{encoding:'utf8',timeout:10_000})
  expect(status.status,status.stderr).toBe(0);expect(JSON.parse(status.stdout)).toMatchObject({committed:false,open:false,receipt:null,retired:{version:2}})
  const recovered=spawnSync(process.execPath,[entry,'recover',f.root],{encoding:'utf8',timeout:10_000})
  expect(recovered.status,recovered.stderr).toBe(0)
  for(const [path,before]of Object.entries(f.before))expect(readFileSync(path,'utf8')).toBe(before.text)
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.cleanup();rmSync(harness,{recursive:true,force:true})}
})
