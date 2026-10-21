// MODULE: setup-team-draft.ts - Read-only fresh-profile Team proposals and approval-time availability checks.
import { createHash } from 'node:crypto'
import { SETUP_APP_NAMES, type AgentsSnapshot, type FirstRunSetupRecord, type RosterDataShape,
  type SetupAppsSnapshot, type SetupDefaultsReport, type SetupTeamProposals } from '@bmn/protocol'
import { classRefusal } from '../../bin/agents-roster.mjs'
import { BROWSER_MCP_PACKAGE } from '../../bin/agents-team-browser.mjs'

const ROLES = {
  lead: 'lead the work', helper: 'carry out delegated work', browser: 'check a disposable local app',
  'focused-reviewer': 'review a bounded change', 'pre-reviewer': 'check an epic before review',
  'epic-reviewer': 'review an epic', 'project-pre-reviewer': 'check a project before review',
  'final-reviewer': 'review the completed project', consultant: 'advise on a technical decision', designer: 'propose a design'
}

export function buildSetupTeamProposals(options: {
  profile: FirstRunSetupRecord | null; apps: SetupAppsSnapshot; roster: AgentsSnapshot
  defaults: SetupDefaultsReport; starterHash: string
}): SetupTeamProposals | null {
  const { profile, apps, roster, defaults } = options
  if (!profile || profile.state === 'existing') return null
  const blocked = roster.approvalProblem && roster.approvalProblem.code !== 'NOT_APPROVED' ? 'The approved team needs fixing first.'
    : roster.file.exists && (!roster.file.data || !roster.approved && roster.file.hash !== options.starterHash) ? 'The existing team file needs review first.'
      : (roster.differences?.length ?? 0) > 0 ? 'Keep or revert changes made outside BMN first.'
        : !defaults.source ? 'Setup is preparing the default skills source. Check again shortly.' : null
  const ready = apps.platform === 'linux' ? apps.apps.filter(row => row.program && row.version && ['ready', 'confirmed'].includes(row.signIn)) : []
  const roles = Object.keys(ROLES).filter(role => classRefusal('queen', role) === null)
  const revision = createHash('sha256').update(JSON.stringify({ profile, ready: ready.map(({ app, program, version, signIn }) => ({ app, program, version, signIn })),
    file: roster.file.hash, generation: roster.approved?.generation ?? null, source: defaults.source, names: defaults.names })).digest('hex')
  return { revision, blocked, source: defaults.source, skills: defaults.names, availableApps: ready.map(row => row.app),
    tools: [{ id: 'playwright', name: 'Playwright', command: 'npx', args: ['-y', BROWSER_MCP_PACKAGE], public: true }],
    proposals: blocked ? [] : ready.filter(row => !roster.approved?.data.agents.some(agent => agent.harness === row.app)).map(row => ({
      id: `setup-${row.app}`, app: row.app, version: row.version!, name: SETUP_APP_NAMES[row.app], class: 'queen', roles,
      reasons: roles.map(role => ({ role, reason: `Proposes ${SETUP_APP_NAMES[row.app]} and the model you choose to ${ROLES[role as keyof typeof ROLES]}.` })),
      needs: row.app === 'opencode' ? 'OpenCode Console availability for BMN team asks' : null
    })) }
}

/** Parser/standing checks still run afterward. This checks the setup facts a syntactically valid roster cannot prove. */
export function validateSetupTeamApproval(proposals: SetupTeamProposals | null, revision: unknown, data: RosterDataShape, approved: RosterDataShape | null): void {
  if (!proposals) return
  if (proposals.blocked || revision !== proposals.revision) throw new Error(proposals.blocked ?? 'Setup changed since this team was shown. Check again before approving.')
  const additions = data.agents.filter(agent => {
    const earlier = approved?.agents.find(earlier => earlier.id === agent.id)
    return !earlier || earlier.harness !== agent.harness || !earlier.enabled && agent.enabled || earlier.status === 'proposed' && agent.status === 'active'
  })
  for (const agent of additions) {
    if (!agent.model || !/^[^\s\0]{1,128}$/.test(agent.model) || ['default', 'auto'].includes(agent.model) || !agent.provider || agent.efforts.length === 0 && agent.harness !== 'bmn') {
      throw new Error('Choose an explicit model, provider and effort for every setup member.')
    }
    const provider = data.providers.find(provider => provider.id === agent.provider)
    if (provider?.private_work !== 'public_only') throw new Error('Setup members start with public work only.')
    const proposal = proposals.proposals.find(proposal => proposal.app === agent.harness)
    const needs = agent.harness === 'opencode' ? 'OpenCode Console availability for BMN team asks' : proposal?.needs ??
      (agent.harness === 'bmn' ? 'an account verified outside setup' : !proposals.availableApps.includes(agent.harness as import('@bmn/protocol').SetupApp) ? 'a ready app' : null)
    if (needs && (agent.enabled || agent.status !== 'proposed' || data.roles.some(role => role.candidates.some(candidate => candidate.split('@')[0] === agent.id)))) {
      throw new Error(`${agent.name} needs ${needs}; keep it proposed and off, outside candidate chains.`)
    }
  }
}
