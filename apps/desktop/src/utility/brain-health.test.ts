// MODULE: brain-health.test.ts - Startup failures cannot disappear from Health
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {readBrainHealth,recordBrainInitialization} from './brain-health'
it('distinguishes no brain from an existing brain with no valid worker status',()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-health-')),data=join(root,'data'),state=join(root,'state')
 const env={BMN_DATA_HOME:data,BMN_STATE_HOME:state}
 try {
  mkdirSync(data);mkdirSync(state)
  expect(readBrainHealth(env,root)).toBeNull()
  writeFileSync(join(data,'brain.sqlite3'),'synthetic database placeholder')
  expect(readBrainHealth(env,root)).toMatchObject({backup:'unverified',export:'unverified'})
  writeFileSync(join(data,'brain-health.json'),JSON.stringify({backup:'ok',export:'ok',checkedAt:'synthetic'}))
  expect(readBrainHealth(env,root)).toMatchObject({backup:'ok',export:'ok'})
  writeFileSync(join(state,'brain-cutover-recovery-error.json'),'{}')
  expect(readBrainHealth(env,root)).toMatchObject({recovery:'failed'})
 }finally{rmSync(root,{recursive:true,force:true})}
})

it('shows pending/failed initialization before a database exists and retains the last backup failure and success',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bmn-brain-health-init-')),env={BMN_DATA_HOME:root}
 try {
  await recordBrainInitialization(root)
  expect(readBrainHealth(env,root)).toMatchObject({backup:'unverified',export:'unverified'})
  writeFileSync(join(root,'brain-health.json'),JSON.stringify({backup:'failed',export:'ok',checkedAt:'synthetic',backupLastSuccess:'2026-01-01',backupFailureAt:'2026-01-02'}))
  await recordBrainInitialization(root)
  expect(readBrainHealth(env,root)).toMatchObject({backup:'failed',export:'unverified',backupLastSuccess:'2026-01-01',backupFailureAt:'2026-01-02'})
  await recordBrainInitialization(root,true)
  expect(readBrainHealth(env,root)).toMatchObject({backup:'failed',export:'failed',backupLastSuccess:'2026-01-01',backupFailureAt:'2026-01-02'})
 }finally{rmSync(root,{recursive:true,force:true})}
})
