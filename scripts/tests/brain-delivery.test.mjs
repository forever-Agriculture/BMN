// MODULE: brain-delivery.test.mjs - Later builds contain the first brain delivery, proven by actual Git
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect,vi} from 'vitest'
import {brainDeliveryCommit,brainContainsDelivery} from '../lib/brain-provenance.mjs'
import {prepareBrainDelivery,brainUpdateNotice} from '../install/update-desktop.mjs'
it.each(['direct','integration merge'])('keeps full-feature delivery through later builds and refuses schema-only/foreign builds (%s)',shape=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-delivery-git-')),state=join(root,'state')
 const git=(...args)=>{
  const result=spawnSync('/usr/bin/git',['-C',root,'-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}})
  if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim()
 }
 try{
  git('init','--quiet','--initial-branch=main');git('commit','--allow-empty','--no-gpg-sign','-qm','Before brain');const before=git('rev-parse','HEAD')
  mkdirSync(join(root,'apps/desktop/src/utility'),{recursive:true});writeFileSync(join(root,'apps/desktop/src/utility/brain-schema.ts'),'// synthetic schema\n');git('add','.');git('commit','--no-gpg-sign','-qm','Schema only');const partial=git('rev-parse','HEAD')
  if(shape==='integration merge')git('checkout','--quiet','-b','epic-synthetic')
  mkdirSync(join(root,'skills/brain'),{recursive:true});writeFileSync(join(root,'skills/brain/delivery.json'),JSON.stringify({version:1,epic:126,feature:'brain-store-and-owner-held-cutover'})+'\n')
  git('add','.');git('commit','--no-gpg-sign','-qm','Complete brain feature')
  if(shape==='integration merge'){git('checkout','--quiet','main');git('commit','--allow-empty','--no-gpg-sign','-qm','Other main work');git('merge','--quiet','--no-ff','--no-gpg-sign','-m','Integrate complete brain feature','epic-synthetic')}
  const delivered=git('rev-parse','HEAD')
  git('commit','--allow-empty','--no-gpg-sign','-qm','Later update');const later=git('rev-parse','HEAD')
  expect(brainDeliveryCommit(root,later)).toBe(delivered);expect(brainContainsDelivery(root,delivered,later)).toBe(true);expect(brainContainsDelivery(root,delivered,before)).toBe(false)
  expect(()=>brainDeliveryCommit(root,before)).toThrow(/cannot be established/)
  expect(()=>brainDeliveryCommit(root,partial)).toThrow(/cannot be established/)
  const install=vi.fn();expect(prepareBrainDelivery({project:root,commit:later,state,install})).toBe(delivered)
  expect(JSON.parse(readFileSync(join(state,'brain-delivery.json'),'utf8')).commit).toBe(delivered)
  expect(install).toHaveBeenCalledWith({sourceRoot:root,resources:join(root,'apps/desktop/release/linux-unpacked/resources')})
  git('worktree','add','--quiet','--detach',join(root,'linked'),later)
  expect(()=>prepareBrainDelivery({project:join(root,'linked'),commit:later,state,install})).toThrow(/canonical/)
  writeFileSync(join(state,'brain-delivery.json'),JSON.stringify({version:1,epic:126,commit:before}))
  expect(()=>prepareBrainDelivery({project:root,commit:later,state,install})).toThrow(/identity changed/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it('keeps first-install palette guidance and makes no false unchanged claim after a recorded switch',()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-update-notice-'))
 try{
  expect(brainUpdateNotice('a'.repeat(40),root)).toContain('The brain is installed; nothing has switched. Use “Switch to the BMN brain…” in the command palette.')
  mkdirSync(join(root,'brain-cutover'))
  for(const state of ['running','complete','rolled-back']){
   writeFileSync(join(root,'brain-cutover','journal.json'),JSON.stringify({state}))
   const message=brainUpdateNotice('b'.repeat(40),root)
   expect(message).toContain('check the brain’s current state')
   expect(message).not.toContain('nothing has switched')
  }
 }finally{rmSync(root,{recursive:true,force:true})}
})
