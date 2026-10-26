// MODULE: team-rules-preferences.test.ts - Epic 60.5/60.6 markup: shape and plain words carry meaning, every control is named, no schema word reaches the owner
import type { AgentsPreview, AgentsSnapshot, ResearchModelView, ResearchSnapshot, RosterAgentShape, RosterDataShape, RosterDiffShape, RosterListedApp, RosterToolShape, RulesPlan, RulesSavePlan, RulesSnapshot, ToolProposalView, ToolsPlan } from '@bmn/protocol'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CommandPress } from './session-command'
import {
  INSERTS,
  RulesEditor,
  RulesPreferences,
  ToolEditor,
  ToolProposals,
  UpdateSheet,
  changeWords,
  agentLimitWords,
  notHeldWords,
  contextStateWords,
  contextValueWords,
  destinationWords,
  forgetUpdateWatches,
  diffSummary,
  earlierVersions,
  healthNeedsCount,
  needsFirst,
  hookRowWords,
  hookRows,
  rulesStatus,
  targetStateWords,
  endedSince,
  onUpdateEnded,
  updateEnded,
  insertAt,
  kilobytes,
  lineCount,
  markerParts,
  recheckWords,
  sessionsWords,
  skillStateHint,
  skillStateWords,
  skillsTestLine,
  testLine,
  undoWords,
  updateCommand,
  watchUpdate,
  watchedWords,
  type RulesState
} from './rules-preferences'
import {
  Chain, TeamLedger, TeamPreferences, TeamToast, compactHint, compactRefusal, contextLimitHint, firstApprovalWords, researcherWords, hostKind, limitRefusal, nothingInEffectWords, outsideCountWords,
  retiredAppClause, shortDate, teamProposals, type TeamPage
} from './team-preferences'
import { ModelList } from './model-field'
import { fenceResultWords, fenceWords, noResearcherWords, researcherHint, researchedModels, type ResearchState } from './models-preferences'
import { codexToolsLine, dayWords, fillFrom } from './research-view'
import { modelSuggestions } from './model-suggestions'
import { changeModel, consequenceWords, formatValue, groupDifferences, holdProposed, listedRoles, nameResearchers, namedResearchers, readOnlyProposal, readOnlyProposed, removeException, setResearcher, setRoleReadOnly, setSkillPublic, skillMark, toggleSkillApp } from './roster-staging'
import { readOnlyProposed as cliProposed } from '../../../bin/agents-roster.mjs'
import { EMPTY_DRAFT, draftFrom, type ToolDraft } from './tools-view'
import { confirmsBeforeCommit, rowHidesDetail, rulesUpdateWords, type TeamState } from './team-state'

const noop = (): void => {}
const later = async (): Promise<void> => {}
const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'bishop', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default',
  enabled: true, status: 'active', efforts: ['low', 'medium', 'high'], roles: [], ...extra
})

const DATA: RosterDataShape = {
  schema_version: 2,
  agents: [
    agent('sol', { class: 'knight', roles: ['lead'], efforts: ['xhigh'], context_window: 400000, context_limit: 272000, price: { input: 1.25, output: 10, source: 'https://prices.example.test/sol', as_of: '2026-10-01' } }),
    agent('fable', { class: 'rook', harness: 'claude', provider: 'anthropic', roles: ['designer', 'helper'] }),
    agent('luna', { class: 'pawn', efforts: ['max'], roles: ['helper'] }),
    agent('haiku', { class: 'pawn', harness: 'claude', provider: 'anthropic', status: 'proposed' }),
    agent('glm', { class: 'pawn', harness: 'claude', provider: 'zai', host: 'api.z.ai', enabled: false, enabled_note: 'Subscription ended', efforts: [], roles: ['helper'] })
  ],
  roles: [
    { id: 'lead', description: 'leads an epic/project start to finish', candidates: ['sol@xhigh'], then: 'owner-chooses' },
    { id: 'designer', candidates: ['fable@medium|high'], then: 'lead' },
    { id: 'helper', candidates: ['glm@max', 'luna@max', 'fable@low'], then: 'skip' }
  ],
  providers: [
    { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' },
    { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' },
    { id: 'zai', name: 'Z.ai', hosts: ['api.z.ai'], private_work: 'public_only' }
  ],
  exceptions: [],
  harness_routes: [
    { harness: 'claude', provider: 'anthropic', basis: 'observed-default' },
    { harness: 'codex', provider: 'openai', basis: 'observed-default', accepted_versions: ['0.170.0'] },
    { harness: 'opencode', provider: 'zai', basis: 'owner-declared' }
  ]
}

const SNAPSHOT: AgentsSnapshot = {
  rosterPath: '/home/synthetic/.config/bmn/agents/roster.md', home: '/home/synthetic',
  file: { exists: true, hash: 'f'.repeat(64), link: null, directory: '/home/synthetic/.config/bmn/agents', errors: [], warnings: [], data: DATA, prose: { sol: 'Fast lead for everyday work.\nSecond line.' } },
  approved: { generation: 4, createdAt: '2026-10-09T22:13:00.000Z', data: DATA },
  approvalProblem: null, differences: [], consequences: [],
  history: [
    { number: 4, valid: true, created_at: '2026-10-09T22:13:00.000Z', summary: 'Opus could no longer be given work' },
    { number: 3, valid: true, created_at: '2026-10-08T10:00:00.000Z', kind: 'restore', restored_from: 1, summary: 'Restored version 1' },
    { number: 2, valid: false },
    { number: 1, valid: true, created_at: '2026-10-01T10:00:00.000Z', earlier_schema: 1 }
  ]
}

const team = (extra: Partial<TeamState> = {}): TeamState => ({
  snapshot: SNAPSHOT, loadError: null, base: DATA, data: DATA, approved: DATA, hasStaged: false, preview: null, outside: { groups: [], general: [] },
  changed: new Set(), busy: false, notice: null, confirmation: null, needsOwner: false, stage: noop, discard: noop, reload: later, setNotice: noop,
  requestApproval: later, approveProposals: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop, ...extra
})
const pageMarkup = (page: TeamPage, state: TeamState = team()): string => renderToStaticMarkup(createElement(TeamPreferences, { team: state, page, go: noop }))
const ledgerMarkup = (state: TeamState): string => renderToStaticMarkup(createElement(TeamLedger, { team: state }))
const toastMarkup = (state: TeamState): string => renderToStaticMarkup(createElement(TeamToast, { team: state }))
const count = (markup: string, text: string): number => markup.split(text).length - 1
/** What the owner reads: the markup without tags, attributes left out. */
const words = (markup: string): string => markup.replace(/<[^>]+>/g, ' ')

/** Words of the schema and of the earlier design that no page may show (R60-NFR8). */
const SCHEMA_WORDS = /\b(route|routes|packet|seal|generation|generations|trust|harness|roster|High|Low)\b/

describe('Agents › Team (60.5 AC2)', () => {
  const markup = pageMarkup({ name: 'agents' })

  it('heads the page with Team, the approval date and New agent', () => {
    expect(markup).toContain(`<h3 class="page-title">Team</h3><span class="faint">Approved ${shortDate('2026-10-09T22:13:00.000Z')}</span>`)
    expect(markup).toContain('>New agent</button>')
  })

  it('groups solid cards as Active, Proposed and Off, each with its piece, class word, notes, app and model', () => {
    expect([...markup.matchAll(/<h4 class="group-head">([A-Za-z]+)/g)].map((match) => match[1])).toEqual(['Active', 'Proposed', 'Off'])
    expect(markup).toContain('<span class="class-word">Knight</span>')
    expect(markup).toContain('<span class="class-word">Rook</span>')
    expect(markup).toContain('<div class="agent-notes">Fast lead for everyday work.</div>')
    expect(markup).not.toContain('Second line.')
    expect(markup).toContain('<div class="agent-app">Codex · <span class="mono">model-sol</span></div>')
    expect(markup).toContain('<span class="price mono">$1.25 / $10.00</span>')
    expect(count(markup, 'class="piece-plate"')).toBe(5)
  })

  it('an agent that is on has a named switch; a proposed one offers Activate; one that is off shows its reason and public work only', () => {
    expect(markup).toContain('class="switch on" role="switch" aria-checked="true" aria-label="Sol on"')
    expect(markup).toMatch(/aria-label="Open Haiku".*?>Activate<\/button>/)
    expect(markup).toContain('<article class="agent-card off">')
    expect(markup).toContain('<div class="agent-notes">Subscription ended</div>')
    expect(markup).toContain('<span class="mono">model-glm</span> · public work only</div>')
    expect(markup).toContain('class="switch" role="switch" aria-checked="false" aria-label="Glm on"')
  })

  it('puts the dot on a card with an unapproved change, and one row per section changed in the team file, under a line that says why', () => {
    const changed = pageMarkup({ name: 'agents' }, team({
      changed: new Set(['luna']),
      outside: { groups: [{ key: 'luna', subject: 'Luna', agent: DATA.agents[2] as RosterAgentShape, lines: [{ field: 'Model', before: 'gpt-6-luna', after: 'gpt-6.1-luna' }], consequences: [] }], general: [] }
    }))
    expect(count(changed, 'class="needs-dot" role="img" aria-label="Unapproved change"')).toBe(1)
    expect(changed).toContain('<b>Luna</b><span class="muted">in the team file:</span><span class="outside-diff"><span class="difference"><span class="muted">Model:</span> gpt-6-luna → gpt-6.1-luna</span></span>')
    expect(changed).toContain('aria-label="Keep the change to Luna">Keep</button>')
    expect(changed).toContain('aria-label="Revert the change to Luna">Revert</button>')
    // The owner ran a script and read "outside BMN" as "not me": the line says what happened and what holds meanwhile.
    expect(words(changed)).toContain('The team file was edited elsewhere: by hand, a script or an agent. The approved team holds until you keep the change.')
    expect(changed).not.toContain('Keep all')
  })

  it('several changes in the team file can be kept or put back together, and keeping all opens the sheet first', () => {
    const asked: Array<{ request: unknown; words: { title: string; action: string }; always: boolean | undefined }> = []
    const group = (index: number) => ({ key: ['luna', 'fable', 'harness-routes'][index] as string, subject: ['Luna', 'Fable', 'Agent apps'][index] as string, lines: [{ field: 'Host', before: 'none', after: 'Provider default' }], consequences: [] })
    const state = team({ outside: { groups: [group(0), group(1), group(2)], general: [] }, requestApproval: async (request, title, always) => { asked.push({ request, words: title, always }) } })
    const markup = pageMarkup({ name: 'agents' }, state)
    expect(words(markup)).toContain('The approved team holds until you keep them.')
    expect(markup).toContain('aria-label="Keep all 3 changes to the team file">Keep all…</button>')
    expect(markup).toContain('aria-label="Revert all 3 changes to the team file">Revert all</button>')
    expect(count(markup, '>Keep</button>')).toBe(3)
    expect(markup.indexOf('Keep all…')).toBeLessThan(markup.indexOf('>Keep</button>'))
    expect([outsideCountWords(1), outsideCountWords(8)]).toEqual(['1 change', '8 changes'])
  })

  it('an agent without a recorded host shows no host as chosen and says the agent is refused until one is', () => {
    const unknown: RosterDataShape = { ...DATA, agents: DATA.agents.map((entry) => (entry.id === 'luna' ? { ...entry, host: null } : entry)) }
    const chosen = /aria-checked="true"[^>]*>Provider default</
    const page = pageMarkup({ name: 'agent', id: 'luna' }, team({ data: unknown, base: unknown }))
    expect(page).not.toMatch(chosen)
    expect(page).toContain('No host is recorded, so BMN refuses every request for Luna. Choose one.')
    // With nothing chosen the first option still takes the Tab key.
    expect(page).toMatch(/aria-checked="false" tabindex="0"[^>]*>Provider default</)
    expect(pageMarkup({ name: 'agent', id: 'luna' })).toMatch(chosen)
    expect([hostKind(null), hostKind('default'), hostKind('api.z.ai')]).toEqual([null, 'default', 'custom'])
  })

  it('with nothing approved, says that nothing takes effect and offers the first approval', () => {
    const first = pageMarkup({ name: 'agents' }, team({ snapshot: { ...SNAPSHOT, approved: null, history: [] }, approved: null }))
    expect(first).toContain('<span class="faint">Nothing approved yet</span>')
    expect(first).toContain('Nothing here takes effect until you approve the team for the first time.')
    expect(first).toContain('>Approve…</button>')
    expect(firstApprovalWords(DATA)).toBe('3 active agents and 3 roles take effect')
    expect(firstApprovalWords({ ...DATA, project_choices: [{ id: 'shop-review', project: '/home/synthetic/shop', role: 'epic-reviewer', agent: 'fable' }] })).toBe('3 active agents, 3 roles and 1 project choice take effect')
  })

  it('offers to start a team when there is no team file, and names the file when it cannot be read', () => {
    const none = pageMarkup({ name: 'agents' }, team({ snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, exists: false, data: null, hash: null }, approved: null }, data: null }))
    expect(none).toContain('>Start a team</button>')
    const broken = pageMarkup({ name: 'agents' }, team({ data: null, snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, data: null, errors: [{ code: 'INVALID_VALUE', line: 12, message: 'class must be knight | queen | rook | bishop | pawn' }] } } }))
    expect(broken).toContain('<span class="mono">~/.config/bmn/agents/roster.md</span>')
    expect(broken).toContain('<li>Line 12: class must be knight | queen | rook | bishop | pawn</li>')
  })
})

describe('Team › an agent, New agent (60.5 AC3, AC4)', () => {
  it('lists Identity, Model and Work as plain rows and keeps Advanced closed', () => {
    const markup = pageMarkup({ name: 'agent', id: 'sol' })
    expect(markup).toMatch(/<button type="button" class="crumb">Team<\/button> <span class="faint">›<\/span> Sol/)
    expect([...markup.matchAll(/<h4 class="group-head">([A-Za-z]+)<\/h4>/g)].map((match) => match[1])).toEqual(['Identity', 'Model', 'Work'])
    expect([...markup.matchAll(/<div class="preferences-row-label"><span[^>]*>([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(
      ['Name', 'Class', 'Notes', 'Agent app', 'Model', 'Private work', 'Price', 'Context limit', 'Roles', 'Efforts', 'Researcher', 'Paid by', 'Compact at', 'Host', 'Also called', 'Team file'])
    expect(markup).toContain('<details class="advanced"><summary>Advanced</summary>')
    expect(markup).toContain('Only you see this. The first line shows on the card.')
    expect(markup).toContain('Set once for OpenAI; it covers every agent there: Sol, Luna.')
    expect(markup).toContain('aria-label="Change private work for OpenAI">Change…</button>')
    expect(markup).toContain('prices.example.test, 2026-10-01')
    expect(markup).toContain('value="272 000"')
    expect(markup).toContain('of 400 000 tokens')
    expect(markup).toContain('>Turn off…</button>')
  })

  it('offers five classes with their piece and line, and bars the roles a class may not hold', () => {
    const markup = pageMarkup({ name: 'agent', id: 'luna' })
    expect([...markup.matchAll(/<\/svg>([A-Za-z]+) <span class="choice-line">([^<]+)<\/span>/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(
      ['Knight: leads an epic/project', 'Queen: does whatever she wants', 'Rook: the Artist: designs what is not there yet', 'Bishop: reviews and advises', 'Pawn: does jobs a lead hands off'])
    expect(markup).toContain('<label class="choice disabled"><input type="checkbox" disabled=""/>Lead <span class="choice-line">Only a Knight or a Queen leads</span></label>')
    expect(markup).toContain('<label class="choice disabled"><input type="checkbox" disabled=""/>Designer <span class="choice-line">Only a Rook or a Queen designs</span></label>')
    expect(markup).toContain('<label class="choice"><input type="checkbox" checked=""/>Helper <span class="choice-line"></span></label>')
  })

  it('New agent is one page whose footer states the consequence and adds to the team', () => {
    const markup = pageMarkup({ name: 'new' })
    expect([...markup.matchAll(/<div class="preferences-row-label"><span[^>]*>([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(
      ['Agent app', 'Model', 'Host', 'Private work', 'Context limit', 'Name', 'Class', 'Notes', 'Roles', 'Efforts'])
    expect(markup).toContain('This agent may receive private work, like every agent on Anthropic.')
    expect(markup).toContain('<button type="button" class="primary" disabled="">Add to team</button>')
  })
})

describe('Team › a team file that still names Cursor (Epic 71, 71.2 AC3)', () => {
  const OLD: RosterDataShape = {
    ...DATA,
    agents: [...DATA.agents, agent('composer', { class: 'pawn', harness: 'cursor', provider: 'cursor', model: 'composer-2', efforts: ['low'] })],
    providers: [...DATA.providers, { id: 'cursor', name: 'Cursor', hosts: [], private_work: 'public_only' }],
    harness_routes: [...DATA.harness_routes, { harness: 'cursor', provider: 'cursor', basis: 'owner-declared' }]
  }
  const state = team({ snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, data: OLD }, approved: { ...SNAPSHOT.approved!, data: OLD } }, data: OLD, base: OLD, approved: OLD })

  it('reads it, says Cursor was retired and proposes removing those lines in the one card; nothing changes until approved (Story 75.10)', () => {
    const proposals = teamProposals(OLD, { lunaListed: false, researchers: null })
    expect(proposals?.clauses[0]).toBe('Cursor was retired on 14 Oct 2026, so Composer, the Cursor route and the Cursor provider are taken out of the team file')
    const markup = renderToStaticMarkup(createElement(TeamPreferences, { team: state, page: { name: 'agents' }, go: noop, proposals }))
    // A head line, then each proposal on a line of its own (docs/design.md W2).
    expect(words(markup).replace(/\s+/g, ' ')).toContain(`BMN proposes ${proposals?.clauses.length} changes to your team. Nothing changes until you approve it. Cursor was retired on 14 Oct 2026, so Composer, the Cursor route and the Cursor provider are taken out of the team file. `)
    // Each proposal ends with a full stop, and the lines keep a review's gap between them (Fable's review of 80.5).
    expect(markup).toContain('<div class="note-text review"><div>BMN proposes')
    expect(markup).toContain('<div>Cursor was retired on 14 Oct 2026, so Composer, the Cursor route and the Cursor provider are taken out of the team file.</div>')
    expect(markup).toContain('>Approve…</button>')
    expect(proposals?.data.agents.map((entry) => entry.id)).not.toContain('composer')
    // The agent is still shown as the file has it.
    expect(markup).toContain('<div class="agent-app">Cursor · <span class="mono">composer-2</span> · public work only</div>')
    // An agent on a retired app cannot be on: its switch shows off and takes no press (71.3).
    expect(markup).toContain('<button type="button" class="switch" role="switch" aria-checked="false" aria-label="Composer on" disabled="">')
    expect(markup).toContain('aria-checked="true" aria-label="Sol on">')
    expect(pageMarkup({ name: 'agents' })).not.toContain('was retired')
    expect(retiredAppClause({ agents: [], routes: [], providers: [], lists: true }))
      .toBe('Cursor was retired on 14 Oct 2026, so Cursor from the apps a skill or tool is kept to is taken out of the team file')
  })

  it('opens the agent with no app picked, says why, and suggests no model until one is', () => {
    const markup = pageMarkup({ name: 'agent', id: 'composer' }, state)
    const appRow = markup.slice(markup.indexOf('>Agent app<'), markup.indexOf('Pick an app'))
    expect([...appRow.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((match) => `${match[2]} ${match[1]}`))
      .toEqual(['Claude Code false', 'Codex false', 'OpenCode false', 'Called by BMN false'])
    expect(markup).toContain('<p class="preferences-help">Cursor was retired on 14 Oct 2026. Pick an app to keep Composer, or use the proposal on Team to remove it.</p>')
    // The page head agrees with the card, whose switch is off (Fable's 71.3 check).
    expect(words(markup).replace(/\s+/g, ' ')).toContain('Composer Retired app')
    expect(markup).toContain('BMN suggests models once an app is picked.')
  })
})

describe('the Model field (60.5: suggestions)', () => {
  it('takes any name, is announced as a list the owner can open, and says where the current name came from', () => {
    const page = pageMarkup({ name: 'agent', id: 'sol' })
    expect(page).toMatch(/<input class="field mono" role="combobox" aria-label="Model" aria-autocomplete="list" aria-expanded="false" aria-controls="[^"]+" aria-describedby="[^"]+"[^>]* value="model-sol"\/>/)
    // The approved name carries no caveat; a name the owner types does (below).
    expect(page).toContain('aria-live="polite">From the approved team.</p>')
    // Closed, the panel is not in the page at all: nothing is read or drawn until the owner opens it.
    expect(page).not.toContain('role="listbox"')
    const fresh = pageMarkup({ name: 'new' })
    expect(fresh).toMatch(/role="combobox" aria-label="Model"[^>]* placeholder="The model name the app takes" value=""/)
    expect(fresh).not.toContain('BMN does not check that')
  })

  it('lists each name once under where BMN knows it from, with the row the keys reached marked', () => {
    const groups = modelSuggestions(DATA, 'codex', [{ harness: 'codex', model: 'model-next', host: null }, { harness: 'codex', model: 'model-luna', host: null }], null)
    const list = renderToStaticMarkup(createElement(ModelList, { id: 'names', groups, active: 1, onPick: noop, onActive: noop }))
    expect(list).toContain('<div class="model-list" id="names" role="listbox" aria-label="Model suggestions">')
    expect(list).toContain('<div role="group" aria-label="On your team"><div class="model-group" aria-hidden="true">On your team</div>')
    expect(list).toContain('<div id="names-1" role="option" aria-selected="true" class="model-option active"><span class="mono">model-luna</span><small>Luna · also reported in an open session</small></div>')
    expect(list).toContain('<div role="group" aria-label="Reported by Codex">')
    expect(list).toContain('<span class="mono">model-next</span><small>in an open session</small>')
    expect([count(list, 'role="option"'), count(list, 'aria-selected="true"'), count(list, '>model-luna<')]).toEqual([3, 1, 1])
    expect(renderToStaticMarkup(createElement(ModelList, { id: 'names', groups: [], active: -1, onPick: noop, onActive: noop }))).toContain('No suggestion matches. The name stays as you typed it.')
  })

  it('a changed model keeps its price and capacity marked as the earlier model\'s until the owner clears them', () => {
    const renamed: RosterDataShape = { ...DATA, agents: DATA.agents.map((entry) => (entry.id === 'sol' ? { ...entry, model: 'model-sol-next' } : entry)) }
    const page = pageMarkup({ name: 'agent', id: 'sol' }, team({ data: renamed, base: DATA, approved: DATA }))
    expect(page).toContain('Recorded for model-sol. Clear it unless the new model costs the same.')
    expect(page).toContain('aria-label="Clear the price recorded for model-sol">Clear</button>')
    expect(page).toContain('of 400 000 tokens, recorded for model-sol')
    expect(page).toContain('Typed by you. BMN does not check that Codex takes this name.')
    // The limit the owner set is his and stays as it is.
    expect(page).toMatch(/aria-label="Context limit"[^>]* value="272 000"/)
    const unchanged = pageMarkup({ name: 'agent', id: 'sol' })
    expect(unchanged).not.toContain('Recorded for')
    expect(unchanged).toContain('prices.example.test, 2026-10-01')
  })

  it('a model changed to one another agent uses shows that agent\'s price and capacity and says whose they are', () => {
    const luna = DATA.agents.find((entry) => entry.id === 'luna') as RosterAgentShape
    const moved = changeModel(DATA, 'luna', 'model-sol', luna)
    const page = pageMarkup({ name: 'agent', id: 'luna' }, team({ data: moved, base: DATA, approved: DATA }))
    expect(page).toContain('Taken from Sol, which uses the same model.')
    expect(page).toContain('<span class="mono">$1.25 / $10.00</span>')
    expect(page).toContain('of 400 000 tokens, taken from Sol')
    // Nothing here describes the earlier model, so there is nothing to clear.
    expect(page).not.toContain('Recorded for')
    expect(page).not.toContain('>Clear</button>')
    expect(page).toContain('From your team: Sol uses it. BMN does not check that Codex takes this name.')
    // Sol's own limit is Sol's: Luna keeps hers (none).
    expect(page).toMatch(/aria-label="Context limit"[^>]* value=""/)
  })

  it('says what Also called is without claiming what the app does with those names', () => {
    expect(pageMarkup({ name: 'agent', id: 'sol' })).toContain('Other names allowed for this agent. BMN does not check what the app maps them to.')
  })
})

describe('Agents › Roles and Changes (60.5 AC5, AC6)', () => {
  it('shows each role as one row: name, line, chain with pieces and efforts, then the fallback in words', () => {
    const markup = pageMarkup({ name: 'roles' })
    expect(markup).toContain('<b>Lead</b><span class="line-detail"> leads an epic/project start to finish</span>')
    const chain = (id: string): string => words(renderToStaticMarkup(createElement(Chain, { role: DATA.roles.find((role) => role.id === id) as RosterDataShape['roles'][number], data: DATA }))).replace(/\s+/g, ' ').trim()
    expect(chain('lead')).toBe('Sol xhigh → Ask me')
    expect(chain('designer')).toBe('Fable medium or high → Lead does it')
    expect(chain('helper')).toBe('Glm, off max public work only › Luna max › Fable low → Skip')
    expect(markup).toContain('For private work, public-only agents are skipped and the next one takes the job.')
    expect(markup).toContain('aria-expanded="false" aria-label="Edit Helper">Edit</button>')
    expect(markup).toContain('>New role</button>')
  })

  it('lists every approved version with its date and summary; an unreadable or earlier-layout one cannot be restored', () => {
    const markup = pageMarkup({ name: 'changes' })
    expect(markup).toContain(`<b>Opus could no longer be given work</b> <span class="line-detail">version 4 · ${shortDate('2026-10-09T22:13:00.000Z')} · in effect</span>`)
    expect(markup).toContain('<b>Restored version 1</b>')
    expect(markup).toContain('<b>This version cannot be read</b>')
    expect(markup).toContain('<b>Approved under an earlier layout</b>')
    expect([...markup.matchAll(/aria-label="Restore version (\d)"/g)].map((match) => match[1])).toEqual(['3'])
    expect(markup).toContain('disabled="" aria-expanded="false" aria-label="View version 2"')
  })

  it('marks a version that never took effect, whether it sits above or below the one in effect', () => {
    const history = SNAPSHOT.history.map((entry) => (entry.number === 3 ? { number: 3, valid: true, created_at: '2026-10-08T10:00:00.000Z', unfinished: true } : entry))
    const markup = pageMarkup({ name: 'changes' }, team({ snapshot: { ...SNAPSHOT, history: [{ number: 5, valid: true, created_at: '2026-10-10T08:00:00.000Z', unfinished: true }, ...history] } }))
    expect(markup).toContain('<b>Never took effect: BMN stopped before this approval finished</b> <span class="line-detail">version 5 ·')
    expect(markup).toContain('<b>Never took effect: BMN stopped before this approval finished</b> <span class="line-detail">version 3 ·')
    expect(markup).toContain('<b>Opus could no longer be given work</b>')
    // A higher number alone says nothing: the mark comes from what BMN recorded.
    expect(pageMarkup({ name: 'changes' }, team({ snapshot: { ...SNAPSHOT, history: [{ number: 5, valid: true, created_at: '2026-10-10T08:00:00.000Z', summary: 'Haiku could be given work' }, ...SNAPSHOT.history] } })))
      .toContain('<b>Haiku could be given work</b>')
  })

  it('a restore with nothing approved names the folders the restored version allows, not the team file\'s', () => {
    const restored = { ...DATA, exceptions: [{ id: 'zai-here', provider: 'zai', folder: '/home/synthetic/restored-work' }] }
    const data = { ...DATA, exceptions: [{ id: 'zai-here', provider: 'zai', folder: '/home/synthetic/file-work' }] }
    const sheet = words(ledgerMarkup(team({
      approved: null, data, snapshot: { ...SNAPSHOT, approved: null, approvalProblem: { code: 'STATE_CORRUPT', message: 'unreadable', lastGood: 3 } },
      confirmation: { request: { kind: 'restore', number: 3 }, title: 'Restore version 3', action: 'Restore',
        preview: { valid: true, errors: [], differences: [], teamUpdate: [], consequences: ['Z.ai could receive private work in one more workspace'], restored } }
    })))
    expect(sheet).toContain('/home/synthetic/restored-work')
    expect(sheet).not.toContain('/home/synthetic/file-work')
  })

  it('offers no restore while the team file holds changes made outside BMN, and says where to settle them', () => {
    const diff: RosterDiffShape = { scope: 'agent', id: 'astra', field: 'model', kind: 'changed', before: { present: true, value: 'model-astra' }, after: { present: true, value: 'model-astra-2' } }
    const markup = pageMarkup({ name: 'changes' }, team({ outside: groupDifferences([diff], DATA, DATA, []) }))
    expect(markup).toContain('The team file holds changes made outside BMN. Keep or revert them on Agents before restoring a version.')
    expect(markup).toContain('<button type="button" class="small" disabled="" aria-label="Restore version 3">')
    expect(pageMarkup({ name: 'changes' })).toContain('<button type="button" class="small" aria-label="Restore version 3">')
  })

  it('says when the approved team can no longer be read, and names the last version that still reads', () => {
    const damaged = team({ approved: null, snapshot: { ...SNAPSHOT, approved: null, approvalProblem: { code: 'STATE_CORRUPT', message: 'generation 4 is missing, unreadable or does not match its hash', lastGood: 3 } } })
    const page = pageMarkup({ name: 'agents' }, damaged)
    expect(page).toContain('<span class="faint">The approved team cannot be read</span>')
    expect(words(page)).toContain('BMN cannot read the approved team, so nothing here is in effect. Version 3 still reads: restore it on Changes, or approve the team again.')
    expect(words(page)).not.toMatch(SCHEMA_WORDS)
    expect(words(pageMarkup({ name: 'changes' }, damaged))).toContain('BMN cannot read the approved team, so nothing here is in effect.')
    expect(nothingInEffectWords(true, null)).toBe('BMN cannot read the approved team, so nothing here is in effect. Approve the team again.')
    // Never approved reads as before.
    const fresh = team({ approved: null, snapshot: { ...SNAPSHOT, approved: null, history: [], approvalProblem: { code: 'NOT_APPROVED', message: 'nothing is approved yet', lastGood: null } } })
    expect(pageMarkup({ name: 'agents' }, fresh)).toContain('<span class="faint">Nothing approved yet</span>')
    expect(words(pageMarkup({ name: 'agents' }, fresh))).toContain('Nothing here takes effect until you approve the team for the first time.')
  })

  it('says a linked team file would be replaced by a regular file before any change is saved', () => {
    const markup = words(pageMarkup({ name: 'agents' }, team({ snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, link: '/home/synthetic/dotfiles/roster.md' } } }))).replace(/\s+/g, ' ')
    expect(markup).toContain('Team file ~/dotfiles/roster.md The team file is a link. Saving here replaces the link with a regular file; the linked file is untouched.')
    // The path is a key/value row, cut at its head with the whole path in its title, so no word of the note sits alone on a line (80.1).
    expect(pageMarkup({ name: 'agents' }, team({ snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, link: '/home/synthetic/dotfiles/roster.md' } } })))
      .toContain('<dl class="kv"><dt>Team file</dt><dd class="path" title="/home/synthetic/dotfiles/roster.md"><bdi>~/dotfiles/roster.md</bdi></dd></dl>')
    expect(pageMarkup({ name: 'agents' })).not.toContain('is a link')
  })
})

describe('the approval footer (60.5 AC7)', () => {
  const preview: AgentsPreview = {
    valid: true, errors: [],
    differences: [{ scope: 'agent', id: 'sol', field: 'context_limit', kind: 'changed', before: { present: true, value: 272000 }, after: { present: true, value: 200000 } }],
    consequences: ['Sol: context limit 272 000 → 200 000'],
    teamUpdate: []
  }

  it('is absent with nothing staged', () => {
    expect(ledgerMarkup(team())).toBe('')
  })

  it('shows the count, the first consequence, Review, Discard and Approve', () => {
    const markup = ledgerMarkup(team({ hasStaged: true, preview }))
    expect(markup).toContain('<b>1 unapproved change</b><span class="muted">Sol: context limit 272 000 → 200 000</span>')
    expect([...markup.matchAll(/>([A-Za-z]+)<\/button>/g)].map((match) => match[1])).toEqual(['Review', 'Discard', 'Approve'])
    expect(markup).toContain('<button type="button" class="primary">Approve</button>')
  })

  it('does not offer Approve for a team that would not be valid, and says why', () => {
    const markup = ledgerMarkup(team({ hasStaged: true, preview: { ...preview, valid: false, differences: [], consequences: [], errors: [{ code: 'INVALID_VALUE', line: 54, message: 'opus has host: default on claude' }] } }))
    expect(markup).toContain('<b>Unapproved changes</b><span class="muted">This would not be a valid team</span>')
    expect(markup).toContain('<button type="button" class="primary" disabled="">Approve</button>')
    expect(markup).toContain('<li>Line 54: opus has host: default on claude</li>')
  })

  it('a confirmation lists each rules file it would also update, with its path, its kind and its diff', () => {
    const markup = ledgerMarkup(team({
      hasStaged: true, preview,
      confirmation: {
        request: { kind: 'staged', data: DATA }, title: 'Approve these changes', action: 'Approve',
        preview: { ...preview, teamUpdate: [{ harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', kind: 'full', diff: '-old\n+new', binding: 'b' }, { harness: 'opencode', path: '/home/synthetic/.config/opencode/AGENTS.md', kind: 'public', diff: '', binding: 'c' }] }
      }
    }))
    expect(markup).toContain('role="group" aria-label="Approve these changes"')
    expect(markup).toContain('<div class="consequence">Also updates the Team line in 2 rules files</div>')
    const path = (file: string): string => `<span class="target-path"><span class="path mono" title="/home/synthetic/${file}">~/${file}</span></span>`
    expect(markup).toContain(`<span>Claude Code</span> ${path('.claude/CLAUDE.md')} <span class="faint">Full rules</span>`)
    expect(markup).toContain(`<span>OpenCode</span> ${path('.config/opencode/AGENTS.md')} <span class="faint">Public sections only</span>`)
    expect(markup).toContain('<pre class="diff">-old\n+new</pre>')
    expect([...markup.matchAll(/>([A-Za-z]+)<\/button>/g)].map((match) => match[1])).toEqual(['Approve', 'Cancel'])
  })

  it('says what an approval did to the rules files and offers Undo', () => {
    expect(rulesUpdateWords({ transaction: 't', written: ['claude', 'codex'], skipped: [] })).toBe('Rules updated in 2 apps')
    expect(rulesUpdateWords({ transaction: 't', written: ['claude'], skipped: ['codex'] })).toBe('Rules updated in 1 app · 1 changed meanwhile; Save in Rules rewrites it')
    expect(rulesUpdateWords({ transaction: null, written: [], skipped: ['claude', 'codex'], failed: 'disk full' })).toBe('No rules file was updated · 2 changed meanwhile; Save in Rules rewrites them · stopped: disk full')
    const markup = toastMarkup(team({ notice: { ok: true, text: 'Approved · version 5 · Rules updated in 2 apps', undo: 't' } }))
    expect(markup).toContain('<div class="toast" role="status"><span>Approved · version 5 · Rules updated in 2 apps</span>')
    expect(markup).toContain('>Undo</button>')
  })

  it('a first approval never commits from the footer alone: the sheet that names allowed folders comes first', () => {
    // Asked to, or rules files would change: as before.
    expect([confirmsBeforeCommit(true, false, 0), confirmsBeforeCommit(false, false, 2), confirmsBeforeCommit(false, false, 0)]).toEqual([true, true, false])
    // Nothing approved yet: always, even with no rules file to update and Review never opened.
    expect(confirmsBeforeCommit(false, true, 0)).toBe(true)
    const data = { ...DATA, exceptions: [{ id: 'zai-here', provider: 'zai', folder: '/home/synthetic/work' }] }
    const sheet = ledgerMarkup(team({
      snapshot: { ...SNAPSHOT, approved: null, history: [] }, approved: null, data, hasStaged: true,
      confirmation: { request: { kind: 'staged', data }, title: 'Approve the team for the first time', action: 'Approve',
        preview: { valid: true, errors: [], differences: [], teamUpdate: [], consequences: ['Sol could be given work', 'Z.ai could receive private work in one more workspace'] } }
    }))
    expect(words(sheet).replace(/\s+/g, ' ')).toContain('Allowed workspaces Z.ai · workspace: /home/synthetic/work · new Z.ai could receive private work in one more workspace')
    expect(sheet.indexOf('Allowed workspaces')).toBeLessThan(sheet.indexOf('>Sol<'))
  })

  it('Keep opens the sheet when its row hides what an added entry grants, or a consequence', () => {
    const added: RosterDiffShape = { scope: 'exceptions', id: 'zai-here', field: null, kind: 'added', after: { present: true, value: { provider: 'zai', folder: '/home/synthetic/work' } } }
    const field: RosterDiffShape = { scope: 'agent', id: 'astra', field: 'model', kind: 'changed', before: { present: true, value: 'model-astra' }, after: { present: true, value: 'model-astra-2' } }
    const sentence = 'Z.ai could receive private work in one more workspace'
    const data = { ...DATA, exceptions: [{ id: 'zai-here', provider: 'zai', folder: '/home/synthetic/work' }] }
    // The row gives the new entry one word: neither its folder nor what it allows shows there.
    const row = words(pageMarkup({ name: 'agents' }, team({ data, outside: groupDifferences([added], data, DATA, [sentence]) })))
    expect(row).toContain('in the team file:')
    expect(row).not.toContain('/home/synthetic/work')
    expect(row).not.toContain(sentence)
    expect([rowHidesDetail({ differences: [added], consequences: [] }), rowHidesDetail({ differences: [field], consequences: [sentence] }), rowHidesDetail({ differences: [field], consequences: [] })]).toEqual([true, true, false])
    // So Keep commits from the sheet, which names the folder and says what it allows.
    const sheet = words(ledgerMarkup(team({
      data, outside: groupDifferences([added], data, DATA, [sentence]),
      confirmation: { request: { kind: 'sections', scope: ['exceptions'] }, title: 'Keep the change to Allowed workspaces', action: 'Keep',
        preview: { valid: true, errors: [], differences: [added], teamUpdate: [], consequences: [sentence] } }
    }))).replace(/\s+/g, ' ')
    // An added entry says "added" once; its fields follow as plain values.
    expect(sheet).toContain('Allowed workspaces Z.ai: added Z.ai · provider: Z.ai Z.ai · workspace: /home/synthetic/work Z.ai could receive private work in one more workspace')
    // An arrow from nothing is never drawn.
    expect(sheet).not.toContain('— →')
    expect(sheet).toContain(sentence)
  })

  it('Undo shows what each rules file would become and waits for the owner; nothing is put back unasked', () => {
    const plan = { ok: true, code: 'OK', planHash: 'h'.repeat(64), targets: [
      { harness: 'claude' as const, path: '/home/synthetic/.claude/CLAUDE.md', kind: 'its earlier bytes', change: 'file', diff: '--- a\n+++ b\n@@ -1,2 +1 @@\n-edited since the update\n old' },
      { harness: 'codex' as const, path: '/home/synthetic/.codex/AGENTS.md', resolvedPath: '/home/synthetic/dotfiles/codex/AGENTS.md', kind: 'its earlier bytes', change: 'file', diff: '-new\n+old' }
    ] }
    const markup = ledgerMarkup(team({ rulesUndo: { transaction: 't', plan } }))
    expect(markup).toContain('<div class="ledger-sheet" role="group" aria-label="Undo the rules update">')
    expect(words(markup).replace(/\s+/g, ' ')).toContain('Claude Code ~/.claude/CLAUDE.md Put back · +0 −1')
    expect(words(markup).replace(/\s+/g, ' ')).toContain('Codex ~/.codex/AGENTS.md → ~/dotfiles/codex/AGENTS.md Put back · +1 −1')
    expect(markup).toContain('<pre class="diff">-edited since the update\n old</pre>')
    expect([...markup.matchAll(/>([A-Za-z ]+)<\/button>/g)].map((match) => match[1])).toEqual(['Undo update', 'Cancel'])
    expect(ledgerMarkup(team({ rulesUndo: { transaction: 't', plan: { ...plan, planHash: null } } }))).toMatch(/<button type="button" class="primary" disabled="">Undo update/)
  })

  it('an approval and an install name where a write would really land when a link leads elsewhere', () => {
    const preview = { valid: true, errors: [], differences: [], consequences: [], teamUpdate: [
      { harness: 'codex' as const, path: '/home/synthetic/.codex/AGENTS.md', resolvedPath: '/home/synthetic/dotfiles/codex/AGENTS.md', kind: 'full' as const, diff: '-a\n+b', binding: 'b' }
    ] }
    const markup = ledgerMarkup(team({ confirmation: { request: { kind: 'file' }, title: 'Approve these changes', action: 'Approve', preview } }))
    expect(words(markup).replace(/\s+/g, ' ')).toContain('Codex ~/.codex/AGENTS.md → ~/dotfiles/codex/AGENTS.md Full rules')
  })

  it('a message floats over the page and leaves the footer to staged changes; only a failure waits to be dismissed', () => {
    const done = team({ notice: { ok: true, text: 'Approved · version 5' } })
    expect(ledgerMarkup(done)).toBe('')
    expect(toastMarkup(done)).toBe('<div class="toast" role="status"><span>Approved · version 5</span></div>')
    const failed = toastMarkup(team({ notice: { ok: false, text: 'The team file changed meanwhile' } }))
    expect(failed).toContain('<div class="toast failed" role="alert"><span class="error-text">The team file changed meanwhile</span>')
    expect(failed).toContain('aria-label="Dismiss the message">Dismiss</button>')
    expect(toastMarkup(team())).toBe('')
  })

  it('reviews a first approval as rows: each agent with what it could do, each role with its chain', () => {
    const first = team({
      snapshot: { ...SNAPSHOT, approved: null, history: [] }, approved: null, hasStaged: true,
      confirmation: {
        request: { kind: 'file' }, title: 'Approve the team for the first time', action: 'Approve',
        preview: { valid: true, errors: [], differences: [], teamUpdate: [], consequences: ['Sol could be given work', 'Sol could lead', 'Sol could receive private work', 'lead would start with Sol'] }
      }
    })
    const markup = ledgerMarkup(first)
    expect(count(markup, 'class="review-group"')).toBe(2)
    expect(markup).toMatch(/<span class="review-subject"><svg[^>]*>.*?<\/svg>Sol<\/span><div><div class="consequence">Can be given work, can lead, may receive private work<\/div><\/div>/)
    expect(markup).toMatch(/<span class="review-subject">Lead<\/span><div><div class="chain"><span class="chain-step"><svg[^>]*>.*?<\/svg><span>Sol<\/span><span class="effort mono">xhigh<\/span><\/span>/)
    expect(markup).not.toContain('lead would start with Sol')
  })

  it('draws a changed order as steps, before and after', () => {
    const markup = ledgerMarkup(team({
      hasStaged: true,
      confirmation: {
        request: { kind: 'staged', data: DATA }, title: 'Approve these changes', action: 'Approve',
        preview: {
          valid: true, errors: [], teamUpdate: [], consequences: ['helper would start with Luna instead of GLM-5.3'],
          differences: [{ scope: 'roles', id: 'helper', field: 'candidates', kind: 'changed', before: { present: true, value: ['glm@max', 'luna@max'] }, after: { present: true, value: ['luna@max', 'glm@max'] } }]
        }
      }
    }))
    expect(count(markup, '<span class="chain">')).toBe(2)
    expect(markup).not.toContain('luna@max')
    expect(markup).toContain('<div class="consequence">Helper would start with Luna instead of GLM-5.3</div>')
  })
})

const RULES: RulesSnapshot = {
  masterPath: '/home/synthetic/.config/bmn/agents/global-rules.md', home: '/home/synthetic',
  master: { exists: true, text: '# Rules\n<!-- bmn:public -->\nAnswer first.\n<!-- /bmn:public -->\nThe team: <!-- bmn:team -->.\n', hash: 'a'.repeat(64), bytes: 92, savedAt: '2026-10-09T21:50:00.000Z', errors: [] },
  renderings: [
    { harness: 'claude', text: 'FULL TEXT', bytes: 2048, kind: 'full', reason: '', teamForm: 'names by app' },
    { harness: 'opencode', text: 'PUBLIC TEXT', bytes: 100, kind: 'public', reason: "BMN can't confirm where OpenCode sends data", teamForm: 'names by app' }
  ],
  health: {
    state: 'checked', checkedAt: '2026-10-09T22:13:00.000Z', ok: false,
    targets: [
      { harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', state: 'current', kind: 'full', reason: '' },
      { harness: 'codex', path: '/home/synthetic/.codex/AGENTS.md', state: 'stale', kind: 'full', reason: '' },
      { harness: 'opencode', path: '/home/synthetic/.config/opencode/AGENTS.md', state: 'missing', kind: 'public', reason: "BMN can't confirm where OpenCode sends data" }
    ]
  },
  probes: [{ harness: 'claude', outcome: 'pass', at: '2026-10-09T20:00:00.000Z', stale: true }, { harness: 'codex', outcome: null }],
  apps: [
    { harness: 'claude', version: '2.1.295', program: '/home/synthetic/.local/bin/claude', programTarget: '/home/synthetic/.local/share/claude/versions/2.1.295', basis: 'default', provider: 'anthropic', host: null, sources: [], versionState: 'tested', versionNote: 'BMN tested how this version picks where to send data.' },
    { harness: 'codex', version: '0.171.0', program: '/home/synthetic/.npm-global/bin/codex', basis: 'default', provider: 'openai', host: null, sources: [], versionState: 'newer', versionNote: 'Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.' },
    { harness: 'opencode', version: null, program: null, basis: 'unknown', provider: null, host: null, sources: [], versionState: 'unknown', versionNote: 'OpenCode is not installed, or its version cannot be read.' }
  ],
  context: [
    { harness: 'codex', path: '/home/synthetic/.codex/config.toml', exists: true, limit: 380000, compact: 342000, version: '0.171.0', limitProven: false, compactProven: false,
      test: { at: '2026-10-09T20:00:00.000Z', version: '0.161.0', outcome: 'pass', detail: 'asked for 123000; the session record shows 116850', asked: 123000, observed: 116850 }, autoTest: 'scheduled', agents: ['Sol', 'Astra', 'Luna'],
      limits: [{ agent: 'Sol', limit: 272000, state: 'not-applied', reason: 'the context setting is not tested on this Codex version yet; BMN tests it by itself when it starts' }] },
    { harness: 'claude', path: '/home/synthetic/.claude/settings.json', exists: true, limit: null, compact: null, version: '2.1.295', limitProven: true, compactProven: false, min: 100000, max: 1000000,
      test: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'asked for 137000; Claude Code reports a window of 137000', asked: 137000, observed: 137000 }, autoTest: 'none', agents: ['Opus', 'Fable'], limits: [] }
  ],
  autoTests: { running: null, stopped: [] },
  readOnlyRoles: { held: ['epic-reviewer'], proposed: [] },
  skills: {
    source: { path: '/home/synthetic/.claude/skills', readable: true }, markedMissing: [], ownLeft: [], pending: 1, exposed: 1,
    skills: [
      { name: 'alpha', description: 'First synthetic skill.', readable: true, states: { claude: 'read-directly', codex: 'current', opencode: 'exposed' } },
      { name: 'beta', description: 'Second synthetic skill.', readable: true, states: { claude: 'read-directly', codex: 'missing', opencode: 'read-directly' } },
      { name: 'Bad_Name', description: '', readable: false, detail: 'the name must be lowercase letters, digits and hyphens', states: {} }
    ],
    apps: [
      { harness: 'claude', version: '2.1.295', supported: true, testable: true, location: null, format: null, readsSource: true, kind: 'full', kindReason: '', state: 'Reads the source',
        test: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'Claude Code reads skills from ~/.claude/skills' },
        loadTestable: true, listing: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'Claude Code named a test skill', stale: true }, loading: null },
      { harness: 'codex', version: '0.171.0', supported: true, testable: true, location: '/home/synthetic/.agents/skills', format: 'link', readsSource: false, kind: 'full', kindReason: '', state: 'Missing',
        test: { at: '2026-10-09T20:00:00.000Z', version: '0.171.0', outcome: 'pass', detail: 'Codex reads skills from ~/.agents/skills' }, loadTestable: true, listing: null, loading: null },
      { harness: 'opencode', version: '1.18.32', supported: true, testable: true, location: null, format: null, readsSource: true, kind: 'public', kindReason: 'OpenCode Go gets public work only', state: 'Exposed',
        test: { at: '2026-10-09T20:00:00.000Z', version: '1.18.32', outcome: 'pass', detail: 'OpenCode reads skills from ~/.claude/skills' }, loadTestable: false, listing: null, loading: null }
    ]
  },
  tools: {
    pending: 2, exposed: 1, blocked: 1,
    tools: [
      { id: 'docs', states: { claude: 'current', codex: 'missing', opencode: 'excluded' }, details: {} },
      { id: 'notes', states: { claude: 'edited-outside', codex: 'blocked', opencode: 'exposed' }, details: { codex: 'Codex takes a variable only under its own name: NOTES_TOKEN is asked for as TOKEN' } },
      { id: 'browser', states: {}, details: {} }
    ],
    apps: [
      { harness: 'claude', version: '2.1.295', supported: true, path: '/home/synthetic/.claude.json', readable: true, kind: 'full', kindReason: '', state: 'Differs', variable: true, isolation: true,
        test: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'Claude Code listed the stand-in tool' }, unlisted: [{ id: 'old-search', state: 'unmanaged', managed: false }] },
      { harness: 'codex', version: '0.171.0', supported: true, path: '/home/synthetic/.codex/config.toml', readable: true, kind: 'full', kindReason: '', state: 'Missing', variable: false, isolation: false,
        test: { at: '2026-10-09T20:00:00.000Z', version: '0.171.0', outcome: 'pass', detail: 'Codex listed the stand-in tool' }, unlisted: [] },
      { harness: 'opencode', version: '1.18.32', supported: true, path: '/home/synthetic/.config/opencode/opencode.jsonc', readable: true, link: '/home/synthetic/dotfiles/opencode.jsonc', kind: 'public', kindReason: 'OpenCode Go gets public work only', state: 'Exposed', variable: true, isolation: false,
        test: { at: '2026-10-09T20:00:00.000Z', version: '1.18.32', outcome: 'pass', detail: 'OpenCode listed the stand-in tool' }, unlisted: [{ id: 'old-search', state: 'exposed', managed: false }] }
    ]
  },
  transactions: [
    { id: 't4', createdAt: '2026-10-09T23:30:00.000Z', state: 'complete', reason: 'tools install', targets: ['claude'], valid: true },
    { id: 't3', createdAt: '2026-10-09T23:00:00.000Z', state: 'complete', reason: 'skills install', targets: ['codex'], valid: true },
    { id: 't2', createdAt: '2026-10-09T22:00:00.000Z', state: 'complete', reason: 'team update', targets: ['claude'], valid: true },
    { id: 't1', createdAt: '2026-10-08T14:02:00.000Z', state: 'complete', reason: 'install', targets: ['claude', 'codex'], valid: true },
    { id: 't0', valid: false }
  ],
  history: [{ revision: 1, at: '2026-10-08T13:58:00.000Z', hash: 'h', bytes: 290, reason: 'saved', intact: true }, { revision: 2, at: '2026-10-09T09:00:00.000Z', hash: 'i', bytes: 2000, reason: 'saved', intact: false }],
  hooks: {
    state: 'checked', checkedAt: '2026-10-09T21:31:00.000Z', apps: [
      { harness: 'claude', file: '/home/synthetic/.claude/settings.json', state: 'checked', placed: ['Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'], older: [], installed: [], left: [] },
      { harness: 'codex', file: '/home/synthetic/.codex/hooks.json', state: 'installed', placed: ['PreToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'], older: [], installed: ['SessionStart', 'SessionEnd'], left: [{ event: 'PostToolUse', why: 'changed' }, { event: 'Interrupt', why: 'foreign' }] },
      { harness: 'opencode', file: '/home/synthetic/.config/opencode/bmn/tui.ts', state: 'not-set-up', placed: [], older: [], installed: [], left: [] }
    ]
  }
}

const rules = (extra: Partial<RulesState> = {}): RulesState => ({
  snapshot: RULES, began: Date.parse('2026-10-09T22:13:00.000Z'), loadError: null, draft: RULES.master.text ?? '', dirty: false, draftPlan: null, busy: false, notice: null, pending: null, setDraft: noop, setNotice: noop,
  ensure: noop, refresh: noop, load: later, beginSave: later, beginToolsRemoval: later, beginUndo: later, beginRestore: later, beginTest: noop, confirm: later, cancel: noop, run: async () => true, ...extra
})
const rulesMarkup = (page: 'editor' | 'skills' | 'tools' | 'health', state: RulesState = rules(), teamState: TeamState = team()): string =>
  renderToStaticMarkup(createElement(RulesPreferences, { rules: state, team: teamState, page }))

describe('Integrations › Rules (60.6 AC1–AC3)', () => {
  const markup = rulesMarkup('editor')

  const SAVE: RulesSavePlan = {
    ok: true, code: 'OK', valid: true, errors: [], diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', expectedHash: 'a'.repeat(64), expectedLink: null, expectedDirectory: '/home/synthetic/.config/bmn/agents',
    renderings: [], changesMaster: true, planHash: 'p'.repeat(64), blocked: [],
    targets: [
      { harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', kind: 'updates BMN\'s file', change: 'stale', diff: '-old\n+new', rendering: 'full' },
      { harness: 'opencode', path: '/home/synthetic/.config/opencode/AGENTS.md', kind: 'creates the file', change: 'missing', diff: '+new', rendering: 'public' }
    ]
  }

  it('says a linked rules file would be replaced by a regular file, on the sheet that saves it', () => {
    const plan = { ...SAVE, expectedLink: '/home/synthetic/dotfiles/global-rules.md' }
    const linked = words(rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan } }))).replace(/\s+/g, ' ')
    expect(linked).toContain('The rules file is a link to ~/dotfiles/global-rules.md . This replaces the link with a regular file here; the file it points to stays as it is.')
    expect(rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: SAVE } }))).not.toContain('is a link to')
  })

  it('saves and installs in one step: the sheet lists each app\'s file, Undo puts them back with the rules, and no Install… is left (Story 75.9)', () => {
    const sheet = rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: SAVE } }))
    expect(sheet).toContain('aria-label="Save the rules · +1 −1"')
    expect(sheet).toContain('<button type="button" class="primary">Save</button><button type="button">Cancel</button>')
    expect(words(sheet)).toContain('Each app&#x27;s file below is written at once. Undo, under Earlier versions, puts the rules and every file back.')
    expect(sheet).toMatch(/<summary><span>Claude Code<\/span>.*?<span class="muted">\+1 −1<\/span><\/span><span class="muted">Full rules<\/span><\/summary>/)
    expect(sheet).toMatch(/<summary><span>OpenCode<\/span>.*?<span class="muted">New file<\/span><\/span><span class="muted">Public sections only<\/span><\/summary>/)
    expect(sheet).not.toContain('Install…')
    // An app whose destination no longer inspects as approved is named, and not written.
    const blocked = words(rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: { ...SAVE, blocked: [{ harness: 'codex', reason: 'it sends data to a custom host; set its destination again' }] } } })))
    expect(blocked).toContain('Codex is not written: it sends data to a custom host; set its destination again')
    // Rules an app could not read are not saved.
    const refused = rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: { ...SAVE, ok: false, code: 'MASTER_INVALID', valid: false, planHash: null, targets: [], errors: [{ code: 'RULES_MARKER', message: 'A public section is not closed.' }] } } }))
    expect(refused).toContain('These rules cannot be saved')
    expect(refused).toContain('<button type="button" class="primary" disabled="">Save</button>')
    // With the rules unchanged, Save writes only the files that differ.
    const files = rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'same', plan: { ...SAVE, changesMaster: false, diff: '' } } }))
    expect(files).toContain('aria-label="Write the saved rules to 2 apps"')
    expect(rulesMarkup('editor', rules({ busy: true, pending: { kind: 'save', text: 'new', plan: SAVE } }))).toContain('<button type="button" class="primary" disabled="">Working…</button><button type="button" disabled="">Cancel</button>')
  })

  it('heads the page with the save, a file BMN could not write first, and keeps Save… on while an app differs (Story 75.9)', () => {
    expect(markup).toMatch(/<span class="faint"><span class="needs-dot"[^>]*><\/span>Saved [^<]+ · Codex and OpenCode not written<\/span>/)
    expect(markup).not.toContain('Install…')
    // A clean draft can still be saved: that writes the saved rules into the apps whose file differs.
    expect(markup).toContain('<button type="button" title="Writes the saved rules into the apps whose file differs">Save…</button>')
    const current = rulesMarkup('editor', rules({ snapshot: { ...RULES, health: { state: 'checked', checkedAt: RULES.health.checkedAt, ok: true, targets: [] } } }))
    expect(current).toContain(`<span class="faint">Saved and installed ${shortDate('2026-10-09T21:50:00.000Z')}</span>`)
    expect(current).toContain('<button type="button" disabled="">Save…</button>')
    expect(rulesStatus({ master: { ...RULES.master, exists: false }, health: RULES.health })).toEqual({ text: 'No rules yet', needs: false })
  })

  it('says after a save where the rules went, a failure first, with a small Undo that opens its sheet there (Story 75.9)', () => {
    const notice = rulesMarkup('editor', rules({ notice: { ok: true, text: 'Saved and installed to Claude Code, Codex and OpenCode', undo: 't5' } }))
    expect(notice).toContain('<p class="preferences-success" role="status">Saved and installed to Claude Code, Codex and OpenCode · <button type="button" class="small">Undo</button></p>')
    const undo: RulesPlan = {
      ok: true, code: 'OK', planHash: 'u'.repeat(64), master: { path: RULES.masterPath, becomes: 'its earlier bytes', diff: '-new\n+old' },
      targets: [{ harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', kind: 'its earlier bytes', change: 'file', diff: '-new\n+old' }]
    }
    const sheet = rulesMarkup('editor', rules({ notice: { ok: true, text: 'Saved', undo: 't5' }, pending: { kind: 'undo', transaction: 't5', plan: undo, near: 'notice' } }))
    expect(sheet.indexOf('aria-label="Undo this save"')).toBeLessThan(sheet.indexOf('class="editor-head"'))
    expect(words(sheet)).toContain('The rules and each file go back to what they were before that save. Nothing is installed again.')
    expect(sheet).toContain('<summary><span>The rules</span>')
    expect(sheet).toContain('<button type="button" class="primary">Undo</button>')
  })

  it('shows the path and size, numbers every line and dims the markers', () => {
    expect(markup).toContain('title="/home/synthetic/.config/bmn/agents/global-rules.md">~/.config/bmn/agents/global-rules.md</span>')
    expect(markup).toContain('· 92 B · 5 lines')
    const editor = renderToStaticMarkup(createElement(RulesEditor, { value: 'One\n<!-- bmn:public -->\nThe team: <!-- bmn:team -->.', readOnly: false, labelledBy: 'x', onChange: noop, area: createRef<HTMLTextAreaElement>() }))
    expect([...editor.matchAll(/<span class="line-number">(\d+)<\/span>/g)].map((match) => match[1])).toEqual(['1', '2', '3'])
    expect([...editor.matchAll(/<span class="marker">([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(['&lt;!-- bmn:public --&gt;', '&lt;!-- bmn:team --&gt;'])
    expect(editor).toContain('<div class="rules-editor-text" aria-hidden="true">')
    expect(editor).toContain('<textarea aria-labelledby="x" spellCheck="false" wrap="soft">')
  })

  it('names each rendering Full rules or Public sections only, with the reason', () => {
    expect(markup).toContain('<summary>What each app reads</summary>')
    expect(markup).toContain('Full rules · 2.0 KB')
    expect(markup).toContain('aria-label="What Claude Code reads">FULL TEXT</pre>')
  })

  it('lists saves and installs with Undo… and versions kept from before with Restore…, newest first', () => {
    expect(earlierVersions(RULES).map((entry) => `${entry.title} | ${entry.detail} | ${entry.usable}`)).toEqual([
      'Team line updated | Claude Code | true',
      'A saved version that cannot be read | 2.0 KB | false',
      'Installed | Claude Code, Codex | true',
      'Saved | 290 B | true',
      'A save that cannot be read |  | false'
    ])
    expect(count(markup, '>Undo…</button>')).toBe(3)
    expect(count(markup, '>Restore…</button>')).toBe(2)
    // A save keeps the master versions it wrote for itself: its own entry stands for them (Story 75.9).
    const saved = earlierVersions({
      transactions: [{ id: 't5', createdAt: '2026-10-10T10:00:00.000Z', state: 'partial', reason: 'save', targets: ['claude', 'codex'], valid: true, master: true }],
      history: [
        { revision: 3, at: '2026-10-10T10:00:00.000Z', hash: 'j', bytes: 300, reason: 'before save t5', intact: true },
        { revision: 4, at: '2026-10-10T10:00:00.000Z', hash: 'k', bytes: 310, reason: 'save t5', intact: true },
        { revision: 5, at: '2026-10-10T11:00:00.000Z', hash: 'j', bytes: 300, reason: 'undo t5', intact: true }
      ]
    })
    expect(saved.map((entry) => `${entry.title} | ${entry.detail} | ${entry.usable}`)).toEqual(['Put back by Undo | 300 B | true', 'Saved and installed | Claude Code, Codex · not every app written | true'])
  })

  it('names an install made before Cursor was retired, and its undo says the Cursor file is left as it is (Epic 71)', () => {
    const old = { ...RULES, transactions: [{ id: 't9', createdAt: '2026-10-01T10:00:00.000Z', state: 'complete', reason: 'install', targets: ['claude', 'cursor'] as RosterListedApp[], valid: true }] }
    expect(earlierVersions(old).find((entry) => entry.kind === 'install')?.detail).toBe('Claude Code, Cursor')
    const plan = {
      ok: true, code: 'OK', planHash: 'h', targets: [{ harness: 'claude' as const, path: '/home/synthetic/.claude/CLAUDE.md', kind: 'missing', change: 'missing', diff: '' }],
      left: [{ harness: 'cursor' as const, path: '/home/synthetic/.cursor/rules/bmn-global-rules.mdc' }]
    }
    const sheet = words(rulesMarkup('editor', rules({ pending: { kind: 'undo', transaction: 't9', plan } }))).replace(/\s+/g, ' ')
    expect(sheet).toContain('Undo this install')
    expect(sheet).toContain('Cursor was retired on 14 Oct 2026. ~/.cursor/rules/bmn-global-rules.mdc is left as it is.')
  })

  it('says, undoing a skills install, that BMN installs again what the list still gives an app (Story 75.9)', () => {
    const snapshot = { ...RULES, transactions: [{ id: 't7', createdAt: '2026-10-16T10:00:00.000Z', state: 'complete', reason: 'skills install', targets: ['codex'] as RosterListedApp[], valid: true }] }
    const plan = { ok: true, code: 'OK', planHash: 'h', targets: [{ harness: 'codex' as const, path: '/home/synthetic/.agents/skills/alpha', kind: 'link', change: 'link', diff: '' }] }
    const sheet = words(rulesMarkup('skills', rules({ snapshot, pending: { kind: 'undo', transaction: 't7', plan } }))).replace(/\s+/g, ' ')
    expect(sheet).toContain('Undo this install')
    expect(sheet).toContain('Each file goes back to what it was before that install. BMN installs again at its next start or approval what your list gives an app; keep the skill from it to keep it out.')
    const rulesInstall = { ...RULES, transactions: [{ ...snapshot.transactions[0]!, reason: 'install' }] }
    const plain = words(rulesMarkup('editor', rules({ snapshot: rulesInstall, pending: { kind: 'undo', transaction: 't7', plan } }))).replace(/\s+/g, ' ')
    expect(plain).toContain('Each file goes back to what it was before that install.')
    expect(plain).not.toContain('installs again')
  })

  it('Insert adds a section on its own lines, and the Team phrase where the cursor is', () => {
    const [apps, shared, phrase] = INSERTS as [typeof INSERTS[number], typeof INSERTS[number], typeof INSERTS[number]]
    expect(INSERTS.map((insert) => insert.label)).toEqual(['Section for some apps', 'Public section', 'Team'])
    const section = insertAt('One line', 8, 8, shared)
    expect(section.text).toBe('One line\n<!-- bmn:public -->\n\n<!-- /bmn:public -->\n')
    expect(section.text.slice(0, section.caret)).toBe('One line\n<!-- bmn:public -->\n')
    const named = insertAt('', 0, 0, apps)
    expect(named.text.slice(0, named.caret)).toBe('<!-- bmn:apps claude codex -->\n')
    const inline = insertAt('The team: .', 10, 10, phrase)
    expect(inline.text).toBe('The team: <!-- bmn:team -->.')
    expect(inline.caret).toBe(27)
    expect(insertAt('abcdef', 1, 5, phrase).text).toBe('a<!-- bmn:team -->f')
  })

  it('splits a line into text and markers', () => {
    expect(markerParts('plain')).toEqual([{ text: 'plain', marker: false }])
    expect(markerParts('')).toEqual([{ text: '', marker: false }])
    expect(markerParts('a <!-- bmn:team --> b')).toEqual([{ text: 'a ', marker: false }, { text: '<!-- bmn:team -->', marker: true }, { text: ' b', marker: false }])
    expect(markerParts('<!-- /bmn:apps -->')).toEqual([{ text: '<!-- /bmn:apps -->', marker: true }])
    expect(markerParts('<!-- a comment -->')).toEqual([{ text: '<!-- a comment -->', marker: false }])
  })

  it('sizes text and summarises a change in words', () => {
    expect([kilobytes(412), kilobytes(2048), lineCount(''), lineCount('a\nb\n'), lineCount('a\nb')]).toEqual(['412 B', '2.0 KB', 0, 2, 2])
    expect(diffSummary('--- a\n+++ b\n@@\n-old\n+new\n+more\n same')).toBe('+2 −1')
    expect(diffSummary('')).toBe('No change')
    expect(changeWords({ change: 'link', diff: '+a' })).toBe('Replaces a link · +1 −0')
    expect(changeWords({ change: 'edited-outside', diff: '-a\n+b' })).toBe('Replaces an edit made outside BMN · +1 −1')
    expect(changeWords({ change: 'unmanaged', diff: '+a' })).toBe('Replaces a file BMN did not write · +1 −0')
    expect(changeWords({ change: 'missing', diff: '+a' })).toBe('New file')
    expect(changeWords({ change: 'stale', diff: '+a\n-b' })).toBe('+1 −1')
    expect([undoWords({ change: 'link', diff: '' }), undoWords({ change: 'missing', diff: '' }), undoWords({ change: 'file', diff: '-a' })]).toEqual(['Becomes a link again', 'Removed again', 'Put back · +0 −1'])
  })
})

it('Team whose file needs fixing reads it again when the owner comes back, with no Check now (Story 75.7)', () => {
  const broken = words(pageMarkup({ name: 'agents' }, team({ data: null, base: null }))).replace(/\s+/g, ' ')
  expect(broken).toContain('The team file needs fixing')
  expect(broken).toContain('Nothing in it applies until it is fixed and approved; BMN reads it again when you come back.')
  expect(broken).not.toContain('Check now')
})

describe('Integrations › Health (60.6 AC4)', () => {
  const markup = rulesMarkup('health')

  it('shows one row per rules file: path, state in words, the kind of rules and the last loading test', () => {
    expect(markup).toContain(`<span class="faint">Checked ${shortDate('2026-10-09T22:13:00.000Z')} · 9 need you · 1 skill entry not installed yet · 1 skill exposed · 2 tool entries not installed yet · 1 tool exposed</span>`)
    // With the skills and the tools counted in order, the header keeps when Health was read and the rows that need him.
    expect(rulesMarkup('health', rules({ snapshot: { ...RULES, skills: { ...RULES.skills, pending: 0, exposed: 0 }, tools: { ...RULES.tools, pending: 0, exposed: 0 } } }))).toContain(`<span class="faint">Checked ${shortDate('2026-10-09T22:13:00.000Z')} · 9 need you</span>`)
    // Story 75.7: Health, Skills and Tools read themselves again by Health's rule; no button asks for it.
    for (const page of [markup, rulesMarkup('skills'), rulesMarkup('tools')]) expect(page).not.toContain('Check now')
    expect(markup).toMatch(/data-state="current"><span>Claude Code<\/span><span class="path mono" title="\/home\/synthetic\/.claude\/CLAUDE.md">~\/.claude\/CLAUDE.md<\/span><span class="health-state"><span>Current<span class="muted"> · Full rules<\/span>/)
    // A loading test sends one prompt, and says so (Story 75.8 AC2).
    expect(markup).toContain(`<span class="faint">Test passed ${shortDate('2026-10-09T20:00:00.000Z')} · stale · one prompt sent</span>`)
    expect(markup).toMatch(/data-state="stale">.*?aria-label="Needs you".*?Differs from the rules · Save the rules to rewrite it<\/span><span class="faint">Not tested yet<\/span>/)
    expect(markup).toMatch(/data-state="missing">.*?Missing · Save the rules to write it<\/span><span class="faint">No loading test<\/span>/)
    // A file that differs is a failure, listed first (Story 75.9).
    expect([...markup.matchAll(/data-state="([a-z-]+)"/g)].map((match) => match[1])).toEqual(['stale', 'missing', 'current'])
    expect(targetStateWords('edited-outside')).toBe('Differs · edited outside BMN · Save the rules to rewrite it')
    expect(testLine(undefined)).toBe('Not tested yet')
    expect(testLine({ harness: 'codex', outcome: 'pass', at: '2026-10-09T20:00:00.000Z', version: '0.171.0', by: 'bmn' })).toBe(`Test passed ${shortDate('2026-10-09T20:00:00.000Z')} on 0.171.0 · by BMN · one prompt sent`)
    expect(testLine({ harness: 'codex', outcome: 'unavailable', at: '2026-10-09T20:00:00.000Z' })).toBe(`Test unavailable ${shortDate('2026-10-09T20:00:00.000Z')}`)
  })

  it('counts in its status every row that carries the Needs-you dot, each decided the way its row decides it (Story 75.10)', () => {
    // Two rules files, two apps' skills, three apps' tools, one context limit and one hook file.
    expect(markup.split('<div class="health-row"').slice(1).filter((row) => row.includes('needs-dot'))).toHaveLength(9)
    expect(healthNeedsCount(RULES)).toBe(9)
    expect(healthNeedsCount({ ...RULES, health: { state: 'failed', checkedAt: 'x', reason: 'unreadable' }, hooks: null })).toBe(6)
    expect(words(rulesMarkup('health', rules({ snapshot: { ...RULES, health: { state: 'failed', checkedAt: '2026-10-09T22:13:00.000Z', reason: 'unreadable' }, hooks: null } })))).toMatch(/Checked [^·]+ · 6 need you ·/)
    // Within each section those rows come first, the rest in their order.
    expect([...markup.matchAll(/data-skills="([A-Za-z ]+)"/g)].map((match) => match[1])).toEqual(['Missing', 'Exposed', 'Reads the source'])
    expect(needsFirst([1, 2, 3, 4], (row) => row % 2 === 0)).toEqual([2, 4, 1, 3])
  })

  it('says what BMN found and did in each app\'s hook file at start, failure first, with no button (Story 75.9)', () => {
    expect(markup).toContain('<h4 class="group-head" id="health-hooks">Hooks<span class="caption">BMN&#x27;s entries in each app&#x27;s hook file, installed at start</span></h4>')
    expect([...markup.matchAll(/data-hooks="([a-z-]+)"><span>([A-Za-z ]+)<\/span>/g)].map((match) => `${match[2]} ${match[1]}`)).toEqual(['Codex left', 'Claude Code in-place', 'OpenCode in-place'])
    expect(markup).toMatch(/data-hooks="left">.*?<span><span class="needs-dot"[^>]*><\/span>5 entries in place · 2 left as they are<\/span><span class="faint">PostToolUse · changed<\/span><span class="faint">Interrupt · not BMN&#x27;s<\/span><span class="faint">Added at start: SessionStart, SessionEnd · Codex asks you once, in \/hooks, before it runs them<\/span>/)
    expect(markup).toMatch(/data-hooks="in-place"><span>Claude Code<\/span>.*?<span class="faint">9 entries in place<\/span>/)
    expect(markup).toContain('Not set up on this computer')
    expect(words(markup)).toMatch(/Checked at start, \d\d:\d\d\. BMN adds an entry only where an event has none of its own/)
    expect(markup).not.toContain('Check configured hooks')
    expect(hookRowWords({ harness: 'claude', file: 'f', state: 'left', placed: [], older: [], installed: [], left: [], why: 'unparsable' })).toEqual({ needs: true, head: 'The file · the file is not valid JSON · left as it is', lines: [] })
    expect(hookRowWords({ harness: 'opencode', file: 'f', state: 'checked', placed: ['plugin', 'cli.json'], older: ['plugin'], installed: [], left: [] }))
      .toEqual({ needs: false, head: '2 entries in place', lines: ['plugin · in an older wording, which still runs'] })
    expect(hookRows({ state: 'checked', checkedAt: 'x', apps: [] })).toEqual([])
    expect(words(rulesMarkup('health', rules({ snapshot: { ...RULES, hooks: null } })))).toContain('Not checked yet: BMN checks them each time it starts.')
    expect(rulesMarkup('health', rules({ snapshot: { ...RULES, hooks: { state: 'failed', checkedAt: 'x', reason: 'The hook install timed out' } } }))).toContain('<p class="preferences-error" role="alert">The hook install timed out</p>')
  })

  it('offers no Test…: Test again… only after a failure or once BMN stopped trying, and only where the app may receive private work (Story 75.8)', () => {
    expect(markup).not.toContain('Test…')
    expect(markup).not.toMatch(/aria-label="Test [A-Za-z ]+ again"/)
    expect(markup).toContain('<p class="preferences-help">A loading test starts the app once with the rules in one prompt; BMN runs it by itself after updates and rules changes.</p><p class="preferences-help">It is off for OpenCode, which gets only the public sections.</p>')
    const allPublic = RULES.health.state === 'checked' ? { ...RULES.health, targets: RULES.health.targets.map((target) => ({ ...target, kind: 'public' as const })) } : RULES.health
    expect(words(rulesMarkup('health', rules({ snapshot: { ...RULES, health: allPublic } })))).toContain('It is off for Claude Code, Codex and OpenCode, which get only the public sections.')
    const after = rulesMarkup('health', rules({ snapshot: { ...RULES,
      probes: [{ harness: 'claude', outcome: 'fail', at: '2026-10-09T20:00:00.000Z', version: '2.1.295' }, { harness: 'codex', outcome: 'inconclusive', at: '2026-10-09T20:00:00.000Z', version: '0.171.0', by: 'bmn' }],
      autoTests: { running: null, stopped: [{ kind: 'rules', harness: 'codex', version: '0.171.0', tries: 3, at: '2026-10-09T20:00:00.000Z' }, { kind: 'rules', harness: 'opencode', version: '1.18.32', tries: 3, at: '2026-10-09T20:00:00.000Z' }] } } }))
    // A failed test puts a dot on a current file too, so all three need him and keep their order (Story 75.10).
    expect([...after.matchAll(/aria-label="Test ([A-Za-z ]+) again">Test again…/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex'])
    expect(after).toContain('<span class="faint">BMN stopped after 3 tries on 0.171.0</span>')
    const running = rulesMarkup('health', rules({ snapshot: { ...RULES, autoTests: { running: { kind: 'rules', harness: 'claude' }, stopped: [] } } }))
    expect(running).toContain('BMN is testing Claude Code now…')
  })

  it('shows each agent app: version, whether it is tested, where it sends data and what is recorded', () => {
    expect(markup).toContain('<span class="mono">2.1.295</span> <span class="muted" title="BMN tested how this version picks where to send data.">· tested</span>')
    expect(markup).toContain('<span class="mono">0.171.0</span> <span class="muted" title="Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.">· newer than tested</span>')
    // An app that is not there is said once, not as "not found · not checked".
    expect(markup).toContain('<span class="health-state"><span class="mono" title="OpenCode is not installed, or its version cannot be read.">not found</span></span>')
    const unread = rulesMarkup('health', rules({ snapshot: { ...RULES, apps: RULES.apps.map((app) => (app.harness === 'codex' ? { ...app, version: null, versionState: 'unknown' as const, versionNote: 'Codex is not installed, or its version cannot be read.' } : app)) } }))
    expect(unread).toContain('<span class="mono" title="Codex is not installed, or its version cannot be read.">version not read</span><span class="path mono wrap" title="/home/synthetic/.npm-global/bin/codex">')
    expect(markup).toContain('<span>Sends data to Anthropic&#x27;s own servers</span><span class="faint">Recorded: Anthropic, as inspected</span>')
    expect(markup).toContain('<span>Where it sends data is unknown</span><span class="faint">Recorded: Z.ai, on your word</span>')
    expect(destinationWords({ basis: 'explicit', provider: null, host: 'proxy.example.com' }, (id) => id)).toBe('Sends data to a custom host, proxy.example.com')
  })

  it('offers no Accept step: every installed version is supported; a list kept from the earlier rule can only be removed', () => {
    expect(markup).not.toContain('Accept version')
    expect([...markup.matchAll(/aria-label="Set the destination of ([^"]+)"/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex', 'OpenCode'])
    expect(markup).toContain('Accepted earlier, no longer needed')
    expect(markup).toContain('aria-label="Remove accepted version 0.170.0 of Codex"')
    expect(markup).toContain('Every installed version is supported')
  })
})

describe('Integrations › Health: Update… (60.6: the app\'s own updater, shown before anything runs)', () => {
  const markup = rulesMarkup('health')
  const apps = RULES.apps
  const sheet = (index: number, extra: Partial<Parameters<typeof UpdateSheet>[0]> = {}): string =>
    renderToStaticMarkup(createElement(UpdateSheet, { app: apps[index]!, home: RULES.home, sessions: 0, hasTest: false, busy: false, result: null, onCopied: noop, onClose: noop, ...extra }))

  it('shows under each version the program BMN finds, and says when it finds none', () => {
    expect(markup).toContain('Agent apps<span class="caption">the program BMN finds, its version and where it sends data</span>')
    // The path wraps instead of being cut: its last part is the program's name.
    expect(markup).toContain('· tested</span></span><span class="path mono wrap" title="/home/synthetic/.local/bin/claude">~/.local/bin/claude</span></span>')
    expect(markup).toContain('· newer than tested</span></span><span class="path mono wrap" title="/home/synthetic/.npm-global/bin/codex">~/.npm-global/bin/codex</span></span>')
    expect(markup).not.toContain('Program not found')
  })

  it('offers Update… on every app, off where there is no program to update, and opens no sheet by itself', () => {
    expect([...markup.matchAll(/<button type="button" class="small"( disabled="")? (?:title="[^"]*" )?aria-label="Update ([^"]+)" aria-expanded="false"(?: title="([^"]*)")?>Update…<\/button>/g)].map((match) => [match[2], match[1] !== undefined, match[3]]))
      .toEqual([['Claude Code', false, undefined], ['Codex', false, undefined], ['OpenCode', true, 'BMN finds no OpenCode program to update']])
    expect(markup).not.toContain('own updater does this')
  })

  it('the command is the program by its full path and the app\'s own update word, quoted for a shell', () => {
    expect(updateCommand({ harness: 'claude', program: '/home/synthetic/.local/bin/claude' })).toBe('/home/synthetic/.local/bin/claude update')
    expect(updateCommand({ harness: 'codex', program: '/home/synthetic/.npm-global/bin/codex' })).toBe('/home/synthetic/.npm-global/bin/codex update')
    expect(updateCommand({ harness: 'opencode', program: '/usr/local/bin/opencode' })).toBe('/usr/local/bin/opencode upgrade')
    expect(updateCommand({ harness: 'codex', program: "/home/synthetic/My Apps/it's/codex" })).toBe("'/home/synthetic/My Apps/it'\\''s/codex' update")
    expect(updateCommand({ harness: 'opencode', program: null })).toBeNull()
  })

  it('the sheet names the program, where a link leads, the exact command and what happens afterwards, and runs nothing', () => {
    const claude = sheet(0, { sessions: 2, hasTest: true })
    expect(claude).toContain('<div class="sheet" role="group" aria-label="Update Claude Code" tabindex="-1">')
    expect(claude).toContain('<b>Update Claude Code</b><span class="muted">Claude Code&#x27;s own updater does this, not BMN.</span>')
    const read = words(claude).replace(/\s+/g, ' ')
    expect(read).toContain('Installed 2.1.295 Program ~/.local/bin/claude A link to ~/.local/share/claude/versions/2.1.295 Command /home/synthetic/.local/bin/claude update')
    expect(read).toContain('Open in BMN BMN recognises 2 Claude Code sessions. Restart them to use the update; their running versions are not checked.')
    expect(read).toContain('Afterwards Run the command in a terminal. Back on Health, BMN reads the version and where Claude Code sends data again. A loading test made before the update needs to be run again.')
    expect(read).toContain('The updater decides what it downloads and replaces, and may ask; BMN cannot see it first or undo it. BMN does not know whether a newer version exists.')
    expect([...claude.matchAll(/<button type="button"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Copy command', 'Close'])
    // Nothing on the sheet starts the updater: the only action on the command is a copy.
    expect(read).not.toMatch(/\bRun update\b|\bUpdate now\b|\bStart\b/)
    expect(claude).not.toContain('role="status"')
  })

  it('where a session can be opened, offers to run the command there on one press', () => {
    const typed: string[][] = []
    const offered = sheet(1, { onRun: async (name, command) => { typed.push([name, command]); return 'typed' } })
    expect([...offered.matchAll(/<button type="button"( class="primary")?[^>]*>([^<]+)<\/button>/g)].map((match) => [match[2], match[1] !== undefined]))
      .toEqual([['Update now', true], ['Copy command', false], ['Close', false]])
    expect(words(offered).replace(/\s+/g, ' ')).toContain('Afterwards Update now opens a session, types the command at its prompt and presses Enter; you see and answer what the updater asks. BMN rereads Codex&#x27;s version and where it sends data whenever that session&#x27;s shell is at its prompt, and on Health. Or run the command in any terminal yourself.')
    expect(offered).toContain('<span class="review"><span>Update now opens')
    // What BMN takes for the prompt, and the one case where that is not the prompt, are said before the press.
    const limit = 'BMN knows the prompt by the sign the shell&#x27;s line editor gives. A question a start-up file asks with line editing gives the same sign and would get the command as its answer.'
    expect(words(offered).replace(/\s+/g, ' ')).toContain(`BMN does not know whether a newer version exists. ${limit}`)
    expect(sheet(1)).not.toContain('line editing')
    // Rendering offers; nothing runs until the press.
    expect(typed).toEqual([])
    expect(offered).not.toContain('role="status"')
    // With no program there is nothing to run.
    expect(sheet(2, { onRun: async () => 'typed' })).toContain('<button type="button" class="primary" disabled="">Update now</button>')
    // Without a way to open a session the sheet is as before: the copy is the main action.
    expect(sheet(1)).not.toContain('Update now')
    expect(sheet(1)).toContain('<button type="button" class="primary">Copy command</button>')
  })

  it('says where a press on Update now stands, takes a second press only where no session opened, and makes the copy the main action where the shell never got ready', () => {
    const at = (press: CommandPress): string => sheet(1, { onRun: async () => 'typed', press })
    // Each of the first two buttons: its words, whether it is the main action, whether it is off.
    const buttons = (markup: string): unknown[][] => [...markup.matchAll(/<button type="button"( class="primary")?( disabled="")?>([^<]+)<\/button>/g)].slice(0, 2).map((match) => [match[3], match[1] !== undefined, match[2] !== undefined])
    expect(buttons(at('idle'))).toEqual([['Update now', true, false], ['Copy command', false, false]])
    expect(buttons(at('opening'))).toEqual([['Update now', true, true], ['Copy command', false, false]])
    expect(at('opening')).toContain('<p role="status">Opening Update Codex and waiting for its shell…</p>')
    expect(buttons(at('typed'))).toEqual([['Update now', true, true], ['Copy command', false, false]])
    expect(buttons(at('failed'))).toEqual([['Update now', true, false], ['Copy command', false, false]])
    expect(at('failed')).toContain('<p role="status">BMN could not open a session, so nothing ran. Press Update now again, or copy the command.</p>')
    expect(buttons(at('not-reading'))).toEqual([['Update now', false, true], ['Copy command', true, false]])
    expect(at('not-reading')).toContain('<p role="status">The shell in Update Codex did not get ready for a command, so BMN typed nothing. Copy the command and run it yourself.</p>')
  })

  it('watches an update BMN starts afresh, and knows a reading made before an update command ended', () => {
    forgetUpdateWatches()
    watchUpdate({ harness: 'codex', version: '0.161.0' }, '2026-10-09T22:00:00.000Z')
    expect(watchedWords({ harness: 'codex', version: '0.161.0' }, '2026-10-09T22:01:00.000Z')).toBe('The program still reports 0.161.0.')
    // Update now pressed after that line was shown: the watch starts again from this reading, so the line after the update is still owed.
    watchUpdate({ harness: 'codex', version: '0.161.0' }, '2026-10-09T22:01:00.000Z', true)
    expect(watchedWords({ harness: 'codex', version: '0.161.0' }, '2026-10-09T22:01:00.000Z')).toBeNull()
    expect(watchedWords({ harness: 'codex', version: '0.172.0' }, '2026-10-09T22:03:00.000Z')).toBe('The program now reports 0.172.0; before it reported 0.161.0.')
    forgetUpdateWatches()
    // Judged by when the read began (63.4 AC2): one begun before the end, or at it, may hold what was there before the update.
    const began = Date.parse('2026-10-09T22:01:00.000Z')
    expect([endedSince(began, null), endedSince(began, began - 1), endedSince(began, began), endedSince(began, began + 1)]).toEqual([false, false, true, true])
    // A reading whose beginning cannot be told is taken as the older one.
    expect(endedSince(null, 5)).toBe(true)
  })

  it('lets every listener hear that an update ended, also when one of them throws (63.4 AC4)', () => {
    const heard: string[] = []
    const stops = [onUpdateEnded(() => heard.push('first')), onUpdateEnded(() => { throw new Error('synthetic') }), onUpdateEnded(() => heard.push('third'))]
    expect(() => updateEnded(5)).not.toThrow()
    expect(heard).toEqual(['first', 'third'])
    for (const stop of stops) stop()
    updateEnded(6)
    expect(heard).toEqual(['first', 'third'])
  })

  it('says for Codex which program is meant, since BMN\'s sessions start its own command of that name', () => {
    const codex = words(sheet(1)).replace(/\s+/g, ' ')
    expect(codex).toContain("In BMN's sessions, codex is BMN's own command; it hands over to this program, and this is the one updated.".replace(/'/g, '&#x27;'))
    expect(codex).not.toContain('A link to')
    expect(codex).not.toContain('A loading test made before the update')
    expect(words(sheet(0))).not.toContain('own command')
  })

  it('with no program found the command cannot be copied; a check that is running is said by Health, not the sheet', () => {
    const missing = sheet(2, { busy: true })
    expect(words(missing).replace(/\s+/g, ' ')).toContain('Installed version not read Program not found Command no program found')
    expect(missing).toContain('<button type="button" class="primary" disabled="">Copy command</button>')
    expect(missing).not.toContain('Checking…')
    expect(rulesMarkup('health', rules({ busy: true }))).toContain('<span class="faint">Checking…</span>')
  })

  it('counts only the sessions BMN recognises and never claims their versions', () => {
    expect(sessionsWords('Codex', 0)).toBe('BMN recognises no Codex session right now. A session it cannot recognise keeps running what it started with.')
    expect(sessionsWords('Codex', 1)).toBe('BMN recognises 1 Codex session. Restart it to use the update; its running version is not checked.')
    expect(sessionsWords('Codex', 3)).toBe('BMN recognises 3 Codex sessions. Restart them to use the update; their running versions are not checked.')
  })

  it('after a check it says only what the program reports now and before, never that an update succeeded', () => {
    expect(recheckWords('0.171.0', '0.172.0')).toBe('The program now reports 0.172.0; before it reported 0.171.0.')
    expect(recheckWords('0.171.0', '0.171.0')).toBe('The program still reports 0.171.0.')
    expect(recheckWords(null, '0.172.0')).toBe('The program now reports 0.172.0.')
    expect(recheckWords('0.171.0', null)).toBe('BMN could not read the installed version.')
    expect(sheet(1, { result: recheckWords('0.171.0', '0.172.0') })).toContain('<p role="status">The program now reports 0.172.0; before it reported 0.171.0.</p>')
    for (const text of [recheckWords('1', '2'), recheckWords('1', '1'), recheckWords(null, '2'), recheckWords('1', null)]) expect(text).not.toMatch(/updated|succeeded|up to date|latest/i)
  })
})

describe('Integrations › Health: when the shell\'s settings could not be read', () => {
  it('says so above the apps, with the reason, and says nothing when they were read', () => {
    const page = rulesMarkup('health', rules({ snapshot: { ...RULES, ownEnvironment: 'bash did not answer in 5 seconds' } }))
    expect(words(page).replace(/\s+/g, ' ')).toContain('BMN could not read your shell&#x27;s settings (bash did not answer in 5 seconds), so it looked for the apps with its own; a session may find more.')
    expect(page).toMatch(/<p class="page-note" role="status"><span[^>]*aria-label="Needs you"/)
    expect(rulesMarkup('health')).not.toContain('could not read your shell')
  })
})

describe('Integrations › Health: what an app reports after its update command was copied', () => {
  it('remembers what the program reported then, and says what a later check read, under the app\'s row', () => {
    forgetUpdateWatches()
    const codex = RULES.apps[1]!
    expect(watchedWords(codex, RULES.health.checkedAt)).toBeNull()
    watchUpdate({ harness: 'codex', version: '0.161.0' }, '2026-10-09T22:00:00.000Z')
    // Copying again, or asking for a check, does not move the starting point.
    watchUpdate({ harness: 'codex', version: '0.171.0' }, '2026-10-09T22:05:00.000Z')
    // Nothing was read since the copy: there is nothing to say yet.
    expect(watchedWords(codex, '2026-10-09T22:00:00.000Z')).toBeNull()
    expect(watchedWords(codex, RULES.health.checkedAt)).toBe('The program now reports 0.171.0; before it reported 0.161.0.')
    expect(watchedWords(RULES.apps[0]!, RULES.health.checkedAt)).toBeNull()
    const page = rulesMarkup('health')
    expect(page).toContain('<p class="app-note" role="status">The program now reports 0.171.0; before it reported 0.161.0.</p>')
    expect(count(page, 'class="app-note"')).toBe(1)
    forgetUpdateWatches(['codex'])
    expect(rulesMarkup('health')).not.toContain('app-note')
    watchUpdate({ harness: 'claude', version: '2.1.295' }, '2026-10-09T22:00:00.000Z')
    forgetUpdateWatches()
    expect(watchedWords(RULES.apps[0]!, RULES.health.checkedAt)).toBeNull()
  })
})

describe('universal words (R60-NFR8)', () => {
  it('no Team or Rules page shows a word of the schema or of the earlier design', () => {
    const pages = [
      pageMarkup({ name: 'agents' }), pageMarkup({ name: 'agent', id: 'sol' }), pageMarkup({ name: 'new' }), pageMarkup({ name: 'roles' }), pageMarkup({ name: 'changes' }),
      rulesMarkup('editor'), rulesMarkup('skills'), rulesMarkup('tools'), rulesMarkup('health'),
      ...RULES.apps.map((app) => renderToStaticMarkup(createElement(UpdateSheet, { app, home: RULES.home, sessions: 2, hasTest: true, busy: false, result: 'The program still reports 1.0.0.', onCopied: noop, onClose: noop })))
    ]
    for (const page of pages) {
      // The file names the owner's own apps use are theirs, not BMN's words.
      const read = words(page).replace(/~\/[^\s<]+/g, ' ')
      expect(read.match(SCHEMA_WORDS)?.[0]).toBeUndefined()
    }
  })

  it('every control on the pages has an accessible name', () => {
    for (const page of [pageMarkup({ name: 'agents' }), pageMarkup({ name: 'agent', id: 'sol' }), pageMarkup({ name: 'new' }), pageMarkup({ name: 'roles' }), pageMarkup({ name: 'changes' }), rulesMarkup('editor'), rulesMarkup('skills'), rulesMarkup('tools'), rulesMarkup('health')]) {
      const unnamed = [...page.matchAll(/<(button|input|textarea)\b([^>]*)>([^<]*)/g)]
        .filter((match) => !/aria-label(ledby)?=/.test(match[2] ?? '') && (match[3] ?? '').trim() === '' && !/type="(radio|checkbox)"/.test(match[2] ?? ''))
        .map((match) => match[0])
      expect(unnamed).toEqual([])
    }
  })
})

describe('allowed workspaces (60.8 AC5)', () => {
  const ALLOWED: RosterDataShape = { ...DATA, exceptions: [
    { id: 'zai-1a2b3c4d', provider: 'zai', folder: '/home/synthetic/code/app' },
    { id: 'zai-5e6f7a8b', provider: 'zai', folder: '/home/synthetic/code/site' }
  ] }
  const allowed = (extra: Partial<TeamState> = {}): TeamState => team({ data: ALLOWED, base: ALLOWED, approved: ALLOWED, ...extra })

  it('lists each one on Changes with its provider and folder, above the versions, and a Remove that names both', () => {
    const markup = pageMarkup({ name: 'changes' }, allowed())

    expect(markup).toContain('<h4 class="group-head">Allowed workspaces<span class="caption">where a provider that may see public work only was allowed</span></h4>')
    expect(markup).toContain('<b>Z.ai</b> <span class="path mono wrap">/home/synthetic/code/app</span>')
    expect(markup).toContain('aria-label="Stop allowing Z.ai in /home/synthetic/code/site"')
    expect(count(markup, '>Remove</button>')).toBe(2)
    expect(markup.indexOf('Allowed workspaces')).toBeLessThan(markup.indexOf('<h4 class="group-head">Versions</h4>'))
    expect(words(markup)).not.toMatch(SCHEMA_WORDS)
    expect(words(markup)).not.toMatch(/\bexceptions?\b/i)
  })

  it('shows no such group on Changes while none is allowed', () => {
    const markup = pageMarkup({ name: 'changes' })

    expect(markup).not.toContain('Allowed workspaces')
    expect(markup).not.toContain('<h4 class="group-head">Versions</h4>')
  })

  it('lists them in the Advanced section of each agent on that provider, says None for a public-only provider without any, and leaves other agents alone', () => {
    const glm = pageMarkup({ name: 'agent', id: 'glm' }, allowed())

    expect(glm).toContain('Allowed workspaces')
    expect(glm).toContain('Where Z.ai may see private work although it otherwise may not. One is added from the card a stopped prompt shows.')
    expect(glm).toContain('<span class="path mono wrap">/home/synthetic/code/app</span>')
    expect(glm).not.toContain('<b>Z.ai</b> <span class="path mono wrap">')
    expect(count(glm, '>Remove</button>')).toBe(2)
    expect(pageMarkup({ name: 'agent', id: 'glm' })).toContain('<span class="line-detail">None</span>')
    expect(pageMarkup({ name: 'agent', id: 'sol' }, allowed())).not.toContain('Allowed workspaces')
  })

  it('removing one stages the team without it, and the Review says what that means', () => {
    const staged = removeException(ALLOWED, 'zai-1a2b3c4d')

    expect(staged.exceptions).toEqual([{ id: 'zai-5e6f7a8b', provider: 'zai', folder: '/home/synthetic/code/site' }])
    expect(removeException(ALLOWED, 'nobody')).toEqual(ALLOWED)
    const differences: RosterDiffShape[] = [{ scope: 'exceptions', id: 'zai-1a2b3c4d', field: null, kind: 'removed', before: { present: true, value: { provider: 'zai', folder: '/home/synthetic/code/app' } } }]
    const { groups } = groupDifferences(differences, staged, ALLOWED, ['GLM could no longer receive private work in /home/synthetic/code/app'])
    expect(groups.map((group) => [group.subject, group.consequences])).toEqual([['Allowed workspaces', ['GLM could no longer receive private work in /home/synthetic/code/app']]])
  })
})

describe('context limits (60.9 AC3, AC4)', () => {
  const markup = rulesMarkup('health')

  it('shows one row per app: its file, who shares it, the default it holds and whether the setting is tested', () => {
    expect(markup).toContain('<h4 class="group-head">Context limits<span class="caption">how large a conversation may grow in sessions you start yourself</span></h4>')
    expect(markup).toMatch(/<span>Codex<\/span><span class="health-state"><span class="path mono" title="\/home\/synthetic\/.codex\/config.toml">~\/.codex\/config.toml<\/span><span class="faint">Shared by Sol, Astra and Luna<\/span><\/span><span class="health-state"><span>380 000 tokens · summarises at 342 000<\/span><span class="faint" title="[^"]*">Not tested on 0.171.0 · BMN tests it by itself<\/span>/)
    expect(markup).toMatch(/<span class="faint">Shared by Opus and Fable<\/span><\/span><span class="health-state"><span>App default<\/span><span class="faint" title="[^"]*">Tested on 2.1.295 · asked for 137 000, it reported 137 000 · proves the limit for runs BMN starts, as --settings; where it summarises is not tested<\/span>/)
  })

  it('offers Change… only where the test passed on the installed version', () => {
    expect(markup).toContain('disabled="" aria-label="Change the default context limit of Codex" title="Not supported yet: it waits for a test that passes on this Codex version"')
    expect(markup).toMatch(/<button type="button" class="small" aria-label="Change the default context limit of Claude Code">Change…<\/button>/)
    expect(markup).not.toMatch(/aria-label="Test the context limit of [A-Za-z ]+ again"/)
  })

  it('says in words what a row holds and why a setting is not supported yet', () => {
    expect(contextValueWords({ limit: null, compact: null })).toBe('App default')
    expect(contextValueWords({ limit: 272000, compact: null })).toBe('272 000 tokens')
    expect(contextValueWords({ limit: 272000, compact: null, unreadable: 'config.toml model_context_window is not a whole number' })).toBe("Can't be read")
    const test = (version: string, outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable', observed: number | null = null) => ({ at: 'x', version, outcome, detail: 'd', asked: 123000, observed })
    expect(contextStateWords({ harness: 'codex', version: null, test: null, autoTest: 'scheduled' })).toBe('Not supported yet · the app is not found')
    // Codex's test sends one short request to its provider, and says so; Claude Code's asks for its own report. A failure waits for the owner.
    expect(contextStateWords({ harness: 'codex', version: '0.162.0', test: test('0.162.0', 'fail', 380000), autoTest: 'none' })).toBe('Tested on 0.162.0 · the test failed: d · not used; Test again… is yours · one prompt sent')
    expect(contextStateWords({ harness: 'claude', version: '0.162.0', test: test('0.162.0', 'inconclusive'), autoTest: 'scheduled' })).toBe('Tested on 0.162.0 · the test showed nothing · BMN tries again by itself')
    expect(contextStateWords({ harness: 'codex', version: '0.162.0', test: test('0.161.0', 'pass', 116850), autoTest: 'scheduled' })).toBe('Not tested on 0.162.0 · BMN tests it by itself')
  })

  it('keeps the saved value, what the test observed, what it proves and who acts next apart, and promises no test that is not coming (Story 96.5 AC2, AC3)', () => {
    const pass = { at: 'x', version: '0.164.0', outcome: 'pass' as const, detail: 'asked for 123000; the session record shows 116850', asked: 123000, observed: 116850 }
    // What a pass proves is named, and what it does not: summarising is never tested.
    expect(contextStateWords({ harness: 'codex', version: '0.164.0', test: pass, autoTest: 'none' }))
      .toBe('Tested on 0.164.0 · asked for 123 000, it reported 116 850 · proves model_context_window; where it summarises is not tested · one prompt sent')
    // A default in the app's file alone is a reason to test; with neither a default nor an agent's limit nothing is promised.
    expect(contextStateWords({ harness: 'codex', version: '0.164.0', test: null, autoTest: 'scheduled' })).toBe('Not tested on 0.164.0 · BMN tests it by itself')
    expect(contextStateWords({ harness: 'codex', version: '0.164.0', test: null, autoTest: 'not-needed' })).toBe('Not tested on 0.164.0 · no automatic test: no agent has a limit here and the file holds no default')
    expect(contextStateWords({ harness: 'claude', version: '2.1.310', test: { ...pass, version: '2.1.310', outcome: 'inconclusive', observed: null }, autoTest: 'none' }))
      .toBe('Tested on 2.1.310 · the test showed nothing · no automatic test is scheduled')
    // The synthetic size a test asks for is said only as what was asked, never as a value to choose.
    expect(markup).not.toMatch(/<option[^>]*>137/)
  })

  it('has no switch: BMN tests by itself, and the help says what a test starts and costs (63.1 AC4; Story 75.8 AC3)', () => {
    expect(markup).not.toContain('context-auto-test')
    expect(markup).not.toContain('Test context limits after an app update')
    expect(markup).toContain('Claude Code is asked for its context report; Codex sends one short request to its provider. Nothing of yours is in it.')
    expect(markup).toContain('an agent&#x27;s own limit waits for the next automatic test')
  })

  it('says which agents\' own limits are applied, not applied or refused, with the check\'s reason behind each (63.1 AC4)', () => {
    expect(markup).toContain('<p class="limit-note" title="the context setting is not tested on this Codex version yet; BMN tests it by itself when it starts" role="status"><span class="needs-dot" role="img" aria-label="Needs you" title="Needs you"></span>Sol: its own limit of 272 000 is not applied, so a run gets the app&#x27;s own size.</p>')
    expect(agentLimitWords({ agent: 'Haiku', limit: 100000, state: 'applied' })).toBe('Haiku: its own limit of 100 000 is applied to each run.')
    expect(agentLimitWords({ agent: 'Haiku', limit: 100000, state: 'refused', reason: 'r' })).toBe('Haiku: runs are refused, because its own limit of 100 000 cannot be applied.')
    const applied = rulesMarkup('health', rules({ snapshot: { ...RULES, context: RULES.context.map((row) => ({ ...row, limits: [{ agent: 'Haiku', limit: 100000, state: 'applied' as const }] })) } }))
    expect(applied).toContain('<p class="limit-note">Haiku: its own limit of 100 000 is applied to each run.</p>')
  })

  it('says of a test BMN ran by itself that it did, with its day, the version and what came of it, and while one runs (63.1 AC5)', () => {
    const at = '2026-10-09T20:00:00.000Z'
    const own = (outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'): string => contextStateWords({ harness: 'claude', version: '2.1.296',
      test: { at, version: '2.1.296', outcome, detail: 'd', asked: 137000, observed: outcome === 'pass' ? 137000 : null, by: 'bmn' }, autoTest: outcome === 'inconclusive' ? 'scheduled' : 'none' })
    const proves = 'proves the limit for runs BMN starts, as --settings; where it summarises is not tested'
    expect(own('pass')).toBe(`BMN tested 2.1.296 by itself ${shortDate(at)} · asked for 137 000, it reported 137 000 · ${proves}`)
    expect(own('fail')).toBe(`BMN tested 2.1.296 by itself ${shortDate(at)} · the test failed: d · not used; Test again… is yours`)
    expect(own('inconclusive')).toBe(`BMN tested 2.1.296 by itself ${shortDate(at)} · the test showed nothing · BMN tries again by itself`)
    // A test of another version is not this version's, whoever ran it; the owner's own test says no one.
    expect(contextStateWords({ harness: 'claude', version: '2.1.297', test: { at, version: '2.1.296', outcome: 'pass', detail: 'd', asked: 137000, observed: 137000, by: 'bmn' }, autoTest: 'scheduled' }))
      .toBe('Not tested on 2.1.297 · BMN tests it by itself')
    expect(contextStateWords({ harness: 'claude', version: '2.1.296', test: { at, version: '2.1.296', outcome: 'pass', detail: 'd', asked: 137000, observed: 137000 }, autoTest: 'none' }))
      .toBe(`Tested on 2.1.296 · asked for 137 000, it reported 137 000 · ${proves}`)
    expect(contextStateWords({ harness: 'codex', version: '0.171.0', test: { at, version: '0.171.0', outcome: 'pass', detail: 'd', asked: 123000, observed: 116850, by: 'bmn' }, autoTest: 'none' }))
      .toBe(`BMN tested 0.171.0 by itself ${shortDate(at)} · asked for 123 000, it reported 116 850 · proves model_context_window; where it summarises is not tested · one prompt sent`)
    const running = rulesMarkup('health', rules({ snapshot: { ...RULES, autoTests: { running: { kind: 'context', harness: 'claude' }, stopped: [] } } }))
    expect(running).toMatch(/<span class="faint" title="[^"]*">BMN is testing Claude Code now…<\/span>/)
    expect(running).not.toContain('BMN is testing Codex')
    // Stopped after its tries: the row says so and offers Test again…, which opens the owner's own test.
    const stopped = rulesMarkup('health', rules({ snapshot: { ...RULES, autoTests: { running: null, stopped: [{ kind: 'context', harness: 'codex', version: '0.171.0', tries: 3, at }] } } }))
    expect(stopped).toMatch(/<span class="faint" title="[^"]*">BMN stopped after 3 tries on 0.171.0<\/span>/)
    expect([...stopped.matchAll(/aria-label="Test the context limit of ([A-Za-z ]+) again">Test again…/g)].map((match) => match[1])).toEqual(['Codex'])
  })

  it('refuses a limit above what the model holds, inline, and a compaction point that is not below the limit', () => {
    expect(limitRefusal({ context_window: 400000 }, 400001)).toBe("Above the model's 400 000 tokens")
    expect(limitRefusal({ context_window: 400000 }, 400000)).toBeNull()
    expect(limitRefusal({}, 9_000_000)).toBeNull()
    expect(limitRefusal({ compact_at: 200000 }, 200000)).toBe('Must be above Compact at, 200 000')
    expect(compactRefusal({ context_limit: 272000 }, 272000)).toBe('Must be below the context limit, 272 000')
    expect(compactRefusal({ context_limit: 272000 }, 200000)).toBeNull()
  })

  it('shows capacity, and Compact at only once a limit is set', () => {
    const page = (id: string): string => renderToStaticMarkup(createElement(TeamPreferences, { team: team(), page: { name: 'agent', id }, context: RULES.context, go: noop }))
    const sol = page('sol')
    expect(sol).toContain('of 400 000 tokens')
    expect(sol).toContain('aria-label="Compact at"')
    expect(sol).toContain('Not supported yet on Codex 0.171.0: kept but not applied until its test passes in Integrations › Health.')
    expect(sol).toContain('Not supported yet on Codex: kept but not applied. The app starts summarising the conversation here.')
    const luna = page('luna')
    expect(luna).toContain('capacity unknown')
    expect(luna).not.toContain('aria-label="Compact at"')
    expect(luna).toContain("Empty means the app&#x27;s own default.")
  })

  it('says what a limit does where the setting is tested, and where the app does not take the size', () => {
    expect(contextLimitHint({ harness: 'claude', context_limit: 200000 }, RULES.context)).toBe("Added to each run BMN or dev-auto starts with this agent, and checked before it leaves. Empty means the app's own default.")
    expect(contextLimitHint({ harness: 'claude', context_limit: 90000 }, RULES.context)).toBe('Claude Code takes 100 000 to 1 000 000 tokens; a run with this limit is refused.')
    expect(contextLimitHint({ harness: 'opencode', context_limit: 90000 }, RULES.context)).toBe('Not supported yet: BMN has no context setting for OpenCode. The limit is kept but not applied.')
    expect(contextLimitHint({ harness: 'codex', context_limit: 90000 }, null)).toBe("Empty means the app's own default.")
    expect(compactHint({ harness: 'codex' }, RULES.context.map((row) => ({ ...row, compactProven: true })))).toBe('The app starts summarising the conversation here.')
  })
})

describe('skills (60.11 AC5)', () => {
  const page = rulesMarkup('skills')

  it('shows one row per skill: its name, the first line of its description, Public and its state in each app', () => {
    expect(page).toContain('<h3 class="page-title">Skills</h3><span class="faint">3 skills · 1 not installed yet</span>')
    expect(page).toContain('<span class="faint mono" title="/home/synthetic/.claude/skills">~/.claude/skills</span>')
    expect(page).toContain('<b class="mono">alpha</b><span class="faint" title="First synthetic skill.">First synthetic skill.</span>')
    expect([...page.matchAll(/aria-label="alpha in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(['Claude Code: Reads it', 'Codex: Linked', 'OpenCode: Exposed'])
    expect([...page.matchAll(/aria-label="beta in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => match[2])).toEqual(['Reads it', 'Missing', 'Reads it'])
    expect(page).toContain('<span class="faint scope-word">All apps</span>')
    expect(page).toMatch(/role="switch" aria-checked="false" aria-label="alpha is public"/)
    // The exposed skill carries the attention mark on its chip, and the page says what to do about it.
    expect(page).toMatch(/aria-label="alpha in OpenCode: Exposed" title="OpenCode can see this skill but may not have it"><span class="needs-dot"[^>]*><\/span>OpenCode<span class="chip-state">Exposed<\/span>/)
    expect(words(page)).toContain('One skill can be seen by an app that may not have it. Mark the skill Public, or move it out of the skills folder.')
  })

  it('offers no Install…: what is not installed yet is said in the head, and BMN installs it (Story 75.9); a skill it cannot read stays out of reach', () => {
    expect(page).toContain('<span class="faint">3 skills · 1 not installed yet</span>')
    expect(page).not.toContain('Install…')
    expect(words(page)).toContain('A change takes effect on approval; BMN then installs it in each app, and at every start installs what an app lacks.')
    expect(page).toContain('<b class="mono">Bad_Name</b><span class="faint">the name must be lowercase letters, digits and hyphens</span>')
    expect(page).toMatch(/aria-label="Bad_Name is public" disabled=""/)
  })

  it('shows a staged scope as chips, and stages Public and scope changes for approval', () => {
    const staged = { ...DATA, skills: [{ id: 'beta', public: true as const, only: ['codex' as const, 'opencode' as const] }] }
    const markup = rulesMarkup('skills', rules(), team({ data: staged, hasStaged: true }))
    expect(markup).toContain('<span class="faint scope-word">Only</span>')
    expect([...markup.matchAll(/aria-pressed="(true|false)" aria-label="beta in/g)].map((match) => match[1])).toEqual(['false', 'true', 'true'])
    expect(markup).toMatch(/aria-pressed="false" aria-label="beta in Claude Code: Off" title="Not for Claude Code"/)
    expect(markup).toMatch(/role="switch" aria-checked="true" aria-label="beta is public"/)
    expect(setSkillPublic(DATA, 'alpha', true).skills).toEqual([{ id: 'alpha', public: true }])
    expect(Object.keys(setSkillPublic(setSkillPublic(DATA, 'alpha', true), 'alpha', false))).not.toContain('skills')
    expect(toggleSkillApp(DATA, 'alpha', 'opencode').skills).toEqual([{ id: 'alpha', only: ['claude', 'codex'] }])
    expect(skillMark(toggleSkillApp(toggleSkillApp(DATA, 'alpha', 'opencode'), 'alpha', 'opencode'), 'alpha')).toEqual({ id: 'alpha' })
    const one = { ...DATA, skills: [{ id: 'alpha', only: ['codex' as const] }] }
    expect(toggleSkillApp(one, 'alpha', 'codex')).toBe(one)
    expect(rulesMarkup('skills', rules(), team({ data: one }))).toMatch(/aria-label="alpha in Codex: Linked" disabled="" title="A skill needs at least one app"/)
  })

  it('names in the approval which apps a change reaches', () => {
    const differences: RosterDiffShape[] = [
      { scope: 'skills', id: 'alpha', field: null, kind: 'added', after: { present: true, value: { public: true, only: ['codex', 'opencode'] } } },
      { scope: 'skills', id: '.source', field: 'folder', kind: 'changed', before: { present: true, value: '/a' }, after: { present: true, value: '/srv/skills' } }
    ]
    const { groups, general } = groupDifferences(differences, DATA, DATA, ['Skill alpha would reach OpenCode', 'Skill alpha would no longer reach Claude Code', 'Skills would come from another folder'])
    expect(general).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'skills', subject: 'Skills', consequences: ['Skill alpha would reach OpenCode', 'Skill alpha would no longer reach Claude Code', 'Skills would come from another folder'] })
    expect(groups[0]!.lines).toEqual([
      { field: 'alpha', before: '—', after: 'added' },
      { field: 'alpha · public', before: '—', after: 'yes', detail: true },
      { field: 'alpha · only in', before: '—', after: 'Codex, OpenCode', detail: true },
      { field: 'Skills folder', before: '/a', after: '/srv/skills' }
    ])
  })

  it('lists its own installs with Undo, and leaves them out of the rules\' earlier versions', () => {
    expect(page).toMatch(/<summary>Earlier installs<\/summary><div class="list-line"><div><b>Installed<\/b> <span class="line-detail">[^<]+ · Codex<\/span><\/div><button type="button" class="small" aria-label="Undo the skills install of [^"]+">Undo…<\/button>/)
    expect(earlierVersions(RULES).some((entry) => entry.kind === 'install' && entry.id === 't3')).toBe(false)
    expect(undoWords({ change: 'folder', diff: '' })).toBe('Put back as it was')
    expect(undoWords({ change: 'entry', diff: '' })).toBe('Put back as it was')
  })

  it('Health shows one row per app: where its skills live, the state in words, Full or Public skills only and the last loading test', () => {
    const health = rulesMarkup('health')
    expect(health).toContain('<h4 class="group-head">Skills<span class="caption">where each app reads skills, and whether it has the ones it may have</span></h4>')
    expect(words(health)).toMatch(/Checked [^·]+ · 9 need you · 1 skill entry not installed yet · 1 skill exposed/)
    expect(health).toMatch(/data-skills="Reads the source"><span>Claude Code<\/span><span class="health-state"><span>The skills folder itself<\/span><\/span><span class="health-state"><span>Reads the source<span class="muted"> · Full<\/span><\/span><span class="faint" title="Claude Code named a test skill">Listing test passed [^<]+ · stale · loading never tested<\/span>/)
    expect(health).toMatch(/data-skills="Missing"><span>Codex<\/span><span class="health-state"><span class="path mono" title="\/home\/synthetic\/.agents\/skills">~\/.agents\/skills<\/span><\/span><span class="health-state"><span><span class="needs-dot"[^>]*><\/span>Missing<span class="muted"> · Full<\/span><\/span><span class="faint" title="[^"]*">Loading never tested<\/span>/)
    expect(health).toMatch(/data-skills="Exposed"><span>OpenCode<\/span>.*?Exposed<span class="muted"> · Public skills only<\/span><\/span><span class="faint" title="[^"]*">No loading test<\/span>/)
    // BMN tests by itself: no Test… and no Loading test… (Story 75.8).
    expect(health).not.toMatch(/aria-label="Skills test for|aria-label="Skill loading test for|Loading test…/)
    // An app BMN has no skills test for says so.
    const untested = rulesMarkup('health', rules({ snapshot: { ...RULES, skills: { ...RULES.skills, apps: RULES.skills.apps.map((app) => (app.harness === 'opencode'
      ? { ...app, supported: false, reason: 'no test has run on OpenCode 1.18.32', testable: false, readsSource: false, kind: 'public' as const, kindReason: '', state: 'Not supported yet', test: null }
      : app)) } } }))
    expect(untested).toMatch(/data-skills="Not supported yet"><span>OpenCode<\/span><span class="health-state"><span class="faint">Not known yet<\/span><\/span><span class="health-state"><span title="no test has run on OpenCode 1.18.32">Not supported yet<\/span><span class="faint">BMN has no test for this app<\/span>/)
    // Test again… follows a failure or a stop: the folders test for any app BMN can ask, the loading test only where the app may receive private work.
    const after = rulesMarkup('health', rules({ snapshot: { ...RULES, autoTests: { running: null, stopped: [
      { kind: 'skills', harness: 'opencode', version: '1.18.32', tries: 3, at: '2026-10-09T20:00:00.000Z' },
      { kind: 'skills-loading', harness: 'codex', version: '0.171.0', tries: 3, at: '2026-10-09T20:00:00.000Z' },
      { kind: 'skills-loading', harness: 'opencode', version: '1.18.32', tries: 3, at: '2026-10-09T20:00:00.000Z' }
    ] } } }))
    expect([...after.matchAll(/aria-label="Test the skills of ([A-Za-z ]+) again"/g)].map((match) => match[1])).toEqual(['OpenCode'])
    expect([...after.matchAll(/aria-label="Test skill loading in ([A-Za-z ]+) again"/g)].map((match) => match[1])).toEqual(['Codex'])
    expect(after).toMatch(/data-skills="Missing"><span>Codex<\/span>.*?<span class="faint" title="[^"]*">BMN stopped after 3 tries on 0.171.0<\/span>/)
    expect(rulesMarkup('health', rules({ snapshot: { ...RULES, autoTests: { running: { kind: 'skills-loading', harness: 'codex' }, stopped: [] } } }))).toContain('BMN is testing Codex now…')
  })

  it('says each state and test in plain words', () => {
    const app = { harness: 'codex' as const, supported: true, format: 'copy' as const, kind: 'full' as const }
    expect(skillStateWords('current', app, true)).toBe('Copied')
    expect(skillStateWords('stale', app, true)).toBe('Differs')
    expect(skillStateWords('excluded', app, true)).toBe('Not public')
    expect(skillStateWords('excluded', app, false)).toBe('Off')
    expect(skillStateWords('exposed', app, false)).toBe('Exposed')
    expect(skillStateWords('unreadable', app, true)).toBe("Can't read")
    expect(skillStateWords(undefined, { supported: false, format: null }, true)).toBe('Not yet')
    expect(skillStateHint('excluded', { ...app, kind: 'public' }, true, 'OpenCode')).toBe('OpenCode gets public skills only')
    expect(skillStateHint('missing', app, true, 'Codex')).toBe('Not in Codex yet: BMN adds it at its next start or approval')
    expect(skillStateHint('stale', app, true, 'Codex')).toBe('Codex has an older copy: BMN updates it at its next start or approval')
    expect(skillStateHint('unmanaged', app, true, 'Codex')).toBe('Codex holds something else under this name, which BMN leaves as it is: remove it there and BMN adds the skill')
    expect(skillStateHint(undefined, { ...app, supported: false }, true, 'OpenCode')).toBe('Skills are not supported yet in OpenCode: Health says how BMN\'s test of it stands')
    const base = { supported: false, version: '0.171.0', test: null, listing: null, loading: null, kind: 'full' as const, testable: true }
    expect(skillsTestLine({ ...base, version: null })).toBe('The app is not found')
    expect(skillsTestLine(base)).toBe('BMN tests 0.171.0 by itself')
    expect(skillsTestLine({ ...base, test: { at: 'x', version: '0.171.0', outcome: 'inconclusive', detail: 'd' } })).toBe('The test was inconclusive on 0.171.0')
    expect(skillsTestLine({ ...base, test: { at: 'x', version: '0.170.0', outcome: 'fail', detail: 'd' } })).toBe('BMN tests 0.171.0 by itself')
    // A listing is named a listing, and never reads as a loading test; the loading test, once run, is the line.
    const seen = { at: '2026-10-09T20:00:00.000Z', version: '0.171.0', detail: 'd', stale: false }
    const there = { ...base, supported: true }
    expect(skillsTestLine(there)).toBe('Loading never tested')
    expect(skillsTestLine({ ...there, listing: { ...seen, outcome: 'pass' } })).toMatch(/^Listing test passed [^·]+ · loading never tested$/)
    // The loading test sends one prompt, and says so; one BMN ran by itself says that too.
    expect(skillsTestLine({ ...there, listing: { ...seen, outcome: 'pass' }, loading: { ...seen, outcome: 'inconclusive', stale: true } })).toMatch(/^Loading test inconclusive [^·]+ · stale · one prompt sent$/)
    expect(skillsTestLine({ ...there, loading: { ...seen, outcome: 'pass', by: 'bmn' } })).toMatch(/^Loading test passed [^·]+ · by BMN · one prompt sent$/)
    expect(skillsTestLine({ ...there, kind: 'public' })).toBe('No loading test')
  })
})

describe('tools (60.12 AC6)', () => {
  const TOOLS: RosterToolShape[] = [
    { id: 'browser', name: 'Browser', command: 'npx', args: ['@synthetic/browser-tool'], agents: ['luna'] },
    { id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', public: true },
    { id: 'notes', name: 'Notes', command: 'notes-tool', args: ['--token', { env: 'NOTES_TOKEN' }], env: { TOKEN: 'NOTES_TOKEN' }, apps: ['claude', 'codex'] }
  ]
  const WITH: RosterDataShape = { ...DATA, tools: TOOLS }
  const page = rulesMarkup('tools', rules(), team({ data: WITH, base: WITH, approved: WITH }))

  it('shows one row per tool: its name, what it runs, the variables it names, Public and its state in each app', () => {
    expect(page).toContain('<h3 class="page-title">Tools</h3><span class="faint">3 tools · 2 not installed yet</span>')
    expect(page).toContain('<b>Docs</b><span class="faint mono" title="docs.example.test">docs.example.test</span>')
    expect(page).toContain('<b>Notes</b><span class="faint mono" title="notes-tool · needs NOTES_TOKEN">notes-tool · needs NOTES_TOKEN</span>')
    expect([...page.matchAll(/aria-label="Docs in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(['Claude Code: Set up', 'Codex: Missing', 'OpenCode: Not public'])
    expect([...page.matchAll(/aria-label="Notes in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => match[2])).toEqual(['Differs', 'Blocked', 'Exposed'])
    expect([...page.matchAll(/aria-pressed="(true|false)" aria-label="Notes in/g)].map((match) => match[1])).toEqual(['true', 'true', 'false'])
    expect(page).toMatch(/role="switch" aria-checked="true" aria-label="Docs is public"/)
    expect(page).toMatch(/role="switch" aria-checked="false" aria-label="Notes is public"/)
    // Why Codex cannot take it is the chip's own hint; the exposed and the blocked chip carry the attention mark.
    expect(page).toMatch(/aria-label="Notes in Codex: Blocked" title="Codex takes a variable only under its own name: NOTES_TOKEN is asked for as TOKEN"><span class="needs-dot"[^>]*><\/span>Codex<span class="chip-state">Blocked<\/span>/)
    expect(page).toMatch(/aria-label="Notes in OpenCode: Exposed" title="OpenCode holds this tool but may not have it"><span class="needs-dot"/)
    expect(words(page)).toContain('One tool is in an app that may not have it. Mark the tool Public, or remove its entry in that app.')
    // The reason is also said under the row, in words.
    expect(page).toMatch(/<p class="preferences-help tool-why"><span class="needs-dot"[^>]*><\/span>In Codex: Codex takes a variable only under its own name: NOTES_TOKEN is asked for as TOKEN<\/p>/)
    expect(count(page, 'tool-why')).toBe(1)
  })

  it('shows a tool kept to agents by their names, in no app\'s settings', () => {
    expect(page).toMatch(/aria-label="Agents whose runs get Browser"><span class="faint scope-word">Runs of<\/span><button type="button" class="chip on" aria-pressed="true" aria-label="Browser for the runs of Luna" disabled="" title="A tool kept to agents needs at least one">Luna<\/button><span class="faint">in no app&#x27;s settings<\/span>/)
    expect(page).not.toContain('aria-label="Browser in ')
  })

  it('offers no Install… (Story 75.9), and Add tool, From your apps… and each tool\'s Edit and Remove', () => {
    expect(page).toContain('· 2 not installed yet</span>')
    expect(page).not.toContain('Install…')
    expect(page).toContain('<button type="button">Add tool</button><button type="button">From your apps…</button>')
    expect(page).toContain('<button type="button" class="small" aria-label="Edit Notes">Edit</button><button type="button" class="small" aria-label="Remove Notes" title="Takes it off your list; approve to keep that">Remove</button>')
    // A team with no tools says so and still offers both ways in.
    const none = rulesMarkup('tools')
    expect(none).toContain('<span class="faint">0 tools · 2 not installed yet</span>')
    expect(words(none)).toContain('No tools on your list yet.')
    expect(none).toContain('>Add tool</button>')
  })

  it('lists the entries the apps hold that are not on the list, each once, and offers to remove them', () => {
    expect(page).toContain('<h4 class="group-head">In your apps, not on your list<span class="caption">BMN did not write these and leaves them</span></h4>')
    expect(count(page, 'data-unlisted="old-search"')).toBe(1)
    expect(words(page).replace(/\s+/g, ' ')).toContain('old-search Claude Code, OpenCode · in an app that gets public work only')
    expect(page).toContain('>Remove them from the apps…</button>')
    const settled = { ...RULES, tools: { ...RULES.tools, apps: RULES.tools.apps.map((app) => ({ ...app, unlisted: [] })) } }
    expect(rulesMarkup('tools', rules({ snapshot: settled }), team({ data: WITH }))).not.toContain('not on your list')
  })

  it('Add tool and Edit are plain rows: no list of the browser\'s own, every field named', () => {
    const editor = (start: ToolDraft): string => renderToStaticMarkup(createElement(ToolEditor, { data: WITH, start, onDone: noop }))
    const adding = editor(EMPTY_DRAFT)
    expect(adding).toContain('<div class="sheet tool-editor" role="group" aria-label="Add a tool">')
    expect(adding).not.toContain('<select')
    expect([...adding.matchAll(/<(?:input|textarea)[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual(['Tool name', 'Tool id', 'Program', 'Arguments', 'Variables'])
    expect([...adding.matchAll(/role="radio" aria-checked="(?:true|false)"[^>]*>([^<]+)/g)].map((match) => match[1])).toEqual(['A program', 'An address', 'All apps', 'Some apps', 'Some agents'])
    expect(words(adding)).toContain('Environment variables the program needs, one name per line; NAME=OTHER when yours is named differently. Never a value.')
    expect(adding).toContain('<button type="button" class="primary">Add tool</button><button type="button">Cancel</button>')
    // Editing: the id stays, an address shows its own rows, and a tool kept to apps shows them as chips.
    const address = editor(draftFrom(TOOLS[1]!))
    expect(address).toContain('aria-label="Edit Docs"')
    expect(address).toMatch(/aria-label="Tool id"[^>]*disabled=""[^>]*value="docs"/)
    expect([...address.matchAll(/<(?:input|textarea)[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual(['Tool name', 'Tool id', 'Address', 'Headers'])
    const some = editor(draftFrom(TOOLS[2]!))
    expect(some).toContain('<textarea class="field wide mono" aria-label="Arguments" aria-invalid="false" rows="3">--token\n$NOTES_TOKEN</textarea>')
    expect(some).toContain('<textarea class="field wide mono" aria-label="Variables" aria-invalid="false" rows="2">TOKEN=NOTES_TOKEN</textarea>')
    expect([...some.matchAll(/class="(chip on|chip)" aria-pressed="(?:true|false)">([^<]+)/g)].map((match) => `${match[2]}${match[1] === 'chip on' ? ' on' : ''}`)).toEqual(['Claude Code on', 'Codex on', 'OpenCode'])
    const kept = editor(draftFrom(TOOLS[0]!))
    expect(words(kept)).toContain('Only these agents&#x27; runs get it. No app keeps it in its settings.')
    expect(kept).toMatch(/aria-label="Agents whose runs get it">.*<button type="button" class="chip on" aria-pressed="true">Luna<\/button>/)
  })

  it('From your apps… says what each entry would do, and adds only what can join the list', () => {
    const found: ToolProposalView[] = [
      { id: 'search', state: 'ready', apps: ['claude'], tool: { id: 'search', name: 'search', command: 'search-tool', apps: ['claude'] }, notes: [] },
      { id: 'mail', state: 'secret', apps: ['codex'], tool: { id: 'mail', name: 'mail', command: 'mail-tool', env: { MAIL_KEY: 'MAIL_KEY' }, apps: ['codex'] }, notes: ['MAIL_KEY held a value in Codex: it is left out; set the variable where the app starts'] },
      { id: 'docs', state: 'known', apps: ['claude'], notes: ['already on your list'] },
      { id: 'maps', state: 'conflict', apps: ['claude', 'opencode'], notes: ['the apps define maps differently: keep one, or give each its own id'] }
    ]
    const sheet = renderToStaticMarkup(createElement(ToolProposals, { found, data: WITH, onAdd: noop, onCancel: noop }))
    expect(sheet).toContain('aria-label="Add 2 tools from your apps"')
    expect(words(sheet).replace(/\s+/g, ' ')).toContain('search Claude Code · will be added')
    expect(words(sheet).replace(/\s+/g, ' ')).toContain('mail Codex · will be added without the value it holds MAIL_KEY held a value in Codex: it is left out; set the variable where the app starts')
    expect(words(sheet).replace(/\s+/g, ' ')).toContain('docs Claude Code · already on your list')
    expect(words(sheet).replace(/\s+/g, ' ')).toContain('maps Claude Code, OpenCode · the apps differ, so it is not added')
    expect(count(sheet, 'already on your list')).toBe(1)
    const nothing = renderToStaticMarkup(createElement(ToolProposals, { found: found.slice(2), data: WITH, onAdd: noop, onCancel: noop }))
    expect(nothing).toMatch(/aria-label="Nothing new in your apps".*<button type="button" class="primary" disabled="">Add to your list<\/button>/s)
    expect(words(renderToStaticMarkup(createElement(ToolProposals, { found: [], data: WITH, onAdd: noop, onCancel: noop })))).toContain('Your apps hold no tool entries.')
  })

  it('shows a removal entry by entry with what each holds now and would hold, and what stays exposed or blocked', () => {
    const plan: ToolsPlan = {
      ok: true, code: 'OK', planHash: 'h'.repeat(64), removeUnlisted: true,
      targets: [
        { harness: 'codex', tool: 'docs', path: '/home/synthetic/.codex/config.toml', action: 'set', words: 'adds the tool', before: null, after: '[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"' },
        { harness: 'claude', tool: 'notes', path: '/home/synthetic/.claude.json', action: 'set', words: 'replaces an entry changed outside BMN', before: '{"command":"old","env":{"TOKEN":"•••"}}', after: '{"type":"stdio","command":"notes-tool"}' }
      ],
      exposed: [{ harness: 'opencode', tool: 'notes', fix: 'remove notes from OpenCode, or mark it public' }],
      blocked: [{ harness: 'codex', tool: 'notes', fix: 'Codex takes a variable only under its own name' }]
    }
    const sheet = rulesMarkup('tools', rules({ pending: { kind: 'tools', plan } }), team({ data: WITH }))
    expect(sheet).toContain('aria-label="Change 2 tool entries"')
    expect(words(sheet)).toContain('Only these entries change in each file. Undo, under Earlier installs, puts them back.')
    expect(sheet).toContain('<span class="muted">docs · adds the tool</span>')
    expect(sheet).toContain('<pre class="diff">+[mcp_servers.docs]\n+url = &quot;https://docs.example.test/mcp&quot;</pre>')
    expect(sheet).toContain('<pre class="diff">-{&quot;command&quot;:&quot;old&quot;,&quot;env&quot;:{&quot;TOKEN&quot;:&quot;•••&quot;}}\n+{&quot;type&quot;:&quot;stdio&quot;,&quot;command&quot;:&quot;notes-tool&quot;}</pre>')
    expect(words(sheet)).toContain('One entry stays exposed whatever is installed:')
    expect(sheet).toContain('<p class="preferences-help">notes: remove notes from OpenCode, or mark it public</p>')
    expect(words(sheet)).toContain('One entry is not changed:')
    expect(sheet).toContain('<p class="preferences-help">Codex, notes: Codex takes a variable only under its own name</p>')
    const none = rulesMarkup('tools', rules({ pending: { kind: 'tools', plan: { ...plan, targets: [] } } }), team({ data: WITH }))
    expect(none).toMatch(/aria-label="No app holds such an entry now".*<button type="button" class="primary" disabled="">Change<\/button>/s)
  })

  it('lists its own installs with Undo, and leaves them out of the rules\' earlier versions and install date', () => {
    expect(page).toMatch(/<summary>Earlier installs<\/summary><div class="list-line"><div><b>Installed<\/b> <span class="line-detail">[^<]+ · Claude Code<\/span><\/div><button type="button" class="small" aria-label="Undo the tools install of [^"]+">Undo…<\/button>/)
    expect(earlierVersions(RULES).some((entry) => entry.kind === 'install' && entry.id === 't4')).toBe(false)
  })

  it('Health shows one row per app: its settings file, the state in words, Full or Public tools only and the last test', () => {
    const health = rulesMarkup('health')
    expect(health).toContain('<h4 class="group-head">Tools<span class="caption">where each app keeps its tools, and whether it has the ones it may have</span></h4>')
    expect(words(health)).toMatch(/Checked [^·]+ · 9 need you · 1 skill entry not installed yet · 1 skill exposed · 2 tool entries not installed yet · 1 tool exposed/)
    expect(health).toMatch(/data-tools="Differs"><span>Claude Code<\/span><span class="health-state"><span class="path mono" title="\/home\/synthetic\/.claude.json">~\/.claude.json<\/span><\/span><span class="health-state"><span><span class="needs-dot"[^>]*><\/span>Differs<span class="muted"> · Full<\/span><\/span><span class="faint" title="Claude Code listed the stand-in tool">Checked [^<]+ · passes variables · a run keeps to its own tools<\/span>/)
    expect(health).toMatch(/data-tools="Missing"><span>Codex<\/span>.*?Missing<span class="muted"> · Full<\/span><\/span><span class="faint" title="[^"]*">Checked [^<]+ · variables not seen · no run seen kept to its tools<\/span>/)
    expect(health).toMatch(/data-tools="Exposed"><span>OpenCode<\/span>.*?<span class="faint" title="\/home\/synthetic\/dotfiles\/opencode.jsonc">A link: BMN does not write through it<\/span>.*?Exposed<span class="muted"> · Public tools only<\/span>/)
    expect(health).not.toMatch(/aria-label="Tools test for|aria-label="Test the tools of/)
    const failed = rulesMarkup('health', rules({ snapshot: { ...RULES, tools: { ...RULES.tools, apps: RULES.tools.apps.map((app) => (app.harness === 'codex'
      ? { ...app, test: { at: '2026-10-09T20:00:00.000Z', version: app.version, outcome: 'fail' as const, detail: 'd', by: 'bmn' as const } } : app)) } } }))
    expect([...failed.matchAll(/aria-label="Test the tools of ([A-Za-z ]+) again">Test again…/g)].map((match) => match[1])).toEqual(['Codex'])
    const untested = rulesMarkup('health', rules({ snapshot: { ...RULES, tools: { ...RULES.tools, apps: RULES.tools.apps.map((app) => (app.harness === 'opencode'
      ? { ...app, supported: false, reason: 'no test has run on OpenCode 1.18.32', state: 'Not supported yet', variable: false, isolation: false, test: null }
      : app)) } } }))
    expect(untested).toMatch(/data-tools="Not supported yet"><span>OpenCode<\/span>.*?<span title="no test has run on OpenCode 1.18.32">Not supported yet<\/span><span class="faint">BMN tests 1.18.32 by itself<\/span>/)
    expect(health.indexOf('<h4 class="group-head">Skills')).toBeLessThan(health.indexOf('<h4 class="group-head">Tools'))
    expect(health.indexOf('<h4 class="group-head">Tools')).toBeLessThan(health.indexOf('<h4 class="group-head">Context limits'))
  })

  it('names in the approval who a tool change reaches, in words', () => {
    const differences: RosterDiffShape[] = [
      { scope: 'tools', id: 'notes', field: null, kind: 'added', after: { present: true, value: { name: 'Notes', command: 'notes-tool', args: ['--token', { env: 'NOTES_TOKEN' }], env: { TOKEN: 'NOTES_TOKEN' }, apps: ['claude', 'codex'] } } },
      { scope: 'tools', id: 'browser', field: 'agents', kind: 'changed', before: { present: true, value: ['luna'] }, after: { present: true, value: ['luna', 'sol'] } }
    ]
    const first = 'With a tool on the list, the check keeps every Claude Code run to exactly its own tools, once its tools test passed there; it does not judge the tools of a Codex run'
    const { groups, general } = groupDifferences(differences, DATA, WITH, ['Tool Notes would reach Claude Code and Codex', 'Tool Browser is for the runs of Sol, and BMN cannot give a Codex run a tool yet', first])
    expect(general).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'tools', subject: 'Tools', consequences: ['Tool Notes would reach Claude Code and Codex', 'Tool Browser is for the runs of Sol, and BMN cannot give a Codex run a tool yet', first] })
    expect(groups[0]!.lines.map((line) => `${line.field}: ${line.before} > ${line.after}`)).toEqual([
      'notes: — > added', 'notes · name: — > Notes', 'notes · program: — > notes-tool', 'notes · arguments: — > --token $NOTES_TOKEN', 'notes · variables: — > TOKEN from NOTES_TOKEN',
      'notes · only in: — > Claude Code, Codex', 'browser · only for the runs of: Luna > Luna, Sol'
    ])
    const lines = groups[0]!.lines.map((line) => `${line.field} ${line.before} ${line.after}`)
    expect(lines.join('\n')).not.toMatch(SCHEMA_WORDS)
  })
})

describe('Agents › Models (60.10, first release)', () => {
  const checked = (verified: boolean, why?: string) => ({ rank: 1 as const, verified, ...(why ? { why } : {}) })
  const found = (id: string, providerId: string, extra: Partial<ResearchModelView> = {}): ResearchModelView => ({
    id, provider: providerId === 'openai' ? 'OpenAI' : 'Anthropic', providerId, price: null, contextWindow: null,
    firstSeen: '2026-10-10T09:40:00.000Z', lastSeen: '2026-10-10T09:40:00.000Z', fresh: false, foundLast: true, ...extra
  })
  /** The tools the fence test saw Codex keep offering, as its record names them. */
  const FENCE_TOOLS = ['custom:functions.exec', 'exec:apply_patch', 'exec:web__run', 'function:collaboration.spawn_agent', 'function:functions.request_user_input', 'function:functions.wait']
  const RESEARCH: ResearchSnapshot = {
    last: { at: '2026-10-10T09:40:00.000Z', researcher: 'Fable', state: 'complete', models: 6 },
    previousAt: '2026-10-03T09:00:00.000Z',
    models: [
      found('model-sol', 'openai', { price: { input: 2, output: 8, source: 'https://openai.example.test/api/pricing', as_of: '2026-10-10', ...checked(true) },
        contextWindow: { tokens: 400000, source: 'https://openai.example.test/models', as_of: '2026-10-10', ...checked(true) } }),
      found('model-fable', 'anthropic', { price: { input: 20, output: 100, source: 'https://www.anthropic.example.test/pricing', as_of: '2026-10-10', ...checked(true) } }),
      found('model-luna', 'openai', { firstSeen: '2026-10-03T09:00:00.000Z', lastSeen: '2026-10-03T09:00:00.000Z', foundLast: false }),
      found('model-next', 'anthropic', { fresh: true, price: { input: 15, output: 75, source: 'https://www.anthropic.example.test/pricing', as_of: '2026-10-10', ...checked(true) } }),
      found('model-far', 'anthropic', { fresh: true, price: { input: 0.6, output: 2.5, source: 'https://blog.example.test/prices', as_of: '2026-10-10', rank: 2, verified: false, why: 'the page does not name this model' } }),
      found('model-old', 'openai', { firstSeen: '2026-10-03T09:00:00.000Z' })
    ],
    researchers: [
      { id: 'sol', name: 'Sol', harness: 'codex', ok: true, fence: { tools: FENCE_TOOLS, compared: true } }, { id: 'fable', name: 'Fable', harness: 'claude', ok: true },
      { id: 'luna', name: 'Luna', harness: 'codex', ok: true, fence: { tools: FENCE_TOOLS, compared: true } },
      { id: 'glm', name: 'Glm', harness: 'claude', ok: false, why: 'its provider gets public work only', reason: 'synthetic reason with the word roster in it' },
      { id: 'kimi', name: 'Kimi', harness: 'opencode', ok: false, why: 'the fence test has not run for this version of OpenCode yet', reason: 'synthetic' }
    ],
    researcher: 'fable', choice: { named: ['sol', 'fable', 'luna', 'glm', 'kimi'], proposed: [] }, dropped: null, fenceTest: { running: false, ended: null, last: [{ harness: 'codex', verdict: 'pass', version: '0.161.0', at: '2026-10-09T20:00:00.000Z' }] }, autoTests: { running: null, stopped: [] }, running: null, ended: null
  }
  const lookup = async () => ({ ok: false, message: '', model: null })
  const research = (extra: Partial<ResearchState> = {}): ResearchState => ({
    snapshot: RESEARCH, loadError: null, busy: false, notice: null, setNotice: noop, ensure: noop, peek: noop, testFence: later, choose: noop, start: later, stop: later, lookUp: lookup, ...extra
  })
  const modelsMarkup = (state: ResearchState = research(), teamState: TeamState = team()): string =>
    renderToStaticMarkup(createElement(TeamPreferences, { team: teamState, page: { name: 'models' }, research: state, go: noop }))
  const page = modelsMarkup()
  const lines = (markup: string): string[] => [...markup.matchAll(/<div class="model-line" data-model="([^"]+)">/g)].map((match) => match[1]!)
  /** The researchers offered, each as its piece's name, its own name and whether it is the chosen one. */
  const offered = (markup: string): string[] =>
    [...markup.matchAll(/role="radio" aria-checked="(true|false)"[^>]*><svg class="piece"[^>]*role="img" aria-label="([^"]+)"[^>]*>.*?<\/svg>([^<]+)</g)].map((match) => `${match[2]} ${match[3]}:${match[1]}`)

  it('tells two researchers of one name apart by their pieces', () => {
    const twins = { ...DATA, agents: [...DATA.agents,
      { ...agent('opus', { class: 'knight', harness: 'claude', provider: 'anthropic', roles: ['lead'] }), name: 'Opus' },
      { ...agent('opus-2', { class: 'queen', harness: 'claude', provider: 'anthropic' }), name: 'Opus' }] }
    const both: ResearchSnapshot = { ...RESEARCH, researcher: 'opus-2', researchers: [
      { id: 'opus', name: 'Opus', harness: 'claude', ok: true }, { id: 'opus-2', name: 'Opus', harness: 'claude', ok: true }] }
    expect(offered(modelsMarkup(research({ snapshot: both }), team({ base: twins, data: twins, approved: twins })))).toEqual(['Knight Opus:false', 'Queen Opus:true'])
  })

  it('heads the page with the last research, who did it and Research now (AC1)', () => {
    expect(page).toContain(`<h3 class="page-title">Models</h3><span class="faint">Researched ${shortDate('2026-10-10T09:40:00.000Z')} by Fable · 6 models</span>`)
    expect(page).toContain('<button type="button">Research now</button>')
    // The researcher is one of the agents that may research; the others are named with why in plain words, never the check's own.
    // Each is offered with its class's piece before its name, as on the Team pages.
    expect(offered(page)).toEqual(['Knight Sol:false', 'Rook Fable:true', 'Pawn Luna:false'])
    // One line each: what the researcher gets, then each agent that cannot research and why (docs/design.md W2).
    expect(page).toContain('<p class="preferences-help">Gets only your model names and the source list, never your files.</p><p class="preferences-help">Runs in an empty folder with web tools only.</p><p class="preferences-help">Glm cannot research: its provider gets public work only.</p><p class="preferences-help">Kimi cannot research: the fence test has not run for this version of OpenCode yet.</p>')
    expect(page).not.toContain('synthetic')
    expect(researcherHint({ harness: 'claude' })).toEqual(['Gets only your model names and the source list, never your files.', 'Runs in an empty folder with web tools only.'])
    expect(page).toContain('<ol class="sources"><li>Provider pages</li><li>Other sites</li></ol>')
    expect(words(page)).not.toMatch(SCHEMA_WORDS)
  })

  describe('who researches, and Codex behind its fence (63.3)', () => {
    const sol = RESEARCH.researchers.find((entry) => entry.id === 'sol')!
    const withSnapshot = (extra: Partial<ResearchSnapshot>, teamState: TeamState = team()): string => modelsMarkup(research({ snapshot: { ...RESEARCH, ...extra } }), teamState)

    it('a Codex researcher has the words of one on Claude Code plus one line that names the tools Codex keeps offering (AC4)', () => {
      const hint = researcherHint(sol)
      expect(hint).toEqual(['Gets only your model names and the source list, never your files.', 'Runs in an empty folder, with a Codex folder of its own and web search.',
        'Codex also offers exec (a script tool that reaches apply_patch and web__run), spawn_agent, request_user_input and wait; this Codex version\'s fence test showed none of them reads or writes your files.'])
      expect(hint[0]).toBe(researcherHint({ harness: 'claude' })[0])
      expect(withSnapshot({ researcher: 'sol' })).toContain(hint.map((line) => `<p class="preferences-help">${line.replace(/'/g, '&#x27;')}</p>`).join(''))
      // Until the tools were compared under the provider's own model list, the first research says what it does first (AC6).
      expect(researcherHint({ ...sol, fence: { tools: FENCE_TOOLS, compared: false } })).toContain('Its first research repeats the fence test under the provider\'s model list; another tool list stops it before any answer.')
      expect(researcherHint(sol).join(' ')).not.toContain('Its first research')
      expect(codexToolsLine([])).toBe('The fence test of this Codex version saw no other tool offered.')
    })

    it('says that the choice waits for him while the team names no researcher, and BMN\'s proposal is taken from the one card on Team (AC7, Story 75.10)', () => {
      const waiting = withSnapshot({ choice: { named: null, proposed: ['sol', 'luna', 'gone'] } })
      expect(words(waiting)).toContain('You have not chosen who researches, so every agent that can research is offered; BMN&#x27;s proposal is on Team.')
      expect(waiting).not.toMatch(/Use proposal|<div class="page-note with-action"[^>]*><span class="needs-dot"[^>]*><\/span><span class="note-text">You have not chosen/)
      const proposals = teamProposals(DATA, { lunaListed: false, researchers: { named: null, proposed: ['sol', 'luna', 'gone'] } })
      expect(proposals?.clauses).toContain('Sol and Luna as researchers, one agent per model')
      expect(namedResearchers(proposals!.data)).toEqual(['sol', 'luna'])
      // Once the approved team names its researchers, BMN proposes none.
      expect(teamProposals(DATA, { lunaListed: false, researchers: { named: ['sol'], proposed: [] } })?.clauses ?? []).not.toContain('Sol and Luna as researchers, one agent per model')
      // The proposal is staged like any other change: the mark on each proposed agent, nothing else touched.
      const taken = nameResearchers(DATA, ['sol', 'luna'])
      expect(taken.agents.filter((entry) => entry.researcher === true).map((entry) => entry.id)).toEqual(['sol', 'luna'])
      expect(namedResearchers(DATA)).toBeNull()
      expect(namedResearchers(taken)).toEqual(['sol', 'luna'])
      expect(setResearcher(taken, 'sol', false).agents.find((entry) => entry.id === 'sol')).toEqual(DATA.agents.find((entry) => entry.id === 'sol'))
      // Before he approved any name, switching each back off leaves the team as it was: nothing chosen.
      expect(setResearcher(setResearcher(taken, 'sol', false), 'luna', false)).toEqual(DATA)
      // Once he has staged names, or the team names them, the page no longer asks.
      expect(words(withSnapshot({ choice: { named: null, proposed: ['sol', 'luna'] } }, team({ base: DATA, data: taken, approved: DATA })))).not.toContain('You have not chosen who researches')
      expect(words(page)).not.toContain('You have not chosen who researches')
    })

    it('taking the last researcher away from a team that has chosen leaves nobody researching, never everybody again', () => {
      const chosen = nameResearchers(DATA, ['sol', 'luna'])
      // One of two switched off: the other still carries the choice, so this one's field just goes.
      const one = setResearcher(chosen, 'sol', false, true)
      expect(one.agents.find((entry) => entry.id === 'sol')).toEqual(DATA.agents.find((entry) => entry.id === 'sol'))
      expect(namedResearchers(one)).toEqual(['luna'])
      // The last one switched off: the mark stays, as `no`, and the team names none.
      const none = setResearcher(one, 'luna', false, true)
      expect(none.agents.find((entry) => entry.id === 'luna')?.researcher).toBe(false)
      expect(namedResearchers(none)).toEqual([])
      // Switched on and off again on an agent the team never named, the team is as it was.
      expect(setResearcher(setResearcher(one, 'fable', true, true), 'fable', false, true)).toEqual(one)
      const luna = none.agents.find((entry) => entry.id === 'luna')!
      expect(researcherWords(none, luna)).toEqual(['Your team names no researcher, so nobody researches: a research with Luna is refused.'])
      expect(researcherWords(one, one.agents.find((entry) => entry.id === 'sol')!)).toEqual(['Not offered on Models: a research with Sol is refused.'])
      expect(noResearcherWords([])).toBe('Your team names no researcher, so nobody researches. Switch Researcher on on an agent\'s page: an active agent on Claude Code, or on Codex or OpenCode where its fence test passed, whose provider may see private work.')
      const empty = withSnapshot({ researcher: null, researchers: [], choice: { named: [], proposed: [] } }, team({ base: none, data: none, approved: none }))
      expect(words(empty)).toContain('Your team names no researcher, so nobody researches.')
      expect(words(empty)).not.toContain('You have not chosen who researches')
      expect(empty).not.toContain('role="radio"')
    })

    it('offers only the researchers the team names: one Opus where the team holds two, and no row for the other (AC7, AC8)', () => {
      const twins = { ...DATA, agents: [...DATA.agents,
        { ...agent('opus', { class: 'knight', harness: 'claude', provider: 'anthropic', roles: ['lead'] }), name: 'Opus', researcher: true },
        { ...agent('opus-2', { class: 'queen', harness: 'claude', provider: 'anthropic' }), name: 'Opus' }] }
      const named = withSnapshot({ researcher: 'opus', choice: { named: ['opus'], proposed: [] }, researchers: [{ id: 'opus', name: 'Opus', harness: 'claude', ok: true }] }, team({ base: twins, data: twins, approved: twins }))
      expect(offered(named)).toEqual(['Knight Opus:true'])
      expect(words(named)).not.toContain('cannot research')
      expect(named).not.toContain('Codex fence test')
    })

    it('says once whom he had picked when that researcher is no longer named (AC8)', () => {
      const lost = withSnapshot({ dropped: 'Opus 2', researcher: null })
      expect(words(lost)).toContain('Opus 2 is no longer one of your team&#x27;s researchers, so no researcher is picked. Pick one below.')
      // Nobody stands in for the one he lost: none is selected, and Research now waits for his pick.
      expect(lost).not.toContain('aria-checked="true"')
      expect(lost).toContain('<button type="button" disabled="" title="Pick a researcher first">Research now</button>')
      expect(words(lost)).toContain('Pick who researches.')
      expect(words(page)).not.toContain('no longer one of your team')
    })

    it('shows how the installed Codex stands for the fence test, read-only, with Test again only after a failure or a stop (AC2; Story 75.8)', () => {
      expect(words(page)).toContain('Codex fence test')
      expect(words(page)).toContain(`Fence test passed ${shortDate('2026-10-09T20:00:00.000Z')} on 0.161.0`)
      expect(page).not.toMatch(/Run again|Run test|aria-label="Test the [A-Za-z]+ fence again"/)
      expect(fenceWords(RESEARCH.researchers.filter((entry) => entry.harness === 'codex'))).toEqual(['BMN runs it by itself when Codex or a researcher\'s model changes, against a stand-in with made-up files.',
        'No provider is called and none of your files is read.'])
      expect(fenceResultWords(undefined, shortDate)).toBe('Not tested yet')
      expect(fenceResultWords({ harness: 'opencode', verdict: 'inconclusive', version: null, at: '2026-10-09T20:00:00.000Z' }, shortDate)).toBe(`Fence test showed nothing ${shortDate('2026-10-09T20:00:00.000Z')}`)
      const closed: ResearchSnapshot['researchers'] = RESEARCH.researchers.map((entry) => (entry.harness === 'codex'
        ? { id: entry.id, name: entry.name, harness: entry.harness, ok: false, why: 'the fence test has not run for this version of Codex yet', reason: 'synthetic' } : entry))
      const untested = withSnapshot({ researchers: closed })
      expect(untested).not.toContain('Test again')
      expect(words(untested)).toContain('Sol and Luna research only where this test passed for exactly the installed Codex: the fence test has not run for this version of Codex yet.')
      // A failure on the installed version, or a stop after BMN's tries, offers Test again on that app's row.
      const failed = withSnapshot({ researchers: RESEARCH.researchers.map((entry) => (entry.harness === 'codex'
        ? { id: entry.id, name: entry.name, harness: entry.harness, ok: false, why: 'the fence test of codex 0.161.0 with gpt-6-luna did not pass, so no research runs there: pick another researcher', reason: 'synthetic' } : entry)) })
      expect(failed).toContain('<button type="button" class="small" aria-label="Test the Codex fence again">Test again</button>')
      const stopped = withSnapshot({ autoTests: { running: null, stopped: [{ kind: 'fence', harness: 'opencode', version: '2.0.29', tries: 3, at: '2026-10-09T20:00:00.000Z' }] } })
      expect(words(stopped)).toContain('BMN stopped after 3 tries on 2.0.29')
      expect(stopped).toContain('aria-label="Test the OpenCode fence again"')
      // An OpenCode researcher gets a row of its own, from the same test (70.3); without one there is no row.
      expect(words(page)).toContain('OpenCode fence test')
      expect(words(page).replace(/\s+/g, ' ')).toContain('Kimi researches only where this test passed for exactly the installed OpenCode: the fence test has not run for this version of OpenCode yet. BMN runs it by itself when OpenCode')
      expect(words(withSnapshot({ researchers: RESEARCH.researchers.filter((entry) => entry.harness !== 'opencode') }))).not.toContain('OpenCode fence test')
      // Agents held back for one reason share one line (Fable's review of 80.5).
      expect(words(untested)).toContain('Sol and Luna cannot research: the fence test has not run for this version of Codex yet.')
      expect(offered(untested)).toEqual(['Rook Fable:true'])
      expect(words(withSnapshot({ researchers: closed, fenceTest: { running: true, ended: null, last: [] } }))).toContain('Testing…')
    })

    it('an agent\'s own page says what its Researcher switch means as the team stands', () => {
      const luna = DATA.agents.find((entry) => entry.id === 'luna')!
      expect(researcherWords(DATA, luna)).toEqual(['No researcher is named yet, so Models offers every agent that can research.', 'Switching this on makes Luna the only one until you name others; Models proposes whom.'])
      const named = nameResearchers(DATA, ['sol'])
      expect(researcherWords(named, named.agents.find((entry) => entry.id === 'sol')!)).toEqual(['Offered on Models as a researcher, where its app can research.'])
      expect(researcherWords(named, luna)).toEqual(['Not offered on Models: a research with Luna is refused.'])
      const own = pageMarkup({ name: 'agent', id: 'sol' }, team({ base: named, data: named, approved: named }))
      expect(own).toMatch(/<span id="[^"]+">Researcher<\/span>/)
      expect(own).toMatch(/class="switch on" role="switch" aria-checked="true" aria-labelledby="[^"]+"/)
    })
  })

  it('lists what is new, the team as found and what was found earlier, each value with its site (AC3, AC4)', () => {
    expect(lines(page)).toEqual(['model-next', 'model-far', 'model-sol', 'model-fable', 'model-luna', 'model-haiku', 'model-glm', 'model-old'])
    expect(page).toContain(`<h4 class="group-head">New since ${dayWords('2026-10-03T09:00:00.000Z')}<span class="caption">first seen by the research on ${dayWords('2026-10-10T09:40:00.000Z')}</span></h4>`)
    expect(page).toContain('<h4 class="group-head">Your team<span class="caption">as the research found them</span></h4>')
    expect(page).toContain('<summary>Found earlier · 1 model</summary>')
    expect(page).toContain('<span class="mono value">$15.00 / $75.00</span><span class="faint">per M tokens, in / out</span><span class="mono source" title="https://www.anthropic.example.test/pricing" aria-label="anthropic.example.test, price source for model-next">anthropic.example.test</span>')
    // A value BMN could not confirm says so right after it, in plain weight, with the reason on hover.
    expect(page).toContain('<span class="mono value">$0.60 / $2.50</span><span title="BMN could not confirm this on the cited page: the page does not name this model.">unverified</span><span class="faint">per M tokens, in / out</span><span class="mono source" title="https://blog.example.test/prices"')
    expect(page).toContain('<span class="mono value">400 000 tokens</span><span class="faint">capacity</span>')
    // The last research and the one before it were a week apart, so the head names both days; on one day it says it once.
    expect(modelsMarkup(research({ snapshot: { ...RESEARCH, previousAt: '2026-10-10T08:00:00.000Z' } }))).toContain('<h4 class="group-head">New in this research</h4>')
    expect(page).toContain('<button type="button" class="small" aria-label="Add model-next to team">Add to team…</button>')
    // The team: a differing price says what the team has; a model this research missed says when it was last seen.
    expect(page).toContain('<span class="faint">· your team has $1.25 / $10.00</span>')
    expect(page).toContain('<span class="needs-dot" role="img" aria-label="Price differs from your team&#x27;s" title="Price differs from your team&#x27;s"></span>')
    expect(page).toContain(`<div class="faint">Not found this time · last seen ${dayWords('2026-10-03T09:00:00.000Z')}</div>`)
    expect(page).toContain('<div class="faint">Not found yet</div>')
    expect(page).not.toContain('BMN does not check that an app takes a name found here')
    expect(page).toContain('<span class="mono">model-fable</span> <span class="faint">Fable · Anthropic</span>')
  })

  it('offers Apply prices only for verified prices that differ, and reviews them with each page before staging (AC5)', () => {
    expect(page).toMatch(/<div class="page-note with-action" role="status"><span class="needs-dot"[^>]*><\/span><span class="note-text">2 prices differ from your team&#x27;s\.<\/span><button type="button" class="small">Apply prices…<\/button><\/div>/)
    const same = { ...DATA, agents: DATA.agents.map((entry) => (entry.id === 'sol' ? { ...entry, price: { input: 2, output: 8 } } : entry.id === 'fable' ? { ...entry, price: { input: 20, output: 100 } } : entry)) }
    expect(modelsMarkup(research(), team({ data: same }))).not.toContain('Apply prices…')
    const one = { ...DATA, agents: DATA.agents.map((entry) => (entry.id === 'fable' ? { ...entry, price: { input: 20, output: 100 } } : entry)) }
    expect(modelsMarkup(research(), team({ data: one }))).toContain('<span class="note-text">One price differs from your team&#x27;s.</span>')
  })

  it('shows a run that is going with how far it is and Stop, and keeps the researcher fixed meanwhile (AC2)', () => {
    const running = modelsMarkup(research({ snapshot: { ...RESEARCH, running: { researcher: 'luna', done: 3, total: 9, lookup: false } } }))
    expect(running).toContain('<span class="faint">Luna is researching · 3 of 9 models</span>')
    expect(running).toContain('<button type="button">Stop</button>')
    expect(running).not.toContain('Research now')
    expect(count(running, 'role="radio"')).toBe(3)
    expect([...running.matchAll(/role="radio"[^>]*disabled=""/g)]).toHaveLength(3)
    // A run that kept nothing says how it ended; one that kept something shows in the head and in one line under it.
    const nothing = modelsMarkup(research({ notice: { ok: true, text: 'Stopped before it finished. Nothing was kept.' } }))
    expect(nothing).toContain('<p class="preferences-success" role="status">Stopped before it finished. Nothing was kept.</p>')
    const partial = modelsMarkup(research({ snapshot: { ...RESEARCH, last: { ...RESEARCH.last!, state: 'partial', note: 'Stopped before it finished.' } } }))
    expect(partial).toContain('· 6 models · not finished</span>')
    expect(count(partial, 'Stopped before it finished.')).toBe(1)
    expect(words(partial)).toContain('The last research did not finish: Stopped before it finished.')
  })

  it('says plainly when no agent can research, and what the page shows before any research', () => {
    const none = modelsMarkup(research({ snapshot: { ...RESEARCH, last: null, previousAt: null, models: [], researcher: null, researchers: RESEARCH.researchers.filter((entry) => !entry.ok) } }))
    expect(none).toContain('<span class="faint">Not researched yet</span>')
    expect(none).toContain('<span class="muted">No agent on your team can research.</span>')
    expect(words(none).replace(/\s+/g, ' ')).toContain('Research needs one of the researchers your team names: an active agent on Claude Code, or on Codex or OpenCode where its fence test passed, whose provider may see private work. A price can still be written in the team file.')
    expect(noResearcherWords(null)).toBe('Research needs an active agent on Claude Code, or on Codex or OpenCode where its fence test passed, whose provider may see private work.')
    expect(none).toContain('<button type="button" disabled="" title="No agent on your team can research">Research now</button>')
    expect(none).not.toContain('role="radio"')
    expect(lines(none)).toEqual(['model-sol', 'model-fable', 'model-luna', 'model-haiku', 'model-glm'])
    // The head says it once; the lines carry only their names.
    expect(count(none, 'Not researched yet')).toBe(1)
    expect(none).not.toContain('Not found yet')
    expect(modelsMarkup(research({ snapshot: null }))).toContain('Reading what research found…')
    expect(modelsMarkup(research({ loadError: 'Could not read what research found' }))).toContain('<p class="preferences-error" role="alert">Could not read what research found</p>')
  })

  it('a first research heads its finds as not on the team, since nothing came before it', () => {
    expect(modelsMarkup(research({ snapshot: { ...RESEARCH, previousAt: null } }))).toContain('<h4 class="group-head">Not on your team<span class="caption">first seen by the research on')
  })

  it('New agent opens filled from a find, says so once with Undo, and offers Look up (AC6)', () => {
    const fill = fillFrom(RESEARCH.models[3]!, DATA)
    const markup = renderToStaticMarkup(createElement(TeamPreferences, { team: team(), page: { name: 'new', fill }, research: research(), go: noop }))
    expect(markup).toMatch(/<div class="page-note with-action" role="status"><span class="note-text">Name and price from research on [^<]+\. Check Agent app and Host\.<\/span><button type="button" class="small">Undo<\/button><\/div>/)
    expect(markup).toMatch(/aria-label="Model"[^>]* value="model-next"/)
    expect(markup).toContain('<span class="mono">$15.00 / $75.00</span><span class="faint"> per M tokens, in / out</span>')
    expect(words(markup)).toContain(`Read on www.anthropic.example.test, ${dayWords('2026-10-10')}`)
    expect(markup).toContain('aria-live="polite">Found in research on ' + dayWords('2026-10-10T09:40:00.000Z') + '. BMN does not check that Claude Code takes this name.</p>')
    expect(markup).toMatch(/<button type="button" class="small" aria-label="Look up this model" title="Asks your researcher for this model&#x27;s published price and capacity">Look up<\/button>/)
    // Without a researcher, or without a name, Look up is off and says why.
    const blank = renderToStaticMarkup(createElement(TeamPreferences, { team: team(), page: { name: 'new' }, research: research({ snapshot: { ...RESEARCH, researcher: null } }), go: noop }))
    expect(blank).toMatch(/<button type="button" class="small" disabled="" aria-label="Look up this model" title="No agent on your team can research">Look up<\/button>/)
    expect(blank).not.toContain('from research on')
    // The class is never taken from research: a find carries none.
    expect(Object.keys(fill).sort()).toEqual(['day', 'harness', 'model', 'price'])
  })

  it('offers the researched names to the Model field with the day of the last research', () => {
    expect(researchedModels(null)).toBeUndefined()
    expect(researchedModels({ ...RESEARCH, models: [] })).toBeUndefined()
    expect(researchedModels(RESEARCH)).toEqual({ models: RESEARCH.models, day: dayWords('2026-10-10T09:40:00.000Z') })
    expect(researchedModels({ ...RESEARCH, last: null })!.day).toBeNull()
  })
})

describe('read-only roles on Team and Health (63.2 AC4)', () => {
  /** The team of these tests with two reviewer roles and a consultant, none held yet. */
  const REVIEWED: RosterDataShape = {
    ...DATA,
    roles: [
      ...DATA.roles,
      { id: 'epic-reviewer', candidates: ['sol@xhigh'], then: 'blocked' },
      { id: 'focused-reviewer', candidates: ['luna@max'], then: 'lead' },
      { id: 'consultant', candidates: ['sol@xhigh'], then: 'blocked' }
    ]
  }
  const roles = (data: RosterDataShape): string => pageMarkup({ name: 'roles' }, team({ data, snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, data } } }))

  it('proposes the reviewers and the consultant while no role is held, by the same rule as the command line', () => {
    const ids = ['lead', 'designer', 'helper', 'browser', 'epic-reviewer', 'pre-reviewer', 'reviewer', 'consultant', 'consultants', 'reviewers']
    expect(ids.map(readOnlyProposed)).toEqual(ids.map(cliProposed))
    expect(ids.filter(readOnlyProposed)).toEqual(['epic-reviewer', 'pre-reviewer', 'reviewer', 'consultant'])
    expect(readOnlyProposal(DATA)).toEqual([])
    expect(readOnlyProposal(REVIEWED)).toEqual(['epic-reviewer', 'focused-reviewer', 'consultant'])
    expect(listedRoles(['epic-reviewer', 'focused-reviewer', 'consultant'])).toBe('Epic reviewer, Focused reviewer and Consultant')
    // Roles says where the proposal is; the one card on Team takes it with the others (Story 75.10).
    const page = words(roles(REVIEWED)).replace(/\s+/g, ' ')
    expect(page).toContain('No role is held to read-only yet; BMN&#x27;s proposal is on Team.')
    expect(page).not.toContain('Use proposal')
    expect(teamProposals(REVIEWED, { lunaListed: false, researchers: null })?.clauses).toContain('Epic reviewer, Focused reviewer and Consultant held to read-only')
    expect(roles(REVIEWED)).not.toContain('class="role-mark"')
    // A team without such roles is offered nothing.
    expect(roles(DATA)).not.toContain('BMN&#x27;s proposal is on Team')
    expect(teamProposals(DATA, { lunaListed: false, researchers: null })?.clauses ?? []).not.toContain('held to read-only')
  })

  it('takes the proposal as a staged change, marks each held role, and leaves the choice to the owner from then on', () => {
    const taken = holdProposed(REVIEWED)
    expect(taken.roles.filter((role) => role.read_only === true).map((role) => role.id)).toEqual(['epic-reviewer', 'focused-reviewer', 'consultant'])
    expect(taken.roles.find((role) => role.id === 'lead')).not.toHaveProperty('read_only')
    const page = roles(taken)
    expect(page.split('class="role-mark"')).toHaveLength(4)
    expect(page).toContain('<b>Epic reviewer</b><span class="role-mark" title="A run for this role is refused unless it is started so that it cannot write.">Read-only</span>')
    expect(page).not.toContain('Use proposal')
    // One role let write again: no mark is left in the data, and BMN does not propose it back while another is held.
    const freed = setRoleReadOnly(taken, 'consultant', false)
    expect(freed.roles.find((role) => role.id === 'consultant')).toEqual({ id: 'consultant', candidates: ['sol@xhigh'], then: 'blocked' })
    expect(readOnlyProposal(freed)).toEqual([])
    expect(setRoleReadOnly(DATA, 'helper', true).roles.find((role) => role.id === 'helper')).toMatchObject({ read_only: true })
  })

  it('words the change and what it means for the review', () => {
    const ids = new Set(['epic-reviewer', 'lead'])
    expect(consequenceWords('epic-reviewer runs would be refused unless they are started so that they cannot write', ids)).toBe('Epic reviewer runs would be refused unless they are started so that they cannot write')
    expect(consequenceWords('epic-reviewer runs could be started with write access again', ids)).toBe('Epic reviewer runs could be started with write access again')
    expect([formatValue({ present: true, value: true }, 'read_only'), formatValue({ present: true, value: false }, 'read_only')]).toEqual(['yes', 'no'])
    const diff: RosterDiffShape = { scope: 'roles', id: 'epic-reviewer', field: 'read_only', kind: 'changed', before: { present: false }, after: { present: true, value: true } }
    const { groups } = groupDifferences([diff], holdProposed(REVIEWED), REVIEWED, ['epic-reviewer runs would be refused unless they are started so that they cannot write'])
    expect(groups.map((group) => [group.key, group.lines.map((line) => `${line.field}: ${line.before} → ${line.after}`), group.consequences]))
      .toEqual([['roles', ['Epic reviewer · read-only: — → yes'], ['Epic reviewer runs would be refused unless they are started so that they cannot write']]])
  })

  it('says on Health that no role is held yet, and nothing once one is or where BMN proposes none', () => {
    expect(notHeldWords(null)).toBeNull()
    expect(notHeldWords({ held: [], proposed: [] })).toBeNull()
    expect(notHeldWords({ held: ['consultant'], proposed: ['epic-reviewer'] })).toBeNull()
    const said = "No role is held to read-only yet, so a reviewer with write access passes. Agents › Team proposes it for Epic reviewer and Consultant."
    expect(notHeldWords({ held: [], proposed: ['epic-reviewer', 'consultant'] })).toBe(said)
    expect(words(rulesMarkup('health', rules({ snapshot: { ...RULES, readOnlyRoles: { held: [], proposed: ['epic-reviewer', 'consultant'] } } })))).toContain(said.replace("'", '&#x27;'))
    expect(words(rulesMarkup('health'))).not.toContain('held to read-only')
  })
})
