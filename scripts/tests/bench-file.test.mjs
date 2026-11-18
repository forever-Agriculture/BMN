// MODULE: bench-file.test.mjs - full trace integrity across chunks without a whole-file string
import {createHash} from 'node:crypto'
import {closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe,expect,it} from 'vitest'
import {fileDigest} from '../qa/bench-file.mjs'
import {terminalTraceEvidence,terminalTraceFileEvidence} from '../qa/bench-state.mjs'
const trace='11 clone() = 12\n12 write(1, "synthetic é →", 10) = 10\n11 +++ exited with 0 +++\n12 +++ exited with 0 +++\n'
const fixture=fn=>{const root=mkdtempSync(join(tmpdir(),'bmn-130-trace-unit-')),path=join(root,'trace');try{return fn(path,root)}finally{rmSync(root,{recursive:true,force:true})}}
describe('streamed QA evidence',()=>{
 it.each([1,7,64,65536])('keeps identical ancestry, terminal states and complete hashes across %i-byte chunks',chunkBytes=>fixture(path=>{
  for(const text of [trace,trace.replace('12 +++ exited with 0 +++\n',''),trace+'strace: Process 12 detached\n',trace+'13 +++ exited with 0 +++\n',trace+'12 +++ exited with 0 +++\n']){
   writeFileSync(path,text);const fd=openSync(path,'r');let actual
   try{actual=terminalTraceFileEvidence(fd,11,chunkBytes)}finally{closeSync(fd)}
   const {bytes,sha256,...terminal}=actual
   expect(terminal).toEqual(terminalTraceEvidence(text,11))
   expect(bytes).toBe(Buffer.byteLength(text));expect(sha256).toBe(createHash('sha256').update(text).digest('hex'))
  }
 }))
 it('hashes every byte and refuses a symlink as evidence',()=>fixture((path,root)=>{
  writeFileSync(path,trace);expect(fileDigest(path)).toEqual({bytes:Buffer.byteLength(trace),sha256:createHash('sha256').update(trace).digest('hex')})
  symlinkSync(path,join(root,'link'));expect(()=>fileDigest(join(root,'link'))).toThrow()
 }))
 it('fails closed on a trace line above the bounded parser size',()=>fixture(path=>{
  writeFileSync(path,'11 '+ 'x'.repeat(1024*1024));const fd=openSync(path,'r')
  try{expect(()=>terminalTraceFileEvidence(fd,11)).toThrow(/line exceeds/)}finally{closeSync(fd)}
 }))
})

it('refuses an oversized sparse trace before hashing or parsing it',()=>fixture(path=>{
 const fd=openSync(path,'w+');ftruncateSync(fd,1024**3+1)
 try{expect(()=>terminalTraceFileEvidence(fd,11)).toThrow(/1GiB/);expect(()=>fileDigest(path)).toThrow(/1GiB/)}finally{closeSync(fd)}
}))
