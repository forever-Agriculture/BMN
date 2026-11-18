// MODULE: brain-cutover-delivery.test.ts - Committed reporting preserves origin and notification uncertainty
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect,vi} from 'vitest'
import {deliverBrainCutover,startBrainDeliveryRetry} from './brain-cutover-delivery'
it('does not call a reservation a sent notification, or send an uncertain one twice',async()=>{
 const root=mkdtempSync(join(tmpdir(),'brain-report-')),folder=join(root,'brain-cutover'),receipt=join(folder,'delivery.json')
 try {
  mkdirSync(folder);writeFileSync(receipt,JSON.stringify({marker:true,result:true,board:true,notification:'reserved'}))
  const execute=vi.fn(async()=>({stdout:''}))
  await deliverBrainCutover({state:root,project:root,bin:root,proof:{ok:true},commit:'a'.repeat(40),execute})
  expect(execute).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(receipt,'utf8')).notification).toBe('uncertain')
  await deliverBrainCutover({state:root,project:root,bin:root,proof:{ok:true},commit:'a'.repeat(40),execute})
  expect(execute).not.toHaveBeenCalled()
 }finally{rmSync(root,{recursive:true,force:true})}
})
it('records confirmed delivery and retries only a known failed notification',async()=>{
 const root=mkdtempSync(join(tmpdir(),'brain-report-')),folder=join(root,'brain-cutover'),receipt=join(folder,'delivery.json')
 try {
  mkdirSync(folder);writeFileSync(receipt,JSON.stringify({marker:true,result:true,board:true}))
  const execute=vi.fn().mockRejectedValueOnce(Object.assign(new Error('not delivered'),{code:1})).mockResolvedValue({stdout:''})
  const options={state:root,project:root,bin:root,proof:{ok:true},commit:'b'.repeat(40),execute}
  await expect(deliverBrainCutover(options)).rejects.toThrow('not delivered')
  expect(JSON.parse(readFileSync(receipt,'utf8')).notification).toBe('failed')
  await deliverBrainCutover(options);expect(JSON.parse(readFileSync(receipt,'utf8')).notification).toBe('sent')
  await deliverBrainCutover(options);expect(execute).toHaveBeenCalledTimes(2)
 }finally{rmSync(root,{recursive:true,force:true})}
})
it('retries reporting while the app stays open, with no overlapping delivery or migration',async()=>{
 vi.useFakeTimers()
 const root=mkdtempSync(join(tmpdir(),'brain-report-retry-')),journal=join(root,'brain-cutover','journal.json')
 let release:()=>void=()=>{}
 const deliver=vi.fn(()=>new Promise<void>(resolve=>{release=resolve})),onError=vi.fn()
 try {
  mkdirSync(join(root,'brain-cutover'));writeFileSync(journal,JSON.stringify({state:'running'}))
  const stop=startBrainDeliveryRetry({state:root,deliver,onError,interval:100})
  await vi.advanceTimersByTimeAsync(200);expect(deliver).not.toHaveBeenCalled()
  writeFileSync(journal,JSON.stringify({state:'complete',delivered:false}))
  await vi.advanceTimersByTimeAsync(300);expect(deliver).toHaveBeenCalledTimes(1)
  release();await vi.advanceTimersByTimeAsync(100);expect(deliver).toHaveBeenCalledTimes(2)
  writeFileSync(journal,JSON.stringify({state:'complete',delivered:true}));release()
  await vi.advanceTimersByTimeAsync(200);expect(deliver).toHaveBeenCalledTimes(2)
  stop();expect(onError).not.toHaveBeenCalled()
 }finally{vi.useRealTimers();rmSync(root,{recursive:true,force:true})}
})
