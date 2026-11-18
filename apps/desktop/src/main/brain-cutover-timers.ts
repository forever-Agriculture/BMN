// MODULE: brain-cutover-timers.ts - Resume only the exact timer transition recorded before its command
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {promisify} from 'node:util'
import type {BrainTimerProgress,BrainTimerProgressMap,BrainTimerState,BrainTimerStates} from '../utility/brain-cutover-journal'

export const BRAIN_TIMERS=['brain-autocommit','brain-daily-note','brain-daily-rollup'] as const
export type BrainTimerAction='enable'|'disable'|'start'|'stop'
export type BrainTimerCommand=(operation:BrainTimerAction,unit:string)=>Promise<void>
type Pair=Pick<BrainTimerState,'enabled'|'active'>
type Observation=Pair&{identity:string}
type RecordProgress=(name:string,progress:BrainTimerProgress)=>void
const local=promisify(execFile)
const held:Pair={enabled:false,active:false}

function equal(a:Pair,b:Pair):boolean {
 return a.enabled===b.enabled&&a.active===b.active
}
function belongs(prior:Pair,current:Pair):boolean {
 return (prior.enabled||!current.enabled)&&(prior.active||!current.active)
}
function saneProgress(prior:BrainTimerState,progress:BrainTimerProgress):boolean {
 const {state,after,identity}=progress
 return /^[a-f0-9]{64}$/.test(identity)&&(!prior.identity||identity===prior.identity)&&belongs(prior,state)&&
   (!after||belongs(prior,after)&&Number(state.enabled!==after.enabled)+Number(state.active!==after.active)===1)
}
function settled(name:string,prior:BrainTimerState,progress:BrainTimerProgress|undefined,observed:Observation):Pair {
 const expected=progress?.identity??prior.identity
 if(expected&&observed.identity!==expected)throw new Error('Rollback conflict: timer identity changed '+name)
 if(progress){
  if(saneProgress(prior,progress)&&(equal(observed,progress.state)||progress.after&&equal(observed,progress.after)))return observed
 }else if(equal(observed,prior)||!prior.identity&&equal(observed,held)){
  // An earlier journal has only its original and fully held observations.
  return observed
 }
 throw new Error('Rollback conflict: unrecorded timer state '+name)
}

export function brainTimerTransitions(read:(name:string)=>Promise<Observation>,command:BrainTimerCommand) {
 const checked=async(name:string,prior:BrainTimerState,progress?:BrainTimerProgress)=>{
  if(!BRAIN_TIMERS.some(timer=>timer===name))throw new Error('Unknown timer in brain recovery')
  const observed=await read(name)
  const state=settled(name,prior,progress,observed)
  return {identity:observed.identity,state:{enabled:state.enabled,active:state.active}}
 }
 const advance=async(name:string,prior:BrainTimerState,progress:BrainTimerProgress|undefined,target:Pair,record:RecordProgress)=>{
  const {identity,state:initial}=await checked(name,prior,progress)
  let state=initial
  if(progress?.after)record(name,{identity,state})
  for(const axis of ['enabled','active'] as const){
   if(state[axis]===target[axis])continue
   const after={...state,[axis]:target[axis]}
   const operation=axis==='enabled'?(after.enabled?'enable':'disable'):(after.active?'start':'stop')
   record(name,{identity,state,after})
   await command(operation,name+'.timer')
   const observed=await checked(name,prior,{identity,state,after})
   if(!equal(observed.state,after))throw new Error('Timer command did not reach the journalled state '+name)
   state=after
   record(name,{identity,state})
  }
 }
 return {
  async pause(record:(timers:BrainTimerStates)=>void,recordProgress:RecordProgress):Promise<void>{
   const timers:BrainTimerStates={}
   for(const name of BRAIN_TIMERS)timers[name]=await read(name)
   record(timers)
   for(const [name,prior]of Object.entries(timers))await advance(name,prior,undefined,held,recordProgress)
  },
  async preflight(timers:BrainTimerStates,progress:BrainTimerProgressMap):Promise<void>{
   for(const [name,prior]of Object.entries(timers))await checked(name,prior,progress[name])
  },
  async restore(timers:BrainTimerStates,progress:BrainTimerProgressMap,record:RecordProgress):Promise<void>{
   for(const [name,prior]of Object.entries(timers))await advance(name,prior,progress[name],prior,record)
  }
 }
}

async function managerIdentity():Promise<string> {
 const bus=(method:string,args:string[])=>local('/usr/bin/busctl',['--user','call','org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus',method,...args],{timeout:5000})
 const busId=(await bus('GetId',[])).stdout.trim()
 const owner=(await bus('GetNameOwner',['s','org.freedesktop.systemd1'])).stdout.trim()
 if(!/^s "[a-f0-9]{32}"$/.test(busId)||!/^s ":[0-9]+\.[0-9]+"$/.test(owner))throw new Error('Cannot pin the brain timer manager')
 return busId+' '+owner
}

/** Production reads the effective unit and the same manager before and after reading its file. */
export async function observeBrainTimer(name:string):Promise<Observation> {
 const unit=name+'.timer',manager=await managerIdentity()
 const keys=['Id','LoadState','UnitFileState','ActiveState','Job','FragmentPath','DropInPaths','NeedDaemonReload']
 const show=await local('/usr/bin/systemctl',['--user','show',unit,...keys.map(key=>'--property='+key)],{timeout:5000})
 const fields=Object.fromEntries(show.stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}))
 if(fields.Id!==unit||fields.LoadState!=='loaded'||fields.Job!==''||fields.NeedDaemonReload!=='no'||!fields.FragmentPath?.startsWith('/')||
   !['enabled','disabled'].includes(fields.UnitFileState??'')||!['active','inactive'].includes(fields.ActiveState??''))throw new Error('Cannot prove settled brain timer state '+name)
 const unitFiles=await local('/usr/bin/systemctl',['--user','cat','--no-pager',unit],{timeout:5000,maxBuffer:128*1024})
 if(manager!==await managerIdentity())throw new Error('Brain timer manager changed while reading '+name)
 // The unit's files and drop-ins are its identity; a new login's manager (after a reboot) serves the same unit.
 const identity=createHash('sha256').update(JSON.stringify([fields.FragmentPath,fields.DropInPaths,unitFiles.stdout])).digest('hex')
 return {identity,enabled:fields.UnitFileState==='enabled',active:fields.ActiveState==='active'}
}
