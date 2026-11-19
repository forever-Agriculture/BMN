// MODULE: brain-cutover-journal.test.ts - Synthetic vault switch and unified rollback
import {createRequire} from 'node:module'
import {chmodSync,existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,readlinkSync,readdirSync,rmSync,writeFileSync,renameSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import type {DatabaseConnection} from './database-initialization'
import {BrainStore} from './brain-store'
import {BrainFiles} from './brain-files'
import {verifyBrainImportExport} from './brain-export-proof'
import {BrainAdmission} from './brain-admission'
import {installOwnSkills,ownCopiesRoot} from '../../bin/agents-own-skills.mjs'
import {configureBrainReceiptReader} from '../../bin/brain-state.mjs'
import {brainCutoverSkills} from '../../bin/brain-cutover-skills.mjs'
// @ts-expect-error normal private ownership engine has no published declarations
import {initializeDefaultsOwnership,readDefaultsOwnership} from '../../bin/defaults-ownership.mjs'
import {withDefaultsAdmission} from '../../bin/defaults-admission.mjs'
import {brainAtomicRename} from './brain-cutover-files'
import {BrainCutoverJournal,BRAIN_MEMORY_POINTER,type BrainCutoverPaths} from './brain-cutover-journal'
const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
function fixture(fail=false,blocked=false,writerProbe?:(vault:string)=>Promise<{blockers:unknown[];unknown:number[]}>,independentEdit?:(paths:BrainCutoverPaths)=>void,report?:()=>Promise<void>,decide?:()=>Promise<void>,guard?:()=>void){
 const priorHome=process.env.HOME,root=mkdtempSync(join(tmpdir(),'brain-switch-')),vault=join(root,'vault');process.env.HOME=root;mkdirSync(vault)
 for(const name of ['files','.git','notes'])mkdirSync(join(vault,name));writeFileSync(join(vault,'notes','Personal.md'),'# Personal\nA lasting synthetic preference.\n')
 const paths:BrainCutoverPaths={home:root,vault,journal:join(root,'state','brain-cutover'),master:join(root,'master'),claudeRules:join(root,'CLAUDE.md'),codexRules:join(root,'AGENTS.md'),claudeSkill:join(root,'.claude/skills/brain'),codexSkill:join(root,'.agents/skills/brain'),managedSkill:join(root,'.local/share/bmn/skills/brain'),shippedSkill:join(root,'resources/skills/brain'),indexes:[join(root,'MEMORY.md')]}
 for(const path of [paths.master,paths.claudeRules,paths.codexRules,...paths.indexes])writeFileSync(path,'Old vault instruction, with many words.\n')
 for(const path of [paths.claudeSkill,paths.codexSkill,paths.shippedSkill]){mkdirSync(path,{recursive:true});writeFileSync(join(path,'SKILL.md'),path===paths.shippedSkill?'bmn brain':'old vault skill')}
 const store=new BrainStore(new SQLite(join(root,'brain.sqlite3'))),files=new BrainFiles(store,root,join(vault,'files'))
 const admission=new BrainAdmission(store,join(paths.journal,'journal.json'))
 const brain={returnCapture:async()=>{if(store.isOpen())throw new Error('The brain return capture needs the closed write door');const snapshot=files.snapshot('return',new Date(),undefined,false);return {snapshot,projection:files.dump() as never,objects:join(files.backupRoot,'objects')}},admission:async()=>admission.status(),commitCutover:async(hash:string)=>admission.commit(hash),resumeCutover:async()=>admission.resume(),setWriteDoor:async(open:boolean)=>{if(open)store.setWriteDoor(true);else admission.revoke()},importNotes:async(...a:Parameters<BrainStore['importNotes']>)=>{const checkpoint=files.snapshot('before-import');return {...store.importNotes(...a),checkpoint}},list:async()=>store.list(),read:async(...a:Parameters<BrainStore['read']>)=>store.read(...a),create:async(...a:Parameters<BrainStore['create']>)=>store.create(...a),withdraw:async(...a:Parameters<BrainStore['withdraw']>)=>store.withdraw(...a),export:async()=>files.export(),backup:async()=>files.snapshot('manual'),restoreCheck:async()=>({ok:true as const,notes:0,versions:0,attachments:0})}
 let restored=false,time=0
 const journal=new BrainCutoverJournal(paths,{skills:brainCutoverSkills(paths,guard??(()=>{})),rulesAdmission:work=>withDefaultsAdmission(work),atomicRename:brainAtomicRename(join(import.meta.dirname,'../../bin')),brain,guard:guard??(()=>{}),decide:decide??(async()=>{}),commit:()=>{},pauseWriters:async record=>record({synthetic:{active:true,enabled:true}}),restoreTimers:async()=>{restored=true},writers:async()=>writerProbe?writerProbe(vault):({blockers:blocked?[42]:[],unknown:[]}),renderRules:async()=>{writeFileSync(paths.claudeRules,'bmn brain');writeFileSync(paths.codexRules,'bmn brain')},instructionProof:async()=>{},recoverCheck:async()=>({status:'absent'}),importProof:async(current,notes)=>verifyBrainImportExport(current,root,notes),installedProof:async()=>{independentEdit?.(paths);if(fail){writeFileSync(paths.indexes[0]!,readFileSync(paths.indexes[0]!,'utf8')+'New independent line\n');throw new Error('synthetic installed check failure')}},afterSwitch:report??(async()=>{}),now:()=>time,sleep:async ms=>{time+=ms}},{synthetic:true},'c'.repeat(40))
 return {root,vault,paths,store,brain,journal,files,confirmReturn:()=>admission.authorizeReturn(),restored:()=>restored,run:()=>journal.run([{source:join(vault,'notes','Personal.md'),source_kind:'vault',label:'brain'}],[],[{before:'Old vault instruction, with many words.',after:'bmn brain'}]),close(){if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;store.database.close();for(const entry of readdirSync(root,{recursive:true,withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())chmodSync(join(entry.parentPath,entry.name),0o700);chmodSync(root,0o700);rmSync(root,{recursive:true,force:true})}}
}
it('records all phases and makes a read-only archive while preserving files and git',async()=>{
 const f=fixture();try{
  await f.run();const state=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8'))
  expect(state.state).toBe('complete');expect(state.phases).toContain('memory-indexes');expect(f.store.isOpen()).toBe(true)
  expect(lstatSync(join(f.vault,'notes','Personal.md')).mode&0o222).toBe(0);expect(lstatSync(f.vault).mode&0o222).toBe(0)
  for(const name of ['files','.git'])expect(lstatSync(join(f.vault,name)).mode&0o200).toBe(0o200)
  expect(()=>writeFileSync(join(f.vault,'new.md'),'no')).toThrow();expect(()=>rmSync(join(f.vault,'notes','Personal.md'))).toThrow();expect(()=>renameSync(join(f.vault,'notes','Personal.md'),join(f.vault,'notes','renamed.md'))).toThrow()
  writeFileSync(join(f.vault,'files','allowed'),'yes');expect(f.store.list().some(n=>n.title==='Personal')).toBe(true)
 }finally{f.close()}
})
it('rolls back after memory indexes and keeps independently added index lines',async()=>{
 const f=fixture(true);try{
  await expect(f.run()).rejects.toThrow(/synthetic installed/)
  expect(f.store.isOpen()).toBe(false);expect(f.restored()).toBe(true);expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault')
  expect(readFileSync(f.paths.indexes[0]!,'utf8')).toContain('New independent line');expect(readFileSync(f.paths.indexes[0]!,'utf8')).not.toContain(BRAIN_MEMORY_POINTER.trim())
  expect(lstatSync(f.paths.codexSkill).isDirectory()).toBe(true);expect(existsSync(join(f.vault,'ARCHIVE.md'))).toBe(false)
  expect(lstatSync(f.vault).mode&0o200).toBe(0o200);expect(existsSync(join(f.paths.journal,'brain-changes.json'))).toBe(true)
 }finally{f.close()}
})
it('stops before the master switch if a held writer cannot drain in ten minutes',async()=>{
 const f=fixture(false,true);try{await expect(f.run()).rejects.toThrow(/ten minutes/);expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault');expect(f.store.list()).toHaveLength(0);expect(f.restored()).toBe(true)}finally{f.close()}
})

it('holds old paths and timers while the brain worker cannot revoke admission, then retries whole recovery',async()=>{
 const f=fixture(true);const close=f.brain.setWriteDoor,captureBrain=f.brain.returnCapture
 let calls=0
 f.brain.setWriteDoor=async open=>{if(!open&&calls++>0)throw new Error('synthetic worker unavailable');return close(open)}
 f.brain.returnCapture=async()=>{if(readFileSync(f.paths.master,'utf8')==='bmn brain\n')throw new Error('synthetic worker unavailable');return captureBrain()}
 try{
  await expect(f.run()).rejects.toThrow(/rollback incomplete/)
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  expect(lstatSync(f.vault).mode&0o222).toBe(0)
  f.brain.setWriteDoor=close;f.brain.returnCapture=captureBrain;await f.journal.rollback()
  expect(f.store.isOpen()).toBe(false);expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.close()}
})
it('refuses a lifted permission barrier before changing the master',async()=>{
 const f=fixture();const imported=f.brain.importNotes,originalMode=lstatSync(join(f.vault,'notes','Personal.md')).mode&0o7777
 f.brain.importNotes=async notes=>{const result=await imported(notes);chmodSync(join(f.vault,'notes','Personal.md'),originalMode);return result}
 try{await expect(f.run()).rejects.toThrow(/barrier or inode changed/);expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault');expect(f.store.isOpen()).toBe(false)}finally{f.close()}
})

it.each([1,2])('imports every successful racing write and preserves readable Git history, pass %s',async()=>{
 const f=fixture(false,false,async vault=>{
  const probe=spawnSync('/usr/bin/python3',['-I',join(import.meta.dirname,'../../bin/brain-vault-writers.py'),vault],{encoding:'utf8',timeout:5000})
  if(probe.status!==0)throw new Error(probe.stderr)
  return JSON.parse(probe.stdout)
 })
 const environment={...process.env,HOME:f.root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}
 const git=(...args:string[])=>spawnSync('/usr/bin/git',['-C',f.vault,'-c','core.hooksPath=/dev/null',...args],{env:environment,encoding:'utf8'})
 expect(git('init','--quiet').status).toBe(0)
 expect(git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','--no-gpg-sign','-qm','Synthetic archive control').status).toBe(0)
 const writer=spawn('/usr/bin/python3',['-I','-c',`
import sys,select,time,json
count=0
while True:
 if select.select([sys.stdin],[],[],0)[0] and sys.stdin.readline()=='':break
 try:
  with open(sys.argv[1],'a') as stream:stream.write('synthetic-writer-%d\\n'%count)
  count+=1
  if count==1:print('READY',flush=True)
 except PermissionError:
  print(json.dumps({'written':count,'permissionDenied':True}),flush=True);break
 time.sleep(0.001)
`,join(f.vault,'notes','Personal.md')],{stdio:['pipe','pipe','pipe']})
 let output='';writer.stdout.on('data',data=>{output+=data.toString()})
 const closed=new Promise<number|null>(resolve=>writer.once('close',resolve))
 try {
  await new Promise<void>((resolve,reject)=>{const lines=createInterface({input:writer.stdout});lines.once('line',line=>line==='READY'?resolve():reject(new Error('Writer not ready')));writer.once('error',reject)})
  await f.run();expect(await closed).toBe(0)
  expect(output).toContain('"permissionDenied": true')
  const note=f.store.read('Personal')
  expect(note.markdown).toContain('synthetic-writer-0')
  expect(note.markdown).toBe(readFileSync(join(f.vault,'notes','Personal.md'),'utf8'))
  expect(git('log','-1','--format=%s').stdout.trim()).toBe('Synthetic archive control')
 }finally{writer.stdin.end();await closed;f.close()}
},15_000)

it('preserves an independent rules edit and reports its rollback conflict',async()=>{
 const f=fixture(true,false,undefined,paths=>writeFileSync(paths.master,'Independent owner edit\n'))
 try{
  await expect(f.run()).rejects.toThrow(/rollback incomplete.*conflict/i)
  expect(readFileSync(f.paths.master,'utf8')).toBe('Independent owner edit\n')
  expect(readFileSync(f.paths.claudeRules,'utf8')).toBe('bmn brain')
  expect(readFileSync(f.paths.codexRules,'utf8')).toBe('bmn brain');expect(lstatSync(f.vault).mode&0o222).toBe(0)
  expect(f.store.isOpen()).toBe(false);expect(f.restored()).toBe(false)
 }finally{f.close()}
})

it('still attempts whole rollback when saving the diagnostic error fails',async()=>{
 const f=fixture(false,false,async()=>{chmodSync(f.paths.journal,0o500);throw new Error('synthetic writer probe failure')})
 const originalMode=lstatSync(f.vault).mode&0o7777
 try{
  await expect(f.run()).rejects.toThrow()
  expect(f.store.isOpen()).toBe(false)
  expect(f.restored()).toBe(false)
  expect(lstatSync(f.vault).mode&0o222).toBe(0)
  // A failed durable intent cannot authorize removing even our archive entry.
  expect(existsSync(join(f.vault,'ARCHIVE.md'))).toBe(true)
  chmodSync(f.paths.journal,0o700);await f.journal.rollback()
  expect(existsSync(join(f.vault,'ARCHIVE.md'))).toBe(false);expect(f.restored()).toBe(true)
  expect(lstatSync(f.vault).mode&0o7777).toBe(originalMode)
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.close()}
})

it('preserves a replaced vault inode and its mode instead of chmodding the foreign replacement during rollback',async()=>{
 const f=fixture(false,false,undefined,paths=>{
  const folder=join(paths.vault,'notes'),path=join(folder,'Personal.md')
  chmodSync(paths.vault,0o700);chmodSync(folder,0o700)
  renameSync(path,join(paths.home,'original-note-kept.md'))
  writeFileSync(path,'Independent synthetic replacement.',{mode:0o400})
  chmodSync(folder,0o500);chmodSync(paths.vault,0o500)
 })
 try{
  await expect(f.run()).rejects.toThrow(/rollback incomplete/)
  const path=join(f.vault,'notes','Personal.md')
  expect(readFileSync(path,'utf8')).toBe('Independent synthetic replacement.')
  expect(lstatSync(path).mode&0o777).toBe(0o400)
  expect(readFileSync(join(f.root,'original-note-kept.md'),'utf8')).toContain('lasting synthetic preference')
  expect(f.store.isOpen()).toBe(false)
  await expect(f.journal.rollback()).rejects.toThrow(/rollback incomplete/)
  expect(lstatSync(path).mode&0o777).toBe(0o400)
 }finally{f.close()}
})

it.each(['.obsidian/state.json','.git/synthetic-control'])('refuses a changed import-excluded source entry before publication: %s',async relative=>{
 const f=fixture(false,false,undefined,paths=>{
  const file=join(paths.vault,relative),mode=lstatSync(file).mode&0o7777
  chmodSync(file,0o600);writeFileSync(file,'Changed synthetic protected bytes');chmodSync(file,mode)
 })
 try{
  const file=join(f.vault,relative);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'Original synthetic protected bytes')
  await expect(f.run()).rejects.toThrow(/protected vault|source changed/i)
  expect(f.store.isOpen()).toBe(false)
 }finally{f.close()}
})
it('refuses a changed symlink identity while preserving its outside target',async()=>{
 const f=fixture(false,false,undefined,paths=>{
  const mode=lstatSync(paths.vault).mode&0o7777;chmodSync(paths.vault,0o700);rmSync(join(paths.vault,'alias'));symlinkSync(join(paths.home,'outside-b.md'),join(paths.vault,'alias'));chmodSync(paths.vault,mode)
 })
 try{
  writeFileSync(join(f.root,'outside-a.md'),'Outside synthetic A');writeFileSync(join(f.root,'outside-b.md'),'Outside synthetic B')
  symlinkSync(join(f.root,'outside-a.md'),join(f.vault,'alias'))
  await expect(f.run()).rejects.toThrow(/protected vault|source changed/i)
  expect(f.store.isOpen()).toBe(false);expect(readFileSync(join(f.root,'outside-b.md'),'utf8')).toBe('Outside synthetic B')
 }finally{f.close()}
})

it('recovers a durable worker publication whose reply was lost without restoring the old setup',async()=>{
 const f=fixture(),publish=f.brain.commitCutover
 f.brain.commitCutover=async hash=>{await publish(hash);throw new Error('Synthetic lost publication reply')}
 try{
  await expect(f.run()).rejects.toThrow(/lost publication reply/)
  expect(await f.brain.admission()).toMatchObject({committed:true,open:false})
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('running')
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  await f.journal.resumeCommitted();await f.journal.deliver()
  expect(await f.brain.admission()).toMatchObject({committed:true,open:true})
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('complete')
 }finally{f.close()}
})
it('keeps a genuine switch committed when reporting fails and retries only reporting',async()=>{
 let failed=true,reports=0,checks=0
 const f=fixture(false,false,undefined,()=>{checks++},async()=>{reports++;if(failed)throw new Error('Synthetic report unavailable')})
 try{
  await expect(f.run()).rejects.toThrow(/report unavailable/)
  expect(await f.brain.admission()).toMatchObject({committed:true,open:true})
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).delivered).not.toBe(true)
  failed=false;await f.journal.deliver();await f.journal.deliver()
  expect(checks).toBe(1);expect(reports).toBe(2)
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).delivered).toBe(true)
 }finally{f.close()}
})

it('a refused final authority decision rolls back with no worker receipt or admitted writes',async()=>{
 const f=fixture(false,false,undefined,undefined,undefined,async()=>{throw new Error('Synthetic peer closed before the decision')})
 try{
  await expect(f.run()).rejects.toThrow(/closed before the decision/)
  expect(await f.brain.admission()).toMatchObject({committed:false,open:false,receipt:null})
  expect(f.store.isOpen()).toBe(false);expect(f.restored()).toBe(true)
  expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault')
 }finally{f.close()}
})
it('cancellation during the yielding final source walk rolls back before any authority decision',async()=>{
 let finalGuards=0,decisions=0
 const f=fixture(false,false,undefined,undefined,undefined,async()=>{decisions++},()=>{
  const file=join(f.paths.journal,'journal.json')
  if(existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).phases.includes('installed-checks')&&++finalGuards===3)throw new Error('Synthetic cancellation during final walk')
 })
 try{
  await expect(f.run()).rejects.toThrow(/cancellation during final walk/)
  expect(decisions).toBe(0);expect(await f.brain.admission()).toMatchObject({committed:false,open:false,receipt:null})
  expect(f.restored()).toBe(true);expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault')
 }finally{f.close()}
})

it('restores the whole committed switch and exports every post-switch note except its exact synthetic check id',async()=>{
 const f=fixture()
 try{
  await f.run()
  const note=f.store.create({title:'Real later synthetic decision',kind:'fact',origin:'cutover-check',scope:'all',markdown:'An ordinary later decision; origin alone must not hide it.'},'synthetic-session')
  f.confirmReturn();await f.journal.rollback()
  expect(await f.brain.admission()).toMatchObject({committed:false,open:false,receipt:null})
  expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault')
  expect(lstatSync(f.paths.codexSkill).isDirectory()).toBe(true);expect(f.restored()).toBe(true)
  const changes=JSON.parse(readFileSync(join(f.paths.journal,'brain-changes.json'),'utf8'))
  expect(changes.some((v:{note:string})=>v.note===note.id)).toBe(true)
  expect(f.store.read(note.id).markdown).toContain('ordinary later decision')
  await f.journal.rollback()
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolled-back')
 }finally{f.close()}
})
it('holds the committed setup and timers if admission cannot be revoked before whole recovery',async()=>{
 const f=fixture()
 try{
  await f.run();f.brain.setWriteDoor=async()=>{throw new Error('Synthetic worker unavailable during revocation')}
  f.confirmReturn();await expect(f.journal.rollback()).rejects.toThrow(/unavailable during revocation/)
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  expect(lstatSync(f.vault).mode&0o222).toBe(0)
 }finally{f.close()}
})

it('preserves relative links in original skill backups and whole recovery',async()=>{
 const f=fixture()
 try{
  symlinkSync('./SKILL.md',join(f.paths.claudeSkill,'alias.md'))
  await f.run();f.confirmReturn();await f.journal.rollback()
  expect(readlinkSync(join(f.paths.claudeSkill,'alias.md'))).toBe('./SKILL.md')
  expect(readFileSync(join(f.paths.claudeSkill,'alias.md'),'utf8')).toBe('old vault skill')
 }finally{f.close()}
})

it.each([false,true])('adopts the switched brain through normal persistent own-skill maintenance and follows a later shipped update (setup=%s)',async setup=>{
 const f=fixture(),prior=process.env.HOME
 try{
  process.env.HOME=f.root
  if(setup)withDefaultsAdmission(()=>initializeDefaultsOwnership('synthetic-brain-adoption'))
  await f.run()
  // The existing normal installer requires its genuine receipt, with the same
  // pure status reader used by the production host; no synthetic complete flag.
  const state=join(f.root,'normal-state'),journal=join(state,'brain-cutover');mkdirSync(journal,{recursive:true})
  writeFileSync(join(journal,'journal.json'),readFileSync(join(f.paths.journal,'journal.json')))
  const status=await f.brain.admission();configureBrainReceiptReader(root=>root===state&&status.receipt?{...status.receipt,open:status.open}:null)
  const shipped=join(f.paths.shippedSkill,'..');writeFileSync(join(shipped,'manifest.json'),JSON.stringify({skills:['brain']}))
  writeFileSync(join(f.paths.shippedSkill,'SKILL.md'),'Updated synthetic BMN brain')
  const environment={HOME:f.root,BMN_STATE_HOME:state,BMN_SHIPPED_SKILLS:shipped}
  const result=installOwnSkills({source:join(f.paths.claudeSkill,'..'),environment})
  expect(result.rows.find((row:{name:string})=>row.name==='brain')?.state).toBe('updated')
  expect(readFileSync(join(ownCopiesRoot(environment),'brain','SKILL.md'),'utf8')).toBe('Updated synthetic BMN brain')
  const later=f.store.create({title:'Later synthetic decision',kind:'fact',origin:'synthetic',scope:'all',markdown:'Keep this decision after rollback.'},'synthetic-later')
  f.confirmReturn();await f.journal.rollback();await f.journal.rollback()
  expect(f.store.read(later.id).markdown).toBe('Keep this decision after rollback.')
  expect(JSON.parse(readFileSync(join(f.paths.journal,'brain-changes.json'),'utf8')).some((row:{note:string})=>row.note===later.id)).toBe(true)
  expect(readFileSync(join(f.paths.claudeSkill,'SKILL.md'),'utf8')).toBe('old vault skill')
  expect(lstatSync(f.paths.codexSkill).isDirectory()).toBe(true);expect(existsSync(f.paths.managedSkill)).toBe(false);expect(f.restored()).toBe(true)
 }finally{configureBrainReceiptReader(()=>null);if(prior===undefined)delete process.env.HOME;else process.env.HOME=prior;f.close()}
})

it.each([false,true])('selectively restores normal skill ownership and preserves unrelated records (setup=%s)',async setup=>{
 const f=fixture()
 try{
  if(setup)withDefaultsAdmission(()=>initializeDefaultsOwnership('synthetic-brain-rollback'))
  await f.run()
  const ownPath=join(f.root,'.config/bmn/agents/state/own-skills.json'),writtenPath=join(f.root,'.config/bmn/agents/state/rules/skills-written.json')
  const own=JSON.parse(readFileSync(ownPath,'utf8')),written=JSON.parse(readFileSync(writtenPath,'utf8'))
  const kept={path:join(f.root,'.claude/skills/independent'),copy:join(f.root,'.local/share/bmn/skills/independent'),at:new Date().toISOString()}
  const other=join(f.root,'.agents/skills/independent'),record={harness:'codex',skill:'independent',kind:'link',target:kept.path}
  if(setup){
   // Use normal witnessed metadata writes; do not forge setup provenance.
   // @ts-expect-error normal private metadata engine has no published declarations
   const {readSetupSkillRecords,writeSetupSkillRecords}=await import('../../bin/setup-skill-records.mjs')
   withDefaultsAdmission(()=>{
    let journal=readDefaultsOwnership('synthetic-brain-rollback'),prior=readSetupSkillRecords(journal,'own-skills');prior.value.skills.independent=kept
    writeSetupSkillRecords(journal,'own-skills',prior,prior.value,{folder:f.paths.journal})
    journal=readDefaultsOwnership('synthetic-brain-rollback');prior=readSetupSkillRecords(journal,'skills-written');prior.value[other]=record
    writeSetupSkillRecords(journal,'skills-written',prior,prior.value,{folder:f.paths.journal})
   })
  }else{own.skills.independent=kept;written[other]=record;writeFileSync(ownPath,JSON.stringify(own));writeFileSync(writtenPath,JSON.stringify(written))}
  f.confirmReturn();await f.journal.rollback();await f.journal.rollback()
  const after=JSON.parse(readFileSync(ownPath,'utf8')),afterWritten=JSON.parse(readFileSync(writtenPath,'utf8'))
  expect(after.skills.brain).toBeUndefined();expect(after.removed.brain).toBeUndefined();expect(after.skills.independent).toEqual(kept)
  expect(afterWritten[f.paths.codexSkill]).toBeUndefined();expect(afterWritten[other]).toEqual(record)
  expect(readFileSync(join(f.paths.claudeSkill,'SKILL.md'),'utf8')).toBe('old vault skill');expect(lstatSync(f.paths.codexSkill).isDirectory()).toBe(true)
  expect(existsSync(f.paths.managedSkill)).toBe(false);expect(f.restored()).toBe(true)
  if(setup)expect(Object.values(readDefaultsOwnership('synthetic-brain-rollback').snapshot().entries).some(row=>(row as {target:{entry:string}}).target.entry==='brain')).toBe(false)
 }finally{f.close()}
})
it.each([true,false])('reuses only the existing exact Codex link and metadata (matches=%s)',async matches=>{
 const f=fixture()
 try{
  const {paths}=f
  rmSync(paths.codexSkill,{recursive:true});symlinkSync(matches?paths.claudeSkill:paths.shippedSkill,paths.codexSkill)
  const link=lstatSync(paths.codexSkill)
  const writtenPath=join(f.root,'.config/bmn/agents/state/rules/skills-written.json')
  mkdirSync(join(writtenPath,'..'),{recursive:true})
  const written=JSON.stringify({[paths.codexSkill]:{harness:'codex',skill:'brain',kind:'link',target:paths.claudeSkill}})
  writeFileSync(writtenPath,written)
  if(matches){
   await f.run()
   expect(readFileSync(join(paths.codexSkill,'SKILL.md'),'utf8')).toBe('bmn brain')
   f.confirmReturn();await f.journal.rollback();await f.journal.rollback()
   expect(readFileSync(join(paths.codexSkill,'SKILL.md'),'utf8')).toBe('old vault skill')
  }else{
   await expect(f.run()).rejects.toThrow(/ownership conflict/)
   expect(await f.brain.admission()).toMatchObject({committed:false,open:false})
  }
  expect(lstatSync(paths.codexSkill).ino).toBe(link.ino)
  expect(readFileSync(writtenPath,'utf8')).toBe(written)
 }finally{f.close()}
})

it('preserves an existing owner brain opt-out before switching any original file',async()=>{
 const f=fixture()
 try{
  const path=join(f.root,'.config/bmn/agents/state/own-skills.json');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify({version:1,skills:{},removed:{brain:new Date().toISOString()}}))
  const prior=readFileSync(path,'utf8')
  await expect(f.run()).rejects.toThrow(/opt-out/)
  expect(readFileSync(path,'utf8')).toBe(prior);expect(readFileSync(f.paths.master,'utf8')).toContain('Old vault');expect(lstatSync(f.paths.claudeSkill).isDirectory()).toBe(true)
  expect(await f.brain.admission()).toMatchObject({committed:false,open:false})
 }finally{f.close()}
})

it('refuses generic plan/apply Undo for every setup skill component of the whole switch',async()=>{
 const f=fixture()
 try{
  withDefaultsAdmission(()=>initializeDefaultsOwnership('synthetic-brain-undo'))
  await f.run()
  const saved=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8'))
  const {restoreTransaction}=await import('../../bin/agents-rules.mjs')
  // @ts-expect-error normal private skill engine has no published declarations
  const {retireSetupSkill}=await import('../../bin/setup-skill-defaults.mjs')
  expect(saved.skills.installations).toHaveLength(3)
  for(const row of saved.skills.installations){
   expect(await restoreTransaction(row.transaction,{planOnly:true})).toMatchObject({code:'CUTOVER_RECOVERY_REQUIRED'})
   expect(await restoreTransaction(row.transaction,{yes:true,asJson:true})).toMatchObject({code:'CUTOVER_RECOVERY_REQUIRED'})
   expect(retireSetupSkill(row.target,{setupId:'synthetic-brain-undo'})).toMatchObject({code:'CUTOVER_RECOVERY_REQUIRED'})
  }
  expect(await f.brain.admission()).toMatchObject({committed:true,open:true})
  f.confirmReturn();await f.journal.rollback();expect(f.restored()).toBe(true)
 }finally{f.close()}
})
it('holds all original paths when setup ownership is unresolved or the owner opted it out',async()=>{
 const f=fixture()
 try{
  withDefaultsAdmission(()=>initializeDefaultsOwnership('synthetic-brain-opt-out'))
  await f.run()
  const state=readDefaultsOwnership('synthetic-brain-opt-out').snapshot(),source=Object.values(state.entries).find(row=>(row as {target:{path:string}}).target.path===f.paths.claudeSkill) as {target:unknown;transaction:string;current:{fingerprint:unknown}}
  // The normal journal records the opt-out; source removal may be admitted while its backing stays retained.
  withDefaultsAdmission(()=>readDefaultsOwnership('synthetic-brain-opt-out').beginUndo(source.target,source.transaction,source.current.fingerprint))
  f.confirmReturn();await expect(f.journal.rollback()).rejects.toThrow(/rollback incomplete.*(?:ownership|provenance)/i)
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(lstatSync(f.vault).mode&0o222).toBe(0);expect(f.restored()).toBe(false)
  const after=Object.values(readDefaultsOwnership('synthetic-brain-opt-out').snapshot().entries).find(row=>(row as {target:{path:string}}).target.path===f.paths.claudeSkill) as {optOut:boolean}
  expect(after.optOut).toBe(true);expect(await f.brain.admission()).toMatchObject({committed:false,open:false})
 }finally{f.close()}
})
it('returns post-switch notes to Obsidian as new Markdown in the inbox, keeping the vault original and a retry idempotent',async()=>{
 const f=fixture()
 try{
  await f.run()
  const added=f.store.create({title:'Нове рішення after switch',kind:'decision',origin:'synthetic',scope:'all',markdown:'# New\nWritten in BMN after the switch.\n'},'synthetic-session')
  const imported=f.store.list().find(note=>note.import_source)!
  const edited=f.store.edit(imported.id,imported.revision,{title:imported.title,kind:imported.kind,origin:imported.origin,scope:imported.scope,markdown:'# Personal\nEdited in BMN.\n'},'synthetic-session')
  const original=readFileSync(join(f.vault,'notes','Personal.md'),'utf8')
  f.confirmReturn();await f.journal.rollback()
  const saved=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8'))
  expect(saved.state).toBe('rolled-back')
  const folder=saved.returnFolder as string
  expect(folder.startsWith(join(f.vault,'inbox','from-bmn-brain-'))).toBe(true)
  const names=readdirSync(folder).filter(name=>name.endsWith('.md')).sort()
  expect(names).toHaveLength(3)
  const bodies=names.map(name=>readFileSync(join(folder,name),'utf8'))
  expect(bodies.some(body=>body.includes('bmn_brain_id: "'+added.id+'"')&&body.endsWith('# New\nWritten in BMN after the switch.\n'))).toBe(true)
  expect(bodies.some(body=>body.includes('bmn_brain_id: "'+edited.id+'"')&&body.includes('edits_vault_note: ')&&body.endsWith('Edited in BMN.\n'))).toBe(true)
  expect(bodies.some(body=>body.includes('cutover-check'))).toBe(false)
  expect(readFileSync(join(f.vault,'notes','Personal.md'),'utf8')).toBe(original)
  expect(lstatSync(join(f.vault,'notes')).mode&0o200).toBe(0o200)
  const before=readdirSync(folder).map(name=>[name,readFileSync(join(folder,name),'utf8')])
  await f.journal.rollback()
  expect(readdirSync(join(f.vault,'inbox'))).toEqual([folder.split('/').pop()])
  expect(readdirSync(folder).map(name=>[name,readFileSync(join(folder,name),'utf8')])).toEqual(before)
 }finally{f.close()}
})
it('holds the return when its inbox folder was changed by someone else, and never overwrites it',async()=>{
 const f=fixture()
 try{
  const vaultMode=lstatSync(f.vault).mode&0o7777
  await f.run()
  f.store.create({title:'Later',kind:'fact',origin:'synthetic',scope:'all',markdown:'Later.\n'},'synthetic-session')
  const cutoverId=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).cutoverId as string
  const {brainReturnFolderName}=await import('./brain-return')
  const target=join(f.vault,'inbox',brainReturnFolderName(cutoverId))
  chmodSync(f.vault,vaultMode);mkdirSync(target,{recursive:true});writeFileSync(join(target,'foreign.md'),'Foreign text.\n');chmodSync(f.vault,vaultMode&~0o222)
  f.confirmReturn();await expect(f.journal.rollback()).rejects.toThrow(/rollback incomplete.*differs from its manifest/i)
  expect(readFileSync(join(target,'foreign.md'),'utf8')).toBe('Foreign text.\n')
  expect(JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8')).state).toBe('rolling-back')
  // A failed publish restores nothing: the vault stays held, the new rules and held timers stay, BMN refuses writes.
  expect(lstatSync(f.vault).mode&0o222).toBe(0);expect(lstatSync(join(f.vault,'notes')).mode&0o222).toBe(0)
  expect(()=>writeFileSync(join(f.vault,'notes','stale.md'),'no')).toThrow()
  expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  expect(()=>f.store.create({title:'Stale',kind:'fact',origin:'synthetic',scope:'all',markdown:'Stale.\n'},'synthetic-session')).toThrow()
 }finally{f.close()}
})
it('resumes an interrupted return after the notes were published without duplicating or losing them',async()=>{
 const f=fixture()
 try{
  await f.run()
  const added=f.store.create({title:'Interrupted return note',kind:'fact',origin:'synthetic',scope:'all',markdown:'Survives an interrupted return.\n'},'synthetic-session')
  const operations=(f.journal as unknown as {operations:{restoreTimers:(...args:unknown[])=>Promise<void>}}).operations,restore=operations.restoreTimers
  operations.restoreTimers=async()=>{throw new Error('synthetic interruption')}
  f.confirmReturn();await expect(f.journal.rollback()).rejects.toThrow(/rollback incomplete.*synthetic interruption/)
  const held=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8'))
  expect(held.state).toBe('rolling-back')
  expect(f.store.read(added.id).markdown).toBe('Survives an interrupted return.\n')
  const folder=held.returnFolder as string,first=readdirSync(folder).sort()
  operations.restoreTimers=restore
  await f.journal.rollback()
  const done=JSON.parse(readFileSync(join(f.paths.journal,'journal.json'),'utf8'))
  expect(done.state).toBe('rolled-back');expect(done.returnFolder).toBe(folder);expect(f.restored()).toBe(true)
  expect(readdirSync(join(f.vault,'inbox'))).toHaveLength(1);expect(readdirSync(folder).sort()).toEqual(first)
  expect(first.filter(name=>name.endsWith('.md')).map(name=>readFileSync(join(folder,name),'utf8')).filter(body=>body.includes(added.id))).toHaveLength(1)
 }finally{f.close()}
})
it('holds a completed switch when a return was not confirmed, whatever the journal says',async()=>{
 const f=fixture()
 try{
  await f.run()
  const journalPath=join(f.paths.journal,'journal.json'),saved=JSON.parse(readFileSync(journalPath,'utf8'))
  await expect(f.journal.rollback()).rejects.toThrow(/no confirmed return/)
  expect(f.store.isOpen()).toBe(true);expect(readFileSync(f.paths.master,'utf8')).toBe('bmn brain\n');expect(f.restored()).toBe(false)
  // A journal edited to look mid-return still matches the receipt, so only the worker's return record may start one.
  writeFileSync(journalPath,JSON.stringify({...saved,state:'rolling-back'}))
  const edited=new BrainCutoverJournal(f.paths,(f.journal as unknown as {operations:ConstructorParameters<typeof BrainCutoverJournal>[1]}).operations,undefined,undefined,JSON.parse(readFileSync(journalPath,'utf8')))
  expect(await f.brain.admission()).toMatchObject({committed:true})
  await expect(edited.rollback()).rejects.toThrow(/no confirmed return/)
  expect(f.store.isOpen()).toBe(true);expect(lstatSync(f.vault).mode&0o222).toBe(0)
 }finally{f.close()}
})
