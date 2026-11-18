// MODULE: brain-cutover-files.test.ts - Actual Linux atomic restore transport and race/ancestry refusals
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,symlinkSync,rmSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {brainAtomicRename} from './brain-cutover-files'
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-atomic-files-')),source=join(root,'stage'),target=join(root,'target')
 const move=brainAtomicRename(join(import.meta.dirname,'../../bin'))
 const identity=(path:string)=>{const stat=lstatSync(path);return {dev:stat.dev,ino:stat.ino}}
 return {root,source,target,move,identity,close(){rmSync(root,{recursive:true,force:true})}}
}
it('exchanges complete nonempty directory and symlink entries without removing either, and refuses replay',()=>{
 const f=fixture();try{
  mkdirSync(f.source);writeFileSync(join(f.source,'SKILL.md'),'Original synthetic skill');symlinkSync('synthetic-owned-link',f.target)
  const request={operation:'exchange' as const,source:f.source,target:f.target,sourceIdentity:f.identity(f.source),targetIdentity:f.identity(f.target)}
  f.move(request);expect(readFileSync(join(f.target,'SKILL.md'),'utf8')).toBe('Original synthetic skill');expect(lstatSync(f.source).isSymbolicLink()).toBe(true)
  expect(()=>f.move(request)).toThrow(/identity changed/);expect(readFileSync(join(f.target,'SKILL.md'),'utf8')).toBe('Original synthetic skill')
 }finally{f.close()}
})
it('refuses a target inode swapped after Node validation and preserves both independently replaced entries',()=>{
 const f=fixture();try{
  writeFileSync(f.source,'Original synthetic rules');writeFileSync(f.target,'Owned switched rules')
  const request={operation:'exchange' as const,source:f.source,target:f.target,sourceIdentity:f.identity(f.source),targetIdentity:f.identity(f.target)}
  renameSync(f.target,join(f.root,'kept-owned'));writeFileSync(f.target,'Independent synthetic edit',{mode:0o400})
  expect(()=>f.move(request)).toThrow(/identity changed/)
  expect(readFileSync(f.target,'utf8')).toBe('Independent synthetic edit');expect(lstatSync(f.target).mode&0o777).toBe(0o400)
  expect(readFileSync(f.source,'utf8')).toBe('Original synthetic rules');expect(readFileSync(join(f.root,'kept-owned'),'utf8')).toBe('Owned switched rules')
 }finally{f.close()}
})
it('installs only into an absent destination and never overwrites an entry that appeared there',()=>{
 const f=fixture();try{
  writeFileSync(f.source,'Original synthetic rules');writeFileSync(f.target,'Independent appeared entry')
  const request={operation:'no-replace' as const,source:f.source,target:f.target,sourceIdentity:f.identity(f.source),targetIdentity:null}
  expect(()=>f.move(request)).toThrow(/identity changed/);expect(readFileSync(f.target,'utf8')).toBe('Independent appeared entry')
  f.move({...request,target:join(f.root,'absent')});expect(readFileSync(join(f.root,'absent'),'utf8')).toBe('Original synthetic rules')
 }finally{f.close()}
})
it('refuses symlink ancestors and a missing installed helper without a fallback',()=>{
 const f=fixture();try{
  writeFileSync(f.source,'Original synthetic rules');mkdirSync(join(f.root,'outside'));writeFileSync(join(f.root,'outside','target'),'Independent outside entry');symlinkSync(join(f.root,'outside'),join(f.root,'alias'))
  expect(()=>f.move({operation:'exchange',source:f.source,target:join(f.root,'alias','target'),sourceIdentity:f.identity(f.source),targetIdentity:f.identity(join(f.root,'outside','target'))})).toThrow(/Atomic brain restore refused/)
  expect(readFileSync(join(f.root,'outside','target'),'utf8')).toBe('Independent outside entry')
  expect(()=>brainAtomicRename(join(f.root,'missing'))({operation:'no-replace',source:f.source,target:f.target,sourceIdentity:f.identity(f.source),targetIdentity:null})).toThrow()
  expect(readFileSync(f.source,'utf8')).toBe('Original synthetic rules')
 }finally{f.close()}
})
