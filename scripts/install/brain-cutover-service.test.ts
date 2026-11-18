// MODULE: brain-cutover-service.test.ts - Held unit installation has no activation trigger
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect,vi} from 'vitest'
const {installBrainCutoverService,brainCutoverUnit}=await import('./'+'brain-cutover-service.mjs') as {installBrainCutoverService(options:Record<string,unknown>):string;brainCutoverUnit(options:{service:string;locator:string}):string}
it('installs only a disabled/unstarted oneshot, refusing a foreign unit',()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-held-unit-'))
 try{
  const resources=join(root,'resources');mkdirSync(join(resources,'bin'),{recursive:true});writeFileSync(join(resources,'bin','brain-cutover-service.py'),'synthetic')
  const path=installBrainCutoverService({resources,home:root,environment:{},reload:false}),text=readFileSync(path,'utf8')
  expect(text).toContain('Type=oneshot');expect(text).toContain('Restart=no');expect(text).not.toMatch(/WantedBy|\[Install\]|OnCalendar|OnBootSec|PathChanged/)
  expect(brainCutoverUnit({service:'/synthetic/space % file.py',locator:'/synthetic/socket'})).toContain('space %% file.py')
  writeFileSync(path,'Foreign unit');expect(()=>installBrainCutoverService({resources,home:root,environment:{},reload:false})).toThrow(/not BMN/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it.each(['modified','linked'])('preserves a %s unit even when it starts with the BMN header',kind=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-held-ownership-'))
 try{
  const resources=join(root,'resources'),folder=join(root,'.config/systemd/user')
  mkdirSync(join(resources,'bin'),{recursive:true});writeFileSync(join(resources,'bin','brain-cutover-service.py'),'synthetic')
  mkdirSync(folder,{recursive:true});const unit=join(folder,'bmn-brain-cutover.service')
  const original=brainCutoverUnit({service:join(resources,'bin','brain-cutover-service.py'),locator:'/synthetic/locator'})+'# independent edit\n'
  if(kind==='linked'){const target=join(root,'foreign.service');writeFileSync(target,original);symlinkSync(target,unit)}else writeFileSync(unit,original)
  expect(()=>installBrainCutoverService({resources,home:root,environment:{},reload:false})).toThrow(/unchanged|owned|linked|modified/)
  expect(readFileSync(unit,'utf8')).toBe(original)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it.each(['inactive','failed'])('installs a static future resource path and rechecks an owned %s unit without activating it',active=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-held-future-'))
 try{
  mkdirSync(join(root,'apps/desktop/bin'),{recursive:true})
  for(const name of ['brain-cutover-service.py','brain-cutover-peer.py'])writeFileSync(join(root,'apps/desktop/bin',name),'synthetic')
  writeFileSync(join(root,'apps/desktop/electron-builder.yml'),'bin/brain-cutover-service.py\nbin/brain-cutover-peer.py\n')
  const resources=join(root,'future/resources'),folder=join(root,'.config/systemd/user'),path=join(folder,'bmn-brain-cutover.service'),runtime=join(root,'runtime')
  let reload=false,current='inactive'
  const manager=vi.fn((file:string,args:string[])=>{
   if(file==='/usr/bin/systemd-analyze')return {status:0,stdout:folder+'\n'}
   if(args.includes('daemon-reload')){reload=true;return {status:0,stdout:''}}
   if(!reload)return {status:1,stdout:'LoadState=not-found\n'}
   return {status:0,stdout:['LoadState=loaded','ActiveState='+current,'MainPID=0','ControlPID=0','UnitFileState=static','FragmentPath='+path,'DropInPaths=','Job=0','TriggeredBy=','WantedBy=','RequiredBy=','UpheldBy=',`ExecStart={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I ${resources}/bin/brain-cutover-service.py ${runtime}/brain-cutover-peer.json ; ignore_errors=no ; }`].join('\n')}
  })
  expect(installBrainCutoverService({sourceRoot:root,resources,home:root,environment:{BMN_RUNTIME_HOME:runtime},manager})).toBe(path)
  expect(manager.mock.calls.some(([,args])=>args.some(word=>['start','enable','restart','enable-now'].includes(word)))).toBe(false)
  expect(readFileSync(path,'utf8')).toContain(resources+'/bin/brain-cutover-service.py')
  current=active
  expect(()=>installBrainCutoverService({sourceRoot:root,resources,home:root,environment:{BMN_RUNTIME_HOME:runtime},manager})).not.toThrow()
 }finally{rmSync(root,{recursive:true,force:true})}
})
it.each(['drop-in','timer','dependency','link'])('refuses an existing %s activation route without overwriting it',kind=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-held-trigger-'))
 try{
  const resources=join(root,'resources'),folder=join(root,'.config/systemd/user')
  mkdirSync(join(resources,'bin'),{recursive:true});writeFileSync(join(resources,'bin/brain-cutover-service.py'),'synthetic');mkdirSync(folder,{recursive:true})
  if(kind==='drop-in'){mkdirSync(join(folder,'bmn-brain-cutover.service.d'));writeFileSync(join(folder,'bmn-brain-cutover.service.d/foreign.conf'),'[Service]\n')}
  if(kind==='timer')writeFileSync(join(folder,'bmn-brain-cutover.timer'),'[Timer]\n')
  if(kind==='dependency')writeFileSync(join(folder,'foreign.service'),'[Unit]\nWants=bmn-brain-cutover.service\n')
  if(kind==='link'){mkdirSync(join(folder,'default.target.wants'));symlinkSync('../bmn-brain-cutover.service',join(folder,'default.target.wants/bmn-brain-cutover.service'))}
  expect(()=>installBrainCutoverService({resources,home:root,environment:{},reload:false})).toThrow(/drop-ins|activation|dependency/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it.each(['main-pid','control-pid','job','foreign','activation'])('keeps a failed unit held when ownership or quiescence is unproved (%s)',fault=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-held-failed-guard-'))
 try{
  const resources=join(root,'resources');mkdirSync(join(resources,'bin'),{recursive:true});writeFileSync(join(resources,'bin','brain-cutover-service.py'),'synthetic')
  const path=installBrainCutoverService({resources,home:root,environment:{},reload:false}),original=readFileSync(path,'utf8')
  if(fault==='foreign')rmSync(path+'.bmn.json')
  const manager=vi.fn(()=>({status:0,stdout:['LoadState=loaded','ActiveState=failed','FragmentPath='+path,'UnitFileState=static','DropInPaths=',
   'MainPID='+(fault==='main-pid'?'8123':'0'),'ControlPID='+(fault==='control-pid'?'8124':'0'),'Job='+(fault==='job'?'123':'0'),
   'TriggeredBy='+(fault==='activation'?'foreign.timer':''),'WantedBy=','RequiredBy=','UpheldBy='].join('\n')}))
  expect(()=>installBrainCutoverService({resources,home:root,environment:{},manager})).toThrow(/active|activation|unchanged/)
  expect(readFileSync(path,'utf8')).toBe(original)
  expect(manager.mock.calls).toHaveLength(1)
 }finally{rmSync(root,{recursive:true,force:true})}
})
