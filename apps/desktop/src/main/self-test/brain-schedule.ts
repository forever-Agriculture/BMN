// MODULE: brain-schedule.ts - Move the clock through the nightly backup cutoff in isolated Electron
import {existsSync,lstatSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {METHOD_REGISTRY} from '@bmn/protocol'
import type {PtyHostClient} from '../pty-host-client'

export async function runBrainScheduleSelfTest(client:PtyHostClient,dataRoot:string) {
  const root=join(dataRoot,'brain-backups'),year=new Date().getUTCFullYear()+1
  const date=year+'-02-02',previous=year+'-02-01'
  const tick=(now:string)=>client.request<string|null>(METHOD_REGISTRY.healthGet,{selfTestBrainClock:now})
  const slot=join(root,'nightly-'+date)
  const before=await tick(date+'T02:59:59.000Z')
  if(before!==join(root,'nightly-'+previous)||existsSync(slot))throw new Error('The Brain self-test did not catch up the previous night without publishing the future slot')
  const atBoundary=await tick(date+'T03:00:00.000Z')
  if(atBoundary!==slot||!lstatSync(join(slot,'brain.sqlite3')).isFile())throw new Error('The Brain self-test did not publish its database at 03:00')
  const manifest=JSON.parse(readFileSync(join(slot,'manifest.json'),'utf8'))
  if(manifest.version!==3||manifest.createdAt!==date+'T03:00:00.000Z')throw new Error('The Brain self-test published the wrong snapshot slot')
  const repeat=await tick(date+'T03:00:01.000Z')
  if(repeat!==null)throw new Error('The Brain self-test published twice for one slot')
  const health=JSON.parse(readFileSync(join(dataRoot,'brain-health.json'),'utf8'))
  if(health.backup!=='ok')throw new Error('The Brain self-test did not record a healthy scheduled backup')
  return {previous,scheduled:date,duplicate:false,health:health.backup}
}
