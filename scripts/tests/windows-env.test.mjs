import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

it('resolves SystemRoot inside an actual case-sensitive worker environment', async () => {
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
(async()=>{const {windowsEnvironmentValue}=await import(workerData.moduleUrl);
parentPort.postMessage({exactPresent:typeof process.env.SystemRoot==='string',root:windowsEnvironmentValue(process.env,'SystemRoot')})})();`,
  { eval: true, env: { SYSTEMROOT: 'C:\\Windows', PRIVATE_SYNTHETIC: 'unused' },
    workerData: { moduleUrl: new URL('../../apps/desktop/bin/windows-env.mjs', import.meta.url).href } })
  const exited = once(worker, 'exit'), message = once(worker, 'message')
  expect((await message)[0]).toEqual({ exactPresent: false, root: 'C:\\Windows' })
  expect((await exited)[0]).toBe(0)
})

it('accepts matching duplicate names and refuses conflicting values without exposing them', () => {
  expect(windowsEnvironmentValue({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' }, 'SystemRoot')).toBe('C:\\Windows')
  expect(() => windowsEnvironmentValue({ SystemRoot: 'PRIVATE_ONE', SYSTEMROOT: 'PRIVATE_TWO' }, 'SystemRoot'))
    .toThrow('Conflicting Windows environment values for SystemRoot')
  expect(windowsEnvironmentValue({ Other: 'unused' }, 'SystemRoot')).toBeUndefined()
})
