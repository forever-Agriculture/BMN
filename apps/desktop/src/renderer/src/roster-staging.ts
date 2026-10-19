// MODULE: roster-staging.ts - Epic 60.5: the Team pages' staged edits, review rows and their words, kept pure for tests
import {
  RETIRED_APP_NAMES,
  ROSTER_APP_NAMES,
  ROSTER_CALLED_BY_BMN,
  ROSTER_DESIGNER_ROLE,
  ROSTER_HARNESSES,
  ROSTER_JUDGE_ROLE,
  ROSTER_LEAD_ROLE,
  ROSTER_SCHEMA_VERSION,
  LUNA_GO_PROPOSAL,
  appDisplayName,
  isRetiredApp,
  rosterApp,
  type AgentAppView,
  type RosterAgentShape,
  type RosterClass,
  type RosterDataShape,
  type RosterDiffShape,
  type RosterEffort,
  type RosterHarness,
  type RosterPriceShape,
  type RosterPrivateWork,
  type RosterProviderShape,
  type RosterRoleShape,
  type RosterRouteShape,
  type RosterSkillShape,
  type RosterThen
} from '@bmn/protocol'

/** A section a row names, as the approval writer and `revertAgents` take it: an agent id or a shared section. */
export type RosterSection = string

/**
 * `detail` marks a value carried by an entry that was added or removed whole; a one-line summary
 * leaves those out. `chain` carries a role's candidates on each side, for a page to draw as steps.
 */
export interface DiffLine { field: string; before: string; after: string; detail?: true; chain?: { before: string[] | null; after: string[] | null } }

/** `role` marks a row about one role whose whole chain the page draws (a first approval). */
export interface DiffGroup {
  key: RosterSection
  subject: string
  agent?: RosterAgentShape
  role?: RosterRoleShape
  lines: DiffLine[]
  consequences: string[]
}

// ---------------------------------------------------------------------------------------------
// Words the owner reads (R60-NFR8): no schema names on the pages.

export const CLASS_WORDS: Readonly<Record<RosterClass, { name: string; line: string }>> = {
  knight: { name: 'Knight', line: 'leads an epic/project' },
  queen: { name: 'Queen', line: 'does whatever she wants' },
  rook: { name: 'Rook', line: 'the Artist: designs what is not there yet' },
  bishop: { name: 'Bishop', line: 'reviews and advises' },
  pawn: { name: 'Pawn', line: 'does jobs a lead hands off' }
}

/** What happens when every candidate of a role fails, in words. */
export const THEN_WORDS: Readonly<Record<RosterThen, string>> = { lead: 'Lead does it', skip: 'Skip', blocked: 'Stop and tell me', 'owner-chooses': 'Ask me' }

export const PRIVATE_WORK_WORDS: Readonly<Record<RosterPrivateWork, string>> = { allowed: 'Allowed', public_only: 'Public work only' }

const SECTION_SUBJECTS: Readonly<Record<string, string>> = {
  roles: 'Roles',
  providers: 'Providers',
  exceptions: 'Allowed workspaces',
  'harness-routes': 'Agent apps',
  skills: 'Skills',
  tools: 'Tools',
  'project-choices': 'Project choices'
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  name: 'Name', class: 'Class', harness: 'Agent app', model: 'Model', provider: 'Provider', host: 'Host', enabled: 'On', status: 'Status',
  efforts: 'Efforts', roles: 'Roles', run_by: 'Runs the model', aliases: 'Also called', enabled_note: 'Reason it is off', context_window: 'Capacity', context_limit: 'Context limit',
  compact_at: 'Compact at', paid_by: 'Paid by', price: 'Price', description: 'Line', candidates: 'Order', then: 'If all fail', recheck: 'Recheck',
  small_work: 'Small work', read_only: 'Read-only', researcher: 'Researcher', hosts: 'Hosts', sites: 'Sites', private_work: 'Private work', folder: 'Workspace', basis: 'Destination', accepted_versions: 'Accepted versions',
  input: 'In', cached_input: 'Cached in', output: 'Out', source: 'Source', as_of: 'As of', public: 'Public', only: 'Only in',
  command: 'Program', args: 'Arguments', url: 'Address', env: 'Variables', headers: 'Headers', apps: 'Only in', agents: 'Only for the runs of',
  project: 'Project', role: 'Role', agent: 'Teammate', effort: 'Effort', ends: 'Until'
}

const VALUE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  class: Object.fromEntries(Object.entries(CLASS_WORDS).map(([key, words]) => [key, words.name])),
  harness: { ...ROSTER_APP_NAMES, ...RETIRED_APP_NAMES, [ROSTER_CALLED_BY_BMN]: 'none, called by BMN' },
  then: THEN_WORDS,
  private_work: PRIVATE_WORK_WORDS,
  paid_by: { per_token: 'Per token', subscription: 'Subscription' },
  enabled: { true: 'yes', false: 'no' },
  public: { true: 'yes' },
  host: { default: 'Provider default' },
  basis: { 'observed-default': "its provider's own servers, as inspected", 'owner-declared': 'on your word' }
}

/** A role id as a name: `epic-reviewer` reads "Epic reviewer". */
export function roleName(id: string): string {
  const words = id.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** 272000 reads "272 000". Mirrors bin shared-helpers.mjs `thousands`: the renderer cannot load bin modules. */
export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/** "$1.25 / $10.00" per million tokens, in / out; null when the agent has no price. */
export function priceWords(agent: Pick<RosterAgentShape, 'price'>): string | null {
  return agent.price === undefined ? null : priceText(agent.price)
}

/** The first line of an agent's notes, as its card shows it. */
export function firstLine(notes: string | undefined): string {
  return (notes ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
}

function sectionOf(diff: RosterDiffShape): RosterSection {
  return diff.scope === 'agent' ? diff.id : diff.scope
}

/** The names an id stands for on the pages: the file's ids never reach the owner's eyes. */
interface Names { agents: ReadonlyMap<string, string>; providers: ReadonlyMap<string, string>; exceptions: ReadonlyMap<string, string> }

const NO_NAMES: Names = { agents: new Map(), providers: new Map(), exceptions: new Map() }

/** Later sources win, so a renamed agent or provider reads by its new name. */
function namesOf(...sources: Array<RosterDataShape | null>): Names {
  const present = sources.filter((source): source is RosterDataShape => source !== null)
  return {
    agents: new Map(present.flatMap((source) => source.agents.map((agent) => [agent.id, agent.name] as const))),
    providers: new Map(present.flatMap((source) => source.providers.map((provider) => [provider.id, provider.name] as const))),
    exceptions: new Map(present.flatMap((source) => source.exceptions.map((exception) => [exception.id, exception.provider] as const)))
  }
}

/** `luna@max` reads "Luna max"; `astra@medium|high` reads "Astra medium or high". */
function candidateWords(text: string, names: Names): string {
  const candidate = parseCandidate(text)
  return `${names.agents.get(candidate.agent) ?? candidate.agent} ${effortWords(candidate)}`
}

/** A dollar amount with cents, or with every digit it has when cents would round it ("$0.125"). */
const money = (amount: number): string => (Number(amount.toFixed(2)) === amount ? amount.toFixed(2) : String(amount))

/** "$15.00 / $75.00": per million tokens, in / out. */
export function priceText(price: Pick<RosterPriceShape, 'input' | 'output'>): string {
  return `$${money(price.input)} / $${money(price.output)}`
}

/** The site a value was read on, as the pages name it: "anthropic.com", never the whole address. */
export function siteOf(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, '')
  } catch {
    return source
  }
}

/** "Oct 10": the day a value was read or a model was seen. */
export function dayWords(date: string): string {
  const value = new Date(date.length === 10 ? `${date}T12:00:00` : date)
  return Number.isNaN(value.getTime()) ? date : value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A recorded price as a review shows it: the two amounts, the cached one when there is one, and where and when it was read. */
function priceReview(price: RosterPriceShape): string {
  const read = [price.source ? siteOf(price.source) : null, price.as_of ? dayWords(String(price.as_of)) : null].filter(Boolean).join(', ')
  return [priceText(price), price.cached_input === undefined ? null : `cached $${money(price.cached_input)}`, read === '' ? null : read].filter(Boolean).join(' · ')
}

const isPrice = (value: unknown): value is RosterPriceShape =>
  typeof value === 'object' && value !== null && typeof (value as RosterPriceShape).input === 'number' && typeof (value as RosterPriceShape).output === 'number'

function formatPlain(value: unknown, field: string | undefined, names: Names): string {
  if (value === null || value === undefined) return 'none'
  if (field === 'price' && isPrice(value)) return priceReview(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none'
    if (field === 'candidates') return value.map((entry) => candidateWords(String(entry), names)).join(', ')
    if (field === 'roles') return value.map((entry) => roleName(String(entry))).join(', ')
    if (field === 'only' || field === 'apps') return value.map((entry) => appDisplayName(String(entry))).join(', ')
    if (field === 'agents') return value.map((entry) => names.agents.get(String(entry)) ?? String(entry)).join(', ')
    // A tool's arguments, as they would be typed; one that comes from a variable shows the variable, never a value.
    if (field === 'args') return value.map((entry) => (typeof entry === 'object' && entry !== null ? `$${String((entry as { env?: unknown }).env)}` : String(entry))).join(' ')
    return value.map((entry) => formatPlain(entry, undefined, names)).join(', ')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // A recheck names who rechecks and at which effort: `{same_reviewer: true, astra: low}`.
    // The variables a tool names: each entry it receives, and the variable it comes from when that is named differently.
    if (field === 'env' || field === 'headers') return entries.map(([key, entry]) => (key === entry ? key : `${key} from ${String(entry)}`)).join(', ')
    if (field === 'recheck') {
      return entries.map(([key, entry]) => key === 'same_reviewer' ? (entry === true ? 'the same reviewer' : 'another reviewer') : `${names.agents.get(key) ?? key} ${String(entry)}`).join(' · ')
    }
    return entries.map(([key, entry]) => `${(FIELD_WORDS[key] ?? key).toLowerCase()} ${formatPlain(entry, key, names)}`).join(' · ')
  }
  if (field === 'small_work') return candidateWords(String(value), names)
  if (field === 'read_only' || field === 'researcher') return value === true ? 'yes' : 'no'
  if (field === 'provider' || field === 'run_by') return names.providers.get(String(value)) ?? String(value)
  const word = field === undefined ? undefined : VALUE_WORDS[field]?.[String(value)]
  if (word !== undefined) return word
  return typeof value === 'number' && value >= 10_000 ? thousands(value) : String(value)
}

/**
 * One value as the review shows it. The owner's free text shows only that it changed; an
 * exception's folder shows in full, because approving it is what lets private work into that folder.
 */
export function formatValue(side: RosterDiffShape['before'], field?: string, names: Names = NO_NAMES): string {
  if (side === undefined || !side.present) return '—'
  if (side.hash !== undefined) return 'changed'
  return formatPlain(side.value, field, names)
}

/** For an agent BMN itself calls, its provider is the party that receives the request; the other one runs the model. */
const CALLED_FIELD_WORDS: Readonly<Record<string, string>> = { provider: 'Receives the request' }

function fieldWords(diff: RosterDiffShape, names: Names, called = false): string {
  const word = (called ? CALLED_FIELD_WORDS[diff.field ?? ''] : undefined) ?? FIELD_WORDS[diff.field ?? ''] ?? diff.field ?? ''
  if (diff.scope === 'agent') return word
  // The folder the skills come from is one value of the section, not a skill.
  if (diff.scope === 'skills' && diff.id === SKILLS_SOURCE_ID) return 'Skills folder'
  const provider = (id: string): string => names.providers.get(id) ?? id
  const subject = diff.scope === 'roles' ? roleName(diff.id)
    : diff.scope === 'harness-routes' ? appDisplayName(diff.id)
      : diff.scope === 'providers' ? provider(diff.id)
        : diff.scope === 'exceptions' ? provider(names.exceptions.get(diff.id) ?? diff.id) : diff.id
  return word === '' ? subject : `${subject} · ${word.toLowerCase()}`
}

const candidatesOf = (side: RosterDiffShape['before']): string[] | null =>
  side?.present && side.hash === undefined && Array.isArray(side.value) ? side.value.map(String) : null

function lineFor(diff: RosterDiffShape, names: Names, called: boolean): DiffLine {
  const line: DiffLine = { field: fieldWords(diff, names, called), before: formatValue(diff.before, diff.field ?? undefined, names), after: formatValue(diff.after, diff.field ?? undefined, names) }
  return diff.field === 'candidates' ? { ...line, chain: { before: candidatesOf(diff.before), after: candidatesOf(diff.after) } } : line
}

/** An added or removed entry shows every value it carries, one line per field (60.5 AC2); an agent BMN calls has no efforts to show. */
function linesFor(diff: RosterDiffShape, names: Names, called: boolean): DiffLine[] {
  if (diff.field !== null) return [lineFor(diff, names, called)]
  const added = diff.kind === 'added'
  const side = added ? diff.after : diff.before
  const head: DiffLine = { field: fieldWords({ ...diff, field: null }, names) || 'Agent', before: added ? '—' : 'present', after: added ? 'added' : 'removed' }
  if (!side?.present || side.value === null || typeof side.value !== 'object') return [head]
  const hidden = new Set(['id', ...(diff.scope === 'harness-routes' ? ['harness'] : []), ...(called ? ['efforts'] : [])])
  return [head, ...Object.entries(side.value as Record<string, unknown>).filter(([key]) => !hidden.has(key)).map(([key, value]) => {
    const text = typeof value === 'string' && value.startsWith('text ') ? 'set' : formatPlain(value, key, names)
    return { field: fieldWords({ ...diff, field: key }, names, called), before: added ? '—' : text, after: added ? text : '—', detail: true as const }
  })]
}

function claimant(sentence: string, groups: DiffGroup[], roleIds: ReadonlySet<string>): DiffGroup | undefined {
  const agentGroup = groups.find((group) => group.agent !== undefined && (sentence.startsWith(`${group.subject} `) || sentence.startsWith(`${group.subject}: `)))
  if (agentGroup) return agentGroup
  const section = (key: string): DiffGroup | undefined => groups.find((group) => group.key === key)
  if (sentence.startsWith('Changing ')) return section('providers')
  if (/^Skills? /.test(sentence)) return section('skills')
  if (/^(Tool |With (a|no) tool on the list)/.test(sentence)) return section('tools')
  if (/ could (no longer )?receive private work in /.test(sentence)) return section('exceptions')
  if (/^[a-z0-9-]+ asks in one project would reach /.test(sentence)) return section('project-choices')
  if (/ could (no longer )?carry private work/.test(sentence) || sentence.includes(' would count as sending data ')) return section('harness-routes')
  const roleWord = /^(?:when every |the )?([a-z0-9-]+) /.exec(sentence)?.[1]
  if (roleWord !== undefined && roleIds.has(roleWord)) return section('roles')
  return undefined
}

const spaced = (id: string): string => id.replaceAll('-', ' ')
const thenWords = (id: string): string => THEN_WORDS[id as RosterThen] ?? id

/**
 * A consequence sentence as a page shows it. The sentences are 60.3's, shared with
 * `bmn roster status`, where a role and a fallback go by their ids; here they go by their words.
 */
export function consequenceWords(sentence: string, roleIds: ReadonlySet<string>): string {
  const known = (id: string | undefined): id is string => id !== undefined && roleIds.has(id)
  const starts = /^([a-z0-9-]+) would (start with .*|have no agent to start with) ?(?:\(then ([a-z-]+)\))?$/.exec(sentence)
  if (starts && known(starts[1])) return `${roleName(starts[1])} would ${starts[2]}${starts[3] ? ` (then: ${thenWords(starts[3])})` : ''}`
  const fails = /^when every ([a-z0-9-]+) candidate fails: ([a-z-]+) instead of ([a-z-]+)$/.exec(sentence)
  if (fails && known(fails[1])) return `When every ${spaced(fails[1])} candidate fails: ${thenWords(fails[2] as string)} instead of ${thenWords(fails[3] as string)}`
  const runs = /^([a-z0-9-]+) runs (would be refused unless they are started so that they cannot write|could be started with write access again)$/.exec(sentence)
  if (runs && known(runs[1])) return `${roleName(runs[1])} runs ${runs[2] as string}`
  const choice = /^([a-z0-9-]+) asks in one project (would reach .*)$/.exec(sentence)
  if (choice && known(choice[1])) return `${roleName(choice[1])} asks in one project ${choice[2] as string}`
  const removed = /^the ([a-z0-9-]+) role would be removed$/.exec(sentence)
  if (removed && known(removed[1])) return `The ${spaced(removed[1])} role would be removed`
  return sentence.replace(/ take the ([a-z0-9-]+) role$/, (whole, id: string) => (roleIds.has(id) ? ` take the ${spaced(id)} role` : whole))
}

/** An approved version's one-line summary: its first consequence in the pages' words, then "· N more". */
export function summaryWords(summary: string, roleIds: ReadonlySet<string>): string {
  const more = / · \d+ more$/.exec(summary)
  return more ? `${consequenceWords(summary.slice(0, more.index), roleIds)}${more[0]}` : consequenceWords(summary, roleIds)
}

export function roleIdsOf(...sources: Array<RosterDataShape | null>): Set<string> {
  return new Set(sources.flatMap((source) => source?.roles.map((role) => role.id) ?? []))
}

/**
 * Groups machine differences into one row per agent or shared section, and gives each row the
 * consequence sentences about it (the sentences come from 60.3's `consequences`, the same words
 * `bmn roster status` prints). Sentences no row claims stay in `general`.
 */
export function groupDifferences(diffs: readonly RosterDiffShape[], data: RosterDataShape | null, approved: RosterDataShape | null,
  sentences: readonly string[]): { groups: DiffGroup[]; general: string[] } {
  const agentById = new Map([...(approved?.agents ?? []), ...(data?.agents ?? [])].map((agent) => [agent.id, agent]))
  const names = namesOf(approved, data)
  const groups = new Map<RosterSection, DiffGroup>()
  for (const diff of diffs) {
    const key = sectionOf(diff)
    let group = groups.get(key)
    if (group === undefined) {
      const agent = diff.scope === 'agent' ? agentById.get(diff.id) : undefined
      group = { key, subject: agent?.name ?? SECTION_SUBJECTS[key] ?? key, lines: [], consequences: [], ...(agent ? { agent } : {}) }
      groups.set(key, group)
    }
    const subject = diff.scope === 'agent' ? agentById.get(diff.id) : undefined
    group.lines.push(...linesFor(diff, names, subject !== undefined && isCalled(subject)))
  }
  const general: string[] = []
  const roleIds = roleIdsOf(data, approved)
  for (const sentence of sentences) {
    const owner = claimant(sentence, [...groups.values()], roleIds)
    if (owner) owner.consequences.push(consequenceWords(sentence, roleIds))
    else general.push(consequenceWords(sentence, roleIds))
  }
  return { groups: [...groups.values()], general }
}

const ABILITY_WORDS: Readonly<Record<string, string>> = {
  'be given work': 'can be given work', lead: 'can lead', design: 'can design', 'receive private work': 'may receive private work'
}

/**
 * A first approval has nothing to differ from, so its review is the consequences themselves, one
 * row per agent ("Can be given work, can lead, may receive private work") and one per role, whose
 * chain the page draws; one row naming, in full, every folder where a provider that otherwise
 * gets public work only would be allowed private work; and one naming each project choice with its
 * folder, role, teammate, effort and end date (73.2 AC2). Sentences about none of these stay in `general`.
 */
export function firstApprovalGroups(data: RosterDataShape, sentences: readonly string[]): { groups: DiffGroup[]; general: string[] } {
  const roleIds = roleIdsOf(data)
  const left = new Set(sentences)
  const groups: DiffGroup[] = []
  for (const agent of data.agents) {
    const mine = sentences.filter((sentence) => sentence.startsWith(`${agent.name} could `))
    if (mine.length === 0) continue
    for (const sentence of mine) left.delete(sentence)
    const abilities = mine.map((sentence) => sentence.slice(`${agent.name} could `.length)).map((ability) => ABILITY_WORDS[ability] ?? `could ${ability}`).join(', ')
    groups.push({ key: agent.id, subject: agent.name, agent, lines: [], consequences: [abilities.charAt(0).toUpperCase() + abilities.slice(1)] })
  }
  for (const role of data.roles) {
    const mine = sentences.filter((sentence) => sentence.startsWith(`${role.id} would `))
    if (mine.length === 0) continue
    for (const sentence of mine) left.delete(sentence)
    groups.push({ key: `role:${role.id}`, subject: roleName(role.id), role, lines: [], consequences: mine.some((sentence) => sentence.includes(' would have no agent to start with')) ? ['Nobody can start it yet'] : [] })
  }
  if (data.exceptions.length > 0) {
    const names = namesOf(data)
    const mine = sentences.filter((sentence) => / could receive private work in /.test(sentence))
    for (const sentence of mine) left.delete(sentence)
    // First, so it is read before Approve without scrolling past every agent and role.
    groups.unshift({
      key: 'exceptions', subject: SECTION_SUBJECTS.exceptions ?? 'exceptions', consequences: mine,
      lines: data.exceptions.map((exception) => ({ field: `${names.providers.get(exception.provider) ?? exception.provider} · workspace`, before: '—', after: exception.folder }))
    })
  }
  const choices = data.project_choices ?? []
  if (choices.length > 0) {
    const names = namesOf(data)
    const mine = sentences.filter((sentence) => /^[a-z0-9-]+ asks in one project would reach /.test(sentence))
    for (const sentence of mine) left.delete(sentence)
    // Each choice says where it binds and to whom, as BMN's own review names a folder (73.2 AC2).
    groups.unshift({
      key: 'project-choices', subject: SECTION_SUBJECTS['project-choices'] ?? 'Project choices', consequences: mine.map((sentence) => consequenceWords(sentence, roleIds)),
      lines: choices.map((choice) => ({
        field: `${roleName(choice.role)} · ${choice.id}`, before: '—',
        after: `${choice.project} → ${names.agents.get(choice.agent) ?? choice.agent}${choice.effort === undefined ? '' : ` at ${choice.effort}`}${choice.ends === undefined ? '' : ` until ${choice.ends}`}`
      }))
    })
  }
  return { groups, general: sentences.filter((sentence) => left.has(sentence)).map((sentence) => consequenceWords(sentence, roleIds)) }
}

/** "+3 −1" for a unified diff, headers excluded; "No change" for an empty one. */
export function diffSummary(diff: string): string {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return added + removed === 0 ? 'No change' : `+${added} −${removed}`
}

/** What a file becomes when an install or a rules update is undone. */
export function undoWords(target: { change: string; diff: string }): string {
  return target.change === 'link' ? 'Becomes a link again' : target.change === 'missing' ? 'Removed again' : target.change === 'folder' || target.change === 'entry' ? 'Put back as it was' : `Put back · ${diffSummary(target.diff)}`
}

/** A group's differences on one line, as the "changed outside BMN" row shows them. */
export function differenceLine(group: Pick<DiffGroup, 'lines'>): string {
  return group.lines.filter((line) => line.detail !== true).map((line) => `${line.field.toLowerCase()} ${line.before} → ${line.after}`).join(' · ')
}

/**
 * A difference as a sheet shows it: the changed lines with their context. The two file lines and
 * the position lines of the diff format are left out, because the sheet names the file itself.
 */
export function diffBody(diff: string): string {
  const lines = diff.split('\n')
  const body = lines.filter((line, index) => !(index < 2 && /^(---|\+\+\+) /.test(line)))
  const first = body.findIndex((line) => line.startsWith('@@'))
  return body.flatMap((line, index) => !line.startsWith('@@') ? [line] : index === first ? [] : ['⋯']).join('\n')
}

/** "1 unapproved change", the footer's count. */
export function summarize(diffs: readonly RosterDiffShape[]): string {
  // Turning an agent off records its reason too; that is one change, not two.
  const switched = new Set(diffs.filter((diff) => diff.scope === 'agent' && diff.field === 'enabled').map((diff) => diff.id))
  const sections = new Set(diffs.filter((diff) => !(diff.scope === 'agent' && diff.field === 'enabled_note' && switched.has(diff.id)))
    .map((diff) => `${diff.scope}:${diff.id}:${diff.field ?? ''}`)).size
  return sections === 0 ? 'No changes' : `${sections} unapproved change${sections === 1 ? '' : 's'}`
}

/** "Also updates the Team line in 4 rules files", or null when an approval touches none (60.5 AC7). */
export function teamUpdateWords(count: number): string | null {
  return count === 0 ? null : `Also updates the Team line in ${count} rules file${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------------------------
// Edits: every helper returns new data and never mutates its input.

type AgentPatch = { [Key in Exclude<keyof RosterAgentShape, 'id' | 'roles' | 'class'>]?: RosterAgentShape[Key] | undefined }

/** Optional fields set to `undefined` leave the file. */
export function updateAgent(data: RosterDataShape, id: string, patch: AgentPatch): RosterDataShape {
  return {
    ...data,
    agents: data.agents.map((agent) => {
      if (agent.id !== id) return agent
      const next: Record<string, unknown> = { ...agent, ...patch }
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
      return next as unknown as RosterAgentShape
    })
  }
}

interface Candidate { agent: string; efforts: RosterEffort[]; choice: boolean }

/** Mirrors bin agents-roster.mjs `parseCandidate`: the renderer cannot load bin modules. */
export function parseCandidate(text: string): Candidate {
  const [agent = '', efforts = ''] = text.split('@')
  return { agent, efforts: efforts.split('|').filter(Boolean) as RosterEffort[], choice: efforts.includes('|') }
}

/** An agent BMN calls has no effort, and is named by its id alone. */
export function formatCandidate(candidate: Pick<Candidate, 'agent' | 'efforts'>): string {
  return candidate.efforts.length === 0 ? candidate.agent : `${candidate.agent}@${candidate.efforts.join('|')}`
}

/** "max", or "medium or high" where the lead chooses. */
export function effortWords(candidate: Pick<Candidate, 'efforts'>): string {
  return candidate.efforts.join(' or ')
}

/** Why a class may not hold a role, or null when it may: a Knight or a Queen leads, a Rook or a Queen designs. */
export function classBar(agentClass: RosterClass, roleId: string): string | null {
  if (roleId === ROSTER_LEAD_ROLE && agentClass !== 'knight' && agentClass !== 'queen') return 'Only a Knight or a Queen leads'
  if (roleId === ROSTER_DESIGNER_ROLE && agentClass !== 'rook' && agentClass !== 'queen') return 'Only a Rook or a Queen designs'
  return null
}

/** Whether BMN itself calls the agent: it runs in no agent app (Epic 65). Mirrors bin agents-roster.mjs `isCalled`: the renderer cannot load bin modules. */
export function isCalled(agent: Pick<RosterAgentShape, 'harness'>): boolean {
  return rosterApp(agent) === null
}

/** Where an agent runs, as a card says it: its app, or that BMN calls it. */
export const CALLED_WORDS = 'Called by BMN'
export function appWords(agent: Pick<RosterAgentShape, 'harness'>): string {
  const app = rosterApp(agent)
  return app === null ? CALLED_WORDS : appDisplayName(app)
}

/**
 * Why an agent may not hold a role, or null when it may. An agent BMN calls holds the role Judge
 * and no other, and nobody else holds that one; for the rest its class decides.
 */
export function roleBar(agent: Pick<RosterAgentShape, 'class' | 'harness'>, roleId: string): string | null {
  if (isCalled(agent)) return roleId === ROSTER_JUDGE_ROLE ? null : 'An agent BMN calls holds the role Judge only'
  if (roleId === ROSTER_JUDGE_ROLE) return 'Only an agent BMN calls is a judge'
  return classBar(agent.class, roleId)
}

function updateRole(data: RosterDataShape, roleId: string, change: (role: RosterRoleShape) => RosterRoleShape): RosterDataShape {
  return { ...data, roles: data.roles.map((role) => (role.id === roleId ? change(role) : role)) }
}

export function moveCandidate(data: RosterDataShape, roleId: string, index: number, step: -1 | 1): RosterDataShape {
  return updateRole(data, roleId, (role) => {
    const target = index + step
    if (target < 0 || target >= role.candidates.length) return role
    const candidates = [...role.candidates]
    ;[candidates[index], candidates[target]] = [candidates[target] as string, candidates[index] as string]
    return { ...role, candidates }
  })
}

/**
 * Toggles one effort on a candidate. Its efforts keep the agent's declared order; the last one
 * cannot be removed. Two or more make an effort choice the lead settles.
 */
export function toggleCandidateEffort(data: RosterDataShape, roleId: string, agentId: string, effort: RosterEffort): RosterDataShape {
  const order = data.agents.find((agent) => agent.id === agentId)?.efforts ?? []
  return updateRole(data, roleId, (role) => ({
    ...role,
    candidates: role.candidates.map((text) => {
      const candidate = parseCandidate(text)
      if (candidate.agent !== agentId) return text
      const has = candidate.efforts.includes(effort)
      if (has && candidate.efforts.length === 1) return text
      const efforts = has ? candidate.efforts.filter((value) => value !== effort) : [...candidate.efforts, effort]
      return formatCandidate({ agent: agentId, efforts: order.filter((value) => efforts.includes(value)) })
    })
  }))
}

export function setRoleThen(data: RosterDataShape, roleId: string, then: RosterThen): RosterDataShape {
  return updateRole(data, roleId, (role) => ({ ...role, then }))
}

/** Holds a role to read-only, or lets it write again; a role that may write carries no mark at all, as in a team from before the mark. */
export function setRoleReadOnly(data: RosterDataShape, roleId: string, on: boolean): RosterDataShape {
  return updateRole(data, roleId, (role) => {
    const rest = { ...role }
    delete rest.read_only
    return on ? { ...rest, read_only: true } : rest
  })
}

/** BMN's proposal for read-only roles (63.2): every role whose name ends in "reviewer", and the consultant. The same rule as the CLI's, mirrored because the renderer cannot load bin modules. */
export function readOnlyProposed(roleId: string): boolean {
  return /reviewer$/.test(roleId) || roleId === 'consultant'
}

/** The roles BMN proposes to hold to read-only, while the team holds none yet; empty once any role is held, since the choice is the owner's from then on. Mirrors bin agents-roster.mjs `readOnlyProposal`: the renderer cannot load bin modules. */
export function readOnlyProposal(data: Pick<RosterDataShape, 'roles'>): string[] {
  if (data.roles.some((role) => role.read_only === true)) return []
  return data.roles.filter((role) => readOnlyProposed(role.id)).map((role) => role.id)
}

/** The proposal taken as it stands, for the owner to approve like any other change. */
export function holdProposed(data: RosterDataShape): RosterDataShape {
  return readOnlyProposal(data).reduce((next, roleId) => setRoleReadOnly(next, roleId, true), data)
}

/** The agents a team names as researchers (63.3): null only for a team from before the mark, in which no agent carries it; otherwise exactly the agents marked yes, none where every mark says no. The same rule as the CLI's, mirrored because the renderer cannot load bin modules. */
export function namedResearchers(data: Pick<RosterDataShape, 'agents'>): string[] | null {
  if (!data.agents.some((agent) => typeof agent.researcher === 'boolean')) return null
  return data.agents.filter((agent) => agent.researcher === true).map((agent) => agent.id)
}

/**
 * Names an agent a researcher, or takes that away. A team that has made its choice keeps it: where
 * the approved team carries the mark (`chosen`) and this was the last one left, switching it off
 * writes `no` on it, so that taking the last researcher away leaves nobody researching and never
 * everybody again. Everywhere else switching off leaves the field out, as it was before he switched it on.
 */
export function setResearcher(data: RosterDataShape, agentId: string, on: boolean, chosen = false): RosterDataShape {
  const last = chosen && !data.agents.some((agent) => agent.id !== agentId && typeof agent.researcher === 'boolean')
  return {
    ...data,
    agents: data.agents.map((agent) => {
      if (agent.id !== agentId) return agent
      const rest = { ...agent }
      delete rest.researcher
      return on ? { ...rest, researcher: true } : last ? { ...rest, researcher: false } : rest
    })
  }
}

/** BMN's proposal of who researches, taken as it stands, for the owner to approve like any other change. */
export function nameResearchers(data: RosterDataShape, ids: readonly string[]): RosterDataShape {
  return ids.reduce((next, id) => setResearcher(next, id, true), data)
}

/** "Opus", "Opus and Haiku", "Opus, Haiku and Sol": agents by the names the team gives them. */
export function listedAgents(data: Pick<RosterDataShape, 'agents'>, ids: readonly string[]): string {
  const names = ids.map((id) => data.agents.find((agent) => agent.id === id)?.name ?? id)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}

/** "Epic reviewer", "Epic reviewer and Consultant", "Epic reviewer, Final reviewer and Consultant". */
export function listedRoles(ids: readonly string[]): string {
  const names = ids.map(roleName)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}

function withoutAgent(role: RosterRoleShape, agentId: string): RosterRoleShape {
  const next: RosterRoleShape = { ...role, candidates: role.candidates.filter((text) => parseCandidate(text).agent !== agentId) }
  if (next.recheck && Object.hasOwn(next.recheck, agentId)) {
    const rest = { ...next.recheck }
    delete rest[agentId]
    next.recheck = rest
  }
  if (next.small_work && parseCandidate(next.small_work).agent === agentId) delete next.small_work
  return next
}

/**
 * An agent holds a role exactly when it is one of the role's candidates (60.1's ROLE_NOT_HELD), so
 * both change together: holding adds it last in the chain at its highest effort (an agent BMN
 * calls has none, and is named alone), releasing removes it. A role it may not hold is never added.
 */
export function toggleAgentRole(data: RosterDataShape, agentId: string, roleId: string): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined) return data
  const holds = agent.roles.includes(roleId)
  if (!holds && roleBar(agent, roleId) !== null) return data
  const called = isCalled(agent)
  const top = agent.efforts.at(-1)
  if (!holds && !called && top === undefined) return data
  const agents = data.agents.map((entry) => entry.id !== agentId ? entry
    : { ...entry, roles: holds ? entry.roles.filter((role) => role !== roleId) : [...entry.roles, roleId] })
  const roles = data.roles.map((role) => {
    if (role.id !== roleId) return role
    if (holds) return withoutAgent(role, agentId)
    return (top === undefined && !called) || role.candidates.some((text) => parseCandidate(text).agent === agentId) ? role
      : { ...role, candidates: [...role.candidates, formatCandidate({ agent: agentId, efforts: top === undefined ? [] : [top] })] }
  })
  return { ...data, agents, roles }
}

/** A new class; roles the class may not hold leave the agent and their chains with it. */
export function setAgentClass(data: RosterDataShape, agentId: string, agentClass: RosterClass): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined || agent.class === agentClass) return data
  let next = data
  for (const role of agent.roles) if (roleBar({ ...agent, class: agentClass }, role) !== null) next = toggleAgentRole(next, agentId, role)
  return { ...next, agents: next.agents.map((entry) => (entry.id === agentId ? { ...entry, class: agentClass } : entry)) }
}

/**
 * Toggles one effort an agent offers. Its last effort cannot be removed while it is on; a removed
 * effort leaves every chain that asked for it, keeping at least one effort per candidate.
 */
export function toggleAgentEffort(data: RosterDataShape, agentId: string, effort: RosterEffort, order: readonly RosterEffort[]): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined) return data
  const has = agent.efforts.includes(effort)
  if (has && agent.efforts.length === 1) return data
  const efforts = order.filter((value) => (value === effort ? !has : agent.efforts.includes(value)))
  const fallback = efforts.at(-1) as RosterEffort
  const fix = (text: string): string => {
    const candidate = parseCandidate(text)
    if (candidate.agent !== agentId) return text
    const kept = candidate.efforts.filter((value) => efforts.includes(value))
    return formatCandidate({ agent: agentId, efforts: kept.length > 0 ? kept : [fallback] })
  }
  return {
    ...data,
    agents: data.agents.map((entry) => (entry.id === agentId ? { ...entry, efforts } : entry)),
    roles: data.roles.map((role) => {
      const next: RosterRoleShape = { ...role, candidates: role.candidates.map(fix) }
      if (role.small_work !== undefined) next.small_work = fix(role.small_work)
      if (role.recheck !== undefined && typeof role.recheck[agentId] === 'string' && !efforts.includes(role.recheck[agentId] as RosterEffort)) {
        const rest = { ...role.recheck }
        delete rest[agentId]
        next.recheck = rest
      }
      return next
    })
  }
}

/** Turning an agent off records the owner's short reason; turning it on clears it. Efforts stay as they are. */
export function setAgentOn(data: RosterDataShape, agentId: string, on: boolean, reason = ''): RosterDataShape {
  return updateAgent(data, agentId, { enabled: on, enabled_note: on || reason.trim() === '' ? undefined : reason.trim() })
}

export function activateAgent(data: RosterDataShape, agentId: string): RosterDataShape {
  return updateAgent(data, agentId, { status: 'active', enabled: true, enabled_note: undefined })
}

/** One answer per provider: it covers every agent there. */
export function setProviderAnswer(data: RosterDataShape, providerId: string, answer: RosterPrivateWork): RosterDataShape {
  return { ...data, providers: data.providers.map((provider) => (provider.id === providerId ? { ...provider, private_work: answer } : provider)) }
}

/** The id the skills folder's difference carries; no skill can be named so. */
const SKILLS_SOURCE_ID = '.source'

/** A skill's marks in the team, or none: every app that may receive private work has it, and it is not public. */
export function skillMark(data: Pick<RosterDataShape, 'skills'>, name: string): RosterSkillShape {
  return data.skills?.find((entry) => entry.id === name) ?? { id: name }
}

/** The team with one skill's marks replaced; a skill with no mark has no entry, and a team with none has no list. */
function withSkillMark(data: RosterDataShape, mark: RosterSkillShape): RosterDataShape {
  const kept = (data.skills ?? []).filter((entry) => entry.id !== mark.id)
  const skills = [...kept, ...(mark.public === true || mark.only !== undefined ? [mark] : [])].sort((a, b) => (a.id < b.id ? -1 : 1))
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'skills')) as Omit<RosterDataShape, 'skills'>
  return skills.length === 0 ? rest : { ...rest, skills }
}

/** Public lets an app on a public-only route have the skill. */
export function setSkillPublic(data: RosterDataShape, name: string, on: boolean): RosterDataShape {
  const mark = skillMark(data, name)
  return withSkillMark(data, { id: name, ...(on ? { public: true as const } : {}), ...(mark.only === undefined ? {} : { only: mark.only }) })
}

/** Whether a skill is meant for an app: every app, unless it is kept to some. */
export function skillForApp(mark: RosterSkillShape, harness: RosterHarness): boolean {
  return mark.only === undefined || mark.only.includes(harness)
}

/** Adds an app to a skill's scope or takes it out; all four apps is "all apps" again, and the last app cannot be taken out. */
export function toggleSkillApp(data: RosterDataShape, name: string, harness: RosterHarness): RosterDataShape {
  const mark = skillMark(data, name)
  const now = ROSTER_HARNESSES.filter((app) => skillForApp(mark, app) !== (app === harness))
  if (now.length === 0) return data
  return withSkillMark(data, { id: name, ...(mark.public === true ? { public: true as const } : {}), ...(now.length === ROSTER_HARNESSES.length ? {} : { only: now }) })
}

/** One allowed workspace taken away: its provider may no longer see private work there (60.8 AC5). */
export function removeException(data: RosterDataShape, id: string): RosterDataShape {
  return { ...data, exceptions: data.exceptions.filter((entry) => entry.id !== id) }
}

/** The agents a provider's answer covers: those it serves, and an agent BMN calls whose model it runs. */
export function agentsOnProvider(data: RosterDataShape, providerId: string): RosterAgentShape[] {
  return data.agents.filter((agent) => agent.provider === providerId || (isCalled(agent) && agent.run_by === providerId))
}

export function providerOf(data: RosterDataShape, agent: Pick<RosterAgentShape, 'provider'>): RosterProviderShape | undefined {
  return data.providers.find((provider) => provider.id === agent.provider)
}

/**
 * Whether an agent gets public work only: its provider answers so (an unknown provider does). An
 * agent BMN calls names two parties, and gets private work only where both allow it: the same rule
 * as the CLI's `privateWorkOf`.
 */
export function publicOnly(data: RosterDataShape, agent: Pick<RosterAgentShape, 'provider'> & Partial<Pick<RosterAgentShape, 'harness' | 'run_by'>>): boolean {
  const allowed = (id: string | undefined): boolean => data.providers.find((provider) => provider.id === id)?.private_work === 'allowed'
  return !(allowed(agent.provider) && (agent.harness !== ROSTER_CALLED_BY_BMN || allowed(agent.run_by)))
}

export interface CalledParty { id: string; name: string; private_work: RosterPrivateWork }

/**
 * The two parties of an agent BMN calls, who receives the request and who runs the model, each
 * with its answer, and the one sentence that says what follows: the same words as the CLI's
 * `calledParties`, mirrored because the renderer cannot load bin modules.
 */
export function calledParties(data: RosterDataShape, agent: Pick<RosterAgentShape, 'provider' | 'run_by'>): { receives: CalledParty; runs: CalledParty; allowed: boolean; reason: string } {
  const party = (id: string): CalledParty => {
    const provider = data.providers.find((entry) => entry.id === id)
    return { id, name: provider?.name ?? id, private_work: provider?.private_work ?? 'public_only' }
  }
  const receives = party(agent.provider)
  const runs = party(agent.run_by ?? agent.provider)
  const held = [receives, runs].filter((entry, index, all) => entry.private_work !== 'allowed' && all.findIndex((other) => other.id === entry.id) === index)
  const names = receives.id === runs.id ? receives.name : `${receives.name} and ${runs.name}`
  const reason = held.length === 0 ? `${names} may see private work`
    : `public work only: ${held.map((entry) => entry.name).join(' and ')} ${held.length === 1 ? 'gets' : 'get'} public work only`
  return { receives, runs, allowed: held.length === 0, reason }
}

/** BMN's first proposal for a judge, as the CLI's `JUDGE_PROPOSAL` holds it (65.1 AC7); the two are compared in a test. */
export const JUDGE_PROPOSAL = {
  receives: { id: 'opencode-zen', name: 'OpenCode Zen', hosts: ['opencode.ai'], sites: ['opencode.ai'], private_work: 'allowed' },
  runs: { id: 'typesafe', name: 'TypeSafe AI', hosts: [], sites: ['typesafe.ai'], private_work: 'allowed' },
  agent: {
    id: 'jev', name: 'Jev', class: 'bishop', harness: ROSTER_CALLED_BY_BMN, model: 'jev-1.13', host: 'opencode.ai', enabled: true, status: 'active', efforts: [], roles: [ROSTER_JUDGE_ROLE],
    paid_by: 'per_token',
    price: { input: 0.042, output: 0, source: 'https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/services/www/src/docs/content/console/models.mdx', as_of: '2026-10-12' }
  },
  description: 'answers typed questions about a text with numbers; advice only'
} as const satisfies { receives: RosterProviderShape; runs: RosterProviderShape; agent: Omit<RosterAgentShape, 'provider' | 'run_by'>; description: string }

/**
 * The team with BMN's judge proposal taken, or null where there is nothing to propose: the team
 * already holds an agent BMN calls or a role judge, or its names are in use. The same rule as the
 * CLI's `judgeProposal`: a provider the team already names for that host keeps its own answer.
 * Mirrored because the renderer cannot load bin modules.
 */
export function judgeProposal(data: RosterDataShape): RosterDataShape | null {
  if (data.agents.some(isCalled) || data.roles.some((role) => role.id === ROSTER_JUDGE_ROLE) || data.agents.some((agent) => agent.id === JUDGE_PROPOSAL.agent.id)) return null
  const providers = [...data.providers]
  const party = (wanted: RosterProviderShape): string => {
    const held = providers.find((provider) => provider.id === wanted.id || wanted.hosts.some((host) => provider.hosts.some((other) => other.toLowerCase() === host)))
    if (held !== undefined) return held.id
    providers.push({ ...wanted, hosts: [...wanted.hosts], ...(wanted.sites ? { sites: [...wanted.sites] } : {}) })
    return wanted.id
  }
  const receives = party(JUDGE_PROPOSAL.receives)
  const runs = party(JUDGE_PROPOSAL.runs)
  if (!providers.find((provider) => provider.id === receives)?.hosts.some((host) => host.toLowerCase() === JUDGE_PROPOSAL.agent.host)) return null
  const { id, name, class: agentClass, harness, model, host, enabled, status, roles, paid_by: paidBy, price } = JUDGE_PROPOSAL.agent
  return {
    ...data, schema_version: ROSTER_SCHEMA_VERSION, providers,
    agents: [...data.agents, { id, name, class: agentClass, harness, model, provider: receives, run_by: runs, host, enabled, status, efforts: [], roles: [...roles], paid_by: paidBy, price: { ...price } }],
    roles: [...data.roles, { id: ROSTER_JUDGE_ROLE, description: JUDGE_PROPOSAL.description, candidates: [id], then: 'skip' }]
  }
}

/** The model an OpenCode agent runs, as `-m` names it: `<provider>/<model>`. */
function openCodeModelOf(agent: RosterAgentShape): string {
  return agent.model.includes('/') ? agent.model : `${agent.provider}/${agent.model}`
}

/**
 * The team with Luna (Go) proposed, or null where there is nothing to propose: the team already
 * holds an OpenCode agent on her model, or the id. She joins the role helper where the team has one,
 * at her highest effort, last in its order; she is named a researcher where the team names its
 * researchers, and researches anyway on a team from before that mark. A proposal only: nothing
 * changes until the owner approves it.
 */
export function lunaGoProposal(data: RosterDataShape): RosterDataShape | null {
  const { provider, agent, role } = LUNA_GO_PROPOSAL
  const model = `${provider.id}/${agent.model}`
  if (data.agents.some((entry) => entry.id === agent.id || (entry.harness === 'opencode' && openCodeModelOf(entry) === model))) return null
  const providers = data.providers.some((entry) => entry.id === provider.id) ? data.providers : [...data.providers, { ...provider, hosts: [] }]
  const added: RosterAgentShape = { ...agent, provider: provider.id, efforts: [...agent.efforts], roles: [], ...(namedResearchers(data) === null ? {} : { researcher: true }) }
  const next: RosterDataShape = { ...data, schema_version: ROSTER_SCHEMA_VERSION, providers, agents: [...data.agents, added] }
  return data.roles.some((entry) => entry.id === role) ? toggleAgentRole(next, agent.id, role) : next
}

/** What BMN's proposal takes out of a team file that still names a retired app. */
export interface RetiredRemoval { agents: string[]; routes: string[]; providers: string[]; lists: boolean }

/**
 * Epic 71 (71.2 AC3): the team file without the app BMN retired. Its agents go, with their places
 * in every role and tool; its route goes; a provider goes once something removed named it and
 * nothing left does. A skill or tool kept to some apps loses the retired one where another app
 * stays; a list naming only the retired app already reaches no app, and stays as written. Null
 * when there is nothing to remove. A proposal only: nothing changes until the owner approves it.
 */
export function retiredAppProposal(data: RosterDataShape): { data: RosterDataShape; removed: RetiredRemoval } | null {
  const gone = data.agents.filter((agent) => isRetiredApp(agent.harness))
  const goneIds = new Set(gone.map((agent) => agent.id))
  const goneRoutes = data.harness_routes.filter((route) => isRetiredApp(route.harness))
  const trim = <T extends string>(apps: T[]): T[] => (apps.every(isRetiredApp) ? apps : apps.filter((app) => !isRetiredApp(app)))
  const skills = data.skills?.map((mark) => (mark.only === undefined ? mark : { ...mark, only: trim(mark.only) }))
  const tools = data.tools?.flatMap((tool) => {
    if (tool.apps !== undefined) return [{ ...tool, apps: trim(tool.apps) }]
    if (tool.agents === undefined || !tool.agents.some((id) => goneIds.has(id))) return [tool]
    const agents = tool.agents.filter((id) => !goneIds.has(id))
    // A tool kept to the runs of the removed agents alone was theirs.
    return agents.length === 0 ? [] : [{ ...tool, agents }]
  })
  const kept = data.agents.filter((agent) => !goneIds.has(agent.id))
  const routes = data.harness_routes.filter((route) => !isRetiredApp(route.harness))
  const named = new Set([...kept.flatMap((agent) => [agent.provider, ...(agent.run_by === undefined ? [] : [agent.run_by])]),
    ...routes.map((route) => route.provider), ...data.exceptions.map((entry) => entry.provider)])
  const touched = new Set([...gone.map((agent) => agent.provider), ...goneRoutes.map((route) => route.provider)])
  const goneProviders = data.providers.filter((provider) => touched.has(provider.id) && !named.has(provider.id))
  const next: RosterDataShape = {
    ...data,
    agents: kept,
    roles: data.roles.map((role) => [...goneIds].reduce(withoutAgent, role)),
    providers: data.providers.filter((provider) => !goneProviders.includes(provider)),
    harness_routes: routes,
    ...(skills === undefined ? {} : { skills }),
    ...(tools === undefined ? {} : { tools })
  }
  const lists = JSON.stringify([skills, tools]) !== JSON.stringify([data.skills, data.tools])
  if (gone.length === 0 && goneRoutes.length === 0 && !lists) return null
  return {
    data: { ...next, schema_version: ROSTER_SCHEMA_VERSION },
    removed: { agents: gone.map((agent) => agent.name), routes: goneRoutes.map((route) => route.harness), providers: goneProviders.map((provider) => provider.name), lists }
  }
}

/** The providers a destination may be set to: none that only a retired app's lines name (Epic 71, the 71.1 design notes). */
export function destinationProviders(data: RosterDataShape): RosterProviderShape[] {
  const proposal = retiredAppProposal(data)
  return proposal === null ? data.providers : data.providers.filter((provider) => proposal.data.providers.some((kept) => kept.id === provider.id))
}

/**
 * An agent with no role, turned into one BMN calls: it runs in no app, so what belongs to an app
 * leaves it (efforts, context fields, the researcher mark) and its provider is named as the one
 * that runs the model too, until the owner names another. An agent that holds a role stays as it is.
 */
export function callByBmn(data: RosterDataShape, agentId: string): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined || isCalled(agent) || agent.roles.length > 0) return data
  const called: RosterAgentShape = { ...agent, harness: ROSTER_CALLED_BY_BMN, run_by: agent.provider, efforts: [] }
  for (const key of ['context_window', 'context_limit', 'compact_at', 'researcher'] as const) delete called[key]
  return { ...data, schema_version: ROSTER_SCHEMA_VERSION, agents: data.agents.map((entry) => (entry.id === agentId ? called : entry)) }
}

/** An id from a name: lower case, digits and dashes, at most 32 characters, distinct from the ids taken. */
export function idFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'agent'
  if (!taken.includes(base)) return base
  for (let suffix = 2; ; suffix += 1) if (!taken.includes(`${base}-${suffix}`)) return `${base}-${suffix}`
}

/** The provider each app reaches when nothing overrides it; the roster's own record wins when it has one. */
const APP_PROVIDERS: Readonly<Record<RosterHarness, { id: string; name: string }>> = {
  claude: { id: 'anthropic', name: 'Anthropic' }, codex: { id: 'openai', name: 'OpenAI' },
  opencode: { id: 'opencode-go', name: 'OpenCode Go' }
}

interface Landing {
  /** The provider a new agent would run on. */
  provider: { id: string; name: string }
  /** True when the roster has no such provider yet, so its private-work answer must be asked. */
  isNew: boolean
  /** A custom host, as the roster would record it; null for the provider's own servers. */
  host: string | null
}

/** Where an agent on `harness` with `host` ("" or "default" for the provider's own servers) would run. */
export function landingFor(data: RosterDataShape, harness: RosterHarness, host: string): Landing {
  const custom = host.trim().toLowerCase()
  if (custom === '' || custom === 'default') {
    const recorded = data.harness_routes.find((route) => route.harness === harness)?.provider ?? APP_PROVIDERS[harness].id
    const known = data.providers.find((provider) => provider.id === recorded)
    return { provider: known ? { id: known.id, name: known.name } : recorded === APP_PROVIDERS[harness].id ? APP_PROVIDERS[harness] : { id: recorded, name: recorded }, isNew: known === undefined, host: null }
  }
  const owner = data.providers.find((provider) => provider.hosts.some((entry) => entry.toLowerCase() === custom))
  if (owner) return { provider: { id: owner.id, name: owner.name }, isNew: false, host: custom }
  return { provider: { id: idFor(custom.replace(/:\d+$/, ''), data.providers.map((provider) => provider.id)), name: custom }, isNew: true, host: custom }
}

export interface NewAgent {
  name: string
  class: RosterClass
  harness: RosterHarness
  model: string
  host: string
  /** Asked only when the provider is new to the roster. */
  privateWork: RosterPrivateWork
  roles: string[]
  efforts: RosterEffort[]
  contextLimit?: number
  /** A price and a capacity research found for the model; they come before what an agent on the same model records. */
  price?: RosterPriceShape
  contextWindow?: number
}

/**
 * How an app the roster has no destination for is recorded: as inspected when BMN's own reading of
 * the app reaches that provider's servers (checked again at approval), else on the owner's word.
 */
export function unrecordedBasis(harness: RosterHarness, provider: string, apps: readonly AgentAppView[] | null | undefined): RosterRouteShape['basis'] {
  const app = apps?.find((entry) => entry.harness === harness)
  return app !== undefined && app.basis === 'default' && app.provider === provider ? 'observed-default' : 'owner-declared'
}

/**
 * An agent already on the team that runs the same model through the same app on the same provider:
 * what the team recorded about that model (its price, its capacity) holds for a new agent too.
 */
export function modelTwin(data: RosterDataShape, harness: RosterAgentShape['harness'], provider: string, model: string): RosterAgentShape | undefined {
  const name = model.trim()
  if (name === '') return undefined
  const twins = data.agents.filter((agent) => agent.harness === harness && agent.provider === provider && agent.model === name)
  return twins.find((agent) => agent.price !== undefined) ?? twins.find((agent) => agent.context_window !== undefined) ?? twins[0]
}

/**
 * A new model name on an agent. Its price and capacity are facts about a model, so they follow the
 * name where the team knows it: from an agent on the same app, provider and model, and back to the
 * approved values when the name is the approved one again or no such agent exists. In that last
 * case they still describe the earlier model, and the page says so and offers to clear them.
 */
export function changeModel(data: RosterDataShape, id: string, model: string, approved?: RosterAgentShape): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === id)
  if (!agent) return data
  const others = { ...data, agents: data.agents.filter((entry) => entry.id !== id) }
  const twin = approved?.model === model ? undefined : modelTwin(others, agent.harness, agent.provider, model)
  const base = approved ?? agent
  return updateAgent(data, id, { model, price: twin?.price ?? base.price, context_window: twin?.context_window ?? base.context_window })
}

/**
 * Adds an agent as active, with its provider when the roster does not know it and, for an app the
 * roster has no destination for, that app recorded as BMN inspected it (`apps`, from Integrations › Health)
 * or else on the owner's word (public work only until it is inspected). A model the team already
 * runs brings its recorded price and capacity along.
 */
export function addAgent(data: RosterDataShape, draft: NewAgent, apps?: readonly AgentAppView[] | null): { data: RosterDataShape; id: string } {
  const landing = landingFor(data, draft.harness, draft.host)
  const id = idFor(draft.name, data.agents.map((agent) => agent.id))
  const twin = modelTwin(data, draft.harness, landing.provider.id, draft.model)
  const agent: RosterAgentShape = {
    id, name: draft.name.trim(), class: draft.class, harness: draft.harness, model: draft.model.trim(), provider: landing.provider.id,
    host: landing.host ?? 'default', enabled: true, status: 'active', efforts: draft.efforts, roles: [],
    ...(draft.contextLimit === undefined ? {} : { context_limit: draft.contextLimit }),
    ...((draft.price ?? twin?.price) === undefined ? {} : { price: (draft.price ?? twin?.price) as RosterPriceShape }),
    ...((draft.contextWindow ?? twin?.context_window) === undefined ? {} : { context_window: (draft.contextWindow ?? twin?.context_window) as number })
  }
  let next: RosterDataShape = {
    ...data,
    agents: [...data.agents, agent],
    providers: landing.isNew
      ? [...data.providers, { id: landing.provider.id, name: landing.provider.name, hosts: landing.host === null ? [] : [landing.host], private_work: draft.privateWork }]
      : data.providers,
    harness_routes: landing.host === null && !data.harness_routes.some((route) => route.harness === draft.harness)
      ? [...data.harness_routes, { harness: draft.harness, provider: landing.provider.id, basis: unrecordedBasis(draft.harness, landing.provider.id, apps) }]
      : data.harness_routes
  }
  for (const role of draft.roles) next = toggleAgentRole(next, id, role)
  return { data: next, id }
}

/**
 * Moves an agent to another app or host. It lands on the provider that app or host reaches; a
 * provider new to the roster is added with `answer` (Public work only unless the owner said otherwise);
 * an app without a recorded destination is recorded as `addAgent` records it.
 */
export function moveAgent(data: RosterDataShape, agentId: string, harness: RosterHarness, host: string, answer: RosterPrivateWork = 'public_only',
  apps?: readonly AgentAppView[] | null): RosterDataShape {
  const landing = landingFor(data, harness, host)
  return {
    ...data,
    agents: data.agents.map((agent) => (agent.id === agentId ? { ...agent, harness, provider: landing.provider.id, host: landing.host ?? 'default' } : agent)),
    providers: landing.isNew
      ? [...data.providers, { id: landing.provider.id, name: landing.provider.name, hosts: landing.host === null ? [] : [landing.host], private_work: answer }]
      : data.providers,
    harness_routes: landing.host === null && !data.harness_routes.some((route) => route.harness === harness)
      ? [...data.harness_routes, { harness, provider: landing.provider.id, basis: unrecordedBasis(harness, landing.provider.id, apps) }]
      : data.harness_routes
  }
}

/**
 * What adding an agent means, in words, for the New agent footer. Until 60.8's guard stops a
 * public-only lead itself, the true consequence is the check's refusal.
 */
export function newAgentConsequence(name: string, provider: string, answer: RosterPrivateWork, declared: boolean): string {
  const who = name.trim() === '' ? 'This agent' : name.trim()
  if (declared) return `${who} gets public work only: BMN can't confirm where its app sends data.`
  return answer === 'allowed' ? `${who} may receive private work, like every agent on ${provider}.`
    : `${who} gets public work only. Private work is refused for it until you allow ${provider}.`
}

/** A new role at the end of the list; candidates take it at their highest effort. */
export function addRole(data: RosterDataShape, name: string, line: string, candidates: readonly string[]): RosterDataShape {
  const id = idFor(name, data.roles.map((role) => role.id))
  let next: RosterDataShape = { ...data, roles: [...data.roles, { id, ...(line.trim() === '' ? {} : { description: line.trim() }), candidates: [], then: 'lead' }] }
  for (const agent of candidates) next = toggleAgentRole(next, agent, id)
  return next
}

/**
 * Records where an app sends data: its provider's own servers as BMN inspected them, or the
 * owner's word. A new record replaces any accepted versions, which belonged to the old destination.
 */
export function setDestination(data: RosterDataShape, harness: RosterHarness, provider: { id: string; name: string }, basis: RosterRouteShape['basis']): RosterDataShape {
  const route: RosterRouteShape = { harness, provider: provider.id, basis }
  const order = Object.keys(ROSTER_APP_NAMES)
  const routes = [...data.harness_routes.filter((entry) => entry.harness !== harness), route].sort((a, b) => order.indexOf(a.harness) - order.indexOf(b.harness))
  return {
    ...data,
    providers: data.providers.some((entry) => entry.id === provider.id) ? data.providers
      : [...data.providers, { id: provider.id, name: provider.name, hosts: [], private_work: 'public_only' as const }],
    harness_routes: routes
  }
}

/** Removing a version accepted under the earlier rule; the list is no longer read (every installed version is supported). */
export function revokeVersion(data: RosterDataShape, harness: RosterHarness, version: string): RosterDataShape {
  return {
    ...data,
    harness_routes: data.harness_routes.map((route) => {
      if (route.harness !== harness) return route
      const rest = (route.accepted_versions ?? []).filter((entry) => entry !== version)
      const next: RosterRouteShape = { ...route }
      if (rest.length > 0) next.accepted_versions = rest
      else delete next.accepted_versions
      return next
    })
  }
}

export function agentGroups(data: RosterDataShape): { active: RosterAgentShape[]; proposed: RosterAgentShape[]; off: RosterAgentShape[] } {
  return {
    active: data.agents.filter((agent) => agent.status === 'active' && agent.enabled),
    proposed: data.agents.filter((agent) => agent.status === 'proposed'),
    off: data.agents.filter((agent) => agent.status === 'active' && !agent.enabled)
  }
}

/** Sections with an unapproved difference: the dot on a card and beside Team. */
export function changedSections(diffs: readonly RosterDiffShape[] | null): Set<RosterSection> {
  return new Set((diffs ?? []).map(sectionOf))
}

export function sameData(a: RosterDataShape | null, b: RosterDataShape | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
