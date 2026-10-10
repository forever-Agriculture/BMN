// MODULE: model-suggestions.test.ts - Epic 60.5: the Model field offers each known name once, says where it came from, and its keys behave like a list
import type { HookOriginRecord, RosterAgentShape, RosterDataShape } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { modelSourceWords, modelSuggestions, pickerKey, reportedModels, type ReportedModel } from './model-suggestions'

const agent = (id: string, extra: Partial<RosterAgentShape> = {}): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'bishop', harness: 'claude', model: `model-${id}`, provider: 'anthropic', host: 'default',
  enabled: true, status: 'active', efforts: ['medium'], roles: [], ...extra
})

const DATA: RosterDataShape = {
  schema_version: 2,
  agents: [
    agent('opus', { model: 'synthetic-large-5', aliases: ['large'] }),
    agent('fable', { model: 'synthetic-art-5', status: 'proposed' }),
    agent('haiku', { model: 'synthetic-small-5', enabled: false }),
    agent('scout', { model: 'synthetic-small-5' }),
    agent('glm', { model: 'synthetic-far-5', provider: 'zai', host: 'api.z.test' }),
    agent('relay', { model: 'synthetic-far-5', provider: 'relay', host: 'relay.example.test' }),
    agent('sol', { harness: 'codex', provider: 'openai', model: 'synthetic-sol-6' })
  ],
  roles: [],
  providers: [
    { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'], private_work: 'allowed' },
    { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com'], private_work: 'allowed' },
    { id: 'zai', name: 'Z.ai', hosts: ['api.z.test'], private_work: 'public_only' },
    { id: 'relay', name: 'Relay', hosts: [], private_work: 'public_only' }
  ],
  exceptions: [],
  harness_routes: [{ harness: 'claude', provider: 'anthropic', basis: 'observed-default' }, { harness: 'codex', provider: 'openai', basis: 'observed-default' }]
}

const REPORTED: ReportedModel[] = [
  { harness: 'claude', model: 'synthetic-large-5', host: 'api.anthropic.com' },
  { harness: 'claude', model: 'synthetic-large-6', host: 'api.anthropic.com' },
  { harness: 'claude', model: 'synthetic-large-6', host: 'gateway.example.test' },
  { harness: 'codex', model: 'synthetic-sol-7', host: null }
]

const rows = (groups: ReturnType<typeof modelSuggestions>): string[] => groups.flatMap((group) => group.rows.map((row) => `${group.label} | ${row.name} | ${row.context}`))

describe('model suggestions (60.5: the Model field)', () => {
  it('offers the names of one app, each once: the team\'s with who uses it, then what the app reported in an open session', () => {
    expect(rows(modelSuggestions(DATA, 'claude', REPORTED, null))).toEqual([
      // A name the team has and a session also reported stays under the team, and says so.
      'On your team | synthetic-large-5 | Opus · also reported in an open session',
      'On your team | synthetic-art-5 | Fable',
      // Proposed and switched-off agents count: the name is on the team either way. Two users are both named.
      'On your team | synthetic-small-5 | Haiku and Scout',
      // The same name on two custom hosts is one row that names each host, never two look-alike rows.
      'On your team | synthetic-far-5 | Glm and Relay on relay.example.test',
      // Reported against the app's own servers and against another host: one row, and the other host is named.
      'Reported by Claude Code | synthetic-large-6 | in an open session; in an open session, on gateway.example.test'
    ])
    expect(rows(modelSuggestions(DATA, 'codex', REPORTED, null))).toEqual(['On your team | synthetic-sol-6 | Sol', 'Reported by Codex | synthetic-sol-7 | in an open session'])
    // An app with no agent and no report offers nothing: the field then never opens a panel.
    expect(modelSuggestions(DATA, 'cursor', REPORTED, null)).toEqual([])
  })

  it('narrows by the name and by what its agents are also called, ignoring case, and keeps the spelling of what it offers', () => {
    expect(rows(modelSuggestions(DATA, 'claude', REPORTED, ' LARGE '))).toEqual([
      'On your team | synthetic-large-5 | Opus · also reported in an open session',
      'Reported by Claude Code | synthetic-large-6 | in an open session; in an open session, on gateway.example.test'
    ])
    const shouting: RosterDataShape = { ...DATA, agents: [agent('mixed', { model: 'Synthetic-MiXed-5', aliases: ['Blend'] })] }
    expect(modelSuggestions(shouting, 'claude', [], 'blend')[0]?.rows[0]?.name).toBe('Synthetic-MiXed-5')
    expect(modelSuggestions(DATA, 'claude', REPORTED, 'nothing-like-it')).toEqual([])
  })

  it('on an agent\'s own page never names that agent as a user of its model', () => {
    expect(rows(modelSuggestions(DATA, 'claude', [], null, 'opus'))[0]).toBe('On your team | synthetic-large-5 | This agent')
    expect(rows(modelSuggestions(DATA, 'claude', [], null, 'haiku'))[2]).toBe('On your team | synthetic-small-5 | Scout')
  })

  it('says where the name in the field came from and that BMN does not check the app takes it', () => {
    const tail = ' BMN does not check that Claude Code takes this name.'
    expect(modelSourceWords('', DATA, 'claude', REPORTED)).toBe('')
    expect(modelSourceWords('anything-typed', DATA, 'claude', REPORTED)).toBe(`Typed by you.${tail}`)
    expect(modelSourceWords(' synthetic-small-5 ', DATA, 'claude', REPORTED)).toBe(`From your team: Haiku and Scout use it.${tail}`)
    expect(modelSourceWords('synthetic-art-5', DATA, 'claude', REPORTED)).toBe(`From your team: Fable uses it.${tail}`)
    expect(modelSourceWords('synthetic-large-6', DATA, 'claude', REPORTED)).toBe(`Reported by Claude Code in an open session.${tail}`)
    // An agent's own approved name is the team's; once it is changed to a reported one, the report is the source.
    expect(modelSourceWords('synthetic-large-5', DATA, 'claude', REPORTED, { self: 'opus', approved: 'synthetic-large-5' })).toBe(`From the approved team.${tail}`)
    expect(modelSourceWords('synthetic-large-6', DATA, 'claude', REPORTED, { self: 'opus', approved: 'synthetic-large-5' })).toBe(`Reported by Claude Code in an open session.${tail}`)
    // A name is matched exactly: another spelling is the owner's own typing.
    expect(modelSourceWords('SYNTHETIC-ART-5', DATA, 'claude', REPORTED)).toBe(`Typed by you.${tail}`)
    expect(modelSourceWords('synthetic-sol-7', DATA, 'codex', REPORTED)).toBe('Reported by Codex in an open session. BMN does not check that Codex takes this name.')
  })

  it('takes a reported name only from the run of a session that is going on now', () => {
    const record = (sessionId: string, incarnationId: string, model: string | null, agentName: HookOriginRecord['agent'] = 'claude'): HookOriginRecord =>
      ({ state: 'observed', sessionId, incarnationId, agent: agentName, country: null, model, apiHost: 'api.anthropic.com', observedAt: '2026-10-10T10:00:00.000Z' })
    const records = [record('s1', 'run-2', 'synthetic-large-6'), record('s2', 'run-1', 'synthetic-old-1'), record('s3', 'run-1', 'synthetic-gone-1'), record('s4', 'run-1', null), record('s5', 'run-1', 'synthetic-large-6'), record('s6', 'run-1', 'synthetic-sol-7', 'codex')]
    const sessions = [
      { sessionId: 's1', lastProcess: { incarnationId: 'run-2', state: 'live' as const, exitCode: null, signal: null, detail: null } },
      // A record from an earlier run of the session is not this run's model.
      { sessionId: 's2', lastProcess: { incarnationId: 'run-2', state: 'live' as const, exitCode: null, signal: null, detail: null } },
      // A run that has ended reports nothing any more.
      { sessionId: 's3', lastProcess: { incarnationId: 'run-1', state: 'exited' as const, exitCode: 0, signal: null, detail: null } },
      { sessionId: 's4', lastProcess: null }, { sessionId: 's5', lastProcess: null }, { sessionId: 's6', lastProcess: null }
    ]
    const live = { s1: { incarnationId: 'run-2' }, s2: { incarnationId: 'run-2' }, s3: { incarnationId: 'run-1' }, s4: { incarnationId: 'run-1' }, s5: { incarnationId: 'run-1' }, s6: { incarnationId: 'run-1' } }
    expect(reportedModels(records, sessions, live)).toEqual([
      { harness: 'claude', model: 'synthetic-large-6', host: 'api.anthropic.com' },
      { harness: 'codex', model: 'synthetic-sol-7', host: 'api.anthropic.com' }
    ])
    expect(reportedModels(records, sessions, {})).toEqual([])
  })
})

describe('the picker\'s keys (60.5: keyboard)', () => {
  const closed = { open: false, active: -1 }
  it('Down opens on the first row and Up on the last; both wrap', () => {
    expect(pickerKey(closed, 'ArrowDown', 3)).toEqual({ state: { open: true, active: 0 }, pick: null, handled: true })
    expect(pickerKey(closed, 'ArrowUp', 3)).toEqual({ state: { open: true, active: 2 }, pick: null, handled: true })
    expect(pickerKey({ open: true, active: 2 }, 'ArrowDown', 3).state.active).toBe(0)
    expect(pickerKey({ open: true, active: 0 }, 'ArrowUp', 3).state.active).toBe(2)
    // Opened by a click, no row is active yet: Down takes the first, Up the last.
    expect([pickerKey({ open: true, active: -1 }, 'ArrowDown', 3).state.active, pickerKey({ open: true, active: -1 }, 'ArrowUp', 3).state.active]).toEqual([0, 2])
    expect(pickerKey(closed, 'ArrowDown', 0)).toEqual({ state: closed, pick: null, handled: true })
  })

  it('Enter picks only an active row; Escape closes the panel and is then spent; other keys are the field\'s', () => {
    expect(pickerKey({ open: true, active: 1 }, 'Enter', 3)).toEqual({ state: closed, pick: 1, handled: true })
    expect(pickerKey({ open: true, active: -1 }, 'Enter', 3).handled).toBe(false)
    expect(pickerKey(closed, 'Enter', 3).handled).toBe(false)
    expect(pickerKey({ open: true, active: 1 }, 'Escape', 3)).toEqual({ state: closed, pick: null, handled: true })
    // With the panel closed Escape is not the picker's: the dialog may take it.
    expect(pickerKey(closed, 'Escape', 3).handled).toBe(false)
    expect(pickerKey({ open: true, active: 1 }, 'Tab', 3).handled).toBe(false)
    expect(pickerKey({ open: true, active: 1 }, 'a', 3).handled).toBe(false)
  })
})
