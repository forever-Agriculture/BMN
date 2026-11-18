// MODULE: brain-cutover-timers.test.ts - Crash between timer commands without reaching the host manager
import {expect,it} from 'vitest'
import {BRAIN_TIMERS,brainTimerTransitions,type BrainTimerAction} from './brain-cutover-timers'
import type {BrainTimerState,BrainTimerStates,BrainTimerProgressMap,BrainTimerProgress} from '../utility/brain-cutover-journal'

const name=BRAIN_TIMERS[0],identity='a'.repeat(64)
const pairs=[{enabled:false,active:false},{enabled:true,active:false},{enabled:false,active:true},{enabled:true,active:true}]
function fixture(first:BrainTimerState){
 const observations=Object.fromEntries(BRAIN_TIMERS.map(timer=>[timer,timer===name?{...first,identity}:{enabled:false,active:false,identity}]))
 let prior:BrainTimerStates={},steps:BrainTimerProgressMap={}
 const calls:BrainTimerAction[]=[]
 let fault:{operation:BrainTimerAction;after:boolean}|undefined
 const control=brainTimerTransitions(async timer=>({...observations[timer]!}),async(operation,unit)=>{
  calls.push(operation)
  const timer=observations[unit.replace(/\.timer$/,'')]!
  const pending=steps[name]
  expect(pending?.after).toBeDefined()
  if(fault?.operation===operation&&!fault.after)throw new Error('Interrupted before timer command')
  if(operation==='enable'||operation==='disable')timer.enabled=operation==='enable'
  else timer.active=operation==='start'
  if(fault?.operation===operation&&fault.after)throw new Error('Interrupted after timer command')
 })
 const record=(timer:string,state:BrainTimerProgress)=>{steps={...steps,[timer]:structuredClone(state)}}
 return {observations,calls,interrupt(operation:BrainTimerAction,after:boolean){fault={operation,after}},clear(){fault=undefined},
  pause:()=>control.pause(state=>{prior=structuredClone(state)},record),
  preflight:()=>control.preflight(prior,steps),
  restore:()=>control.restore(prior,steps,record)}
}
it.each(pairs)('round-trips the exact enabled and active pair %j',async pair=>{
 const f=fixture(pair)
 await f.pause()
 expect(f.observations[name]).toMatchObject({enabled:false,active:false})
 await f.preflight()
 await f.restore()
 expect(f.observations[name]).toMatchObject(pair)
})
const boundaries=(['enable','disable','start','stop'] as const).flatMap(operation=>[false,true].map(after=>({operation,after})))
it.each(boundaries)('restores after losing the attempt for $operation (already applied: $after)',async({operation,after})=>{
 const pair={enabled:true,active:true},f=fixture(pair),pausing=operation==='disable'||operation==='stop'
 if(!pausing)await f.pause()
 f.interrupt(operation,after)
 await expect(pausing?f.pause():f.restore()).rejects.toThrow(/Interrupted/)
 f.clear()
 await f.preflight()
 await f.restore()
 expect(f.observations[name]).toMatchObject(pair)
})
it('refuses an unrecorded pair or manager replacement before restoration touches any timer',async()=>{
 const f=fixture({enabled:true,active:true})
 await f.pause()
 const count=f.calls.length,timer=f.observations[name]!
 timer.active=true
 await expect(f.preflight()).rejects.toThrow(/unrecorded timer state/)
 expect(f.calls).toHaveLength(count)
 timer.active=false;timer.identity='b'.repeat(64)
 await expect(f.preflight()).rejects.toThrow(/timer identity changed/)
 expect(f.calls).toHaveLength(count)
})
