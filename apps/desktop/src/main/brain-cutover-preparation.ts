// MODULE: brain-cutover-preparation.ts - Complete frozen-method start-text groups and per-file byte receipts
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrainPreparationSnapshot } from './brain-build-proof'
export interface BrainStartTextGroup {app:'claude'|'codex';project:'BMN'|'b2buster';paths:string[]}
export interface BrainStartTextReceipt extends BrainStartTextGroup {bytes:number;files:{path:string;bytes:number;sha256:string}[]}
/** The same global/project/index files used by the frozen baseline's always-on-byte method. */
export function brainStartTextGroups(home=homedir()):BrainStartTextGroup[] {
  const groups:BrainStartTextGroup[]=[]
  for(const [project,folder,rules]of [
    ['BMN',join(home,'code','BMN'),'AGENTS.md'],
    ['b2buster',join(home,'code','Project2','b2buster-ai'),'CLAUDE.md']
  ] as const){
    for(const app of ['claude','codex'] as const){
      const paths=[join(home,app==='claude'?'.claude':'.codex',app==='claude'?'CLAUDE.md':'AGENTS.md'),join(folder,rules)]
      const index=join(home,'.claude','projects',folder.replaceAll('/','-'),'memory','MEMORY.md')
      if(app==='claude'&&existsSync(index))paths.push(index)
      groups.push({app,project,paths})
    }
  }
  return groups
}
export function validateBrainStartText(value:unknown,home=homedir()):asserts value is BrainStartTextGroup[] {
  if(!Array.isArray(value)||value.length!==4)throw new Error('Brain preparation requires all four Claude/Codex and BMN/B2Buster start-text groups')
  const expected=brainStartTextGroups(home),seen=new Set<string>()
  for(const item of value){
    if(!item||typeof item!=='object'||!Array.isArray(item.paths)||item.paths.some((path:unknown)=>typeof path!=='string'))throw new Error('Invalid brain start-text file group')
    const group=item as BrainStartTextGroup,key=group.app+'/'+group.project
    const required=expected.find(row=>row.app===group.app&&row.project===group.project)
    if(!required||seen.has(key)||new Set(group.paths).size!==group.paths.length||JSON.stringify([...group.paths].sort())!==JSON.stringify([...required.paths].sort()))throw new Error('Brain start-text file membership differs from the frozen method: '+key)
    seen.add(key)
  }
}
export function brainStartTextBytes(groups:BrainStartTextGroup[]):BrainStartTextReceipt[] {
  return groups.map(group=>{
    const files=group.paths.map(path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}})
    return {...group,paths:[...group.paths],files,bytes:files.reduce((total,file)=>total+file.bytes,0)}
  })
}
export function assertBrainStartTextDidNotGrow(before:BrainStartTextReceipt[],after:BrainStartTextReceipt[]):void {
  if(before.length!==4||after.length!==4)throw new Error('Brain start-text byte receipt is incomplete')
  for(const group of before){
    const next=after.find(row=>row.app===group.app&&row.project===group.project)
    if(!next||JSON.stringify(next.paths)!==JSON.stringify(group.paths)||next.bytes>group.bytes)throw new Error('Always-on session text grew or changed membership for '+group.app+'/'+group.project)
  }
}
export function checkedBrainPreparation(snapshot:BrainPreparationSnapshot,home=homedir()):BrainPreparationSnapshot {
  if(createHash('sha256').update(snapshot.text).digest('hex')!==snapshot.sha256)throw new Error('The brain preparation hash changed')
  const config=JSON.parse(snapshot.text) as Record<string,unknown>
  if(!config||config.version!==1||!['labels','projects','changes','indexes'].every(name=>Array.isArray(config[name]))||!config.instructionLines||typeof config.instructionLines!=='object'||Array.isArray(config.instructionLines))throw new Error('Invalid brain rehearsal preparation')
  validateBrainStartText(config.startText,home)
  const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value)}}
  freeze(config)
  return Object.freeze({text:snapshot.text,sha256:snapshot.sha256,value:config})
}
