// MODULE: opencode-floor.mjs - Story 102.15: OpenCode's own refusal rows for the "never" list and the secret list, merged into his config with every other byte kept
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseJsonc } from './agents-check-routes.mjs'
import { NEVER_COMMANDS, secretPaths } from './native-rules.mjs'

export { parseJsonc }

const BEGIN = '// BMN floor begin'
/** A block comment: whatever of his follows on that line stays live. */
const END = '/* BMN floor end */'
const NOTE = ' (bmn hooks install keeps these rows; taking out these lines between the two marks gives back your file)'

/** `permission.bash` patterns and `permission.read` paths, all `deny`. Last match wins in OpenCode, so they go last in each map. */
export function openCodeFloorRows(home) {
  const paths = secretPaths(home)
  return {
    bash: [
      ...NEVER_COMMANDS.flatMap((command) => [command, `${command} *`]),
      ...paths.flatMap((path) => [`*~/${path}*`, `*$HOME/${path}*`, `*${home}/${path}*`])
    ],
    read: paths.flatMap((path) => [`~/${path}`, `${home}/${path}`])
  }
}

/** The members of the object opening at `open`, read over comments and strings, with where it ends. */
function scanObject(text, open) {
  const members = []
  let index = open + 1
  let lastEnd = open + 1
  let comma = false
  const skip = () => {
    for (;;) {
      if (/\s/.test(text[index] ?? '')) index += 1
      else if (text.startsWith('//', index)) { while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1 }
      else if (text.startsWith('/*', index)) index = text.indexOf('*/', index + 2) + 2
      else return
    }
  }
  const string = () => {
    const from = index
    index += 1
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    index += 1
    return JSON.parse(text.slice(from, index))
  }
  const value = () => {
    const from = index
    let depth = 0
    for (;;) {
      skip()
      const char = text[index]
      if (char === '"') string()
      else if (char === '{' || char === '[') { depth += 1; index += 1 }
      else if (char === '}' || char === ']') {
        if (depth === 0) return from
        depth -= 1
        index += 1
      } else if (char === ',' && depth === 0) return from
      else index += 1
      if (depth === 0 && char !== undefined && !/[-+.\w]/.test(text[index] ?? '')) return from
    }
  }
  for (;;) {
    skip()
    if (text[index] === '}') return { members, close: index, lastEnd, comma }
    const key = string()
    skip()
    index += 1
    skip()
    const start = index
    value()
    members.push({ key, start, end: index })
    lastEnd = index
    comma = false
    skip()
    if (text[index] === ',') { index += 1; lastEnd = index; comma = true }
  }
}

/** Where the root object opens: comments before it may hold a brace, so past them. */
function rootOpen(text) {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (;;) {
    if (/\s/.test(text[index] ?? '')) index += 1
    else if (text.startsWith('//', index)) index = text.indexOf('\n', index) + 1
    else if (text.startsWith('/*', index)) index = text.indexOf('*/', index + 2) + 2
    else return index
  }
}

/** His file with every region BMN put in taken out, byte for byte. */
export function withoutOpenCodeFloor(text) {
  let out = text
  for (;;) {
    const begin = out.indexOf(BEGIN)
    if (begin === -1) return out
    const from = out.lastIndexOf('\n', begin)
    const stop = out.indexOf(END, begin)
    if (from === -1 || stop === -1) return out
    out = out.slice(0, from) + out.slice(stop + END.length)
  }
}

const rowLines = (rows, indent) => rows.map((row, index) => `${indent}${JSON.stringify(row)}: "deny"${index === rows.length - 1 ? '' : ','}`)

/** A region to put right after the last thing an object holds; a comma of its own when that member has none, so none of his bytes change. */
function region(object, body, indent) {
  const lead = object.members.length > 0 && !object.comma ? `${indent},` : null
  return [``, `${indent}${BEGIN}${NOTE}`, ...(lead === null ? [] : [lead]), ...body, `${indent}${END}`].join('\n')
}

/**
 * His config text with BMN's rows, or null when it cannot hold them with nothing of his changed: a `permission`, `bash` or `read`
 * that is not a map. Rows go inside the `permission` he has, last in each map, with no duplicate key.
 */
export function withOpenCodeFloor(text, home) {
  const rows = openCodeFloorRows(home)
  const clean = withoutOpenCodeFloor(text)
  parseJsonc(clean)
  const root = scanObject(clean, rootOpen(clean))
  const permission = root.members.find((member) => member.key === 'permission')
  const insertions = []
  if (permission === undefined) {
    const body = ['    "permission": {', ...Object.entries(rows).flatMap(([key, list], at) => [`      ${JSON.stringify(key)}: {`, ...rowLines(list, '        '), `      }${at === 0 ? ',' : ''}`]), '    }']
    insertions.push([root.lastEnd, region(root, body, '  ')])
  } else {
    if (clean[permission.start] !== '{') return null
    const map = scanObject(clean, permission.start)
    const added = []
    for (const [key, list] of Object.entries(rows)) {
      const member = map.members.find((entry) => entry.key === key)
      if (member === undefined) added.push([key, list])
      else {
        if (clean[member.start] !== '{') return null
        insertions.push([scanObject(clean, member.start).lastEnd, region(scanObject(clean, member.start), rowLines(list, '      '), '      ')])
      }
    }
    if (added.length > 0) {
      const body = added.flatMap(([key, list], at) => [`    ${JSON.stringify(key)}: {`, ...rowLines(list, '      '), `    }${at === added.length - 1 ? '' : ','}`])
      insertions.push([map.lastEnd, region(map, body, '    ')])
    }
  }
  let next = clean
  for (const [at, words] of insertions.sort((a, b) => b[0] - a[0])) next = next.slice(0, at) + words + next.slice(at)
  parseJsonc(next)
  return next
}

/** Which of OpenCode's two global files holds its config: `opencode.jsonc` or `opencode.json`, a new `opencode.json` when neither; null when both (agents-tools refuses that too). */
export function openCodeConfigFile(folder) {
  const json = join(folder, 'opencode.json'), jsonc = join(folder, 'opencode.jsonc')
  if (existsSync(json) && existsSync(jsonc)) return null
  return existsSync(jsonc) ? jsonc : json
}

/** What the file holds and what it should: `state` is `present`, `missing` or `unusable`. */
export function openCodeFloorPlan(folder, home) {
  const file = openCodeConfigFile(folder)
  if (file === null) return { file: null, text: null, next: null, state: 'unusable' }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null
  try {
    const next = withOpenCodeFloor(text ?? '{\n}\n', home)
    if (next === null) return { file, text, next: null, state: 'unusable' }
    return { file, text, next, state: next === text ? 'present' : 'missing' }
  } catch {
    return { file, text, next: null, state: 'unusable' }
  }
}
