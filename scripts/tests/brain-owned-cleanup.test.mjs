// MODULE: brain-owned-cleanup.test.mjs - Readonly exports clean up without touching foreign roots
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,chmodSync,rmSync,renameSync,symlinkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {createTemporaryRoot} from '../lib/temporary-root.mjs'
it('removes readonly generated directories while preserving an outside symlink target',()=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-cleanup-contract-')),outside=join(parent,'outside')
 const fixture=createTemporaryRoot({prefix:'owned-',directories:[]},parent,join(parent,'no-claude'))
 const exported=join(fixture.root,'brain-export')
 try{
  mkdirSync(outside);writeFileSync(join(outside,'note.md'),'outside');chmodSync(outside,0o555)
  mkdirSync(exported);writeFileSync(join(exported,'note.md'),'synthetic',{mode:0o444});chmodSync(exported,0o555)
  symlinkSync(outside,join(fixture.root,'foreign-link'))
  expect(()=>fixture.cleanup()).not.toThrow()
  expect(existsSync(fixture.root)).toBe(false);expect(lstatSync(outside).mode&0o777).toBe(0o555);expect(readFileSync(join(outside,'note.md'),'utf8')).toBe('outside')
 }finally{if(existsSync(exported))chmodSync(exported,0o700);chmodSync(outside,0o700);rmSync(parent,{recursive:true,force:true})}
})
it('preserves a replacement root instead of deleting it by its reused pathname',()=>{
 const parent=mkdtempSync(join(tmpdir(),'bmn-cleanup-replaced-')),fixture=createTemporaryRoot({prefix:'owned-',directories:[]},parent,join(parent,'no-claude')),moved=join(parent,'moved')
 try{
  renameSync(fixture.root,moved);mkdirSync(fixture.root);writeFileSync(join(fixture.root,'foreign.md'),'independent')
  expect(()=>fixture.cleanup()).toThrow(/identity|owned|changed/)
  expect(readFileSync(join(fixture.root,'foreign.md'),'utf8')).toBe('independent')
 }finally{rmSync(parent,{recursive:true,force:true})}
})
