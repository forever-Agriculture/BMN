// MODULE: agents-tool-files.mjs - Story 60.12: reading one MCP entry out of an app's own settings file and changing only that entry, every other byte left as it is (JSON with comments, and Codex's TOML)

/**
 * An agent app keeps its MCP tools in a file it also rewrites itself (`~/.claude.json` holds a
 * great deal besides). BMN therefore never rewrites such a file from parsed data: it finds the one
 * entry by position and replaces, adds or removes exactly those bytes. Anything it cannot place
 * with certainty is reported as unreadable and left alone.
 *
 * Two shapes are read: a JSON object of entries under a key path (Claude Code `mcpServers`,
 * Cursor `mcpServers`, OpenCode `mcp`; comments and trailing commas allowed), and Codex's TOML
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
function valueEnd(text, start) {
  const char = text[start]
  if (char === '"') return stringEnd(text, start)
  if (char === '{') return objectSpans(text, start).close + 1
  if (char === '[') {
    let index = skipSpace(text, start + 1)
    while (text[index] !== ']') {
      index = skipSpace(text, valueEnd(text, index))
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
function objectSpans(text, open) {
  if (text[open] !== '{') fail('an object was expected')
  const members = []
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
    index = skipSpace(text, keyEnd)
    if (text[index] !== ':') fail('a ":" was expected')
    const start = skipSpace(text, index + 1)
    const end = valueEnd(text, start)
    index = skipSpace(text, end)
    let commaEnd = -1
    if (text[index] === ',') {
      commaEnd = index + 1
      index = skipSpace(text, commaEnd)
    } else if (text[index] !== '}') fail('an object is not closed')
    members.push({ key, keyStart, valueStart: start, valueEnd: end, commaEnd })
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

function rootOf(text) {
  const open = skipSpace(text, 0)
  if (open >= text.length) return null
  const root = objectSpans(text, open)
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

/** `text` with one member of the object `spans` set to `value` (or to the exact text `raw`), or removed when both are undefined. */
function editMember(text, spans, key, value, unit, raw) {
  const written = (indent) => raw ?? rendered(value, unit, indent)
  const index = spans.members.findIndex((member) => member.key === key)
  const outer = indentAt(text, spans.open)
  const inner = spans.members.length > 0 && ownLine(text, spans.members[0].keyStart) ? indentAt(text, spans.members[0].keyStart) : `${outer}${unit}`
  if (value === undefined && raw === undefined) {
    if (index === -1) return text
    const member = spans.members[index]
    if (spans.members.length === 1) return `${text.slice(0, spans.open + 1)}${text.slice(spans.close)}`
    if (member.commaEnd !== -1) {
      // The member and its comma go; a member on a line of its own takes that line with it.
      const lineEnd = text.indexOf('\n', member.commaEnd)
      const alone = ownLine(text, member.keyStart) && lineEnd !== -1 && /^[ \t\r]*$/.test(text.slice(member.commaEnd, lineEnd))
      return alone ? `${text.slice(0, lineStart(text, member.keyStart))}${text.slice(lineEnd + 1)}` : `${text.slice(0, member.keyStart)}${text.slice(skipBlanks(text, member.commaEnd))}`
    }
    // The last member takes the comma before it along.
    const before = spans.members[index - 1]
    return `${text.slice(0, before.valueEnd)}${text.slice(member.valueEnd)}`
  }
  if (index !== -1) {
    const member = spans.members[index]
    return `${text.slice(0, member.valueStart)}${written(indentAt(text, member.keyStart))}${text.slice(member.valueEnd)}`
  }
  const entry = `${JSON.stringify(key)}: ${written(inner)}`
  if (spans.members.length === 0) return `${text.slice(0, spans.open + 1)}\n${inner}${entry}\n${outer}${text.slice(spans.close)}`
  const last = spans.members.at(-1)
  return `${text.slice(0, last.valueEnd)},\n${inner}${entry}${text.slice(last.valueEnd)}`
}

function skipBlanks(text, start) {
  let index = start
  while (text[index] === ' ' || text[index] === '\t') index += 1
  return index
}

/**
 * The settings text with the entry `id` under `path` set to `value`, or removed when `value` is
 * undefined. Only that entry's bytes change, plus the comma and line it needs; a missing key path
 * is added when an entry is set, and a file with no object at all becomes one. `raw` puts an
 * entry back as the exact text it had (an undo), instead of a value written anew.
 */
export function editJsonEntry(text, path, id, value, { raw } = {}) {
  const unit = indentUnit(text)
  if (raw !== undefined) value = parseValue(raw)
  if (rootOf(text) === null) {
    if (value === undefined) return text
    const nested = [...path].reverse().reduce((inner, step) => ({ [step]: inner }), { [id]: value })
    return `${JSON.stringify(nested, null, 2)}\n`
  }
  // The deepest step of the path that is there, and what is missing below it.
  let depth = path.length
  while (depth > 0 && containerOf(text, path.slice(0, depth)) === null) depth -= 1
  const spans = containerOf(text, path.slice(0, depth))
  if (depth === path.length) return editMember(text, spans, id, value, unit, raw)
  if (value === undefined) return text
  const missing = path.slice(depth + 1).reverse().reduce((inner, step) => ({ [step]: inner }), { [id]: value })
  return editMember(text, spans, path[depth], missing, unit)
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
function tomlValue(source) {
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
      const [value, after] = tomlValue(rest)
      list.push(value)
      rest = after.replace(/^(?:[ \t\r\n]|#[^\n]*)+/, '')
      if (rest[0] === ',') rest = rest.slice(1)
      else if (rest[0] !== ']') fail('a list is not closed')
    }
  }
  if (text[0] === '{') {
    const table = {}
    let rest = text.slice(1).replace(/^[ \t]+/, '')
    if (rest[0] === '}') return [table, rest.slice(1)]
    for (;;) {
      const equals = rest.indexOf('=')
      const parts = equals === -1 ? null : keyParts(rest.slice(0, equals))
      if (parts === null || parts.length !== 1) fail('an inline table cannot be read')
      const [value, after] = tomlValue(rest.slice(equals + 1))
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
export function readTomlEntries(text, root = 'mcp_servers') {
  const entries = new Map()
  const lines = tomlLines(text)
  const mark = (id, reason) => {
    const entry = entries.get(id) ?? { value: null, raw: '', start: -1, end: -1 }
    entries.set(id, { ...entry, unreadable: entry.unreadable ?? reason })
  }
  let table = []
  let current = null
  const closed = new Set()
  let pending = null
  for (const line of lines) {
    if (pending !== null) {
      // A value that runs over several lines (a list): gathered until it reads whole.
      pending.text += `\n${line.body}`
      try {
        const [value, rest] = tomlValue(pending.text)
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
      table = ['?']
      current = null
      continue
    }
    if (line.header !== null) {
      table = line.header
      if (table[0] !== root) {
        if (current !== null) closed.add(current)
        current = null
        continue
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
        else entries.set(id, { value: {}, raw: '', start: line.start, end: line.end, firstLine: line, lastLine: line })
        current = id
      }
      const entry = entries.get(id)
      entry.lastLine = line
      if (entry.unreadable === undefined) {
        let target = entry.value
        for (const step of table.slice(2)) {
          target[step] ??= {}
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
      const [value, rest] = tomlValue(line.body.slice(equals + 1))
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
