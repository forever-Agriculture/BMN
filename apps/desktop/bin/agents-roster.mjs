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

export const SCHEMA_VERSION = 2
export const HARNESSES = ['claude', 'codex', 'opencode', 'cursor']
/** How BMN names each agent app to the owner, in the order they are always listed. */
export const APP_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' }
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** The four chess classes: a knight leads an epic/project, a queen designs and thinks creatively, a bishop reviews and advises, a pawn does jobs a lead hands off. */
export const CLASSES = ['knight', 'queen', 'bishop', 'pawn']
export const STATUSES = ['active', 'proposed']
export const THEN = ['lead', 'skip', 'blocked', 'owner-chooses']
export const PRIVATE_WORK = ['allowed', 'public_only']
export const PAID_BY = ['per_token', 'subscription']
export const BASES = ['observed-default', 'owner-declared']
/** Sections that are not agents. `skills` and `tools` are held for the stories that define them. */
export const RESERVED_SECTIONS = ['roster', 'roles', 'providers', 'exceptions', 'harness-routes', 'skills', 'tools']
const UNREAD_SECTIONS = ['skills', 'tools']
export const MAX_EXCEPTIONS = 64
/** The one role only a knight may hold. */
export const LEAD_ROLE = 'lead'
/** The one role only a queen may hold: the design pass. */
export const DESIGNER_ROLE = 'designer'
/** Roles one class alone may hold, with the refusal another class gets. Every other role is open to every class. */
export const CLASS_ROLES = {
  [LEAD_ROLE]: { class: 'knight', code: 'CLASS_CANNOT_LEAD', rule: 'only a knight leads' },
  [DESIGNER_ROLE]: { class: 'queen', code: 'CLASS_CANNOT_DESIGN', rule: 'only a queen designs' }
}

/** Why an agent of this class may not hold a role, or null when it may. */
export function classRefusal(agentClass, role) {
  const rule = Object.hasOwn(CLASS_ROLES, role) ? CLASS_ROLES[role] : undefined
  return rule === undefined || rule.class === agentClass ? null : rule
}
export const ID_PATTERN = /^[a-z0-9-]{1,32}$/
const CANDIDATE_PATTERN = /^([a-z0-9-]{1,32})@([a-z]+(?:\|[a-z]+)*)$/
const HOST_PATTERN = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

/** Machine fields that are the owner's free text: status shows them only as changed plus a hash. */
export const FREE_TEXT_FIELDS = ['enabled_note', 'description']

const REQUIRED_AGENT_FIELDS = ['name', 'class', 'harness', 'model', 'provider', 'host', 'enabled', 'status', 'efforts', 'roles']
const OPTIONAL_AGENT_FIELDS = ['aliases', 'enabled_note', 'context_window', 'context_limit', 'compact_at', 'paid_by', 'price']
export const AGENT_FIELDS = [...REQUIRED_AGENT_FIELDS, ...OPTIONAL_AGENT_FIELDS]
const PRICE_FIELDS = ['input', 'cached_input', 'output', 'source', 'as_of']
const PROVIDER_FIELDS = ['name', 'hosts', 'sites', 'private_work']
const ROLE_FIELDS = ['description', 'candidates', 'then', 'recheck', 'small_work']
const ROUTE_FIELDS = ['provider', 'basis', 'accepted_versions']
/** What schema 1 called things, for the refusal that tells its owner what changed. */
const SCHEMA_1_CHANGES = 'schema 1 is the earlier layout: title became class (knight | queen | bishop | pawn); trust, authority, security, cost, quota, tags and ## data-labels are gone; small_epic became small_work and max_context_tokens became context_limit; privacy is now ## providers with private_work: allowed | public_only'

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
export function parseRoster(text) {
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
    if (UNREAD_SECTIONS.includes(id)) {
      add('SECTION_INVALID', section.line, `"## ${id}" is reserved and not read by this version of BMN`)
      continue
    }
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
    if (header.value.schema_version !== SCHEMA_VERSION) {
      const found = header.value.schema_version
      add('SCHEMA_VERSION', header.lines.get('schema_version') ?? header.block.startLine,
        `schema_version must be ${SCHEMA_VERSION}${found === undefined ? '' : `, not ${found}`}${found === 1 ? `; ${SCHEMA_1_CHANGES}` : ''}`)
      return { data: null, errors, warnings, sections }
    }
  }

  const providers = validateProviders(blocks.get('providers'), add)
  const providerIds = new Set(blocks.get('providers') ? Object.keys(blocks.get('providers').value) : [])
  const agents = []
  for (const [id, entry] of blocks) {
    if (RESERVED_SECTIONS.includes(id)) continue
    agents.push(validateAgent(id, entry, providerIds, add))
  }
  const agentById = new Map(agents.filter(Boolean).map((agent) => [agent.id, agent]))
  const agentIds = new Set([...seen.keys()].filter((id) => !RESERVED_SECTIONS.includes(id)))

  const routes = validateRoutes(blocks.get('harness-routes'), providerIds, add)
  const roles = validateRoles(blocks.get('roles'), agentById, agentIds, add, warnings)
  const exceptions = validateExceptions(blocks.get('exceptions'), providerIds, add)

  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const roleIds = new Set(roles.map((role) => role.id))
  for (const agent of agentById.values()) {
    const entry = blocks.get(agent.id)
    const route = routes.find((candidate) => candidate.harness === agent.harness)
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

  if (errors.length > 0) return { data: null, errors: errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), warnings, sections }
  return {
    data: { schema_version: SCHEMA_VERSION, agents: agents.filter(Boolean), roles, providers, exceptions, harness_routes: routes },
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

function validateAgent(id, entry, providerIds, add) {
  const { value, lines, block } = entry
  const at = (key) => lines.get(key) ?? block.startLine
  const bad = (key, message) => add('INVALID_VALUE', at(key), `${id}.${key}: ${message}`)
  checkFields(entry, AGENT_FIELDS, `agent ${id}`, add)
  let valid = Object.keys(value).every((key) => AGENT_FIELDS.includes(key))
  for (const key of REQUIRED_AGENT_FIELDS) {
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
  check('harness', enumOf(HARNESSES), HARNESSES.join(' | '))
  check('model', (v) => isString(v, 128), 'text of 1-128 characters')
  check('provider', (v) => typeof v === 'string' && ID_PATTERN.test(v), 'a provider id from ## providers')
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

function validateRoutes(entry, providerIds, add) {
  if (!entry) return []
  const routes = []
  for (const [harness, route] of Object.entries(entry.value)) {
    const line = entry.lines.get(harness)
    if (!HARNESSES.includes(harness)) {
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

function validateRoles(entry, agentById, agentIds, add, warnings) {
  if (!entry) return []
  const roles = []
  for (const [id, role] of Object.entries(entry.value)) {
    const line = entry.lines.get(id)
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
    if (ok) {
      const out = { id }
      for (const key of ROLE_FIELDS) if (Object.hasOwn(role, key)) out[key] = role[key]
      roles.push(out)
    }
  }
  return roles
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
function validateExceptions(entry, providerIds, add) {
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
    const key = `${exception.provider}\n${resolvedDirectory(path)}`
    if (resolved.has(key)) {
      add('EXCEPTION_COLLISION', line, `## exceptions.${id} names the same folder as ${resolved.get(key)} for provider ${exception.provider}`)
      continue
    }
    resolved.set(key, id)
    exceptions.push({ id, provider: exception.provider, folder: path })
  }
  return exceptions
}

// ---------------------------------------------------------------------------------------------
// Queries over validated (or approved) machine data

export function agentState(agent) {
  if (agent.status === 'proposed') return 'proposed'
  if (!agent.enabled) return 'disabled'
  return 'active'
}

/** The provider's answer for an agent: whether its provider may see private work at all. */
export function privateWorkOf(data, agent) {
  return data.providers.find((provider) => provider.id === agent.provider)?.private_work ?? 'public_only'
}

/**
 * Whether an app's approved default destination may receive private work, with the reason in
 * words: only an inspected default whose provider answers `allowed`. Missing, owner-declared and
 * public-only destinations get public work only (60.3 AC4, 60.4 AC1).
 */
export function harnessPrivateWork(data, harness) {
  const app = APP_NAMES[harness] ?? harness
  const route = data?.harness_routes.find((entry) => entry.harness === harness)
  if (route === undefined) return { allowed: false, reason: data ? `BMN has no approved destination for ${app}` : 'nothing is approved yet', route: null, provider: null }
  const provider = data.providers.find((entry) => entry.id === route.provider) ?? null
  if (route.basis === 'owner-declared') return { allowed: false, reason: `BMN can't confirm where ${app} sends data`, route, provider }
  if (provider?.private_work !== 'allowed') return { allowed: false, reason: `${provider?.name ?? route.provider} gets public work only`, route, provider }
  return { allowed: true, reason: `${provider.name} may see private work`, route, provider }
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
  return entry
}

export function teamLine(entry) {
  const parts = [entry.id, entry.name, entry.class, entry.harness, entry.model, `provider=${entry.provider}`,
    `private-work=${entry.private_work === 'allowed' ? 'allowed' : 'public-only'}`,
    `roles=${entry.roles.join(',') || '-'}`, `efforts=${entry.efforts.join(',') || '-'}`,
    `context-limit=${entry.context_limit ?? 'app default'}`]
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
    const candidate = parseCandidate(text)
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
  return chain
}

export function roleChainText(chain) {
  const lines = [`role ${chain.role}`]
  const about = (candidate) => `${candidate.eligible ? 'eligible' : `not eligible: ${candidate.state}`}  private-work=${candidate.private_work === 'allowed' ? 'allowed' : 'public-only'}`
  chain.candidates.forEach((candidate, index) => {
    const effort = candidate.effort_choice ? `${candidate.efforts.join('|')} (lead chooses)` : candidate.efforts[0]
    lines.push(`  ${index + 1}. ${candidate.agent}@${effort}  ${about(candidate)}`)
  })
  lines.push(`  then: ${chain.then}`)
  if (chain.recheck) {
    const overrides = Object.entries(chain.recheck.efforts).map(([agent, effort]) => `${agent} at ${effort}`)
    lines.push(`  recheck: ${chain.recheck.same_reviewer ? 'same reviewer' : 'any candidate'}${overrides.length ? `, ${overrides.join(', ')}` : ''}`)
  }
  if (chain.small_work) lines.push(`  small work: ${chain.small_work.agent}@${chain.small_work.efforts[0]}  ${about(chain.small_work)}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Writing machine data back as YAML (revert and panel saves, 60.2 and 60.5)

function yamlScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  const plain = /^[A-Za-z0-9_./@+-][A-Za-z0-9_ ./@|+-]*$/.test(text) && !/\s$/.test(text)
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

export function agentYaml(agent) {
  return AGENT_FIELDS.filter((key) => Object.hasOwn(agent, key)).map((key) => `${key}: ${yamlFlow(agent[key])}`).join('\n')
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

export function headerYaml() {
  return `schema_version: ${SCHEMA_VERSION}`
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
  { id: 'harness-routes', key: 'harness', field: 'harness_routes', yaml: routesYaml }
]
export const SHARED_SECTIONS = SHARED.map((entry) => entry.id)

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
    if (!ID_PATTERN.test(id) || !inScope(id) || UNREAD_SECTIONS.includes(id)) return
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
      wanted = headerYaml()
      current = same(blockValue(section), { schema_version: SCHEMA_VERSION }) ? wanted : undefined
    } else if (shared !== undefined) {
      wanted = shared.yaml(data[shared.field])
      current = same(keyedFromBlock(blockValue(section), shared.key), data[shared.field]) ? wanted : undefined
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
  ensure('roster', headerYaml())
  if (data.providers.length > 0) ensure('providers', providersYaml(data.providers))
  for (const agent of data.agents) ensure(agent.id, agentYaml(agent))
  for (const shared of SHARED) {
    if (shared.id !== 'providers' && data[shared.field].length > 0) ensure(shared.id, shared.yaml(data[shared.field]))
  }
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
