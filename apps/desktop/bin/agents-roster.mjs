// MODULE: agents-roster.mjs - Epic 60: parse, validate and print the owner's typed agent roster (~/.config/bmn/agents/roster.md)
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * The roster is Markdown: a `## <section>` per agent and per table, each holding exactly one fenced
 * `yaml` block of machine fields followed by prose nothing parses. The packaged CLI runs without
 * node_modules, so the YAML here is a strict subset read by this file alone: block maps, block
 * lists of scalars, flow lists and flow maps, plain and quoted scalars, `#` comments. Anchors,
 * aliases, tags, multi-line scalars and documents are refused rather than half-understood.
 */

/** The layout BMN writes for a new team. A team file in an older layout BMN still reads keeps reading, and stays approved, as it is. */
export const SCHEMA_VERSION = 3
/** The oldest layout BMN still reads. Schema 3 only adds to it, so a schema 2 file means what it meant. */
export const OLDEST_SCHEMA_VERSION = 2
export function schemaSupported(version) {
  return Number.isSafeInteger(version) && version >= OLDEST_SCHEMA_VERSION && version <= SCHEMA_VERSION
}
export const HARNESSES = ['claude', 'codex', 'opencode']
/**
 * Apps BMN supported once and retired (Epic 71), with how they are named. A team file that still
 * names one is read, with a note; nothing runs on it, and Team proposes removing it. The support
 * itself is kept at a git tag, so it can come back.
 */
export const RETIRED_APPS = { cursor: 'Cursor' }
export const RETIRED_ON = '2026-10-14'
export const RETIRED_TAG = 'cursor-support-final'
/** The apps a team file's lists may name: the ones BMN serves, then the retired ones, which an old file may still hold. */
export const LISTED_APPS = [...HARNESSES, ...Object.keys(RETIRED_APPS)]
/** Whether an app is one BMN retired. */
export function isRetired(app) {
  return typeof app === 'string' && Object.hasOwn(RETIRED_APPS, app)
}
/** How BMN names an app, a retired one included; an id it does not know is shown as written. */
export function appName(app) {
  return APP_NAMES[app] ?? RETIRED_APPS[app] ?? app
}
/** What every command says when it is asked for a retired app, in place of "unknown app". */
export function retiredWords(app) {
  return `${RETIRED_APPS[app]} was retired on ${RETIRED_ON}; BMN's support for it is kept at the git tag ${RETIRED_TAG}`
}
/** Each retired app's program, so a command that starts one is named for what it was. */
export const RETIRED_PROGRAMS = { 'cursor-agent': 'cursor' }
/** The retired app a command's program (a name or a path) starts, or null. */
export function retiredProgram(command) {
  const name = typeof command === 'string' ? command.slice(command.lastIndexOf('/') + 1) : ''
  return Object.hasOwn(RETIRED_PROGRAMS, name) ? RETIRED_PROGRAMS[name] : null
}
/** What a command says of an app it cannot take: that it was retired, or else its own words. */
export function appRefusal(app, words) {
  return isRetired(app) ? retiredWords(app) : words
}
/**
 * What an agent's `harness` says in place of an agent app when BMN itself calls the model (65.1):
 * such an agent runs in no app, takes no dispatch, and is asked through a command of BMN's own.
 */
export const CALLED_BY_BMN = 'bmn'
export const CALLED_WORDS = 'called by BMN'
/** Whether an agent is called by BMN itself instead of running in an agent app. */
export function isCalled(agent) {
  return agent?.harness === CALLED_BY_BMN
}
/** How BMN names each agent app to the owner, in the order they are always listed. */
export const APP_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
/**
 * Apps that get public work only whatever their destination reads. OpenCode converts older
 * configuration shapes BMN does not read (a model entry's own `provider`, a variant's direct
 * fields, renamed providers), so its reading cannot rule out another endpoint; it stays here by
 * owner decision 2026-10-14 after the fifth review found one more.
 */
export const PUBLIC_ONLY_APPS = ['opencode']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** The five chess classes: a knight leads an epic/project, a queen may hold any role, a rook designs, a bishop reviews and advises, a pawn does jobs a lead hands off. */
export const CLASSES = ['knight', 'queen', 'rook', 'bishop', 'pawn']
export const STATUSES = ['active', 'proposed']
export const THEN = ['lead', 'skip', 'blocked', 'owner-chooses']
export const PRIVATE_WORK = ['allowed', 'public_only']
export const PAID_BY = ['per_token', 'subscription']
export const BASES = ['observed-default', 'owner-declared']
/** Sections that are not agents. */
export const RESERVED_SECTIONS = ['roster', 'roles', 'providers', 'exceptions', 'harness-routes', 'skills', 'tools', 'project-choices']
export const MAX_EXCEPTIONS = 64
export const MAX_PROJECT_CHOICES = 256
/** A project choice (73.2): who answers a role's asks in one project, at an effort, until an end date. */
export const PROJECT_CHOICE_FIELDS = ['project', 'role', 'agent', 'effort', 'ends']
export const MAX_SKILLS = 256
export const MAX_TOOLS = 64
/** A tool's id: the name its entry carries in each app's own settings. */
export const TOOL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** The name of an environment variable; a tool names variables, it never holds their values. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
export const TOOL_FIELDS = ['name', 'command', 'args', 'url', 'env', 'headers', 'public', 'apps', 'agents']
/** A skill's name is its folder's name in the skills source. */
export const SKILL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** The role only a knight or a queen may hold. */
export const LEAD_ROLE = 'lead'
/** The role only a rook or a queen may hold: the design pass. */
export const DESIGNER_ROLE = 'designer'
/** The role only an agent called by BMN may hold, and the only one it may hold (65.1). */
export const JUDGE_ROLE = 'judge'
export const JUDGE_DESCRIPTION = 'answers typed questions about a text with numbers; advice only'
/** Roles only some classes may hold, with the refusal another class gets. Every other role is open to every class, and every role to a queen. */
export const CLASS_ROLES = {
  [LEAD_ROLE]: { classes: ['knight', 'queen'], code: 'CLASS_CANNOT_LEAD', rule: 'only a knight or a queen leads' },
  [DESIGNER_ROLE]: { classes: ['rook', 'queen'], code: 'CLASS_CANNOT_DESIGN', rule: 'only a rook or a queen designs' }
}

/** Why an agent of this class may not hold a role, or null when it may. */
export function classRefusal(agentClass, role) {
  const rule = Object.hasOwn(CLASS_ROLES, role) ? CLASS_ROLES[role] : undefined
  return rule === undefined || rule.classes.includes(agentClass) ? null : rule
}
export const ID_PATTERN = /^[a-z0-9-]{1,32}$/
const CANDIDATE_PATTERN = /^([a-z0-9-]{1,32})@([a-z]+(?:\|[a-z]+)*)$/
const HOST_PATTERN = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

/** Machine fields that are the owner's free text: status shows them only as changed plus a hash. */
export const FREE_TEXT_FIELDS = ['enabled_note', 'description']

const REQUIRED_AGENT_FIELDS = ['name', 'class', 'harness', 'model', 'provider', 'host', 'enabled', 'status', 'efforts', 'roles']
const OPTIONAL_AGENT_FIELDS = ['run_by', 'aliases', 'enabled_note', 'context_window', 'context_limit', 'compact_at', 'paid_by', 'price', 'researcher']
export const AGENT_FIELDS = [...REQUIRED_AGENT_FIELDS, ...OPTIONAL_AGENT_FIELDS]
/** What an agent called by BMN never carries: it runs in no app, so it has no effort, no context and no research. */
const APP_ONLY_FIELDS = ['context_window', 'context_limit', 'compact_at', 'researcher']
const PRICE_FIELDS = ['input', 'cached_input', 'output', 'source', 'as_of']
const PROVIDER_FIELDS = ['name', 'hosts', 'sites', 'private_work']
export const ROLE_FIELDS = ['description', 'candidates', 'then', 'recheck', 'small_work', 'read_only']

/**
 * Whether BMN proposes to hold a role to read-only (63.2): every role whose name ends in `reviewer`,
 * and the consultant. A proposal only: a role is held once the approved team marks it `read_only`.
 */
export function readOnlyProposed(roleId) {
  return /reviewer$/.test(roleId) || roleId === 'consultant'
}

/** The roles of a team that BMN proposes to hold to read-only and that are not held yet. */
export function readOnlyProposal(data) {
  return (data?.roles ?? []).filter((role) => role.read_only !== true && readOnlyProposed(role.id)).map((role) => role.id)
}

/** The agent apps that have a research form the check admits. */
export const RESEARCH_APPS = ['claude', 'codex', 'opencode']

/**
 * The agents the approved team names as researchers (63.3). Null only for a team from before the
 * mark, in which no agent carries it at all: that team keeps offering every agent that can
 * research. A team that carries the mark has made its choice and names exactly the agents marked
 * `true`: none at all where every mark is `false`, so taking the last researcher away leaves
 * nobody researching, never everybody again.
 */
export function namedResearchers(data) {
  const agents = data?.agents ?? []
  if (!agents.some((agent) => typeof agent.researcher === 'boolean')) return null
  return agents.filter((agent) => agent.researcher === true).map((agent) => agent.id)
}

/**
 * Who BMN proposes as researchers while the team names none: the knights and the pawns among the
 * active agents on an app that can research, one per model, the first in the team's order. A lead
 * and a helper of each model, never the same model twice, and never an agent whose provider gets
 * public work only: it could not research. A proposal only: the owner approves it.
 */
export function researcherProposal(data) {
  if (namedResearchers(data) !== null) return []
  const seen = new Set()
  const proposed = []
  for (const agent of data?.agents ?? []) {
    if (agentState(agent) !== 'active' || !RESEARCH_APPS.includes(agent.harness) || !['knight', 'pawn'].includes(agent.class)) continue
    if (data.providers?.find((provider) => provider.id === agent.provider)?.private_work === 'public_only') continue
    const model = `${agent.harness}\n${agent.model}`
    if (seen.has(model)) continue
    seen.add(model)
    proposed.push(agent.id)
  }
  return proposed
}

/**
 * BMN's first proposal for a judge (65.1 AC7): Jev, TypeSafe AI's System One model, reached through
 * OpenCode's gateway. The two providers' private-work answer is the owner's own, given on a card on
 * 2026-10-12 with the research of 65.1 in front of him ("Allow both"); a provider his team already
 * names keeps the answer it has. The price is OpenCode's own figure, read in its docs source.
 */
export const JUDGE_PROPOSAL = {
  receives: { id: 'opencode-zen', name: 'OpenCode Zen', hosts: ['opencode.ai'], sites: ['opencode.ai'], private_work: 'allowed' },
  runs: { id: 'typesafe', name: 'TypeSafe AI', hosts: [], sites: ['typesafe.ai'], private_work: 'allowed' },
  agent: {
    id: 'jev', name: 'Jev', class: 'bishop', harness: CALLED_BY_BMN, model: 'jev-1.13', host: 'opencode.ai', enabled: true, status: 'active', efforts: [], roles: [JUDGE_ROLE],
    paid_by: 'per_token',
    price: { input: 0.042, output: 0, source: 'https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/services/www/src/docs/content/console/models.mdx', as_of: '2026-10-12' }
  }
}

/**
 * The team with BMN's judge proposal taken, or null where there is nothing to propose: the team
 * already holds an agent called by BMN or a role judge (the choice is the owner's from then on), or
 * an agent or role of another kind already uses the proposal's names. A proposal only: nothing can
 * be asked until the owner approves it like every team change.
 */
export function judgeProposal(data) {
  if (!data || data.agents.some(isCalled) || data.roles.some((role) => role.id === JUDGE_ROLE) || data.agents.some((agent) => agent.id === JUDGE_PROPOSAL.agent.id)) return null
  const providers = [...data.providers]
  const party = (wanted) => {
    // A provider the team already names for that host, or under that id, is used as it stands.
    const held = providers.find((provider) => provider.id === wanted.id || wanted.hosts.some((host) => provider.hosts.some((other) => other.toLowerCase() === host)))
    if (held !== undefined) return held.id
    providers.push({ ...wanted })
    return wanted.id
  }
  const receives = party(JUDGE_PROPOSAL.receives)
  const runs = party(JUDGE_PROPOSAL.runs)
  const receiver = providers.find((provider) => provider.id === receives)
  if (!receiver.hosts.some((host) => host.toLowerCase() === JUDGE_PROPOSAL.agent.host)) return null
  const { id, name, class: agentClass, harness, model, host, ...rest } = JUDGE_PROPOSAL.agent
  return {
    ...data, schema_version: SCHEMA_VERSION, providers,
    agents: [...data.agents, { id, name, class: agentClass, harness, model, provider: receives, run_by: runs, host, ...rest }],
    roles: [...data.roles, { id: JUDGE_ROLE, description: JUDGE_DESCRIPTION, candidates: [id], then: 'skip' }]
  }
}

/** The agents an approved team offers as a judge, in the role's order: called by BMN, candidates of the role, each with its state. */
export function judges(data) {
  const role = data?.roles.find((entry) => entry.id === JUDGE_ROLE)
  if (role === undefined) return []
  return role.candidates.map((id) => data.agents.find((agent) => agent.id === id)).filter((agent) => agent !== undefined && isCalled(agent))
}

/** The efforts a role names for an agent: its candidate entry, its effort for a recheck and the one for small work. Empty where the role does not name the agent. */
/** The efforts a first ask of a role may use with an agent: its efforts in the chain, else as the small-work candidate, else its own. */
export function initialEfforts(role, agent) {
  for (const text of role.candidates) {
    const candidate = parseCandidate(text)
    if (candidate?.agent === agent.id) return candidate.efforts
  }
  const small = role.small_work === undefined ? null : parseCandidate(role.small_work)
  if (small?.agent === agent.id) return small.efforts
  return agent.efforts
}

/** Why a project choice cannot be asked now, or null: its role or agent is gone, the agent cannot take the role, or the effort is not one the role allows it (73.2). */
export function projectChoiceProblem(data, choice) {
  const role = data.roles.find((candidate) => candidate.id === choice.role)
  if (role === undefined) return `the role ${choice.role} is not in the team`
  const agent = data.agents.find((candidate) => candidate.id === choice.agent)
  if (agent === undefined) return `${choice.agent} is not on the team`
  const state = agentState(agent)
  if (state !== 'active') return `${choice.agent} is ${state}`
  if (isCalled(agent)) return `${choice.agent} is called by BMN itself and answers no asks`
  if (!agent.roles.includes(role.id)) return `${choice.agent} does not hold the role ${role.id}`
  const rule = classRefusal(agent.class, role.id)
  if (rule !== null) return `${choice.agent} is a ${agent.class}; ${rule.rule}`
  const efforts = initialEfforts(role, agent)
  if (choice.effort !== undefined && !efforts.includes(choice.effort)) return `${choice.agent} is asked at ${efforts.join(' or ') || 'no effort'} for ${role.id}, not ${choice.effort}`
  return null
}

/** The day `now` is on this computer, written YYYY-MM-DD. */
function localDay(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Whether a choice's end date has passed: it applies through the day it names. */
export function choiceEnded(choice, now = new Date()) {
  return choice.ends !== undefined && localDay(now) > choice.ends
}

/**
 * The project choice for a role in a project, or null. `folders` are the ask's project and, for a
 * linked worktree, its repository's main folder, in that order: a choice for the repository covers
 * its worktrees and no other folder (73.2 AC1). The first folder with a choice that has not ended
 * decides, never the order of the team file; `ended` is true only when every choice that matches has
 * ended, so it no longer applies.
 */
export function projectChoiceFor(data, folders, roleId, now = new Date()) {
  let ended = null
  for (const folder of folders) {
    const choice = (data.project_choices ?? []).find((entry) => entry.role === roleId && entry.project === folder)
    if (choice === undefined) continue
    if (!choiceEnded(choice, now)) return { choice, ended: false }
    ended ??= choice
  }
  return ended === null ? null : { choice: ended, ended: true }
}

export function roleEfforts(role, agentId) {
  const efforts = []
  const add = (effort) => { if (typeof effort === 'string' && !efforts.includes(effort)) efforts.push(effort) }
  for (const text of role.candidates ?? []) {
    const candidate = parseCandidate(text)
    if (candidate?.agent === agentId) candidate.efforts.forEach(add)
  }
  if (role.recheck !== undefined && Object.hasOwn(role.recheck, agentId) && agentId !== 'same_reviewer') add(role.recheck[agentId])
  const small = role.small_work === undefined ? null : parseCandidate(role.small_work)
  if (small?.agent === agentId) small.efforts.forEach(add)
  return efforts
}
const ROUTE_FIELDS = ['provider', 'basis', 'accepted_versions']
/** What schema 1 called things, for the refusal that tells its owner what changed. */
/** What schema 3 added, for the refusal that tells an owner why a schema 2 file cannot say it. */
export const SCHEMA_3_CHANGES = 'schema 3 adds an agent called by BMN itself (harness: bmn, with run_by naming who runs the model, and no efforts, context fields or researcher mark) and the role judge that only such an agent holds; everything a schema 2 file says means what it meant'
const SCHEMA_1_CHANGES = 'schema 1 is the earlier layout: title became class (knight | queen | rook | bishop | pawn); trust, authority, security, cost, quota, tags and ## data-labels are gone; small_epic became small_work and max_context_tokens became context_limit; privacy is now ## providers with private_work: allowed | public_only'

export function agentsDirectory() {
  return `${homedir()}/.config/bmn/agents`
}

export function rosterPath() {
  return `${agentsDirectory()}/roster.md`
}

/** A stable, refusal-carrying error: `code` is what the CLI prints and the exit code is derived from it. */
export class RosterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    Object.assign(this, details)
  }
}

/** JSON with keys sorted at every level: the bytes every hash in Epic 60 is taken over. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------------------------
// YAML subset

class YamlError extends Error {
  constructor(line, message) {
    super(message)
    this.line = line
  }
}

/** The line without its comment: a `#` at the start or after a space, outside quotes. */
function stripComment(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (quote === '"' && char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) return text.slice(0, index)
  }
  return text
}

function plainScalar(text, line) {
  if (text === '') return null
  if (/^[&*!|>%@`]/.test(text) || text === '---' || text === '...') {
    throw new YamlError(line, `unsupported YAML at "${text.slice(0, 20)}": anchors, aliases, tags and block scalars are not read`)
  }
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) {
    const value = Number(text)
    if (!Number.isSafeInteger(value)) throw new YamlError(line, `number ${text} is out of range`)
    return value
  }
  // Decimals exist for prices; a version such as 0.170.0 is not one and stays text.
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

/** Reads one scalar or flow collection from `text` at `start`; returns [value, nextIndex]. */
function readFlow(text, start, line, terminators) {
  let index = start
  while (text[index] === ' ') index += 1
  const char = text[index]
  if (char === '[' || char === '{') {
    const isList = char === '['
    const close = isList ? ']' : '}'
    const out = isList ? [] : {}
    index += 1
    for (;;) {
      while (text[index] === ' ') index += 1
      if (text[index] === close) return [out, index + 1]
      if (index >= text.length) throw new YamlError(line, `unclosed ${char}`)
      if (isList) {
        const [value, next] = readFlow(text, index, line, [',', ']'])
        out.push(value)
        index = next
      } else {
        const [key, afterKey] = readKey(text, index, line, true)
        if (Object.hasOwn(out, key)) throw new YamlError(line, `duplicate key ${key}`)
        const [value, next] = readFlow(text, afterKey, line, [',', '}'])
        out[key] = value
        index = next
      }
      while (text[index] === ' ') index += 1
      if (text[index] === ',') {
        index += 1
        continue
      }
      if (text[index] === close) return [out, index + 1]
      throw new YamlError(line, `expected , or ${close}`)
    }
  }
  if (char === '"' || char === "'") return readQuoted(text, index, line)
  let end = index
  while (end < text.length && !terminators.includes(text[end])) end += 1
  return [plainScalar(text.slice(index, end).trim(), line), end]
}

function readQuoted(text, start, line) {
  const quote = text[start]
  let out = ''
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (quote === "'" && char === "'" && text[index + 1] === "'") {
      out += "'"
      index += 2
      continue
    }
    if (char === quote) return [out, index + 1]
    if (quote === '"' && char === '\\') {
      const next = text[index + 1]
      const escapes = { '"': '"', '\\': '\\', n: '\n', t: '\t', '/': '/' }
      if (!Object.hasOwn(escapes, next)) throw new YamlError(line, `unsupported escape \\${next ?? ''}`)
      out += escapes[next]
      index += 2
      continue
    }
    out += char
    index += 1
  }
  throw new YamlError(line, 'unclosed quote')
}

/** A map key up to its `:`; in flow context `,` and `}` also end it. Returns [key, indexAfterColon]. */
function readKey(text, start, line, flow) {
  let index = start
  while (text[index] === ' ') index += 1
  let key
  if (text[index] === '"' || text[index] === "'") {
    ;[key, index] = readQuoted(text, index, line)
  } else {
    let end = index
    while (end < text.length && !(text[end] === ':' && (end + 1 === text.length || text[end + 1] === ' ' || (flow && /[,}\]]/.test(text[end + 1]))))) {
      if (flow && /[,{}[\]]/.test(text[end])) break
      end += 1
    }
    key = text.slice(index, end).trim()
    index = end
    if (/^[&*!|>?%@`[{]/.test(key) || key === '') throw new YamlError(line, `unsupported or empty key "${key}"`)
  }
  while (text[index] === ' ') index += 1
  if (text[index] !== ':') throw new YamlError(line, `expected ":" after key ${key}`)
  return [key, index + 1]
}

function flowValue(text, line) {
  const [value, end] = readFlow(text, 0, line, [])
  if (text.slice(end).trim() !== '') throw new YamlError(line, `unexpected text after value: ${text.slice(end).trim()}`)
  return value
}

/**
 * Parses the subset into plain values. `lines` maps a dotted path (`roles.lead.candidates`) to the
 * file line that set it, so every refusal can name where to look. `firstLine` is the file line of
 * the block's first content line.
 */
export function parseYaml(source, firstLine = 1) {
  const rows = []
  source.split('\n').forEach((raw, offset) => {
    const line = firstLine + offset
    if (/^\s*\t/.test(raw) || /^\t/.test(raw)) throw new YamlError(line, 'tabs are not allowed for indentation')
    const text = stripComment(raw).replace(/\s+$/, '')
    if (text.trim() === '') return
    if (text.trim() === '---' || text.trim() === '...') throw new YamlError(line, 'YAML document markers are not read')
    rows.push({ line, indent: text.length - text.trimStart().length, text: text.trim() })
  })
  const lines = new Map()
  let position = 0

  function parseBlock(indent, path) {
    const first = rows[position]
    if (first.text.startsWith('- ') || first.text === '-') return parseList(indent, path)
    return parseMap(indent, path)
  }

  function parseList(indent, path) {
    const out = []
    while (position < rows.length && rows[position].indent === indent && (rows[position].text.startsWith('- ') || rows[position].text === '-')) {
      const row = rows[position]
      const rest = row.text.slice(1).trim()
      if (rest === '' || /^[^"'[{][^:]*:(\s|$)/.test(rest)) {
        throw new YamlError(row.line, 'list items must be single values; nested blocks inside lists are not read')
      }
      lines.set(`${path}[${out.length}]`, row.line)
      out.push(flowValue(rest, row.line))
      position += 1
    }
    if (position < rows.length && rows[position].indent > indent) throw new YamlError(rows[position].line, 'unexpected indentation')
    return out
  }

  function parseMap(indent, path) {
    const out = {}
    while (position < rows.length && rows[position].indent === indent) {
      const row = rows[position]
      if (row.text.startsWith('- ')) throw new YamlError(row.line, 'a list item where a key was expected')
      const [key, after] = readKey(row.text, 0, row.line, false)
      if (Object.hasOwn(out, key)) throw new YamlError(row.line, `duplicate key ${key}`)
      const keyPath = path === '' ? key : `${path}.${key}`
      lines.set(keyPath, row.line)
      const rest = row.text.slice(after).trim()
      position += 1
      if (rest !== '') {
        out[key] = flowValue(rest, row.line)
      } else if (position < rows.length && rows[position].indent > indent) {
        out[key] = parseBlock(rows[position].indent, keyPath)
      } else if (position < rows.length && rows[position].indent === indent && rows[position].text.startsWith('- ')) {
        // YAML allows a list at the same indent as its key.
        out[key] = parseList(indent, keyPath)
      } else {
        out[key] = null
      }
    }
    if (position < rows.length && rows[position].indent > indent) throw new YamlError(rows[position].line, 'unexpected indentation')
    return out
  }

  if (rows.length === 0) return { value: {}, lines }
  if (rows[0].indent !== 0) throw new YamlError(rows[0].line, 'the block must start at column 1')
  const value = parseBlock(0, '')
  if (position < rows.length) throw new YamlError(rows[position].line, 'unexpected indentation')
  if (Array.isArray(value)) throw new YamlError(rows[0].line, 'a block must be a map of fields')
  return { value, lines }
}

// ---------------------------------------------------------------------------------------------
// Markdown sections

/**
 * Splits the file into `## ` sections, tracking code fences so a heading inside one is text. Each
 * section lists its `yaml` blocks with the line range of their content and the byte range of the
 * whole fence, which revert (60.2) rewrites while every byte outside stays as it was.
 */
export function splitSections(text) {
  const sections = []
  const lines = text.split('\n')
  let offset = 0
  let fence = null
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const lineNumber = index + 1
    const lineStart = offset
    offset += raw.length + 1
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw)
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') {
        if (fence.block) {
          fence.block.endLine = lineNumber
          fence.block.contentEnd = lineStart
          fence.block.end = Math.min(offset, text.length)
          fence.block.source = lines.slice(fence.block.contentLine - 1, index).join('\n')
          current.blocks.push(fence.block)
        }
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      const isYaml = fenceMatch[2].trim() === 'yaml' && current !== null
      fence = {
        char: fenceMatch[1][0], length: fenceMatch[1].length,
        block: isYaml ? { startLine: lineNumber, contentLine: lineNumber + 1, start: lineStart, contentStart: Math.min(offset, text.length) } : null
      }
      continue
    }
    const heading = /^##[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(raw)
    if (heading && !raw.startsWith('###')) {
      current = { heading: heading[1], line: lineNumber, start: lineStart, blocks: [] }
      sections.push(current)
    }
  }
  if (fence?.block) {
    throw new RosterError('ROSTER_INVALID', 'unclosed yaml block', { errors: [{ code: 'YAML_SYNTAX', line: fence.block.startLine, message: 'unclosed yaml block' }] })
  }
  return sections
}

// ---------------------------------------------------------------------------------------------
// Validation

function isString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function distinctList(max, each) {
  return (value) => Array.isArray(value) && value.length <= max && value.every(each) && new Set(value).size === value.length
}

function parseCandidate(text) {
  const match = CANDIDATE_PATTERN.exec(String(text))
  if (!match) return null
  return { agent: match[1], efforts: match[2].split('|'), choice: match[2].includes('|') }
}

export { parseCandidate }

/**
 * Reads and validates a roster file. Returns `{ data, errors, warnings, sections }`; `data` is the
 * machine data in a canonical shape and is null whenever any error was found, so nothing invalid
 * is ever approved or printed as a team.
 */
export function parseRoster(text, { now = new Date() } = {}) {
  const errors = []
  const warnings = []
  const add = (code, line, message) => errors.push({ code, line, message })
  let sections
  try {
    sections = splitSections(text)
  } catch (error) {
    if (error instanceof RosterError) return { data: null, errors: error.errors, warnings, sections: [] }
    throw error
  }
  const seen = new Map()
  const blocks = new Map()
  for (const section of sections) {
    const id = section.heading
    if (!ID_PATTERN.test(id)) {
      add('SECTION_INVALID', section.line, `section "## ${id}" is not an agent id ([a-z0-9-]{1,32}) or one of ${RESERVED_SECTIONS.join(', ')}`)
      continue
    }
    if (seen.has(id)) {
      add('DUPLICATE_ID', section.line, `"## ${id}" appears twice (first at line ${seen.get(id)})`)
      continue
    }
    seen.set(id, section.line)
    if (section.blocks.length === 0) {
      add('MISSING_BLOCK', section.line, `"## ${id}" has no fenced yaml block`)
      continue
    }
    if (section.blocks.length > 1) {
      add('DUPLICATE_BLOCK', section.blocks[1].startLine, `"## ${id}" has more than one yaml block`)
      continue
    }
    const block = section.blocks[0]
    try {
      const parsed = parseYaml(block.source, block.contentLine)
      blocks.set(id, { ...parsed, section, block })
    } catch (error) {
      if (!(error instanceof YamlError)) throw error
      const duplicate = /^duplicate key/.test(error.message)
      add(duplicate ? 'DUPLICATE_KEY' : 'YAML_SYNTAX', error.line, error.message)
    }
  }

  // ## roster: the schema version, read first because nothing else means anything without it.
  const header = blocks.get('roster')
  if (!header) {
    if (!seen.has('roster')) add('SCHEMA_VERSION', 1, `missing "## roster" section with schema_version: ${SCHEMA_VERSION}`)
  } else {
    for (const key of Object.keys(header.value)) {
      if (key !== 'schema_version') add('UNKNOWN_FIELD', header.lines.get(key), `unknown field ${key} in ## roster`)
    }
    if (!schemaSupported(header.value.schema_version)) {
      const found = header.value.schema_version
      add('SCHEMA_VERSION', header.lines.get('schema_version') ?? header.block.startLine,
        `schema_version must be ${SCHEMA_VERSION} (or ${OLDEST_SCHEMA_VERSION}, the layout before it)${found === undefined ? '' : `, not ${found}`}${found === 1 ? `; ${SCHEMA_1_CHANGES}` : ''}`)
      return { data: null, errors, warnings, sections }
    }
  }
  // A file without the section already has its error; what it holds is read as the newest layout.
  const schema = header?.value.schema_version ?? SCHEMA_VERSION

  const providers = validateProviders(blocks.get('providers'), add)
  const providerIds = new Set(blocks.get('providers') ? Object.keys(blocks.get('providers').value) : [])
  const agents = []
  for (const [id, entry] of blocks) {
    if (RESERVED_SECTIONS.includes(id)) continue
    agents.push(validateAgent(id, entry, providerIds, add, schema))
  }
  const agentById = new Map(agents.filter(Boolean).map((agent) => [agent.id, agent]))
  const agentIds = new Set([...seen.keys()].filter((id) => !RESERVED_SECTIONS.includes(id)))

  const warn = (code, line, message) => warnings.push({ code, line, message })
  const routes = validateRoutes(blocks.get('harness-routes'), providerIds, add, warn)
  const roles = validateRoles(blocks.get('roles'), agentById, agentIds, add, warnings, schema)
  const exceptions = validateExceptions(blocks.get('exceptions'), providerIds, add, warn)
  const skills = validateSkills(blocks.get('skills'), add, warn)
  const tools = validateTools(blocks.get('tools'), agentIds, add, warn)
  const projectChoices = validateProjectChoices(blocks.get('project-choices'), add, warn)

  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const roleIds = new Set(roles.map((role) => role.id))
  // A role judge that is written but wrong has its own error already.
  const rolesBlock = blocks.get('roles')
  const judgeWritten = isMap(rolesBlock?.value) && Object.hasOwn(rolesBlock.value, JUDGE_ROLE)
  for (const agent of agentById.values()) {
    const entry = blocks.get(agent.id)
    if (isRetired(agent.harness)) warn('APP_RETIRED', entry.lines.get('harness'), `${agent.id} runs in ${retiredWords(agent.harness)}; nothing runs on it, and BMN proposes removing it on Team`)
    const route = routes.find((candidate) => candidate.harness === agent.harness)
    if (isCalled(agent) && !roleIds.has(JUDGE_ROLE) && !judgeWritten && agent.roles.includes(JUDGE_ROLE)) {
      // Said as an error, not as the warning other roles get: without the role nothing could ever ask this agent.
      add('ROLE_UNKNOWN', entry.lines.get('roles'), `${agent.id} holds role ${JUDGE_ROLE}, which ## roles does not hold; add ${JUDGE_ROLE} there with ${agent.id} as its candidate`)
    }
    if (agent.host === 'default' && route !== undefined && route.provider !== agent.provider) {
      add('ROUTE_CONFLICT', entry.lines.get('host'),
        `${agent.id} has host: default on ${agent.harness}, whose default provider is ${route.provider}, not ${agent.provider}`)
    }
    const provider = providerById.get(agent.provider)
    if (typeof agent.host === 'string' && agent.host !== 'default' && provider !== undefined
      && !provider.hosts.some((host) => host.toLowerCase() === agent.host.toLowerCase())) {
      add('HOST_UNLISTED', entry.lines.get('host'), `${agent.id}.host ${agent.host} is not among provider ${agent.provider}'s hosts`)
    }
    for (const role of agent.roles) {
      if (!roleIds.has(role)) warnings.push({ code: 'ROLE_WITHOUT_CHAIN', line: entry.lines.get('roles'), message: `${agent.id} holds role ${role}, which has no chain in ## roles` })
    }
  }

  // A choice whose agent can no longer answer, or that ended, leaves the team valid: the check says so, and asks there are refused (73.2 AC4).
  const choiceData = { agents: agents.filter(Boolean), roles }
  for (const choice of projectChoices.project_choices ?? []) {
    const line = blocks.get('project-choices').lines.get(choice.id)
    const problem = projectChoiceProblem(choiceData, choice)
    if (problem !== null) warn('PROJECT_CHOICE_UNAVAILABLE', line, `## project-choices.${choice.id}: ${problem}; ${choice.role} asks in that project are refused until the choice is changed`)
    if (choiceEnded(choice, now)) warn('PROJECT_CHOICE_ENDED', line, `## project-choices.${choice.id} ended on ${choice.ends}; it no longer applies`)
  }

  if (errors.length > 0) return { data: null, errors: errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), warnings, sections }
  return {
    data: { schema_version: schema, agents: agents.filter(Boolean), roles, providers, exceptions, harness_routes: routes, ...skills, ...tools, ...projectChoices },
    errors, warnings, sections
  }
}

function checkFields(entry, allowed, where, add) {
  for (const key of Object.keys(entry.value)) {
    if (!allowed.includes(key)) add('UNKNOWN_FIELD', entry.lines.get(key), `unknown field ${key} in ${where}`)
  }
}

function priceProblem(price) {
  if (!isMap(price)) return 'a map of input and output (USD per million tokens), optionally cached_input, source and as_of'
  const unknown = Object.keys(price).filter((key) => !PRICE_FIELDS.includes(key))
  if (unknown.length > 0) return `unknown field ${unknown.join(', ')}; a price holds ${PRICE_FIELDS.join(', ')}`
  const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
  for (const key of ['input', 'output']) if (!amount(price[key])) return `${key} must be a number from 0 to 1000000 (USD per million tokens)`
  if (Object.hasOwn(price, 'cached_input') && !amount(price.cached_input)) return 'cached_input must be a number from 0 to 1000000'
  if (Object.hasOwn(price, 'source') && !(isString(price.source, 200) && /^https?:\/\/\S+$/.test(price.source))) return 'source must be an http(s) URL of at most 200 characters'
  if (Object.hasOwn(price, 'as_of') && !isDate(price.as_of)) return 'as_of must be a date, YYYY-MM-DD'
  return null
}

function validateAgent(id, entry, providerIds, add, schema) {
  const { value, lines, block } = entry
  const at = (key) => lines.get(key) ?? block.startLine
  const bad = (key, message) => add('INVALID_VALUE', at(key), `${id}.${key}: ${message}`)
  checkFields(entry, AGENT_FIELDS, `agent ${id}`, add)
  let valid = Object.keys(value).every((key) => AGENT_FIELDS.includes(key))
  const called = value.harness === CALLED_BY_BMN
  for (const key of REQUIRED_AGENT_FIELDS) {
    // An agent called by BMN has no efforts to list; `run_by` is what it must name instead.
    if (called && key === 'efforts') continue
    if (!Object.hasOwn(value, key)) {
      add('MISSING_FIELD', block.startLine, `${id} is missing required field ${key}`)
      valid = false
    }
  }
  for (const key of OPTIONAL_AGENT_FIELDS) {
    if (Object.hasOwn(value, key) && value[key] === null) {
      add('NULL_OPTIONAL', at(key), `${id}.${key} is null; omit an optional field instead`)
      valid = false
    }
  }
  const check = (key, ok, message) => {
    // A required field set to null fails its own check; only an optional null is reported above instead.
    if (!Object.hasOwn(value, key) || (value[key] === null && OPTIONAL_AGENT_FIELDS.includes(key))) return
    if (!ok(value[key])) {
      bad(key, message)
      valid = false
    }
  }
  const enumOf = (options) => (v) => options.includes(v)
  const positive = (v) => Number.isSafeInteger(v) && v > 0
  check('name', (v) => isString(v, 40), 'text of 1-40 characters')
  check('class', enumOf(CLASSES), CLASSES.join(' | '))
  // A retired app is still read, so an old team file loads; the note and Team's proposal come from parseRoster.
  check('harness', enumOf([...LISTED_APPS, CALLED_BY_BMN]), `${HARNESSES.join(' | ')}, or ${CALLED_BY_BMN} for an agent BMN itself calls`)
  check('model', (v) => isString(v, 128), 'text of 1-128 characters')
  check('provider', (v) => typeof v === 'string' && ID_PATTERN.test(v), 'a provider id from ## providers')
  check('run_by', (v) => typeof v === 'string' && ID_PATTERN.test(v), 'a provider id from ## providers: who runs the model')
  if (Object.hasOwn(value, 'host') && value.host !== null && !(value.host === 'default' || (typeof value.host === 'string' && HOST_PATTERN.test(value.host)))) {
    bad('host', 'a hostname (optionally :port), default, or null')
    valid = false
  }
  check('enabled', (v) => typeof v === 'boolean', 'true | false')
  check('status', enumOf(STATUSES), STATUSES.join(' | '))
  check('efforts', distinctList(EFFORTS.length, (e) => EFFORTS.includes(e)), `a list of distinct efforts from ${EFFORTS.join(', ')}`)
  check('roles', distinctList(32, (r) => typeof r === 'string' && ID_PATTERN.test(r)), 'a list of distinct role ids')
  check('aliases', distinctList(4, (a) => isString(a, 64)), 'at most 4 distinct aliases of 1-64 characters')
  check('enabled_note', (v) => isString(v, 120), 'text of 1-120 characters')
  check('context_window', positive, 'a positive whole number')
  check('context_limit', positive, 'a positive whole number')
  check('compact_at', positive, 'a positive whole number')
  check('paid_by', enumOf(PAID_BY), PAID_BY.join(' | '))
  check('researcher', (v) => typeof v === 'boolean', 'true | false')
  if (Object.hasOwn(value, 'price') && value.price !== null) {
    const problem = priceProblem(value.price)
    if (problem !== null) {
      bad('price', problem)
      valid = false
    }
  }
  if (!valid) return null
  if (!providerIds.has(value.provider)) {
    add('UNKNOWN_PROVIDER', at('provider'), `${id}.provider: ${value.provider} is not in ## providers`)
    return null
  }
  if (called) return calledAgent(id, value, at, providerIds, add, schema)
  if (Object.hasOwn(value, 'run_by')) {
    add('CALLED_ONLY', at('run_by'), `${id}.run_by: only an agent called by BMN (harness: ${CALLED_BY_BMN}) names who runs its model; ${id} runs in ${appName(value.harness)}`)
    return null
  }
  if (value.roles.includes(JUDGE_ROLE)) {
    add('JUDGE_NOT_CALLED', at('roles'), `${id} holds role ${JUDGE_ROLE}; only an agent called by BMN (harness: ${CALLED_BY_BMN}) holds it, and ${id} runs in ${appName(value.harness)}`)
    return null
  }
  if (value.efforts.length === 0 && value.enabled) {
    bad('efforts', 'empty efforts are allowed only when enabled is false')
    return null
  }
  if (value.compact_at !== undefined && value.context_limit === undefined) {
    bad('compact_at', 'allowed only together with context_limit')
    return null
  }
  if (value.compact_at !== undefined && value.compact_at >= value.context_limit) {
    bad('compact_at', `must be below context_limit (${value.context_limit})`)
    return null
  }
  if (value.context_window !== undefined && value.context_limit !== undefined && value.context_limit > value.context_window) {
    bad('context_limit', `must not exceed context_window (${value.context_window})`)
    return null
  }
  for (const role of value.roles) {
    const refusal = classRefusal(value.class, role)
    if (refusal === null) continue
    add(refusal.code, at('roles'), `${id} is a ${value.class} holding role ${role}; ${refusal.rule}`)
    return null
  }
  const agent = { id }
  for (const key of AGENT_FIELDS) if (Object.hasOwn(value, key)) agent[key] = value[key]
  return agent
}

/**
 * An agent BMN itself calls (65.1): the same name, class, model, provider, host, switch, status and
 * roles as every agent, plus who runs the model. It runs in no app, so each field that belongs to
 * an app is refused with its line, and it holds the role judge and no other.
 */
function calledAgent(id, value, at, providerIds, add, schema) {
  const fail = (code, key, message) => {
    add(code, at(key), `${id}.${key}: ${message}`)
    return null
  }
  if (schema < 3) return fail('SCHEMA_VERSION', 'harness', `an agent called by BMN needs schema_version: 3 in ## roster, and this file says ${schema}; ${SCHEMA_3_CHANGES}`)
  if (Object.hasOwn(value, 'efforts') && value.efforts.length > 0) return fail('CALLED_FIELD', 'efforts', `${id} is called by BMN and has no efforts (it runs in no agent app); remove the line`)
  for (const key of APP_ONLY_FIELDS) {
    if (!Object.hasOwn(value, key)) continue
    const what = key === 'researcher' ? 'the researcher mark' : `a ${key.replace('_', ' ')}`
    return fail('CALLED_FIELD', key, `${id} is called by BMN and carries no ${what.replace(/^(a|the) /, '')} (it runs in no agent app); remove the line`)
  }
  if (!Object.hasOwn(value, 'run_by')) {
    add('MISSING_FIELD', at('harness'), `${id} is called by BMN and is missing run_by: the provider that runs the model (provider is who receives the request)`)
    return null
  }
  if (!providerIds.has(value.run_by)) return fail('UNKNOWN_PROVIDER', 'run_by', `${value.run_by} is not in ## providers`)
  if (value.host === null || value.host === 'default') return fail('INVALID_VALUE', 'host', `${id} is called by BMN, so host is the hostname BMN sends the request to, not ${value.host}`)
  const other = value.roles.find((role) => role !== JUDGE_ROLE)
  if (other !== undefined) return fail('CALLED_ROLE', 'roles', `${id} is called by BMN and holds role ${other}; such an agent holds the role ${JUDGE_ROLE} and no other`)
  const agent = { id }
  for (const key of AGENT_FIELDS) if (Object.hasOwn(value, key)) agent[key] = value[key]
  // No efforts in the file; an empty list here, so nothing that reads an agent's efforts has two shapes to know.
  agent.efforts = []
  return agent
}

function validateProviders(entry, add) {
  if (!entry) return []
  const providers = []
  const hostOwner = new Map()
  for (const [id, provider] of Object.entries(entry.value)) {
    const line = entry.lines.get(id)
    if (!ID_PATTERN.test(id)) {
      add('INVALID_VALUE', line, `## providers: provider id ${id} must match [a-z0-9-]{1,32}`)
      continue
    }
    if (!isMap(provider)) {
      add('INVALID_VALUE', line, `## providers.${id} must be a map of name, hosts and private_work`)
      continue
    }
    let ok = true
    const fail = (code, key, message) => {
      add(code, entry.lines.get(`${id}.${key}`) ?? line, `## providers.${id}: ${message}`)
      ok = false
    }
    for (const key of Object.keys(provider)) {
      if (!PROVIDER_FIELDS.includes(key)) fail('UNKNOWN_FIELD', key, `unknown field ${key}`)
    }
    if (!isString(provider.name, 40)) fail('INVALID_VALUE', 'name', 'name must be text of 1-40 characters')
    if (!distinctList(8, (host) => typeof host === 'string' && HOST_PATTERN.test(host))(provider.hosts)) {
      fail('INVALID_VALUE', 'hosts', 'hosts must be a list of at most 8 distinct hostnames')
    }
    if (Object.hasOwn(provider, 'sites')) {
      if (provider.sites === null) fail('NULL_OPTIONAL', 'sites', 'sites is null; omit it instead')
      else if (!distinctList(4, (site) => typeof site === 'string' && DOMAIN_PATTERN.test(site))(provider.sites)) fail('INVALID_VALUE', 'sites', 'sites must be a list of at most 4 distinct domains')
    }
    if (!PRIVATE_WORK.includes(provider.private_work)) fail('INVALID_VALUE', 'private_work', `private_work must be ${PRIVATE_WORK.join(' | ')}`)
    if (!ok) continue
    for (const host of provider.hosts) {
      const key = host.toLowerCase()
      if (hostOwner.has(key)) fail('DUPLICATE_HOST', 'hosts', `host ${host} is also listed by provider ${hostOwner.get(key)}`)
      else hostOwner.set(key, id)
    }
    if (ok) providers.push({ id, ...provider })
  }
  return providers
}

function validateRoutes(entry, providerIds, add, warn) {
  if (!entry) return []
  const routes = []
  for (const [harness, route] of Object.entries(entry.value)) {
    const line = entry.lines.get(harness)
    if (isRetired(harness)) warn('APP_RETIRED', line, `## harness-routes.${harness}: ${retiredWords(harness)}; BMN proposes removing this route on Team`)
    else if (!HARNESSES.includes(harness)) {
      add('UNKNOWN_FIELD', line, `## harness-routes: unknown harness ${harness}`)
      continue
    }
    if (!isMap(route)) {
      add('INVALID_VALUE', line, `## harness-routes.${harness} must be a map of provider and basis`)
      continue
    }
    let ok = true
    for (const key of Object.keys(route)) {
      if (!ROUTE_FIELDS.includes(key)) {
        add('UNKNOWN_FIELD', entry.lines.get(`${harness}.${key}`) ?? line, `## harness-routes.${harness}: unknown field ${key}`)
        ok = false
      }
    }
    const fail = (code, message) => {
      add(code, line, `## harness-routes.${harness}: ${message}`)
      ok = false
    }
    if (typeof route.provider !== 'string' || !ID_PATTERN.test(route.provider)) fail('INVALID_VALUE', 'provider must be a provider id from ## providers')
    else if (!providerIds.has(route.provider)) fail('UNKNOWN_PROVIDER', `provider ${route.provider} is not in ## providers`)
    if (!BASES.includes(route.basis)) fail('INVALID_VALUE', `basis must be ${BASES.join(' | ')}`)
    if (Object.hasOwn(route, 'accepted_versions')) {
      const versions = route.accepted_versions
      if (versions === null) {
        add('NULL_OPTIONAL', line, `## harness-routes.${harness}.accepted_versions is null; omit it instead`)
        ok = false
      } else if (!distinctList(8, (version) => isString(version, 64))(versions)) {
        fail('INVALID_VALUE', 'accepted_versions must be at most 8 distinct quoted version strings')
      }
    }
    if (ok) routes.push({ harness, ...route })
  }
  return routes
}

function validateRoles(entry, agentById, agentIds, add, warnings, schema) {
  if (!entry) return []
  const roles = []
  for (const [id, role] of Object.entries(entry.value)) {
    const line = entry.lines.get(id)
    if (id === JUDGE_ROLE) {
      const judge = validateJudge(role, entry, agentById, agentIds, add, warnings, schema)
      if (judge !== null) roles.push(judge)
      continue
    }
    if (!ID_PATTERN.test(id)) {
      add('INVALID_VALUE', line, `## roles: role id ${id} must match [a-z0-9-]{1,32}`)
      continue
    }
    if (!isMap(role)) {
      add('INVALID_VALUE', line, `## roles.${id} must be a map with candidates and then`)
      continue
    }
    let ok = true
    const fail = (code, message) => {
      add(code, entry.lines.get(`${id}.${message.key}`) ?? line, `## roles.${id}: ${message.text}`)
      ok = false
    }
    for (const key of Object.keys(role)) {
      if (!ROLE_FIELDS.includes(key)) fail('UNKNOWN_FIELD', { key, text: `unknown field ${key}` })
    }
    if (Object.hasOwn(role, 'description')) {
      if (role.description === null) fail('NULL_OPTIONAL', { key: 'description', text: 'description is null; omit it instead' })
      else if (!isString(role.description, 80)) fail('INVALID_VALUE', { key: 'description', text: 'description must be text of 1-80 characters' })
    }
    if (!Array.isArray(role.candidates)) fail('INVALID_VALUE', { key: 'candidates', text: 'candidates must be a list of agent@effort' })
    if (!THEN.includes(role.then)) fail('INVALID_VALUE', { key: 'then', text: `then must be ${THEN.join(' | ')}` })
    const candidateAgents = new Set()
    const checkCandidate = (text, key, single) => {
      const candidate = parseCandidate(text)
      if (candidate === null || candidate.efforts.some((effort) => !EFFORTS.includes(effort))
        || new Set(candidate.efforts).size !== candidate.efforts.length || (single && candidate.choice)) {
        fail('INVALID_VALUE', { key, text: `"${text}" must be agent@effort${single ? '' : ' or agent@effort|effort'}` })
        return null
      }
      if (!agentIds.has(candidate.agent)) {
        fail('UNKNOWN_AGENT', { key, text: `"${text}" names unknown agent ${candidate.agent}` })
        return null
      }
      const agent = agentById.get(candidate.agent)
      if (agent === undefined) return candidate // its own section already failed and is reported there
      if (isCalled(agent)) {
        fail('CALLED_ROLE', { key, text: `"${text}": ${agent.id} is called by BMN and may be a candidate of the role ${JUDGE_ROLE} only` })
        return null
      }
      for (const effort of candidate.efforts) {
        if (!agent.efforts.includes(effort)) fail('EFFORT_NOT_LISTED', { key, text: `"${text}": ${agent.id} does not list effort ${effort}` })
      }
      if (!agent.roles.includes(id)) fail('ROLE_NOT_HELD', { key, text: `"${text}": ${agent.id} does not hold role ${id} in its own roles` })
      const refusal = classRefusal(agent.class, id)
      if (refusal !== null) fail(refusal.code, { key, text: `"${text}": ${agent.id} is a ${agent.class}; ${refusal.rule}` })
      if (!agent.enabled) warnings.push({ code: 'CANDIDATE_DISABLED', line: entry.lines.get(`${id}.${key}`) ?? line, message: `## roles.${id}: ${agent.id} is disabled` })
      return candidate
    }
    if (Array.isArray(role.candidates)) {
      const texts = new Set()
      role.candidates.forEach((text, index) => {
        if (typeof text !== 'string' || texts.has(text)) {
          fail('INVALID_VALUE', { key: `candidates`, text: `candidate ${index + 1} is not a distinct agent@effort` })
          return
        }
        texts.add(text)
        const candidate = checkCandidate(text, 'candidates', false)
        if (candidate) candidateAgents.add(candidate.agent)
      })
    }
    if (Object.hasOwn(role, 'recheck')) {
      const recheck = role.recheck
      if (!isMap(recheck)) {
        fail('INVALID_VALUE', { key: 'recheck', text: 'recheck must be a map: same_reviewer plus agent: effort overrides' })
      } else {
        if (typeof recheck.same_reviewer !== 'boolean') fail('INVALID_VALUE', { key: 'recheck', text: 'recheck.same_reviewer must be true or false' })
        for (const [agentId, effort] of Object.entries(recheck)) {
          if (agentId === 'same_reviewer') continue
          if (!ID_PATTERN.test(agentId) || !agentIds.has(agentId)) {
            fail('UNKNOWN_AGENT', { key: 'recheck', text: `recheck names unknown agent ${agentId}` })
          } else if (!candidateAgents.has(agentId)) {
            fail('INVALID_VALUE', { key: 'recheck', text: `recheck override ${agentId} is not a candidate of this role` })
          } else if (!EFFORTS.includes(effort) || (agentById.get(agentId) && !agentById.get(agentId).efforts.includes(effort))) {
            fail('EFFORT_NOT_LISTED', { key: 'recheck', text: `recheck ${agentId}: ${effort} is not an effort ${agentId} lists` })
          }
        }
      }
    }
    if (Object.hasOwn(role, 'small_work')) {
      if (role.small_work === null || typeof role.small_work !== 'string') fail('INVALID_VALUE', { key: 'small_work', text: 'small_work must be agent@effort' })
      else checkCandidate(role.small_work, 'small_work', true)
    }
    if (Object.hasOwn(role, 'read_only') && typeof role.read_only !== 'boolean') fail('INVALID_VALUE', { key: 'read_only', text: 'read_only must be true or false' })
    if (ok) {
      const out = { id }
      for (const key of ROLE_FIELDS) if (Object.hasOwn(role, key)) out[key] = role[key]
      roles.push(out)
    }
  }
  return roles
}

/**
 * The role judge (65.1): its candidates are agents called by BMN, named by their id alone since
 * such an agent has no effort. It has a description, candidates and `then`, and nothing else.
 */
function validateJudge(role, entry, agentById, agentIds, add, warnings, schema) {
  const line = entry.lines.get(JUDGE_ROLE)
  let ok = true
  const fail = (code, key, text) => {
    add(code, entry.lines.get(`${JUDGE_ROLE}.${key}`) ?? line, `## roles.${JUDGE_ROLE}: ${text}`)
    ok = false
  }
  if (schema < 3) {
    fail('SCHEMA_VERSION', 'candidates', `the role ${JUDGE_ROLE} needs schema_version: 3 in ## roster, and this file says ${schema}; ${SCHEMA_3_CHANGES}`)
    return null
  }
  if (!isMap(role)) {
    fail('INVALID_VALUE', 'candidates', 'must be a map with candidates and then')
    return null
  }
  for (const key of Object.keys(role)) {
    if (!ROLE_FIELDS.includes(key)) fail('UNKNOWN_FIELD', key, `unknown field ${key}`)
    else if (!['description', 'candidates', 'then'].includes(key)) fail('INVALID_VALUE', key, `${key} belongs to a role that agent apps run; ${JUDGE_ROLE} holds a description, candidates and then`)
  }
  if (Object.hasOwn(role, 'description')) {
    if (role.description === null) fail('NULL_OPTIONAL', 'description', 'description is null; omit it instead')
    else if (!isString(role.description, 80)) fail('INVALID_VALUE', 'description', 'description must be text of 1-80 characters')
  }
  if (!THEN.includes(role.then)) fail('INVALID_VALUE', 'then', `then must be ${THEN.join(' | ')}`)
  if (!Array.isArray(role.candidates)) {
    fail('INVALID_VALUE', 'candidates', 'candidates must be a list of agents called by BMN, each by its id')
  } else {
    const named = new Set()
    role.candidates.forEach((text, index) => {
      if (typeof text !== 'string' || named.has(text)) return fail('INVALID_VALUE', 'candidates', `candidate ${index + 1} is not a distinct agent id`)
      named.add(text)
      if (!ID_PATTERN.test(text)) return fail('INVALID_VALUE', 'candidates', `"${text}" must be the id of an agent called by BMN, with no @effort: such an agent has no effort`)
      if (!agentIds.has(text)) return fail('UNKNOWN_AGENT', 'candidates', `"${text}" names unknown agent ${text}`)
      const agent = agentById.get(text)
      if (agent === undefined) return undefined // its own section already failed and is reported there
      if (!isCalled(agent)) return fail('JUDGE_NOT_CALLED', 'candidates', `"${text}": only an agent called by BMN may be a candidate of ${JUDGE_ROLE}, and ${agent.id} runs in ${appName(agent.harness)}`)
      if (!agent.roles.includes(JUDGE_ROLE)) return fail('ROLE_NOT_HELD', 'candidates', `"${text}": ${agent.id} does not hold role ${JUDGE_ROLE} in its own roles`)
      if (!agent.enabled) warnings.push({ code: 'CANDIDATE_DISABLED', line: entry.lines.get(`${JUDGE_ROLE}.candidates`) ?? line, message: `## roles.${JUDGE_ROLE}: ${agent.id} is disabled` })
      return undefined
    })
  }
  if (!ok) return null
  const out = { id: JUDGE_ROLE }
  for (const key of ROLE_FIELDS) if (Object.hasOwn(role, key)) out[key] = role[key]
  return out
}

/** The directory a path names, with symbolic links followed where the path exists. */
export function resolvedDirectory(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * `## exceptions`: one entry per public-only provider the owner allowed in one workspace, keyed
 * by an opaque id (the only part of an exception a receipt ever carries).
 */
function validateExceptions(entry, providerIds, add, warn) {
  if (!entry) return []
  const exceptions = []
  const resolved = new Map()
  const ids = Object.keys(entry.value)
  if (ids.length > MAX_EXCEPTIONS) add('INVALID_VALUE', entry.block.startLine, `## exceptions holds ${ids.length} entries; at most ${MAX_EXCEPTIONS}`)
  for (const [id, exception] of Object.entries(entry.value)) {
    const line = entry.lines.get(id)
    if (!ID_PATTERN.test(id)) {
      add('INVALID_VALUE', line, `## exceptions: id ${id} must match [a-z0-9-]{1,32}`)
      continue
    }
    if (!isMap(exception)) {
      add('INVALID_VALUE', line, `## exceptions.${id} must be a map of provider and folder`)
      continue
    }
    const unknown = Object.keys(exception).filter((key) => key !== 'provider' && key !== 'folder')
    if (unknown.length > 0) {
      add('UNKNOWN_FIELD', line, `## exceptions.${id}: unknown field ${unknown.join(', ')}`)
      continue
    }
    if (typeof exception.provider !== 'string' || !ID_PATTERN.test(exception.provider)) {
      add('INVALID_VALUE', line, `## exceptions.${id}: provider must be a provider id from ## providers`)
      continue
    }
    if (!providerIds.has(exception.provider)) {
      add('UNKNOWN_PROVIDER', line, `## exceptions.${id}: provider ${exception.provider} is not in ## providers`)
      continue
    }
    const folder = exception.folder
    const parts = typeof folder === 'string' ? folder.split('/') : []
    if (!isString(folder, 4096) || !folder.startsWith('/') || parts.includes('..') || parts.includes('.')) {
      add('EXCEPTION_PATH', line, `## exceptions.${id}: folder must be an absolute path without . or .. (nothing is expanded, not even ~)`)
      continue
    }
    const path = folder.length > 1 ? folder.replace(/\/+$/, '') : folder
    // The check compares this text with a workspace's real path and follows no link, so what was
    // approved can never come to mean another folder. A path through a link grants nothing; say so.
    const real = resolvedDirectory(path)
    if (real !== path) warn('EXCEPTION_LINK', line, `## exceptions.${id}: folder passes through a link; an exception counts only for a workspace's real path, so write that path`)
    const key = `${exception.provider}\n${real}`
    if (resolved.has(key)) {
      add('EXCEPTION_COLLISION', line, `## exceptions.${id} names the same folder as ${resolved.get(key)} for provider ${exception.provider}`)
      continue
    }
    resolved.set(key, id)
    exceptions.push({ id, provider: exception.provider, folder: path })
  }
  return exceptions
}

/**
 * `## project-choices` (73.2): the owner's teammate for one role in one project, keyed by an id.
 * Only its shape is an error here; whether its agent can answer now is a warning (`parseRoster`),
 * so a choice whose agent is later turned off leaves the team valid. A choice picks who answers and
 * grants nothing: private work, tools and reach stay the team's.
 */
function validateProjectChoices(entry, add, warn) {
  if (!entry || !isMap(entry.value)) return {}
  const choices = []
  const taken = new Map()
  const ids = Object.keys(entry.value)
  if (ids.length > MAX_PROJECT_CHOICES) add('INVALID_VALUE', entry.block.startLine, `## project-choices holds ${ids.length} entries; at most ${MAX_PROJECT_CHOICES}`)
  for (const [id, choice] of Object.entries(entry.value)) {
    const line = entry.lines.get(id) ?? entry.block.startLine
    const where = `## project-choices.${id}`
    if (!ID_PATTERN.test(id)) {
      add('INVALID_VALUE', line, `## project-choices: id ${id} must match [a-z0-9-]{1,32}`)
      continue
    }
    if (!isMap(choice)) {
      add('INVALID_VALUE', line, `${where} must be a map of project, role, agent and optionally effort and ends`)
      continue
    }
    const unknown = Object.keys(choice).filter((key) => !PROJECT_CHOICE_FIELDS.includes(key))
    if (unknown.length > 0) {
      add('UNKNOWN_FIELD', line, `${where}: unknown field ${unknown.join(', ')}`)
      continue
    }
    const folder = choice.project
    const parts = typeof folder === 'string' ? folder.split('/') : []
    if (!isString(folder, 4096) || !folder.startsWith('/') || folder === '/' || parts.includes('..') || parts.includes('.')) {
      add('PROJECT_CHOICE_PATH', line, `${where}: project must be the project's absolute folder, without . or .. (nothing is expanded, not even ~)`)
      continue
    }
    if (typeof choice.role !== 'string' || !ID_PATTERN.test(choice.role)) {
      add('INVALID_VALUE', line, `${where}: role must be a role id from ## roles`)
      continue
    }
    if (typeof choice.agent !== 'string' || !ID_PATTERN.test(choice.agent)) {
      add('INVALID_VALUE', line, `${where}: agent must be an agent id`)
      continue
    }
    if (Object.hasOwn(choice, 'effort') && !EFFORTS.includes(choice.effort)) {
      add('INVALID_VALUE', line, `${where}: effort must be one of ${EFFORTS.join(', ')}`)
      continue
    }
    if (Object.hasOwn(choice, 'ends') && !isDate(choice.ends)) {
      add('INVALID_VALUE', line, `${where}: ends must be a date written YYYY-MM-DD`)
      continue
    }
    const project = folder.replace(/\/+$/, '')
    // Like an exception, a choice counts only for a project's real path: what was approved never comes to mean another folder.
    if (resolvedDirectory(project) !== project) warn('PROJECT_CHOICE_LINK', line, `${where}: project passes through a link; a choice counts only for a project's real path, so write that path`)
    const key = `${project}\n${choice.role}`
    if (taken.has(key)) {
      add('PROJECT_CHOICE_COLLISION', line, `${where} names the same project and role as ${taken.get(key)}: one choice per project and role`)
      continue
    }
    taken.set(key, id)
    choices.push({ id, project, role: choice.role, agent: choice.agent, ...(Object.hasOwn(choice, 'effort') ? { effort: choice.effort } : {}), ...(Object.hasOwn(choice, 'ends') ? { ends: choice.ends } : {}) })
  }
  return choices.length > 0 ? { project_choices: choices } : {}
}

// ---------------------------------------------------------------------------------------------
// Queries over validated (or approved) machine data

export function agentState(agent) {
  // An agent on a retired app takes no work, whatever the file says of it (Epic 71).
  if (isRetired(agent.harness)) return 'retired'
  if (agent.status === 'proposed') return 'proposed'
  if (!agent.enabled) return 'disabled'
  return 'active'
}

/**
 * The provider's answer for an agent: whether its provider may see private work at all. An agent
 * called by BMN names two parties, who receives the request and who runs the model, and private
 * work is allowed for it only where both say so (65.1 AC2).
 */
export function privateWorkOf(data, agent) {
  const answer = (id) => data.providers.find((provider) => provider.id === id)?.private_work ?? 'public_only'
  if (isCalled(agent)) return answer(agent.provider) === 'allowed' && answer(agent.run_by) === 'allowed' ? 'allowed' : 'public_only'
  return answer(agent.provider)
}

/**
 * The two parties of an agent called by BMN, each with its private-work answer, and the one
 * sentence that says what follows: private work only where both allow it, otherwise public work
 * only, with who holds it back.
 */
export function calledParties(data, agent) {
  const party = (id) => {
    const provider = data.providers.find((entry) => entry.id === id)
    return { id, name: provider?.name ?? id, private_work: provider?.private_work ?? 'public_only' }
  }
  const receives = party(agent.provider)
  const runs = party(agent.run_by)
  const held = [receives, runs].filter((entry, index, all) => entry.private_work !== 'allowed' && all.findIndex((other) => other.id === entry.id) === index)
  const allowed = held.length === 0
  const names = receives.id === runs.id ? receives.name : `${receives.name} and ${runs.name}`
  const reason = allowed ? `${names} may see private work`
    : `public work only: ${held.map((entry) => entry.name).join(' and ')} ${held.length === 1 ? 'gets' : 'get'} public work only`
  return { receives, runs, allowed, reason }
}

/**
 * Whether an app's approved default destination may receive private work, with the reason in
 * words: only an inspected default whose provider answers `allowed`, in an app not in
 * PUBLIC_ONLY_APPS. Missing, owner-declared and public-only destinations get public work only (60.3 AC4,
 * 60.4 AC1), and so does every app in PUBLIC_ONLY_APPS, whatever its configuration reads today
 * (owner decisions 2026-10-10, narrowing 60.4 AC3, and 2026-10-14, which kept OpenCode on it).
 */
export function harnessPrivateWork(data, harness) {
  const app = appName(harness)
  const route = data?.harness_routes.find((entry) => entry.harness === harness)
  if (route === undefined) return { allowed: false, reason: data ? `BMN has no approved destination for ${app}` : 'nothing is approved yet', route: null, provider: null }
  const provider = data.providers.find((entry) => entry.id === route.provider) ?? null
  if (route.basis === 'owner-declared') return { allowed: false, reason: `BMN can't confirm where ${app} sends data`, route, provider }
  if (provider?.private_work !== 'allowed') return { allowed: false, reason: `${provider?.name ?? route.provider} gets public work only`, route, provider }
  if (PUBLIC_ONLY_APPS.includes(harness)) return { allowed: false, reason: `BMN does not check what ${app} sends`, route, provider }
  return { allowed: true, reason: `${provider.name} may see private work`, route, provider }
}

/**
 * Why an agent could not receive private work in a workspace without an exception (empty when it
 * could). It is judged by the agent's own destination: its provider, at its approved host. The
 * app's default destination counts only for an agent that uses it (`host: default`).
 */
export function publicOnlyReasons(agent, data) {
  if (isCalled(agent)) {
    const parties = calledParties(data, agent)
    return [parties.receives, parties.runs].filter((entry, index, all) => entry.private_work !== 'allowed' && all.findIndex((other) => other.id === entry.id) === index)
      .map((entry) => `${entry.name} gets public work only`)
  }
  const reasons = []
  const provider = data.providers.find((entry) => entry.id === agent.provider)
  const route = data.harness_routes.find((entry) => entry.harness === agent.harness)
  if (agent.host === null) reasons.push(`${agent.id}'s host is unknown`)
  if (agent.host === 'default' && route === undefined) reasons.push(`no approved destination for ${appName(agent.harness)}`)
  if (agent.host === 'default' && route?.basis === 'owner-declared') reasons.push(`the ${appName(agent.harness)} destination is owner-declared`)
  if (provider?.private_work !== 'allowed') reasons.push(`${provider?.name ?? agent.provider} gets public work only`)
  return reasons
}

/**
 * One unabridged team line: never prose, notes, prices, paid_by or exception folders. A context
 * limit is the configured one; whether BMN applied it to a run is on that run's receipt.
 */
export function teamEntry(data, agent) {
  const entry = {
    id: agent.id, name: agent.name, class: agent.class, harness: agent.harness, model: agent.model,
    provider: agent.provider, private_work: privateWorkOf(data, agent), roles: agent.roles, efforts: agent.efforts,
    state: agentState(agent)
  }
  if (agent.context_limit !== undefined) entry.context_limit = agent.context_limit
  if (isCalled(agent)) {
    entry.called_by = CALLED_BY_BMN
    entry.run_by = agent.run_by
  }
  return entry
}

export function teamLine(entry) {
  // An agent called by BMN says so where the others name their app, and has no effort or context to list.
  const called = entry.harness === CALLED_BY_BMN
  const parts = [entry.id, entry.name, entry.class, called ? CALLED_WORDS : entry.harness, entry.model, `provider=${entry.provider}`,
    ...(called ? [`run-by=${entry.run_by}`] : []),
    `private-work=${entry.private_work === 'allowed' ? 'allowed' : 'public-only'}`,
    `roles=${entry.roles.join(',') || '-'}`,
    ...(called ? [] : [`efforts=${entry.efforts.join(',') || '-'}`, `context-limit=${entry.context_limit ?? 'app default'}`])]
  if (entry.state !== 'active') parts.push(`[${entry.state}]`)
  return parts.join('  ')
}

export function team(data, all) {
  return data.agents.filter((agent) => all || agentState(agent) === 'active').map((agent) => teamEntry(data, agent))
}

/** The full chain for a role: ordered candidates with each one's eligibility and private-work answer, `then` and the typed rules. */
export function roleChain(data, roleId) {
  const role = data.roles.find((candidate) => candidate.id === roleId)
  if (role === undefined) throw new RosterError('ROLE_UNKNOWN', `no role ${roleId} in the roster's ## roles`)
  const byId = new Map(data.agents.map((agent) => [agent.id, agent]))
  const describe = (text) => {
    // The judge's candidates are named by their id alone: an agent called by BMN has no effort.
    const candidate = parseCandidate(text) ?? { agent: text, efforts: [], choice: false }
    const agent = byId.get(candidate.agent)
    const state = agent === undefined ? 'unknown' : agentState(agent)
    return {
      agent: candidate.agent, efforts: candidate.efforts, effort_choice: candidate.choice,
      eligible: state === 'active', state, private_work: agent === undefined ? 'public_only' : privateWorkOf(data, agent)
    }
  }
  const chain = { role: role.id, candidates: role.candidates.map(describe), then: role.then }
  if (role.recheck !== undefined) {
    const { same_reviewer: sameReviewer, ...efforts } = role.recheck
    chain.recheck = { same_reviewer: sameReviewer, efforts }
  }
  if (role.small_work !== undefined) chain.small_work = describe(role.small_work)
  // A role the check holds to read-only (63.2): a run for it must not be able to write.
  if (role.read_only === true) chain.read_only = true
  // Nobody dispatches to this role: its agent is asked through BMN's own command.
  if (role.id === JUDGE_ROLE) chain.called_by = CALLED_BY_BMN
  return chain
}

export function roleChainText(chain) {
  const lines = [`role ${chain.role}`]
  // A limit BMN applies to the run, or why it does not (60.9 AC2); nothing is said for the app's own default.
  const limit = (context) => context === undefined || context.state === 'app-default' ? ''
    : `  context-limit=${context.limit}${context.state === 'applied' ? '' : context.state === 'out-of-range' ? ' (cannot be applied)' : ' (not supported yet)'}`
  const about = (candidate) => `${candidate.eligible ? 'eligible' : `not eligible: ${candidate.state}`}  private-work=${candidate.private_work === 'allowed' ? 'allowed' : 'public-only'}${limit(candidate.context)}`
  chain.candidates.forEach((candidate, index) => {
    const effort = candidate.effort_choice ? `${candidate.efforts.join('|')} (lead chooses)` : candidate.efforts[0]
    lines.push(`  ${index + 1}. ${candidate.agent}${effort === undefined ? '' : `@${effort}`}  ${about(candidate)}`)
  })
  lines.push(`  then: ${chain.then}`)
  if (chain.recheck) {
    const overrides = Object.entries(chain.recheck.efforts).map(([agent, effort]) => `${agent} at ${effort}`)
    lines.push(`  recheck: ${chain.recheck.same_reviewer ? 'same reviewer' : 'any candidate'}${overrides.length ? `, ${overrides.join(', ')}` : ''}`)
  }
  if (chain.small_work) lines.push(`  small work: ${chain.small_work.agent}@${chain.small_work.efforts[0]}  ${about(chain.small_work)}`)
  if (chain.called_by === CALLED_BY_BMN) lines.push(`  ${CALLED_WORDS}: no dispatch goes to this role; ask it with \`bmn judge ask\``)
  if (chain.read_only === true) {
    lines.push('  read-only: a run for this role is refused unless it is started so that it cannot write')
    const forms = new Map(chain.candidates.filter((candidate) => candidate.read_only !== undefined).map((candidate) => [candidate.read_only.argv.join(' '), candidate.read_only.argv]))
    for (const argv of forms.values()) lines.push(`    ${argv[0] === '--sandbox' ? 'codex exec' : argv[0] === '--agent' ? 'opencode run' : 'claude -p'} must carry: ${argv.map((item) => (/^[A-Za-z0-9_=,.:/-]+$/.test(item) ? item : `'${item}'`)).join(' ')}`)
  }
  // An OpenCode candidate runs only in the one form the check reads (70.2), whatever the role.
  const openCode = chain.candidates.find((candidate) => candidate.opencode !== undefined)?.opencode
  if (openCode !== undefined) lines.push(`  opencode: env -i ${openCode.env.join(' ')} PATH=<your PATH> opencode ${[...openCode.argv, ...openCode.then].join(' ')} < <prompt file>`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Writing machine data back as YAML (revert and panel saves, 60.2 and 60.5)

function yamlScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  // A leading @ would read as a YAML tag, which this file's reader refuses: such a text is quoted.
  const plain = /^[A-Za-z0-9_./+-][A-Za-z0-9_ ./@|+-]*$/.test(text) && !/\s$/.test(text)
    && !['null', 'true', 'false', '~'].includes(text) && !/^-?\d+(\.\d+)?$/.test(text) && !/ #|: /.test(text)
  return plain ? text : JSON.stringify(text)
}

function yamlFlow(value) {
  if (Array.isArray(value)) return `[${value.map(yamlFlow).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${yamlScalar(key)}: ${yamlFlow(item)}`).join(', ')}}`
  }
  return yamlScalar(value)
}

/**
 * `## skills`: `source` (the folder the skills live in, when it is not the default), `public`
 * (the skills an app on a public-only route may have) and `only` (a skill kept to some apps).
 * The data holds one entry per skill that has either mark, in name order, and nothing at all when
 * the section says nothing, so a team file without the section keeps the hash it always had.
 */
function validateSkills(entry, add, warn) {
  if (!entry) return {}
  const where = entry.block.startLine
  for (const key of Object.keys(entry.value)) {
    if (!['source', 'public', 'only'].includes(key)) add('UNKNOWN_FIELD', entry.lines.get(key), `unknown field ${key} in ## skills`)
  }
  const out = {}
  const { source, public: open = [], only = {} } = entry.value
  if (source !== undefined) {
    const parts = typeof source === 'string' ? source.split('/') : []
    if (!isString(source, 4096) || !source.startsWith('/') || parts.includes('..') || parts.includes('.')) {
      add('INVALID_VALUE', entry.lines.get('source') ?? where, '## skills: source must be an absolute path without . or .. (nothing is expanded, not even ~)')
    } else {
      out.skills_source = source.length > 1 ? source.replace(/\/+$/, '') : source
    }
  }
  const marks = new Map()
  const mark = (id) => {
    if (!marks.has(id)) marks.set(id, { id })
    return marks.get(id)
  }
  if (!Array.isArray(open) || open.some((name) => typeof name !== 'string' || !SKILL_PATTERN.test(name))) {
    add('INVALID_VALUE', entry.lines.get('public') ?? where, '## skills: public must be a list of skill names (lowercase letters, digits and hyphens)')
  } else if (new Set(open).size !== open.length) {
    add('DUPLICATE_ID', entry.lines.get('public') ?? where, '## skills: public names a skill twice')
  } else {
    for (const name of open) mark(name).public = true
  }
  if (!isMap(only)) {
    add('INVALID_VALUE', entry.lines.get('only') ?? where, '## skills: only must be a map of skill name to a list of apps')
  } else {
    for (const [name, apps] of Object.entries(only)) {
      const line = entry.lines.get('only') ?? where
      if (!SKILL_PATTERN.test(name)) {
        add('INVALID_VALUE', line, `## skills.only: ${name} is not a skill name (lowercase letters, digits and hyphens)`)
      } else if (!Array.isArray(apps) || apps.length === 0 || apps.some((app) => !LISTED_APPS.includes(app))) {
        add('INVALID_VALUE', line, `## skills.only.${name} must be a list of one or more of ${HARNESSES.join(', ')}`)
      } else if (new Set(apps).size !== apps.length) {
        add('DUPLICATE_ID', line, `## skills.only.${name} names an app twice`)
      } else {
        // A retired app stays in the list as written and reaches nothing: no app BMN serves is added in its place.
        for (const app of apps.filter(isRetired)) warn('APP_RETIRED', line, `## skills.only.${name}: ${retiredWords(app)}`)
        mark(name).only = LISTED_APPS.filter((app) => apps.includes(app))
      }
    }
  }
  if (marks.size > MAX_SKILLS) add('INVALID_VALUE', where, `## skills marks ${marks.size} skills; at most ${MAX_SKILLS}`)
  if (marks.size > 0) out.skills = [...marks.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  return out
}

/** Text of one line: no control character, so nothing in it can end a line of a settings file or hide in a preview. */
const plainText = (value, max) => isString(value, max) && [...value].every((char) => char.codePointAt(0) >= 0x20 && char.codePointAt(0) !== 0x7f)

/** Whether a tool's address is one BMN writes into an app: https, or plain http to this machine only, with no sign-in in it. */
function toolUrlProblem(value) {
  if (!plainText(value, 400)) return 'url must be an address of at most 400 characters'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'url is not an address'
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'url must start with https:// (http:// only for this machine)'
  if (url.username !== '' || url.password !== '') return 'url must not hold a name or a password; name an environment variable under headers'
  return null
}

/**
 * `## tools`: one entry per MCP tool, keyed by its id. A tool is a program BMN names (`command`,
 * `args`) or an address (`url`); what it needs that is secret is named, never held: `env` maps an
 * entry the program receives to the name of an environment variable, `headers` does the same for
 * a request header, and an argument may be `{env: NAME}`. `public` is true when an app that gets
 * public work only may have the tool. A tool reaches every app unless `apps` keeps it to some, or
 * `agents` keeps it to the runs of some agents, in which case it is installed in no app. The data
 * holds nothing at all when the section says nothing, so a team file without it keeps its hash.
 */
function validateTools(entry, agentIds, add, warn) {
  if (!entry) return {}
  const tools = []
  for (const [id, tool] of Object.entries(entry.value)) {
    const line = entry.lines.get(id) ?? entry.block.startLine
    if (!TOOL_PATTERN.test(id)) {
      add('INVALID_VALUE', line, `## tools: tool id ${id} must be lowercase letters, digits, - or _, at most 40`)
      continue
    }
    if (!isMap(tool)) {
      add('INVALID_VALUE', line, `## tools.${id} must be a map of name and command or url`)
      continue
    }
    let ok = true
    const fail = (code, key, message) => {
      add(code, entry.lines.get(`${id}.${key}`) ?? line, `## tools.${id}: ${message}`)
      ok = false
    }
    for (const key of Object.keys(tool)) {
      if (!TOOL_FIELDS.includes(key)) fail('UNKNOWN_FIELD', key, `unknown field ${key}`)
    }
    if (!plainText(tool.name, 40)) fail('INVALID_VALUE', 'name', 'name must be text of 1-40 characters')
    const local = Object.hasOwn(tool, 'command')
    const remote = Object.hasOwn(tool, 'url')
    if (local === remote) fail('INVALID_VALUE', local ? 'url' : 'name', 'a tool has a command or a url, one of them')
    if (local && !plainText(tool.command, 400)) fail('INVALID_VALUE', 'command', 'command must be a program name or path of at most 400 characters')
    if (remote) {
      const problem = toolUrlProblem(tool.url)
      if (problem !== null) fail('INVALID_VALUE', 'url', problem)
    }
    const out = { id, name: tool.name, ...(local ? { command: tool.command } : {}), ...(remote ? { url: tool.url } : {}) }
    if (Object.hasOwn(tool, 'args')) {
      const fine = (arg) => plainText(arg, 400) || arg === '' || (isMap(arg) && Object.keys(arg).length === 1 && typeof arg.env === 'string' && ENV_NAME_PATTERN.test(arg.env))
      if (!local) fail('INVALID_VALUE', 'args', 'args belong to a command, not to a url')
      else if (!Array.isArray(tool.args) || tool.args.length > 40 || !tool.args.every(fine)) fail('INVALID_VALUE', 'args', 'args must be a list of at most 40 texts, or {env: NAME} for a value kept in an environment variable')
      else if (tool.args.length > 0) out.args = tool.args
    }
    for (const [key, pattern, max, what] of [['env', ENV_NAME_PATTERN, 32, 'an entry the program receives'], ['headers', HEADER_NAME_PATTERN, 16, 'a request header']]) {
      if (!Object.hasOwn(tool, key)) continue
      const map = tool[key]
      if (key === 'headers' && !remote) fail('INVALID_VALUE', key, 'headers belong to a url, not to a command')
      else if (key === 'env' && !local) fail('INVALID_VALUE', key, 'env belongs to a command, not to a url')
      else if (!isMap(map) || Object.keys(map).length > max || !Object.entries(map).every(([name, variable]) => pattern.test(name) && typeof variable === 'string' && ENV_NAME_PATTERN.test(variable))) {
        fail('INVALID_VALUE', key, `${key} must map ${what} to the name of an environment variable (never its value), at most ${max}`)
      } else if (Object.keys(map).length > 0) out[key] = Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    if (Object.hasOwn(tool, 'public')) {
      if (typeof tool.public !== 'boolean') fail('INVALID_VALUE', 'public', 'public must be true or false')
      else if (tool.public) out.public = true
    }
    if (Object.hasOwn(tool, 'apps') && Object.hasOwn(tool, 'agents')) fail('INVALID_VALUE', 'agents', 'a tool is kept to some apps or to some agents, not both')
    else if (Object.hasOwn(tool, 'apps')) {
      if (!Array.isArray(tool.apps) || tool.apps.length === 0 || tool.apps.some((app) => !LISTED_APPS.includes(app))) fail('INVALID_VALUE', 'apps', `apps must be a list of one or more of ${HARNESSES.join(', ')}`)
      else if (new Set(tool.apps).size !== tool.apps.length) fail('DUPLICATE_ID', 'apps', 'apps names an app twice')
      else {
        for (const app of tool.apps.filter(isRetired)) warn('APP_RETIRED', entry.lines.get(`${id}.apps`) ?? line, `## tools.${id}.apps: ${retiredWords(app)}`)
        out.apps = LISTED_APPS.filter((app) => tool.apps.includes(app))
      }
    } else if (Object.hasOwn(tool, 'agents')) {
      if (!Array.isArray(tool.agents) || tool.agents.length === 0 || tool.agents.some((agent) => typeof agent !== 'string' || !ID_PATTERN.test(agent))) fail('INVALID_VALUE', 'agents', 'agents must be a list of one or more agent ids')
      else if (new Set(tool.agents).size !== tool.agents.length) fail('DUPLICATE_ID', 'agents', 'agents names an agent twice')
      else if (tool.agents.some((agent) => !agentIds.has(agent))) fail('AGENT_UNKNOWN', 'agents', `no agent ${tool.agents.find((agent) => !agentIds.has(agent))} in this file`)
      else out.agents = [...tool.agents].sort()
    }
    if (ok) tools.push(out)
  }
  if (tools.length > MAX_TOOLS) add('INVALID_VALUE', entry.block.startLine, `## tools holds ${tools.length} tools; at most ${MAX_TOOLS}`)
  return tools.length > 0 ? { tools: tools.sort((a, b) => (a.id < b.id ? -1 : 1)) } : {}
}

/** The tools as the section holds them, or '' when there are none. */
export function toolsYaml(data) {
  return keyedYaml((data.tools ?? []).map((tool) => Object.fromEntries(['id', ...TOOL_FIELDS].filter((key) => Object.hasOwn(tool, key)).map((key) => [key, tool[key]]))), 'id')
}

/** The tools part of machine data read back from a block's parsed value, the way `validateTools` builds it. */
function toolsFromBlock(value, agentIds) {
  if (!isMap(value)) return undefined
  const issues = []
  const out = validateTools({ value, lines: new Map(), block: { startLine: 0 } }, agentIds, (code) => issues.push(code))
  return issues.length > 0 ? undefined : out.tools ?? []
}

/** The skills marks as the section holds them, or '' when there is nothing to say. */
export function skillsYaml(data) {
  const marks = data.skills ?? []
  const open = marks.filter((entry) => entry.public === true).map((entry) => entry.id)
  const only = Object.fromEntries(marks.filter((entry) => entry.only !== undefined).map((entry) => [entry.id, entry.only]))
  return [
    ...(data.skills_source === undefined ? [] : [`source: ${yamlFlow(data.skills_source)}`]),
    ...(open.length === 0 ? [] : [`public: ${yamlFlow(open)}`]),
    ...(Object.keys(only).length === 0 ? [] : [`only: ${yamlFlow(only)}`])
  ].join('\n')
}

/** The skills part of machine data read back from a block's parsed value, the way `validateSkills` builds it. */
function skillsFromBlock(value) {
  if (!isMap(value)) return undefined
  const issues = []
  const out = validateSkills({ value, lines: new Map(), block: { startLine: 0 } }, (code) => issues.push(code))
  return issues.length > 0 ? undefined : { skills: out.skills ?? [], source: out.skills_source ?? null }
}

export function agentYaml(agent) {
  // An agent called by BMN has no efforts line in the file; the empty list is this module's own.
  return AGENT_FIELDS.filter((key) => Object.hasOwn(agent, key) && !(key === 'efforts' && isCalled(agent))).map((key) => `${key}: ${yamlFlow(agent[key])}`).join('\n')
}

/** A block of `id: {…}` lines for a list of entries that each carry their key in `keyField`. */
function keyedYaml(entries, keyField) {
  return entries.map((entry) => {
    const { [keyField]: key, ...rest } = entry
    return `${key}: ${yamlFlow(rest)}`
  }).join('\n')
}

export function rolesYaml(roles) {
  return keyedYaml(roles, 'id')
}

export function providersYaml(providers) {
  return keyedYaml(providers, 'id')
}

export function exceptionsYaml(exceptions) {
  return keyedYaml(exceptions, 'id')
}

export function routesYaml(routes) {
  return keyedYaml(routes, 'harness')
}

export function projectChoicesYaml(choices) {
  return keyedYaml(choices.map((choice) => Object.fromEntries(['id', ...PROJECT_CHOICE_FIELDS].filter((key) => Object.hasOwn(choice, key)).map((key) => [key, choice[key]]))), 'id')
}

export function headerYaml(version = SCHEMA_VERSION) {
  return `schema_version: ${version}`
}

/** The four roles a new team starts with; every one is the owner's to rename, change or remove. */
export const STARTER_ROLES = [
  { id: 'lead', description: 'leads an epic/project start to finish', candidates: [], then: 'owner-chooses' },
  { id: 'designer', description: 'designs and thinks creatively', candidates: [], then: 'lead' },
  { id: 'helper', description: 'does small jobs a lead hands off', candidates: [], then: 'lead' },
  { id: 'reviewer', description: 'judges finished work', candidates: [], then: 'blocked' },
  { id: 'advisor', description: "answers a lead's hard questions", candidates: [], then: 'blocked' }
]

/** The roster a new install starts from: no agents, five editable roles. */
export function starterRoster() {
  return [
    '# Team',
    '',
    'Your agents, the providers they run on and who does which job. BMN reads only the `yaml`',
    'blocks; any text outside them is your own notes. Nothing here takes effect until you approve',
    'it in BMN (Preferences, Team).',
    '',
    '## roster',
    '',
    '```yaml',
    headerYaml(),
    '```',
    '',
    '## roles',
    '',
    '```yaml',
    rolesYaml(STARTER_ROLES),
    '```',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Rewriting a roster file to hold given machine data (revert and panel saves)

function blockValue(section) {
  if (section.blocks.length === 0) return undefined
  try {
    return parseYaml(section.blocks[0].source, section.blocks[0].contentLine).value
  } catch {
    return undefined
  }
}

function agentFromBlock(id, value) {
  if (!isMap(value)) return undefined
  const agent = { id }
  for (const key of Object.keys(value)) agent[key] = value[key]
  if (isCalled(agent) && !Object.hasOwn(agent, 'efforts')) agent.efforts = []
  return agent
}

/** A keyed block read back the way `keyedYaml` wrote it. */
function keyedFromBlock(value, keyField) {
  if (!isMap(value)) return undefined
  return Object.entries(value).map(([key, entry]) => ({ [keyField]: key, ...(isMap(entry) ? entry : { invalid: entry }) }))
}

function same(a, b) {
  return a !== undefined && canonicalJson(a) === canonicalJson(b)
}

/** The shared sections: heading, the data they hold and how that data is written. */
const SHARED = [
  { id: 'roles', key: 'id', field: 'roles', yaml: rolesYaml },
  { id: 'providers', key: 'id', field: 'providers', yaml: providersYaml },
  { id: 'exceptions', key: 'id', field: 'exceptions', yaml: exceptionsYaml },
  { id: 'harness-routes', key: 'harness', field: 'harness_routes', yaml: routesYaml },
  // An optional key, like the tools: a team without choices holds none.
  { id: 'project-choices', key: 'id', field: 'project_choices', yaml: projectChoicesYaml }
]
export const SHARED_SECTIONS = [...SHARED.map((entry) => entry.id), 'skills', 'tools']

/**
 * The roster text rewritten so its machine data equals `data`, changing only what must change:
 * a yaml block whose fields already match keeps its bytes (comments included); a differing block
 * is replaced between its fences; an agent or a non-empty shared section missing from the file
 * gets a new section at the end; an agent the file has and `data` lacks loses its whole section.
 * Prose outside rewritten blocks is never touched. `scope`, when given, limits the rewrite to
 * those section ids.
 */
export function rewriteRoster(text, data, { scope = null } = {}) {
  const sections = splitSections(text)
  const edits = []
  const inScope = (id) => scope === null || scope.includes(id)
  const targets = new Map(data.agents.map((agent) => [agent.id, agent]))
  const seen = new Set()
  sections.forEach((section, index) => {
    const id = section.heading
    if (!ID_PATTERN.test(id) || !inScope(id)) return
    const sectionEnd = index + 1 < sections.length ? sections[index + 1].start : text.length
    if (seen.has(id)) {
      if (!RESERVED_SECTIONS.includes(id) && !targets.has(id)) return
      edits.push({ start: section.start, end: sectionEnd, text: '' })
      return
    }
    seen.add(id)
    const shared = SHARED.find((entry) => entry.id === id)
    let wanted
    let current
    if (id === 'roster') {
      // The layout the data is in: a schema 2 team stays schema 2 until it holds what only schema 3 can say.
      wanted = headerYaml(data.schema_version ?? SCHEMA_VERSION)
      current = same(blockValue(section), { schema_version: data.schema_version ?? SCHEMA_VERSION }) ? wanted : undefined
    } else if (id === 'skills') {
      // An emptied section keeps its heading and says so, rather than leaving a block nothing parses.
      wanted = skillsYaml(data) || 'public: []'
      current = same(skillsFromBlock(blockValue(section)), { skills: data.skills ?? [], source: data.skills_source ?? null }) ? wanted : undefined
    } else if (id === 'tools') {
      // An emptied section keeps its heading and says so; a block with no entries reads as no tools.
      wanted = toolsYaml(data) || '# no tools'
      current = same(toolsFromBlock(blockValue(section), new Set(data.agents.map((agent) => agent.id))), data.tools ?? []) ? wanted : undefined
    } else if (shared !== undefined) {
      wanted = shared.yaml(data[shared.field] ?? [])
      current = same(keyedFromBlock(blockValue(section), shared.key), data[shared.field] ?? []) ? wanted : undefined
    } else if (!targets.has(id)) {
      edits.push({ start: section.start, end: sectionEnd, text: '' })
      return
    } else {
      wanted = agentYaml(targets.get(id))
      current = same(agentFromBlock(id, blockValue(section)), targets.get(id)) && section.blocks.length === 1 ? wanted : undefined
    }
    if (current !== undefined && section.blocks.length === 1) return
    if (section.blocks.length === 0) {
      const headingEnd = text.indexOf('\n', section.start)
      const at = headingEnd === -1 ? text.length : headingEnd + 1
      edits.push({ start: at, end: at, text: `\n\`\`\`yaml\n${wanted}\n\`\`\`\n` })
      return
    }
    const [first, ...extra] = section.blocks
    edits.push({ start: first.contentStart, end: first.contentEnd, text: `${wanted}\n` })
    for (const block of extra) edits.push({ start: block.start, end: block.end, text: '' })
  })
  let appended = ''
  const ensure = (id, body) => {
    if (seen.has(id) || !inScope(id)) return
    appended += `\n## ${id}\n\n\`\`\`yaml\n${body}\n\`\`\`\n`
  }
  ensure('roster', headerYaml(data.schema_version ?? SCHEMA_VERSION))
  if (data.providers.length > 0) ensure('providers', providersYaml(data.providers))
  for (const agent of data.agents) ensure(agent.id, agentYaml(agent))
  for (const shared of SHARED) {
    if (shared.id !== 'providers' && (data[shared.field] ?? []).length > 0) ensure(shared.id, shared.yaml(data[shared.field]))
  }
  if (skillsYaml(data) !== '') ensure('skills', skillsYaml(data))
  if (toolsYaml(data) !== '') ensure('tools', toolsYaml(data))
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  if (appended !== '') out = `${out}${out.endsWith('\n') || out === '' ? '' : '\n'}${appended}`
  return out
}

/**
 * The file's bytes outside the content of its yaml blocks, as the pieces between them. Revert
 * (60.2 AC6) may change only what lies between a block's fences, so these pieces must survive it.
 */
export function outsideYamlBlocks(text) {
  const pieces = []
  let from = 0
  for (const block of splitSections(text).flatMap((section) => section.blocks).sort((a, b) => a.contentStart - b.contentStart)) {
    pieces.push(text.slice(from, block.contentStart))
    from = block.contentEnd
  }
  pieces.push(text.slice(from))
  return pieces
}

/** The prose of an agent's section: everything after its yaml block, up to the next section. */
export function proseOf(text, id) {
  const sections = splitSections(text)
  const index = sections.findIndex((section) => section.heading === id)
  if (index === -1 || sections[index].blocks.length === 0) return null
  const end = index + 1 < sections.length ? sections[index + 1].start : text.length
  return text.slice(sections[index].blocks[sections[index].blocks.length - 1].end, end).trim()
}

/**
 * The roster with one agent's prose replaced. Prose is never parsed and takes effect at once; the
 * yaml block and every other section keep their bytes. Fences and `## ` headings inside the new
 * prose are refused, since they would change what the file's sections are.
 */
export function rewriteProse(text, id, prose) {
  if (/^ {0,3}(```|~~~)/m.test(prose) || /^##(?!#)/m.test(prose)) {
    throw new RosterError('ROSTER_INVALID', 'notes cannot hold code fences or ## headings')
  }
  const sections = splitSections(text)
  const index = sections.findIndex((section) => section.heading === id)
  if (index === -1 || sections[index].blocks.length === 0) throw new RosterError('ROSTER_INVALID', `no agent section ${id} with a yaml block`)
  const start = sections[index].blocks[sections[index].blocks.length - 1].end
  const end = index + 1 < sections.length ? sections[index + 1].start : text.length
  const body = prose.trim()
  const tail = index + 1 < sections.length ? '\n' : ''
  return `${text.slice(0, start)}${body === '' ? tail : `\n${body}\n${tail}`}${text.slice(end)}`
}
