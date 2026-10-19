// MODULE: judge-page.test.ts - Epic 65 markup and words: Jev's card and page on Team, BMN's proposal, what its calls cost, the limit, Try it's answers and the staged edits behind them, over a synthetic team
import type { JudgeTryReply, JudgeView, RosterAgentShape, RosterDataShape, RosterDiffShape } from '@bmn/protocol'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JUDGE_PROPOSAL as CLI_PROPOSAL, calledParties as cliParties, judgeProposal as cliProposal, parseRoster, privateWorkOf, rewriteRoster, starterRoster } from '../../../bin/agents-roster.mjs'
import { JudgeGroups, LimitReached, TryAnswer, byCost, cut, dollarsOf, estimatedWords, limitUsd, mayBeSentWords, monthName, outcomeWords, tryFacts, usd, type JudgeState } from './judge-page'
import { researchGroups, appFor } from './research-view'
import {
  JUDGE_PROPOSAL, agentsOnProvider, appWords, callByBmn, calledParties, formatCandidate, groupDifferences, isCalled, judgeProposal, parseCandidate, publicOnly, roleBar, setAgentClass, setProviderAnswer,
  thousands, toggleAgentRole
} from './roster-staging'
import { TeamPreferences, appChoices, judgeClause, teamProposals, type TeamPage } from './team-preferences'
import type { TeamState } from './team-state'

const noop = (): void => {}
const later = async (): Promise<void> => {}
const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'bishop', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default',
  enabled: true, status: 'active', efforts: ['low', 'medium', 'high'], roles: [], ...extra
})

const BEFORE: RosterDataShape = {
  schema_version: 2,
  agents: [agent('sol', { class: 'knight', roles: ['lead'], efforts: ['xhigh'] }), agent('luna', { class: 'pawn', efforts: ['max'], roles: ['helper'] }), agent('haiku', { class: 'pawn', harness: 'claude', provider: 'anthropic' })],
  roles: [{ id: 'lead', candidates: ['sol@xhigh'], then: 'owner-chooses' }, { id: 'helper', candidates: ['luna@max'], then: 'skip' }],
  providers: [{ id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' }, { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' }],
  exceptions: [],
  harness_routes: [{ harness: 'claude', provider: 'anthropic', basis: 'observed-default' }, { harness: 'codex', provider: 'openai', basis: 'observed-default' }]
}
const DATA = judgeProposal(BEFORE) as RosterDataShape
const JEV = DATA.agents.find(isCalled) as RosterAgentShape
const withAnswers = (receives: 'allowed' | 'public_only', runs: 'allowed' | 'public_only'): RosterDataShape => setProviderAnswer(setProviderAnswer(DATA, 'opencode-zen', receives), 'typesafe', runs)

const team = (data: RosterDataShape, extra: Partial<TeamState> = {}): TeamState => ({
  snapshot: {
    rosterPath: '/home/synthetic/.config/bmn/agents/roster.md', home: '/home/synthetic',
    file: { exists: true, hash: 'f'.repeat(64), link: null, directory: '/home/synthetic/.config/bmn/agents', errors: [], warnings: [], data, prose: {} },
    approved: { generation: 4, createdAt: '2026-10-09T22:13:00.000Z', data }, approvalProblem: null, differences: [], consequences: [], history: []
  },
  loadError: null, base: data, data, approved: data, hasStaged: false, preview: null, outside: { groups: [], general: [] },
  changed: new Set(), busy: false, notice: null, confirmation: null, needsOwner: false, stage: noop, discard: noop, reload: later, setNotice: noop,
  requestApproval: later, approveProposals: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop, ...extra
})
const pageMarkup = (page: TeamPage, data: RosterDataShape = DATA): string => renderToStaticMarkup(createElement(TeamPreferences, { team: team(data), page, go: noop }))
/** What the owner reads: the markup without tags. */
const words = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('the team file\'s own rules, kept the same on the Team pages (65.1)', () => {
  it('BMN\'s proposal is the CLI\'s, value for value', () => {
    const { description, ...rest } = JUDGE_PROPOSAL
    expect(rest).toEqual(CLI_PROPOSAL)
    expect(judgeProposal(BEFORE)).toEqual(cliProposal(BEFORE as never))
    expect(description).toBe(cliProposal(BEFORE as never)?.roles.at(-1)?.description)
    expect(DATA.schema_version).toBe(3)
    expect(JEV).toMatchObject({ id: 'jev', name: 'Jev', class: 'bishop', harness: 'bmn', model: 'jev-1.13', provider: 'opencode-zen', run_by: 'typesafe', host: 'opencode.ai', enabled: true, status: 'active', efforts: [], roles: ['judge'] })
    expect(DATA.roles.at(-1)).toEqual({ id: 'judge', description: 'answers typed questions about a text with numbers; advice only', candidates: ['jev'], then: 'skip' })
  })

  it('the proposed team is one the team file takes', () => {
    const written = rewriteRoster(starterRoster(), DATA as never)
    const parsed = parseRoster(written)
    expect(parsed.errors).toEqual([])
    expect(parsed.data).toEqual(DATA)
  })

  it('nothing is proposed once the team holds a judge, an agent BMN calls, or the name', () => {
    expect(judgeProposal(DATA)).toBeNull()
    expect(judgeProposal({ ...BEFORE, roles: [...BEFORE.roles, { id: 'judge', candidates: [], then: 'skip' }] })).toBeNull()
    expect(judgeProposal({ ...BEFORE, agents: [...BEFORE.agents, agent('jev')] })).toBeNull()
  })

  it('a provider the team already names for the gateway\'s host keeps its own answer', () => {
    const held: RosterDataShape = { ...BEFORE, providers: [...BEFORE.providers, { id: 'zen', name: 'Zen', hosts: ['OpenCode.ai'], private_work: 'public_only' }] }
    const proposed = judgeProposal(held) as RosterDataShape
    expect(proposed).toEqual(cliProposal(held as never))
    expect(proposed.agents.at(-1)).toMatchObject({ provider: 'zen', run_by: 'typesafe' })
    expect(proposed.providers.map((provider) => provider.id)).toEqual(['openai', 'anthropic', 'zen', 'typesafe'])
    expect(publicOnly(proposed, proposed.agents.at(-1) as RosterAgentShape)).toBe(true)
    expect(judgeClause(proposed)).toContain('Zen and TypeSafe AI; Jev gets public work only: Zen gets public work only')
  })

  it('private work follows both providers, in all four combinations, with the CLI\'s own reason', () => {
    for (const receives of ['allowed', 'public_only'] as const) {
      for (const runs of ['allowed', 'public_only'] as const) {
        const data = withAnswers(receives, runs)
        expect(publicOnly(data, JEV), `${receives}/${runs}`).toBe(!(receives === 'allowed' && runs === 'allowed'))
        expect(publicOnly(data, JEV)).toBe(privateWorkOf(data as never, JEV as never) !== 'allowed')
        expect(calledParties(data, JEV)).toEqual(cliParties(data as never, JEV as never))
      }
    }
    expect(calledParties(withAnswers('allowed', 'public_only'), JEV).reason).toBe('public work only: TypeSafe AI gets public work only')
    expect(calledParties(withAnswers('public_only', 'public_only'), JEV).reason).toBe('public work only: OpenCode Zen and TypeSafe AI get public work only')
    expect(calledParties(DATA, JEV)).toMatchObject({ allowed: true, reason: 'OpenCode Zen and TypeSafe AI may see private work' })
  })

  it('an agent BMN calls holds the role Judge and no other, and nobody else holds that one', () => {
    expect(roleBar(JEV, 'judge')).toBeNull()
    expect(roleBar(JEV, 'helper')).toBe('An agent BMN calls holds the role Judge only')
    expect(roleBar(agent('luna'), 'judge')).toBe('Only an agent BMN calls is a judge')
    expect(roleBar(agent('luna', { class: 'pawn' }), 'lead')).toBe('Only a Knight or a Queen leads')
    expect(toggleAgentRole(DATA, 'jev', 'helper')).toBe(DATA)
    expect(toggleAgentRole(DATA, 'luna', 'judge')).toBe(DATA)
    const released = toggleAgentRole(DATA, 'jev', 'judge')
    expect(released.agents.find(isCalled)?.roles).toEqual([])
    expect(released.roles.at(-1)?.candidates).toEqual([])
    // Held again: named by its id alone, since it has no effort.
    expect(toggleAgentRole(released, 'jev', 'judge')).toEqual(DATA)
    expect(formatCandidate(parseCandidate('jev'))).toBe('jev')
    expect(formatCandidate({ agent: 'luna', efforts: ['max'] })).toBe('luna@max')
    // Another class keeps the role: a class bars no judge.
    expect(setAgentClass(DATA, 'jev', 'pawn').agents.find(isCalled)).toMatchObject({ class: 'pawn', roles: ['judge'] })
  })

  it('a provider\'s answer covers the agent whose model it runs', () => {
    expect(agentsOnProvider(DATA, 'typesafe').map((entry) => entry.id)).toEqual(['jev'])
    expect(agentsOnProvider(DATA, 'opencode-zen').map((entry) => entry.id)).toEqual(['jev'])
    expect(agentsOnProvider(DATA, 'openai').map((entry) => entry.id)).toEqual(['sol', 'luna'])
  })

  it('an agent with no role can be turned into one BMN calls; one that holds a role cannot', () => {
    expect(appChoices(agent('haiku'))).toEqual(['claude', 'codex', 'opencode', 'bmn'])
    expect(appChoices(agent('sol', { roles: ['lead'] }))).toEqual(['claude', 'codex', 'opencode'])
    expect(callByBmn(BEFORE, 'sol')).toBe(BEFORE)
    const withFields = { ...BEFORE, agents: BEFORE.agents.map((entry) => (entry.id === 'haiku' ? { ...entry, context_window: 200_000, context_limit: 150_000, compact_at: 100_000, researcher: true } : entry)) }
    const turned = callByBmn(withFields, 'haiku')
    expect(turned.schema_version).toBe(3)
    expect(turned.agents.find((entry) => entry.id === 'haiku')).toEqual({ ...agent('haiku', { class: 'pawn', provider: 'anthropic' }), harness: 'bmn', run_by: 'anthropic', efforts: [] })
    expect(appWords(turned.agents[2] as RosterAgentShape)).toBe('Called by BMN')
    expect(appWords(agent('sol'))).toBe('Codex')
  })

  it('Models takes no app from an agent BMN calls, and shows its own recorded price where research found none', () => {
    expect(appFor(DATA, 'opencode-zen')).toBeNull()
    expect(appFor(DATA, 'openai')).toBe('codex')
    const row = researchGroups([], DATA).team.find((entry) => entry.model === 'jev-1.13')
    expect(row).toMatchObject({ agents: ['Jev'], provider: 'OpenCode Zen', found: null, recorded: { input: 0.042, output: 0, as_of: '2026-10-12' } })
    expect(researchGroups([], DATA).team.find((entry) => entry.model === 'model-sol')).not.toHaveProperty('recorded')
  })
})

describe('Agents › Team with a judge (65.1 AC5, AC7)', () => {
  it('while the team holds no judge, the one proposals card on Team names Jev and offers Approve… (Story 75.10)', () => {
    const proposals = teamProposals(BEFORE, { lunaListed: false, researchers: null })
    expect(proposals?.data).toEqual(DATA)
    const markup = renderToStaticMarkup(createElement(TeamPreferences, { team: team(BEFORE), page: { name: 'agents' }, go: noop, proposals }))
    expect(words(markup)).toContain('BMN proposes 1 change to your team. Nothing changes until you approve it. Jev as Judge, with its two providers OpenCode Zen and TypeSafe AI, which may both see private work, as you chose')
    expect(markup).toMatch(/<div class="page-note with-action" role="status" data-proposals="1">.*?>Approve…<\/button>/)
    expect(teamProposals(DATA, { lunaListed: false, researchers: null })).toBeNull()
    expect(pageMarkup({ name: 'agents' })).not.toMatch(/Use proposal|BMN proposes/)
  })

  it('with nothing approved, Changes shows the same card, so one Approve… carries the proposals wherever it is pressed (Story 75.10)', () => {
    const proposals = teamProposals(BEFORE, { lunaListed: false, researchers: null })
    const base = team(BEFORE)
    const unapproved = team(BEFORE, { approved: null, snapshot: { ...base.snapshot!, approved: null } })
    const changes = (shown: typeof proposals): string => renderToStaticMarkup(createElement(TeamPreferences, { team: unapproved, page: { name: 'changes' }, go: noop, proposals: shown }))
    expect(words(changes(proposals))).toContain("Nothing here takes effect until you approve the team for the first time. BMN's proposal is included: Jev as Judge")
    expect(changes(proposals)).toMatch(/<div class="page-note with-action" role="status" data-proposals="1">.*?>Approve…<\/button>/)
    // Without a proposal it is the plain first approval, as before.
    expect(changes(null)).not.toContain('data-proposals')
    expect(words(changes(null))).toContain('Nothing here takes effect until you approve the team for the first time.')
  })

  it('the card shows the class, the role, "Called by BMN" with the model, and public work only where either provider says so', () => {
    const markup = pageMarkup({ name: 'agents' })
    expect(markup).toContain('<span class="class-word">Bishop · Judge</span>')
    expect(markup).toContain('<div class="agent-notes">Says whether a statement is true of a text</div>')
    expect(markup).toContain('<div class="agent-app">Called by BMN · <span class="mono">jev-1.13</span></div>')
    expect(markup).toContain('aria-label="Jev on"')
    expect(markup).toContain('<span class="price mono">$0.042 / $0.00</span>')
    for (const data of [withAnswers('allowed', 'public_only'), withAnswers('public_only', 'allowed'), withAnswers('public_only', 'public_only')]) {
      expect(pageMarkup({ name: 'agents' }, data)).toContain('<div class="agent-app">Called by BMN · <span class="mono">jev-1.13</span> · public work only</div>')
    }
    // The other cards are as they were.
    expect(markup).toContain('<span class="class-word">Knight</span>')
    expect(markup).toContain('<div class="agent-app">Codex · <span class="mono">model-sol</span></div>')
  })

  it('Review shows the proposed agent in the page\'s words: who receives the request, who runs the model, and no efforts', () => {
    const added: RosterDiffShape = { scope: 'agent', id: 'jev', field: null, kind: 'added', after: { present: true, value: JEV } }
    const group = groupDifferences([added], DATA, BEFORE, ['Jev could be asked as the judge', 'Jev could be sent private text']).groups[0]
    const lines = group?.lines.map((line) => `${line.field}: ${line.after}`) ?? []
    expect(lines.slice(0, 7)).toEqual(['Agent: added', 'Name: Jev', 'Class: Bishop', 'Agent app: none, called by BMN', 'Model: jev-1.13', 'Receives the request: OpenCode Zen', 'Runs the model: TypeSafe AI'])
    expect(lines).toContain('Roles: Judge')
    expect(lines.join('\n')).not.toMatch(/Efforts|run_by|: bmn|typesafe\b/)
    expect(group?.consequences).toEqual(['Jev could be asked as the judge', 'Jev could be sent private text'])
    // A changed party of an agent BMN calls goes by the same words; an app agent's provider stays "Provider".
    const moved = (id: string): string[] => groupDifferences([{ scope: 'agent', id, field: 'provider', kind: 'changed', before: { present: true, value: 'opencode-zen' }, after: { present: true, value: 'openai' } }], DATA, DATA, [])
      .groups[0]?.lines.map((line) => `${line.field}: ${line.before} → ${line.after}`) ?? []
    expect(moved('jev')).toEqual(['Receives the request: OpenCode Zen → OpenAI'])
    expect(moved('sol')).toEqual(['Provider: OpenCode Zen → OpenAI'])
  })

  it('Roles draws the judge by its name alone, and offers it no agent that runs in an app', () => {
    const markup = pageMarkup({ name: 'roles' })
    expect(words(markup)).toMatch(/Judge answers typed questions about a text with numbers; advice only Jev called by BMN → Skip/)
  })
})

describe('Team › Jev (65.1 AC5, 65.3 AC1, AC7)', () => {
  const markup = pageMarkup({ name: 'agent', id: 'jev' })
  const text = words(markup)

  it('has the on and off control, both providers with their answer, the verdict and the price with its page and date', () => {
    expect(markup).toContain('>Turn off…</button>')
    expect(text).toMatch(/Receives the request OpenCode Zen private work allowed Change…/)
    expect(text).toMatch(/Runs the model TypeSafe AI private work allowed Change…/)
    expect(markup).toContain('aria-label="Change private work for TypeSafe AI"')
    expect(text).toContain('Private text May be sent')
    expect(text).toMatch(/Price \$0\.042 \/ \$0\.00 per M tokens, in \/ out From the price page at github\.com , Oct 12/)
    expect(markup).toContain('title="https://github.com/anomalyco/opencode/blob/')
    expect(text).toContain('Model called by BMN itself, not by an agent app')
    expect(text).toContain('Role 0.90 or more reads yes; anything else is no answer. An answer is advice.'.replace('Role ', 'Role Judge '))
  })

  it('says who holds private text back', () => {
    const held = words(pageMarkup({ name: 'agent', id: 'jev' }, withAnswers('allowed', 'public_only')))
    expect(held).toMatch(/Runs the model TypeSafe AI public work only Change…/)
    expect(held).toContain('Private text Not sent')
    expect(held).toContain('Public text only: TypeSafe AI gets public work only.')
    expect(pageMarkup({ name: 'agent', id: 'jev' }, withAnswers('allowed', 'public_only'))).toContain('<span class="answer limits">public work only</span>')
  })

  it('draws no row that belongs to an agent app', () => {
    for (const label of ['Agent app', 'Efforts', 'Context limit', 'Researcher', 'Compact at', 'Paid by', 'Host', 'Also called', 'Roles']) {
      expect(markup, label).not.toContain(`<span>${label}</span>`)
      expect(markup, label).not.toMatch(new RegExp(`<div class="preferences-row-label"><span[^>]*>${label}</span>`))
    }
    expect(markup).not.toContain('role="switch" aria-checked="false" aria-labelledby')
    // A normal agent's page keeps them all.
    const sol = pageMarkup({ name: 'agent', id: 'sol' })
    for (const label of ['Agent app', 'Efforts', 'Context limit', 'Researcher', 'Roles']) expect(sol, label).toMatch(new RegExp(`<div class="preferences-row-label"><span[^>]*>${label}</span>`))
  })

  it('the app choice offers "Called by BMN" only to an agent that holds no role', () => {
    expect(pageMarkup({ name: 'agent', id: 'haiku' })).toContain('>Called by BMN</')
    expect(pageMarkup({ name: 'agent', id: 'sol' })).not.toContain('>Called by BMN</')
    expect(pageMarkup({ name: 'agent', id: 'luna' })).not.toContain('>Called by BMN</')
  })

  it('offers Try it with the text held private until he says otherwise', () => {
    expect(markup).toContain('placeholder="Paste the text to ask about"')
    expect(markup).toContain('placeholder="A sentence that is true or false of the text"')
    expect(text).toContain('Try it goes by the same route and is counted like every call')
    expect(text).toContain('Private text may be sent.')
    expect(markup).toMatch(/<button type="submit" disabled="">Ask<\/button>/)
  })
})

const NOW = new Date(2026, 9, 12, 15, 0)
const at = (hour: number, minute: number, day = 12): string => new Date(2026, 9, day, hour, minute).toISOString()
const VIEW: JudgeView = {
  limit: { on: true, usd: 1 }, reached: false,
  current: { month: '2026-10', calls: 14, input_tokens: 5810, cost_usd: 0.000244, refused: 3, estimated: 0, purposes: {
    'try-it': { calls: 2, input_tokens: 830, cost_usd: 0.000035 }, 'dev-auto': { calls: 9, input_tokens: 3735, cost_usd: 0.000157 }, brain: { calls: 3, input_tokens: 1245, cost_usd: 0.000052 }
  } },
  previous: { month: '2026-09', calls: 0, input_tokens: 0, cost_usd: 0, refused: 0, estimated: 0, purposes: {} },
  calls: [
    { at: at(14, 58), by: { kind: 'owner' }, purpose: 'try-it', outcome: 'answered' },
    { at: at(14, 40), by: { kind: 'session', session: 's-1', app: 'claude' }, purpose: 'dev-auto', outcome: 'answered' },
    { at: at(14, 2), by: { kind: 'session', session: 's-2' }, purpose: 'brain', outcome: 'refused', code: 'PRIVATE_NOT_ALLOWED' },
    { at: at(9, 30, 11), by: { kind: 'shell' }, purpose: 'unnamed', outcome: 'timeout' },
    { at: at(9, 10, 11), by: { kind: 'shell' }, purpose: 'unnamed', outcome: 'refused', code: 'LIMIT_REACHED' },
    { at: at(9, 5, 11), by: { kind: 'shell' }, purpose: 'unnamed', outcome: 'refused', code: 'FREE_MODEL' }
  ]
}
const state = (view: JudgeView | null, extra: Partial<JudgeState> = {}): JudgeState => ({ view, loadError: null, setLimit: noop, ask: async () => ({ outcome: 'failed', note: 'not asked in a test' }), ...extra })
const groups = (view: JudgeView | null, data: RosterDataShape = DATA, extra: Partial<JudgeState> = {}): string => renderToStaticMarkup(createElement(JudgeGroups, {
  agent: JEV, parties: calledParties(data, JEV), state: state(view, extra), limitRow: createRef<HTMLDivElement>(), covered: () => ['Jev'], onAnswer: noop,
  sessionName: (id: string) => ({ 's-1': 'bmn-ui' } as Record<string, string>)[id], now: NOW
}))

describe('what Jev\'s calls cost (65.3 AC1)', () => {
  const markup = groups(VIEW)
  const text = words(markup)

  it('this month and the last, in all and per purpose, the dearest first', () => {
    expect(text).toContain('Cost this month and last, by the one-word purpose each caller gives')
    expect(text).toContain(`Calls Tokens in Cost This month October 14 ${thousands(5810)} $0.000244 dev-auto 9 ${thousands(3735)} $0.000157 brain 3 ${thousands(1245)} $0.000052 try-it 2 830 $0.000035 Last month September 0 0 $0`)
    expect(byCost(VIEW.current).map(([purpose]) => purpose)).toEqual(['dev-auto', 'brain', 'try-it'])
    expect(text).toContain('Refused and not charged: 3 this month, 0 last month.')
    expect(text).toContain('About $0.000017 a call so far.')
  })

  it('the last calls: when, who, the purpose and how each ended', () => {
    const lines = [...markup.matchAll(/<li class="(call[^"]*)">(.*?)<\/li>/g)].map((match) => [match[1], words(match[2] ?? '').trim()])
    expect(lines).toEqual([
      ['call', 'Today 14:58 You, on this page try-it answered'],
      ['call', 'Today 14:40 bmn-ui (Claude Code) dev-auto answered'],
      ['call loud', 'Today 14:02 A closed session\'s shell brain refused: private text not allowed'],
      ['call loud', expect.stringMatching(/A shell unnamed no answer in time$/)],
      ['call loud', expect.stringMatching(/A shell unnamed refused: monthly limit reached$/)],
      ['call loud', expect.stringMatching(/A shell unnamed refused$/)]
    ])
    expect(outcomeWords({ outcome: 'shape' })).toBe('not Jev\'s shape')
    expect(outcomeWords({ outcome: 'failed' })).toBe('the request failed')
  })

  it('the monthly limit is a switch that is off by default, and says what is used', () => {
    expect(text).toContain('$0.0002 of $1.00 used this month.')
    expect(markup).toMatch(/class="switch on" role="switch" aria-checked="true"/)
    const off = groups({ ...VIEW, limit: { on: false, usd: 1 } })
    expect(words(off)).toContain('Off: there is no limit.')
    expect(off).toMatch(/class="switch" role="switch" aria-checked="false"/)
    expect(off).toContain('aria-label="Monthly limit in dollars"')
    expect(dollarsOf('0.50')).toBe(0.5)
    expect(dollarsOf('$2')).toBe(2)
    expect(dollarsOf('0,01')).toBe(0.01)
    expect(dollarsOf('0')).toBeNull()
    expect(dollarsOf('-1')).toBeNull()
    expect(dollarsOf('a lot')).toBeNull()
  })

  it('at the limit the page says asking is stopped until next month or a higher limit', () => {
    const reached: JudgeView = { ...VIEW, reached: true, limit: { on: true, usd: 0.0002 } }
    expect(words(groups(reached))).toContain('Reached: asking is stopped until next month or a higher limit.')
    const note = words(renderToStaticMarkup(createElement(LimitReached, { view: reached, name: 'Jev', raise: noop })))
    // A limit under a cent is said as it is, never as $0.00.
    expect(note).toContain('Asking Jev is stopped until next month or a higher limit. This month\'s calls cost $0.0002, which reaches the limit of $0.0002.')
    expect([1, 0.5, 0.01, 0.005, 0.0002].map(limitUsd)).toEqual(['$1.00', '$0.50', '$0.01', '$0.005', '$0.0002'])
    expect(note).toContain('Raise the limit')
    expect(renderToStaticMarkup(createElement(LimitReached, { view: VIEW, name: 'Jev', raise: noop }))).toBe('')
  })

  it('with no calls yet nothing looks missing', () => {
    const empty: JudgeView = { limit: { on: false, usd: 1 }, reached: false, current: { ...VIEW.previous, month: '2026-10' }, previous: VIEW.previous, calls: [] }
    const none = words(groups(empty))
    expect(none).toContain('No calls yet. The first one you ask under Try it is counted here.')
    expect(none).toContain('Last calls the newest 20 No calls yet.')
    expect(none).toContain('Off: there is no limit.')
    expect(groups(empty)).not.toContain('<table')
    // A month with refused calls only has nothing to add up: the refusals are said, and no table of zeros is drawn.
    const refusedOnly = groups({ ...empty, current: { ...empty.current, refused: 1 }, calls: [{ at: at(9, 5), by: { kind: 'shell' }, purpose: 'unnamed', outcome: 'refused', code: 'NO_JUDGE' }] })
    expect(refusedOnly).not.toContain('<table')
    expect(words(refusedOnly)).toContain('No calls yet. The first one you ask under Try it is counted here. Refused and not charged: 1 this month, 0 last month.')
    expect(words(groups(null))).toContain('Reading Jev\'s calls…')
    expect(words(groups(null, DATA, { loadError: 'Could not read the calls: synthetic' }))).toContain('Could not read the calls: synthetic')
  })

  it('a purpose that is a word every object carries has its row like any other (65.2 AC7)', () => {
    const purposes = JSON.parse('{"constructor":{"calls":2,"input_tokens":4000,"cost_usd":0.000168},"brain":{"calls":1,"input_tokens":10,"cost_usd":0.000001}}') as JudgeView['current']['purposes']
    expect(byCost({ purposes }).map(([word]) => word)).toEqual(['constructor', 'brain'])
    const shown = words(groups({ ...VIEW, current: { ...VIEW.current, purposes } }))
    expect(shown).toContain('constructor 2 4 000 $0.000168 brain 1 10 $0.000001')
  })

  it('calls counted by the size of their request are said under the sums, and a record that cannot be read is said in place of them', () => {
    expect(estimatedWords({ estimated: 0 }, { estimated: 0 })).toBeNull()
    expect(text).not.toContain('gave no token count')
    const some = words(groups({ ...VIEW, current: { ...VIEW.current, estimated: 1 }, previous: { ...VIEW.previous, estimated: 4 } }))
    expect(some).toContain('The gateway gave no token count for 1 call this month and 4 last month; BMN estimated their cost from what it sent.')
    const unreadable = words(groups({ ...VIEW, current: { ...VIEW.previous, month: '2026-10' }, calls: [], unreadable: '~/.config/bmn/agents/state/judge/calls.json' }))
    expect(unreadable).toContain("Cannot read Jev's call record at ~/.config/bmn/agents/state/judge/calls.json : the cost is unknown, so nothing is asked. Mend or move it to count again.")
    // Neither sums nor calls are shown of a record that cannot be read: "no calls" would be a claim.
    expect(unreadable).not.toContain('Last calls')
    expect(unreadable).not.toContain('No calls yet')
    // A limit's setting that cannot be read: the sums still show, the limit is said to be unknown, and only his own setting writes it anew.
    const unset = words(groups({ ...VIEW, limit: { on: false, usd: 1 }, limitUnreadable: '~/.config/bmn/agents/state/judge/settings.json' }))
    expect(unset).toContain('BMN cannot read the limit you set at ~/.config/bmn/agents/state/judge/settings.json , so it asks Jev nothing. Set it again: switch it on, or press Keep it off.')
    expect(unset).toContain('Keep it off')
    expect(unset).toContain('dev-auto 9 3 735 $0.000157')
    expect(unset).not.toContain('Off: there is no limit.')
    expect(text).not.toContain('Keep it off')
    // The limit's row claims no amount it cannot know.
    expect(unreadable).toContain('What this month cost is not known.')
    expect(unreadable).not.toContain('used this month')
    expect(unreadable).not.toContain('No calls yet. The first one')
  })

  it('money and months in plain words', () => {
    expect(usd(0, 6)).toBe('$0')
    expect(usd(0.000084, 6)).toBe('$0.000084')
    expect(usd(1, 2)).toBe('$1.00')
    expect(monthName('2026-01')).toBe('January')
    expect(monthName('2026-12')).toBe('December')
  })
})

describe('Try it (65.3 AC2)', () => {
  const reply = (value: JudgeTryReply): string => words(renderToStaticMarkup(createElement(TryAnswer, { reply: value })))
  const answered = (noul: number, near = false, count: { counted?: 'yes' | 'waiting' | 'no'; estimated?: boolean } = {}): Extract<JudgeTryReply, { outcome: 'answered' }> =>
    ({ outcome: 'answered', noul, reading: noul >= 0.9 ? 'yes' : 'no answer', near, input_tokens: 415, cost_usd: 0.000017, took_ms: 812, counted: 'yes', estimated: false, ...count })

  it('shows Jev\'s number and BMN\'s reading', () => {
    expect(reply(answered(0.97))).toContain('0.97 Yes 0.97 is 0.90 or more, so BMN reads yes. It is advice, not proof. 415 tokens in, $0.000017, 0.8 seconds. Counted in the calls below.')
    expect(reply(answered(0.41))).toContain('0.41 No answer 0.41 is under 0.90, so BMN reads no answer. That is not a no.')
    expect(reply(answered(0.91, true))).toContain('Yes, near the line')
    expect(reply(answered(0.889, true))).toContain('0.88 No answer, near the line')
    expect(renderToStaticMarkup(createElement(TryAnswer, { reply: answered(0.97) }))).toContain('<div class="try-reply said">')
    expect(renderToStaticMarkup(createElement(TryAnswer, { reply: answered(0.41) }))).toContain('<div class="try-reply">')
  })

  it('says "counted" only of a call that is in the record, and calls an estimate an estimate (65.2 AC7)', () => {
    expect(tryFacts(answered(0.97))).toBe('415 tokens in, $0.000017, 0.8 seconds. Counted in the calls below.')
    const waits = reply(answered(0.97, false, { counted: 'waiting' }))
    expect(waits).toContain('0.8 seconds. Kept beside the record, which cannot be read just now: it is counted once that is mended.')
    expect(waits).not.toContain('Counted in the calls below')
    const lost = reply(answered(0.97, false, { counted: 'no' }))
    expect(lost).toContain('415 tokens in, $0.000017, 0.8 seconds. Not counted: BMN could not write this call into its record.')
    expect(lost).not.toContain('Counted in the calls below')
    expect(reply(answered(0.97, false, { estimated: true }))).toContain('About 415 tokens in (an estimate: the gateway gave no count), $0.000017, 0.8 seconds. Counted in the calls below.')
  })

  it('a number under the line never looks like 0.90', () => {
    expect(cut(0.899)).toBe('0.89')
    expect(cut(0.8999999)).toBe('0.89')
    expect(cut(0.9)).toBe('0.90')
    expect(cut(0.29)).toBe('0.29')
    expect(cut(1)).toBe('1.00')
    expect(cut(0)).toBe('0.00')
  })

  it('a refusal is said in the command\'s own words; its next step is said to him, not to an agent', () => {
    const refused = reply({ outcome: 'refused', code: 'PRIVATE_NOT_ALLOWED', message: 'the text is declared private, and Jev gets public text only (public work only: TypeSafe AI gets public work only)', next: 'send only text that is public and say so with --data public, or ask the owner' })
    expect(refused).toContain('Refused: the text is declared private, and Jev gets public text only (public work only: TypeSafe AI gets public work only) Choose Public if the text is public, or allow private work for both providers above and approve the team.')
    expect(refused).not.toMatch(/--data|the owner/)
    const limit = reply({ outcome: 'refused', code: 'LIMIT_REACHED', message: 'this month\'s calls to Jev cost $0.0126, which reaches the monthly limit of $0.01', next: 'the owner raises the monthly limit or switches it off' })
    expect(limit).toContain('Raise the monthly limit above or switch it off; otherwise ask again next month.')
    expect(limit).not.toContain('the owner')
    // The two refusals that keep an uncounted call from being made are his to mend, and are said to him.
    expect(reply({ outcome: 'refused', code: 'RECORD_UNREADABLE', message: 'the record of the judge\'s calls is there and cannot be read', next: 'the owner moves the file away' })).toContain('Mend what the message names or move it away, and BMN counts again. Nothing is asked meanwhile.')
    expect(reply({ outcome: 'refused', code: 'LIMIT_UNREADABLE', message: 'the setting of the monthly limit is there and cannot be read', next: 'the owner sets the monthly limit again' })).toContain('Set the monthly limit again above: switch it on, or press Keep it off.')
    expect(reply({ outcome: 'refused', code: 'NO_PRICE', message: 'the approved team records no price for Jev', next: 'the owner records the model\'s price' })).toContain("Record the model's price for it in the team file and approve the team.")
    // A code that is a word every object carries finds no words of the page's own.
    expect(reply({ outcome: 'refused', code: 'constructor', message: 'refused', next: 'the next step' })).toContain('Refused: refused the next step')
    expect(outcomeWords({ outcome: 'refused', code: 'constructor' })).toBe('refused')
    // A refusal the page has no words of its own for keeps the command's next step.
    expect(reply({ outcome: 'refused', code: 'TOO_LARGE', message: 'the text is too long', next: 'send a shorter text' })).toContain('Refused: the text is too long send a shorter text')
  })

  it('no answer in time, a failed request and a wrong shape all read no answer', () => {
    expect(reply({ outcome: 'timeout', note: 'no answer came inside the time for the call' })).toContain('No answer in time no answer came inside the time for the call BMN reads no answer.')
    expect(reply({ outcome: 'failed', note: 'the approved host answered 500' })).toContain('The request failed the approved host answered 500 BMN reads no answer.')
    expect(reply({ outcome: 'shape', note: 'the answer was not Jev\'s shape' })).toContain('Not Jev\'s shape')
  })

  it('says beside Ask what may be sent as the team stands', () => {
    expect(mayBeSentWords(calledParties(DATA, JEV))).toBe('Private text may be sent.')
    expect(mayBeSentWords(calledParties(withAnswers('public_only', 'public_only'), JEV))).toBe('Public text only: OpenCode Zen and TypeSafe AI get public work only.')
  })
})
