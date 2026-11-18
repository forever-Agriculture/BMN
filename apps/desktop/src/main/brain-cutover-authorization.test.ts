// MODULE: brain-cutover-authorization.test.ts - Fail-closed one-use window grants
import {describe,it,expect} from 'vitest'
import {assertBrainCutoverPermit,BrainCutoverAuthorization,type CutoverPeer} from './brain-cutover-authorization'
const peer:CutoverPeer={pid:42,uid:1000,ticks:'123',connection:'c'.repeat(32),invocation:'a'.repeat(32)}
function fixture(){let time=0,proof=true,caller=true,confirms=0,starts=0;const auth=new BrainCutoverAuthorization({confirm:async()=>{confirms++;return true},start:async()=>{starts++},attest:async()=>caller,decide:async(_peer,_hash,accept)=>accept(),proveBuild:async()=>{if(!proof)throw new Error('Build is not complete')},now:()=>time});return {auth,setTime(n:number){time=n},badBuild(){proof=false},badCaller(){caller=false},counts:()=>({confirms,starts})}}
describe('owner-held brain switch',()=>{
 it('refuses forged records, direct starts, used consent and new-process replay',async()=>{
  const f=fixture();await expect(f.auth.consume(peer)).rejects.toThrow(/Choose and confirm/)
  await f.auth.begin();const permit=await f.auth.consume(peer);await f.auth.check(peer)
  await expect(f.auth.check({...peer,ticks:'124'})).rejects.toThrow(/No live/)
  await permit.decide('b'.repeat(64));permit.commit();await expect(f.auth.consume(peer)).rejects.toThrow();expect(f.auth.status().complete).toBe(true)
  await expect(fixture().auth.consume(peer)).rejects.toThrow();expect(f.counts()).toEqual({confirms:1,starts:1})
 })
 it('allows exactly one concurrent consumer',async()=>{
  const f=fixture();await f.auth.begin();const result=await Promise.allSettled([f.auth.consume(peer),f.auth.consume(peer)])
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);await f.auth.check(peer)
 })
 it('requires a fresh confirmation after build failure, caller failure, expiry or main cancellation',async()=>{
  for(const fail of ['build','caller','expiry','cancel']){
   const f=fixture();await f.auth.begin()
   if(fail==='build')f.badBuild();if(fail==='caller')f.badCaller();if(fail==='expiry')f.setTime(31_000);if(fail==='cancel')f.auth.invalidate()
   await expect(f.auth.consume(peer)).rejects.toThrow();await expect(f.auth.consume(peer)).rejects.toThrow(/Choose and confirm/)
   expect(f.auth.status().available).toBe(true)
  }
 })
})

it('refuses a forged process-local permit and expires pending consent without a service request',async()=>{
 expect(()=>assertBrainCutoverPermit({assert:()=>{},commit:()=>{}})).toThrow(/live owner/)
 const f=fixture();await f.auth.begin();f.setTime(31_000);expect(f.auth.status().available).toBe(true)
 await f.auth.begin();const permit=await f.auth.consume(peer);assertBrainCutoverPermit(permit)
 f.auth.invalidate();expect(()=>assertBrainCutoverPermit(permit)).toThrow(/live owner|cancelled/)
})


it('an obsolete confirmation cannot revoke a later owner choice',async()=>{
 const replies:((answer:boolean)=>void)[]=[]
 const auth=new BrainCutoverAuthorization({confirm:()=>new Promise(resolve=>replies.push(resolve)),start:async()=>{},attest:async()=>true,decide:async(_peer,_hash,accept)=>accept(),proveBuild:async()=>{},now:()=>0})
 const first=auth.begin().catch(error=>error)
 auth.invalidate()
 const second=auth.begin()
 replies[1]!(true);await second
 replies[0]!(true);await first
 expect(auth.status().running).toBe(true)
 const permit=await auth.consume(peer);assertBrainCutoverPermit(permit)
})


it('a rejected second connection cannot cancel the winner, even from the same process',async()=>{
 const f=fixture();await f.auth.begin();const permit=await f.auth.consume(peer)
 const loser={...peer,connection:'d'.repeat(32)}
 await expect(f.auth.consume(loser)).rejects.toThrow()
 f.auth.disconnected(loser);assertBrainCutoverPermit(permit);await f.auth.check(peer)
 await expect(f.auth.check(loser)).rejects.toThrow();assertBrainCutoverPermit(permit)
 f.auth.disconnected(peer);expect(()=>assertBrainCutoverPermit(permit)).toThrow()
})
it('disconnect during attestation prevents a permit from being issued',async()=>{
 let attest:((value:boolean)=>void)|undefined
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:()=>new Promise(resolve=>{attest=resolve}),decide:async(_peer,_hash,accept)=>accept(),proveBuild:async()=>{},now:()=>0})
 await auth.begin();const consuming=auth.consume(peer)
 auth.disconnected(peer);attest!(true)
 await expect(consuming).rejects.toThrow(/expired/);expect(auth.status().available).toBe(true)
})

it('carries one immutable checked preparation snapshot with the issued permit',async()=>{
 const preparation={text:'{"synthetic":"checked"}',sha256:'a'.repeat(64)}
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>true,decide:async(_peer,_hash,accept)=>accept(),proveBuild:async()=>preparation,now:()=>0})
 await auth.begin();const permit=await auth.consume(peer)
 preparation.text='replaced after proof';preparation.sha256='b'.repeat(64)
 expect(permit.preparation).toEqual({text:'{"synthetic":"checked"}',sha256:'a'.repeat(64)})
 expect(Object.isFrozen(permit.preparation)).toBe(true);expect(Object.isFrozen(permit)).toBe(true)
 assertBrainCutoverPermit(permit)
})

it('cannot publish a switch using only an issued permit without the final one-use decision',async()=>{
 const f=fixture();await f.auth.begin();const permit=await f.auth.consume(peer)
 expect(()=>permit.commit()).toThrow(/decision/)
 expect(f.auth.status().complete).toBe(false)
})

it('serializes final acceptance before a later disconnect in the same broker turn',async()=>{
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>true,proveBuild:async()=>{},now:()=>0,decide:async(p,_hash,accept)=>{accept();auth.disconnected(p)}})
 await auth.begin();const permit=await auth.consume(peer)
 await permit.decide('b'.repeat(64));auth.invalidate();assertBrainCutoverPermit(permit)
 await expect(permit.decide('c'.repeat(64))).rejects.toThrow(/unused final/)
 permit.commit();expect(auth.status().complete).toBe(true)
})
it('refuses disconnect before broker acceptance and does not publish a decision',async()=>{
 let reply:(()=>void)|undefined,started:()=>void=()=>{}
 const pending=new Promise<void>(resolve=>{started=resolve})
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>true,proveBuild:async()=>{},now:()=>0,decide:(_p,_hash,accept)=>new Promise<void>((resolve,reject)=>{reply=()=>{try{accept();resolve()}catch(error){reject(error)}};started()})})
 await auth.begin();const permit=await auth.consume(peer),deciding=permit.decide('b'.repeat(64))
 await pending;auth.disconnected(peer);reply!()
 await expect(deciding).rejects.toThrow(/cancelled/)
 expect(auth.status()).toMatchObject({available:true,complete:false})
 expect(()=>permit.commit()).toThrow()
})
it('a second final decision cannot cancel the first pending decision',async()=>{
 let reply:(()=>void)|undefined,started:()=>void=()=>{}
 const pending=new Promise<void>(resolve=>{started=resolve})
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>true,proveBuild:async()=>{},now:()=>0,decide:(_p,_hash,accept)=>new Promise<void>(resolve=>{reply=()=>{accept();resolve()};started()})})
 await auth.begin();const permit=await auth.consume(peer),deciding=permit.decide('b'.repeat(64))
 await pending;await expect(permit.decide('b'.repeat(64))).rejects.toThrow(/unused final/)
 reply!();await deciding;permit.commit();expect(auth.status().complete).toBe(true)
})
it('rechecks the manager peer before the kernel decision and refuses a lost invocation',async()=>{
 let calls=0,decisions=0
 const auth=new BrainCutoverAuthorization({confirm:async()=>true,start:async()=>{},attest:async()=>++calls===1,proveBuild:async()=>{},now:()=>0,decide:async(_p,_hash,accept)=>{decisions++;accept()}})
 await auth.begin();const permit=await auth.consume(peer)
 await expect(permit.decide('b'.repeat(64))).rejects.toThrow(/peer was lost/)
 expect(decisions).toBe(0);expect(auth.status().complete).toBe(false)
})

it('retires a failed final decision only for its exact hash and requires another owner confirmation',async()=>{
 const f=fixture();await f.auth.begin();const first=await f.auth.consume(peer),hash='b'.repeat(64)
 await first.decide(hash);f.auth.invalidate();expect(f.auth.status().available).toBe(false)
 expect(()=>first.retireFailed?.('c'.repeat(64))).toThrow(/matching failed/)
 first.retireFailed!(hash);expect(f.auth.status().available).toBe(true);expect(()=>assertBrainCutoverPermit(first)).toThrow()
 await expect(first.decide(hash)).rejects.toThrow();await f.auth.begin();const second=await f.auth.consume(peer)
 expect(f.counts()).toEqual({confirms:2,starts:2});assertBrainCutoverPermit(second)
})
