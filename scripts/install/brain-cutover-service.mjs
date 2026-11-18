// MODULE: brain-cutover-service.mjs - Install an owned, inactive one-shot without activating it
import {spawnSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,readlinkSync,renameSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {homedir,tmpdir} from 'node:os'
const HEADER='# BMN owner-held brain cutover v1'
const UNIT='bmn-brain-cutover.service'
const hash=text=>createHash('sha256').update(text).digest('hex')
const quote=value=>{if(/[\0\r\n;{}]/.test(value))throw new Error('Invalid brain service path');return '"'+value.replaceAll('%','%%').replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'}
const regular=path=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('The brain unit or helper is linked or not a regular owned file; kept unchanged');return stat}
export function brainCutoverUnit({service,locator}) {
 return [HEADER,'[Unit]','Description=BMN brain switch, only after the owner confirms in BMN','','[Service]','Type=oneshot',
  `ExecStart=/usr/bin/python3 -I ${quote(service)} ${quote(locator)}`,'TimeoutStartSec=30min','Restart=no','UMask=0077',''].join('\n')
}
function atomic(path,text){
 mkdirSync(dirname(path),{recursive:true,mode:0o700})
 const temporary=path+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600)
 try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}
 renameSync(temporary,path)
 if(readFileSync(path,'utf8')!==text)throw new Error('Held service read-back failed')
 const folder=openSync(dirname(path),'r');try{fsyncSync(folder)}finally{closeSync(folder)}
}
function show(manager){
 const result=manager('/usr/bin/systemctl',['--user','show',UNIT,...['LoadState','FragmentPath','DropInPaths','ExecStart','ActiveState','MainPID','ControlPID','UnitFileState','Job','TriggeredBy','WantedBy','RequiredBy','UpheldBy'].map(name=>'--property='+name)],{encoding:'utf8',timeout:10_000})
 const fields=Object.fromEntries((result.stdout??'').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}))
 if(result.status!==0&&fields.LoadState!=='not-found')throw new Error('Cannot inspect the effective held unit; kept unchanged')
 return fields
}
function inactive(fields,owned=false){
 if(fields.LoadState==='not-found')return
 const quiescent=fields.MainPID==='0'&&fields.ControlPID==='0'
 if(!quiescent||!(fields.ActiveState==='inactive'||owned&&fields.ActiveState==='failed')||(fields.Job&&fields.Job!=='0')||!['static','disabled',''].includes(fields.UnitFileState??'')||
  ['DropInPaths','TriggeredBy','WantedBy','RequiredBy','UpheldBy'].some(key=>fields[key]?.trim()))throw new Error('The held unit is active, linked, modified or has an activation route; kept unchanged')
}
/** Reject activation links and explicit or implicit timer/path/socket dependencies before writing. */
function noActivation(folders,unitPath){
 const visit=folder=>{
  let entries
  try{entries=readdirSync(folder,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error}
  for(const entry of entries){
   const path=join(folder,entry.name)
   if(path===unitPath||path===unitPath+'.bmn.json')continue
   if(entry.name===UNIT+'.d'){
    if(entry.isSymbolicLink()||readdirSync(path).length)throw new Error('Unknown held-unit drop-ins; kept unchanged')
    continue
   }
   if(/^bmn-brain-cutover\.(timer|path|socket)$/.test(entry.name))throw new Error('A brain cutover activation unit exists; kept unchanged')
   if(entry.isSymbolicLink()){
    if(entry.name===UNIT||resolve(dirname(path),readlinkSync(path))===unitPath)throw new Error('A brain cutover activation link exists; kept unchanged')
   }else if(entry.isDirectory())visit(path)
   else if(entry.isFile()&&!entry.name.endsWith('.bmn.json')){
    const text=readFileSync(path,'utf8')
    if(text.split('\n').some(line=>/^\s*(Wants|Requires|Requisite|BindsTo|Upholds|OnSuccess|OnFailure|Unit|Service)\s*=/.test(line)&&line.includes(UNIT)))throw new Error('A brain cutover dependency exists; kept unchanged')
   }
  }
 }
 for(const folder of new Set(folders))visit(folder)
}
export function installBrainCutoverService({resources,sourceRoot,environment=process.env,home=homedir(),reload=true,manager=spawnSync}) {
 const service=join(resources,'bin','brain-cutover-service.py')
 // The updater installs the static future path before packaging. Validate shipped source and mapping.
 if(sourceRoot){
  for(const name of ['brain-cutover-service.py','brain-cutover-peer.py']){
   const source=join(sourceRoot,'apps/desktop/bin',name);regular(source)
   if(!readFileSync(join(sourceRoot,'apps/desktop/electron-builder.yml'),'utf8').includes('bin/'+name))throw new Error('Brain helper is not in the packaging map')
  }
 }else regular(service)
 const runtime=environment.BMN_RUNTIME_HOME??environment.AITERM_RUNTIME_HOME??join(environment.XDG_RUNTIME_DIR??join(tmpdir(),`bmn-${process.getuid?.()??'user'}`),'bmn')
 const locator=join(runtime,'brain-cutover-peer.json')
 const folder=join(environment.XDG_CONFIG_HOME??join(home,'.config'),'systemd','user'),path=join(folder,UNIT),receipt=path+'.bmn.json'
 const text=brainCutoverUnit({service,locator})
 let ownedExisting=false
 if(existsSync(path)||(()=>{try{return lstatSync(path).isSymbolicLink()}catch{return false}})()){
  regular(path)
  const prior=readFileSync(path,'utf8')
  let owned
  try{regular(receipt);owned=JSON.parse(readFileSync(receipt,'utf8'))}catch{/* Exact current unit is accepted on first adoption. */}
  ownedExisting=owned?.version===1&&owned.path===path&&owned.sha256===hash(prior)
  if(prior!==text&&!ownedExisting)throw new Error('The brain cutover unit is not BMN’s or was modified; kept unchanged')
 }
 let folders=[folder]
 if(reload){
  const before=show(manager);inactive(before,ownedExisting)
  if(before.LoadState!=='not-found'&&before.FragmentPath!==path)throw new Error('The effective brain unit is foreign; kept unchanged')
  const result=manager('/usr/bin/systemd-analyze',['--user','unit-paths'],{encoding:'utf8',timeout:10_000})
  if(result.status!==0)throw new Error('Cannot inspect user unit search paths; kept unchanged')
  folders.push(...result.stdout.trim().split('\n').filter(Boolean))
 }
 noActivation(folders,path)
 atomic(path,text)
 atomic(receipt,JSON.stringify({version:1,path,sha256:hash(text)})+'\n')
 if(reload){
  if(manager('/usr/bin/systemctl',['--user','daemon-reload'],{encoding:'utf8',timeout:10_000}).status!==0)throw new Error('Could not reload the user manager after installing the held brain service')
  const after=show(manager);inactive(after,true)
  const argv=`argv[]=/usr/bin/python3 -I ${service} ${locator} ;`
  if(after.LoadState!=='loaded'||after.FragmentPath!==path||!after.ExecStart?.includes(argv)||after.ExecStart.split('argv[]=').length!==2||!after.ExecStart.startsWith('{ path=/usr/bin/python3 ;'))throw new Error('The effective held brain unit differs from its owned fragment')
  noActivation(folders,path)
 }
 return path
}
