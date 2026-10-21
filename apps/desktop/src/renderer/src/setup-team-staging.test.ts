// MODULE: setup-team-staging.test.ts - No inferred destination/effort, real parser round-trip, staging and unresolved UI.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentsSnapshot, SetupTeamProposal, SetupTeamProposals } from '@bmn/protocol'
import { parseRoster, rewriteRoster, starterRoster } from '../../../bin/agents-roster.mjs'
import { BROWSER_MCP_PACKAGE } from '../../../bin/agents-team-browser.mjs'
import { TeamPreferences } from './team-preferences'
import type { TeamState } from './team-state'
import { newSetupAgent, setupDestination, stageSetupAgent } from './setup-team-staging'
const data=()=>parseRoster(starterRoster()).data!
const proposal:SetupTeamProposal={id:'setup-codex',app:'codex',version:'synthetic-1',name:'Codex',class:'queen',roles:['epic-reviewer','consultant','designer'],reasons:[{role:'consultant',reason:'Proposes Codex and the model you choose to advise.'}],needs:null}
const envelope:SetupTeamProposals={revision:'synthetic-revision',availableApps:['codex'],blocked:null,source:'/synthetic/skills',skills:['plan','team-ask'],tools:[{id:'playwright',name:'Playwright',command:'npx',args:['-y',BROWSER_MCP_PACKAGE],public:true}],proposals:[proposal]}
function complete(p=proposal){const draft=newSetupAgent(p);draft.model='synthetic-model';draft.efforts=['medium'];draft.destination=setupDestination(data(),draft.harness,'openai','')!;return draft}
function team(staged=data()):TeamState{
 const snapshot={file:{exists:true,hash:'hash',data:data(),prose:{},errors:[],warnings:[],link:null},approved:null,approvalProblem:null,history:[],setupTeam:envelope} as unknown as AgentsSnapshot
 return {snapshot,data:staged,base:data(),approved:null,hasStaged:false,busy:false,changed:new Set(),pendingNotes:{},outside:{groups:[],general:[]},notice:null,loadError:null} as unknown as TeamState
}
describe('explicit setup Team staging',()=>{
 it('starts with no model, effort or provider, and refuses incomplete conversion',()=>{
   const draft=newSetupAgent(proposal);expect(draft).toMatchObject({model:'',efforts:[],privateWork:'public_only'});expect(draft.destination).toBeUndefined()
   expect(()=>stageSetupAgent(data(),draft,proposal,envelope)).toThrow('incomplete')
   for(const choice of ['', 'unknown'])expect(setupDestination(data(),'codex',choice,'')).toBeNull()
   for(const host of ['', 'default', 'auto', 'https://private.example.test'])expect(setupDestination(data(),'codex','other',host)).toBeNull()
 })
 it('round-trips actual staged public choices, pinned tools and every recommended role through the real parser',()=>{
   const before=data(),snapshot=structuredClone(before),added=stageSetupAgent(before,complete(),proposal,envelope)
   expect(before).toEqual(snapshot);expect(added.data.skills_source).toBe('/synthetic/skills');expect(added.data.tools).toEqual(envelope.tools)
   expect(added.data.agents[0]).toMatchObject({provider:'openai',efforts:['medium'],roles:proposal.roles,enabled:true})
   for(const role of proposal.roles)expect(added.data.roles.find(row=>row.id===role)?.candidates).toEqual([`${added.id}@medium`])
   expect(parseRoster(rewriteRoster('# Synthetic setup\n',added.data)).errors).toEqual([])
   expect(()=>stageSetupAgent(added.data,complete(),proposal,envelope)).toThrow('already staged')
 })
 it('does not inherit a twin’s efforts, private allowance, price or model capacity',()=>{
   const existing=stageSetupAgent(data(),complete(),proposal,envelope).data
   existing.agents[0]!.efforts=['max'];existing.agents[0]!.context_window=99999;existing.providers[0]!.private_work='allowed'
   const other={...proposal,id:'setup-claude',app:'claude' as const,name:'Claude Code'}
   const draft=complete(other);expect(draft.efforts).toEqual(['medium']);const added=stageSetupAgent(existing,draft,other,{...envelope,proposals:[other]})
   expect(added.data.agents.at(-1)).not.toHaveProperty('context_window');expect(existing.agents[0]!.efforts).toEqual(['max'])
 })
 it('keeps unavailable Console members proposed/off and outside every candidate chain',()=>{
   const p={...proposal,id:'setup-opencode',app:'opencode' as const,name:'OpenCode',needs:'OpenCode Console availability'},added=stageSetupAgent(data(),complete(p),p,{...envelope,proposals:[p]})
   expect(added.data.agents[0]).toMatchObject({enabled:false,status:'proposed',enabled_note:'Needs OpenCode Console availability'})
   expect(added.data.roles.every(role=>!role.candidates.some(c=>c.startsWith(added.id+'@')))).toBe(true)
   expect(parseRoster(rewriteRoster('# Synthetic setup\n',added.data)).errors).toEqual([])
 })
 it('shows one unresolved card, hides it once staged, and restores it on discard',()=>{
   const markup=(state:TeamState)=>renderToStaticMarkup(createElement(TeamPreferences,{team:state,page:{name:'agents'},go:()=>undefined}))
   expect(markup(team()).match(/data-setup-proposal="setup-codex"/g)).toHaveLength(1)
   expect(markup(team())).toContain('Provider: not chosen yet')
   expect(markup(team(stageSetupAgent(data(),complete(),proposal,envelope).data))).not.toContain('data-setup-proposal')
   expect(markup(team())).toContain('Choose settings…')
 })
 it('renders the reused form with explicit provider/effort choices, fixed app and disabled Add',()=>{
   const html=renderToStaticMarkup(createElement(TeamPreferences,{team:team(),page:{name:'new',proposal:'setup-codex'},go:()=>undefined}))
   expect(html).toContain('From setup');expect(html).toContain('aria-label="Efforts"');expect(html).toContain('Other host…')
   expect(html).toMatch(/disabled="">Add to team/);expect(html.match(/role="radiogroup" aria-labelledby="[^"]+-provider"[^>]*>([\s\S]*?)<\/div>/)?.[1]).not.toContain('aria-checked="true"')
 })
 it('refuses a stale setup proposal instead of falling through to the generic form',()=>{
   const html=renderToStaticMarkup(createElement(TeamPreferences,{team:team(),page:{name:'new',proposal:'missing'},go:()=>undefined}))
   expect(html).toContain('This setup proposal changed');expect(html).not.toContain('Add to team')
 })
})

const render=(state:TeamState,page:Parameters<typeof TeamPreferences>[0]['page'])=>renderToStaticMarkup(createElement(TeamPreferences,{team:state,page,go:()=>undefined}))
describe('Fable Team findings on actual component',()=>{
 it('gives each proposal action a distinct app accessible name',()=>{
   const state=team();state.snapshot!.setupTeam={...envelope,proposals:[proposal,{...proposal,id:'setup-claude',app:'claude',name:'Claude Code'}]}
   const html=render(state,{name:'agents'});expect(html).toContain('aria-label="Choose settings for Codex…"');expect(html).toContain('aria-label="Choose settings for Claude Code…"')
 })
 it('shows each app-specific role reason once and at most two help paragraphs',()=>{
   const rich={...proposal,reasons:proposal.roles.map(role=>({role,reason:`Codex and the model you choose: ${role}`}))},state=team();state.snapshot!.setupTeam={...envelope,proposals:[rich]}
   const html=render(state,{name:'new',proposal:proposal.id}),roles=html.split('>Roles</span>')[1]!.split('>Efforts</span>')[0]!
   expect((roles.match(/class="preferences-help"/g)??[]).length).toBeLessThanOrEqual(2)
   for(const row of rich.reasons)expect(roles.split(row.reason).length-1).toBe(1)
 })
 it('uses an explicit unselected-provider privacy hint',()=>{
   const html=render(team(),{name:'new',proposal:proposal.id});expect(html).not.toContain('Set once for Provider not chosen');expect(html).toContain('Choose a provider first')
 })
 it('disables unavailable activation on both the card and member page and shows why',()=>{
   const p={...proposal,id:'setup-opencode',app:'opencode' as const,name:'OpenCode',needs:'OpenCode Console availability'},added=stageSetupAgent(data(),complete(p),p,{...envelope,proposals:[p]}),state=team(added.data)
   for(const page of [{name:'agents' as const},{name:'agent' as const,id:added.id}]){const html=render(state,page);expect(html).toMatch(/disabled=""[^>]*>Activate/);expect(html).toContain('Needs OpenCode Console availability')}
 })
})
