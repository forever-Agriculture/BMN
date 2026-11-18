// MODULE: brain-cutover-files.ts - Exact installed helper transport for atomic owned restores
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
export interface BrainFileIdentity {dev:number;ino:number}
export interface BrainAtomicRename {operation:'exchange'|'no-replace';source:string;target:string;sourceIdentity:BrainFileIdentity;targetIdentity:BrainFileIdentity|null}
export function brainAtomicRename(bin:string):(request:BrainAtomicRename)=>void {
 return request=>{
  const result=spawnSync('/usr/bin/python3',['-I',join(bin,'brain-cutover-files.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10_000,maxBuffer:8192})
  if(result.error)throw result.error
  if(result.status!==0)throw new Error(result.stderr.trim()||'The atomic brain restore did not complete')
 }
}
