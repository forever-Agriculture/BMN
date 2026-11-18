// MODULE: brain-cutover-paths.test.ts - Fixed recovery roots, complete backup membership and no-follow ancestry
import {mkdtempSync,mkdirSync,writeFileSync,lstatSync,rmSync,renameSync,symlinkSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it} from 'vitest'
import {assertBrainRecoveryPaths} from './brain-cutover-paths'
import {brainPathFingerprint,brainRestorePrefix} from '../utility/brain-cutover-journal'
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'bmn-brain-recovery-paths-')),state=join(home,'state'),skills=join(home,'resources/skills'),journal=join(state,'brain-cutover')
 const paths={home,vault:join(home,'brain'),journal,master:join(home,'.config/bmn/agents/global-rules.md'),claudeRules:join(home,'.claude/CLAUDE.md'),codexRules:join(home,'.codex/AGENTS.md'),claudeSkill:join(home,'.claude/skills/brain'),codexSkill:join(home,'.agents/skills/brain'),managedSkill:join(home,'.local/share/bmn/skills/brain'),shippedSkill:join(skills,'brain'),indexes:[join(home,'.claude/projects/-synthetic/memory/MEMORY.md')]}
 for(const path of [paths.master,...paths.indexes]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'Synthetic original')}
 mkdirSync(paths.vault);mkdirSync(paths.claudeSkill,{recursive:true});writeFileSync(join(paths.claudeSkill,'SKILL.md'),'Synthetic old skill')
 mkdirSync(join(journal,'saved'),{recursive:true});writeFileSync(join(journal,'saved','0'),'Synthetic original')
 mkdirSync(join(journal,'saved','1'));writeFileSync(join(journal,'saved','1','SKILL.md'),'Synthetic old skill')
 const saved=[paths.master,paths.claudeSkill].map((path,index)=>({path,backup:join(journal,'saved',String(index)),mode:lstatSync(path).mode&0o7777,folder:lstatSync(path).isDirectory(),original:brainPathFingerprint(path),written:brainPathFingerprint(path)}))
 const record={version:1,saved,modes:[{path:paths.vault,mode:lstatSync(paths.vault).mode&0o7777,dev:lstatSync(paths.vault).dev,ino:lstatSync(paths.vault).ino}],timers:{'brain-autocommit':{enabled:true,active:true}}}
 return {home,state,skills,paths,record,check(){assertBrainRecoveryPaths(this.paths,this.record,{home,state,skills})},close(){rmSync(home,{recursive:true,force:true})}}
}
it('accepts the real path layout, exact regular/folder backups and recorded vault modes',()=>{const f=fixture();try{expect(()=>f.check()).not.toThrow()}finally{f.close()}})
it.each(['home','vault','journal','master','claudeRules','codexRules','claudeSkill','codexSkill','managedSkill','shippedSkill'] as const)('refuses a redirected fixed recovery field %s',key=>{
 const f=fixture();try{f.paths[key]=join(f.home,'unapproved');expect(()=>f.check()).toThrow(/recovery path/)}finally{f.close()}
})
it('refuses unlisted targets, escaped/reordered/corrupt backups and duplicate targets',()=>{
 const f=fixture();try{
  const original=structuredClone(f.record)
  f.record.saved[0]!.path=join(f.home,'outside.md');expect(()=>f.check()).toThrow(/saved target/);f.record=structuredClone(original)
  f.record.saved[0]!.backup=join(f.home,'outside.md');expect(()=>f.check()).toThrow(/backup location/);f.record=structuredClone(original)
  f.record.saved[0]!.backup=join(f.paths.journal,'saved','1');expect(()=>f.check()).toThrow(/backup location/);f.record=structuredClone(original)
  f.record.saved[0]!.original='changed';expect(()=>f.check()).toThrow(/backup identity/);f.record=structuredClone(original)
  f.record.saved.push(f.record.saved[0]!);expect(()=>f.check()).toThrow(/saved target/)
 }finally{f.close()}
})
it('refuses symlink ancestors without following them to change the outside canary',()=>{
 const f=fixture();try{
  const foreign=join(f.home,'foreign-config');mkdirSync(foreign);writeFileSync(join(foreign,'canary'),'Independent synthetic file')
  renameSync(join(f.home,'.config'),join(f.home,'original-config'));symlinkSync(foreign,join(f.home,'.config'))
  expect(()=>f.check()).toThrow(/recovery path/)
  expect(lstatSync(join(foreign,'canary')).size).toBe(26)
 }finally{f.close()}
})
it('refuses memory-note targets, out-of-vault modes, writable exceptions and unknown timers',()=>{
 const f=fixture();try{
  f.paths.indexes=[join(f.home,'.claude/projects/-synthetic/memory/note.md')];expect(()=>f.check()).toThrow(/memory index/)
  f.paths.indexes=[join(f.home,'.claude/projects/-synthetic/memory/MEMORY.md')]
  for(const path of [join(f.home,'outside'),join(f.paths.vault,'files/a'),join(f.paths.vault,'.git/config')]){f.record.modes[0]!.path=path;expect(()=>f.check()).toThrow(/vault mode location/)}
  f.record.modes[0]!.path=f.paths.vault
  Object.assign(f.record.timers,{'unapproved':{enabled:true,active:true}});expect(()=>f.check()).toThrow(/timer/)
 }finally{f.close()}
})

it('validates every restore-stage path, nonce, phase, identity and retained-stage record before recovery',()=>{
 const f=fixture();try{
  const item=f.record.saved[0]!,stat=lstatSync(item.path),valid={temporary:brainRestorePrefix(item.path)+'12345678-1234-4234-8234-123456789abc',phase:'planned',original:item.original,written:item.written,targetDev:stat.dev,targetIno:stat.ino}
  Object.assign(item,{restore:valid});expect(()=>f.check()).not.toThrow()
  for(const mutation of [
   {temporary:join(f.home,'unapproved')},{temporary:item.path+'.brain-restore-not-a-nonce'},{phase:'unapproved'},{original:'changed'},{written:'changed'},{targetDev:-1},{targetIno:-1},{device:stat.dev},{inode:stat.ino},{device:-1,inode:stat.ino},{device:stat.dev,inode:0},
   {abandoned:[{temporary:join(f.home,'unapproved'),device:stat.dev,inode:stat.ino}]},{abandoned:[{temporary:valid.temporary,device:stat.dev,inode:stat.ino}]},
  ]){Object.assign(item,{restore:{...valid,...mutation}});expect(()=>f.check(),JSON.stringify(mutation)).toThrow(/restore/)}
 }finally{f.close()}
})
