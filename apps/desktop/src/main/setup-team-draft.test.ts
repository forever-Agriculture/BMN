// MODULE: setup-team-draft.test.ts - Read-only unresolved proposals, provenance, revision and usable-approval fences.
import { describe, expect, it } from 'vitest'
import { SETUP_APPS, type AgentsSnapshot, type SetupAppsSnapshot } from '@bmn/protocol'
import { classRefusal, parseRoster, sha256, starterRoster } from '../../bin/agents-roster.mjs'
import { BROWSER_MCP_PACKAGE } from '../../bin/agents-team-browser.mjs'
import { buildSetupTeamProposals, validateSetupTeamApproval } from './setup-team-draft'
const hash=sha256(starterRoster())
const data=()=>parseRoster(starterRoster()).data!
function options(): Parameters<typeof buildSetupTeamProposals>[0] {
  return { profile: { state:'active',revision:1,workspaceId:null,updatedAt:'2026-10-21T00:00:00Z' },
    apps:{platform:'linux',checkedAt:'2026-10-21T00:00:00Z',curlAvailable:true,apps:SETUP_APPS.map(app=>({app,program:`/synthetic/${app}`,version:'synthetic-1',onPath:true,signIn:'ready',method:'oauth',qualification:'passed'}))} as SetupAppsSnapshot,
    roster:{rosterPath:'/synthetic/team.md',home:'/synthetic',file:{exists:true,hash,link:null,directory:'/synthetic',errors:[],warnings:[],data:data(),prose:{}},approved:null,approvalProblem:{code:'NOT_APPROVED',message:'Not approved',lastGood:null},differences:null,consequences:[],history:[]} as AgentsSnapshot,
    defaults:{code:'OK',source:'/synthetic/skills',names:['team-ask','plan'],rows:[]},starterHash:hash }
}
function staged(app='codex') {
  const o=options(), envelope=buildSetupTeamProposals(o)!, proposal=envelope.proposals.find(p=>p.app===app)!, next=data(),id=`synthetic-${app}`
  next.agents=[{id,name:proposal.name,class:'queen',harness:proposal.app,model:'synthetic-model',provider:'synthetic-provider',host:'default',efforts:['medium'],roles:[],enabled:!proposal.needs,status:proposal.needs?'proposed':'active'}]
  next.providers=[{id:'synthetic-provider',name:'Synthetic',hosts:[],private_work:'public_only'}]
  return { o,envelope,proposal,data:next,id }
}
describe('setup Team proposals',()=>{
  it('keeps unresolved choices outside the roster and recommends class-legal roles without writes',()=>{
    const o=options(),before=structuredClone(o),p=buildSetupTeamProposals(o)!
    expect(p.proposals).toHaveLength(3);expect(p.proposals.map(p=>p.app)).toEqual(SETUP_APPS)
    for(const proposal of p.proposals){expect(proposal).not.toHaveProperty('model');expect(proposal.roles).toEqual(expect.arrayContaining(['epic-reviewer','consultant','designer']));for(const role of proposal.roles)expect(classRefusal(proposal.class,role)).toBeNull()}
    expect(p.tools[0]?.args).toEqual(['-y',BROWSER_MCP_PACKAGE]);expect(o).toEqual(before)
  })
  it('requires durable fresh-profile provenance even when approval is absent',()=>{
    const o=options();o.profile!.state='existing';expect(buildSetupTeamProposals(o)).toBeNull();o.profile=null;expect(buildSetupTeamProposals(o)).toBeNull()
  })
  it.each(['foreign','corrupt','outside','missing-source'] as const)('blocks %s state rather than overwriting it',kind=>{
    const o=options();if(kind==='foreign')o.roster.file.hash='foreign';if(kind==='corrupt')o.roster.file.data=null;if(kind==='outside')o.roster.differences=[{section:'roster',field:null} as never];if(kind==='missing-source')o.defaults.source=null
    expect(buildSetupTeamProposals(o)).toMatchObject({blocked:expect.any(String),proposals:[]})
  })
  it('deduplicates approved apps and proposes later readiness without changing the approved team',()=>{
    const s=staged(),o=options();o.roster.approved={generation:1,createdAt:'2026-10-21',data:s.data};o.roster.file.data=s.data;o.roster.file.hash='approved';o.roster.approvalProblem=null
    const before=structuredClone(o);expect(buildSetupTeamProposals(o)!.proposals.map(p=>p.app)).toEqual(['claude','opencode']);expect(o).toEqual(before)
  })
  it('changes the revision for profile, app program/version/sign-in and roster changes, not check time',()=>{
    const o=options(),old=buildSetupTeamProposals(o)!.revision;o.apps.checkedAt='later';expect(buildSetupTeamProposals(o)!.revision).toBe(old)
    for(const change of [(n:typeof o)=>n.profile!.revision++,(n:typeof o)=>n.apps.apps[0]!.version='changed',(n:typeof o)=>n.apps.apps[0]!.program='/changed',(n:typeof o)=>n.apps.apps[0]!.signIn='signed-out',(n:typeof o)=>n.roster.file.hash='changed']){const n=options();change(n);expect(buildSetupTeamProposals(n)!.revision).not.toBe(old)}
  })
  it('accepts explicit complete public choices and rejects stale revisions or missing settings',()=>{
    const s=staged();expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,s.data,null)).not.toThrow()
    expect(()=>validateSetupTeamApproval(s.envelope,'stale',s.data,null)).toThrow('changed')
    for(const field of ['model','provider','efforts'] as const){const next=structuredClone(s.data);Object.assign(next.agents[0]!,{[field]:field==='efforts'?[]:''});expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,next,null)).toThrow('explicit')}
    const next=structuredClone(s.data);next.agents[0]!.model='x'.repeat(129);expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,next,null)).toThrow()
    expect(parseRoster(rewrite(s.data)).errors).toEqual([])
  })
  it('refuses unverified Console access as active or in any candidate chain',()=>{
    const s=staged('opencode');expect(s.data.agents[0]).toMatchObject({enabled:false,status:'proposed'});expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,s.data,null)).not.toThrow()
    const next=structuredClone(s.data);next.agents[0]!.enabled=true;expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,next,null)).toThrow('Console')
    const chained=structuredClone(s.data);chained.roles[0]!.candidates.push(`${s.id}@medium`);expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,chained,null)).toThrow('candidate')
  })
  it('refuses reactivating an already approved unavailable member even if its display note is removed',()=>{
    const s=staged('opencode'),approved=structuredClone(s.data),next=structuredClone(s.data)
    next.agents[0]!.enabled=true;next.agents[0]!.status='active';delete next.agents[0]!.enabled_note
    expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,next,approved)).toThrow('keep it proposed and off')
    expect(approved.agents[0]).toMatchObject({enabled:false,status:'proposed'})
  })
  it('never inherits private permission for setup additions',()=>{
    const s=staged();s.data.providers[0]!.private_work='allowed';expect(()=>validateSetupTeamApproval(s.envelope,s.envelope.revision,s.data,null)).toThrow('public work only')
  })
})
import { rewriteRoster } from '../../bin/agents-roster.mjs'
const rewrite=(data:Parameters<typeof rewriteRoster>[1])=>rewriteRoster('# Synthetic team\n',data)
