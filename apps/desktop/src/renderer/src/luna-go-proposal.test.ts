// MODULE: luna-go-proposal.test.ts - Story 70.4: BMN's proposal of Luna (Go) on Team and the sign-in note, over a synthetic team
import { LUNA_GO_PROPOSAL, type OpenCodeGoView, type RosterAgentShape, type RosterDataShape } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseRoster, rewriteRoster, starterRoster } from '../../../bin/agents-roster.mjs'
import { LUNA_GO_MODEL, OPENCODE_GO_PROVIDER } from '../../../bin/agents-opencode.mjs'
import { lunaGoProposal, namedResearchers, setProviderAnswer, setResearcher } from './roster-staging'
import { LUNA_GO_SIGN_IN_WORDS, OpenCodeSignInNote, judgeClause, lunaGoClause, openCodeSignInWords, teamProposals } from './team-preferences'
import { approvalNotice, type TeamState } from './team-state'

const noop = (): void => {}
const later = async (): Promise<void> => {}
const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'bishop', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default',
  enabled: true, status: 'active', efforts: ['low', 'medium', 'high'], roles: [], ...extra
})

/** A team shaped as the owner's stood on 2026-10-14: no OpenCode agent, no OpenCode Go, Opus named as the researcher. */
const BEFORE: RosterDataShape = {
  schema_version: 3,
  agents: [
    agent('sol', { class: 'knight', roles: ['lead'], efforts: ['xhigh'] }),
    agent('luna', { class: 'pawn', model: 'gpt-6-luna', efforts: ['xhigh', 'max'], roles: ['helper'] }),
    agent('opus', { class: 'queen', harness: 'claude', provider: 'anthropic', roles: [], researcher: true })
  ],
  roles: [{ id: 'lead', candidates: ['sol@xhigh'], then: 'owner-chooses' }, { id: 'helper', candidates: ['luna@max'], then: 'lead' }],
  providers: [{ id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' }, { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' }],
  exceptions: [],
  harness_routes: [{ harness: 'claude', provider: 'anthropic', basis: 'observed-default' }, { harness: 'codex', provider: 'openai', basis: 'observed-default' }]
}
const PROPOSED = lunaGoProposal(BEFORE) as RosterDataShape

const team = (approved: RosterDataShape, extra: Partial<TeamState> = {}): TeamState => ({
  snapshot: {
    rosterPath: '/home/synthetic/.config/bmn/agents/roster.md', home: '/home/synthetic',
    file: { exists: true, hash: 'f'.repeat(64), link: null, directory: '/home/synthetic/.config/bmn/agents', errors: [], warnings: [], data: approved, prose: {} },
    approved: { generation: 4, createdAt: '2026-10-14T12:00:00.000Z', data: approved }, approvalProblem: null, differences: [], consequences: [], history: []
  },
  loadError: null, base: approved, data: approved, approved, hasStaged: false, preview: null, outside: { groups: [], general: [] },
  changed: new Set(), busy: false, notice: null, confirmation: null, needsOwner: false, stage: noop, discard: noop, reload: later, setNotice: noop,
  requestApproval: later, approveProposals: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop, ...extra
})
const signIn = (approved: RosterDataShape, view: OpenCodeGoView | null, copying = false): string =>
  renderToStaticMarkup(createElement(OpenCodeSignInNote, { team: team(approved), state: { view, copying, copy: noop } }))
/** What the owner reads: the markup without tags. */
const words = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('BMN proposes Luna (Go) (70.4 AC1)', () => {
  it('adds her as a read-only helper and a researcher on OpenCode Go, which gets public work only until he allows it', () => {
    expect(LUNA_GO_PROPOSAL.provider.id).toBe(OPENCODE_GO_PROVIDER)
    expect(LUNA_GO_PROPOSAL.agent.model).toBe(LUNA_GO_MODEL)
    expect(PROPOSED.agents.at(-1)).toEqual({
      id: 'luna-go', name: 'Luna (Go)', class: 'pawn', harness: 'opencode', model: 'gpt-6-luna', provider: 'opencode-go', host: 'default',
      enabled: true, status: 'active', efforts: ['xhigh', 'max'], roles: ['helper'], researcher: true
    })
    expect(PROPOSED.providers.at(-1)).toEqual({ id: 'opencode-go', name: 'OpenCode Go', hosts: [], private_work: 'public_only' })
    // Last in the helper's order, at her highest effort; the team's other roles and its routes stay as they were.
    expect(PROPOSED.roles).toEqual([BEFORE.roles[0], { id: 'helper', candidates: ['luna@max', 'luna-go@max'], then: 'lead' }])
    expect(PROPOSED.harness_routes).toEqual(BEFORE.harness_routes)
    expect(namedResearchers(PROPOSED)).toEqual(['opus', 'luna-go'])
    expect(lunaGoClause(PROPOSED)).toBe('Luna (Go) as a read-only helper and a researcher, run by OpenCode, which lists her model on OpenCode Go; OpenCode Go gets public work only until you allow it')
  })

  it('is a team the team file takes', () => {
    const parsed = parseRoster(rewriteRoster(starterRoster(), PROPOSED as never))
    expect(parsed.errors).toEqual([])
    expect(parsed.data).toEqual(PROPOSED)
  })

  it('keeps the answer a team already gives OpenCode Go, and marks no researcher on a team from before the mark', () => {
    const held = { ...BEFORE, providers: [...BEFORE.providers, { id: 'opencode-go', name: 'OpenCode Go', hosts: [], private_work: 'allowed' as const }] }
    const proposed = lunaGoProposal(held) as RosterDataShape
    expect(proposed.providers).toEqual(held.providers)
    expect(lunaGoClause(proposed)).toMatch(/; OpenCode Go may see private work, as you chose$/)
    // Every agent that can research does so on a team from before the mark; marking her alone would take that from the others.
    const unmarked = setResearcher(BEFORE, 'opus', false)
    expect(namedResearchers(unmarked)).toBeNull()
    const open = lunaGoProposal(unmarked) as RosterDataShape
    expect(open.agents.at(-1)?.researcher).toBeUndefined()
    expect(namedResearchers(open)).toBeNull()
    expect(lunaGoClause(open)).toContain('Luna (Go) as a read-only helper and a researcher')
    // A team with no helper role: she joins with none, as a researcher.
    const noHelper = lunaGoProposal({ ...BEFORE, roles: BEFORE.roles.slice(0, 1) }) as RosterDataShape
    expect(noHelper.agents.at(-1)?.roles).toEqual([])
    expect(lunaGoClause(noHelper)).toContain('Luna (Go) as a researcher, run by OpenCode')
  })

  it('proposes nothing once the team holds her model on OpenCode, in either form, or her id', () => {
    expect(lunaGoProposal(PROPOSED)).toBeNull()
    const onApp = (extra: Partial<RosterAgentShape>): RosterDataShape => ({ ...BEFORE, agents: [...BEFORE.agents, agent('other', { harness: 'opencode', provider: 'opencode-go', ...extra })] })
    expect(lunaGoProposal(onApp({ model: 'gpt-6-luna' }))).toBeNull()
    expect(lunaGoProposal(onApp({ model: 'opencode-go/gpt-6-luna', provider: 'zai' }))).toBeNull()
    expect(lunaGoProposal(onApp({ model: 'kimi-k3' }))).not.toBeNull()
    expect(lunaGoProposal({ ...BEFORE, agents: [...BEFORE.agents, agent('luna-go')] })).toBeNull()
    // Luna on Codex is another agent: she is still proposed.
    expect(BEFORE.agents.some((entry) => entry.model === 'gpt-6-luna')).toBe(true)
  })
})

describe('the Team page shows the proposal and the sign-in (70.4, Story 75.10)', () => {
  it('names her in the one proposals card only while OpenCode lists her and the team does not hold her', () => {
    // The team holds no judge either, so the card proposes Jev first and Luna after him.
    const listed = teamProposals(BEFORE, { lunaListed: true, researchers: null })
    expect(listed?.clauses).toEqual([judgeClause(listed!.data), lunaGoClause(listed!.data)])
    // The sign-in an approval copies is said on its own line under the clauses.
    expect(listed?.notes).toEqual([LUNA_GO_SIGN_IN_WORDS])
    expect(LUNA_GO_SIGN_IN_WORDS).toBe('Once you approve, BMN copies your OpenCode Go sign-in into its own OpenCode folder.')
    expect(listed?.data.agents.at(-1)).toEqual(PROPOSED.agents.at(-1))
    expect(teamProposals(BEFORE, { lunaListed: false, researchers: null })?.clauses).toEqual([judgeClause(listed!.data)])
    expect(teamProposals(listed!.data, { lunaListed: true, researchers: null })).toBeNull()
  })

  it('asks for the sign-in where the approved team names an agent on OpenCode Go and BMN\'s folder holds none', () => {
    const approved = setProviderAnswer(PROPOSED, 'opencode-go', 'allowed')
    expect(signIn(approved, null)).toBe('')
    expect(words(signIn(approved, { listed: true, signedIn: false, reason: null }))).toBe(
      'Luna (Go) cannot run yet: BMN\'s OpenCode folder holds no OpenCode Go sign-in. Copy sign-in takes yours from OpenCode on this computer, once, and nothing else of OpenCode\'s. Copy sign-in')
    expect(signIn(approved, { listed: true, signedIn: false, reason: null }, true)).toContain('disabled="">Copying…</button>')
    expect(signIn(approved, { listed: true, signedIn: true, reason: null })).toBe('')
    expect(signIn(approved, { listed: true, signedIn: null, reason: 'OpenCode is not on this computer' })).toBe('')
    const two = { ...approved, agents: [...approved.agents, agent('kimi', { harness: 'opencode', provider: 'opencode-go', model: 'kimi-k3', name: 'Kimi' })] }
    expect(openCodeSignInWords(two)).toMatch(/^Luna \(Go\) and Kimi cannot run yet/)
  })
})

describe('the approval says what became of the sign-in (70.4)', () => {
  const ok = (extra: Partial<Extract<Parameters<typeof approvalNotice>[0], { ok: true }>> = {}) => approvalNotice({ ok: true, snapshot: team(BEFORE).snapshot!, message: 'Approved · version 5', ...extra })
  it('adds the copy\'s words after the rules files, and is not a success where the copy failed', () => {
    expect(ok()).toEqual({ ok: true, text: 'Approved · version 5' })
    expect(ok({ openCodeSignIn: { ok: true, copied: true, message: 'BMN copied your OpenCode Go sign-in into its own OpenCode folder' } }))
      .toEqual({ ok: true, text: 'Approved · version 5 · BMN copied your OpenCode Go sign-in into its own OpenCode folder' })
    expect(ok({ rulesUpdate: { transaction: 'tx-1', written: ['claude'], skipped: [] }, openCodeSignIn: { ok: false, copied: false, message: 'OpenCode is not on this computer, so nothing was copied' } }))
      .toEqual({ ok: false, text: 'Approved · version 5 · Rules updated in 1 app · OpenCode is not on this computer, so nothing was copied', undo: 'tx-1' })
  })
})
