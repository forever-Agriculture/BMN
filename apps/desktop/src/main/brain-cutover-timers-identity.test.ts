// MODULE: brain-cutover-timers-identity.test.ts - A timer keeps its identity across a new login's manager, not across a changed unit
import {beforeEach,expect,it,vi} from 'vitest'

const host={bus:'a'.repeat(32),owner:':1.7',unit:'[Timer]\nOnCalendar=daily\n'}
vi.mock('node:child_process',()=>({execFile:(command:string,args:string[],_options:unknown,done:(error:Error|null,result?:{stdout:string})=>void)=>{
 if(command==='/usr/bin/busctl')return done(null,{stdout:args.includes('GetId')?'s "'+host.bus+'"\n':'s "'+host.owner+'"\n'})
 if(args.includes('show'))return done(null,{stdout:['Id=brain-autocommit.timer','LoadState=loaded','UnitFileState=disabled','ActiveState=inactive','Job=','FragmentPath=/home/synthetic/.config/systemd/user/brain-autocommit.timer','DropInPaths=','NeedDaemonReload=no'].join('\n')+'\n'})
 return done(null,{stdout:host.unit})
}}))
const {observeBrainTimer}=await import('./brain-cutover-timers')
beforeEach(()=>{host.bus='a'.repeat(32);host.owner=':1.7';host.unit='[Timer]\nOnCalendar=daily\n'})

it('keeps the held timer identity after a reboot gives the user manager a new bus and name',async()=>{
 const before=await observeBrainTimer('brain-autocommit')
 host.bus='b'.repeat(32);host.owner=':1.42'
 expect(await observeBrainTimer('brain-autocommit')).toEqual(before)
})
it('changes the identity when the unit itself changed',async()=>{
 const before=await observeBrainTimer('brain-autocommit')
 host.unit='[Timer]\nOnCalendar=hourly\n'
 expect((await observeBrainTimer('brain-autocommit')).identity).not.toBe(before.identity)
})
