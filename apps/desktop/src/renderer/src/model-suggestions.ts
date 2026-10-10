// MODULE: model-suggestions.ts - Epic 60.5: the names a Model field offers and where each came from, kept pure for tests
import { ROSTER_APP_NAMES, type HookOriginRecord, type RosterDataShape, type RosterHarness, type SessionRecord } from '@bmn/protocol'
import { activeHookOrigin } from './session-presentation'

/** A model name an app reported in a session that is running now, with the host it reported beside it. */
export interface ReportedModel { harness: RosterHarness; model: string; host: string | null }

export type ModelSource = 'team' | 'reported'

export interface ModelSuggestion {
  /** The name exactly as it was recorded or reported; a pick writes these characters. */
  name: string
  source: ModelSource
  /** Who uses it or where it was seen, in words. */
  context: string
  /** Agents of the team that use it; empty for a reported name nobody uses. */
  agents: string[]
  /** Other names the filter reads: what those agents are also called by their app. */
  alsoCalled: string[]
}

export interface ModelSuggestionGroup { source: ModelSource; label: string; rows: ModelSuggestion[] }

/**
 * What each app last reported in a session that is running now. BMN keeps this in memory only, per
 * run: a name goes when its session ends or BMN restarts, so this is never a list of what an app offers.
 */
export function reportedModels(
  records: readonly HookOriginRecord[],
  sessions: ReadonlyArray<Pick<SessionRecord, 'sessionId' | 'lastProcess'>>,
  live: Readonly<Record<string, { incarnationId: string } | undefined>>
): ReportedModel[] {
  const found: ReportedModel[] = []
  for (const session of sessions) {
    const origin = activeHookOrigin(records, session, live[session.sessionId]?.incarnationId)
    if (origin === null || origin.model === null || origin.model.trim() === '') continue
    const entry: ReportedModel = { harness: origin.agent, model: origin.model, host: origin.apiHost }
    if (!found.some((other) => other.harness === entry.harness && other.model === entry.model && other.host === entry.host)) found.push(entry)
  }
  return found
}

/**
 * How many running sessions BMN recognises as each app: the ones whose current run reported to it.
 * An app started inside a shell BMN cannot see into is not counted, so this is never "all of them".
 */
export function sessionsByApp(
  records: readonly HookOriginRecord[],
  sessions: ReadonlyArray<Pick<SessionRecord, 'sessionId' | 'lastProcess'>>,
  live: Readonly<Record<string, { incarnationId: string } | undefined>>
): Partial<Record<RosterHarness, number>> {
  const counts: Partial<Record<RosterHarness, number>> = {}
  for (const session of sessions) {
    const origin = activeHookOrigin(records, session, live[session.sessionId]?.incarnationId)
    if (origin !== null) counts[origin.agent] = (counts[origin.agent] ?? 0) + 1
  }
  return counts
}

const names = (list: readonly string[]): string => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1) as string}`)

/** A host worth naming beside a name: one that is not the provider's own. */
function otherHost(data: RosterDataShape, provider: string | undefined, host: string | null): string | null {
  if (host === null || host === 'default') return null
  const own = data.providers.find((entry) => entry.id === provider)?.hosts ?? []
  return own.some((entry) => entry.toLowerCase() === host.toLowerCase()) ? null : host
}

/**
 * The names offered for one app, each once: the team's first (with who uses it), then what the app
 * reported in a running session. `query` narrows by the name and by what its agents are also
 * called, ignoring case; null lists everything. `self` is the agent being edited, never named as a
 * user of its own model.
 */
export function modelSuggestions(data: RosterDataShape, harness: RosterHarness, reported: readonly ReportedModel[], query: string | null, self?: string): ModelSuggestionGroup[] {
  const app = ROSTER_APP_NAMES[harness]
  const seen = reported.filter((entry) => entry.harness === harness)
  const team: ModelSuggestion[] = []
  for (const agent of data.agents) {
    if (agent.harness !== harness || agent.model.trim() === '') continue
    let row = team.find((entry) => entry.name === agent.model)
    if (!row) {
      row = { name: agent.model, source: 'team', context: '', agents: [], alsoCalled: [] }
      team.push(row)
    }
    if (agent.id !== self) {
      const host = otherHost(data, agent.provider, agent.host)
      row.agents.push(host === null ? agent.name : `${agent.name} on ${host}`)
    }
    for (const alias of agent.aliases ?? []) if (!row.alsoCalled.includes(alias)) row.alsoCalled.push(alias)
  }
  for (const row of team) {
    const also = seen.some((entry) => entry.model === row.name) ? 'also reported in an open session' : null
    row.context = [row.agents.length > 0 ? names(row.agents) : 'This agent', also].filter(Boolean).join(' · ')
  }
  const fresh: ModelSuggestion[] = []
  for (const entry of seen) {
    if (team.some((row) => row.name === entry.model)) continue
    const host = otherHost(data, data.harness_routes.find((route) => route.harness === harness)?.provider, entry.host)
    const context = host === null ? 'in an open session' : `in an open session, on ${host}`
    const row = fresh.find((other) => other.name === entry.model)
    if (row) row.context = row.context.includes(context) ? row.context : `${row.context}; ${context}`
    else fresh.push({ name: entry.model, source: 'reported', context, agents: [], alsoCalled: [] })
  }
  const text = query?.trim().toLowerCase() ?? ''
  const hit = (row: ModelSuggestion): boolean => text === '' || row.name.toLowerCase().includes(text) || row.alsoCalled.some((alias) => alias.toLowerCase().includes(text))
  return [
    { source: 'team' as const, label: 'On your team', rows: team.filter(hit) },
    { source: 'reported' as const, label: `Reported by ${app}`, rows: fresh.filter(hit) }
  ].filter((group) => group.rows.length > 0)
}

/**
 * Where the name in the field came from, then the one thing BMN cannot promise about any name.
 * `approved` is the model the approved team holds for the agent being edited.
 */
export function modelSourceWords(value: string, data: RosterDataShape, harness: RosterHarness, reported: readonly ReportedModel[], options: { self?: string; approved?: string } = {}): string {
  const name = value.trim()
  if (name === '') return ''
  const app = ROSTER_APP_NAMES[harness]
  const row = modelSuggestions(data, harness, reported, null, options.self).flatMap((group) => group.rows).find((entry) => entry.name === name)
  const source = options.approved !== undefined && options.approved === name ? 'From the approved team'
    : row?.source === 'team' && row.agents.length > 0 ? `From your team: ${names(row.agents)} ${row.agents.length === 1 ? 'uses' : 'use'} it`
      : row?.source === 'reported' || (row?.source === 'team' && reported.some((entry) => entry.harness === harness && entry.model === name)) ? `Reported by ${app} in an open session`
        : 'Typed by you'
  return `${source}. BMN does not check that ${app} takes this name.`
}

export interface PickerState { open: boolean; active: number }

/**
 * The picker's keys. Down opens and takes the first row, Up the last; both wrap. Enter picks only a
 * row that is active. Escape closes the panel and is then spent, so it never reaches the dialog. Any
 * other key is left to the field.
 */
export function pickerKey(state: PickerState, key: string, count: number): { state: PickerState; pick: number | null; handled: boolean } {
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (count === 0) return { state: { open: false, active: -1 }, pick: null, handled: true }
    const down = key === 'ArrowDown'
    if (!state.open) return { state: { open: true, active: down ? 0 : count - 1 }, pick: null, handled: true }
    const active = down ? (state.active + 1) % count : state.active <= 0 ? count - 1 : state.active - 1
    return { state: { open: true, active }, pick: null, handled: true }
  }
  if (key === 'Enter' && state.open && state.active >= 0 && state.active < count) return { state: { open: false, active: -1 }, pick: state.active, handled: true }
  if (key === 'Escape' && state.open) return { state: { open: false, active: -1 }, pick: null, handled: true }
  return { state, pick: null, handled: false }
}
