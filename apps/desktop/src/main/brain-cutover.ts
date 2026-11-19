// MODULE: brain-cutover.ts - Window-only confirmation, kernel-attested service and private host operations
import {spawn,execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {promisify} from 'node:util'
import {createInterface} from 'node:readline'
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {BrainCutoverAuthorization,type CutoverPeer,type BrainCutoverPermit} from './brain-cutover-authorization'
import {checkedBrainPreparation} from './brain-cutover-preparation'
import {homedir} from 'node:os'
import {brainContainsDelivery} from '../../../../scripts/lib/brain-provenance.mjs'
import {attestBrainCutoverPeer} from './brain-cutover-peer'
import {proveBrainBuild} from './brain-build-proof'
const execute=promisify(execFile)
export const BRAIN_CUTOVER_UNIT='bmn-brain-cutover.service'
declare const __BMN_BUILD_COMMIT__:string
interface Options {
 runtime:string;state:string;prepared:string;archive:string;bin:string;complete:()=>boolean|Promise<boolean>
 available?:()=>boolean|Promise<boolean>
 settleFailed?:(payloadHash:string)=>Promise<boolean>
 confirm:()=>Promise<boolean>
 run:(permit:BrainCutoverPermit)=>Promise<unknown>
}
/** Constructing this object does not start a service, broker, timer or cutover. */
export function brainCutover(options:Options) {
 let child:ReturnType<typeof spawn>|null=null
 let temporary:string|null=null
 let executing=false
 let generation=0
 let permit:BrainCutoverPermit|null=null
 let expiry:ReturnType<typeof setTimeout>|null=null
 let settlement:Promise<void>|null=null
 const decisions=new Map<string,{broker:ReturnType<typeof spawn>;hash:string;accept:()=>void;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
 const locator=join(options.runtime,'brain-cutover-peer.json')
 const auth=new BrainCutoverAuthorization({
  now:()=>performance.now(),confirm:options.confirm,
  start:async()=>{
   const current=generation
   await startBroker(current)
   if(current!==generation)throw new Error('The brain switch was cancelled')
   await execute('/usr/bin/systemctl',['--user','start','--no-block',BRAIN_CUTOVER_UNIT],{timeout:10_000})
  },
  attest:peer=>attestBrainCutoverPeer(peer,BRAIN_CUTOVER_UNIT),
  decide:(peer,hash,accept)=>finalDecision(peer,hash,accept),
  proveBuild:async()=>{
   const record=proveBrainBuild({stateDirectory:options.state,pid:process.pid,archive:options.archive,resources:dirname(options.bin),preparedPath:options.prepared,contains:(commit,delivery)=>commit===__BMN_BUILD_COMMIT__&&brainContainsDelivery(join(homedir(),'code','BMN'),delivery,commit)})
   // Bind exact installed bytes to the compiled revision and the original delivered ancestor.
   if(record.commit!==__BMN_BUILD_COMMIT__)throw new Error('The installed build identity differs from the running BMN')
   if(!record.preparation)throw new Error('The checked brain preparation is missing')
   return checkedBrainPreparation(record.preparation)
  }
 })
 function rejectDecisions(broker:ReturnType<typeof spawn>):void {
  for(const [id,pending]of decisions)if(pending.broker===broker){decisions.delete(id);clearTimeout(pending.timer);pending.reject(new Error('The brain broker closed before the final decision'))}
 }
 async function finalDecision(peer:CutoverPeer,hash:string,accept:()=>void):Promise<void> {
  const broker=child,input=broker?.stdin
  if(!broker||!input||input.destroyed||input.writableEnded)throw new Error('No live brain decision broker')
  const decisionId=randomUUID()
  return new Promise<void>((resolve,reject)=>{
   const fail=(error:Error)=>{const pending=decisions.get(decisionId);if(!pending)return;decisions.delete(decisionId);clearTimeout(pending.timer);reject(error)}
   const timer=setTimeout(()=>fail(new Error('The final brain decision timed out')),5000)
   decisions.set(decisionId,{broker,hash,accept,resolve,reject,timer})
   try{input.write(JSON.stringify({command:'commit-decision',decisionId,peer,payloadHash:hash})+'\n',error=>{if(error)fail(error)})}catch(error){fail(error instanceof Error?error:new Error('Brain broker write failed'))}
  })
 }
 async function request(message:{id:number;peer:Omit<CutoverPeer,'invocation'>;payload:{command?:unknown;invocation?:unknown}}):Promise<unknown>{
  const peer={...message.peer,invocation:String(message.payload.invocation??'')}
  if(message.payload.command==='begin'){permit=await auth.consume(peer);if(expiry){clearTimeout(expiry);expiry=null}return {accepted:true}}
  if(message.payload.command!=='run')throw new Error('Unknown brain cutover request')
  const current=generation
  await auth.check(peer)
  if(executing)throw new Error('The brain cutover is already running')
  executing=true
  try{
   if(!permit)throw new Error('No live owner authorization')
   const result=await options.run(permit)
   if(!auth.status().complete)auth.finish()
   return result
  }catch(error){
   // Revoke the permit now. Keep the transport alive to deliver the failure, as
   // with a failed build proof. A new confirmation replaces the old broker.
   if(current===generation)auth.invalidate()
   throw error
  }finally{executing=false}
 }
 async function startBroker(current:number):Promise<void>{
  await stopBroker()
  if(current!==generation)throw new Error('The brain switch was cancelled')
  mkdirSync(options.runtime,{recursive:true,mode:0o700})
  temporary=mkdtempSync(join(options.runtime,'brain-cutover-'))
  const socket=join(temporary,'peer.sock')
  child=spawn('/usr/bin/python3',['-I',join(options.bin,'brain-cutover-peer.py'),'broker',socket],{stdio:['pipe','pipe','pipe']})
  const broker=child
  broker.stdin?.on('error',()=>{rejectDecisions(broker);if(child===broker)auth.invalidate()})
  await new Promise<void>((resolve,reject)=>{
   let ready=false
   const timer=setTimeout(()=>{reject(new Error('Brain cutover peer broker did not start'));void stopBroker().catch(error=>console.error('Brain broker shutdown failed',error))},5000)
   broker.once('error',error=>{clearTimeout(timer);reject(error)})
   broker.once('exit',()=>{clearTimeout(timer);rejectDecisions(broker);if(child===broker)auth.invalidate();if(!ready)reject(new Error('Brain cutover peer broker exited'))})
   broker.stderr?.resume()
   const lines=createInterface({input:broker.stdout!})
   lines.on('line',line=>{
    if(child!==broker)return
    let value:{decision?:{decisionId:string;payloadHash:string;accepted:boolean;error?:string};ready?:string;gone?:Omit<CutoverPeer,'invocation'>;id:number;peer:Omit<CutoverPeer,'invocation'>;payload:{command?:unknown;invocation?:unknown}}
    try{value=JSON.parse(line)}catch{auth.invalidate();return}
    if(value.decision){
     const result=value.decision,pending=decisions.get(result.decisionId)
     if(!pending||pending.broker!==broker)return
     decisions.delete(result.decisionId);clearTimeout(pending.timer)
     try{if(!result.accepted||result.payloadHash!==pending.hash)throw new Error(result.error??'The final brain decision was refused');pending.accept();pending.resolve()}catch(error){pending.reject(error instanceof Error?error:new Error('Invalid final brain decision'))}
     return
    }
    if(value.gone){auth.disconnected(value.gone);return}
    if(value.ready===socket){
     const body=JSON.stringify({socket,mainPid:process.pid})+'\n',temp=locator+'.tmp'
     writeFileSync(temp,body,{mode:0o600});renameSync(temp,locator)
     if(readFileSync(locator,'utf8')!==body){reject(new Error('Brain peer locator read-back failed'));void stopBroker().catch(error=>console.error('Brain broker shutdown failed',error));return}
     ready=true;clearTimeout(timer);resolve();return
    }
    const reply=(body:Record<string,unknown>)=>{if(child===broker&&!broker.stdin?.destroyed&&!broker.stdin?.writableEnded)broker.stdin?.write(JSON.stringify({id:value.id,...body})+'\n')}
    void request(value).then(result=>reply({result}),error=>reply({error:error instanceof Error?error.message:'Brain cutover failed'}))
   })
  })
 }
 async function stopBroker():Promise<void> {
  if(expiry){clearTimeout(expiry);expiry=null}
  const stopping=child,folder=temporary
  if(stopping)rejectDecisions(stopping)
  child=null;temporary=null
  try{rmSync(locator,{force:true})}catch{/* The directory may have gone with an isolated run. */}
  if(stopping&&stopping.exitCode===null&&stopping.signalCode===null){
   await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Brain peer broker did not close its parent pipe')),5000)
    stopping.once('close',()=>{clearTimeout(timer);resolve()})
    stopping.stdin?.end()
   })
  }
  if(folder)rmSync(folder,{recursive:true,force:true})
 }
 async function settle():Promise<void> {
  if(settlement)return settlement
  const candidate=permit,check=options.settleFailed,current=generation
  const hash=candidate?auth.pendingDecision(candidate):null
  if(executing||!candidate||!check||!hash)return
  settlement=(async()=>{
   if(!await check(hash)||current!==generation||auth.pendingDecision(candidate)!==hash)return
   await stopBroker()
   if(current===generation&&auth.pendingDecision(candidate)===hash)candidate.retireFailed?.(hash)
  })().catch(error=>console.error('Brain rollback is still held',error))
  try{await settlement}finally{settlement=null}
 }
 return {
  status:async()=>{await settle();const complete=await options.complete();return {...auth.status(),available:!complete&&!executing&&auth.status().available&&(await options.available?.()??true),complete}} ,
  begin:async()=>{await settle();if(options.available&&!await options.available())throw new Error('The prior brain attempt has not completed safe recovery');if(await options.complete())throw new Error('The brain has already switched');if(executing||!auth.status().available)throw new Error('The brain switch is already in progress');const current=++generation;try{await auth.begin();if(current===generation&&auth.status().running){expiry=setTimeout(()=>{if(current!==generation)return;auth.expirePending();if(auth.status().available)void stopBroker().catch(error=>console.error('Brain broker shutdown failed',error))},30_050);expiry.unref()}}catch(error){if(current===generation)await stopBroker();throw error}},
  dispose:async()=>{generation++;auth.invalidate();await stopBroker()}
 }
}
