// MODULE: brain-cutover-transport.test.ts - Real main/parent/Python decision pipe with synthetic build and manager assertions
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createConnection,type Socket} from 'node:net'
import {once} from 'node:events'
import {afterEach,expect,it,vi} from 'vitest'
const synthetic=vi.hoisted(()=>({text:'',starts:[] as string[][]}))
vi.mock('node:child_process',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process')
 return {...actual,execFile:(file:string,args:string[],_options:unknown,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{
  if(file!=='/usr/bin/systemctl'||JSON.stringify(args)!==JSON.stringify(['--user','start','--no-block','bmn-brain-cutover.service']))throw new Error('Unexpected synthetic manager call')
  synthetic.starts.push(args);callback(null,'','')
 }}
})
vi.mock('./brain-cutover-peer',()=>({attestBrainCutoverPeer:async()=>true}))
vi.mock('./brain-build-proof',async()=>{
 const {createHash}=await vi.importActual<typeof import('node:crypto')>('node:crypto')
 return {proveBrainBuild:()=>({commit:'c'.repeat(40),preparation:{text:synthetic.text,sha256:createHash('sha256').update(synthetic.text).digest('hex')}})}
})
import {brainCutover} from './brain-cutover'
import {brainStartTextGroups} from './brain-cutover-preparation'
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();synthetic.starts=[]})
type Outcome={ok:boolean;error?:string}
async function fixture(hooks:{before?:()=>Promise<void>;after?:()=>Promise<void>;settleFailed?:(hash:string)=>Promise<boolean>}={}) {
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-transport-')),home=join(root,'home'),runtime=join(root,'runtime')
 mkdirSync(home)
 vi.stubEnv('HOME',home);vi.stubGlobal('__BMN_BUILD_COMMIT__','c'.repeat(40))
 synthetic.text=JSON.stringify({version:1,labels:[],projects:[],changes:[],indexes:[],instructionLines:{},startText:brainStartTextGroups(home)})
 let committed=false,finish:(outcome:Outcome)=>void=()=>{}
 const finished=new Promise<Outcome>(resolve=>{finish=resolve})
 const app=brainCutover({runtime,state:join(root,'update'),prepared:'synthetic-build-proof',archive:'synthetic-build-proof',bin:resolve(import.meta.dirname,'../../bin'),complete:()=>committed,confirm:async()=>true,...(hooks.settleFailed?{settleFailed:hooks.settleFailed}:{}),run:async permit=>{
  try{
   await hooks.before?.();await permit.decide('b'.repeat(64));await hooks.after?.()
   permit.commit();committed=true;finish({ok:true});return {ok:true}
  }catch(error){finish({ok:false,error:error instanceof Error?error.message:'failed'});throw error}
 }})
 let socket:Socket|undefined
 try{
  await app.begin()
  const locator=JSON.parse(readFileSync(join(runtime,'brain-cutover-peer.json'),'utf8')) as {socket:string}
  socket=createConnection(locator.socket);await once(socket,'connect')
  let buffered=''
  const waiting:{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}[]=[]
  socket.on('data',data=>{
   buffered+=data.toString()
   for(;;){const end=buffered.indexOf('\n');if(end<0)break;const line=buffered.slice(0,end);buffered=buffered.slice(end+1);waiting.shift()?.resolve(JSON.parse(line) as Record<string,unknown>)}
  })
  socket.on('error',error=>{for(const pending of waiting.splice(0))pending.reject(error)})
  const send=(command:string):Promise<Record<string,unknown>>=>new Promise((resolve,reject)=>{waiting.push({resolve,reject});socket!.write(JSON.stringify({command,invocation:'a'.repeat(32)})+'\n')})
  expect(await send('begin')).toHaveProperty('result.accepted',true)
  return {socket,app,send,finished,async close(){socket!.destroy();await app.dispose();rmSync(root,{recursive:true,force:true})}}
 }catch(error){socket?.destroy();await app.dispose();rmSync(root,{recursive:true,force:true});throw error}
}
it('composes the actual Python decision response with the main permit before publication',async()=>{
 const f=await fixture()
 try{
  expect(await f.send('run')).toHaveProperty('result.ok',true)
  expect(await f.finished).toEqual({ok:true});expect(await f.app.status()).toMatchObject({complete:true})
  expect(synthetic.starts).toHaveLength(1)
 }finally{await f.close()}
})
it('a kernel half-close between final preparation and decision prevents main publication',async()=>{
 let release:()=>void=()=>{},entered:()=>void=()=>{}
 const hold=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const f=await fixture({before:async()=>{entered();await hold}})
 try{
  f.socket.write(JSON.stringify({command:'run',invocation:'a'.repeat(32)})+'\n')
  await started;f.socket.end();release()
  const outcome=await f.finished
  expect(outcome.ok).toBe(false);expect(outcome.error).toMatch(/peer|connection|decision|broker/)
  expect(await f.app.status()).toMatchObject({complete:false})
 }finally{await f.close()}
})
it('a peer gone event after the accepted decision cannot cancel main publication',async()=>{
 const f=await fixture({after:async()=>{const closed=once(peer,'close');peer.end();await closed}})
 const peer:Socket=f.socket
 try{
  f.socket.write(JSON.stringify({command:'run',invocation:'a'.repeat(32)})+'\n')
  expect(await f.finished).toEqual({ok:true})
  expect(await f.app.status()).toMatchObject({complete:true})
 }finally{await f.close()}
})

it('keeps a failed decision latched until its settled rollback and then requires new confirmation',async()=>{
 const hashes:string[]=[]
 let recovered=false
 const f=await fixture({after:async()=>{throw new Error('Synthetic publication failed')},settleFailed:async hash=>{hashes.push(hash);return recovered}})
 try{
  expect(await f.send('run')).toMatchObject({error:'Synthetic publication failed'})
  expect(await f.app.status()).toMatchObject({available:false,complete:false})
  expect(synthetic.starts).toHaveLength(1)
  recovered=true
  const closed=once(f.socket,'close')
  expect(await f.app.status()).toMatchObject({available:true,complete:false})
  await closed
  expect(synthetic.starts).toHaveLength(1)
  expect(hashes).toEqual(['b'.repeat(64),'b'.repeat(64)])
  await f.app.begin()
  expect(synthetic.starts).toHaveLength(2)
 }finally{await f.close()}
})
