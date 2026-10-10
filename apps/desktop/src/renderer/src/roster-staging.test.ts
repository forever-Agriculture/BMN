// MODULE: roster-staging.test.ts - Epic 60.5: staged team edits keep chains and holders in step; differences group by section with their words
import type { RosterAgentShape, RosterDataShape, RosterDiffShape } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  acceptVersion,
  activateAgent,
  addAgent,
  addRole,
  agentGroups,
  agentsOnProvider,
  changedSections,
  classBar,
  consequenceWords,
  diffBody,
  differenceLine,
  effortWords,
  firstApprovalGroups,
  firstLine,
  formatValue,
  groupDifferences,
  idFor,
  landingFor,
  moveAgent,
  moveCandidate,
  newAgentConsequence,
  parseCandidate,
  priceWords,
  publicOnly,
  revokeVersion,
  roleName,
  sameData,
  setAgentClass,
  setAgentOn,
  setDestination,
  setProviderAnswer,
  setRoleThen,
  summarize,
  summaryWords,
  teamUpdateWords,
  thousands,
  toggleAgentEffort,
  toggleAgentRole,
  toggleCandidateEffort,
  updateAgent
} from './roster-staging'

const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'bishop', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default',
  enabled: true, status: 'active', efforts: ['low', 'medium', 'high'], roles: [], ...extra
})

const DATA: RosterDataShape = {
  schema_version: 2,
  agents: [
    agent('sol', { class: 'knight', roles: ['lead'], efforts: ['high', 'xhigh'] }),
    agent('astra', { roles: ['epic-reviewer'] }),
    agent('fable', { class: 'queen', harness: 'claude', provider: 'anthropic', roles: ['designer', 'epic-reviewer'] }),
    agent('luna', { class: 'pawn', efforts: ['max'] }),
    agent('haiku', { class: 'pawn', harness: 'claude', provider: 'anthropic', status: 'proposed' }),
    agent('glm', { class: 'pawn', harness: 'claude', provider: 'zai', host: 'api.z.ai', enabled: false, enabled_note: 'off', efforts: [] })
  ],
  roles: [
    { id: 'lead', candidates: ['sol@xhigh'], then: 'owner-chooses' },
    { id: 'designer', candidates: ['fable@medium'], then: 'lead' },
    { id: 'epic-reviewer', candidates: ['astra@medium', 'fable@medium'], then: 'blocked', recheck: { same_reviewer: true, astra: 'low' }, small_work: 'astra@low' }
  ],
  providers: [
    { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' },
    { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' },
    { id: 'zai', name: 'Z.ai', hosts: ['api.z.ai'], private_work: 'public_only' }
  ],
  exceptions: [],
  harness_routes: [
    { harness: 'claude', provider: 'anthropic', basis: 'observed-default' },
    { harness: 'codex', provider: 'openai', basis: 'observed-default' }
  ]
}

const find = (data: RosterDataShape, id: string): RosterAgentShape => data.agents.find((entry) => entry.id === id) as RosterAgentShape
const role = (data: RosterDataShape, id: string) => data.roles.find((entry) => entry.id === id)

describe('words (R60-NFR8)', () => {
  it('names roles, numbers, prices and efforts the way the pages show them', () => {
    expect(roleName('epic-reviewer')).toBe('Epic reviewer')
    expect(thousands(272000)).toBe('272 000')
    expect(thousands(999)).toBe('999')
    expect(priceWords({ price: { input: 1.25, output: 10 } })).toBe('$1.25 / $10.00')
    expect(priceWords({})).toBeNull()
    expect(effortWords(parseCandidate('astra@medium|high'))).toBe('medium or high')
    expect(firstLine('\n  First line.  \nSecond.')).toBe('First line.')
    expect(firstLine(undefined)).toBe('')
    expect(teamUpdateWords(0)).toBeNull()
    expect(teamUpdateWords(1)).toBe('Also updates the Team line in 1 rules file')
    expect(teamUpdateWords(4)).toBe('Also updates the Team line in 4 rules files')
  })

  it('states what adding an agent means, by its provider\'s answer and how its app\'s destination is known', () => {
    expect(newAgentConsequence('Kimi', 'Moonshot AI', 'public_only', false)).toBe('Kimi gets public work only. Private work is refused for it until you allow Moonshot AI.')
    expect(newAgentConsequence('Kimi', 'OpenAI', 'allowed', false)).toBe('Kimi may receive private work, like every agent on OpenAI.')
    expect(newAgentConsequence(' ', 'Cursor', 'allowed', true)).toBe("This agent gets public work only: BMN can't confirm where its app sends data.")
  })
})

describe('chains and the roles agents hold (60.5 AC5)', () => {
  it('moves a candidate within its chain and never past either end', () => {
    expect(role(moveCandidate(DATA, 'epic-reviewer', 1, -1), 'epic-reviewer')?.candidates).toEqual(['fable@medium', 'astra@medium'])
    expect(moveCandidate(DATA, 'epic-reviewer', 0, -1)).toEqual(DATA)
    expect(role(DATA, 'epic-reviewer')?.candidates).toEqual(['astra@medium', 'fable@medium'])
  })

  it('toggles a candidate effort in the agent\'s order; two make an effort choice; the last one stays', () => {
    const chosen = toggleCandidateEffort(DATA, 'epic-reviewer', 'astra', 'low')
    expect(role(chosen, 'epic-reviewer')?.candidates[0]).toBe('astra@low|medium')
    expect(parseCandidate('astra@low|medium')).toEqual({ agent: 'astra', efforts: ['low', 'medium'], choice: true })
    expect(role(toggleCandidateEffort(chosen, 'epic-reviewer', 'astra', 'low'), 'epic-reviewer')?.candidates[0]).toBe('astra@medium')
    expect(toggleCandidateEffort(DATA, 'epic-reviewer', 'astra', 'medium')).toEqual(DATA)
  })

  it('holding a role adds the agent last at its top effort; releasing removes it with its recheck and small-work entries', () => {
    const held = toggleAgentRole(DATA, 'luna', 'epic-reviewer')
    expect(find(held, 'luna').roles).toEqual(['epic-reviewer'])
    expect(role(held, 'epic-reviewer')?.candidates).toEqual(['astra@medium', 'fable@medium', 'luna@max'])
    const released = toggleAgentRole(DATA, 'astra', 'epic-reviewer')
    expect(find(released, 'astra').roles).toEqual([])
    expect(role(released, 'epic-reviewer')).toEqual({ id: 'epic-reviewer', candidates: ['fable@medium'], then: 'blocked', recheck: { same_reviewer: true } })
  })

  it('only a Knight takes lead and only a Queen takes designer; an agent with no efforts takes nothing', () => {
    expect(classBar('bishop', 'lead')).toBe('Only a Knight leads')
    expect(classBar('knight', 'designer')).toBe('Only a Queen designs')
    expect(classBar('queen', 'epic-reviewer')).toBeNull()
    expect(classBar('queen', 'lead')).toBe('Only a Knight leads')
    expect(toggleAgentRole(DATA, 'astra', 'lead')).toBe(DATA)
    expect(toggleAgentRole(DATA, 'sol', 'designer')).toBe(DATA)
    expect(toggleAgentRole(DATA, 'glm', 'epic-reviewer')).toBe(DATA)
    expect(toggleAgentRole(DATA, 'nobody', 'lead')).toBe(DATA)
  })

  it('a new class drops the roles it may not hold, from the agent and from their chains', () => {
    const bishop = setAgentClass(DATA, 'fable', 'bishop')
    expect(find(bishop, 'fable')).toMatchObject({ class: 'bishop', roles: ['epic-reviewer'] })
    expect(role(bishop, 'designer')?.candidates).toEqual([])
    const pawn = setAgentClass(DATA, 'sol', 'pawn')
    expect(find(pawn, 'sol').roles).toEqual([])
    expect(role(pawn, 'lead')?.candidates).toEqual([])
    expect(setAgentClass(DATA, 'sol', 'knight')).toBe(DATA)
  })

  it('removing an effort an agent offers leaves every chain with one it still offers', () => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max'] as const
    const without = toggleAgentEffort(DATA, 'astra', 'medium', order)
    expect(find(without, 'astra').efforts).toEqual(['low', 'high'])
    expect(role(without, 'epic-reviewer')?.candidates[0]).toBe('astra@high')
    expect(role(without, 'epic-reviewer')?.small_work).toBe('astra@low')
    const noLow = toggleAgentEffort(DATA, 'astra', 'low', order)
    expect(role(noLow, 'epic-reviewer')).toMatchObject({ recheck: { same_reviewer: true }, small_work: 'astra@high' })
    expect(find(toggleAgentEffort(DATA, 'astra', 'max', order), 'astra').efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(toggleAgentEffort(DATA, 'luna', 'max', order)).toBe(DATA)
  })

  it('sets the fallback and adds a role with its candidates at their top effort', () => {
    expect(role(setRoleThen(DATA, 'lead', 'blocked'), 'lead')?.then).toBe('blocked')
    const added = addRole(DATA, 'Browser Check', ' Checks the running app ', ['luna', 'astra'])
    expect(added.roles.at(-1)).toEqual({ id: 'browser-check', description: 'Checks the running app', candidates: ['luna@max', 'astra@high'], then: 'lead' })
    expect(find(added, 'luna').roles).toEqual(['browser-check'])
    expect(addRole(DATA, 'Lead', '', []).roles.at(-1)).toEqual({ id: 'lead-2', candidates: [], then: 'lead' })
  })
})

describe('agents (60.5 AC2–AC4)', () => {
  it('an optional field set to undefined leaves the data; required fields change in place', () => {
    const limited = updateAgent(DATA, 'astra', { context_limit: 272000 })
    expect(find(limited, 'astra').context_limit).toBe(272000)
    expect(Object.hasOwn(find(updateAgent(limited, 'astra', { context_limit: undefined }), 'astra'), 'context_limit')).toBe(false)
    expect(find(updateAgent(DATA, 'astra', { model: 'gpt-7' }), 'astra').model).toBe('gpt-7')
    expect(find(DATA, 'astra').model).toBe('model-astra')
  })

  it('turning off records the reason, turning on clears it, activating makes a proposed agent active', () => {
    expect(find(setAgentOn(DATA, 'sol', false, '  Subscription ended '), 'sol')).toMatchObject({ enabled: false, enabled_note: 'Subscription ended' })
    expect(Object.hasOwn(find(setAgentOn(DATA, 'sol', false, ' '), 'sol'), 'enabled_note')).toBe(false)
    const on = find(setAgentOn(DATA, 'glm', true), 'glm')
    expect([on.enabled, Object.hasOwn(on, 'enabled_note')]).toEqual([true, false])
    expect(find(activateAgent(DATA, 'haiku'), 'haiku')).toMatchObject({ status: 'active', enabled: true })
  })

  it('groups agents as Active, Proposed and Off', () => {
    const groups = agentGroups(DATA)
    expect(groups.active.map((entry) => entry.id)).toEqual(['sol', 'astra', 'fable', 'luna'])
    expect(groups.proposed.map((entry) => entry.id)).toEqual(['haiku'])
    expect(groups.off.map((entry) => entry.id)).toEqual(['glm'])
  })

  it('one provider answer covers every agent there', () => {
    const changed = setProviderAnswer(DATA, 'openai', 'public_only')
    expect(agentsOnProvider(changed, 'openai').map((entry) => entry.name)).toEqual(['Sol', 'Astra', 'Luna'])
    expect(agentsOnProvider(changed, 'openai').every((entry) => publicOnly(changed, entry))).toBe(true)
    expect(publicOnly(DATA, find(DATA, 'sol'))).toBe(false)
    expect(publicOnly(DATA, { provider: 'unknown' })).toBe(true)
  })

  it('finds where a new agent would run: the app\'s recorded provider, a listed host\'s provider, or a new provider', () => {
    expect(landingFor(DATA, 'codex', '')).toEqual({ provider: { id: 'openai', name: 'OpenAI' }, isNew: false, host: null })
    expect(landingFor(DATA, 'claude', ' API.Z.AI ')).toEqual({ provider: { id: 'zai', name: 'Z.ai' }, isNew: false, host: 'api.z.ai' })
    expect(landingFor(DATA, 'claude', 'api.moonshot.test')).toEqual({ provider: { id: 'api-moonshot-test', name: 'api.moonshot.test' }, isNew: true, host: 'api.moonshot.test' })
    expect(landingFor(DATA, 'cursor', 'default')).toEqual({ provider: { id: 'cursor', name: 'Cursor' }, isNew: true, host: null })
    expect(idFor('Kimi K3!', ['kimi-k3'])).toBe('kimi-k3-2')
    expect(idFor('***', [])).toBe('agent')
  })

  it('adds an agent as active with a provider the team did not know, answered as the owner said', () => {
    const { data, id } = addAgent(DATA, { name: ' Kimi ', class: 'pawn', harness: 'claude', model: ' kimi-k3 ', host: 'api.moonshot.test', privateWork: 'public_only', roles: ['epic-reviewer', 'lead'], efforts: ['low'], contextLimit: 100000 })
    expect(id).toBe('kimi')
    expect(find(data, 'kimi')).toEqual({
      id: 'kimi', name: 'Kimi', class: 'pawn', harness: 'claude', model: 'kimi-k3', provider: 'api-moonshot-test', host: 'api.moonshot.test',
      enabled: true, status: 'active', efforts: ['low'], roles: ['epic-reviewer'], context_limit: 100000
    })
    expect(data.providers.at(-1)).toEqual({ id: 'api-moonshot-test', name: 'api.moonshot.test', hosts: ['api.moonshot.test'], private_work: 'public_only' })
    expect(role(data, 'epic-reviewer')?.candidates.at(-1)).toBe('kimi@low')
    expect(role(data, 'lead')?.candidates).toEqual(['sol@xhigh'])
    expect(data.harness_routes).toEqual(DATA.harness_routes)
  })

  it('an agent on an app the team has no destination for records that app on the owner\'s word', () => {
    const { data } = addAgent(DATA, { name: 'Composer', class: 'pawn', harness: 'cursor', model: 'composer-2', host: '', privateWork: 'allowed', roles: [], efforts: ['low'] })
    expect(data.harness_routes.at(-1)).toEqual({ harness: 'cursor', provider: 'cursor', basis: 'owner-declared' })
    expect(data.providers.at(-1)).toEqual({ id: 'cursor', name: 'Cursor', hosts: [], private_work: 'allowed' })
    expect(find(data, 'composer')).toMatchObject({ provider: 'cursor', host: 'default' })
  })

  it('moves an agent to another app or host, onto the provider that reaches', () => {
    expect(find(moveAgent(DATA, 'astra', 'claude', ''), 'astra')).toMatchObject({ harness: 'claude', provider: 'anthropic', host: 'default' })
    const custom = moveAgent(DATA, 'astra', 'codex', 'llm.internal.test', 'allowed')
    expect(find(custom, 'astra')).toMatchObject({ provider: 'llm-internal-test', host: 'llm.internal.test' })
    expect(custom.providers.at(-1)).toMatchObject({ id: 'llm-internal-test', private_work: 'allowed' })
    expect(moveAgent(DATA, 'astra', 'codex', 'llm.internal.test').providers.at(-1)?.private_work).toBe('public_only')
  })
})

describe('agent apps (60.6 AC4)', () => {
  it('records a destination as inspected or on the owner\'s word, in app order, dropping versions accepted for the old one', () => {
    const accepted = acceptVersion(DATA, 'codex', '0.170.0')
    expect(accepted.harness_routes[1]?.accepted_versions).toEqual(['0.170.0'])
    expect(acceptVersion(accepted, 'codex', '0.170.0')).toBe(accepted)
    expect(acceptVersion(DATA, 'cursor', '1.0')).toBe(DATA)
    const declared = setDestination(accepted, 'codex', { id: 'zai', name: 'Z.ai' }, 'owner-declared')
    expect(declared.harness_routes).toEqual([{ harness: 'claude', provider: 'anthropic', basis: 'observed-default' }, { harness: 'codex', provider: 'zai', basis: 'owner-declared' }])
    const cursor = setDestination(DATA, 'cursor', { id: 'cursor', name: 'Cursor' }, 'owner-declared')
    expect(cursor.harness_routes.map((route) => route.harness)).toEqual(['claude', 'codex', 'cursor'])
    expect(cursor.providers.at(-1)).toEqual({ id: 'cursor', name: 'Cursor', hosts: [], private_work: 'public_only' })
  })

  it('removing the last accepted version removes the list', () => {
    const two = acceptVersion(acceptVersion(DATA, 'codex', '0.170.0'), 'codex', '0.171.0')
    expect(revokeVersion(two, 'codex', '0.170.0').harness_routes[1]?.accepted_versions).toEqual(['0.171.0'])
    expect(Object.hasOwn(revokeVersion(acceptVersion(DATA, 'codex', '0.170.0'), 'codex', '0.170.0').harness_routes[1] ?? {}, 'accepted_versions')).toBe(false)
  })
})

describe('differences in words (60.5 AC7)', () => {
  const changed = (scope: RosterDiffShape['scope'], id: string, field: string, before: unknown, after: unknown): RosterDiffShape =>
    ({ scope, id, field, kind: 'changed', before: { present: before !== undefined, value: before }, after: { present: after !== undefined, value: after } })

  it('groups by agent or shared section and gives each its consequence sentences', () => {
    const diffs = [
      changed('agent', 'astra', 'context_limit', undefined, 272000),
      changed('agent', 'astra', 'class', 'bishop', 'pawn'),
      changed('providers', 'zai', 'private_work', 'public_only', 'allowed'),
      changed('roles', 'epic-reviewer', 'candidates', ['astra@medium', 'fable@medium'], ['fable@medium', 'astra@medium']),
      changed('harness-routes', 'codex', 'basis', 'observed-default', 'owner-declared')
    ]
    const sentences = [
      'Astra: context limit app default → 272 000',
      'Changing Z.ai to Allowed lets GLM receive private work',
      'epic-reviewer would start with Fable instead of Astra',
      'Codex would count as sending data to OpenAI on your word, so it gets public work only',
      'Something nobody claims'
    ]
    const { groups, general } = groupDifferences(diffs, DATA, DATA, sentences)
    expect(groups.map((group) => [group.key, group.subject, group.consequences])).toEqual([
      ['astra', 'Astra', ['Astra: context limit app default → 272 000']],
      ['providers', 'Providers', ['Changing Z.ai to Allowed lets GLM receive private work']],
      ['roles', 'Roles', ['Epic reviewer would start with Fable instead of Astra']],
      ['harness-routes', 'Agent apps', ['Codex would count as sending data to OpenAI on your word, so it gets public work only']]
    ])
    expect(general).toEqual(['Something nobody claims'])
    expect(groups[0]?.agent?.id).toBe('astra')
    expect(groups[0]?.lines).toEqual([{ field: 'Context limit', before: '—', after: '272 000' }, { field: 'Class', before: 'Bishop', after: 'Pawn' }])
    expect(groups[1]?.lines).toEqual([{ field: 'Z.ai · private work', before: 'Public work only', after: 'Allowed' }])
    expect(groups[2]?.lines).toEqual([{
      field: 'Epic reviewer · order', before: 'Astra medium, Fable medium', after: 'Fable medium, Astra medium',
      chain: { before: ['astra@medium', 'fable@medium'], after: ['fable@medium', 'astra@medium'] }
    }])
    expect(groups[3]?.lines).toEqual([{ field: 'Codex · destination', before: "its provider's own servers, as inspected", after: 'on your word' }])
    expect(changedSections(diffs)).toEqual(new Set(['astra', 'providers', 'roles', 'harness-routes']))
  })

  it('an added agent shows every value in Review and one word on its outside-change row', () => {
    const added: RosterDiffShape = { scope: 'agent', id: 'kimi', field: null, kind: 'added', after: { present: true, value: { id: 'kimi', name: 'Kimi', class: 'pawn', harness: 'claude', enabled: true } } }
    const group = groupDifferences([added], { ...DATA, agents: [...DATA.agents, agent('kimi', { class: 'pawn' })] }, DATA, []).groups[0]
    expect(group?.lines).toEqual([
      { field: 'Agent', before: '—', after: 'added' },
      { field: 'Name', before: '—', after: 'Kimi', detail: true },
      { field: 'Class', before: '—', after: 'Pawn', detail: true },
      { field: 'Agent app', before: '—', after: 'Claude Code', detail: true },
      { field: 'On', before: '—', after: 'yes', detail: true }
    ])
    expect(differenceLine(group ?? { lines: [] })).toBe('agent — → added')
    expect(differenceLine({ lines: [{ field: 'Model', before: 'gpt-6-luna', after: 'gpt-6.1-luna' }, { field: 'On', before: 'yes', after: 'no' }] })).toBe('model gpt-6-luna → gpt-6.1-luna · on yes → no')
  })

  it('says names where the file holds ids: agents, providers, roles, fallbacks and a price\'s parts', () => {
    const lines = (diff: RosterDiffShape): unknown => groupDifferences([diff], DATA, DATA, []).groups[0]?.lines.map((line) => `${line.field}: ${line.before} → ${line.after}`)
    expect(lines(changed('roles', 'helper', 'small_work', undefined, 'astra@low'))).toEqual(['Helper · small work: — → Astra low'])
    expect(lines(changed('roles', 'helper', 'recheck', undefined, { same_reviewer: true, astra: 'low' }))).toEqual(['Helper · recheck: — → the same reviewer · Astra low'])
    expect(lines(changed('roles', 'helper', 'candidates', ['luna@max'], ['astra@medium|high', 'nobody@low']))).toEqual(['Helper · order: Luna max → Astra medium or high, nobody low'])
    expect(lines(changed('agent', 'astra', 'roles', ['helper'], ['helper', 'epic-reviewer']))).toEqual(['Roles: Helper → Helper, Epic reviewer'])
    expect(lines(changed('agent', 'astra', 'provider', 'openai', 'zai'))).toEqual(['Provider: OpenAI → Z.ai'])
    expect(lines(changed('harness-routes', 'cursor', 'provider', 'zai', 'openai'))).toEqual(['Cursor · provider: Z.ai → OpenAI'])
    expect(lines(changed('agent', 'astra', 'price', undefined, { input: 1.25, cached_input: 0.125, output: 10, as_of: '2026-10-01' }))).toEqual(['Price: — → in 1.25 · cached in 0.125 · out 10 · as of 2026-10-01'])
  })

  it('turns a consequence sentence into the pages\' words, leaving anything else alone', () => {
    const roles = new Set(['lead', 'epic-reviewer', 'helper'])
    expect(consequenceWords('epic-reviewer would start with Fable instead of Astra', roles)).toBe('Epic reviewer would start with Fable instead of Astra')
    expect(consequenceWords('helper would have no agent to start with (then owner-chooses)', roles)).toBe('Helper would have no agent to start with (then: Ask me)')
    expect(consequenceWords('when every epic-reviewer candidate fails: blocked instead of lead', roles)).toBe('When every epic reviewer candidate fails: Stop and tell me instead of Lead does it')
    expect(consequenceWords('the epic-reviewer role would be removed', roles)).toBe('The epic reviewer role would be removed')
    expect(consequenceWords('Astra could take the epic-reviewer role', roles)).toBe('Astra could take the epic reviewer role')
    expect(consequenceWords('Astra could no longer take the epic-reviewer role', roles)).toBe('Astra could no longer take the epic reviewer role')
    expect(consequenceWords('Sol could lead', roles)).toBe('Sol could lead')
    expect(consequenceWords('stranger would start with Sol', roles)).toBe('stranger would start with Sol')
    expect(summaryWords('epic-reviewer would start with Fable instead of Astra · 2 more', roles)).toBe('Epic reviewer would start with Fable instead of Astra · 2 more')
    expect(summaryWords('Restored version 3', roles)).toBe('Restored version 3')
  })

  it('reviews a first approval as one row per agent and one per role', () => {
    const { groups, general } = firstApprovalGroups(DATA, [
      'Sol could be given work', 'Sol could lead', 'Sol could receive private work', 'Astra could be given work', 'Fable could be given work', 'Fable could design',
      'lead would start with Sol', 'epic-reviewer would have no agent to start with (then blocked)', 'Codex 0.170.0 could carry private work (accepted by you; BMN has not tested how this version picks its destination)'
    ])
    expect(groups.map((group) => [group.key, group.subject, group.agent?.id ?? group.role?.id, group.consequences])).toEqual([
      ['sol', 'Sol', 'sol', ['Can be given work, can lead, may receive private work']],
      ['astra', 'Astra', 'astra', ['Can be given work']],
      ['fable', 'Fable', 'fable', ['Can be given work, can design']],
      ['role:lead', 'Lead', 'lead', []],
      ['role:epic-reviewer', 'Epic reviewer', 'epic-reviewer', ['Nobody can start it yet']]
    ])
    expect(general).toEqual(['Codex 0.170.0 could carry private work (accepted by you; BMN has not tested how this version picks its destination)'])
  })

  it('shows a difference without the diff format\'s file and position lines', () => {
    expect(diffBody('--- /home/synthetic/a.md\n+++ /home/synthetic/a.md\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n@@ -9,2 +9,2 @@\n-nine\n+9')).toBe(' one\n-two\n+2\n⋯\n-nine\n+9')
    expect(diffBody('-old\n+new')).toBe('-old\n+new')
    expect(diffBody('')).toBe('')
  })

  it('never shows the owner\'s free text: only that it changed', () => {
    expect(formatValue({ present: true, hash: 'abc' }, 'enabled_note')).toBe('changed')
    expect(formatValue({ present: false })).toBe('—')
    expect(formatValue(undefined)).toBe('—')
    expect(formatValue({ present: true, value: 400000 }, 'context_window')).toBe('400 000')
    expect(formatValue({ present: true, value: [] }, 'roles')).toBe('none')
  })

  it('counts changes; switching an agent off with its reason is one', () => {
    expect(summarize([])).toBe('No changes')
    expect(summarize([changed('agent', 'sol', 'enabled', true, false), { scope: 'agent', id: 'sol', field: 'enabled_note', kind: 'added', free_text: true, after: { present: true, hash: 'h' } }])).toBe('1 unapproved change')
    expect(summarize([changed('agent', 'sol', 'enabled_note', 'a', 'b')])).toBe('1 unapproved change')
    expect(summarize([changed('agent', 'sol', 'model', 'a', 'b'), changed('roles', 'lead', 'then', 'lead', 'skip')])).toBe('2 unapproved changes')
  })

  it('compares staged data with the file by value', () => {
    expect(sameData(DATA, structuredClone(DATA))).toBe(true)
    expect(sameData(DATA, setRoleThen(DATA, 'lead', 'skip'))).toBe(false)
    expect(sameData(null, null)).toBe(true)
  })
})
