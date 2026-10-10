// MODULE: team-rules-preferences.test.ts - Epic 60.5/60.6 markup: shape and plain words carry meaning, every control is named, no schema word reaches the owner
import type { AgentsPreview, AgentsSnapshot, RosterAgentShape, RosterDataShape, RulesSnapshot } from '@bmn/protocol'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  INSERTS,
  RulesEditor,
  RulesPreferences,
  changeWords,
  destinationWords,
  diffSummary,
  earlierVersions,
  insertAt,
  kilobytes,
  lineCount,
  markerParts,
  testLine,
  undoWords,
  type RulesState
} from './rules-preferences'
import { Chain, TeamLedger, TeamPreferences, TeamToast, firstApprovalWords, shortDate, type TeamPage } from './team-preferences'
import { rulesUpdateWords, type TeamState } from './team-state'

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
    agent('fable', { class: 'queen', harness: 'claude', provider: 'anthropic', roles: ['designer', 'helper'] }),
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
  file: { exists: true, hash: 'f'.repeat(64), link: null, errors: [], warnings: [], data: DATA, prose: { sol: 'Fast lead for everyday work.\nSecond line.' } },
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
  requestApproval: later, commit: later, cancelConfirmation: noop, revert: later, saveNotes: later, pendingNotes: {}, setPendingNote: noop, undoRulesUpdate: later, ...extra
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
    expect(markup).toContain('<span class="class-word">Queen</span>')
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

  it('puts the dot on a card with an unapproved change, and one row per section changed outside BMN', () => {
    const changed = pageMarkup({ name: 'agents' }, team({
      changed: new Set(['luna']),
      outside: { groups: [{ key: 'luna', subject: 'Luna', agent: DATA.agents[2] as RosterAgentShape, lines: [{ field: 'Model', before: 'gpt-6-luna', after: 'gpt-6.1-luna' }], consequences: [] }], general: [] }
    }))
    expect(count(changed, 'class="needs-dot" role="img" aria-label="Unapproved change"')).toBe(1)
    expect(changed).toContain('<b>Luna</b><span class="muted">changed outside BMN:</span><span class="outside-diff"><span class="difference"><span class="muted">Model:</span> gpt-6-luna → gpt-6.1-luna</span></span>')
    expect(changed).toContain('aria-label="Keep the change to Luna">Keep</button>')
    expect(changed).toContain('aria-label="Revert the change to Luna">Revert</button>')
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
    const broken = pageMarkup({ name: 'agents' }, team({ data: null, snapshot: { ...SNAPSHOT, file: { ...SNAPSHOT.file, data: null, errors: [{ code: 'INVALID_VALUE', line: 12, message: 'class must be knight, queen, bishop or pawn' }] } } }))
    expect(broken).toContain('<span class="mono">~/.config/bmn/agents/roster.md</span>')
    expect(broken).toContain('<li>Line 12: class must be knight, queen, bishop or pawn</li>')
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

  it('offers four classes with their piece and line, and bars the roles a class may not hold', () => {
    const markup = pageMarkup({ name: 'agent', id: 'luna' })
    expect([...markup.matchAll(/<\/svg>([A-Za-z]+) <span class="choice-line">([^<]+)<\/span>/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(
      ['Knight: leads an epic/project', 'Queen: designs and thinks creatively', 'Bishop: reviews and advises', 'Pawn: does jobs a lead hands off'])
    expect(markup).toContain('<label class="choice disabled"><input type="checkbox" disabled=""/>Lead <span class="choice-line">Only a Knight leads</span></label>')
    expect(markup).toContain('<label class="choice disabled"><input type="checkbox" disabled=""/>Designer <span class="choice-line">Only a Queen designs</span></label>')
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
    expect(markup).toContain('<span>Claude Code</span> <span class="mono muted">~/.claude/CLAUDE.md</span> <span class="faint">Full rules</span>')
    expect(markup).toContain('<span>Cursor</span> <span class="mono muted">~/.cursor/rules/bmn-global-rules.mdc</span> <span class="faint">Public sections only</span>')
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
    { harness: 'claude', version: '2.1.295', basis: 'default', provider: 'anthropic', host: null, sources: [], versionState: 'tested', acceptable: false, comparison: '' },
    { harness: 'codex', version: '0.171.0', basis: 'default', provider: 'openai', host: null, sources: [], versionState: 'new', acceptable: true, comparison: 'It sends data where 0.161.0 did.' },
    { harness: 'cursor', version: null, basis: 'unknown', provider: null, host: null, sources: [], versionState: 'unknown', acceptable: false, comparison: '' }
  ],
  transactions: [
    { id: 't2', createdAt: '2026-10-09T22:00:00.000Z', state: 'complete', reason: 'team update', targets: ['claude'], valid: true },
    { id: 't1', createdAt: '2026-10-08T14:02:00.000Z', state: 'complete', reason: 'install', targets: ['claude', 'codex'], valid: true },
    { id: 't0', valid: false }
  ],
  history: [{ revision: 1, at: '2026-10-08T13:58:00.000Z', hash: 'h', bytes: 290, reason: 'saved', intact: true }, { revision: 2, at: '2026-10-09T09:00:00.000Z', hash: 'i', bytes: 2000, reason: 'saved', intact: false }]
}

const rules = (extra: Partial<RulesState> = {}): RulesState => ({
  snapshot: RULES, loadError: null, draft: RULES.master.text ?? '', dirty: false, draftPlan: null, busy: false, notice: null, pending: null, setDraft: noop, setNotice: noop,
  ensure: noop, refresh: noop, load: later, beginSave: later, beginInstall: later, beginUndo: later, beginRestore: later, beginTest: noop, confirm: later, cancel: noop, ...extra
})
const rulesMarkup = (page: 'editor' | 'health', state: RulesState = rules(), teamState: TeamState = team()): string =>
  renderToStaticMarkup(createElement(RulesPreferences, { rules: state, team: teamState, page }))

describe('Rules › Editor (60.6 AC1–AC3)', () => {
  const markup = rulesMarkup('editor')

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
    expect(markup).toContain(`<span class="faint">Checked ${shortDate('2026-10-09T22:13:00.000Z')}</span>`)
    expect(markup).toContain('>Check now</button>')
    expect(markup).toMatch(/data-state="current"><span>Claude Code<\/span><span class="path mono" title="\/home\/synthetic\/.claude\/CLAUDE.md">~\/.claude\/CLAUDE.md<\/span><span class="health-state"><span>Current <span class="muted">· Full rules<\/span>/)
    expect(markup).toContain(`<span class="faint">Test passed ${shortDate('2026-10-09T20:00:00.000Z')} · stale</span>`)
    expect(markup).toMatch(/data-state="stale">.*?aria-label="Needs you".*?Differs from the rules <span class="muted">· Full rules<\/span><\/span><span class="faint">Never tested<\/span>/)
    expect(markup).toMatch(/data-state="missing">.*?Missing <span class="muted">· Public sections only<\/span><\/span><span class="faint">No loading test<\/span>/)
    expect(testLine(undefined)).toBe('Never tested')
  })

  it('offers Test… only where the app may receive private work, and says why not elsewhere', () => {
    expect([...markup.matchAll(/aria-label="Test ([A-Za-z ]+)"/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex'])
    expect(markup).toContain("A loading test starts the app once and sends it the rules. It is off for Cursor: BMN can&#x27;t confirm where it sends data.")
  })

  it('shows each agent app: version, whether it is tested, where it sends data and what is recorded', () => {
    expect(markup).toContain('<span class="mono">2.1.295</span> <span class="muted">· tested</span>')
    expect(markup).toContain('<span class="mono">0.171.0</span> <span class="muted">· new</span>')
    expect(markup).toContain('<span class="mono">not found</span> <span class="muted">· not checked</span>')
    expect(markup).toContain('<span>Sends data to Anthropic&#x27;s own servers</span><span class="faint">Recorded: Anthropic, as inspected</span>')
    expect(markup).toContain('<span>Where it sends data is unknown</span><span class="faint">Recorded: Z.ai, on your word</span>')
    expect(destinationWords({ basis: 'explicit', provider: null, host: 'proxy.example.com' }, (id) => id)).toBe('Sends data to a custom host, proxy.example.com')
  })

  it('offers Accept version… only for a new version that sends data where a tested one did, and names each accepted version to remove', () => {
    expect([...markup.matchAll(/aria-label="Accept version ([^"]+)"/g)].map((match) => match[1])).toEqual(['0.171.0 of Codex'])
    expect([...markup.matchAll(/aria-label="Set the destination of ([^"]+)"/g)].map((match) => match[1])).toEqual(['Claude Code', 'Codex', 'Cursor'])
    expect(markup).toContain('aria-label="Remove accepted version 0.170.0 of Codex"')
  })
})

describe('universal words (R60-NFR8)', () => {
  it('no Team or Rules page shows a word of the schema or of the earlier design', () => {
    const pages = [
      pageMarkup({ name: 'agents' }), pageMarkup({ name: 'agent', id: 'sol' }), pageMarkup({ name: 'new' }), pageMarkup({ name: 'roles' }), pageMarkup({ name: 'changes' }),
      rulesMarkup('editor'), rulesMarkup('health')
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
