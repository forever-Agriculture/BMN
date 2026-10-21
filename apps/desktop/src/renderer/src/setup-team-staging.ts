// MODULE: setup-team-staging.ts - Explicit setup choices converted through the existing Team staging path.
import type { RosterDataShape, SetupTeamProposal, SetupTeamProposals } from '@bmn/protocol'
import { addAgent, landingFor, readOnlyProposed, type Landing, type NewAgent } from './roster-staging'

export const SETUP_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI' }, { id: 'opencode-zen', name: 'OpenCode Console' }
]
export function setupProviderOptions(data: RosterDataShape): Array<{ id: string; name: string }> {
  return [...data.providers.map(({ id, name }) => ({ id, name })), ...SETUP_PROVIDERS.filter(row => !data.providers.some(provider => provider.id === row.id))]
}
export function setupDestination(data: RosterDataShape, app: NewAgent['harness'], choice: string, host: string): Landing | null {
  if (choice === 'other') return /^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) && !['default', 'auto'].includes(host.toLowerCase())
    ? landingFor(data, app, host) : null
  const provider = setupProviderOptions(data).find(row => row.id === choice)
  return provider ? { provider, isNew: !data.providers.some(row => row.id === provider.id), host: null } : null
}
export function newSetupAgent(proposal: SetupTeamProposal): NewAgent {
  return { name: proposal.name, class: proposal.class, harness: proposal.app, model: '', host: '', privateWork: 'public_only',
    roles: [...proposal.roles], efforts: [], setup: { needs: proposal.needs } }
}
export function stageSetupAgent(data: RosterDataShape, draft: NewAgent, proposal: SetupTeamProposal, envelope: SetupTeamProposals): { data: RosterDataShape; id: string } {
  if (!draft.setup || !draft.destination || draft.harness !== proposal.app || data.agents.some(agent => agent.harness === proposal.app)) throw new Error('This setup app is already staged or its settings are incomplete.')
  if (!envelope.source) throw new Error('Setup needs its prepared skills source.')
  let next = structuredClone(data)
  if (!next.skills_source) next = { ...next, skills_source: envelope.source, skills: envelope.skills.map(id => ({ id, public: true })) }
  if (!next.tools?.some(tool => tool.id === 'playwright')) next.tools = [...next.tools ?? [], ...envelope.tools]
  for (const role of draft.roles) if (!next.roles.some(row => row.id === role)) next.roles.push({ id: role, description: role.replaceAll('-', ' '),
    candidates: [], then: 'owner-chooses', ...(readOnlyProposed(role) ? { read_only: true } : {}) })
  return addAgent(next, { ...draft, privateWork: 'public_only' })
}
