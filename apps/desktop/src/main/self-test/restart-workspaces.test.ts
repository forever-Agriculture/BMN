// MODULE: restart-workspaces.test.ts - Captured old-count RED and exact identity/state negatives.
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '@bmn/protocol'
import { workspaceRestorationMatches } from './restart-workspaces'
const ids=['synthetic-default','synthetic-archived','synthetic-select','synthetic-routing']
const rows=():WorkspaceRecord[]=>ids.map((workspaceId,position)=>({workspaceId,name:workspaceId,defaultCwd:'/synthetic',pinnedFilePaths:['/synthetic/file'],position,marker:'none',archivedAt:null,revision:1}))
describe('self-test workspace restart',()=>{
  it('replays old count RED and exact four creation receipts GREEN without mutating inputs',()=>{
    const before=rows(),after=rows(),original=structuredClone({ids,before,after})
    expect(after.length!==3).toBe(true)
    expect(workspaceRestorationMatches(ids,before,after)).toBe(true)
    expect({ids,before,after}).toEqual(original)
  })
  it.each(['missing','extra','substituted','duplicate','reordered'] as const)('rejects %s workspace identities',kind=>{
    const after=rows()
    if(kind==='missing')after.pop()
    if(kind==='extra')after.push({...after[0]!,workspaceId:'unexpected'})
    if(kind==='substituted')after[2]!.workspaceId='unexpected'
    if(kind==='duplicate')after[2]!.workspaceId=after[1]!.workspaceId
    if(kind==='reordered')after.reverse()
    expect(workspaceRestorationMatches(ids,rows(),after)).toBe(false)
  })
  it('rejects a duplicated or substituted expected ID and an already wrong baseline',()=>{
    expect(workspaceRestorationMatches([ids[0]!,ids[0]!,ids[2]!,ids[3]!],rows(),rows())).toBe(false)
    expect(workspaceRestorationMatches([...ids.slice(0,3),'unexpected'],rows(),rows())).toBe(false)
    expect(workspaceRestorationMatches(ids,rows().slice(1),rows())).toBe(false)
  })
  it.each(['name','defaultCwd','pinnedFilePaths','position','marker','archivedAt','revision'] as const)('rejects changed %s metadata',field=>{
    const after=rows(),changes={name:'changed',defaultCwd:null,pinnedFilePaths:[],position:99,marker:'teal',archivedAt:'2026-10-21T00:00:00Z',revision:2}
    Object.assign(after[2]!,{[field]:changes[field]});expect(workspaceRestorationMatches(ids,rows(),after)).toBe(false)
  })
})
