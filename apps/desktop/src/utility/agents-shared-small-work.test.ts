// MODULE: agents-shared-small-work.test.ts - Epic120.2: shared Small work survives real approval and both resolution paths
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseRoster, rewriteRoster, roleChain, type RosterData } from '../../bin/agents-roster.mjs'
import { readApproved, readValidRoster, generationPath } from '../../bin/agents-state.mjs'
import { approveRoster, saveAndApprove } from '../main/agents-approval'
import { resolveTeammate } from '../../bin/agents-team-resolve.mjs'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const previousHome = process.env.HOME
let home: string
const context = { project: '/synthetic/shared-review', standing: () => 'proven', allowed: () => ({ allowed: true }), projectChoice: () => null }
const spellings = [{ role: 'small-epic-reviewer' }, { role: 'epic-reviewer', smallWork: true }]
const selected = (data: RosterData, request: typeof spellings[number]) => {
  const result = resolveTeammate(data, request, context)
  return { agent: result.agent.id, effort: result.effort }
}
const shown = () => ({ generation: readApproved().number, fileHash: readValidRoster().hash })
const persist = (data: RosterData) => saveAndApprove(shown(), data, { checkInspectedRoutes: () => {} })
const linked = (): RosterData => {
  const data = structuredClone(readApproved().data)
  data.roles.find(role => role.id === 'epic-reviewer')!.small_work = { role: 'small-epic-reviewer' }
  data.roles.push({ id: 'small-epic-reviewer', candidates: ['astra@low', 'fable@medium'], then: 'blocked', read_only: true, recheck: { same_reviewer: true, astra: 'low' } })
  for (const agent of data.agents) if (['astra', 'fable'].includes(agent.id)) agent.roles.push('small-epic-reviewer')
  return data
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-shared-small-work-'))); process.env.HOME = home
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), EXAMPLE)
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
})
afterEach(() => { process.env.HOME = previousHome; rmSync(home, { recursive: true, force: true }) })

it('stores a reference rather than two reviewer values, preserving the full chain and historical generation', () => {
  const old = readFileSync(generationPath(1), 'utf8')
  const data = linked(); const text = rewriteRoster(EXAMPLE, data); const parsed = parseRoster(text)
  expect(parsed.errors).toEqual([]); expect(parsed.data).toEqual(data)
  persist(data)
  const fresh = readApproved().data
  expect(fresh.roles.find(role => role.id === 'epic-reviewer')!.small_work).toEqual({ role: 'small-epic-reviewer' })
  expect(fresh.roles.find(role => role.id === 'small-epic-reviewer')!.candidates).toEqual(['astra@low', 'fable@medium'])
  expect(readFileSync(generationPath(1), 'utf8')).toBe(old)
  expect(spellings.map(request => selected(fresh, request))).toEqual([{agent:'astra',effort:'low'}, {agent:'astra',effort:'low'}])
})

it('an agent and effort edit persists after approval and both command resolutions and summaries update', () => {
  persist(linked())
  const initial = readApproved().data
  const changed = structuredClone(initial)
  changed.roles.find(role => role.id === 'small-epic-reviewer')!.candidates = ['fable@high', 'astra@low']
  persist(changed)
  const fresh = readApproved().data
  expect(spellings.map(request => selected(fresh, request))).toEqual([{agent:'fable',effort:'high'}, {agent:'fable',effort:'high'}])
  const cli = (role: string) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../bin/bmn', import.meta.url)), 'roster', 'role', role, '--json'], {cwd:home,env:{HOME:home,PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000}))
  const outer = cli('epic-reviewer'), dedicated = cli('small-epic-reviewer')
  expect(outer.ok).toBe(true); expect(dedicated.ok).toBe(true)
  expect(outer.small_work.candidates.map((entry: {agent:string;efforts:string[]}) => ({agent:entry.agent,efforts:entry.efforts}))).toEqual(dedicated.candidates.map((entry: {agent:string;efforts:string[]}) => ({agent:entry.agent,efforts:entry.efforts})))
  expect(outer.small_work.candidates[0]).toMatchObject({agent:'fable',efforts:['high']})
  expect(roleChain(fresh, 'epic-reviewer').small_work).toMatchObject({ role: 'small-epic-reviewer', candidates: [{agent:'fable',efforts:['high']}, {agent:'astra',efforts:['low']}] })
  expect(roleChain(fresh, 'small-epic-reviewer').candidates).toEqual((roleChain(fresh, 'epic-reviewer').small_work as {candidates:unknown}).candidates)
  expect(fresh.roles.find(role => role.id === 'epic-reviewer')!.candidates).toEqual(initial.roles.find(role => role.id === 'epic-reviewer')!.candidates)
})

it('uses the same fallback and effort refusal through either command', () => {
  const data = linked(); data.agents.find(agent => agent.id === 'astra')!.enabled = false
  for (const request of spellings) {
    expect(selected(data, request)).toEqual({agent:'fable',effort:'medium'})
    expect(() => resolveTeammate(data, {...request, effort:'low'}, context)).toThrow(expect.objectContaining({code:'EFFORT_NOT_ALLOWED'}))
  }
})

it('does not bypass privacy or an outer project choice through the dedicated role name', () => {
  const data = linked()
  for (const request of spellings) {
    expect(() => resolveTeammate(data, request, {...context, allowed: () => ({allowed:false,reason:'synthetic privacy refusal'})})).toThrow(expect.objectContaining({code:'AGENT_NOT_ELIGIBLE'}))
    expect(() => resolveTeammate(data, request, {...context, projectChoice: role => role.id === 'epic-reviewer' ? {id:'synthetic-choice',agent:'astra'} : null})).toThrow(expect.objectContaining({code:'PROJECT_CHOICE_CONFLICT'}))
  }
})

it('keeps old earlier-reviewer and project binding even after initial order changes', () => {
  const data = linked(); data.roles.find(role => role.id === 'small-epic-reviewer')!.candidates.reverse()
  for (const role of ['epic-reviewer', 'small-epic-reviewer']) {
    const recheck = {id:'20261111T010101-abcdef12',run:{role, project:context.project,agent:'astra',phase:'small-work'}}
    expect(resolveTeammate(data, {role,recheck}, context)).toMatchObject({agent:{id:'astra'},effort:'low'})
    expect(() => resolveTeammate(data, {role,recheck}, {...context,project:'/synthetic/wrong'})).toThrow(expect.objectContaining({code:'RECHECK_INVALID'}))
  }
})

it('rejects dangling and nested references rather than guessing a reviewer', () => {
  const data = linked(); data.roles = data.roles.filter(role => role.id !== 'small-epic-reviewer')
  expect(parseRoster(rewriteRoster(EXAMPLE, data)).data).toBeNull()
  const nested = linked(); nested.roles.find(role => role.id === 'small-epic-reviewer')!.small_work = {role:'small-epic-reviewer'}
  expect(parseRoster(rewriteRoster(EXAMPLE, nested)).data).toBeNull()
})

it('named initial and missing-receipt efforts read the referenced configuration too', () => {
  const data = linked()
  data.roles.find(role => role.id === 'small-epic-reviewer')!.candidates = ['sol@xhigh']
  data.agents.find(agent => agent.id === 'sol')!.roles.push('epic-reviewer', 'small-epic-reviewer')
  expect(resolveTeammate(data, {role:'epic-reviewer',agent:'sol'}, context)).toMatchObject({agent:{id:'sol'},effort:'xhigh'})
  expect(resolveTeammate(data, {role:'epic-reviewer',agent:'sol',effort:'xhigh',recheck:{id:'20261111T010101-abcdef12',run:null}}, context)).toMatchObject({agent:{id:'sol'},effort:'xhigh'})
})

it.each(['astra@low', 'fable@medium', undefined])('keeps legacy value %s until an explicit link is approved without losing the dedicated chain', scalar => {
  const data = linked()
  const outer = data.roles.find(role => role.id === 'epic-reviewer')!
  if (scalar === undefined) delete outer.small_work
  else outer.small_work = scalar
  persist(data)
  const old = readFileSync(generationPath(readApproved().number), 'utf8')
  const oldNumber = readApproved().number
  const target = structuredClone(readApproved().data.roles.find(role => role.id === 'small-epic-reviewer'))
  expect(readApproved().data.roles.find(role => role.id === 'epic-reviewer')!.small_work).toBe(scalar)
  const explicit = structuredClone(readApproved().data)
  explicit.roles.find(role => role.id === 'epic-reviewer')!.small_work = {role:'small-epic-reviewer'}
  persist(explicit)
  expect(readApproved().data.roles.find(role => role.id === 'small-epic-reviewer')).toEqual(target)
  expect(readFileSync(generationPath(oldNumber), 'utf8')).toBe(old)
  expect(spellings.map(request => selected(readApproved().data, request))).toEqual([{agent:'astra',effort:'low'}, {agent:'astra',effort:'low'}])
})

it('retains a legacy scalar with no dedicated role rather than inventing a choice or role grant', () => {
  const original = readApproved().data
  const parsed = parseRoster(rewriteRoster(EXAMPLE, original))
  expect(parsed.errors).toEqual([])
  expect(parsed.data).toEqual(original)
  expect(parsed.data!.roles.some(role => role.id === 'small-epic-reviewer')).toBe(false)
})

it('enforces dedicated choices and outer membership on both shared entry points', () => {
  const data = linked()
  const choice = {...context,projectChoice: (role: RosterData['roles'][number]) => role.id === 'small-epic-reviewer' ? {id:'synthetic-small-choice',agent:'fable',effort:'medium'} : null}
  for (const request of spellings) expect(resolveTeammate(data, request, choice)).toMatchObject({agent:{id:'fable'},effort:'medium',choice:'synthetic-small-choice'})
  data.agents.find(agent => agent.id === 'astra')!.roles = ['small-epic-reviewer']
  for (const request of spellings) expect(selected(data, request)).toEqual({agent:'fable',effort:'medium'})
  data.agents.find(agent => agent.id === 'fable')!.roles = ['small-epic-reviewer']
  for (const request of spellings) expect(() => selected(data, request)).toThrow(expect.objectContaining({code:'AGENT_NOT_ELIGIBLE'}))
})

it('refuses a known shared recheck when its explicit link has been removed', () => {
  const data=linked();data.roles.find(role=>role.id==='epic-reviewer')!.small_work='astra@low'
  expect(()=>resolveTeammate(data,{role:'epic-reviewer',recheck:{id:'20261111T010101-abcdef12',run:{role:'epic-reviewer',agent:'astra',project:context.project,phase:'recheck',configuration_role:'small-epic-reviewer'}}},context)).toThrow(expect.objectContaining({code:'RECHECK_INVALID'}))
})
