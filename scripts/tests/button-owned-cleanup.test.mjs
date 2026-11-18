// MODULE: button-owned-cleanup.test.mjs - Actual catalogue cleanup preserves the UI error and outside data
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {captureButtonScreens} from '../test/button-screens.mjs'
import {makeOwnedDirectoriesWritable} from '../lib/owned-directories.mjs'

it.each(['window','launch'])('cleans readonly exports at the real catalogue use site after a %s error',async stage=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-button-owned-')),outside=mkdtempSync(join(tmpdir(),'bmn-button-outside-')),stat=lstatSync(parent)
 let closed=false
 try{
  writeFileSync(join(outside,'canary.txt'),'keep outside');chmodSync(outside,0o555)
  await expect(captureButtonScreens({directory:join(parent,'captures'),fixtureParent:parent,fixtureFolder:join(parent,'synthetic-project'),appDirectory:resolve('apps/desktop'),phase:()=>{},
   launch:async roots=>{
    const generated=join(roots.data,'bmn/brain-export/generation');mkdirSync(generated,{recursive:true});writeFileSync(join(generated,'note.md'),'synthetic',{mode:0o444});chmodSync(generated,0o555)
    symlinkSync(outside,join(parent,'button-pass/outside-link'))
    if(stage==='launch')throw new Error('original synthetic UI failure')
    return {firstWindow:async()=>{throw new Error('original synthetic UI failure')}}
   },close:async()=>{closed=true}
  })).rejects.toThrow('original synthetic UI failure')
  expect(closed).toBe(stage==='window');expect(existsSync(join(parent,'button-pass'))).toBe(false)
  expect(lstatSync(outside).mode&0o777).toBe(0o555);expect(readFileSync(join(outside,'canary.txt'),'utf8')).toBe('keep outside')
 }finally{
  makeOwnedDirectoriesWritable(parent,{device:stat.dev,inode:stat.ino});rmSync(parent,{recursive:true,force:true});chmodSync(outside,0o700);rmSync(outside,{recursive:true,force:true})
 }
})

it('keeps an existing fixed fixture root instead of deleting its independent contents',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-button-existing-')),base=join(parent,'button-pass');let launched=false
 try{
  mkdirSync(base);writeFileSync(join(base,'independent.txt'),'keep independent')
  await expect(captureButtonScreens({directory:join(parent,'captures'),fixtureParent:parent,fixtureFolder:join(parent,'synthetic-project'),appDirectory:resolve('apps/desktop'),phase:()=>{},launch:async()=>{launched=true;throw new Error('must not launch')}})).rejects.toThrow(/EEXIST/)
  expect(launched).toBe(false);expect(readFileSync(join(base,'independent.txt'),'utf8')).toBe('keep independent')
 }finally{rmSync(parent,{recursive:true,force:true})}
})
