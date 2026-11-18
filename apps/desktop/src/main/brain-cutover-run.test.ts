// MODULE: brain-cutover-run.test.ts - Real startup lock and rollback need neither consent nor prepared config
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,chmodSync,existsSync,lstatSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {brainTextFingerprint} from '../utility/brain-cutover-journal'
import {tmpdir} from 'node:os'
import {afterEach,it,expect,vi} from 'vitest'
import {recoverBrainCutover,runBrainCutover,settleBrainRollback} from './brain-cutover-run'
import {brainJournalCommit} from '../../bin/brain-state.mjs'
import {randomUUID} from 'node:crypto'
import {readBrainHealth} from '../utility/brain-health'
afterEach(()=>vi.unstubAllEnvs())
it('rejects direct entry before creating a lock or journal',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-entry-'))
 try {
  await expect(runBrainCutover({state:join(root,'state'),bin:'missing',skills:'missing',admin:async()=>{throw new Error('must not be called')},permit:{assert:()=>{},decide:async()=>{},commit:()=>{}}})).rejects.toThrow(/live owner/)
  expect(existsSync(join(root,'state'))).toBe(false)
 }finally{rmSync(root,{recursive:true,force:true})}
})
it('holds files with the real lock helper during revocation failure and retries after config loss',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-startup-')),state=join(root,'state'),journal=join(state,'brain-cutover'),vault=join(root,'brain')
 vi.stubEnv('HOME',root)
 const master=join(root,'.config/bmn/agents/global-rules.md'),backup=join(journal,'saved','0'),exported=join(root,'export')
 try {
  mkdirSync(dirname(backup),{recursive:true});mkdirSync(dirname(master),{recursive:true});mkdirSync(vault);mkdirSync(exported)
  writeFileSync(master,'switched',{mode:0o600});writeFileSync(backup,'original',{mode:0o600});writeFileSync(join(exported,'history.json'),JSON.stringify({versions:[]}))
  const paths={home:root,vault,journal,master,claudeRules:join(root,'.claude/CLAUDE.md'),codexRules:join(root,'.codex/AGENTS.md'),claudeSkill:join(root,'.claude/skills/brain'),codexSkill:join(root,'.agents/skills/brain'),managedSkill:join(root,'.local/share/bmn/skills/brain'),shippedSkill:join(root,'resources/skills/brain'),indexes:[]}
  writeFileSync(join(journal,'journal.json'),JSON.stringify({version:1,state:'running',phases:['master'],saved:[{path:master,backup,mode:0o600,original:brainTextFingerprint('original',0o600),written:brainTextFingerprint('switched',0o600)}],modes:[{path:vault,mode:0o700,dev:lstatSync(vault).dev,ino:lstatSync(vault).ino}],timers:{},manifest:null,watermark:'synthetic',paths,preparation:{version:1,labels:[],projects:[],changes:[],indexes:[],instructionLines:{},startText:[{app:'claude',project:'Synthetic',paths:[join(root,'missing-after-crash.md')]}]}}))
  chmodSync(vault,0o500)
  let unavailable=true
  const admin=async<T>(command:string):Promise<T>=>{if(unavailable)throw new Error('Synthetic worker unavailable');if(command==='admission-status')return {committed:false,open:false,receipt:null} as T;if(command==='return-capture')return {snapshot:'',projection:{notes:[],versions:[],attachments:[]},objects:''} as T;if(command==='close-door')return undefined as T;throw new Error('Unexpected operation '+command)}
  const options={state,home:root,bin:resolve(import.meta.dirname,'../../bin'),skills:join(root,'resources/skills'),admin}
  await expect(recoverBrainCutover(options)).rejects.toThrow(/worker unavailable/)
  expect(readFileSync(master,'utf8')).toBe('switched')
  expect(lstatSync(vault).mode&0o7777).toBe(0o500)
  expect(readBrainHealth({BMN_DATA_HOME:join(root,'data'),BMN_STATE_HOME:state},root)).toMatchObject({recovery:'failed'})
  // The first attempt must release flock before this immediate second startup.
  unavailable=false
  await expect(recoverBrainCutover(options)).resolves.toEqual({rolledBack:true})
  expect(JSON.parse(readFileSync(join(journal,'journal.json'),'utf8')).state).toBe('rolled-back')
  expect(existsSync(join(state,'brain-cutover-recovery-error.json'))).toBe(false)
  await expect(recoverBrainCutover(options)).resolves.toEqual({skipped:true})
 }finally{chmodSync(vault,0o700);rmSync(root,{recursive:true,force:true})}
})

it('holds a forged complete journal before locks, delivery or any recovery target is touched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-forged-complete-')),journal=join(root,'brain-cutover')
 const calls:string[]=[]
 try{
  mkdirSync(journal);writeFileSync(join(journal,'journal.json'),JSON.stringify({version:1,state:'complete',paths:{master:'/must-not-touch'}}))
  await expect(recoverBrainCutover({state:root,bin:'missing',skills:'missing',admin:async<T>(command:string)=>{calls.push(command);return {committed:false,open:false,receipt:null} as T}})).rejects.toThrow(/no matching worker receipt/)
  expect(calls).toEqual(['admission-status'])
  expect(existsSync(join(root,'brain-cutover.lock'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root,'brain-cutover-recovery-error.json'),'utf8')).failed).toBe(true)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it('refuses a journal that redirects recovery to an unapproved target and preserves its bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-path-guard-')),state=join(root,'state'),journal=join(state,'brain-cutover'),vault=join(root,'brain'),outside=join(root,'unapproved-canary.md'),backup=join(journal,'saved','0'),exported=join(root,'export')
 try{
  mkdirSync(join(journal,'saved'),{recursive:true});mkdirSync(vault);mkdirSync(exported)
  writeFileSync(outside,'Independent synthetic canary');writeFileSync(backup,'Unapproved replacement');writeFileSync(join(exported,'history.json'),JSON.stringify({versions:[]}))
  const paths={home:root,vault,journal,master:outside,claudeRules:join(root,'.claude/CLAUDE.md'),codexRules:join(root,'.codex/AGENTS.md'),claudeSkill:join(root,'.claude/skills/brain'),codexSkill:join(root,'.agents/skills/brain'),managedSkill:join(root,'.local/share/bmn/skills/brain'),shippedSkill:join(root,'resources/skills/brain'),indexes:[]}
  writeFileSync(join(journal,'journal.json'),JSON.stringify({version:1,state:'running',paths,saved:[{path:outside,backup,mode:0o600}],modes:[],timers:{},phases:[],manifest:null,watermark:'synthetic'}))
  const admin=async<T>(command:string):Promise<T>=>{if(command==='admission-status')return {committed:false,open:false,receipt:null} as T;if(command==='return-capture')return {snapshot:'',projection:{notes:[],versions:[],attachments:[]},objects:''} as T;if(command==='close-door')return undefined as T;throw new Error('Unexpected operation '+command)}
  await expect(recoverBrainCutover({state,home:root,bin:resolve(import.meta.dirname,'../../bin'),skills:join(root,'resources/skills'),admin})).rejects.toThrow(/recovery path|approved|recovery target/i)
  expect(readFileSync(outside,'utf8')).toBe('Independent synthetic canary')
 }finally{rmSync(root,{recursive:true,force:true})}
})

it('settles only a locked durable rollback for the exact store and decision with definitive absence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-settled-')),folder=join(root,'brain-cutover')
 const storeId=randomUUID(),cutoverId=randomUUID()
 const saved={version:1,state:'rolled-back',cutoverId,originatingCommit:'c'.repeat(40),phases:['write-barrier','source-proof','write-door','installed-checks','rollback'],commit:undefined as ReturnType<typeof brainJournalCommit>|undefined}
 saved.commit=brainJournalCommit(saved,storeId)
 const hash=saved.commit.payloadHash
 const observed={storeId,committed:false,open:false,receipt:null,receiptState:'absent'}
 let status={...observed}
 const options={state:root,bin:resolve(import.meta.dirname,'../../bin'),skills:join(root,'resources/skills'),admin:async<T>(command:string):Promise<T>=>{
  expect(command).toBe('admission-status')
  return status as T
 }}
 try{
  mkdirSync(folder)
  const path=join(folder,'journal.json')
  writeFileSync(path,JSON.stringify(saved))
  await expect(settleBrainRollback(options,'d'.repeat(64))).resolves.toBe(false)
  for(const override of [{storeId:randomUUID()},{receiptState:'invalid'},{receiptState:'present'},{open:true},{committed:true},{retired:saved.commit}]){
   status={...observed,...override}
   await expect(settleBrainRollback(options,hash)).resolves.toBe(false)
  }
  status=observed
  await expect(settleBrainRollback(options,hash)).resolves.toBe(true)
  expect(readFileSync(path,'utf8')).toBe(JSON.stringify(saved))
 }finally{rmSync(root,{recursive:true,force:true})}
})
