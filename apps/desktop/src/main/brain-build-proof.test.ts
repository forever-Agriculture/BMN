// MODULE: brain-build-proof.test.ts - Pending/failed records never replace completed build provenance
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {it,expect} from 'vitest'
import {proveBrainBuild} from './brain-build-proof'
import {brainFileHash,brainResourcesHash} from '../../../../scripts/lib/brain-provenance.mjs'
it('requires running binary plus app resources, while retaining earlier completed installs',()=>{
 const root=mkdtempSync(join(tmpdir(),'brain-build-'))
 try {
  mkdirSync(join(root,'proc','42'),{recursive:true});mkdirSync(join(root,'completed'))
  const binary=join(root,'bmn'),archive=join(root,'app.asar');writeFileSync(binary,'binary');writeFileSync(archive,'brain code');symlinkSync(binary,join(root,'proc','42','exe'))
  const commit='a'.repeat(40),digest=(s:string)=>createHash('sha256').update(s).digest('hex')
  writeFileSync(join(root,'brain-delivery.json'),JSON.stringify({version:1,epic:126,commit}))
  const record={phase:'complete',commit,brainDeliveryCommit:commit,binary,archive,binaryHash:digest('binary'),archiveHash:digest('brain code'),brainVersion:126}
  const prove=()=>proveBrainBuild({stateDirectory:root,pid:42,archive,procRoot:join(root,'proc'),contains:c=>c===commit})
  for(const phase of ['queued','waiting-for-exit','building','failed']){writeFileSync(join(root,'latest.json'),JSON.stringify({...record,phase}));expect(prove).toThrow(/no completed/)}
  writeFileSync(join(root,'completed',commit+'.json'),JSON.stringify(record))
  expect(prove().commit).toBe(commit)
  expect(()=>proveBrainBuild({stateDirectory:root,pid:42,archive,procRoot:join(root,'proc'),contains:()=>false})).toThrow(/no completed/)
  writeFileSync(join(root,'brain-delivery.json'),JSON.stringify({version:1,epic:126,commit:'c'.repeat(40)}));expect(prove).toThrow(/no completed/)
  writeFileSync(join(root,'brain-delivery.json'),JSON.stringify({version:1,epic:126,commit}))
  writeFileSync(archive,'old code');expect(prove).toThrow(/no completed/)
  writeFileSync(archive,'brain code');writeFileSync(binary,'other runtime');expect(prove).toThrow(/no completed/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

it('refuses changed helper, skill or prepared-config bytes before issuing authority',()=>{
 const root=mkdtempSync(join(tmpdir(),'brain-resources-'))
 try {
  const resources=join(root,'resources');mkdirSync(join(resources,'bin'),{recursive:true});mkdirSync(join(resources,'skills'));mkdirSync(join(root,'proc','42'),{recursive:true})
  const helper=join(resources,'bin','peer.py'),skill=join(resources,'skills','brain.md'),config=join(root,'prepared.json'),binary=join(root,'bmn'),archive=join(resources,'app.asar')
  for(const path of [helper,skill,config,binary,archive])writeFileSync(path,'original')
  symlinkSync(binary,join(root,'proc','42','exe'))
  writeFileSync(join(root,'brain-delivery.json'),JSON.stringify({version:1,epic:126,commit:'b'.repeat(40)}))
  const record={phase:'complete',commit:'b'.repeat(40),brainDeliveryCommit:'b'.repeat(40),binary,archive,binaryHash:brainFileHash(binary),archiveHash:brainFileHash(archive),resourcesHash:brainResourcesHash(resources),preparedHash:brainFileHash(config),brainVersion:126}
  writeFileSync(join(root,'latest.json'),JSON.stringify(record))
  const prove=()=>proveBrainBuild({stateDirectory:root,pid:42,archive,resources,preparedPath:config,procRoot:join(root,'proc'),contains:()=>true})
  const verified=prove();expect(verified.commit).toBe(record.commit)
  expect(verified.preparation).toEqual({text:'original',sha256:record.preparedHash})
  writeFileSync(config,'replaced after proof');expect(verified.preparation?.text).toBe('original');writeFileSync(config,'original')
  for(const path of [helper,skill,config]){writeFileSync(path,'changed');expect(prove).toThrow(/no completed/);writeFileSync(path,'original')}
 }finally{rmSync(root,{recursive:true,force:true})}
})
