// MODULE: brain-backup-inventory.ts - One fail-closed inventory for checkpoint retention and object collection
import {lstatSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {validateBrainSnapshot} from './brain-snapshot'
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const scheduled=/^(?:nightly|weekly)-\d{4}-\d{2}-\d{2}$/
const privateCopy=new RegExp('^[a-z0-9-]+-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-'+uuid+'$')
const staging=new RegExp('^\\.[a-z0-9-]+(?:[TZa-z0-9.-]*)\\.'+uuid+'\\.tmp$')
const retired=new RegExp('^\\.retired-'+uuid+'$')
const markerStage=new RegExp('^schedule\\.json\\.'+uuid+'\\.tmp$')
/** A missing manifest is a corrupt checkpoint, never a reason to forget its objects. */
export function brainCheckpointInventory(root:string):string[]{
 const completed:string[]=[]
 for(const name of readdirSync(root)){
  const path=join(root,name),entry=lstatSync(path)
  if(entry.isSymbolicLink())throw new Error('Unsafe entry in Brain backup inventory: '+name)
  if(name==='objects'){if(!entry.isDirectory())throw new Error('Brain object store is not a directory');continue}
  if(name==='schedule.json'||markerStage.test(name)){if(!entry.isFile())throw new Error('Brain schedule entry has the wrong type');continue}
  if(staging.test(name)||retired.test(name)){if(!entry.isDirectory())throw new Error('Brain staging entry has the wrong type');continue}
  if(!(scheduled.test(name)||privateCopy.test(name))||!entry.isDirectory())throw new Error('Unexpected entry in Brain backup inventory: '+name)
  validateBrainSnapshot(path);completed.push(path)
 }
 return completed
}
