// MODULE: brain-installed-check.ts - Actual installed launcher with credentials only on inherited descriptor 3
import {readFileSync} from 'node:fs'
import {durableBrainText,type BrainCheckIntent} from '../utility/brain-cutover-journal'
import {inspectBrainExport} from '../utility/brain-export-proof'
import {markdownPage} from '../renderer/src/quick-look-markdown'
import {BRAIN_INSTALLED_CHECK_BODY} from '../utility/brain-check-capabilities'
import type {BrainNote} from '../utility/brain-store'
import {spawn} from 'node:child_process'
import {join} from 'node:path'
import type {Writable} from 'node:stream'
import type {BrainCheckGrant} from '../utility/brain-check-capabilities'
export async function runInstalledBrainCli(options:{bin:string;grant:BrainCheckGrant;args:string[];guard():void;signal?:AbortSignal;environment?:NodeJS.ProcessEnv}):Promise<unknown> {
 options.guard()
 const environment:NodeJS.ProcessEnv={...(options.environment??process.env),BMN_BRAIN_CHECK_FD:'3',BMN_DATA_HOME:options.grant.dataRoot}
 for(const key of ['BMN_TOKEN','AITERM_TOKEN','BMN_CONTROL_SOCKET','AITERM_CONTROL_SOCKET'])delete environment[key]
 return new Promise((resolve,reject)=>{
  const controller=new AbortController(),cancel=()=>controller.abort()
  if(options.signal?.aborted){reject(new Error('The installed brain check was cancelled'));return}
  options.signal?.addEventListener('abort',cancel,{once:true})
  const child=spawn(join(options.bin,'bmn'),['brain',...options.args,'--json'],{env:environment,stdio:['ignore','pipe','pipe','pipe'],signal:controller.signal})
  let output='',error='',failure:Error|undefined
  const deadline=setTimeout(()=>{failure=new Error('The installed brain CLI timed out');controller.abort()},15_000)
  const collect=(destination:'output'|'error',data:Buffer)=>{
   if(destination==='output')output+=data.toString();else error+=data.toString()
   if(Buffer.byteLength(output)+Buffer.byteLength(error)>1_048_576){failure=new Error('The installed brain CLI result is too large');controller.abort()}
  }
  child.stdout!.on('data',data=>collect('output',data));child.stderr!.on('data',data=>collect('error',data))
  child.once('error',error=>{failure??=error})
  child.once('close',code=>{
   clearTimeout(deadline);options.signal?.removeEventListener('abort',cancel)
   try{
    options.guard()
    if(failure)throw failure
    if(code!==0)throw new Error('Installed bmn brain failed: '+error.replaceAll(options.grant.token,'[redacted]').trim())
    resolve(JSON.parse(output))
   }catch(error){reject(error)}
  })
  const inherited=child.stdio[3] as Writable|null
  inherited?.on('error',()=>{})
  inherited?.end(JSON.stringify(options.grant))
 })
}

/** The production installed proof, driven over the shipped launcher and private socket scope. */
export async function verifyInstalledBrainCheck(options:{bin:string;journal:string;intent:BrainCheckIntent;guard():void;signal?:AbortSignal;environment?:NodeJS.ProcessEnv;admin:<T>(command:string,params?:Record<string,unknown>)=>Promise<T>}):Promise<{note:string;export:string}> {
 const intent=options.intent
 const saved=JSON.parse(readFileSync(join(options.journal,'journal.json'),'utf8')) as {checkIntent?:BrainCheckIntent}
 if(JSON.stringify(saved.checkIntent)!==JSON.stringify(intent))throw new Error('The installed check intent is not durably journalled')
   const {attempt,title:checkTitle}=intent
   if(intent.body!==BRAIN_INSTALLED_CHECK_BODY)throw new Error('Installed check intent body differs')
   options.guard()
   const file=join(options.journal,'cutover-check.md')
   durableBrainText(file,BRAIN_INSTALLED_CHECK_BODY)
   const grant=await options.admin<BrainCheckGrant>('issue-check',{attempt,title:checkTitle,noteId:intent.note})
   const cancel=()=>{void options.admin('revoke-check',{id:grant.id}).catch(()=>undefined)}
   options.signal?.addEventListener('abort',cancel,{once:true})
   let note:BrainNote,folder:string
   try{
    const run=(args:string[])=>runInstalledBrainCli({bin:options.bin,grant,args,guard:options.guard,...(options.signal?{signal:options.signal}:{}),...(options.environment?{environment:options.environment}:{})})
    note=await run(['write',checkTitle,'--revision','0','--text-file',file,'--kind','check','--origin','cutover-check']) as BrainNote
    const read=await run(['read',note.id]) as BrainNote
    if(note.id!==intent.note||read.id!==intent.note||read.markdown!==BRAIN_INSTALLED_CHECK_BODY||read.markdown!==note.markdown||read.origin!=='cutover-check'||read.revision!==1||read.session!==attempt)throw new Error('Installed brain write/read check failed')
    const exported=await run(['export']);if(typeof exported!=='string')throw new Error('Installed brain export lookup failed');folder=exported
    inspectBrainExport(folder,grant.dataRoot,generation=>{
     if(generation.read(note.id+'.md').toString('utf8')!==note.markdown)throw new Error('Installed brain export check failed')
     for(const name of generation.names)if(name.endsWith('.md'))markdownPage(generation.read(name).toString('utf8'))
    })
    const withdrawn=await run(['withdraw',note.id,'--revision',String(note.revision)]) as BrainNote
    if(withdrawn.id!==note.id||withdrawn.revision!==2||withdrawn.status!=='withdrawn')throw new Error('Installed brain withdrawal check failed')
   }finally{
    options.signal?.removeEventListener('abort',cancel)
    await options.admin('revoke-check',{id:grant.id})
   }
   return {note:note.id,export:folder}
}
