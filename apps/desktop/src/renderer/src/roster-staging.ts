// MODULE: roster-staging.ts - Epic 60.5: the Agents section's staged edits, grouped diff rows and their words, kept pure for tests
import type { RosterAgentShape, RosterDataShape, RosterDiffShape, RosterEffort, RosterHarness, RosterRoleShape, RosterRouteShape } from '@bmn/protocol'

/** A section a row names, as the approval writer and `revertAgents` take it. */
export type RosterSection = string

export interface DiffLine { field: string; before: string; after: string }

export interface DiffGroup {
  /** Section id: an agent id, `roles`, `data-labels` or `harness-routes`. */
  key: RosterSection
  subject: string
  agent?: RosterAgentShape
  lines: DiffLine[]
  consequences: string[]
}

const SECTION_SUBJECTS: Readonly<Record<string, string>> = {
  roles: 'Roles',
  'data-labels': 'Workspace labels',
  'harness-routes': 'Harness routes'
}

function sectionOf(diff: RosterDiffShape): RosterSection {
  return diff.scope === 'agent' ? diff.id : diff.scope
}

/** One value as the diff shows it; free text shows only that it changed, never its words outside the editor. */
export function formatValue(side: RosterDiffShape['before']): string {
  if (side === undefined || !side.present) return '—'
  if (side.hash !== undefined) return `text ${side.hash.slice(0, 8)}`
  return formatPlain(side.value)
}

function formatPlain(value: unknown): string {
  if (value === null || value === undefined) return 'none'
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(formatPlain).join(', ')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key} ${formatPlain(entry)}`).join(' · ')
  }
  return String(value)
}

/** An added or removed entry shows every value it carries, one line per field (60.5 AC2). */
function linesFor(diff: RosterDiffShape): DiffLine[] {
  if (diff.field !== null) return [lineFor(diff)]
  const side = diff.kind === 'added' ? diff.after : diff.before
  const prefix = diff.scope === 'agent' ? '' : `${diff.id} `
  const head: DiffLine = { field: diff.scope === 'agent' ? 'agent' : diff.id, before: diff.kind === 'added' ? '—' : 'present', after: diff.kind === 'removed' ? 'removed' : 'added' }
  if (!side?.present || side.value === null || typeof side.value !== 'object') return [head]
  return [head, ...Object.entries(side.value as Record<string, unknown>).filter(([key]) => key !== 'id' && !(diff.scope === 'harness-routes' && key === 'harness')).map(([key, value]) => {
    const text = formatPlain(value)
    return { field: `${prefix}${key}`, before: diff.kind === 'added' ? '—' : text, after: diff.kind === 'added' ? text : '—' }
  })]
}

function lineFor(diff: RosterDiffShape): DiffLine {
  const field = diff.scope === 'agent' ? diff.field ?? 'agent'
    : diff.scope === 'roles' ? `${diff.id} ${diff.field}`
      : diff.scope === 'data-labels' ? (diff.id === 'default' ? 'default' : diff.id)
        : `${diff.id} ${diff.field}`
  return { field, before: formatValue(diff.before), after: formatValue(diff.after) }
}

/**
 * Groups machine differences into one row per agent or shared section, and gives each row the
 * consequence sentences about it (the sentences come from 60.3's `consequences`, the same words
 * `bmn roster status` prints). Sentences no row claims stay in `general`.
 */
export function groupDifferences(diffs: readonly RosterDiffShape[], data: RosterDataShape | null, approved: RosterDataShape | null,
  sentences: readonly string[]): { groups: DiffGroup[]; general: string[] } {
  const agentById = new Map([...(approved?.agents ?? []), ...(data?.agents ?? [])].map((agent) => [agent.id, agent]))
  const groups = new Map<RosterSection, DiffGroup>()
  for (const diff of diffs) {
    const key = sectionOf(diff)
    let group = groups.get(key)
    if (group === undefined) {
      const agent = diff.scope === 'agent' ? agentById.get(diff.id) : undefined
      group = { key, subject: agent?.name ?? SECTION_SUBJECTS[key] ?? key, lines: [], consequences: [], ...(agent ? { agent } : {}) }
      groups.set(key, group)
    }
    group.lines.push(...linesFor(diff))
  }
  const general: string[] = []
  const roleIds = new Set([...(data?.roles ?? []), ...(approved?.roles ?? [])].map((role) => role.id))
  for (const sentence of sentences) {
    const owner = claimant(sentence, [...groups.values()], roleIds)
    if (owner) owner.consequences.push(sentence)
    else general.push(sentence)
  }
  return { groups: [...groups.values()], general }
}

/**
 * Display only: the confirm band's unclaimed sentences gathered under the agent or role they name,
 * so a first approval reads agent by agent instead of as one list. These rows carry no differences
 * and no section to approve; whatever names nothing stays in `general`.
 */
export function groupConsequences(sentences: readonly string[], data: RosterDataShape | null,
  approved: RosterDataShape | null): { groups: DiffGroup[]; general: string[] } {
  const agents = [...(data?.agents ?? []), ...(approved?.agents ?? [])]
  const roleIds = new Set([...(data?.roles ?? []), ...(approved?.roles ?? [])].map((role) => role.id))
  const groups = new Map<string, DiffGroup>()
  const general: string[] = []
  for (const sentence of sentences) {
    const agent = agents.find((entry) => sentence.startsWith(`${entry.name} `))
    const roleWord = /^(?:when every |the )?([a-z0-9-]+) /.exec(sentence)?.[1]
    const key = agent ? `agent:${agent.id}` : roleWord !== undefined && roleIds.has(roleWord) ? 'roles' : null
    if (key === null) { general.push(sentence); continue }
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, subject: agent?.name ?? 'Roles', lines: [], consequences: [], ...(agent ? { agent } : {}) }
      groups.set(key, group)
    }
    group.consequences.push(sentence)
  }
  return { groups: [...groups.values()], general }
}

function claimant(sentence: string, groups: DiffGroup[], roleIds: ReadonlySet<string>): DiffGroup | undefined {
  const agentGroup = groups.find((group) => group.agent !== undefined && sentence.startsWith(`${group.subject} `))
  if (agentGroup) return agentGroup
  const section = (key: string): DiffGroup | undefined => groups.find((group) => group.key === key)
  if (sentence.startsWith('/') || sentence.startsWith('unlabelled workspaces')) return section('data-labels')
  if (sentence.includes(' could carry private work') || sentence.includes(' could no longer carry private work (acceptance revoked)')) return section('harness-routes')
  const roleWord = /^(?:when every |the )?([a-z0-9-]+) /.exec(sentence)?.[1]
  if (roleWord !== undefined && roleIds.has(roleWord)) return section('roles')
  return undefined
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}

/** "3 changes in 2 agents and 1 role" - the band's first sentence. */
export function summarize(diffs: readonly RosterDiffShape[]): string {
  if (diffs.length === 0) return 'No machine changes'
  const agents = new Set(diffs.filter((diff) => diff.scope === 'agent').map((diff) => diff.id)).size
  const roles = new Set(diffs.filter((diff) => diff.scope === 'roles').map((diff) => diff.id)).size
  const labels = diffs.filter((diff) => diff.scope === 'data-labels').length
  const routes = new Set(diffs.filter((diff) => diff.scope === 'harness-routes').map((diff) => diff.id)).size
  const parts = [
    agents > 0 ? plural(agents, 'agent') : null,
    roles > 0 ? plural(roles, 'role') : null,
    labels > 0 ? plural(labels, 'label') : null,
    routes > 0 ? plural(routes, 'route') : null
  ].filter((part): part is string => part !== null)
  const listed = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `${plural(diffs.length, 'change')} in ${listed}`
}

// ---------------------------------------------------------------------------------------------
// Edits: every helper returns new data and never mutates its input.

export type AgentPatch = { [Key in Exclude<keyof RosterAgentShape, 'id' | 'roles'>]?: RosterAgentShape[Key] | undefined }

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
 * cannot be removed. Two or more make an effort choice ("lead chooses").
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

export function setRoleThen(data: RosterDataShape, roleId: string, then: RosterRoleShape['then']): RosterDataShape {
  return updateRole(data, roleId, (role) => ({ ...role, then }))
}

/** Same-reviewer recheck on or off; turning it off drops the per-agent effort overrides with it. */
export function setRecheck(data: RosterDataShape, roleId: string, sameReviewer: boolean): RosterDataShape {
  return updateRole(data, roleId, (role) => {
    const next: RosterRoleShape = { ...role }
    if (sameReviewer) next.recheck = { ...(role.recheck ?? {}), same_reviewer: true }
    else delete next.recheck
    return next
  })
}

/** A per-agent recheck effort for one role; null returns that agent to the effort it reviewed at. */
export function setRecheckEffort(data: RosterDataShape, roleId: string, agentId: string, effort: RosterEffort | null): RosterDataShape {
  return updateRole(data, roleId, (role) => {
    const recheck: Record<string, boolean | string> = { ...(role.recheck ?? { same_reviewer: true }) }
    if (effort === null) delete recheck[agentId]
    else recheck[agentId] = effort
    return { ...role, recheck }
  })
}

export function setSmallEpic(data: RosterDataShape, roleId: string, candidate: string | null): RosterDataShape {
  return updateRole(data, roleId, (role) => {
    const next: RosterRoleShape = { ...role }
    if (candidate === null || candidate.trim() === '') delete next.small_epic
    else next.small_epic = candidate.trim()
    return next
  })
}

/**
 * An agent holds a role exactly when it is one of the role's candidates (60.1's ROLE_NOT_HELD), so
 * both change together: holding adds it last in the chain at its highest effort, releasing removes it.
 */
export function toggleAgentRole(data: RosterDataShape, agentId: string, roleId: string): RosterDataShape {
  const agent = data.agents.find((entry) => entry.id === agentId)
  if (agent === undefined) return data
  const holds = agent.roles.includes(roleId)
  const agents = data.agents.map((entry) => entry.id !== agentId ? entry
    : { ...entry, roles: holds ? entry.roles.filter((role) => role !== roleId) : [...entry.roles, roleId] })
  const top = agent.efforts.at(-1)
  const roles = data.roles.map((role) => {
    if (role.id !== roleId) return role
    if (holds) {
      const next: RosterRoleShape = { ...role, candidates: role.candidates.filter((text) => parseCandidate(text).agent !== agentId) }
      if (next.recheck && Object.hasOwn(next.recheck, agentId)) {
        const rest = { ...next.recheck }
        delete rest[agentId]
        next.recheck = rest
      }
      if (next.small_epic && parseCandidate(next.small_epic).agent === agentId) delete next.small_epic
      return next
    }
    return top === undefined || role.candidates.some((text) => parseCandidate(text).agent === agentId) ? role
      : { ...role, candidates: [...role.candidates, formatCandidate({ agent: agentId, efforts: [top] })] }
  })
  return { ...data, agents, roles }
}

/** Explicit label for a path, or `null` to remove it so the path inherits again. */
export function setLabel(data: RosterDataShape, path: string, label: 'public' | 'private' | null): RosterDataShape {
  const paths = data.data_labels.paths.filter((entry) => entry.path !== path)
  if (label !== null) paths.push({ path, label })
  paths.sort((a, b) => a.path.localeCompare(b.path))
  return { ...data, data_labels: { ...data.data_labels, paths } }
}

export function setDefaultLabel(data: RosterDataShape, label: 'public' | 'private'): RosterDataShape {
  return { ...data, data_labels: { ...data.data_labels, default: label } }
}

export function updateRoute(data: RosterDataShape, harness: RosterHarness, patch: Partial<Omit<RosterRouteShape, 'harness'>>): RosterDataShape {
  return { ...data, harness_routes: data.harness_routes.map((route) => (route.harness === harness ? { ...route, ...patch } : route)) }
}

/** Accepting an inspected harness version adds it to the route's accepted list (60.3 AC6). */
export function acceptVersion(data: RosterDataShape, harness: RosterHarness, version: string): RosterDataShape {
  const route = data.harness_routes.find((entry) => entry.harness === harness)
  if (route === undefined || (route.accepted_versions ?? []).includes(version)) return data
  return updateRoute(data, harness, { accepted_versions: [...(route.accepted_versions ?? []), version] })
}

/** Revoking an accepted version: private work refuses on it again until it is accepted anew. */
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

export function agentGroups(data: RosterDataShape): { active: RosterAgentShape[]; proposed: RosterAgentShape[]; disabled: RosterAgentShape[] } {
  return {
    active: data.agents.filter((agent) => agent.status === 'active' && agent.enabled),
    proposed: data.agents.filter((agent) => agent.status === 'proposed'),
    disabled: data.agents.filter((agent) => agent.status === 'active' && !agent.enabled)
  }
}

/** Host as one of three kinds: the harness default route, a named host, or none (a local model). */
export function hostKind(agent: Pick<RosterAgentShape, 'host'>): 'default' | 'hostname' | 'none' {
  return agent.host === null ? 'none' : agent.host === 'default' ? 'default' : 'hostname'
}

export function sameData(a: RosterDataShape | null, b: RosterDataShape | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
