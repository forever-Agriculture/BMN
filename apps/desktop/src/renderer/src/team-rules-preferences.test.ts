// MODULE: team-rules-preferences.test.ts - Epic 60.5/60.6 markup: shape and plain words carry meaning, every control is named, no schema word reaches the owner
import type { AgentsPreview, AgentsSnapshot, ResearchModelView, ResearchSnapshot, RosterAgentShape, RosterDataShape, RosterDiffShape, RulesSnapshot, SkillsPlan } from '@bmn/protocol'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  INSERTS,
  RulesEditor,
  RulesPreferences,
  UpdateSheet,
  changeWords,
  contextStateWords,
  contextValueWords,
  destinationWords,
  forgetUpdateWatches,
  diffSummary,
  earlierVersions,
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
  Chain, TeamLedger, TeamPreferences, TeamToast, compactHint, compactRefusal, contextLimitHint, firstApprovalWords, hostKind, limitRefusal, nothingInEffectWords, outsideCountWords, shortDate,
  type TeamPage
} from './team-preferences'
import { ModelList } from './model-field'
import { researcherHint, researchedModels, type ResearchState } from './models-preferences'
import { dayWords, fillFrom } from './research-view'
import { modelSuggestions } from './model-suggestions'
import { changeModel, groupDifferences, removeException, setSkillPublic, skillMark, toggleSkillApp } from './roster-staging'
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
    { harness: 'cursor', provider: 'zai', basis: 'owner-declared' }
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
  requestApproval: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, rulesUndo: null, confirmRulesUndo: later, cancelRulesUndo: noop, ...extra
})
const pageMarkup = (page: TeamPage, state: TeamState = team()): string => renderToStaticMarkup(createElement(TeamPreferences, { team: state, page, go: noop }))
const ledgerMarkup = (state: TeamState): string => renderToStaticMarkup(createElement(TeamLedger, { team: state }))
const toastMarkup = (state: TeamState): string => renderToStaticMarkup(createElement(TeamToast, { team: state }))
const count = (markup: string, text: string): number => markup.split(text).length - 1
/** What the owner reads: the markup without tags, attributes left out. */
const words = (markup: string): string => markup.replace(/<[^>]+>/g, ' ')

/** Words of the schema and of the earlier design that no page may show (R60-NFR8). */
const SCHEMA_WORDS = /\b(route|routes|packet|seal|generation|generations|trust|harness|roster|High|Low)\b/

describe('Team › Agents (60.5 AC2)', () => {
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
    expect(words(changed)).toContain('The team file was edited directly, not on these pages: by hand, by a script or by an agent. The approved team stays in effect until you keep the change.')
    expect(changed).not.toContain('Keep all')
  })

  it('several changes in the team file can be kept or put back together, and keeping all opens the sheet first', () => {
    const asked: Array<{ request: unknown; words: { title: string; action: string }; always: boolean | undefined }> = []
    const group = (index: number) => ({ key: ['luna', 'fable', 'harness-routes'][index] as string, subject: ['Luna', 'Fable', 'Agent apps'][index] as string, lines: [{ field: 'Host', before: 'none', after: 'Provider default' }], consequences: [] })
    const state = team({ outside: { groups: [group(0), group(1), group(2)], general: [] }, requestApproval: async (request, title, always) => { asked.push({ request, words: title, always }) } })
    const markup = pageMarkup({ name: 'agents' }, state)
    expect(words(markup)).toContain('The approved team stays in effect until you keep them.')
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
      ['Name', 'Class', 'Notes', 'Agent app', 'Model', 'Private work', 'Price', 'Context limit', 'Roles', 'Efforts', 'Paid by', 'Compact at', 'Host', 'Also called', 'Team file'])
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
      ['Knight: leads an epic/project', 'Queen: does what she wants, in any role', 'Rook: the Artist: designs what is not there yet', 'Bishop: reviews and advises', 'Pawn: does jobs a lead hands off'])
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

describe('Team › Roles and Changes (60.5 AC5, AC6)', () => {
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
    expect(markup).toContain('The team file is a link to ~/dotfiles/roster.md . A change saved from these pages replaces the link with a regular file here; the file it points to stays as it is.')
    expect(pageMarkup({ name: 'agents' })).not.toContain('is a link to')
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
        preview: { ...preview, teamUpdate: [{ harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', kind: 'full', diff: '-old\n+new', binding: 'b' }, { harness: 'cursor', path: '/home/synthetic/.cursor/rules/bmn-global-rules.mdc', kind: 'public', diff: '', binding: 'c' }] }
      }
    }))
    expect(markup).toContain('role="group" aria-label="Approve these changes"')
    expect(markup).toContain('<div class="consequence">Also updates the Team line in 2 rules files</div>')
    const path = (file: string): string => `<span class="target-path"><span class="path mono" title="/home/synthetic/${file}">~/${file}</span></span>`
    expect(markup).toContain(`<span>Claude Code</span> ${path('.claude/CLAUDE.md')} <span class="faint">Full rules</span>`)
    expect(markup).toContain(`<span>Cursor</span> ${path('.cursor/rules/bmn-global-rules.mdc')} <span class="faint">Public sections only</span>`)
    expect(markup).toContain('<pre class="diff">-old\n+new</pre>')
    expect([...markup.matchAll(/>([A-Za-z]+)<\/button>/g)].map((match) => match[1])).toEqual(['Approve', 'Cancel'])
  })

  it('says what an approval did to the rules files and offers Undo', () => {
    expect(rulesUpdateWords({ transaction: 't', written: ['claude', 'codex'], skipped: [] })).toBe('Rules updated in 2 apps')
    expect(rulesUpdateWords({ transaction: 't', written: ['claude'], skipped: ['codex'] })).toBe('Rules updated in 1 app · 1 changed meanwhile and waits for Install')
    expect(rulesUpdateWords({ transaction: null, written: [], skipped: ['claude', 'codex'], failed: 'disk full' })).toBe('No rules file was updated · 2 changed meanwhile and wait for Install · stopped: disk full')
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
    { harness: 'cursor', text: 'PUBLIC TEXT', bytes: 100, kind: 'public', reason: "BMN can't confirm where Cursor sends data", teamForm: 'names by app' }
  ],
  health: {
    state: 'checked', checkedAt: '2026-10-09T22:13:00.000Z', ok: false,
    targets: [
      { harness: 'claude', path: '/home/synthetic/.claude/CLAUDE.md', state: 'current', kind: 'full', reason: '' },
      { harness: 'codex', path: '/home/synthetic/.codex/AGENTS.md', state: 'stale', kind: 'full', reason: '' },
      { harness: 'cursor', path: '/home/synthetic/.cursor/rules/bmn-global-rules.mdc', state: 'missing', kind: 'public', reason: "BMN can't confirm where Cursor sends data" }
    ]
  },
  probes: [{ harness: 'claude', outcome: 'pass', at: '2026-10-09T20:00:00.000Z', stale: true }, { harness: 'codex', outcome: null }],
  apps: [
    { harness: 'claude', version: '2.1.295', program: '/home/synthetic/.local/bin/claude', programTarget: '/home/synthetic/.local/share/claude/versions/2.1.295', basis: 'default', provider: 'anthropic', host: null, sources: [], versionState: 'tested', versionNote: 'BMN tested how this version picks where to send data.' },
    { harness: 'codex', version: '0.171.0', program: '/home/synthetic/.npm-global/bin/codex', basis: 'default', provider: 'openai', host: null, sources: [], versionState: 'newer', versionNote: 'Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.' },
    { harness: 'cursor', version: null, program: null, basis: 'unknown', provider: null, host: null, sources: [], versionState: 'unknown', versionNote: 'BMN does not check Cursor dispatches.' }
  ],
  context: [
    { harness: 'codex', path: '/home/synthetic/.codex/config.toml', exists: true, limit: 380000, compact: 342000, version: '0.171.0', limitProven: false, compactProven: false,
      test: { at: '2026-10-09T20:00:00.000Z', version: '0.161.0', outcome: 'pass', detail: 'asked for 123000; the session record shows 116850' }, agents: ['Sol', 'Astra', 'Luna'] },
    { harness: 'claude', path: '/home/synthetic/.claude/settings.json', exists: true, limit: null, compact: null, version: '2.1.295', limitProven: true, compactProven: false, min: 100000, max: 1000000,
      test: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'asked for 137000; Claude Code reports a window of 137000' }, agents: ['Opus', 'Fable'] }
  ],
  skills: {
    source: { path: '/home/synthetic/.claude/skills', readable: true }, markedMissing: [], pending: 1, exposed: 1,
    skills: [
      { name: 'alpha', description: 'First synthetic skill.', readable: true, states: { claude: 'read-directly', codex: 'current', opencode: 'exposed' } },
      { name: 'beta', description: 'Second synthetic skill.', readable: true, states: { claude: 'read-directly', codex: 'missing', opencode: 'read-directly' } },
      { name: 'Bad_Name', description: '', readable: false, detail: 'the name must be lowercase letters, digits and hyphens', states: {} }
    ],
    apps: [
      { harness: 'claude', version: '2.1.295', supported: true, testable: true, location: null, format: null, readsSource: true, kind: 'full', kindReason: '', state: 'Reads the source',
        test: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'Claude Code reads skills from ~/.claude/skills' },
        loading: { at: '2026-10-09T20:00:00.000Z', version: '2.1.295', outcome: 'pass', detail: 'Claude Code named a test skill', stale: true } },
      { harness: 'codex', version: '0.171.0', supported: true, testable: true, location: '/home/synthetic/.agents/skills', format: 'link', readsSource: false, kind: 'full', kindReason: '', state: 'Missing',
        test: { at: '2026-10-09T20:00:00.000Z', version: '0.171.0', outcome: 'pass', detail: 'Codex reads skills from ~/.agents/skills' }, loading: null },
      { harness: 'opencode', version: '1.18.32', supported: true, testable: true, location: null, format: null, readsSource: true, kind: 'public', kindReason: 'OpenCode Go gets public work only', state: 'Exposed',
        test: { at: '2026-10-09T20:00:00.000Z', version: '1.18.32', outcome: 'pass', detail: 'OpenCode reads skills from ~/.claude/skills' }, loading: null },
      { harness: 'cursor', version: '2026.09.26', supported: false, reason: 'no test has run on Cursor 2026.09.26', testable: false, location: null, format: null, readsSource: false, kind: 'public', kindReason: '', state: 'Not supported yet', test: null, loading: null }
    ]
  },
  transactions: [
    { id: 't3', createdAt: '2026-10-09T23:00:00.000Z', state: 'complete', reason: 'skills install', targets: ['codex'], valid: true },
    { id: 't2', createdAt: '2026-10-09T22:00:00.000Z', state: 'complete', reason: 'team update', targets: ['claude'], valid: true },
    { id: 't1', createdAt: '2026-10-08T14:02:00.000Z', state: 'complete', reason: 'install', targets: ['claude', 'codex'], valid: true },
    { id: 't0', valid: false }
  ],
  history: [{ revision: 1, at: '2026-10-08T13:58:00.000Z', hash: 'h', bytes: 290, reason: 'saved', intact: true }, { revision: 2, at: '2026-10-09T09:00:00.000Z', hash: 'i', bytes: 2000, reason: 'saved', intact: false }]
}

const rules = (extra: Partial<RulesState> = {}): RulesState => ({
  snapshot: RULES, loadError: null, draft: RULES.master.text ?? '', dirty: false, draftPlan: null, busy: false, notice: null, pending: null, setDraft: noop, setNotice: noop,
  ensure: noop, refresh: noop, load: later, beginSave: later, beginInstall: later, beginSkillsInstall: later, beginUndo: later, beginRestore: later, beginTest: noop, confirm: later, cancel: noop, run: async () => true, ...extra
})
const rulesMarkup = (page: 'editor' | 'skills' | 'health', state: RulesState = rules(), teamState: TeamState = team()): string =>
  renderToStaticMarkup(createElement(RulesPreferences, { rules: state, team: teamState, page }))

describe('Rules › Editor (60.6 AC1–AC3)', () => {
  const markup = rulesMarkup('editor')

  it('says a linked rules file would be replaced by a regular file, on the sheet that saves it', () => {
    const plan = { valid: true, errors: [], diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', expectedHash: 'a'.repeat(64), expectedLink: '/home/synthetic/dotfiles/global-rules.md', expectedDirectory: '/home/synthetic/.config/bmn/agents', renderings: [] }
    const linked = words(rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan } }))).replace(/\s+/g, ' ')
    expect(linked).toContain('The rules file is a link to ~/dotfiles/global-rules.md . This replaces the link with a regular file here; the file it points to stays as it is.')
    expect(rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: { ...plan, expectedLink: null } } }))).not.toContain('is a link to')
  })

  it('offers Save and install… beside Save, only for rules that can be saved, and says that neither installs unseen', () => {
    const plan = { valid: true, errors: [], diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', expectedHash: 'a'.repeat(64), expectedLink: null, expectedDirectory: '/home/synthetic/.config/bmn/agents', renderings: [] }
    const sheet = rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan } }))
    expect(sheet).toContain('<button type="button" class="primary">Save</button><button type="button">Save and install…</button><button type="button">Cancel</button>')
    // The two buttons say what each does; the note keeps only what they do not.
    expect(sheet).toContain('<span class="muted">The text before this save is kept under Earlier versions.</span>')
    // Rules an app could not read are not saved, so there is nothing to install either.
    const refused = rulesMarkup('editor', rules({ pending: { kind: 'save', text: 'new', plan: { ...plan, valid: false, errors: [{ code: 'RULES_MARKER', message: 'A public section is not closed.' }] } } }))
    expect(refused).toContain('These rules cannot be saved')
    expect(refused).not.toContain('Save and install…')
    // While a save is being written neither button can be pressed again.
    expect(rulesMarkup('editor', rules({ busy: true, pending: { kind: 'save', text: 'new', plan } }))).toContain('<button type="button" class="primary" disabled="">Working…</button><button type="button" disabled="">Save and install…</button>')
  })

  it('heads the page with the save and install dates and, since an app differs, the dot, the count and Install…', () => {
    expect(markup).toContain(`<span class="faint">Saved ${shortDate('2026-10-09T21:50:00.000Z')} · last installed ${shortDate('2026-10-08T14:02:00.000Z')}</span>`)
    expect(markup).toContain('<span class="muted">2 apps differ</span><button type="button" class="primary">Install…</button>')
    const current = rulesMarkup('editor', rules({ snapshot: { ...RULES, health: { state: 'checked', checkedAt: RULES.health.checkedAt, ok: true, targets: [] } } }))
    expect(current).not.toContain('Install…')
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

  it('lists installs with Undo install… and saves with Restore…, newest first', () => {
    expect(earlierVersions(RULES).map((entry) => `${entry.title} | ${entry.detail} | ${entry.usable}`)).toEqual([
      'Team line updated | Claude Code | true',
      'A saved version that cannot be read | 2.0 KB | false',
      'Installed | Claude Code, Codex | true',
      'Saved | 290 B | true',
      'An install that cannot be read |  | false'
    ])
    expect(count(markup, '>Undo install…</button>')).toBe(3)
    expect(count(markup, '>Restore…</button>')).toBe(2)
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

describe('Rules › Health (60.6 AC4)', () => {
  const markup = rulesMarkup('health')

  it('shows one row per rules file: path, state in words, the kind of rules and the last loading test', () => {
    expect(markup).toContain(`<span class="faint">Checked ${shortDate('2026-10-09T22:13:00.000Z')} · 1 skill entry to install · 1 skill exposed</span>`)
    // With the skills in order, the header says only when Health was read.
    expect(rulesMarkup('health', rules({ snapshot: { ...RULES, skills: { ...RULES.skills, pending: 0, exposed: 0 } } }))).toContain(`<span class="faint">Checked ${shortDate('2026-10-09T22:13:00.000Z')}</span>`)
    expect(markup).toContain('>Check now</button>')
    expect(markup).toMatch(/data-state="current"><span>Claude Code<\/span><span class="path mono" title="\/home\/synthetic\/.claude\/CLAUDE.md">~\/.claude\/CLAUDE.md<\/span><span class="health-state"><span>Current <span class="muted">· Full rules<\/span>/)
    expect(markup).toContain(`<span class="faint">Test passed ${shortDate('2026-10-09T20:00:00.000Z')} · stale</span>`)
    expect(markup).toMatch(/data-state="stale">.*?aria-label="Needs you".*?Differs from the rules <span class="muted">· Full rules<\/span><\/span><span class="faint">Never tested<\/span>/)
    expect(markup).toMatch(/data-state="missing">.*?Missing <span class="muted">· Public sections only<\/span><\/span><span class="faint">No loading test<\/span>/)
    expect(testLine(undefined)).toBe('Never tested')
  })

  it('offers Test… only where the app may receive private work, and says why not elsewhere', () => {
    expect([...markup.matchAll(/aria-label="Test ([A-Za-z ]+)"/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex'])
    expect(markup).toContain("A loading test starts the app once and sends it the rules. It is off for Cursor, which gets only the public sections.")
  })

  it('shows each agent app: version, whether it is tested, where it sends data and what is recorded', () => {
    expect(markup).toContain('<span class="mono">2.1.295</span> <span class="muted" title="BMN tested how this version picks where to send data.">· tested</span>')
    expect(markup).toContain('<span class="mono">0.171.0</span> <span class="muted" title="Newer than the version BMN tested (0.161.0). BMN reads where it sends data the same way on every version.">· newer than tested</span>')
    // An app that is not there is said once, not as "not found · not checked".
    expect(markup).toContain('<span class="health-state"><span class="mono" title="BMN does not check Cursor dispatches.">not found</span></span>')
    const unread = rulesMarkup('health', rules({ snapshot: { ...RULES, apps: RULES.apps.map((app) => (app.harness === 'codex' ? { ...app, version: null, versionState: 'unknown' as const, versionNote: 'Codex is not installed, or its version cannot be read.' } : app)) } }))
    expect(unread).toContain('<span class="mono" title="Codex is not installed, or its version cannot be read.">version not read</span><span class="path mono wrap" title="/home/synthetic/.npm-global/bin/codex">')
    expect(markup).toContain('<span>Sends data to Anthropic&#x27;s own servers</span><span class="faint">Recorded: Anthropic, as inspected</span>')
    expect(markup).toContain('<span>Where it sends data is unknown</span><span class="faint">Recorded: Z.ai, on your word</span>')
    expect(destinationWords({ basis: 'explicit', provider: null, host: 'proxy.example.com' }, (id) => id)).toBe('Sends data to a custom host, proxy.example.com')
  })

  it('offers no Accept step: every installed version is supported; a list kept from the earlier rule can only be removed', () => {
    expect(markup).not.toContain('Accept version')
    expect([...markup.matchAll(/aria-label="Set the destination of ([^"]+)"/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex', 'Cursor'])
    expect(markup).toContain('Accepted earlier, no longer needed')
    expect(markup).toContain('aria-label="Remove accepted version 0.170.0 of Codex"')
    expect(markup).toContain('Every installed version is supported')
  })
})

describe('Rules › Health: Update… (60.6: the app\'s own updater, shown before anything runs)', () => {
  const markup = rulesMarkup('health')
  const apps = RULES.apps
  const sheet = (index: number, extra: Partial<Parameters<typeof UpdateSheet>[0]> = {}): string =>
    renderToStaticMarkup(createElement(UpdateSheet, { app: apps[index]!, home: RULES.home, sessions: 0, hasTest: false, busy: false, result: null, onCopied: noop, onCheck: noop, onClose: noop, ...extra }))

  it('shows under each version the program BMN finds, and says when it finds none', () => {
    expect(markup).toContain('Agent apps<span class="caption">the program BMN finds, its version and where it sends data</span>')
    // The path wraps instead of being cut: its last part is the program's name.
    expect(markup).toContain('· tested</span></span><span class="path mono wrap" title="/home/synthetic/.local/bin/claude">~/.local/bin/claude</span></span>')
    expect(markup).toContain('· newer than tested</span></span><span class="path mono wrap" title="/home/synthetic/.npm-global/bin/codex">~/.npm-global/bin/codex</span></span>')
    expect(markup).not.toContain('Program not found')
  })

  it('offers Update… on every app, off where there is no program to update, and opens no sheet by itself', () => {
    expect([...markup.matchAll(/<button type="button" class="small"( disabled="")? (?:title="[^"]*" )?aria-label="Update ([^"]+)" aria-expanded="false"(?: title="([^"]*)")?>Update…<\/button>/g)].map((match) => [match[2], match[1] !== undefined, match[3]]))
      .toEqual([['Claude Code', false, undefined], ['Codex', false, undefined], ['Cursor', true, 'BMN finds no Cursor program to update']])
    expect(markup).not.toContain('own updater does this')
  })

  it('the command is the program by its full path and the app\'s own update word, quoted for a shell', () => {
    expect(updateCommand({ harness: 'claude', program: '/home/synthetic/.local/bin/claude' })).toBe('/home/synthetic/.local/bin/claude update')
    expect(updateCommand({ harness: 'codex', program: '/home/synthetic/.npm-global/bin/codex' })).toBe('/home/synthetic/.npm-global/bin/codex update')
    expect(updateCommand({ harness: 'opencode', program: '/usr/local/bin/opencode' })).toBe('/usr/local/bin/opencode upgrade')
    expect(updateCommand({ harness: 'cursor', program: "/home/synthetic/My Apps/it's/cursor-agent" })).toBe("'/home/synthetic/My Apps/it'\\''s/cursor-agent' update")
    expect(updateCommand({ harness: 'cursor', program: null })).toBeNull()
  })

  it('the sheet names the program, where a link leads, the exact command and what happens afterwards, and runs nothing', () => {
    const claude = sheet(0, { sessions: 2, hasTest: true })
    expect(claude).toContain('<div class="sheet" role="group" aria-label="Update Claude Code" tabindex="-1">')
    expect(claude).toContain('<b>Update Claude Code</b><span class="muted">Claude Code&#x27;s own updater does this, not BMN.</span>')
    const read = words(claude).replace(/\s+/g, ' ')
    expect(read).toContain('Installed 2.1.295 Program ~/.local/bin/claude A link to ~/.local/share/claude/versions/2.1.295 Command /home/synthetic/.local/bin/claude update')
    expect(read).toContain('Open in BMN BMN currently recognises 2 Claude Code sessions. Restart them to use the updated installation; their running versions are not checked.')
    expect(read).toContain('Afterwards Run the command in a terminal. When you come back to Health, BMN reads the version and where Claude Code sends data again. A loading test made before the update needs to be run again.')
    expect(read).toContain('The updater decides what it downloads and replaces, and may ask questions; BMN does not see that in advance and cannot undo it. BMN does not know whether a newer version exists.')
    expect([...claude.matchAll(/<button type="button"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Copy command', 'Check now', 'Close'])
    // Nothing on the sheet starts the updater: the only action on the command is a copy.
    expect(read).not.toMatch(/\bRun update\b|\bUpdate now\b|\bStart\b/)
    expect(claude).not.toContain('role="status"')
  })

  it('where a session can be opened, offers to type the command there and leaves the Enter to the owner', () => {
    const typed: string[][] = []
    const offered = sheet(1, { onType: (name, command) => { typed.push([name, command]) } })
    expect([...offered.matchAll(/<button type="button"( class="primary")?[^>]*>([^<]+)<\/button>/g)].map((match) => [match[2], match[1] !== undefined]))
      .toEqual([['Type in a new session', true], ['Copy command', false], ['Check now', false], ['Close', false]])
    expect(words(offered).replace(/\s+/g, ' ')).toContain('Afterwards BMN can type the command into a new session; you press Enter there to run it. Or run it in any terminal. When you come back to Health, BMN reads the version and where Codex sends data again.')
    // Rendering offers; nothing is typed until the press.
    expect(typed).toEqual([])
    // With no program there is nothing to type.
    expect(sheet(2, { onType: () => {} })).toContain('<button type="button" class="primary" disabled="">Type in a new session</button>')
    // Without a way to open a session the sheet is as before: the copy is the main action.
    expect(sheet(1)).not.toContain('Type in a new session')
    expect(sheet(1)).toContain('<button type="button" class="primary">Copy command</button>')
  })

  it('says for Codex which program is meant, since BMN\'s sessions start its own command of that name', () => {
    const codex = words(sheet(1)).replace(/\s+/g, ' ')
    expect(codex).toContain("In BMN's sessions, codex is BMN's own command; it hands over to this program, and this is the one updated.".replace(/'/g, '&#x27;'))
    expect(codex).not.toContain('A link to')
    expect(codex).not.toContain('A loading test made before the update')
    expect(words(sheet(0))).not.toContain('own command')
  })

  it('with no program found the command cannot be copied; a check that is running says so', () => {
    const cursor = sheet(2, { busy: true })
    expect(words(cursor).replace(/\s+/g, ' ')).toContain('Installed version not read Program not found Command no program found')
    expect(cursor).toContain('<button type="button" class="primary" disabled="">Copy command</button>')
    expect(cursor).toContain('<button type="button" disabled="">Checking…</button>')
  })

  it('counts only the sessions BMN recognises and never claims their versions', () => {
    expect(sessionsWords('Codex', 0)).toBe('BMN recognises no Codex session right now. A session it cannot recognise keeps running what it started with.')
    expect(sessionsWords('Codex', 1)).toBe('BMN currently recognises 1 Codex session. Restart it to use the updated installation; its running version is not checked.')
    expect(sessionsWords('Codex', 3)).toBe('BMN currently recognises 3 Codex sessions. Restart them to use the updated installation; their running versions are not checked.')
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

describe('Rules › Health: when the shell\'s settings could not be read', () => {
  it('says so above the apps, with the reason, and says nothing when they were read', () => {
    const page = rulesMarkup('health', rules({ snapshot: { ...RULES, ownEnvironment: 'bash did not answer in 5 seconds' } }))
    expect(words(page).replace(/\s+/g, ' ')).toContain('BMN could not read your shell&#x27;s settings (bash did not answer in 5 seconds), so it looked for the apps with its own. A session may find a program that BMN does not.')
    expect(page).toMatch(/<p class="page-note" role="status"><span[^>]*aria-label="Needs you"/)
    expect(rulesMarkup('health')).not.toContain('could not read your shell')
  })
})

describe('Rules › Health: what an app reports after its update command was copied', () => {
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
      rulesMarkup('editor'), rulesMarkup('health'),
      ...RULES.apps.map((app) => renderToStaticMarkup(createElement(UpdateSheet, { app, home: RULES.home, sessions: 2, hasTest: true, busy: false, result: 'The program still reports 1.0.0.', onCopied: noop, onCheck: noop, onClose: noop })))
    ]
    for (const page of pages) {
      // The file names the owner's own apps use are theirs, not BMN's words.
      const read = words(page).replace(/~\/[^\s<]+/g, ' ')
      expect(read.match(SCHEMA_WORDS)?.[0]).toBeUndefined()
    }
  })

  it('every control on the pages has an accessible name', () => {
    for (const page of [pageMarkup({ name: 'agents' }), pageMarkup({ name: 'agent', id: 'sol' }), pageMarkup({ name: 'new' }), pageMarkup({ name: 'roles' }), pageMarkup({ name: 'changes' }), rulesMarkup('editor'), rulesMarkup('health')]) {
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
    expect(markup).toMatch(/<span>Codex<\/span><span class="health-state"><span class="path mono" title="\/home\/synthetic\/.codex\/config.toml">~\/.codex\/config.toml<\/span><span class="faint">Shared by Sol, Astra and Luna<\/span><\/span><span class="health-state"><span>380 000 tokens · summarises at 342 000<\/span><span class="faint" title="[^"]*">Not supported yet · not tested on 0.171.0<\/span>/)
    expect(markup).toMatch(/<span class="faint">Shared by Opus and Fable<\/span><\/span><span class="health-state"><span>App default<\/span><span class="faint" title="[^"]*">Setting tested on 2.1.295<\/span>/)
  })

  it('offers Change… only where the test passed on the installed version', () => {
    expect(markup).toContain('disabled="" aria-label="Change the default context limit of Codex" title="Not supported yet: run the test for Codex first"')
    expect(markup).toMatch(/<button type="button" class="small" aria-label="Change the default context limit of Claude Code">Change…<\/button>/)
    expect([...markup.matchAll(/aria-label="Context test for ([A-Za-z ]+)"/g)].map((match) => match[1])).toEqual(['Codex', 'Claude Code'])
  })

  it('says in words what a row holds and why a setting is not supported yet', () => {
    expect(contextValueWords({ limit: null, compact: null })).toBe('App default')
    expect(contextValueWords({ limit: 272000, compact: null })).toBe('272 000 tokens')
    expect(contextValueWords({ limit: 272000, compact: null, unreadable: 'config.toml model_context_window is not a whole number' })).toBe("Can't be read")
    expect(contextStateWords({ limitProven: false, version: null, test: null })).toBe('Not supported yet · the app is not found')
    expect(contextStateWords({ limitProven: false, version: '0.162.0', test: { at: 'x', version: '0.162.0', outcome: 'fail', detail: 'd' } })).toBe('Not supported yet · the test failed on 0.162.0')
    expect(contextStateWords({ limitProven: false, version: '0.162.0', test: { at: 'x', version: '0.162.0', outcome: 'inconclusive', detail: 'd' } })).toBe('Not supported yet · the test was inconclusive on 0.162.0')
    expect(contextStateWords({ limitProven: false, version: '0.162.0', test: { at: 'x', version: '0.161.0', outcome: 'pass', detail: 'd' } })).toBe('Not supported yet · not tested on 0.162.0')
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
    expect(sol).toContain('Not supported yet on Codex 0.171.0: kept but not applied until its test passes in Rules › Health.')
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
    expect(page).toContain('<h3 class="page-title">Skills</h3><span class="faint">3 skills</span>')
    expect(page).toContain('<span class="faint mono" title="/home/synthetic/.claude/skills">~/.claude/skills</span>')
    expect(page).toContain('<b class="mono">alpha</b><span class="faint" title="First synthetic skill.">First synthetic skill.</span>')
    expect([...page.matchAll(/aria-label="alpha in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(['Claude Code: Reads it', 'Codex: Linked', 'OpenCode: Exposed', 'Cursor: Not yet'])
    expect([...page.matchAll(/aria-label="beta in ([A-Za-z ]+): ([^"]+)"/g)].map((match) => match[2])).toEqual(['Reads it', 'Missing', 'Reads it', 'Not yet'])
    expect(page).toContain('<span class="faint scope-word">All apps</span>')
    expect(page).toMatch(/role="switch" aria-checked="false" aria-label="alpha is public"/)
    // The exposed skill carries the attention mark on its chip, and the page says what to do about it.
    expect(page).toMatch(/aria-label="alpha in OpenCode: Exposed" title="OpenCode can see this skill but may not have it"><span class="needs-dot"[^>]*><\/span>OpenCode<span class="chip-state">Exposed<\/span>/)
    expect(words(page)).toContain('One skill can be seen by an app that may not have it. Mark the skill Public, or move it out of the skills folder.')
  })

  it('offers Install… with the count while entries are to install, and keeps a skill it cannot read out of reach', () => {
    expect(page).toMatch(/<span class="muted">1 to install<\/span><button type="button" class="primary">Install…<\/button>/)
    expect(rulesMarkup('skills', rules({ snapshot: { ...RULES, skills: { ...RULES.skills, pending: 0 } } }))).not.toContain('Install…</button>')
    expect(page).toContain('<b class="mono">Bad_Name</b><span class="faint">the name must be lowercase letters, digits and hyphens</span>')
    expect(page).toMatch(/aria-label="Bad_Name is public" disabled=""/)
  })

  it('shows a staged scope as chips, and stages Public and scope changes for approval', () => {
    const staged = { ...DATA, skills: [{ id: 'beta', public: true as const, only: ['codex' as const, 'opencode' as const] }] }
    const markup = rulesMarkup('skills', rules(), team({ data: staged, hasStaged: true }))
    expect(markup).toContain('<span class="faint scope-word">Only</span>')
    expect([...markup.matchAll(/aria-pressed="(true|false)" aria-label="beta in/g)].map((match) => match[1])).toEqual(['false', 'true', 'true', 'false'])
    expect(markup).toMatch(/aria-pressed="false" aria-label="beta in Claude Code: Off" title="Not for Claude Code"/)
    expect(markup).toMatch(/role="switch" aria-checked="true" aria-label="beta is public"/)
    expect(setSkillPublic(DATA, 'alpha', true).skills).toEqual([{ id: 'alpha', public: true }])
    expect(Object.keys(setSkillPublic(setSkillPublic(DATA, 'alpha', true), 'alpha', false))).not.toContain('skills')
    expect(toggleSkillApp(DATA, 'alpha', 'cursor').skills).toEqual([{ id: 'alpha', only: ['claude', 'codex', 'opencode'] }])
    expect(skillMark(toggleSkillApp(toggleSkillApp(DATA, 'alpha', 'cursor'), 'alpha', 'cursor'), 'alpha')).toEqual({ id: 'alpha' })
    const one = { ...DATA, skills: [{ id: 'alpha', only: ['codex' as const] }] }
    expect(toggleSkillApp(one, 'alpha', 'codex')).toBe(one)
    expect(rulesMarkup('skills', rules(), team({ data: one }))).toMatch(/aria-label="alpha in Codex: Linked" disabled="" title="A skill needs at least one app"/)
  })

  it('names in the approval which apps a change reaches', () => {
    const differences: RosterDiffShape[] = [
      { scope: 'skills', id: 'alpha', field: null, kind: 'added', after: { present: true, value: { public: true, only: ['codex', 'opencode'] } } },
      { scope: 'skills', id: '.source', field: 'folder', kind: 'changed', before: { present: true, value: '/a' }, after: { present: true, value: '/srv/skills' } }
    ]
    const { groups, general } = groupDifferences(differences, DATA, DATA, ['Skill alpha would reach OpenCode', 'Skill alpha would no longer reach Claude Code and Cursor', 'Skills would come from another folder'])
    expect(general).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'skills', subject: 'Skills', consequences: ['Skill alpha would reach OpenCode', 'Skill alpha would no longer reach Claude Code and Cursor', 'Skills would come from another folder'] })
    expect(groups[0]!.lines).toEqual([
      { field: 'alpha', before: '—', after: 'added' },
      { field: 'alpha · public', before: '—', after: 'yes', detail: true },
      { field: 'alpha · only in', before: '—', after: 'Codex, OpenCode', detail: true },
      { field: 'Skills folder', before: '/a', after: '/srv/skills' }
    ])
  })

  it('shows the install as entries with what each becomes in words, never a skill\'s lines, and what stays exposed', () => {
    const plan: SkillsPlan = {
      ok: true, code: 'OK', planHash: 'h'.repeat(64),
      targets: [
        { harness: 'codex', skill: 'beta', path: '/home/synthetic/.agents/skills/beta', kind: 'adds the skill', change: 'missing', diff: '', note: 'A link to the skill in the skills folder.' },
        { harness: 'codex', skill: 'gamma', path: '/home/synthetic/.agents/skills/gamma', kind: 'takes over an entry BMN did not write (unmanaged)', change: 'unmanaged', diff: '', note: 'the folder there differs from the skill in SKILL.md' }
      ],
      exposed: [{ harness: 'opencode', skill: 'alpha', fix: 'OpenCode reads the skills folder itself: move alpha out of it, or mark it public' }]
    }
    const sheet = rulesMarkup('skills', rules({ pending: { kind: 'skills', plan } }))
    expect(sheet).toContain('aria-label="Change 2 skill entries"')
    expect(words(sheet)).toContain('Undo install, under Earlier installs, puts every entry back.')
    expect(sheet).toContain('<span class="muted">beta · adds the skill</span>')
    expect(sheet).toContain('<p class="preferences-help">the folder there differs from the skill in SKILL.md</p>')
    expect(sheet).not.toContain('<pre class="diff">')
    expect(words(sheet)).toContain('One skill stays exposed whatever is installed:')
    expect(sheet).toContain('<p class="preferences-help">OpenCode reads the skills folder itself: move alpha out of it, or mark it public</p>')
    const none = rulesMarkup('skills', rules({ pending: { kind: 'skills', plan: { ...plan, targets: [] } } }))
    expect(none).toMatch(/aria-label="Every app already has its skills".*<button type="button" class="primary" disabled="">Install<\/button>/s)
  })

  it('lists its own installs with Undo, and leaves them out of the rules\' earlier versions', () => {
    expect(page).toMatch(/<summary>Earlier installs<\/summary><div class="list-line"><div><b>Installed<\/b> <span class="line-detail">[^<]+ · Codex<\/span><\/div><button type="button" class="small" aria-label="Undo the skills install of [^"]+">Undo install…<\/button>/)
    expect(earlierVersions(RULES).some((entry) => entry.kind === 'install' && entry.id === 't3')).toBe(false)
    expect(undoWords({ change: 'folder', diff: '' })).toBe('Put back as it was')
  })

  it('Health shows one row per app: where its skills live, the state in words, Full or Public skills only and the last loading test', () => {
    const health = rulesMarkup('health')
    expect(health).toContain('<h4 class="group-head">Skills<span class="caption">where each app reads skills, and whether it has the ones it may have</span></h4>')
    expect(words(health)).toMatch(/Checked [^·]+ · 1 skill entry to install · 1 skill exposed/)
    expect(health).toMatch(/data-skills="Reads the source"><span>Claude Code<\/span><span class="health-state"><span>The skills folder itself<\/span><\/span><span class="health-state"><span>Reads the source<span class="muted"> · Full<\/span><\/span><span class="faint" title="Claude Code named a test skill">Loading test passed [^<]+ · stale<\/span>/)
    expect(health).toMatch(/data-skills="Missing"><span>Codex<\/span><span class="health-state"><span class="path mono" title="\/home\/synthetic\/.agents\/skills">~\/.agents\/skills<\/span><\/span><span class="health-state"><span><span class="needs-dot"[^>]*><\/span>Missing<span class="muted"> · Full<\/span><\/span><span class="faint" title="[^"]*">Loading never tested<\/span>/)
    expect(health).toMatch(/data-skills="Exposed"><span>OpenCode<\/span>.*?Exposed<span class="muted"> · Public skills only<\/span><\/span><span class="faint" title="[^"]*">No loading test<\/span>/)
    expect(health).toMatch(/data-skills="Not supported yet"><span>Cursor<\/span><span class="health-state"><span class="faint">Not known yet<\/span><\/span><span class="health-state"><span title="no test has run on Cursor 2026.09.26">Not supported yet<\/span><span class="faint">BMN has no test for this app<\/span>/)
    expect([...health.matchAll(/(disabled="" )?aria-label="Skills test for ([A-Za-z ]+)"/g)].map((match) => `${match[2]}${match[1] ? ' off' : ''}`)).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Cursor off'])
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
    expect(skillStateHint('missing', app, true, 'Codex')).toBe('Not in Codex yet: Install… adds it')
    expect(skillStateHint(undefined, { ...app, supported: false }, true, 'Cursor')).toBe('Skills are not supported yet in Cursor: run its test on Health')
    const base = { supported: false, version: '0.171.0', test: null, loading: null, kind: 'full' as const, testable: true }
    expect(skillsTestLine({ ...base, version: null })).toBe('The app is not found')
    expect(skillsTestLine(base)).toBe('Not tested on 0.171.0')
    expect(skillsTestLine({ ...base, test: { at: 'x', version: '0.171.0', outcome: 'inconclusive', detail: 'd' } })).toBe('The test was inconclusive on 0.171.0')
    expect(skillsTestLine({ ...base, test: { at: 'x', version: '0.170.0', outcome: 'fail', detail: 'd' } })).toBe('Not tested on 0.171.0')
  })
})

describe('Team › Models (60.10, first release)', () => {
  const checked = (verified: boolean, why?: string) => ({ rank: 1 as const, verified, ...(why ? { why } : {}) })
  const found = (id: string, providerId: string, extra: Partial<ResearchModelView> = {}): ResearchModelView => ({
    id, provider: providerId === 'openai' ? 'OpenAI' : 'Anthropic', providerId, price: null, contextWindow: null,
    firstSeen: '2026-10-10T09:40:00.000Z', lastSeen: '2026-10-10T09:40:00.000Z', fresh: false, foundLast: true, ...extra
  })
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
      { id: 'sol', name: 'Sol', harness: 'codex', ok: true }, { id: 'fable', name: 'Fable', harness: 'claude', ok: true }, { id: 'luna', name: 'Luna', harness: 'codex', ok: true },
      { id: 'glm', name: 'Glm', harness: 'claude', ok: false, why: 'its provider gets public work only', reason: 'synthetic reason with the word roster in it' },
      { id: 'kimi', name: 'Kimi', harness: 'opencode', ok: false, why: 'OpenCode cannot research', reason: 'synthetic' }
    ],
    researcher: 'fable', running: null, ended: null
  }
  const lookup = async () => ({ ok: false, message: '', model: null })
  const research = (extra: Partial<ResearchState> = {}): ResearchState => ({
    snapshot: RESEARCH, loadError: null, busy: false, notice: null, setNotice: noop, ensure: noop, peek: noop, choose: noop, start: later, stop: later, lookUp: lookup, ...extra
  })
  const modelsMarkup = (state: ResearchState = research(), teamState: TeamState = team()): string =>
    renderToStaticMarkup(createElement(TeamPreferences, { team: teamState, page: { name: 'models' }, research: state, go: noop }))
  const page = modelsMarkup()
  const lines = (markup: string): string[] => [...markup.matchAll(/<div class="model-line" data-model="([^"]+)">/g)].map((match) => match[1]!)

  it('heads the page with the last research, who did it and Research now (AC1)', () => {
    expect(page).toContain(`<h3 class="page-title">Models</h3><span class="faint">Researched ${shortDate('2026-10-10T09:40:00.000Z')} by Fable · 6 models</span>`)
    expect(page).toContain('<button type="button">Research now</button>')
    // The researcher is one of the agents that may research; the others are named with why in plain words, never the check's own.
    expect([...page.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((match) => `${match[2]}:${match[1]}`)).toEqual(['Sol:false', 'Fable:true', 'Luna:false'])
    expect(words(page)).toContain('BMN sends only your model names and the source list. Research runs in a separate empty folder with web tools only. Not offered: Glm (its provider gets public work only), Kimi (OpenCode cannot research).')
    expect(page).not.toContain('synthetic')
    expect(researcherHint('codex')).toBe("BMN sends only your model names and the source list. Research runs in a separate empty folder, read-only, with web search on and Codex's command tools off.")
    expect(page).toContain('<ol class="sources"><li>Provider pages</li><li>Other sites</li></ol>')
    expect(words(page)).not.toMatch(SCHEMA_WORDS)
  })

  it('lists what is new, the team as found and what was found earlier, each value with its site (AC3, AC4)', () => {
    expect(lines(page)).toEqual(['model-next', 'model-far', 'model-sol', 'model-fable', 'model-luna', 'model-haiku', 'model-glm', 'model-old'])
    expect(page).toContain(`<h4 class="group-head">New since ${dayWords('2026-10-03T09:00:00.000Z')}<span class="caption">first seen by the research on ${dayWords('2026-10-10T09:40:00.000Z')}</span></h4>`)
    expect(page).toContain('<h4 class="group-head">Your team<span class="caption">as the research found them</span></h4>')
    expect(page).toContain('<summary>Found earlier · 1 model</summary>')
    expect(page).toContain('<span class="mono">$15.00 / $75.00</span><span class="faint">per M tokens, in / out</span><span class="mono source" title="https://www.anthropic.example.test/pricing" aria-label="anthropic.example.test, price source for model-next">anthropic.example.test</span>')
    // A value BMN could not confirm says so, with the reason on hover.
    expect(page).toContain('<span class="faint" title="BMN could not confirm this on the cited page: the page does not name this model.">unverified ·</span><span class="mono source" title="https://blog.example.test/prices"')
    expect(page).toContain('<span>400 000 tokens</span><span class="faint">context window</span>')
    expect(page).toContain('<button type="button" class="small" aria-label="Add model-next to team">Add to team…</button>')
    // The team: a differing price says what the team has; a model this research missed says when it was last seen.
    expect(page).toContain('<div class="faint">Your team has $1.25 / $10.00</div>')
    expect(page).toContain('<span class="needs-dot" role="img" aria-label="Price differs from your team&#x27;s" title="Price differs from your team&#x27;s"></span>')
    expect(page).toContain(`<div class="faint">Not found this time · last seen ${dayWords('2026-10-03T09:00:00.000Z')}</div>`)
    expect(page).toContain('<div class="faint">Never found by the research</div>')
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
    const ended = modelsMarkup(research({ notice: { ok: true, text: 'Research kept 5 models. Stopped before it finished.' }, snapshot: { ...RESEARCH, last: { ...RESEARCH.last!, state: 'partial', note: 'Stopped before it finished.' } } }))
    expect(ended).toContain('<p class="preferences-success" role="status">Research kept 5 models. Stopped before it finished.</p>')
    expect(ended).toContain('· 6 models · not finished</span>')
    // How the run ended is said once: the standing line shows only when the run's own notice is gone.
    expect(ended).not.toContain('The last research did not finish')
    expect(words(modelsMarkup(research({ snapshot: { ...RESEARCH, last: { ...RESEARCH.last!, state: 'partial', note: 'Stopped before it finished.' } } })))).toContain('The last research did not finish: Stopped before it finished.')
  })

  it('says plainly when no agent can research, and what the page shows before any research', () => {
    const none = modelsMarkup(research({ snapshot: { ...RESEARCH, last: null, previousAt: null, models: [], researcher: null, researchers: RESEARCH.researchers.filter((entry) => !entry.ok) } }))
    expect(none).toContain('<span class="faint">Not researched yet</span>')
    expect(none).toContain('<span class="muted">No agent on your team can research.</span>')
    expect(words(none)).toContain('Research needs an active agent on Claude Code or Codex whose provider may see private work. A price can still be written in the team file.')
    expect(none).toContain('<button type="button" disabled="" title="No agent on your team can research">Research now</button>')
    expect(none).not.toContain('role="radio"')
    expect(lines(none)).toEqual(['model-sol', 'model-fable', 'model-luna', 'model-haiku', 'model-glm'])
    expect(count(none, '<div class="faint">Not researched yet</div>')).toBe(5)
    expect(modelsMarkup(research({ snapshot: null }))).toContain('Reading what research found…')
    expect(modelsMarkup(research({ loadError: 'Could not read what research found' }))).toContain('<p class="preferences-error" role="alert">Could not read what research found</p>')
  })

  it('a first research heads its finds as not on the team, since nothing came before it', () => {
    expect(modelsMarkup(research({ snapshot: { ...RESEARCH, previousAt: null } }))).toContain('<h4 class="group-head">Not on your team<span class="caption">first seen by the research on')
  })

  it('New agent opens filled from a find, says so once with Undo, and offers Look up (AC6)', () => {
    const fill = fillFrom(RESEARCH.models[3]!, DATA)
    const markup = renderToStaticMarkup(createElement(TeamPreferences, { team: team(), page: { name: 'new', fill }, research: research(), go: noop }))
    expect(markup).toMatch(/<div class="page-note with-action" role="status"><span class="note-text">The name and the price are from research on [^<]+\. Check the Agent app and Host; BMN does not check that the app takes this name\.<\/span><button type="button" class="small">Undo<\/button><\/div>/)
    expect(markup).toMatch(/aria-label="Model"[^>]* value="model-next"/)
    expect(markup).toContain('<span class="mono">$15.00 / $75.00</span><span class="faint"> per M tokens, in / out</span>')
    expect(words(markup)).toContain('Read on www.anthropic.example.test, 2026-10-10')
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
