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

export const SCHEMA_VERSION = 1
export const HARNESSES = ['claude', 'codex', 'opencode', 'cursor']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const TITLES = ['knight', 'squire']
export const SECURITY = ['high', 'low']
export const AUTHORITIES = ['lead', 'write', 'review', 'read']
export const STATUSES = ['active', 'proposed']
export const COSTS = ['low', 'medium', 'high']
export const THEN = ['lead', 'skip', 'blocked', 'owner-chooses']
export const LABELS = ['public', 'private']
export const BASES = ['observed-default', 'owner-declared']
export const RESERVED_SECTIONS = ['roster', 'roles', 'data-labels', 'harness-routes']
export const ID_PATTERN = /^[a-z0-9-]{1,32}$/
const CANDIDATE_PATTERN = /^([a-z0-9-]{1,32})@([a-z]+(?:\|[a-z]+)*)$/
const HOST_PATTERN = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i

/** Machine fields that are the owner's free text: status shows them only as changed plus a hash. */
export const FREE_TEXT_FIELDS = ['enabled_note', 'quota', 'tags']

const REQUIRED_AGENT_FIELDS = ['name', 'title', 'harness', 'model', 'provider', 'host', 'security', 'trust',
  'authority', 'enabled', 'status', 'efforts', 'roles']
const OPTIONAL_AGENT_FIELDS = ['aliases', 'enabled_note', 'cost', 'quota', 'tags', 'context_window', 'max_context_tokens']
export const AGENT_FIELDS = [...REQUIRED_AGENT_FIELDS, ...OPTIONAL_AGENT_FIELDS]

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
    if (!seen.has('roster')) add('SCHEMA_VERSION', 1, 'missing "## roster" section with schema_version: 1')
  } else {
    for (const key of Object.keys(header.value)) {
      if (key !== 'schema_version') add('UNKNOWN_FIELD', header.lines.get(key), `unknown field ${key} in ## roster`)
    }
    if (header.value.schema_version !== SCHEMA_VERSION) {
      add('SCHEMA_VERSION', header.lines.get('schema_version') ?? header.block.startLine,
        `schema_version must be ${SCHEMA_VERSION}${header.value.schema_version === undefined ? '' : `, not ${header.value.schema_version}`}`)
      return { data: null, errors, warnings, sections }
    }
  }

  const agents = []
  for (const [id, entry] of blocks) {
    if (RESERVED_SECTIONS.includes(id)) continue
    agents.push(validateAgent(id, entry, add))
  }
  const agentById = new Map(agents.filter(Boolean).map((agent) => [agent.id, agent]))
  const agentIds = new Set([...seen.keys()].filter((id) => !RESERVED_SECTIONS.includes(id)))

  const routes = validateRoutes(blocks.get('harness-routes'), add)
  const roles = validateRoles(blocks.get('roles'), agentById, agentIds, add, warnings)
  const labels = validateLabels(blocks.get('data-labels'), add)

  for (const agent of agentById.values()) {
    const entry = blocks.get(agent.id)
    const route = routes.find((candidate) => candidate.harness === agent.harness)
    if (agent.security === 'high' && agent.host === 'default' && route !== undefined
      && (route.security === 'low' || route.basis === 'owner-declared')) {
      add('ROUTE_CONFLICT', entry.lines.get('security'),
        `${agent.id} is high with host: default, but the ${agent.harness} route is ${route.security === 'low' ? 'low' : 'owner-declared'}`)
    }
    const roleIds = new Set(roles.map((role) => role.id))
    for (const role of agent.roles) {
      if (!roleIds.has(role)) warnings.push({ code: 'ROLE_WITHOUT_CHAIN', line: entry.lines.get('roles'), message: `${agent.id} holds role ${role}, which has no chain in ## roles` })
    }
  }

  if (errors.length > 0) return { data: null, errors: errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), warnings, sections }
  return {
    data: { schema_version: SCHEMA_VERSION, agents: agents.filter(Boolean), roles, data_labels: labels, harness_routes: routes },
    errors, warnings, sections
  }
}

function checkFields(entry, allowed, where, add) {
  for (const key of Object.keys(entry.value)) {
    if (!allowed.includes(key)) add('UNKNOWN_FIELD', entry.lines.get(key), `unknown field ${key} in ${where}`)
  }
}

function validateAgent(id, entry, add) {
  const { value, lines, block } = entry
  const at = (key) => lines.get(key) ?? block.startLine
  const bad = (key, message) => add('INVALID_VALUE', at(key), `${id}.${key}: ${message}`)
  checkFields(entry, AGENT_FIELDS, `agent ${id}`, add)
  let valid = true
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
    if (!Object.hasOwn(value, key) || value[key] === null && key !== 'host') return
    if (!ok(value[key])) {
      bad(key, message)
      valid = false
    }
  }
  const enumOf = (options) => (v) => options.includes(v)
  const list = (max, each) => (v) => Array.isArray(v) && v.length <= max && v.every(each) && new Set(v).size === v.length
  check('name', (v) => isString(v, 40), 'text of 1-40 characters')
  check('title', enumOf(TITLES), TITLES.join(' | '))
  check('harness', enumOf(HARNESSES), HARNESSES.join(' | '))
  check('model', (v) => isString(v, 128), 'text of 1-128 characters')
  check('provider', (v) => isString(v, 40), 'text of 1-40 characters')
  if (Object.hasOwn(value, 'host') && value.host !== null && !(value.host === 'default' || (typeof value.host === 'string' && HOST_PATTERN.test(value.host)))) {
    bad('host', 'a hostname (optionally :port), default, or null')
    valid = false
  }
  check('security', enumOf(SECURITY), SECURITY.join(' | '))
  check('trust', (v) => v === 1 || v === 2 || v === 3, '1 | 2 | 3')
  check('authority', enumOf(AUTHORITIES), AUTHORITIES.join(' | '))
  check('enabled', (v) => typeof v === 'boolean', 'true | false')
  check('status', enumOf(STATUSES), STATUSES.join(' | '))
  check('efforts', list(EFFORTS.length, (e) => EFFORTS.includes(e)), `a list of distinct efforts from ${EFFORTS.join(', ')}`)
  check('roles', list(32, (r) => typeof r === 'string' && ID_PATTERN.test(r)), 'a list of distinct role ids')
  check('aliases', list(4, (a) => isString(a, 64)), 'at most 4 distinct aliases of 1-64 characters')
  check('enabled_note', (v) => isString(v, 120), 'text of 1-120 characters')
  check('cost', enumOf(COSTS), COSTS.join(' | '))
  check('quota', (v) => isString(v, 40), 'text of 1-40 characters')
  check('tags', list(8, (t) => isString(t, 40)), 'at most 8 distinct tags of 1-40 characters')
  check('context_window', (v) => Number.isSafeInteger(v) && v > 0, 'a positive whole number')
  check('max_context_tokens', (v) => Number.isSafeInteger(v) && v > 0, 'a positive whole number')
  if (!valid) return null
  if (value.efforts.length === 0 && value.enabled) {
    bad('efforts', 'empty efforts are allowed only when enabled is false')
    return null
  }
  if (value.title === 'squire' && value.authority === 'lead') {
    add('SQUIRE_LEAD', at('authority'), `${id} is a squire with authority lead; a squire never leads`)
    return null
  }
  const agent = { id }
  for (const key of AGENT_FIELDS) if (Object.hasOwn(value, key)) agent[key] = value[key]
  return agent
}

function validateRoutes(entry, add) {
  if (!entry) return []
  const routes = []
  for (const [harness, route] of Object.entries(entry.value)) {
    const line = entry.lines.get(harness)
    if (!HARNESSES.includes(harness)) {
      add('UNKNOWN_FIELD', line, `## harness-routes: unknown harness ${harness}`)
      continue
    }
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      add('INVALID_VALUE', line, `## harness-routes.${harness} must be a map of provider, security, basis`)
      continue
    }
    let ok = true
    for (const key of Object.keys(route)) {
      if (!['provider', 'security', 'basis', 'accepted_versions'].includes(key)) {
        add('UNKNOWN_FIELD', entry.lines.get(`${harness}.${key}`) ?? line, `## harness-routes.${harness}: unknown field ${key}`)
        ok = false
      }
    }
    const fail = (message) => {
      add('INVALID_VALUE', line, `## harness-routes.${harness}: ${message}`)
      ok = false
    }
    if (!isString(route.provider, 40)) fail('provider must be text of 1-40 characters')
    if (!SECURITY.includes(route.security)) fail(`security must be ${SECURITY.join(' | ')}`)
    if (!BASES.includes(route.basis)) fail(`basis must be ${BASES.join(' | ')}`)
    if (Object.hasOwn(route, 'accepted_versions')) {
      const versions = route.accepted_versions
      if (versions === null) {
        add('NULL_OPTIONAL', line, `## harness-routes.${harness}.accepted_versions is null; omit it instead`)
        ok = false
      } else if (!Array.isArray(versions) || versions.length > 8 || new Set(versions).size !== versions.length
        || !versions.every((version) => isString(version, 64))) {
        fail('accepted_versions must be at most 8 distinct quoted version strings')
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
    if (role === null || typeof role !== 'object' || Array.isArray(role)) {
      add('INVALID_VALUE', line, `## roles.${id} must be a map with candidates and then`)
      continue
    }
    let ok = true
    const fail = (code, message) => {
      add(code, entry.lines.get(`${id}.${message.key}`) ?? line, `## roles.${id}: ${message.text}`)
      ok = false
    }
    for (const key of Object.keys(role)) {
      if (!['candidates', 'then', 'recheck', 'small_epic'].includes(key)) fail('UNKNOWN_FIELD', { key, text: `unknown field ${key}` })
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
      if (id === 'lead' && agent.title === 'squire') fail('SQUIRE_LEAD', { key, text: `"${text}": ${agent.id} is a squire and never leads` })
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
      if (recheck === null || typeof recheck !== 'object' || Array.isArray(recheck)) {
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
    if (Object.hasOwn(role, 'small_epic')) {
      if (role.small_epic === null || typeof role.small_epic !== 'string') fail('INVALID_VALUE', { key: 'small_epic', text: 'small_epic must be agent@effort' })
      else checkCandidate(role.small_epic, 'small_epic', true)
    }
    if (ok) {
      const out = { id, candidates: role.candidates, then: role.then }
      if (Object.hasOwn(role, 'recheck')) out.recheck = role.recheck
      if (Object.hasOwn(role, 'small_epic')) out.small_epic = role.small_epic
      roles.push(out)
    }
  }
  return roles
}

/** The directory a label path names, with symbolic links followed where the path exists. */
function resolvedDirectory(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function validateLabels(entry, add) {
  const labels = { default: 'private', paths: [] }
  if (!entry) return labels
  const resolved = new Map()
  for (const [key, label] of Object.entries(entry.value)) {
    const line = entry.lines.get(key)
    if (!LABELS.includes(label)) {
      add('INVALID_VALUE', line, `## data-labels.${key} must be public or private`)
      continue
    }
    if (key === 'default') {
      labels.default = label
      continue
    }
    const parts = key.split('/')
    if (!key.startsWith('/') || parts.includes('..') || parts.includes('.')) {
      add('LABEL_PATH', line, `## data-labels: "${key}" must be an absolute path without . or .. (nothing is expanded, not even ~)`)
      continue
    }
    const path = key.length > 1 ? key.replace(/\/+$/, '') : key
    const directory = resolvedDirectory(path)
    if (resolved.has(directory)) {
      add('LABEL_COLLISION', line, `## data-labels: "${key}" names the same directory as "${resolved.get(directory)}"`)
      continue
    }
    resolved.set(directory, key)
    labels.paths.push({ path, label })
  }
  return labels
}

// ---------------------------------------------------------------------------------------------
// Queries over validated (or approved) machine data

export function agentState(agent) {
  if (agent.status === 'proposed') return 'proposed'
  if (!agent.enabled) return 'disabled'
  return 'active'
}

/** One unabridged team line: never prose, notes, cost, quota or tags. */
export function teamEntry(agent) {
  const entry = {
    id: agent.id, name: agent.name, title: agent.title, harness: agent.harness, model: agent.model,
    roles: agent.roles, security: agent.security, trust: agent.trust, authority: agent.authority,
    efforts: agent.efforts, state: agentState(agent)
  }
  if (agent.max_context_tokens !== undefined) entry.max_context_tokens = { value: agent.max_context_tokens, enforced: false }
  return entry
}

export function teamLine(entry) {
  const parts = [entry.id, entry.name, entry.title, entry.harness, entry.model,
    `roles=${entry.roles.join(',') || '-'}`, `security=${entry.security}`, `trust=${entry.trust}`,
    `authority=${entry.authority}`, `efforts=${entry.efforts.join(',') || '-'}`]
  if (entry.max_context_tokens) parts.push(`max_context_tokens=${entry.max_context_tokens.value} (configured; not enforced)`)
  if (entry.state !== 'active') parts.push(`[${entry.state}]`)
  return parts.join('  ')
}

export function team(data, all) {
  return data.agents.filter((agent) => all || agentState(agent) === 'active').map(teamEntry)
}

/** The full chain for a role: ordered candidates with each one's eligibility, `then` and the typed rules. */
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
      eligible: state === 'active', state
    }
  }
  const chain = { role: role.id, candidates: role.candidates.map(describe), then: role.then }
  if (role.recheck !== undefined) {
    const { same_reviewer: sameReviewer, ...efforts } = role.recheck
    chain.recheck = { same_reviewer: sameReviewer, efforts }
  }
  if (role.small_epic !== undefined) chain.small_epic = describe(role.small_epic)
  return chain
}

export function roleChainText(chain) {
  const lines = [`role ${chain.role}`]
  chain.candidates.forEach((candidate, index) => {
    const effort = candidate.effort_choice ? `${candidate.efforts.join('|')} (lead chooses)` : candidate.efforts[0]
    lines.push(`  ${index + 1}. ${candidate.agent}@${effort}  ${candidate.eligible ? 'eligible' : `not eligible: ${candidate.state}`}`)
  })
  lines.push(`  then: ${chain.then}`)
  if (chain.recheck) {
    const overrides = Object.entries(chain.recheck.efforts).map(([agent, effort]) => `${agent} at ${effort}`)
    lines.push(`  recheck: ${chain.recheck.same_reviewer ? 'same reviewer' : 'any candidate'}${overrides.length ? `, ${overrides.join(', ')}` : ''}`)
  }
  if (chain.small_epic) {
    lines.push(`  small epic: ${chain.small_epic.agent}@${chain.small_epic.efforts[0]}  ${chain.small_epic.eligible ? 'eligible' : `not eligible: ${chain.small_epic.state}`}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Writing machine data back as YAML (revert and panel saves, 60.2 and 60.5)

function yamlScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  const plain = /^[A-Za-z0-9_./@+-][A-Za-z0-9_ ./@|+-]*$/.test(text) && !/\s$/.test(text)
    && !['null', 'true', 'false', '~'].includes(text) && !/^-?\d+$/.test(text) && !/ #|: /.test(text)
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

export function rolesYaml(roles) {
  return roles.map((role) => {
    const { id, ...rest } = role
    return `${id}: ${yamlFlow(rest)}`
  }).join('\n')
}

export function labelsYaml(labels) {
  return [`default: ${labels.default}`, ...labels.paths.map((entry) => `${yamlScalar(entry.path)}: ${entry.label}`)].join('\n')
}

export function routesYaml(routes) {
  return routes.map((route) => {
    const { harness, ...rest } = route
    return `${harness}: ${yamlFlow(rest)}`
  }).join('\n')
}

export function headerYaml() {
  return `schema_version: ${SCHEMA_VERSION}`
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
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const agent = { id }
  for (const key of Object.keys(value)) agent[key] = value[key]
  return agent
}

function rolesFromBlock(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  return Object.entries(value).map(([id, role]) => ({ id, ...(role && typeof role === 'object' ? role : { invalid: role }) }))
}

function labelsFromBlock(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const { default: fallback = 'private', ...paths } = value
  return { default: fallback, paths: Object.entries(paths).map(([path, label]) => ({ path: path.length > 1 ? path.replace(/\/+$/, '') : path, label })) }
}

function routesFromBlock(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  return Object.entries(value).map(([harness, route]) => ({ harness, ...(route && typeof route === 'object' ? route : { invalid: route }) }))
}

function same(a, b) {
  return a !== undefined && canonicalJson(a) === canonicalJson(b)
}

/**
 * The roster text rewritten so its machine data equals `data`, changing only what must change:
 * a yaml block whose fields already match keeps its bytes (comments included); a differing block
 * is replaced between its fences; an agent missing from the file gets a new section at the end;
 * an agent the file has and `data` lacks loses its whole section. Prose outside rewritten
 * blocks is never touched. `scope`, when given, limits the rewrite to those section ids.
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
    let wanted
    let current
    if (id === 'roster') {
      wanted = headerYaml()
      current = same(blockValue(section), { schema_version: SCHEMA_VERSION }) ? wanted : undefined
    } else if (id === 'roles') {
      wanted = rolesYaml(data.roles)
      current = same(rolesFromBlock(blockValue(section)), data.roles) ? wanted : undefined
    } else if (id === 'data-labels') {
      wanted = labelsYaml(data.data_labels)
      current = same(labelsFromBlock(blockValue(section)), data.data_labels) ? wanted : undefined
    } else if (id === 'harness-routes') {
      wanted = routesYaml(data.harness_routes)
      current = same(routesFromBlock(blockValue(section)), data.harness_routes) ? wanted : undefined
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
  for (const agent of data.agents) ensure(agent.id, agentYaml(agent))
  if (data.roles.length > 0) ensure('roles', rolesYaml(data.roles))
  if (data.data_labels.paths.length > 0 || data.data_labels.default !== 'private') ensure('data-labels', labelsYaml(data.data_labels))
  if (data.harness_routes.length > 0) ensure('harness-routes', routesYaml(data.harness_routes))
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  if (appended !== '') out = `${out}${out.endsWith('\n') || out === '' ? '' : '\n'}${appended}`
  return out
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
    throw new RosterError('ROSTER_INVALID', 'an opinion cannot hold code fences or ## headings')
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
