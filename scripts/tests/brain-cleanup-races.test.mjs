// MODULE: brain-cleanup-races.test.mjs - Swap the public fixture paths after validation at real teardown call sites
import {spawnSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync,chmodSync,lstatSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
const temporary=new URL('../lib/temporary-root.mjs',import.meta.url).href,qa=new URL('../test/brain-qa-fixture.mjs',import.meta.url).href
function run(kind){
 const parent=mkdtempSync(join(tmpdir(),'bmn-cleanup-race-')),preload=join(parent,'fault.cjs')
 writeFileSync(preload,`
const fs=require('node:fs'),path=require('node:path'),kind=process.env.BMN126_CLEANUP_POINT
let fired=false
const swap=()=>{
 const root=process.env.BMN126_CLEANUP_ROOT;if(fired||!root)return false;fired=true
 if(fs.existsSync(root))fs.renameSync(root,root+'-kept')
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'foreign.md'),'Independent bytes');fs.chmodSync(root,kind==='mode'?0o500:0o700)
 return true
}
const remove=fs.rmSync;fs.rmSync=(target,options)=>{if(kind==='delete'&&options?.recursive)swap();return remove(target,options)}
const chmod=fs.chmodSync;fs.chmodSync=(target,...args)=>{if(kind==='mode'&&target===process.env.BMN126_CLEANUP_ROOT)swap();return chmod(target,...args)}
const fchmod=fs.fchmodSync;fs.fchmodSync=(fd,...args)=>{if(kind==='mode'&&fs.readlinkSync('/proc/self/fd/'+fd)===process.env.BMN126_CLEANUP_ROOT)swap();return fchmod(fd,...args)}
const rename=fs.renameSync;fs.renameSync=(source,target,...args)=>{
 if(kind==='quarantine'&&source===process.env.BMN126_CLEANUP_ROOT&&path.basename(path.dirname(target)).startsWith('.bmn-cleanup-')&&swap())fs.writeFileSync(path.join(process.env.BMN126_CLEANUP_PARENT,'moved.json'),JSON.stringify({target}))
 return rename(source,target,...args)
}
require('node:module').syncBuiltinESMExports()
`)
 const common=`import {mkdirSync,writeFileSync,readFileSync,lstatSync,chmodSync} from 'node:fs';import {join} from 'node:path';const parent=process.env.BMN126_CLEANUP_PARENT;`
 const body=kind==='mode'?common+`
import {createHash} from 'node:crypto';import {releaseBrainQaFixture} from ${JSON.stringify(qa)};
const root=join(parent,'workload'),run=join(parent,'evidence'),backup=join(root,'data/bmn/brain-backups'),runId='synthetic-swap';
mkdirSync(backup,{recursive:true});mkdirSync(join(run,'bench'),{recursive:true});writeFileSync(join(root,'.bmn-qa-run'),runId);
const seed=JSON.stringify({kind:'brain-v1'});writeFileSync(join(run,'bench/seed.json'),seed);
const hash=b=>createHash('sha256').update(b).digest('hex'),stat=lstatSync(backup);
const config={root,run,runId,packaged:false,qaInput:{runId,fixture:{seedSha256:hash(seed),adapterSha256:hash(readFileSync(new URL(${JSON.stringify(qa)})))}}};
writeFileSync(join(run,'bench/brain-seed-install.json'),JSON.stringify({runId,backup:{path:backup,device:stat.dev,inode:stat.ino,priorMode:0o700}}));chmodSync(backup,0o500);
process.env.BMN126_CLEANUP_ROOT=backup;let error=null;try{releaseBrainQaFixture(config)}catch(e){error=e.message};console.log(JSON.stringify({error,root:backup,mode:lstatSync(backup).mode&0o777}));
`:common+`
import {createTemporaryRoot} from ${JSON.stringify(temporary)};
const fixture=createTemporaryRoot({prefix:'owned-',directories:[]},parent,join(parent,'no-claude'));writeFileSync(join(fixture.root,'owned.md'),'Owned disposable bytes');
process.env.BMN126_CLEANUP_ROOT=fixture.root;let error=null;try{fixture.cleanup()}catch(e){error=e.message};console.log(JSON.stringify({error,root:fixture.root}));
`
 const result=spawnSync(process.execPath,['--require',preload,'--input-type=module','--eval',body],{env:{...process.env,BMN126_CLEANUP_POINT:kind,BMN126_CLEANUP_PARENT:parent},encoding:'utf8',timeout:10_000})
 return {parent,result,close(){for(const row of readdirSync(parent,{recursive:true,withFileTypes:true}))if(row.isDirectory())chmodSync(join(row.parentPath,row.name),0o700);rmSync(parent,{recursive:true,force:true})}}
}
it.skipIf(process.platform!=='linux')('preserves a public-path replacement introduced after validation immediately before removal',()=>{
 const f=run('delete');try{
  expect(f.result.status,f.result.stderr).toBe(0);const value=JSON.parse(f.result.stdout);expect(value.error).toBeNull()
  expect(readFileSync(join(value.root,'foreign.md'),'utf8')).toBe('Independent bytes');expect(lstatSync(value.root).mode&0o777).toBe(0o700)
 }finally{f.close()}
})
it.skipIf(process.platform!=='linux')('restores fixture modes on the pinned inode and preserves a replacement introduced just before chmod',()=>{
 const f=run('mode');try{
  expect(f.result.status,f.result.stderr).toBe(0);const value=JSON.parse(f.result.stdout);expect(value.error).toMatch(/identity|changed/)
  expect(value.mode).toBe(0o500);expect(readFileSync(join(value.root,'foreign.md'),'utf8')).toBe('Independent bytes');expect(lstatSync(value.root+'-kept').mode&0o777).toBe(0o700)
 }finally{f.close()}
})
it.skipIf(process.platform!=='linux')('retains a mismatched entry moved during quarantine without changing or deleting it',()=>{
 const f=run('quarantine');try{
  expect(f.result.status,f.result.stderr).toBe(0);const value=JSON.parse(f.result.stdout);expect(value.error).toMatch(/retained/)
  const moved=JSON.parse(readFileSync(join(f.parent,'moved.json'),'utf8'));expect(value.error).toContain(moved.target)
  expect(readFileSync(join(moved.target,'foreign.md'),'utf8')).toBe('Independent bytes');expect(readFileSync(join(value.root+'-kept','owned.md'),'utf8')).toBe('Owned disposable bytes')
 }finally{f.close()}
})
