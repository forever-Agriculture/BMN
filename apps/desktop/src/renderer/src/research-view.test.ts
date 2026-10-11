// MODULE: research-view.test.ts - Story 60.10: the Models page's lists, the prices it offers to stage and its words, over a synthetic team and synthetic findings
import { describe, expect, it } from 'vitest'
import type { ResearchModelView, ResearchPrice, RosterAgentShape, RosterDataShape } from '@bmn/protocol'
import {
  appFor, applyPrices, dayWords, fillFrom, fillWords, lookupFits, priceChanges, priceText, recordedPrice, researchGroups, researchStatus, siteOf, unverifiedWords
} from './research-view'

const agent = (id: string, fields: Partial<RosterAgentShape>): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'pawn', harness: 'claude', model: `model-${id}`, provider: 'anthropic', host: 'default', enabled: true, status: 'active',
  efforts: ['low'], roles: [], ...fields
})

const DATA: RosterDataShape = {
  schema_version: 2,
  providers: [{ id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' }, { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' }],
  agents: [
    agent('sol', { harness: 'codex', provider: 'openai', model: 'gpt-6.1-sol', price: { input: 1.25, cached_input: 0.125, output: 10, source: 'https://prices.example.test/sol', as_of: '2026-10-01' } }),
    agent('opus', { model: 'claude-opus-5-5' }),
    agent('fable', { model: 'claude-fable-5-1', price: { input: 20, output: 100 } }),
    agent('scout', { model: 'claude-fable-5-1' }),
    agent('luna', { harness: 'codex', provider: 'openai', model: 'gpt-6-luna' })
  ],
  roles: [],
  exceptions: [],
  harness_routes: [{ harness: 'claude', provider: 'anthropic', basis: 'inspected' }, { harness: 'codex', provider: 'openai', basis: 'inspected' }]
} as unknown as RosterDataShape

const price = (input: number, output: number, fields: Partial<ResearchPrice> = {}): ResearchPrice =>
  ({ input, output, source: 'https://www.anthropic.com/pricing', as_of: '2026-10-10', rank: 1, verified: true, ...fields })
const found = (id: string, providerId: string, fields: Partial<ResearchModelView> = {}): ResearchModelView => ({
  id, provider: providerId === 'openai' ? 'OpenAI' : 'Anthropic', providerId, price: null, contextWindow: null,
  firstSeen: '2026-10-10T09:40:00.000Z', lastSeen: '2026-10-10T09:40:00.000Z', fresh: false, foundLast: true, ...fields
})

const MODELS: ResearchModelView[] = [
  found('gpt-6.1-sol', 'openai', { price: price(2, 8, { source: 'https://openai.com/api/pricing' }) }),
  found('claude-opus-5-5', 'anthropic', { price: price(15, 75, { cached_input: 1.5 }), contextWindow: { tokens: 1_000_000, source: 'https://www.anthropic.com/models', as_of: '2026-10-10', rank: 1, verified: true } }),
  found('claude-fable-5-1', 'anthropic', { price: price(20, 100) }),
  found('gpt-6-luna', 'openai', { price: price(0.4, 1.6, { verified: false, why: 'the page does not show this price beside the model' }) }),
  found('claude-opus-5-6', 'anthropic', { fresh: true, price: price(15, 75) }),
  found('gpt-6.1-astra', 'openai', { fresh: true }),
  found('claude-haiku-5-5', 'anthropic', { firstSeen: '2026-10-03T09:00:00.000Z', lastSeen: '2026-10-03T09:00:00.000Z', foundLast: false })
]

describe('the Models page lists (60.10 AC4, first release)', () => {
  it('groups what research found against the team as drafted', () => {
    const groups = researchGroups(MODELS, DATA)
    expect(groups.fresh.map((model) => model.id)).toEqual(['claude-opus-5-6', 'gpt-6.1-astra'])
    expect(groups.earlier.map((model) => model.id)).toEqual(['claude-haiku-5-5'])
    expect(groups.team.map((row) => [row.model, row.agents, row.provider, row.found?.id ?? null, row.differs])).toEqual([
      ['gpt-6.1-sol', ['Sol'], 'OpenAI', 'gpt-6.1-sol', true],
      ['claude-opus-5-5', ['Opus'], 'Anthropic', 'claude-opus-5-5', true],
      // Fable records this price already; Scout, on the same model, records none.
      ['claude-fable-5-1', ['Fable', 'Scout'], 'Anthropic', 'claude-fable-5-1', true],
      // An unverified price is never a difference.
      ['gpt-6-luna', ['Luna'], 'OpenAI', 'gpt-6-luna', false]
    ])
    expect(groups.team[0]!.teamHas).toMatchObject({ input: 1.25, output: 10 })
    expect(groups.team[1]!.teamHas).toBeNull()
    // A model the draft adds to the team leaves the other lists at once.
    const added = { ...DATA, agents: [...DATA.agents, agent('next', { model: 'claude-opus-5-6' })] }
    expect(researchGroups(MODELS, added).fresh.map((model) => model.id)).toEqual(['gpt-6.1-astra'])
    // The same name on another provider is another model.
    expect(researchGroups([found('claude-opus-5-5', 'openai')], DATA).team[1]!.found).toBeNull()
  })

  it('offers only verified prices that differ, and staging changes nothing but each price (60.10 AC5)', () => {
    const changes = priceChanges(MODELS, DATA)
    expect(changes).toEqual([
      { agent: 'sol', name: 'Sol', model: 'gpt-6.1-sol', before: DATA.agents[0]!.price, after: { input: 2, output: 8, source: 'https://openai.com/api/pricing', as_of: '2026-10-10' } },
      { agent: 'opus', name: 'Opus', model: 'claude-opus-5-5', before: null, after: { input: 15, output: 75, cached_input: 1.5, source: 'https://www.anthropic.com/pricing', as_of: '2026-10-10' } },
      { agent: 'scout', name: 'Scout', model: 'claude-fable-5-1', before: null, after: { input: 20, output: 100, source: 'https://www.anthropic.com/pricing', as_of: '2026-10-10' } }
    ])
    const staged = applyPrices(DATA, changes)
    expect(staged.agents.map((entry) => entry.price?.input ?? null)).toEqual([2, 15, 20, 20, null])
    const withoutPrice = (entry: RosterAgentShape): RosterAgentShape => {
      const rest = { ...entry }
      delete rest.price
      return rest
    }
    expect(staged.agents.map(withoutPrice)).toEqual(DATA.agents.map(withoutPrice))
    expect({ ...staged, agents: [] }).toEqual({ ...DATA, agents: [] })
    // Once staged, nothing is left to offer.
    expect(priceChanges(MODELS, staged)).toEqual([])
    expect(researchGroups(MODELS, staged).team.every((row) => !row.differs)).toBe(true)
  })

  it('keeps BMN\'s own marks out of the team file', () => {
    expect(recordedPrice(price(15, 75, { cached_input: 1.5 }))).toEqual({ input: 15, output: 75, cached_input: 1.5, source: 'https://www.anthropic.com/pricing', as_of: '2026-10-10' })
    expect(recordedPrice(price(15, 75))).not.toHaveProperty('cached_input')
  })
})

describe('Add to team and Look up (60.10 AC6)', () => {
  it('fills only what BMN verified, on the app whose provider serves the model, and never a class', () => {
    expect(appFor(DATA, 'openai')).toBe('codex')
    expect(appFor(DATA, 'moonshot')).toBeNull()
    const fill = fillFrom(MODELS[1]!, DATA)
    expect(fill).toEqual({ model: 'claude-opus-5-5', harness: 'claude', day: dayWords('2026-10-10T09:40:00.000Z'),
      price: { input: 15, output: 75, cached_input: 1.5, source: 'https://www.anthropic.com/pricing', as_of: '2026-10-10' }, contextWindow: 1_000_000 })
    expect(fill).not.toHaveProperty('class')
    expect(fillFrom(MODELS[3]!, DATA)).toEqual({ model: 'gpt-6-luna', harness: 'codex', day: fill.day })
    expect(fillWords(fill)).toBe(`Name, price and capacity from research on ${fill.day}. Check Agent app and Host.`)
    expect(fillWords(fillFrom(MODELS[3]!, DATA))).toMatch(/^Name from research on /)
    expect(fillWords(fillFrom(MODELS[4]!, DATA))).toMatch(/^Name and price from research on /)
    // A Look up brings only what was found for the name the owner typed.
    expect(fillWords(fill, true)).toBe(`Price and capacity from research on ${fill.day}.`)
    expect(fillWords(fillFrom(MODELS[4]!, DATA), true)).toBe(`Price from research on ${fill.day}.`)
  })

  it('a Look up\'s answer fills the form only while the form still names what was asked', () => {
    const asked = { model: 'claude-opus-5-5', provider: 'anthropic' }
    expect(lookupFits(asked, { model: 'claude-opus-5-5', provider: 'anthropic' }, 'claude-opus-5-5')).toBe(true)
    // The owner typed another name, or changed the app or the host so the model would run elsewhere, while the researcher worked.
    expect(lookupFits(asked, { model: 'claude-fable-5-1', provider: 'anthropic' }, 'claude-opus-5-5')).toBe(false)
    expect(lookupFits(asked, { model: 'claude-opus-5-5', provider: 'moonshot' }, 'claude-opus-5-5')).toBe(false)
    expect(lookupFits(asked, { model: '', provider: 'anthropic' }, 'claude-opus-5-5')).toBe(false)
    // An answer about another model than the one asked fills nothing.
    expect(lookupFits(asked, { model: 'claude-opus-5-5', provider: 'anthropic' }, 'claude-opus-5-6')).toBe(false)
  })
})

describe('the page\'s words', () => {
  const shortDate = (iso: string): string => `<${iso.slice(0, 10)}>`
  const researchers = [{ id: 'luna', name: 'Luna', harness: 'codex' as const, ok: true }]

  it('says when it was researched, by whom and how far a run is', () => {
    expect(researchStatus({ last: null, running: null, researchers }, shortDate)).toBe('Not researched yet')
    expect(researchStatus({ last: { at: '2026-10-10T09:40:00.000Z', researcher: 'Opus', state: 'complete', models: 15 }, running: null, researchers }, shortDate)).toBe('Researched <2026-10-10> by Opus · 15 models')
    expect(researchStatus({ last: { at: '2026-10-10T09:40:00.000Z', researcher: 'Opus', state: 'partial', models: 1 }, running: null, researchers }, shortDate)).toBe('Researched <2026-10-10> by Opus · 1 model · not finished')
    expect(researchStatus({ last: null, running: { researcher: 'luna', done: 0, total: 0, lookup: false }, researchers }, shortDate)).toBe('Luna is starting')
    expect(researchStatus({ last: null, running: { researcher: 'luna', done: 3, total: 9, lookup: false }, researchers }, shortDate)).toBe('Luna is researching · 3 of 9 models')
    expect(researchStatus({ last: null, running: { researcher: 'luna', done: 0, total: 1, lookup: true }, researchers }, shortDate)).toBe('Luna is looking up one model')
  })

  it('names a price, its site and why a value is not counted', () => {
    expect(priceText({ input: 0.8, output: 4 })).toBe('$0.80 / $4.00')
    // An amount that cents would round keeps every digit it has.
    expect(priceText({ input: 0.075, output: 0.3 })).toBe('$0.075 / $0.30')
    expect(siteOf('https://www.anthropic.com/pricing#api')).toBe('anthropic.com')
    expect(siteOf('https://platform.openai.com/docs/pricing')).toBe('platform.openai.com')
    expect(siteOf('not an address')).toBe('not an address')
    expect(unverifiedWords('the site answered 404')).toBe('BMN could not confirm this on the cited page: the site answered 404.')
    expect(unverifiedWords(undefined)).toBe('BMN could not confirm this on the cited page.')
    expect(dayWords('2026-10-10')).toBe(dayWords('2026-10-10T12:00:00'))
  })
})
