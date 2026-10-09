// MODULE: roster-staging.test.ts - Epic 60.5: staged roster edits keep chains and holders in step; diffs group by section with their words
import type { RosterAgentShape, RosterDataShape, RosterDiffShape } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  acceptVersion,
  agentGroups,
  groupConsequences,
  groupDifferences,
  moveCandidate,
  setLabel,
  setRecheck,
  summarize,
  toggleAgentRole,
  toggleCandidateEffort,
  updateAgent
} from './roster-staging'

const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), title: 'knight', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default',
  security: 'high', trust: 3, authority: 'review', enabled: true, status: 'active', efforts: ['low', 'medium', 'high'], roles: [], ...extra
})

const DATA: RosterDataShape = {
  schema_version: 1,
  agents: [
    agent('astra', { roles: ['epic-reviewer'] }),
    agent('fable', { harness: 'claude', roles: ['epic-reviewer'], quota: 'q' }),
    agent('luna', { title: 'squire', authority: 'read', efforts: ['max'] }),
    agent('haiku', { status: 'proposed' }),
    agent('glm', { enabled: false, enabled_note: 'off' })
  ],
  roles: [{ id: 'epic-reviewer', candidates: ['astra@medium', 'fable@medium'], then: 'blocked', recheck: { same_reviewer: true, astra: 'low' }, small_epic: 'astra@low' }],
  data_labels: { default: 'private', paths: [] },
  harness_routes: [{ harness: 'codex', provider: 'openai', security: 'high', basis: 'observed-default' }]
}

describe('edits (60.5 AC2)', () => {
  it('moves a candidate within its chain and never past either end', () => {
    expect(moveCandidate(DATA, 'epic-reviewer', 1, -1).roles[0]?.candidates).toEqual(['fable@medium', 'astra@medium'])
    expect(moveCandidate(DATA, 'epic-reviewer', 0, -1)).toEqual(DATA)
    expect(DATA.roles[0]?.candidates).toEqual(['astra@medium', 'fable@medium'])
  })

  it('toggles a candidate effort in the agent\'s order; two make an effort choice; the last one stays', () => {
    const chosen = toggleCandidateEffort(DATA, 'epic-reviewer', 'astra', 'low')
    expect(chosen.roles[0]?.candidates[0]).toBe('astra@low|medium')
    expect(toggleCandidateEffort(chosen, 'epic-reviewer', 'astra', 'low').roles[0]?.candidates[0]).toBe('astra@medium')
    expect(toggleCandidateEffort(DATA, 'epic-reviewer', 'astra', 'medium')).toEqual(DATA)
  })

  it('holding a role adds the agent last at its top effort; releasing removes it and its overrides', () => {
    const held = toggleAgentRole(DATA, 'luna', 'epic-reviewer')
    expect(held.agents.find((entry) => entry.id === 'luna')?.roles).toEqual(['epic-reviewer'])
    expect(held.roles[0]?.candidates).toEqual(['astra@medium', 'fable@medium', 'luna@max'])
    const released = toggleAgentRole(DATA, 'astra', 'epic-reviewer')
    expect(released.agents.find((entry) => entry.id === 'astra')?.roles).toEqual([])
    expect(released.roles[0]).toEqual({ id: 'epic-reviewer', candidates: ['fable@medium'], then: 'blocked', recheck: { same_reviewer: true } })
  })

  it('an optional field set to undefined leaves the data; required fields change in place', () => {
    const next = updateAgent(DATA, 'fable', { quota: undefined, security: 'low' })
    expect(Object.hasOwn(next.agents[1] as object, 'quota')).toBe(false)
    expect(next.agents[1]?.security).toBe('low')
    expect(setRecheck(DATA, 'epic-reviewer', false).roles[0]?.recheck).toBeUndefined()
  })

  it('labels: explicit, then removed to inherit again; accepting a version once', () => {
    const labelled = setLabel(DATA, '/srv/app', 'public')
    expect(labelled.data_labels.paths).toEqual([{ path: '/srv/app', label: 'public' }])
    expect(setLabel(labelled, '/srv/app', null).data_labels.paths).toEqual([])
    const accepted = acceptVersion(DATA, 'codex', '0.170.0')
    expect(accepted.harness_routes[0]?.accepted_versions).toEqual(['0.170.0'])
    expect(acceptVersion(accepted, 'codex', '0.170.0')).toEqual(accepted)
  })

  it('groups agents as active, awaiting approval and disabled', () => {
    const groups = agentGroups(DATA)
    expect(groups.active.map((entry) => entry.id)).toEqual(['astra', 'fable', 'luna'])
    expect(groups.proposed.map((entry) => entry.id)).toEqual(['haiku'])
    expect(groups.disabled.map((entry) => entry.id)).toEqual(['glm'])
  })
})

describe('the grouped diff (60.5 AC2-AC3)', () => {
  const diffs: RosterDiffShape[] = [
    { scope: 'agent', id: 'astra', field: 'security', kind: 'changed', before: { present: true, value: 'high' }, after: { present: true, value: 'low' } },
    { scope: 'agent', id: 'astra', field: 'quota', kind: 'changed', free_text: true, before: { present: true, hash: 'aaaaaaaaaaaaaaaa' }, after: { present: true, hash: 'bbbbbbbbbbbbbbbb' } },
    { scope: 'roles', id: 'epic-reviewer', field: 'candidates', kind: 'changed', before: { present: true, value: ['astra@medium', 'fable@medium'] }, after: { present: true, value: ['fable@medium', 'astra@medium'] } },
    { scope: 'data-labels', id: '/srv/app', field: 'label', kind: 'added', before: { present: false }, after: { present: true, value: 'public' } }
  ]
  const sentences = [
    'Astra could no longer receive private work',
    'epic-reviewer would start with Fable instead of Astra',
    '/srv/app becomes public: Low routes could receive its tracked files in packets',
    'something nobody claims'
  ]

  it('gives one row per agent or section, each with the sentences about it', () => {
    const { groups, general } = groupDifferences(diffs, DATA, DATA, sentences)
    expect(groups.map((group) => [group.key, group.subject, group.consequences])).toEqual([
      ['astra', 'Astra', ['Astra could no longer receive private work']],
      ['roles', 'Roles', ['epic-reviewer would start with Fable instead of Astra']],
      ['data-labels', 'Workspace labels', ['/srv/app becomes public: Low routes could receive its tracked files in packets']]
    ])
    expect(general).toEqual(['something nobody claims'])
  })

  it('gathers a first approval\'s sentences under the agent or role they name, in order', () => {
    const { groups, general } = groupConsequences([
      'Astra could be dispatched', 'Fable could be dispatched', 'Astra could receive private work',
      'epic-reviewer would start with Astra', 'something nobody claims'
    ], DATA, null)
    expect(groups.map((group) => [group.key, group.subject, group.lines, group.consequences])).toEqual([
      ['agent:astra', 'Astra', [], ['Astra could be dispatched', 'Astra could receive private work']],
      ['agent:fable', 'Fable', [], ['Fable could be dispatched']],
      ['roles', 'Roles', [], ['epic-reviewer would start with Astra']]
    ])
    expect(groups[0]?.agent?.id).toBe('astra')
    expect(general).toEqual(['something nobody claims'])
  })

  it('shows free text only as changed, never its words', () => {
    const { groups } = groupDifferences(diffs, DATA, DATA, [])
    expect(groups[0]?.lines).toEqual([
      { field: 'security', before: 'high', after: 'low' },
      { field: 'quota', before: 'text aaaaaaaa', after: 'text bbbbbbbb' }
    ])
    expect(groups[1]?.lines).toEqual([{ field: 'epic-reviewer candidates', before: 'astra@medium, fable@medium', after: 'fable@medium, astra@medium' }])
    expect(groups[2]?.lines).toEqual([{ field: '/srv/app', before: '—', after: 'public' }])
  })

  it('an added agent, role or route shows every value it brings; a removed one every value it takes away', () => {
    const added: RosterDiffShape[] = [
      { scope: 'agent', id: 'nova', field: null, kind: 'added', after: { present: true, value: { name: 'Nova', title: 'knight', harness: 'claude', security: 'high', efforts: ['low'], quota: 'text 1234abcd' } } },
      { scope: 'roles', id: 'scout', field: null, kind: 'removed', before: { present: true, value: { id: 'scout', candidates: ['luna@max'], then: 'skip' } } },
      { scope: 'harness-routes', id: 'cursor', field: null, kind: 'added', after: { present: true, value: { harness: 'cursor', provider: 'cursor', security: 'low', basis: 'owner-declared' } } }
    ]
    const { groups } = groupDifferences(added, DATA, DATA, [])
    expect(groups[0]?.lines).toEqual([
      { field: 'agent', before: '—', after: 'added' }, { field: 'name', before: '—', after: 'Nova' }, { field: 'title', before: '—', after: 'knight' },
      { field: 'harness', before: '—', after: 'claude' }, { field: 'security', before: '—', after: 'high' }, { field: 'efforts', before: '—', after: 'low' },
      { field: 'quota', before: '—', after: 'text 1234abcd' }
    ])
    expect(groups[1]?.lines).toEqual([
      { field: 'scout', before: 'present', after: 'removed' }, { field: 'scout candidates', before: 'luna@max', after: '—' }, { field: 'scout then', before: 'skip', after: '—' }
    ])
    expect(groups[2]?.lines).toEqual([
      { field: 'cursor', before: '—', after: 'added' }, { field: 'cursor provider', before: '—', after: 'cursor' },
      { field: 'cursor security', before: '—', after: 'low' }, { field: 'cursor basis', before: '—', after: 'owner-declared' }
    ])
  })

  it('summarises the counts in one sentence', () => {
    expect(summarize(diffs)).toBe('4 changes in 1 agent, 1 role and 1 label')
    expect(summarize([])).toBe('No machine changes')
  })
})
