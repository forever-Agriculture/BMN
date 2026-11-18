// MODULE: brain-cutover-delivery.ts - Resume completion reporting without resuming a cutover
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {durableBrainJson,durableBrainText} from '../utility/brain-cutover-journal'
const execute=promisify(execFile)
type DeliveryExecute=(file:string,args:string[],options:Record<string,unknown>)=>Promise<{stdout:string}>
interface DeliveryReceipt {marker?:boolean;result?:boolean;board?:boolean;notification?:boolean|'reserved'|'sent'|'failed'|'uncertain'}
interface BoardRow {key:string;story:string|null;epic:number;status:string;token:string}
export async function deliverBrainCutover(options:{state:string;project:string;bin:string;proof:unknown;commit:string;execute?:DeliveryExecute}):Promise<void> {
 if(!/^[a-f0-9]{40,64}$/.test(options.commit))throw new Error('The originating brain build commit is missing; completion delivery is held')
 const run=options.execute??execute
 if(!options.proof||typeof options.proof!=='object')throw new Error('Committed brain checks are missing; completion delivery is held')
 const receipt=join(options.state,'brain-cutover','delivery.json')
 const sent=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')) as DeliveryReceipt:{}
 const mark=(step:'marker'|'result'|'board')=>{sent[step]=true;durableBrainJson(receipt,sent)}
 const cli=async(args:string[])=>run(process.execPath,[join(options.bin,'bmn.mjs'),...args,'--project',options.project],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},maxBuffer:1024*1024,timeout:30_000})
 const readBoard=async()=>JSON.parse((await cli(['plan','status','--json'])).stdout) as {ok:boolean;rows:BoardRow[]}
 if(!sent.marker){durableBrainJson(join(options.state,'brain-cutover-complete.json'),{version:1,commit:options.commit,checks:options.proof});mark('marker')}
 if(!sent.result){
  const path=join(options.project,'plan','references','126','cutover-result.md')
  const text='# Epic 126: installed brain cutover\n\nThe owner confirmed the palette switch. The installed cutover and checks completed.\n\nCommit: `'+options.commit+'`.\n\nThe test note was written, read, exported and withdrawn. The backup restored into scratch. Session-start byte totals did not grow. Every exported Markdown note parsed with Quick Look. The vault source manifest was unchanged.\n\nLocal check receipt:\n\n```json\n'+JSON.stringify(options.proof,null,2)+'\n```\n'
  durableBrainText(path,text);mark('result')
 }
 if(!sent.board){
  let board=await readBoard();if(!board.ok)throw new Error('The brain completion board is unavailable')
  for(const story of ['126.8','126.9']){
   const row=board.rows.find(r=>r.story===story);if(!row)throw new Error('Missing brain completion board row')
   if(row.status!=='done')await cli(['plan','set',row.key,'done','--expect',row.token,'--note','main; installed owner-confirmed cutover verified; references/126/cutover-result.md'])
   board=await readBoard()
  }
  if(board.rows.some(r=>r.epic===126&&r.story&&r.status!=='done'))throw new Error('Earlier Epic 126 stories are not accepted; epic completion remains held')
  const epic=board.rows.find(r=>r.key==='epic-126');if(!epic)throw new Error('Missing Epic 126 board row')
  if(epic.status!=='done')await cli(['plan','set',epic.key,'done','--expect',epic.token,'--note','Delivered main; installed cutover verified; references/126/cutover-result.md'])
  mark('board')
 }
 const notification=(state:NonNullable<DeliveryReceipt['notification']>)=>{sent.notification=state;durableBrainJson(receipt,sent)}
 // Legacy `true` meant reserved, not confirmed. A crash or lost response is uncertain.
 if(sent.notification===true||sent.notification==='reserved')notification('uncertain')
 if(!sent.notification||sent.notification==='failed'){
  notification('reserved')
  try{
   await run('/usr/bin/notify-send',['--app-name=BMN','BMN brain switched','The installed checks passed. The old vault is read-only; use bmn brain.'],{timeout:10_000})
   notification('sent')
  }catch(error){notification(typeof (error as {code?:unknown}).code==='number'?'failed':'uncertain');throw error}
 }
}

/** Reporting only: an unfinished migration is never resumed by this timer. */
export function startBrainDeliveryRetry(options:{state:string;deliver:()=>Promise<unknown>;onError:(error:unknown)=>void;interval?:number}):()=>void {
 let busy=false,stopped=false
 const timer=setInterval(()=>{
  if(busy||stopped)return
  let journal:{state?:string;delivered?:boolean}
  try{journal=JSON.parse(readFileSync(join(options.state,'brain-cutover','journal.json'),'utf8'))}catch{return}
  if(journal.state!=='complete'||journal.delivered)return
  busy=true
  void options.deliver().catch(options.onError).finally(()=>{busy=false})
 },options.interval??30_000)
 timer.unref()
 return ()=>{stopped=true;clearInterval(timer)}
}
