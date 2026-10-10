// MODULE: tools-view.ts - Story 60.12: what Rules › Tools shows and stages: a tool's scope and state in words, the plain rows of Add tool and Edit, and the team with a tool set or removed
import {
  ROSTER_APP_NAMES, ROSTER_HARNESSES, type RosterDataShape, type RosterHarness, type RosterToolShape, type ToolProposalView, type ToolStateName, type ToolsAppView
} from '@bmn/protocol'

export const TOOL_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
export const MAX_TOOLS = 64

export type ToolScope = 'all' | 'apps' | 'agents'
export const SCOPE_WORDS: Readonly<Record<ToolScope, string>> = { all: 'All apps', apps: 'Some apps', agents: 'Some agents' }

export function toolScope(tool: Pick<RosterToolShape, 'apps' | 'agents'>): ToolScope {
  return tool.agents !== undefined ? 'agents' : tool.apps !== undefined ? 'apps' : 'all'
}

/** Whether a tool is meant for an app's own settings: never when it is kept to agents. */
export function toolForApp(tool: Pick<RosterToolShape, 'apps' | 'agents'>, harness: RosterHarness): boolean {
  return tool.agents === undefined && (tool.apps === undefined || tool.apps.includes(harness))
}

/** What a tool runs or where it is, in a few words: the program and its first plain argument, or the address's site. */
export function transportWords(tool: Pick<RosterToolShape, 'command' | 'args' | 'url'>): string {
  if (tool.url !== undefined) {
    try {
      return new URL(tool.url).host
    } catch {
      return 'an address'
    }
  }
  const first = (tool.args ?? []).find((arg): arg is string => typeof arg === 'string' && !arg.startsWith('-'))
  return first !== undefined && first.length <= 60 ? `${tool.command ?? ''} ${first}` : tool.command ?? ''
}

/** The environment variables a tool names, each once: what must be set where the app starts for the tool to work. */
export function toolVariables(tool: Pick<RosterToolShape, 'args' | 'env' | 'headers'>): string[] {
  const named = [...Object.values(tool.env ?? {}), ...Object.values(tool.headers ?? {}), ...(tool.args ?? []).flatMap((arg) => (typeof arg === 'string' ? [] : [arg.env]))]
  return [...new Set(named)]
}

/** The team with one tool set (added, or replaced under its id), in id order. */
export function setTool(data: RosterDataShape, tool: RosterToolShape): RosterDataShape {
  const tools = [...(data.tools ?? []).filter((entry) => entry.id !== tool.id), tool].sort((a, b) => (a.id < b.id ? -1 : 1))
  return { ...data, tools }
}

/** The team without one tool; a team with none has no list, so its data is what it was before any tool. */
export function removeTool(data: RosterDataShape, id: string): RosterDataShape {
  const tools = (data.tools ?? []).filter((entry) => entry.id !== id)
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'tools')) as Omit<RosterDataShape, 'tools'>
  return tools.length === 0 ? rest : { ...rest, tools }
}

function scoped(tool: RosterToolShape, scope: { apps?: RosterHarness[]; agents?: string[] }): RosterToolShape {
  const rest = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'apps' && key !== 'agents')) as RosterToolShape
  return { ...rest, ...scope }
}

/** Public lets an app that gets public work only have the tool. */
export function setToolPublic(data: RosterDataShape, id: string, on: boolean): RosterDataShape {
  const tool = data.tools?.find((entry) => entry.id === id)
  if (tool === undefined) return data
  const rest = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'public')) as RosterToolShape
  return setTool(data, on ? { ...rest, public: true } : rest)
}

/** Adds an app to a tool's scope or takes it out; all four apps is "all apps" again, and the last app cannot be taken out. */
export function toggleToolApp(data: RosterDataShape, id: string, harness: RosterHarness): RosterDataShape {
  const tool = data.tools?.find((entry) => entry.id === id)
  if (tool === undefined || tool.agents !== undefined) return data
  const now = ROSTER_HARNESSES.filter((app) => toolForApp(tool, app) !== (app === harness))
  if (now.length === 0) return data
  return setTool(data, scoped(tool, now.length === ROSTER_HARNESSES.length ? {} : { apps: now }))
}

/** Gives a tool to an agent's runs or takes it away; the last agent cannot be taken out. */
export function toggleToolAgent(data: RosterDataShape, id: string, agent: string): RosterDataShape {
  const tool = data.tools?.find((entry) => entry.id === id)
  if (tool?.agents === undefined) return data
  const now = tool.agents.includes(agent) ? tool.agents.filter((entry) => entry !== agent) : [...tool.agents, agent].sort()
  return now.length === 0 ? data : setTool(data, scoped(tool, { agents: now }))
}

/** A tool's state in one app, in a word or two; `on` is whether the tool is meant for that app's settings. */
export function toolStateWords(state: ToolStateName | undefined, app: Pick<ToolsAppView, 'supported'> | undefined, on: boolean): string {
  if (state === 'exposed') return 'Exposed'
  if (!on) return 'Off'
  if (app === undefined || !app.supported) return 'Not yet'
  switch (state) {
    case 'current': return 'Set up'
    case 'missing': return 'Missing'
    case 'excluded': return 'Not public'
    case 'blocked': return 'Blocked'
    case 'unreadable': return "Can't read"
    case undefined: return 'Not yet'
    default: return 'Differs'
  }
}

/** What that word means for this tool and app, as the chip's hint. */
export function toolStateHint(state: ToolStateName | undefined, app: Pick<ToolsAppView, 'supported'> | undefined, on: boolean, name: string, detail?: string): string {
  if (state === 'exposed') return `${name} holds this tool but may not have it`
  if (!on) return `Not for ${name}`
  if (app === undefined || !app.supported) return `Tools are not supported yet in ${name}: run its test on Health`
  switch (state) {
    case 'current': return `${name} has it`
    case 'missing': return `Not in ${name} yet: Install… adds it`
    case 'excluded': return `${name} gets public tools only`
    case 'blocked': return detail ?? `${name} cannot take this tool as it is`
    case 'unreadable': return detail ?? `BMN cannot read ${name}'s entry`
    case undefined: return `Checked once you approve it`
    case 'stale': return `${name} has an older version: Install… updates it`
    default: return detail ?? `${name} holds something else under this name: Install… shows it`
  }
}

/** An app's last tools test, or why its tools are not supported yet. */
export function toolsTestLine(app: Pick<ToolsAppView, 'supported' | 'version' | 'test' | 'variable' | 'isolation'>, day: (iso: string) => string): string {
  if (!app.supported) {
    if (app.version === null) return 'The app is not found'
    const last = app.test !== null && app.test.version === app.version ? app.test.outcome : null
    return last === 'fail' ? `The test failed on ${app.version}` : last === 'inconclusive' ? `The test was inconclusive on ${app.version}` : `Not tested on ${app.version}`
  }
  const seen = [app.variable ? 'passes variables' : 'variables not seen', app.isolation ? 'a run can have tools of its own' : null].filter(Boolean).join(' · ')
  return `Tested ${app.test ? day(app.test.at) : ''} · ${seen}`.replace('  ', ' ')
}

// ---------------------------------------------------------------------------------------------
// Add tool and Edit: plain rows

export interface ToolDraft {
  /** The id of the tool being edited; null for a new one. */
  editing: string | null
  id: string
  name: string
  kind: 'program' | 'address'
  command: string
  /** One argument per line; `$NAME` takes the value of that environment variable. */
  args: string
  /** One per line: the entry the program receives, then `=` and the variable when its name differs. */
  env: string
  url: string
  /** One per line: the header, `=`, the variable. */
  headers: string
  scope: ToolScope
  apps: RosterHarness[]
  agents: string[]
  public: boolean
}

export const EMPTY_DRAFT: ToolDraft = { editing: null, id: '', name: '', kind: 'program', command: '', args: '', env: '', url: '', headers: '', scope: 'all', apps: [], agents: [], public: false }

const pairs = (map: Record<string, string> | undefined): string => Object.entries(map ?? {}).map(([name, variable]) => (name === variable ? name : `${name}=${variable}`)).join('\n')

export function draftFrom(tool: RosterToolShape): ToolDraft {
  return {
    editing: tool.id, id: tool.id, name: tool.name, kind: tool.url !== undefined ? 'address' : 'program', command: tool.command ?? '',
    args: (tool.args ?? []).map((arg) => (typeof arg === 'string' ? arg : `$${arg.env}`)).join('\n'), env: pairs(tool.env), url: tool.url ?? '', headers: pairs(tool.headers),
    scope: toolScope(tool), apps: [...(tool.apps ?? [])], agents: [...(tool.agents ?? [])], public: tool.public === true
  }
}

/** A suggested id from a name: its letters and digits, lowercased, joined by hyphens. */
export function idFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export type DraftField = 'id' | 'name' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'scope'

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '')

function bindings(text: string, what: 'env' | 'headers'): { map: Record<string, string> } | { error: string } {
  const map: Record<string, string> = {}
  for (const line of lines(text)) {
    const [name = '', variable = name] = line.split('=').map((part) => part.trim())
    const named = what === 'env' ? VARIABLE.test(name) : HEADER.test(name)
    if (line.split('=').length > 2 || !named || !VARIABLE.test(variable)) {
      return { error: what === 'env' ? `"${line}" is not a variable name. Name the variable, never its value.` : `"${line}" is not Header=VARIABLE. Name the variable, never its value.` }
    }
    if (what === 'headers' && !line.includes('=')) return { error: `"${line}" needs the variable it comes from: ${name}=VARIABLE` }
    if (Object.hasOwn(map, name)) return { error: `${name} is there twice` }
    map[name] = variable
  }
  return { map: Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))) }
}

/**
 * The tool the rows describe, or what is wrong with each row in plain words. The checks are the
 * team file's own, so a tool the page accepts is one the file reads.
 */
export function toolFrom(draft: ToolDraft, data: RosterDataShape): { tool: RosterToolShape; errors?: undefined } | { errors: Partial<Record<DraftField, string>>; tool?: undefined } {
  const errors: Partial<Record<DraftField, string>> = {}
  const id = draft.id.trim()
  const name = draft.name.trim()
  const others = (data.tools ?? []).filter((entry) => entry.id !== draft.editing)
  if (name === '' || name.length > 40) errors.name = 'A name of 1 to 40 characters'
  if (!TOOL_ID.test(id)) errors.id = 'Lowercase letters, digits, - and _, at most 40'
  else if (others.some((entry) => entry.id === id)) errors.id = 'Another tool has this id'
  else if (draft.editing === null && others.length >= MAX_TOOLS) errors.id = `At most ${MAX_TOOLS} tools`
  const tool: RosterToolShape = { id, name }
  if (draft.kind === 'program') {
    const command = draft.command.trim()
    if (command === '' || command.length > 400) errors.command = 'The program to start, by name or path'
    tool.command = command
    const args = lines(draft.args).map((line) => (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(line) ? { env: line.slice(1) } : line))
    if (args.length > 40 || args.some((arg) => typeof arg === 'string' && arg.length > 400)) errors.args = 'At most 40 arguments of 400 characters'
    if (args.length > 0) tool.args = args
    const env = bindings(draft.env, 'env')
    if ('error' in env) errors.env = env.error
    else if (Object.keys(env.map).length > 32) errors.env = 'At most 32 variables'
    else if (Object.keys(env.map).length > 0) tool.env = env.map
  } else {
    const url = draft.url.trim()
    const parsed = URL.canParse(url) ? new URL(url) : null
    const local = parsed !== null && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed === null || url.length > 400) errors.url = 'An address that starts with https://'
    else if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) errors.url = 'An address that starts with https:// (http:// only for this machine)'
    else if (parsed.username !== '' || parsed.password !== '') errors.url = 'No name or password in the address: name a variable under Headers'
    tool.url = url
    const headers = bindings(draft.headers, 'headers')
    if ('error' in headers) errors.headers = headers.error
    else if (Object.keys(headers.map).length > 16) errors.headers = 'At most 16 headers'
    else if (Object.keys(headers.map).length > 0) tool.headers = headers.map
  }
  if (draft.public) tool.public = true
  if (draft.scope === 'apps') {
    const apps = ROSTER_HARNESSES.filter((harness) => draft.apps.includes(harness))
    if (apps.length === 0) errors.scope = 'Choose at least one app'
    else tool.apps = apps
  } else if (draft.scope === 'agents') {
    const known = new Set(data.agents.map((agent) => agent.id))
    const agents = [...new Set(draft.agents)].filter((agent) => known.has(agent)).sort()
    if (agents.length === 0) errors.scope = 'Choose at least one agent'
    else tool.agents = agents
  }
  return Object.keys(errors).length > 0 ? { errors } : { tool }
}

/** The proposals that can join the team as drafted: readable, not there yet, and one definition per id. */
export function addable(proposals: readonly ToolProposalView[], data: RosterDataShape): RosterToolShape[] {
  const have = new Set((data.tools ?? []).map((tool) => tool.id))
  return proposals.flatMap((proposal) => ((proposal.state === 'ready' || proposal.state === 'secret') && proposal.tool !== undefined && !have.has(proposal.id) ? [proposal.tool] : []))
}

/** The team with the proposed tools added. */
export function withProposals(data: RosterDataShape, tools: readonly RosterToolShape[]): RosterDataShape {
  return tools.reduce((next, tool) => setTool(next, tool), data)
}

/** Who a tool is for, as the review shows it. */
export function scopeWords(tool: Pick<RosterToolShape, 'apps' | 'agents'>, agentName: (id: string) => string): string {
  if (tool.agents !== undefined) return `the runs of ${tool.agents.map(agentName).join(', ')}`
  return tool.apps === undefined ? 'every app' : tool.apps.map((harness) => ROSTER_APP_NAMES[harness]).join(', ')
}
