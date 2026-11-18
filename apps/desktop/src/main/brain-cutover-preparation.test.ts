// MODULE: brain-cutover-preparation.test.ts - Reject missing groups/files and measure actual before/after bytes
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import {createHash} from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it } from 'vitest'
import { brainStartTextGroups,validateBrainStartText,brainStartTextBytes,assertBrainStartTextDidNotGrow,checkedBrainPreparation } from './brain-cutover-preparation'
it('requires all four groups and every frozen-method file, including existing Claude memory indexes',()=>{
  const home=mkdtempSync(join(tmpdir(),'bmn-brain-start-text-'))
  try{
    const project=join(home,'code','BMN'),index=join(home,'.claude/projects',project.replaceAll('/','-'),'memory/MEMORY.md')
    mkdirSync(dirname(index),{recursive:true});writeFileSync(index,'Synthetic memory index.')
    const groups=brainStartTextGroups(home)
    expect(groups).toHaveLength(4);expect(()=>validateBrainStartText(groups,home)).not.toThrow()
    expect(()=>validateBrainStartText([],home)).toThrow(/four/)
    for(let group=0;group<4;group++){
      expect(()=>validateBrainStartText(groups.filter((_,i)=>i!==group),home)).toThrow()
      for(let file=0;file<groups[group]!.paths.length;file++){
        const missing=structuredClone(groups);missing[group]!.paths.splice(file,1)
        expect(()=>validateBrainStartText(missing,home)).toThrow(/membership/)
      }
    }
    const duplicate=structuredClone(groups);duplicate[1]=duplicate[0]!
    expect(()=>validateBrainStartText(duplicate,home)).toThrow(/membership/)
    const extra=structuredClone(groups);extra[0]!.paths.push(join(home,'foreign.md'))
    expect(()=>validateBrainStartText(extra,home)).toThrow(/membership/)
  }finally{rmSync(home,{recursive:true,force:true})}
})
it('records exact per-file/group hashes and bytes and rejects growth or a newly applicable memory index',()=>{
  const home=mkdtempSync(join(tmpdir(),'bmn-brain-start-bytes-'))
  try{
    const groups=brainStartTextGroups(home)
    for(const path of new Set(groups.flatMap(group=>group.paths))){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'Synthetic rules before.\n')}
    const before=brainStartTextBytes(groups)
    expect(before.every(group=>group.bytes===group.files.reduce((total,file)=>total+file.bytes,0))).toBe(true)
    expect(before.flatMap(group=>group.files).every(file=>file.bytes===24&&/^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
    writeFileSync(groups[0]!.paths[0]!,'Short rules.\n')
    const after=brainStartTextBytes(groups)
    expect(()=>assertBrainStartTextDidNotGrow(before,after)).not.toThrow()
    expect(after[0]!.files[0]!.sha256).not.toBe(before[0]!.files[0]!.sha256)
    writeFileSync(groups[1]!.paths[0]!,'Longer rules. '.repeat(100))
    expect(()=>assertBrainStartTextDidNotGrow(before,brainStartTextBytes(groups))).toThrow(/grew/)
    const index=join(home,'.claude/projects',join(home,'code','BMN').replaceAll('/','-'),'memory/MEMORY.md')
    mkdirSync(dirname(index),{recursive:true});writeFileSync(index,'New synthetic always-on index.')
    expect(()=>validateBrainStartText(groups,home)).toThrow(/membership/)
  }finally{rmSync(home,{recursive:true,force:true})}
})

it('checks the preparation hash itself and deeply freezes the once-parsed value',()=>{
 const home=mkdtempSync(join(tmpdir(),'bmn-brain-preparation-bytes-'))
 try{
  const config={version:1,labels:[],projects:[],changes:[],indexes:[],instructionLines:{},startText:brainStartTextGroups(home)},text=JSON.stringify(config)
  expect(()=>checkedBrainPreparation({text,sha256:'0'.repeat(64)},home)).toThrow(/hash|changed/)
  const checked=checkedBrainPreparation({text,sha256:createHash('sha256').update(text).digest('hex')},home)
  const value=checked.value as typeof config
  expect(Object.isFrozen(checked)).toBe(true);expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.startText[0]!.paths)).toBe(true)
  config.startText[0]!.paths.length=0
  expect(value.startText[0]!.paths.length).toBeGreaterThan(0)
  expect(()=>value.startText[0]!.paths.push('changed')).toThrow()
 }finally{rmSync(home,{recursive:true,force:true})}
})
