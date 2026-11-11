// MODULE: agents-shared-small-work.test.ts - Epic120.2: shared Small work survives real approval and both resolution paths
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseRoster, rewriteRoster, roleChain, type RosterData } from '../../bin/agents-roster.mjs'
import { readApproved, readValidRoster, generationPath } from '../../bin/agents-state.mjs'
import { approveRoster, saveAndApprove } from '../main/agents-approval'
import { resolveTeammate } from '../../bin/agents-team-resolve.mjs'
import { moveCandidate, toggleCandidateEffort } from '../renderer/src/roster-staging'

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

it('a real staged agent and effort edit persists after approval and both command resolutions and summaries update', () => {
  persist(linked())
  const initial = readApproved().data
  const moved = moveCandidate(initial, 'small-epic-reviewer', 1, -1)
  const high = toggleCandidateEffort(moved, 'small-epic-reviewer', 'fable', 'high')
  const changed = toggleCandidateEffort(high, 'small-epic-reviewer', 'fable', 'medium')
  persist(changed)
  const fresh = readApproved().data
  expect(spellings.map(request => selected(fresh, request))).toEqual([{agent:'fable',effort:'high'}, {agent:'fable',effort:'high'}])
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
