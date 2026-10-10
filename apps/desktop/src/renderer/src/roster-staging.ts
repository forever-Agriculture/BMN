// MODULE: roster-staging.ts - Epic 60.5: the Team pages' staged edits, review rows and their words, kept pure for tests
import {
  ROSTER_APP_NAMES,
  ROSTER_DESIGNER_ROLE,
  ROSTER_LEAD_ROLE,
  type RosterAgentShape,
  type RosterClass,
  type RosterDataShape,
  type RosterDiffShape,
  type RosterEffort,
  type RosterHarness,
  type RosterPrivateWork,
  type RosterProviderShape,
  type RosterRoleShape,
  type RosterRouteShape,
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
  queen: { name: 'Queen', line: 'designs and thinks creatively' },
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
  'harness-routes': 'Agent apps'
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  name: 'Name', class: 'Class', harness: 'Agent app', model: 'Model', provider: 'Provider', host: 'Host', enabled: 'On', status: 'Status',
  efforts: 'Efforts', roles: 'Roles', aliases: 'Also called', enabled_note: 'Reason it is off', context_window: 'Capacity', context_limit: 'Context limit',
  compact_at: 'Compact at', paid_by: 'Paid by', price: 'Price', description: 'Line', candidates: 'Order', then: 'If all fail', recheck: 'Recheck',
  small_work: 'Small work', hosts: 'Hosts', sites: 'Sites', private_work: 'Private work', folder: 'Workspace', basis: 'Destination', accepted_versions: 'Accepted versions',
  input: 'In', cached_input: 'Cached in', output: 'Out', source: 'Source', as_of: 'As of'
}

const VALUE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  class: Object.fromEntries(Object.entries(CLASS_WORDS).map(([key, words]) => [key, words.name])),
  harness: ROSTER_APP_NAMES,
  then: THEN_WORDS,
  private_work: PRIVATE_WORK_WORDS,
  paid_by: { per_token: 'Per token', subscription: 'Subscription' },
  enabled: { true: 'yes', false: 'no' },
  host: { default: 'Provider default' },
  basis: { 'observed-default': "its provider's own servers, as inspected", 'owner-declared': 'on your word' }
}

/** A role id as a name: `epic-reviewer` reads "Epic reviewer". */
export function roleName(id: string): string {
  const words = id.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** 272000 reads "272 000". */
export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/** "$1.25 / $10.00" per million tokens, in / out; null when the agent has no price. */
export function priceWords(agent: Pick<RosterAgentShape, 'price'>): string | null {
  return agent.price === undefined ? null : `$${agent.price.input.toFixed(2)} / $${agent.price.output.toFixed(2)}`
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

function formatPlain(value: unknown, field: string | undefined, names: Names): string {
  if (value === null || value === undefined) return 'none'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none'
    if (field === 'candidates') return value.map((entry) => candidateWords(String(entry), names)).join(', ')
    if (field === 'roles') return value.map((entry) => roleName(String(entry))).join(', ')
    return value.map((entry) => formatPlain(entry, undefined, names)).join(', ')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // A recheck names who rechecks and at which effort: `{same_reviewer: true, astra: low}`.
    if (field === 'recheck') {
      return entries.map(([key, entry]) => key === 'same_reviewer' ? (entry === true ? 'the same reviewer' : 'another reviewer') : `${names.agents.get(key) ?? key} ${String(entry)}`).join(' · ')
    }
    return entries.map(([key, entry]) => `${(FIELD_WORDS[key] ?? key).toLowerCase()} ${formatPlain(entry, key, names)}`).join(' · ')
  }
  if (field === 'small_work') return candidateWords(String(value), names)
  if (field === 'provider') return names.providers.get(String(value)) ?? String(value)
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

function fieldWords(diff: RosterDiffShape, names: Names): string {
  const word = FIELD_WORDS[diff.field ?? ''] ?? diff.field ?? ''
  if (diff.scope === 'agent') return word
  const provider = (id: string): string => names.providers.get(id) ?? id
  const subject = diff.scope === 'roles' ? roleName(diff.id)
    : diff.scope === 'harness-routes' ? ROSTER_APP_NAMES[diff.id as RosterHarness] ?? diff.id
      : diff.scope === 'providers' ? provider(diff.id)
        : diff.scope === 'exceptions' ? provider(names.exceptions.get(diff.id) ?? diff.id) : diff.id
  return word === '' ? subject : `${subject} · ${word.toLowerCase()}`
}

const candidatesOf = (side: RosterDiffShape['before']): string[] | null =>
  side?.present && side.hash === undefined && Array.isArray(side.value) ? side.value.map(String) : null

function lineFor(diff: RosterDiffShape, names: Names): DiffLine {
  const line: DiffLine = { field: fieldWords(diff, names), before: formatValue(diff.before, diff.field ?? undefined, names), after: formatValue(diff.after, diff.field ?? undefined, names) }
  return diff.field === 'candidates' ? { ...line, chain: { before: candidatesOf(diff.before), after: candidatesOf(diff.after) } } : line
}

/** An added or removed entry shows every value it carries, one line per field (60.5 AC2). */
function linesFor(diff: RosterDiffShape, names: Names): DiffLine[] {
  if (diff.field !== null) return [lineFor(diff, names)]
  const added = diff.kind === 'added'
  const side = added ? diff.after : diff.before
  const head: DiffLine = { field: fieldWords({ ...diff, field: null }, names) || 'Agent', before: added ? '—' : 'present', after: added ? 'added' : 'removed' }
  if (!side?.present || side.value === null || typeof side.value !== 'object') return [head]
  const hidden = new Set(['id', ...(diff.scope === 'harness-routes' ? ['harness'] : [])])
  return [head, ...Object.entries(side.value as Record<string, unknown>).filter(([key]) => !hidden.has(key)).map(([key, value]) => {
    const text = typeof value === 'string' && value.startsWith('text ') ? 'set' : formatPlain(value, key, names)
    return { field: fieldWords({ ...diff, field: key }, names), before: added ? '—' : text, after: added ? text : '—', detail: true as const }
  })]
}

function claimant(sentence: string, groups: DiffGroup[], roleIds: ReadonlySet<string>): DiffGroup | undefined {
  const agentGroup = groups.find((group) => group.agent !== undefined && (sentence.startsWith(`${group.subject} `) || sentence.startsWith(`${group.subject}: `)))
  if (agentGroup) return agentGroup
  const section = (key: string): DiffGroup | undefined => groups.find((group) => group.key === key)
  if (sentence.startsWith('Changing ')) return section('providers')
  if (/ could (no longer )?receive private work in /.test(sentence)) return section('exceptions')
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
    group.lines.push(...linesFor(diff, names))
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
 * chain the page draws. Sentences about neither stay in `general`.
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
  return target.change === 'link' ? 'Becomes a link again' : target.change === 'missing' ? 'Removed again' : `Put back · ${diffSummary(target.diff)}`
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

export type AgentPatch = { [Key in Exclude<keyof RosterAgentShape, 'id' | 'roles' | 'class'>]?: RosterAgentShape[Key] | undefined }

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

export interface Candidate { agent: string; efforts: RosterEffort[]; choice: boolean }

export function parseCandidate(text: string): Candidate {
  const [agent = '', efforts = ''] = text.split('@')
  return { agent, efforts: efforts.split('|').filter(Boolean) as RosterEffort[], choice: efforts.includes('|') }
}

export function formatCandidate(candidate: Pick<Candidate, 'agent' | 'efforts'>): string {
  return `${candidate.agent}@${candidate.efforts.join('|')}`
}

/** "max", or "medium or high" where the lead chooses. */
export function effortWords(candidate: Pick<Candidate, 'efforts'>): string {
  return candidate.efforts.join(' or ')
}

/** Why a class may not hold a role, or null when it may: only a Knight leads, only a Queen designs. */
export function classBar(agentClass: RosterClass, roleId: string): string | null {
  if (roleId === ROSTER_LEAD_ROLE && agentClass !== 'knight') return 'Only a Knight leads'
  if (roleId === ROSTER_DESIGNER_ROLE && agentClass !== 'queen') return 'Only a Queen designs'
  return null
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
 * both change together: holding adds it last in the chain at its highest effort, releasing removes
 * it. A role its class may not hold is never added.
 */
export function toggleAgentRole(data: RosterDataShape, agentId: string, roleId: string): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined) return data
  const holds = agent.roles.includes(roleId)
  if (!holds && classBar(agent.class, roleId) !== null) return data
  const top = agent.efforts.at(-1)
  if (!holds && top === undefined) return data
  const agents = data.agents.map((entry) => entry.id !== agentId ? entry
    : { ...entry, roles: holds ? entry.roles.filter((role) => role !== roleId) : [...entry.roles, roleId] })
  const roles = data.roles.map((role) => {
    if (role.id !== roleId) return role
    if (holds) return withoutAgent(role, agentId)
    return top === undefined || role.candidates.some((text) => parseCandidate(text).agent === agentId) ? role
      : { ...role, candidates: [...role.candidates, formatCandidate({ agent: agentId, efforts: [top] })] }
  })
  return { ...data, agents, roles }
}

/** A new class; roles the class may not hold leave the agent and their chains with it. */
export function setAgentClass(data: RosterDataShape, agentId: string, agentClass: RosterClass): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined || agent.class === agentClass) return data
  let next = data
  for (const role of agent.roles) if (classBar(agentClass, role) !== null) next = toggleAgentRole(next, agentId, role)
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

export function agentsOnProvider(data: RosterDataShape, providerId: string): RosterAgentShape[] {
  return data.agents.filter((agent) => agent.provider === providerId)
}

export function providerOf(data: RosterDataShape, agent: Pick<RosterAgentShape, 'provider'>): RosterProviderShape | undefined {
  return data.providers.find((provider) => provider.id === agent.provider)
}

/** Whether an agent's provider answers Public work only (an unknown provider does). */
export function publicOnly(data: RosterDataShape, agent: Pick<RosterAgentShape, 'provider'>): boolean {
  return providerOf(data, agent)?.private_work !== 'allowed'
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
  opencode: { id: 'opencode-go', name: 'OpenCode Go' }, cursor: { id: 'cursor', name: 'Cursor' }
}

export interface Landing {
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
}

/**
 * Adds an agent as active, with its provider when the roster does not know it and, for an app the
 * roster has no destination for, that app recorded on the owner's word (public work only until
 * Rules › Health inspects it).
 */
export function addAgent(data: RosterDataShape, draft: NewAgent): { data: RosterDataShape; id: string } {
  const landing = landingFor(data, draft.harness, draft.host)
  const id = idFor(draft.name, data.agents.map((agent) => agent.id))
  const agent: RosterAgentShape = {
    id, name: draft.name.trim(), class: draft.class, harness: draft.harness, model: draft.model.trim(), provider: landing.provider.id,
    host: landing.host ?? 'default', enabled: true, status: 'active', efforts: draft.efforts, roles: [],
    ...(draft.contextLimit === undefined ? {} : { context_limit: draft.contextLimit })
  }
  let next: RosterDataShape = {
    ...data,
    agents: [...data.agents, agent],
    providers: landing.isNew
      ? [...data.providers, { id: landing.provider.id, name: landing.provider.name, hosts: landing.host === null ? [] : [landing.host], private_work: draft.privateWork }]
      : data.providers,
    harness_routes: landing.host === null && !data.harness_routes.some((route) => route.harness === draft.harness)
      ? [...data.harness_routes, { harness: draft.harness, provider: landing.provider.id, basis: 'owner-declared' as const }]
      : data.harness_routes
  }
  for (const role of draft.roles) next = toggleAgentRole(next, id, role)
  return { data: next, id }
}

/**
 * Moves an agent to another app or host. It lands on the provider that app or host reaches; a
 * provider new to the roster is added with `answer` (Public work only unless the owner said otherwise).
 */
export function moveAgent(data: RosterDataShape, agentId: string, harness: RosterHarness, host: string, answer: RosterPrivateWork = 'public_only'): RosterDataShape {
  const landing = landingFor(data, harness, host)
  return {
    ...data,
    agents: data.agents.map((agent) => (agent.id === agentId ? { ...agent, harness, provider: landing.provider.id, host: landing.host ?? 'default' } : agent)),
    providers: landing.isNew
      ? [...data.providers, { id: landing.provider.id, name: landing.provider.name, hosts: landing.host === null ? [] : [landing.host], private_work: answer }]
      : data.providers,
    harness_routes: landing.host === null && !data.harness_routes.some((route) => route.harness === harness)
      ? [...data.harness_routes, { harness, provider: landing.provider.id, basis: 'owner-declared' as const }]
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

export function updateRoute(data: RosterDataShape, harness: RosterHarness, patch: Partial<Omit<RosterRouteShape, 'harness'>>): RosterDataShape {
  return { ...data, harness_routes: data.harness_routes.map((route) => (route.harness === harness ? { ...route, ...patch } : route)) }
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

/** Accepting an inspected app version adds it to the app's accepted list (60.3 AC3). */
export function acceptVersion(data: RosterDataShape, harness: RosterHarness, version: string): RosterDataShape {
  const route = data.harness_routes.find((entry) => entry.harness === harness)
  if (route === undefined || (route.accepted_versions ?? []).includes(version)) return data
  return updateRoute(data, harness, { accepted_versions: [...(route.accepted_versions ?? []), version] })
}

/** Removing an accepted version: private work stops on it again until it is accepted anew. */
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
