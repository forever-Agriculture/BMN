// MODULE: brain-provenance.mjs - Hash every executable helper and shipped skill used by cutover
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync} from 'node:fs'
import {join,relative} from 'node:path'
export function brainFileHash(path){return createHash('sha256').update(readFileSync(path)).digest('hex')}
export function brainResourcesHash(root){
 const hash=createHash('sha256')
 function visit(path){
  const stat=lstatSync(path)
  if(stat.isSymbolicLink())throw new Error('Brain cutover resources must not be symbolic links')
  if(stat.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name));return}
  if(!stat.isFile())throw new Error('Brain cutover resource is not a regular file')
  hash.update(relative(root,path).replaceAll('\\','/')+'\0'+brainFileHash(path)+'\n')
 }
 for(const name of ['bin','skills'])visit(join(root,name))
 return hash.digest('hex')
}

export {brainStateRoot as brainCutoverStateRoot} from '../../apps/desktop/bin/brain-state.mjs'

/** The reviewed full-feature marker lands with delivery; first-parent history names its integration commit. */
export function brainDeliveryCommit(project,installedCommit){
 if(!/^[a-f0-9]{40,64}$/.test(installedCommit))throw new Error('Invalid installed brain commit')
 const marker='skills/brain/delivery.json'
 const checked=spawnSync('/usr/bin/git',['-C',project,'show',installedCommit+':'+marker],{encoding:'utf8',timeout:10_000,maxBuffer:16*1024})
 let value
 try{value=JSON.parse(checked.stdout)}catch{/* An incomplete or foreign build has no full-feature marker. */}
 if(checked.status!==0||value?.version!==1||value.epic!==126||value.feature!=='brain-store-and-owner-held-cutover')throw new Error('The committed brain delivery cannot be established')
 const history=spawnSync('/usr/bin/git',['-C',project,'log','--first-parent','--diff-merges=first-parent','--no-patch','--diff-filter=A','--format=%H',installedCommit,'--',marker],{encoding:'utf8',timeout:10_000})
 const commits=history.stdout?.trim().split('\n').filter(Boolean)??[]
 if(history.status!==0||commits.length!==1||!/^[a-f0-9]{40,64}$/.test(commits[0]))throw new Error('The committed brain delivery cannot be established')
 if(!brainContainsDelivery(project,commits[0],installedCommit))throw new Error('The installed build does not contain brain delivery')
 return commits[0]
}
export function brainContainsDelivery(project,delivery,installed){
 if(![delivery,installed].every(value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value)))return false
 return spawnSync('/usr/bin/git',['-C',project,'merge-base','--is-ancestor',delivery,installed],{encoding:'utf8',timeout:10_000}).status===0
}
