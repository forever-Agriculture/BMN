// MODULE: brain-cutover-lifecycle.test.ts - Exercise real event names against a consumed window grant
import {EventEmitter} from 'node:events'
import {it,expect} from 'vitest'
import {BrainCutoverAuthorization,assertBrainCutoverPermit} from './brain-cutover-authorization'
import {bindBrainCutoverWindow} from './brain-cutover-lifecycle'
it('revokes consent on main navigation, renderer failure or window destruction',async()=>{
 for(const event of ['did-start-navigation','render-process-gone','destroyed','closed']) {
  const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>true,decide:async(_peer,_hash,accept)=>accept(),proveBuild:async()=>{},now:()=>0})
  const window=Object.assign(new EventEmitter(),{webContents:new EventEmitter()})
  bindBrainCutoverWindow(window as unknown as Parameters<typeof bindBrainCutoverWindow>[0],()=>auth.invalidate())
  await auth.begin();const permit=await auth.consume({pid:42,uid:1000,ticks:'123',connection:'c'.repeat(32),invocation:'a'.repeat(32)})
  window.webContents.emit('did-start-navigation',{},'about:blank',false,false);assertBrainCutoverPermit(permit)
  if(event==='closed')window.emit(event)
  else window.webContents.emit(event,{},'file:///synthetic',false,true)
  expect(()=>assertBrainCutoverPermit(permit)).toThrow()
 }
})
