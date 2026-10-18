// MODULE: quick-look-syntax.ts - whether a config draft still parses, by its format's own parser, and the line of the first fault (Story 68.2 AC5)
import { yamlLanguage } from '@codemirror/lang-yaml'
import { parse as parseToml } from 'smol-toml'

export type ConfigFormat = 'json' | 'jsonc' | 'yaml' | 'toml'

export type SyntaxVerdict = { status: 'valid' } | { status: 'invalid'; line: number; message: string }

const FORMAT_NAMES: Record<ConfigFormat, string> = { json: 'JSON', jsonc: 'JSONC', yaml: 'YAML', toml: 'TOML' }

export function configFormatOf(name: string): ConfigFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.jsonc')) return 'jsonc'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.toml')) return 'toml'
  return null
}

/** The line a draft's syntax line reads: "Syntax valid", or "Invalid JSONC · line 14: unexpected comma". */
export function syntaxWords(format: ConfigFormat, verdict: SyntaxVerdict): string {
  return verdict.status === 'valid' ? 'Syntax valid' : `Invalid ${FORMAT_NAMES[format]} · line ${verdict.line}: ${verdict.message}`
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line += 1
  return line
}

/**
 * JSON with comments, as editors take it: `//` and block comments, and JSON otherwise; a trailing comma is a fault.
 * With `comments: false` it is plain JSON. A small reader of its own, so the fault's line and kind are told in words
 * and no part of the text ever reaches an error message.
 */
function jsonFault(text: string, comments: boolean): SyntaxVerdict {
  let at = 0
  const fail = (message: string, where = at): SyntaxVerdict => ({ status: 'invalid', line: lineAt(text, where), message })
  const skip = (): SyntaxVerdict | null => {
    for (;;) {
      const code = text.charCodeAt(at)
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0xfeff) {
        at += 1
      } else if (comments && text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end === -1 ? text.length : end
      } else if (comments && text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end === -1) return fail('unclosed comment')
        at = end + 2
      } else {
        return null
      }
    }
  }
  const string = (): SyntaxVerdict | null => {
    at += 1
    for (;;) {
      if (at >= text.length) return fail('unclosed string')
      const code = text.charCodeAt(at)
      if (code === 0x22) {
        at += 1
        return null
      }
      if (code < 0x20) return fail('line break or control character in a string')
      if (code === 0x5c) {
        const next = text[at + 1]
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) return fail('bad escape')
          at += 6
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) {
          at += 2
        } else {
          return fail('bad escape')
        }
      } else {
        at += 1
      }
    }
  }
  const number = (): SyntaxVerdict | null => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at, at + 400))
    if (!match) return fail('unexpected character')
    at += match[0].length
    return null
  }
  // An explicit stack instead of recursion: a deeply nested draft cannot run out of stack.
  const stack: Array<'object' | 'array'> = []
  let expect: 'value' | 'after' | 'key' | 'first-key' | 'first-value' = 'value'
  for (;;) {
    const skipped = skip()
    if (skipped) return skipped
    const char = text[at]
    if (expect === 'after') {
      const top = stack.at(-1)
      if (!top) return char === undefined ? { status: 'valid' } : fail('unexpected text after the end')
      if (char === ',') {
        at += 1
        expect = top === 'object' ? 'key' : 'value'
        continue
      }
      if ((top === 'object' && char === '}') || (top === 'array' && char === ']')) {
        at += 1
        stack.pop()
        expect = 'after'
        continue
      }
      return char === undefined ? fail(`unclosed ${top === 'object' ? 'object' : 'array'}`) : fail(top === 'object' ? 'expected , or }' : 'expected , or ]')
    }
    if (expect === 'key' || expect === 'first-key') {
      if (char === '}' && expect === 'first-key') {
        at += 1
        stack.pop()
        expect = 'after'
        continue
      }
      if (char === '}') return fail('unexpected comma', lastComma(text, at))
      if (char !== '"') return char === undefined ? fail('unclosed object') : fail('expected a quoted name')
      const bad = string()
      if (bad) return bad
      const gap = skip()
      if (gap) return gap
      if (text[at] !== ':') return fail('expected :')
      at += 1
      expect = 'value'
      continue
    }
    // A value.
    if (char === ']' && expect === 'first-value') {
      at += 1
      stack.pop()
      expect = 'after'
      continue
    }
    if (char === ']' && stack.at(-1) === 'array') return fail('unexpected comma', lastComma(text, at))
    if (char === undefined) return fail(stack.length === 0 ? 'the file is empty' : 'unexpected end')
    if (char === '{') {
      at += 1
      stack.push('object')
      expect = 'first-key'
      continue
    }
    if (char === '[') {
      at += 1
      stack.push('array')
      expect = 'first-value'
      continue
    }
    if (char === '"') {
      const bad = string()
      if (bad) return bad
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      const bad = number()
      if (bad) return bad
    } else if (text.startsWith('true', at)) {
      at += 4
    } else if (text.startsWith('false', at)) {
      at += 5
    } else if (text.startsWith('null', at)) {
      at += 4
    } else if (char === ',') {
      return fail('unexpected comma')
    } else {
      return fail('unexpected character')
    }
    expect = 'after'
  }
}

/** Where the comma before `at` stands, so a trailing comma is reported on its own line. */
function lastComma(text: string, at: number): number {
  const comma = text.lastIndexOf(',', at)
  return comma === -1 ? at : comma
}

function yamlFault(text: string): SyntaxVerdict {
  const tree = yamlLanguage.parser.parse(text)
  let fault = -1
  tree.iterate({
    enter: (node) => {
      if (fault !== -1) return false
      if (node.type.isError) {
        fault = node.from
        return false
      }
      return undefined
    }
  })
  return fault === -1 ? { status: 'valid' } : { status: 'invalid', line: lineAt(text, fault), message: 'the YAML parser cannot read this' }
}

/**
 * The kinds of fault smol-toml names in fixed words. Its message also carries a code frame of the text, and a date it
 * cannot read relays the date parser's own message, which can quote the value; only a kind on this list is shown.
 */
const TOML_KINDS = new Set([
  'illegal character in numeric literal', 'control characters are not allowed in comments', 'control characters are not allowed in strings',
  'document contains excessively nested structures. aborting.', 'each key-value declaration must be followed by an end-of-line',
  'expected comma or end of structure', 'expected end of table array declaration', 'illegal character in key', 'illegal empty bare key',
  'illegal leading zero', 'illegal quoted key: multiline strings are not allowed', 'illegal underscore', 'incomplete key-value: cannot find end of key',
  'integer value cannot be represented losslessly', 'invalid date', 'invalid date-time: date part is malformed', 'invalid date-time: time part is malformed',
  'invalid escape: only line-ending whitespace may be escaped', 'invalid non-hex character in unicode escape', 'invalid unicode escape', 'invalid value',
  'trying to redefine an already defined value', 'trying to redefine an already defined table or value', 'unexpected end of key', 'unfinished array',
  'unfinished numeric value', 'unfinished string', 'unfinished table', 'unrecognised escape sequence'
])

function tomlFault(text: string): SyntaxVerdict {
  try {
    parseToml(text)
    return { status: 'valid' }
  } catch (error) {
    const line = typeof error === 'object' && error !== null && 'line' in error && typeof error.line === 'number' ? error.line : 1
    const head = error instanceof Error ? (error.message.split('\n')[0] ?? '').replace(/^Invalid TOML document: /u, '') : ''
    return { status: 'invalid', line, message: TOML_KINDS.has(head) ? head.replace(/\. aborting\.$/u, '') : 'the TOML parser cannot read this' }
  }
}

/**
 * The platform's JSON parser decides; when it refuses, the reader above names the line and the kind of fault in words,
 * since the platform's own message can quote the text. `parsed` is the text with comments blanked for JSONC.
 */
function platformJson(text: string, parsed: string, comments: boolean): SyntaxVerdict {
  try {
    JSON.parse(parsed)
    return { status: 'valid' }
  } catch {
    const located = jsonFault(text, comments)
    return located.status === 'invalid' ? located : { status: 'invalid', line: 1, message: 'the JSON parser cannot read this' }
  }
}

/** JSONC with each comment's characters made blanks, line breaks kept, so offsets and lines stay; null for an unclosed comment. */
function withoutComments(text: string): string | null {
  let out = ''
  let at = 0
  while (at < text.length) {
    const char = text[at] as string
    if (char === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
      out += text.slice(at, end + 1)
      at = end + 1
    } else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at)
      const stop = end === -1 ? text.length : end
      out += ' '.repeat(stop - at)
      at = stop
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2)
      if (end === -1) return null
      out += text.slice(at, end + 2).replace(/[^\n]/g, ' ')
      at = end + 2
    } else {
      out += char
      at += 1
    }
  }
  return out
}

/** Parses a draft by its format's own parser (AC5). It says nothing about whether the program that reads the file accepts it. */
export function checkSyntax(format: ConfigFormat, draft: string): SyntaxVerdict {
  // A byte order mark the file begins with is no part of its syntax; it stays on its line, so line numbers hold.
  const text = draft.charCodeAt(0) === 0xfeff ? draft.slice(1) : draft
  switch (format) {
    case 'json': return platformJson(text, text, false)
    case 'jsonc': {
      const blanked = withoutComments(text)
      return blanked === null ? jsonFault(text, true) : platformJson(text, blanked, true)
    }
    case 'yaml': return yamlFault(text)
    case 'toml': return tomlFault(text)
  }
}
