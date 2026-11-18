// MODULE: brain-cli.mjs - Small brain CLI; closed-BMN reads are strictly read-only
import { readFileSync, existsSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { brainSection } from './brain-markdown.mjs'
import {brainStateRoot,brainReceiptMatches} from './brain-state.mjs'
const HELP=`Usage: bmn brain COMMAND [options]
  search WORDS [--archived]          Up to 10 titles, summaries and scores
  read NAME [--section HEADING] [--links]
  history NAME                      Every revision, including withdrawals
  write TITLE --revision 0 --text-file FILE [--kind fact] [--scope all]
  edit NAME --revision N --text-file FILE [--title TITLE]
  withdraw NAME --revision N        Reversible, history kept
  restore NAME --revision N         Append a restoration
  export                            Locate the published read-only markdown folder
  delete                            Refused; owner-only deletion is Epic 128
Options: --origin agent|user, --kind KIND, --scope all|group:one,two,
  --json, --data-root DIR (reads only), --socket PATH, --token-file FILE, --owner
FILE may be - for standard input. Reads work with BMN closed.
Writes require a live session and the owner's completed brain switch.
Read again after a stale-revision refusal. No direct-write fallback.
At most 3 new notes per session; edit existing notes after that.
Duplicate titles name the existing note; imported duplicates need an id.
Project-scoped notes belong in that project's plan or rules file.
Re-import and cutover are not session commands. No model is called.`
const FLAGS=new Set(['archived','links','json','owner','help'])
const VALUES=new Set(['section','revision','text-file','title','kind','scope','origin','data-root','socket','token-file'])
function parse(argv) {
 const options={},words=[]
 for(let i=0;i<argv.length;i++) {
  const arg=argv[i]
  if(arg==='--'){words.push(...argv.slice(i+1));break}
  if(arg==='-h'){options.help=true;continue}
  if(!arg.startsWith('--')){words.push(arg);continue}
  const [key,...tail]=arg.slice(2).split('=')
  if(Object.hasOwn(options,key))throw new Error(`--${key} given twice`)
  if(FLAGS.has(key)){if(tail.length)throw new Error(`--${key} takes no value`);options[key]=true}
  else if(VALUES.has(key)){const value=tail.length?tail.join('='):argv[++i];if(value===undefined)throw new Error(`--${key} needs a value`);options[key]=value}
  else throw new Error(`Unknown brain option --${key}`)
 }
 return {options,words}
}
export function brainDataRoot(env=process.env,home=homedir()) {
 if(env.BMN_DATA_HOME||env.AITERM_DATA_HOME)return env.BMN_DATA_HOME||env.AITERM_DATA_HOME
 const base=env.XDG_DATA_HOME??join(home,'.local','share')
 return !existsSync(join(base,'bmn','state.sqlite3'))&&existsSync(join(base,'ai-terminal','state.sqlite3'))?join(base,'ai-terminal'):join(base,'bmn')
}
/** Read-only status outside the Rules graph, also available with BMN closed. */
export async function readBrainCommitReceipt(environment=process.env,home=homedir()) {
 let journal
 try{journal=JSON.parse(readFileSync(join(brainStateRoot(environment,home),'brain-cutover','journal.json'),'utf8'))}catch{return null}
 if(journal.state!=='complete'||!brainReceiptMatches(journal,journal.commit))return null
 const path=join(brainDataRoot(environment,home),'brain.sqlite3')
 if(!existsSync(path))return null
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path,{readOnly:true})
 try{
  db.exec('BEGIN')
  const meta=key=>db.prepare('SELECT value FROM brain_meta WHERE key=?').get(key)?.value
  const receipt=JSON.parse(meta('cutover_receipt')??'null')
  if(!receipt||receipt.storeId!==meta('store_id')||meta('write_door')!=='open'||meta('cutover_revoked:'+receipt.cutoverId)!==undefined)return null
  return brainReceiptMatches(journal,receipt)?{...receipt,open:true}:null
 }catch{return null}finally{try{db.exec('ROLLBACK')}finally{db.close()}}
}
export async function readBrain(command,params,dataRoot) {
 const {DatabaseSync}=await import('node:sqlite')
 const path=join(dataRoot,'brain.sqlite3')
 if(!existsSync(path))throw new Error('The brain is not installed in this profile')
 const db=new DatabaseSync(path,{readOnly:true})
 let reading=false
 try {
  // Hold one WAL snapshot across the head, history, links and backlinks queries.
  db.exec('BEGIN');reading=true
  const head=`SELECT n.id,v.* FROM brain_note n JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision`
  if(command==='search') {
   const query=params.query.trim();if(!query)return []
   const statuses=params.archived?"('active','archived')":"('active')"
   let rows
   if([...query].length>=3)rows=db.prepare(`SELECT n.id,v.title,v.markdown,bm25(brain_search,0,5,1) AS score FROM brain_search JOIN brain_note n ON n.id=brain_search.note JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision WHERE brain_search MATCH ? AND n.status IN ${statuses} ORDER BY score,n.id LIMIT 10`).all('"'+query.replaceAll('"','""')+'"')
   else rows=db.prepare(head+` WHERE n.status IN ${statuses} ORDER BY v.title,n.id`).all().filter(n=>(n.title+'\n'+n.markdown).toLocaleLowerCase('und').includes(query.toLocaleLowerCase('und'))).slice(0,10).map(n=>({...n,score:0}))
   return rows.map(n=>({id:n.id,title:n.title,summary:n.markdown.replace(/\s+/gu,' ').slice(0,180),score:n.score}))
  }
  const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('und')
  const rows=db.prepare(head+' WHERE n.id=? OR n.normalized_title=?').all(params.name,normalize(params.name))
  const exact=rows.find(n=>n.id===params.name)
  if(!exact&&rows.length>1)throw new Error('Several imported notes have that title; read by note id')
  const note=exact??rows[0];if(!note)throw new Error('Brain note not found')
  if(command==='history')return db.prepare('SELECT note AS id,* FROM brain_version WHERE note=? ORDER BY revision').all(note.id)
  if(params.section!==undefined) {
   const section=brainSection(note.markdown,params.section)
   if(section===null)throw new Error('Brain section not found')
   note.markdown=section
  }
  if(params.links){note.links=db.prepare('SELECT kind,target,resolved FROM brain_link WHERE note=?').all(note.id);note.backlinks=db.prepare('SELECT kind,note AS target,resolved FROM brain_link WHERE resolved=?').all(note.id)}
  return note
 }finally{try{if(reading)db.exec('ROLLBACK')}finally{db.close()}}
}
function inheritedBrainCheck() {
 const value=process.env.BMN_BRAIN_CHECK_FD
 if(value===undefined)return null
 if(!/^[0-9]+$/.test(value)||Number(value)<3||Number(value)>1024)throw new Error('Invalid installed brain check descriptor')
 const fd=Number(value);let scope
 try{scope=JSON.parse(readFileSync(fd,'utf8'))}finally{closeSync(fd)}
 if(!scope||!/^bc1\.[a-f0-9]{64}$/.test(scope.token)||typeof scope.socketPath!=='string'||!isAbsolute(scope.socketPath)||typeof scope.dataRoot!=='string'||!isAbsolute(scope.dataRoot)||scope.dataRoot!==brainDataRoot())throw new Error('Invalid installed brain check credentials')
 return scope
}
export async function runBrainCommand(argv,{readCredentials,call,output=text=>process.stdout.write(text),errorOutput=text=>process.stderr.write(text)}) {
 try {
  const check=inheritedBrainCheck()
  const {options:o,words}=parse(argv);const command=words.shift()
  if(check&&['socket','token-file','owner','data-root'].some(key=>Object.hasOwn(o,key)))throw new Error('Installed brain check credentials cannot be overridden')
  if(o.help||!command){output(HELP+'\n');return 0}
  if(!['search','read','history','write','edit','withdraw','restore','delete','export'].includes(command))throw new Error('Unknown brain command; see bmn brain --help')
  const allowed={search:['archived'],read:['section','links'],history:[],write:['revision','text-file','kind','scope','origin'],edit:['revision','text-file','title','kind','scope','origin'],withdraw:['revision'],restore:['revision'],delete:[],export:[]}[command]
  if(Object.keys(o).some(k=>!allowed.includes(k)&&!['json','data-root','socket','token-file','owner'].includes(k)))throw new Error('Option does not apply to this brain command')
  if(command!=='search'&&words.length>(['delete','export'].includes(command)?0:1))throw new Error('Quote the brain title as one argument')
  const name=words[0];const root=o['data-root']??brainDataRoot()
  if(!isAbsolute(root))throw new Error('--data-root must be absolute')
  let result
  if(['search','read','history'].includes(command)) {
   if(!name)throw new Error('Supply a brain title or query')
   result=await readBrain(command,{name,query:words.join(' '),section:o.section,links:o.links,archived:o.archived},root)
  } else {
   if(o['data-root'])throw new Error('--data-root is for read-only commands')
   const params={command}
   if(['write','edit','withdraw','restore'].includes(command)) {
    if(!name)throw new Error('Supply a brain title or id')
    const revision=Number(o.revision)
    if(o.revision===undefined||!Number.isSafeInteger(revision)||revision<(command==='write'?0:1)||command==='write'&&revision!==0)throw new Error('Supply --revision 0 for a new note, or the revision you read')
    params.revision=revision
    if(command!=='write')params.name=name
    if(command==='write'||command==='edit') {
     if(!o['text-file'])throw new Error('Supply --text-file FILE (or -)')
     const previous=command==='edit'?await readBrain('read',{name},root):null
     params.title=o.title??previous?.title??name;params.kind=o.kind??previous?.kind??'fact';params.origin=o.origin??'agent';params.scope=o.scope??previous?.scope??'all'
     params.markdown=readFileSync(o['text-file']==='-'?0:o['text-file'],'utf8')
    }
   }
   let credentials
   try{credentials=check??readCredentials(Object.fromEntries(Object.entries(o).filter(([k])=>['socket','token-file','owner'].includes(k))))}catch{throw new Error('Brain writes require a running BMN and a live session; reads work with BMN closed')}
   result=await call(credentials.socketPath,credentials.token,'brain',params)
  }
  if(o.json||Array.isArray(result))output(JSON.stringify(result,null,2)+'\n')
  else if(result&&typeof result==='object'&&'markdown'in result)output(`${result.title}\nId: ${result.id} · revision ${result.revision} · ${result.status}\nOrigin: ${result.origin} · date: ${result.source_time} · scope: ${result.scope}\n\n${result.markdown}\n`+(o.links?JSON.stringify({links:result.links,backlinks:result.backlinks},null,2)+'\n':''))
  else output(typeof result==='string'?result+'\n':JSON.stringify(result)+'\n')
  return 0
 }catch(error){errorOutput('bmn brain: '+(error instanceof Error?error.message:'Operation failed')+'\n');return 1}
}
