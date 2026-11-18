// MODULE: brain-health.ts - Credential-free backup/export health read by BMN's Health page
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, rename, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { brainCutoverStateRoot } from '../../../../scripts/lib/brain-provenance.mjs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { resolveApplicationRoots } from './roots'
export interface BrainHealth { backup:'ok'|'failed'|'unverified'; export:'ok'|'failed'|'unverified'; checkedAt:string; backupLastSuccess?:string; backupFailureAt?:string; backupFailureId?:string; recovery?:'failed' }
export function readBrainHealth(environment:NodeJS.ProcessEnv=process.env,home=homedir()):BrainHealth|null {
  const root=resolveApplicationRoots(environment,{homeDirectory:home,runtimeFallback:tmpdir()}).data
  const recovery=existsSync(join(brainCutoverStateRoot(environment,home),'brain-cutover-recovery-error.json'))?{recovery:'failed' as const}:{}
  const unverified:BrainHealth={backup:'unverified',export:'unverified',checkedAt:'',...recovery}
  try {
    const value=JSON.parse(readFileSync(join(root,'brain-health.json'),'utf8')) as BrainHealth
    if(!['ok','failed','unverified'].includes(value.backup)||!['ok','failed','unverified'].includes(value.export)||typeof value.checkedAt!=='string')return unverified
    return {...value,...recovery}
  }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'&&!existsSync(join(root,'brain.sqlite3'))&&!recovery.recovery?null:unverified}
}

/** Called before worker launch, then on initialization failure; success is worker-owned. */
export async function recordBrainInitialization(dataRoot:string,failed=false):Promise<void> {
  const path=join(dataRoot,'brain-health.json')
  let prior:Partial<BrainHealth>={}
  try{prior=JSON.parse(await readFile(path,'utf8')) as BrainHealth}catch{/* A fresh worker has no prior Health receipt. */}
  const backup=prior.backup&&['ok','failed','unverified'].includes(prior.backup)?prior.backup:'unverified'
  const value:BrainHealth={backup,export:failed||prior.export==='failed'?'failed':'unverified',checkedAt:new Date().toISOString(),
    ...(typeof prior.backupLastSuccess==='string'?{backupLastSuccess:prior.backupLastSuccess}:{}),
    ...(typeof prior.backupFailureAt==='string'?{backupFailureAt:prior.backupFailureAt}:{}),
    ...(typeof prior.backupFailureId==='string'?{backupFailureId:prior.backupFailureId}:backup==='failed'?{backupFailureId:randomUUID()}:{})}
  const temp=path+'.'+randomUUID()+'.tmp',text=JSON.stringify(value)+'\n'
  await writeFile(temp,text,{mode:0o600,flag:'wx'})
  const fd=await open(temp,'r');try{await fd.sync()}finally{await fd.close()}
  await rename(temp,path)
  const parent=await open(dirname(path),'r');try{await parent.sync()}finally{await parent.close()}
  if(JSON.stringify(JSON.parse(await readFile(path,'utf8')))!==JSON.stringify(value))throw new Error('Brain initialization Health read-back failed')
}
