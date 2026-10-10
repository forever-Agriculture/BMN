// MODULE: research-view.ts - Story 60.10: what Team › Models shows of a research, worked out against the team as drafted; kept pure for tests
import type { ResearchModelView, ResearchPrice, ResearchSnapshot, RosterAgentShape, RosterDataShape, RosterHarness, RosterPriceShape } from '@bmn/protocol'
import { dayWords, priceText, siteOf, updateAgent } from './roster-staging'

export { dayWords, priceText, siteOf }

/** One of the team's models with the agents that use it and what research found for it, or null when it never found it. */
export interface TeamModelRow {
  model: string
  providerId: string
  provider: string
  agents: string[]
  found: ResearchModelView | null
  /** The price the team records for it, when a verified researched price differs from it. */
  teamHas: RosterPriceShape | null
  /** A verified researched price differs from what an agent on this model records, or none is recorded. */
  differs: boolean
}

export interface ResearchGroups {
  /** Models not on the team that the last research saw for the first time. */
  fresh: ResearchModelView[]
  team: TeamModelRow[]
  /** Models not on the team that an earlier research or a Look up found. */
  earlier: ResearchModelView[]
}

export interface PriceChange { agent: string; name: string; model: string; before: RosterPriceShape | null; after: RosterPriceShape }

const found = (models: readonly ResearchModelView[], agent: Pick<RosterAgentShape, 'provider' | 'model'>): ResearchModelView | undefined =>
  models.find((model) => model.providerId === agent.provider && model.id === agent.model)

/** A recorded price says the same as a researched one: the same input and output, and the same cached price when research found one. */
function samePrice(recorded: RosterPriceShape | undefined, researched: ResearchPrice): boolean {
  return recorded !== undefined && recorded.input === researched.input && recorded.output === researched.output
    && (researched.cached_input === undefined || recorded.cached_input === researched.cached_input)
}

/** The price a team file takes from a researched one: the numbers, the page and the date; never BMN's own marks. */
export function recordedPrice(price: ResearchPrice): RosterPriceShape {
  return { input: price.input, output: price.output, ...(price.cached_input === undefined ? {} : { cached_input: price.cached_input }), source: price.source, as_of: price.as_of }
}

/**
 * The prices Apply prices would stage: for each agent whose model has a price BMN verified on the
 * cited page, when the agent records another price or none. An unverified price is never offered.
 */
export function priceChanges(models: readonly ResearchModelView[], data: RosterDataShape): PriceChange[] {
  const changes: PriceChange[] = []
  for (const agent of data.agents) {
    const price = found(models, agent)?.price
    if (!price || !price.verified || samePrice(agent.price, price)) continue
    changes.push({ agent: agent.id, name: agent.name, model: agent.model, before: agent.price ?? null, after: recordedPrice(price) })
  }
  return changes
}

/** Stages the prices: nothing but each agent's `price` changes. */
export function applyPrices(data: RosterDataShape, changes: readonly PriceChange[]): RosterDataShape {
  return changes.reduce((next, change) => updateAgent(next, change.agent, { price: change.after }), data)
}

/** The page's three lists, against the team as it is drafted. */
export function researchGroups(models: readonly ResearchModelView[], data: RosterDataShape): ResearchGroups {
  const onTeam = (model: ResearchModelView): boolean => data.agents.some((agent) => agent.provider === model.providerId && agent.model === model.id)
  const others = models.filter((model) => !onTeam(model))
  const team: TeamModelRow[] = []
  for (const agent of data.agents) {
    let row = team.find((entry) => entry.model === agent.model && entry.providerId === agent.provider)
    if (!row) {
      row = { model: agent.model, providerId: agent.provider, provider: data.providers.find((provider) => provider.id === agent.provider)?.name ?? agent.provider,
        agents: [], found: found(models, agent) ?? null, teamHas: null, differs: false }
      team.push(row)
    }
    row.agents.push(agent.name)
    const price = row.found?.price
    if (price?.verified && !samePrice(agent.price, price)) {
      row.differs = true
      row.teamHas ??= agent.price ?? null
    }
  }
  return { fresh: others.filter((model) => model.fresh), team, earlier: others.filter((model) => !model.fresh) }
}

/** Why a value is not counted, said once beside it. */
export function unverifiedWords(why: string | undefined): string {
  return why ? `BMN could not confirm this on the cited page: ${why}.` : 'BMN could not confirm this on the cited page.'
}

/** The app whose own provider serves a researched model, so Add to team can start on it; null when no app's destination is that provider. */
export function appFor(data: RosterDataShape, providerId: string): RosterHarness | null {
  return data.harness_routes.find((route) => route.provider === providerId)?.harness ?? data.agents.find((agent) => agent.provider === providerId)?.harness ?? null
}

/** What research found of a model, as New agent takes it: only values BMN verified. */
export interface ResearchFill { model: string; harness: RosterHarness | null; price?: RosterPriceShape; contextWindow?: number; day: string }

export function fillFrom(model: ResearchModelView, data: RosterDataShape): ResearchFill {
  return {
    model: model.id, harness: appFor(data, model.providerId), day: dayWords(model.lastSeen),
    ...(model.price?.verified ? { price: recordedPrice(model.price) } : {}),
    ...(model.contextWindow?.verified ? { contextWindow: model.contextWindow.tokens } : {})
  }
}

/**
 * What research brought to New agent, in words. Add to team brings the name too; a Look up brings
 * only what was found for the name the owner typed.
 */
export function fillWords(fill: ResearchFill, typed = false): string {
  const parts = [typed ? null : 'name', fill.price ? 'price' : null, fill.contextWindow ? 'capacity' : null].filter((part): part is string => part !== null)
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  const what = `${list.charAt(0).toUpperCase()}${list.slice(1)} from research on ${fill.day}.`
  // That BMN does not check the name is said once, under the Model field.
  return typed ? what : `${what} Check Agent app and Host.`
}

/** The page's status line: when it was last researched, by whom, and how it ended. */
export function researchStatus(snapshot: Pick<ResearchSnapshot, 'last' | 'running' | 'researchers'>, shortDate: (iso: string) => string): string {
  if (snapshot.running !== null) {
    const name = snapshot.researchers.find((entry) => entry.id === snapshot.running?.researcher)?.name ?? snapshot.running.researcher
    if (snapshot.running.lookup) return `${name} is looking up one model`
    return snapshot.running.total === 0 ? `${name} is starting` : `${name} is researching · ${snapshot.running.done} of ${snapshot.running.total} models`
  }
  if (snapshot.last === null) return 'Not researched yet'
  const count = `${snapshot.last.models} model${snapshot.last.models === 1 ? '' : 's'}`
  return `Researched ${shortDate(snapshot.last.at)} by ${snapshot.last.researcher} · ${count}${snapshot.last.state === 'partial' ? ' · not finished' : ''}`
}
