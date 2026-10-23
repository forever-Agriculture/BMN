import { createHash } from 'node:crypto'

// MODULE: agents-tool-files.mjs - Story 60.12: reading one MCP entry out of an app's own settings file and changing only that entry, every other byte left as it is (JSON with comments, and Codex's TOML)

/**
 * An agent app keeps its MCP tools in a file it also rewrites itself (`~/.claude.json` holds a
 * great deal besides). BMN therefore never rewrites such a file from parsed data: it finds the one
 * entry by position and replaces, adds or removes exactly those bytes. Anything it cannot place
 * with certainty is reported as unreadable and left alone.
 *
 * Two shapes are read: a JSON object of entries under a key path (Claude Code `mcpServers`,
 * OpenCode `mcp`; comments and trailing commas allowed), and Codex's TOML
 * tables `[mcp_servers.<id>]` with their sub-tables.
 */

export class ToolFileError extends Error {
  constructor(message) {
    super(message)
    this.code = 'TOOL_FILE_UNREADABLE'
  }
}

const fail = (message) => {
  throw new ToolFileError(message)
}

// ---------------------------------------------------------------------------------------------
// JSON, with comments

function skipSpace(text, start) {
  let index = start
  for (;;) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') index += 1
    else if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) fail('a comment is not closed')
      index = end + 2
    } else return index
  }
}

function stringEnd(text, start) {
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') index += 2
    else if (text[index] === '"') return index + 1
    else if (text[index] === '\n') break
    else index += 1
  }
  return fail('a text is not closed')
}

/** The index just after the value that starts at `start`. */
function valueEnd(text, start, strict = false) {
  const char = text[start]
  if (char === '"') return stringEnd(text, start)
  if (char === '{') return objectSpans(text, start, strict).close + 1
  if (char === '[') {
    let index = skipSpace(text, start + 1)
    while (text[index] !== ']') {
      index = skipSpace(text, valueEnd(text, index, strict))
      if (text[index] === ',') index = skipSpace(text, index + 1)
      else if (text[index] !== ']') fail('a list is not closed')
    }
    return index + 1
  }
  const word = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(start, start + 40))
  if (word === null) fail('a value cannot be read')
  return start + word[0].length
}

/**
 * The members of the object that opens at `open`: each key with where it starts, where its value
 * starts and ends, and where the comma after it ends (-1 when there is none).
 */
function objectSpans(text, open, strict = false) {
  if (text[open] !== '{') fail('an object was expected')
  const members = []
  const names = strict ? new Set() : null
  let index = skipSpace(text, open + 1)
  while (text[index] !== '}') {
    if (text[index] !== '"') fail('a name was expected')
    const keyStart = index
    const keyEnd = stringEnd(text, index)
    let key
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd))
    } catch {
      fail('a name cannot be read')
    }
    if (names?.has(key)) fail('a name is there twice')
    names?.add(key)
    index = skipSpace(text, keyEnd)
    if (text[index] !== ':') fail('a ":" was expected')
    const colon = index
    const start = skipSpace(text, index + 1)
    const end = valueEnd(text, start, strict)
    index = skipSpace(text, end)
    let commaEnd = -1
    if (text[index] === ',') {
      commaEnd = index + 1
      index = skipSpace(text, commaEnd)
    } else if (text[index] !== '}') fail('an object is not closed')
    members.push({ key, keyStart, keyEnd, colon, valueStart: start, valueEnd: end, commaEnd })
  }
  return { open, close: index, members }
}

/** A JSON text with comments and trailing commas taken out, strings left whole. */
function plainJson(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const end = stringEnd(text, index)
      out += text.slice(index, end)
      index = end
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipSpace(text, index)
      out += ' '
    } else if (char === ',') {
      const next = skipSpace(text, index + 1)
      if (text[next] !== '}' && text[next] !== ']') out += ','
      index += 1
    } else {
      out += char
      index += 1
    }
  }
  return out
}

function parseValue(text) {
  try {
    return JSON.parse(plainJson(text))
  } catch (error) {
    if (error instanceof ToolFileError) throw error
    return fail('a value cannot be read')
  }
}

function rootOf(text, strict = false) {
  const open = skipSpace(text, 0)
  if (open >= text.length) return null
  const root = objectSpans(text, open, strict)
  if (skipSpace(text, root.close + 1) < text.length) fail('the file holds more than one object')
  return root
}

/** The object at `path` below the root, or null when a step of the path is not there. */
function containerOf(text, path) {
  let spans = rootOf(text)
  for (const step of path) {
    if (spans === null) return null
    const members = spans.members.filter((entry) => entry.key === step)
    // Which of two would the app take? BMN does not guess: the file is not one it can place an entry in.
    if (members.length > 1) fail(`"${step}" is there twice`)
    const member = members[0]
    if (member === undefined) return null
    if (text[member.valueStart] !== '{') fail(`"${step}" is not an object`)
    spans = objectSpans(text, member.valueStart)
  }
  return spans
}

/**
 * The entries under `path` in a JSON settings file: each id with its parsed value and its exact
 * text. A missing or empty file, or a missing key, holds none. Throws `ToolFileError` when the
 * file cannot be placed with certainty.
 */
export function readJsonEntries(text, path) {
  const entries = new Map()
  const spans = containerOf(text, path)
  if (spans === null) return entries
  for (const member of spans.members) {
    if (entries.has(member.key)) fail(`"${member.key}" is there twice`)
    const raw = text.slice(member.valueStart, member.valueEnd)
    entries.set(member.key, { value: parseValue(raw), raw })
  }
  return entries
}

/** Parser-derived entry coordinates for read-only inventory, including nested arrays. Offsets are UTF-16. */
export function readJsonItems(text, path = [], { strict = false } = {}) {
  if (strict) rootOf(text, true)
  let start = skipSpace(text, 0)
  if (start >= text.length) return []
  const items = (at) => {
    if (text[at] === '{') {
      const members = objectSpans(text, at).members
      if (new Set(members.map((member) => member.key)).size !== members.length) fail('a name is there twice')
      return members.map((member) => ({ key: member.key, start: member.keyStart, valueStart: member.valueStart, value: parseValue(text.slice(member.valueStart, member.valueEnd)) }))
    }
    if (text[at] !== '[') fail('an object or list was expected')
    const entries = []
    let index = skipSpace(text, at + 1)
    while (text[index] !== ']') {
      const end = valueEnd(text, index)
      entries.push({ key: entries.length, start: index, valueStart: index, value: parseValue(text.slice(index, end)) })
      index = skipSpace(text, end)
      if (text[index] === ',') index = skipSpace(text, index + 1)
      else if (text[index] !== ']') fail('a list is not closed')
    }
    return entries
  }
  for (const key of path) {
    const entry = items(start).find((entry) => entry.key === key)
    if (!entry) return []
    start = entry.valueStart
  }
  return items(start).map((entry) => ({ key: entry.key, start: entry.start, value: entry.value }))
}

function lineStart(text, index) {
  return text.lastIndexOf('\n', index - 1) + 1
}

function indentAt(text, index) {
  return /^[ \t]*/.exec(text.slice(lineStart(text, index), index))[0]
}

function ownLine(text, index) {
  return /^[ \t]*$/.test(text.slice(lineStart(text, index), index))
}

/** The file's own indent step: the first indented line's leading blanks, else two spaces. */
function indentUnit(text) {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  '
}

function rendered(value, unit, indent) {
  return JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`)
}

/** Non-comment tokens and whether the range contains comments. Trivia always stays live. */
function tokensOf(text, start, end) {
  const tokens = []
  let comments = false
  for (let index = start; index < end;) {
    const char = text[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      comments = true
      index = skipSpace(text, index)
      continue
    }
    const next = char === '"' ? stringEnd(text, index) : '{}[],:'.includes(char) ? index + 1 : valueEnd(text, index)
    if (next > end) fail('an edit crosses its token boundary')
    tokens.push({ start: index, end: next })
    index = next
  }
  return { tokens, comments }
}

const patch = (text, start, end, insert = '') => ({ start, delete: text.slice(start, end), insert })

function tokenRemoval(text, spans, index, preserveComments) {
  const member = spans.members[index]
  const tokens = [...tokensOf(text, member.keyStart, member.valueStart).tokens,
    ...(preserveComments ? tokensOf(text, member.valueStart, member.valueEnd).tokens : [{ start: member.valueStart, end: member.valueEnd }])]
  const edits = tokens.map((token) => patch(text, token.start, token.end))
  const comma = member.commaEnd !== -1 ? member.commaEnd : index > 0 ? spans.members[index - 1].commaEnd : -1
  if (comma !== -1) edits.push(patch(text, comma - 1, comma))
  return edits
}

/** Plan the same entry edit for ordinary writes and inverse receipts. */
function editMember(text, spans, key, value, unit, raw, preserveComments) {
  const written = (indent) => raw ?? rendered(value, unit, indent)
  const index = spans.members.findIndex((member) => member.key === key)
  const outer = indentAt(text, spans.open)
  const inner = spans.members.length > 0 && ownLine(text, spans.members[0].keyStart) ? indentAt(text, spans.members[0].keyStart) : `${outer}${unit}`
  if (value === undefined && raw === undefined) {
    if (index === -1) return []
    const member = spans.members[index]
    let start, end
    if (spans.members.length === 1) { start = spans.open + 1; end = spans.close }
    else if (member.commaEnd !== -1) {
      const lineEnd = text.indexOf('\n', member.commaEnd)
      const alone = ownLine(text, member.keyStart) && lineEnd !== -1 && /^[ \t\r]*$/.test(text.slice(member.commaEnd, lineEnd))
      start = alone ? lineStart(text, member.keyStart) : member.keyStart
      end = alone ? lineEnd + 1 : skipBlanks(text, member.commaEnd)
    } else { start = spans.members[index - 1].valueEnd; end = member.valueEnd }
    const comments = preserveComments ? tokensOf(text, start, end).comments :
      tokensOf(text, start, member.valueStart).comments || tokensOf(text, member.valueEnd, end).comments
    return comments ? tokenRemoval(text, spans, index, preserveComments) : [patch(text, start, end)]
  }
  if (index !== -1) {
    const member = spans.members[index], next = written(indentAt(text, member.keyStart))
    const old = tokensOf(text, member.valueStart, member.valueEnd)
    if (!preserveComments || !old.comments) return [patch(text, member.valueStart, member.valueEnd, next)]
    return old.tokens.map((token, i) => patch(text, token.start, token.end, i === 0 ? next : ''))
  }
  const entry = `${JSON.stringify(key)}: ${written(inner)}`
  if (spans.members.length === 0) {
    const insert = `\n${inner}${entry}\n${outer}`
    return tokensOf(text, spans.open + 1, spans.close).comments
      ? [patch(text, spans.close, spans.close, insert)] : [patch(text, spans.open + 1, spans.close, insert)]
  }
  const last = spans.members.at(-1)
  return [patch(text, last.valueEnd, last.valueEnd, `,\n${inner}${entry}`)]
}

function skipBlanks(text, start) {
  let index = start
  while (text[index] === ' ' || text[index] === '\t') index += 1
  return index
}

function applyPatches(text, edits) {
  let end = 0
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < end || edit.start > text.length ||
      typeof edit.delete !== 'string' || typeof edit.insert !== 'string' || text.slice(edit.start, edit.start + edit.delete.length) !== edit.delete) fail('an edit no longer matches its tokens')
    end = edit.start + edit.delete.length
  }
  for (const edit of [...edits].reverse()) text = `${text.slice(0, edit.start)}${edit.insert}${text.slice(edit.start + edit.delete.length)}`
  return text
}

const digest = (text) => createHash('sha256').update(text).digest('hex')
const receiptLimit = 1024 * 1024

function jsonEditPlan(text, path, id, value, raw, preserveComments = false) {
  const unit = indentUnit(text)
  if (raw !== undefined) value = parseValue(raw)
  const nestedRaw = (steps) => steps.reverse().reduce((inner, key) => `{${JSON.stringify(key)}:${inner}}`, raw)
  let edits
  if (rootOf(text) === null) {
    if (value === undefined) edits = []
    else {
      const nested = raw === undefined ? JSON.stringify([...path].reverse().reduce((inner, step) => ({ [step]: inner }), { [id]: value }), null, 2) : nestedRaw([...path, id])
      // A comment-only file remains intact; a newline ends a possible EOF line comment.
      edits = [patch(text, text.length, text.length, `${text === '' || text.endsWith('\n') ? '' : '\n'}${nested}\n`)]
    }
  } else {
    let depth = path.length
    while (depth > 0 && containerOf(text, path.slice(0, depth)) === null) depth -= 1
    const spans = containerOf(text, path.slice(0, depth))
    if (depth === path.length) edits = editMember(text, spans, id, value, unit, raw, preserveComments)
    else if (value === undefined) edits = []
    else {
      const missing = path.slice(depth + 1).reverse().reduce((inner, step) => ({ [step]: inner }), { [id]: value })
      edits = editMember(text, spans, path[depth], missing, unit, raw === undefined ? undefined : nestedRaw([...path.slice(depth + 1), id]), preserveComments)
    }
  }
  edits.sort((a, b) => a.start - b.start)
  return { text: applyPatches(text, edits), edits }
}

/** Set/remove one JSONC entry, preserving surrounding comments and the existing raw-value API. */
export function editJsonEntry(text, path, id, value, { raw } = {}) {
  return jsonEditPlan(text, path, id, value, raw).text
}

/** A comment-free prior value; callers must separately admit every literal before persisting it. */
export function commentFreeJson(text) {
  return plainJson(text)
}

/** Exact inverse metadata contains only the planner's edited tokens and structural trivia. */
export function editJsonEntryWithReceipt(text, path, id, value, { raw } = {}) {
  const plan = jsonEditPlan(text, path, id, value, raw, true)
  const receipt = { version: 1, raw: raw !== undefined, before: digest(text), after: digest(plan.text), edits: plan.edits }
  if (receipt.edits.length > 8192 || Buffer.byteLength(JSON.stringify(receipt)) > receiptLimit ||
    receipt.edits.some((edit) => tokensOf(edit.delete, 0, edit.delete.length).comments || tokensOf(edit.insert, 0, edit.insert.length).comments)) fail('the entry cannot be journaled without keeping comments or exceeding the receipt limit')
  return { text: plan.text, receipt }
}

/** Validate scope by independently replaying the same entry planner; null means unrelated file edits. */
export function invertJsonEntry(text, path, id, receipt) {
  if (receipt === null || typeof receipt !== 'object' || receipt.version !== 1 || typeof receipt.raw !== 'boolean' ||
    typeof receipt.before !== 'string' || typeof receipt.after !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.before) || !/^[a-f0-9]{64}$/.test(receipt.after) || !Array.isArray(receipt.edits) ||
    receipt.edits.length > 8192 || Buffer.byteLength(JSON.stringify(receipt)) > receiptLimit ||
    Object.keys(receipt).sort().join(',') !== 'after,before,edits,raw,version') fail('the inverse receipt is malformed')
  let end = 0, delta = 0
  const inverse = []
  for (const edit of receipt.edits) {
    if (edit === null || typeof edit !== 'object' || Object.keys(edit).sort().join(',') !== 'delete,insert,start' ||
      !Number.isSafeInteger(edit.start) || edit.start < end || typeof edit.delete !== 'string' || typeof edit.insert !== 'string' ||
      tokensOf(edit.delete, 0, edit.delete.length).comments || tokensOf(edit.insert, 0, edit.insert.length).comments) fail('the inverse receipt contains an invalid token edit')
    inverse.push({ start: edit.start + delta, delete: edit.insert, insert: edit.delete })
    end = edit.start + edit.delete.length
    delta += edit.insert.length - edit.delete.length
  }
  if (digest(text) !== receipt.after) return null
  const before = applyPatches(text, inverse)
  if (digest(before) !== receipt.before) fail('the inverse receipt does not reconstruct its bound file')
  const current = readJsonEntries(text, path).get(id)
  const replay = editJsonEntryWithReceipt(before, path, id, current?.value, { raw: receipt.raw ? current?.raw : undefined })
  if (replay.text !== text || JSON.stringify(replay.receipt) !== JSON.stringify(receipt)) fail('the inverse receipt is not an edit of this entry')
  return before
}

/** Both OpenCode layouts, with parser-derived provenance; metadata is never a tool. */
export function readOpenCodeEntries(text, { strict = false } = {}) {
  if (strict) rootOf(text, true)
  const entries = new Map(), root = containerOf(text, ['mcp'])
  if (!root) return entries
  const seen = new Set()
  const add = (member, at) => {
    if (entries.has(member.key)) fail(`"${member.key}" is in both MCP layouts`)
    const raw = text.slice(member.valueStart, member.valueEnd)
    entries.set(member.key, { value: parseValue(raw), raw, at, start: member.keyStart })
  }
  for (const member of root.members) {
    if (seen.has(member.key)) fail(`"${member.key}" is there twice`)
    seen.add(member.key)
    if (member.key === 'timeout') continue
    if (member.key !== 'servers') { add(member, ['mcp']); continue }
    if (text[member.valueStart] !== '{') fail('"mcp.servers" is not an object')
    const value = parseValue(text.slice(member.valueStart, member.valueEnd))
    // A legacy server named "servers" remains readable; a canonical add must refuse this namespace collision.
    if (typeof value.type === 'string' || Array.isArray(value.command) || typeof value.url === 'string') { add(member, ['mcp']); continue }
    const nested = objectSpans(text, member.valueStart), names = new Set()
    for (const server of nested.members) {
      if (names.has(server.key)) fail(`"${server.key}" is there twice`)
      names.add(server.key)
      add(server, ['mcp', 'servers'])
    }
  }
  return entries
}

// ---------------------------------------------------------------------------------------------
// Codex's TOML: [mcp_servers.<id>] tables

const BARE_KEY = /^[A-Za-z0-9_-]+$/

/** The parts of a table header or a dotted key: `mcp_servers."my id".env` is three. Null when it cannot be read. */
function keyParts(text) {
  const parts = []
  let index = 0
  const source = text.trim()
  while (index < source.length) {
    let part
    if (source[index] === '"') {
      const end = source.indexOf('"', index + 1)
      if (end === -1 || source.slice(index, end + 1).includes('\\')) return null
      part = source.slice(index + 1, end)
      index = end + 1
    } else if (source[index] === "'") {
      const end = source.indexOf("'", index + 1)
      if (end === -1) return null
      part = source.slice(index + 1, end)
      index = end + 1
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index))
      if (match === null) return null
      part = match[0]
      index += part.length
    }
    parts.push(part)
    while (source[index] === ' ' || source[index] === '\t') index += 1
    if (index === source.length) break
    if (source[index] !== '.') return null
    index += 1
    while (source[index] === ' ' || source[index] === '\t') index += 1
  }
  return parts.length > 0 ? parts : null
}

/** One TOML value of the kinds an MCP entry uses: text, true or false, a whole number, a list of those, or an inline table of them. Returns [value, rest]. */
function tomlValue(source, strict = false) {
  const text = source.replace(/^[ \t\r\n]+/, '')
  if (text[0] === '"') {
    if (text.startsWith('"""')) return fail('a multi-line text is not read')
    let index = 1
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    if (index >= text.length) fail('a text is not closed')
    let value
    try {
      value = JSON.parse(text.slice(0, index + 1).replace(/\\U([0-9a-fA-F]{8})/g, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\\e/g, '\\u001b'))
    } catch {
      fail('a text cannot be read')
    }
    return [value, text.slice(index + 1)]
  }
  if (text[0] === "'") {
    if (text.startsWith("'''")) return fail('a multi-line text is not read')
    const end = text.indexOf("'", 1)
    if (end === -1) fail('a text is not closed')
    return [text.slice(1, end), text.slice(end + 1)]
  }
  if (text[0] === '[') {
    const list = []
    let rest = text.slice(1)
    for (;;) {
      rest = rest.replace(/^(?:[ \t\r\n]|#[^\n]*)+/, '')
      if (rest[0] === ']') return [list, rest.slice(1)]
      if (rest === '') fail('a list is not closed')
      const [value, after] = tomlValue(rest, strict)
      list.push(value)
      rest = after.replace(/^(?:[ \t\r\n]|#[^\n]*)+/, '')
      if (rest[0] === ',') rest = rest.slice(1)
      else if (rest[0] !== ']') fail('a list is not closed')
    }
  }
  if (text[0] === '{') {
    const table = strict ? Object.create(null) : {}
    let rest = text.slice(1).replace(/^[ \t]+/, '')
    if (rest[0] === '}') return [table, rest.slice(1)]
    for (;;) {
      const equals = rest.indexOf('=')
      const parts = equals === -1 ? null : keyParts(rest.slice(0, equals))
      if (parts === null || parts.length !== 1) fail('an inline table cannot be read')
      if (strict && Object.hasOwn(table, parts[0])) fail('an inline name is there twice')
      const [value, after] = tomlValue(rest.slice(equals + 1), strict)
      table[parts[0]] = value
      rest = after.replace(/^[ \t]+/, '')
      if (rest[0] === '}') return [table, rest.slice(1)]
      if (rest[0] !== ',') fail('an inline table is not closed')
      rest = rest.slice(1).replace(/^[ \t]+/, '')
    }
  }
  const word = /^(true|false|[+-]?\d[\d_]*)(?![A-Za-z0-9_.:+-])/.exec(text)
  if (word === null) fail('a value cannot be read')
  return [word[1] === 'true' ? true : word[1] === 'false' ? false : Number(word[1].replaceAll('_', '')), text.slice(word[0].length)]
}

/** The file's lines with where each starts, and for each the table it opens (`[a.b]`), or null. */
function tomlLines(text) {
  const lines = []
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const stop = end === -1 ? text.length : end
    const body = text.slice(start, stop).replace(/\r$/, '')
    const header = /^[ \t]*\[([^\][]+)\][ \t]*(?:#.*)?$/.exec(body)
    const array = /^[ \t]*\[\[/.test(body)
    lines.push({ start, end: stop, body, header: header ? keyParts(header[1]) : null, unreadableHeader: (header !== null && keyParts(header[1]) === null) || array })
    if (end === -1) break
    start = end + 1
  }
  return lines
}

/**
 * Codex's MCP entries: each id with its parsed tables as one object (sub-tables nested), its exact
 * text and where it stands. An entry written in a form BMN does not edit (inline under
 * `[mcp_servers]`, dotted keys, tables apart from each other, a value kind it does not read) is
 * `unreadable` with the reason, and is never changed.
 */
export function readTomlEntries(text, root = 'mcp_servers', { strict = false } = {}) {
  const entries = new Map()
  const lines = tomlLines(text)
  const mark = (id, reason) => {
    const entry = entries.get(id) ?? { value: null, raw: '', start: -1, end: -1 }
    entries.set(id, { ...entry, unreadable: entry.unreadable ?? reason })
  }
  let table = []
  let current = null
  const closed = new Set()
  const tables = new Set()
  let pending = null
  for (const line of lines) {
    if (pending !== null) {
      // A value that runs over several lines (a list): gathered until it reads whole.
      pending.text += `\n${line.body}`
      try {
        const [value, rest] = tomlValue(pending.text, strict)
        if (!/^[ \t]*(?:#.*)?$/.test(rest)) fail('text follows a value')
        pending.target[pending.key] = value
        pending.entry.lastLine = line
        pending = null
      } catch (error) {
        if (!(error instanceof ToolFileError) || !/not closed/.test(error.message)) {
          mark(pending.id, error.message)
          pending = null
        }
      }
      continue
    }
    if (line.unreadableHeader) {
      // Unsupported MCP scope must not silently disappear from an entry commitment.
      const array = /^[ \t]*\[\[(.*?)\]\][ \t]*(?:#.*)?$/.exec(line.body)
      const scope = array ? keyParts(array[1]) : null
      if (strict && (!scope || scope[0] === root)) fail('a table scope cannot be read completely')
      table = ['?']
      current = null
      continue
    }
    if (strict && /^[ \t]*\[/.test(line.body) && line.header === null) fail('a table scope cannot be read completely')
    if (line.header !== null) {
      table = line.header
      if (table[0] !== root) {
        if (current !== null) closed.add(current)
        current = null
        continue
      }
      if (strict) {
        const name = JSON.stringify(table)
        if (tables.has(name)) fail('a table is there twice')
        tables.add(name)
      }
      if (table.length === 1) {
        current = null
        continue
      }
      const id = table[1]
      if (current !== id) {
        if (current !== null) closed.add(current)
        // The same id opened again after another table: its parts stand apart, which BMN does not edit.
        if (closed.has(id) || entries.has(id)) mark(id, 'its tables stand apart from each other')
        else entries.set(id, { value: strict ? Object.create(null) : {}, raw: '', start: line.start, end: line.end, firstLine: line, lastLine: line })
        current = id
      }
      const entry = entries.get(id)
      entry.lastLine = line
      if (entry.unreadable === undefined) {
        let target = entry.value
        for (const [index, step] of table.slice(2).entries()) {
          if (strict && index === table.length - 3 && Object.hasOwn(target, step)) fail('a table is defined twice')
          target[step] ??= strict ? Object.create(null) : {}
          if (typeof target[step] !== 'object' || Array.isArray(target[step])) {
            mark(id, `${step} is written twice`)
            break
          }
          target = target[step]
        }
      }
      continue
    }
    if (/^[ \t]*(?:#.*)?$/.test(line.body)) continue
    const equals = line.body.indexOf('=')
    const parts = equals === -1 ? null : keyParts(line.body.slice(0, equals))
    // Every tool written as one value at the top of the file: BMN reads none of them, so it cannot say which are there.
    if (table.length === 0 && parts !== null && parts[0] === root && parts.length === 1) fail(`${root} is written as one inline value, which BMN does not read or change`)
    // Entries written inline or with dotted keys, under `[mcp_servers]` or at the top of the file.
    if (table.length === 0 && parts !== null && parts[0] === root && parts.length > 1) mark(parts[1], 'it is written with dotted keys')
    if (table.length === 1 && table[0] === root && parts !== null) mark(parts[0], 'it is written inline under [mcp_servers]')
    if (table[0] !== root || table.length < 2) continue
    const id = table[1]
    const entry = entries.get(id)
    entry.lastLine = line
    if (entry.unreadable !== undefined) continue
    if (parts === null || parts.length !== 1) {
      mark(id, 'a line of it cannot be read')
      continue
    }
    let target = entry.value
    for (const step of table.slice(2)) target = target[step]
    try {
      if (strict && Object.hasOwn(target, parts[0])) fail('a name is there twice')
      const [value, rest] = tomlValue(line.body.slice(equals + 1), strict)
      if (!/^[ \t]*(?:#.*)?$/.test(rest)) fail('text follows a value')
      target[parts[0]] = value
    } catch (error) {
      if (error instanceof ToolFileError && /not closed/.test(error.message) && /^[ \t]*\[/.test(line.body.slice(equals + 1))) {
        pending = { id, entry, target, key: parts[0], text: line.body.slice(equals + 1) }
      } else mark(id, error instanceof ToolFileError ? error.message : 'a value cannot be read')
    }
  }
  if (pending !== null) mark(pending.id, 'a list is not closed')
  for (const [id, entry] of entries) {
    if (entry.firstLine === undefined) continue
    const { firstLine, lastLine, ...rest } = entry
    entries.set(id, { ...rest, start: firstLine.start, end: lastLine.end, raw: text.slice(firstLine.start, lastLine.end) })
  }
  return entries
}

const tomlText = (value) => JSON.stringify(String(value))
const tomlKey = (key) => (BARE_KEY.test(key) ? key : tomlText(key))

function tomlInline(value) {
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(', ')}]`
  if (value !== null && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlInline(item)}`).join(', ')} }`
  return typeof value === 'string' ? tomlText(value) : String(value)
}

/** One entry as Codex's own tables: `[mcp_servers.<id>]` and a line per setting, maps written inline. */
export function renderTomlEntry(id, value, root = 'mcp_servers') {
  return [`[${root}.${tomlKey(id)}]`, ...Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlInline(item)}`)].join('\n')
}

/**
 * Codex's settings text with the entry `id` set to `value`, or removed when `value` is undefined.
 * An entry that is there is replaced where it stands; a new one goes to the end of the file. An
 * entry BMN cannot read is never changed: that throws. `raw` puts an entry back as the exact
 * text it had (an undo), instead of a value written anew.
 */
export function editTomlEntry(text, id, value, root = 'mcp_servers', { raw } = {}) {
  const entry = readTomlEntries(text, root).get(id)
  if (entry?.unreadable !== undefined) fail(`${id}: ${entry.unreadable}`)
  if (value === undefined && raw === undefined) {
    if (entry === undefined) return text
    // The entry goes with the one blank line that set it apart.
    let end = entry.end < text.length ? entry.end + 1 : entry.end
    let start = entry.start
    if (/^\r?\n/.test(text.slice(end))) end += text[end] === '\r' ? 2 : 1
    else if (start >= 2 && text.slice(0, start).endsWith('\n\n') && end >= text.length) start -= 1
    return `${text.slice(0, start)}${text.slice(end)}`
  }
  const block = raw ?? renderTomlEntry(id, value, root)
  if (entry !== undefined) return `${text.slice(0, entry.start)}${block}${text.slice(entry.end)}`
  if (text.trim() === '') return `${block}\n`
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`
}
