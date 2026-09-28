// MODULE: file-reference.test.ts - the shared file-reference grammar for typed entry and terminal output
import { describe, expect, it } from 'vitest'
import {
  fileReferenceLines,
  findFileReferences,
  formatFileReference,
  exactAbsoluteFileReference,
  parseFileReference,
  hasControlOrFormatCharacter,
  STRIPPED_FORMAT_CHARACTERS,
  stripFormatCharacters,
  type FileReference
} from './file-reference'

function parsed(input: string, mode: 'typed' | 'terminal' = 'typed'): FileReference {
  const result = parseFileReference(input, mode)
  if (!result.ok) throw new Error(`${input} was rejected: ${result.reason}`)
  return result.reference
}

function rejected(input: string, mode: 'typed' | 'terminal' = 'typed'): string {
  const result = parseFileReference(input, mode)
  if (result.ok) throw new Error(`${input} was accepted as ${JSON.stringify(result.reference)}`)
  return result.reason
}

function linked(text: string): string[] {
  return findFileReferences(text).map((match) => match.text)
}

describe('parseFileReference', () => {
  it('accepts the supported forms with separate line and column metadata', () => {
    expect(parsed('src/parser.ts:42:7')).toEqual({ path: 'src/parser.ts', line: 42, column: 7 })
    expect(parsed('/home/me/project/a.ts:3')).toEqual({ path: '/home/me/project/a.ts', line: 3, column: null })
    expect(parsed('./Makefile')).toEqual({ path: './Makefile', line: null, column: null })
    expect(parsed('../shared/x.json')).toEqual({ path: '../shared/x.json', line: null, column: null })
    expect(parsed('README.md')).toEqual({ path: 'README.md', line: null, column: null })
    expect(parsed('  apps/desktop/bin/bmn\n')).toEqual({ path: 'apps/desktop/bin/bmn', line: null, column: null })
  })

  it('keeps quoted paths with spaces whole, with the position inside or after the quotes', () => {
    expect(parsed('"My Notes/plan draft.md":12:4')).toEqual({ path: 'My Notes/plan draft.md', line: 12, column: 4 })
    expect(parsed("'My Notes/plan draft.md:12'")).toEqual({ path: 'My Notes/plan draft.md', line: 12, column: null })
    expect(parsed('/tmp/a folder/b file.txt')).toEqual({ path: '/tmp/a folder/b file.txt', line: null, column: null })
    expect(rejected('"unterminated.txt')).toMatch(/closing quote/)
    expect(rejected('"a b.txt" extra')).toMatch(/line/)
  })

  it('accepts Unicode names', () => {
    expect(parsed('docs/звіт.md:2')).toEqual({ path: 'docs/звіт.md', line: 2, column: null })
    expect(parsed('café/crème.txt')).toEqual({ path: 'café/crème.txt', line: null, column: null })
  })

  it('rejects URIs, expansions, globs, escapes, controls and folders without interpreting them', () => {
    expect(rejected('https://example.com/a.ts')).toMatch(/URLs/)
    expect(rejected('file:///etc/passwd')).toMatch(/URLs/)
    expect(rejected('~/notes.txt')).toMatch(/~ is not expanded/)
    expect(rejected('$HOME/notes.txt')).toMatch(/variables/)
    expect(rejected('src/`whoami`.ts')).toMatch(/substitution/)
    expect(rejected('$(rm -rf x).txt')).toMatch(/variables/)
    expect(rejected('src/*.ts')).toMatch(/Wildcards/)
    expect(rejected('My\\ Notes/a.md')).toMatch(/Backslash/)
    expect(rejected('src/a.ts\u0007')).toMatch(/Control/)
    expect(rejected('a\nb.txt')).toMatch(/Control/)
    // A right-to-left override would make the shown path read differently from the one opened.
    expect(rejected('src/a\u202Egpj.ts')).toMatch(/invisible/)
    expect(rejected('src/')).toMatch(/folder/)
    expect(rejected('..')).toMatch(/folder/)
    expect(rejected('Makefile')).toMatch(/\.\//)
    expect(rejected('')).toMatch(/Enter/)
    expect(rejected('x'.repeat(5000) + '.txt')).toMatch(/too long/)
  })

  it('requires positive bounded positions', () => {
    expect(rejected('src/a.ts:0')).toMatch(/start at 1/)
    expect(rejected('src/a.ts:4:0')).toMatch(/start at 1/)
    expect(rejected('src/a.ts:99999999999')).toMatch(/too large/)
    expect(rejected('src/a.ts:12:x')).toMatch(/colon/)
  })

  it('is stricter for terminal output than for typed text', () => {
    expect(rejected('and/or', 'terminal')).toBeTruthy()
    expect(rejected('e.g', 'terminal')).toBeTruthy()
    expect(rejected('1.2.3', 'terminal')).toBeTruthy()
    expect(rejected('12:30', 'terminal')).toBeTruthy()
    expect(parsed('apps/desktop/bin/bmn', 'terminal').path).toBe('apps/desktop/bin/bmn')
    expect(parsed('/usr/bin/env', 'terminal').path).toBe('/usr/bin/env')
    expect(parsed('bin/bmn.sh', 'terminal').path).toBe('bin/bmn.sh')
  })
})

describe('exactAbsoluteFileReference', () => {
  it('round-trips absolute paths, line and column across the supported filename grammar', () => {
    for (const path of [
      '/tmp/hello world.ts', '/tmp/звіт.md', '/tmp/a[b].ts', '/tmp/a:b.ts',
      "/tmp/a'quote.ts", '/tmp/a"quote.ts'
    ]) {
      const payload = exactAbsoluteFileReference(path, 42, 7)
      expect(payload).not.toBeNull()
      expect(parsed(payload!)).toEqual({ path, line: 42, column: 7 })
    }
    expect(exactAbsoluteFileReference('/tmp/file.ts', null, null)).toBe('/tmp/file.ts')
    expect(exactAbsoluteFileReference('relative/file.ts', 1, null)).toBeNull()
  })

  it('rejects paths the existing grammar cannot represent exactly', () => {
    for (const path of [
      '/tmp/a\u0024b.ts', '/tmp/a`b.ts', '/tmp/a\\b.ts', '/tmp/a*.ts',
      '/tmp/both\'"quotes.ts', '/tmp/a\u0007b.ts', '~/notes.ts', 'file:///tmp/a.ts'
    ]) {
      expect(exactAbsoluteFileReference(path, 1, null)).toBeNull()
    }
    // A trailing numeric filename segment is parsed as a line suffix even when quoted.
    expect(exactAbsoluteFileReference('/tmp/report:42', null, null)).toBeNull()
  })
})

describe('findFileReferences', () => {
  it('finds compiler, stack-trace and agent references with exact offsets', () => {
    const text = 'src/parser.ts:42:7: error TS2345: bad'
    const [match] = findFileReferences(text)
    expect(match).toEqual({
      start: 0,
      end: 'src/parser.ts:42:7'.length,
      text: 'src/parser.ts:42:7',
      reference: { path: 'src/parser.ts', line: 42, column: 7 }
    })
    expect(linked('    at run (/home/me/app/index.js:10:15)')).toEqual(['/home/me/app/index.js:10:15'])
    expect(linked('I updated `src/parser.ts` and README.md.')).toEqual(['src/parser.ts', 'README.md'])
    expect(linked('See (apps/desktop/src/main/index.ts:88), then [docs/voice.md].')).toEqual([
      'apps/desktop/src/main/index.ts:88',
      'docs/voice.md'
    ])
    expect(linked('changed a.ts,b.ts; c.json')).toEqual(['a.ts', 'b.ts', 'c.json'])
    expect(linked('--config=tools/lint.json')).toEqual(['tools/lint.json'])
  })

  it('keeps quoted paths with spaces as one reference', () => {
    expect(linked('wrote "My Notes/plan draft.md":3 today')).toEqual(['"My Notes/plan draft.md":3'])
    expect(linked("Don't touch 'src/a.ts' yet")).toEqual(['src/a.ts'])
  })

  it('leaves prose, URLs, expansions and fragments of longer tokens as plain text', () => {
    expect(linked('input and/or output, e.g. version 1.2.3 at 12:30')).toEqual([])
    expect(linked('open https://example.com/a/b.ts or file:///tmp/x.txt')).toEqual([])
    expect(linked('cat $HOME/notes.txt ~/x.txt')).toEqual([])
    expect(linked('bash-5.2$ ls')).toEqual([])
    expect(linked('user@host:/srv/app/main.ts')).toEqual([])
    // The unquoted spaced path is never combined, and its last word alone would be a guessed target.
    expect(linked('My Notes/plan draft.md')).toEqual([])
    expect(linked('wrote draft.md and plan.md')).toEqual(['draft.md', 'plan.md'])
    // Punctuation or a tab ends a path, so the name after it is its own reference.
    expect(linked('I updated src/parser.ts, README.md and docs/x.md')).toEqual(['src/parser.ts', 'README.md', 'docs/x.md'])
    expect(linked('wrote src/a.ts\tb.ts')).toEqual(['src/a.ts', 'b.ts'])
    expect(linked('a\\b/c.txt')).toEqual([])
    expect(linked('src/parser.ts:0 and src/lib/')).toEqual([])
  })

  it('handles Unicode text around and inside references', () => {
    const text = 'Готово: docs/звіт.md:4 ✓'
    const [match] = findFileReferences(text)
    expect(match?.text).toBe('docs/звіт.md:4')
    expect(text.slice(match!.start, match!.end)).toBe('docs/звіт.md:4')
  })
})

describe('fileReferenceLines and formatFileReference', () => {
  it('splits lines without inventing a final empty line', () => {
    expect(fileReferenceLines('')).toEqual([])
    expect(fileReferenceLines('a\nb\n')).toEqual(['a', 'b'])
    expect(fileReferenceLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
    expect(fileReferenceLines('\n')).toEqual([''])
  })

  it('formats a copy that parses back to the same file and position', () => {
    expect(formatFileReference('/p/src/a.ts', 42, 7)).toBe('/p/src/a.ts:42:7')
    expect(formatFileReference('/p/a.ts', null, null)).toBe('/p/a.ts')
    const spaced = formatFileReference('/p/My Notes/a b.md', 3, null)
    expect(spaced).toBe('"/p/My Notes/a b.md":3')
    expect(parsed(spaced)).toEqual({ path: '/p/My Notes/a b.md', line: 3, column: null })
  })
})

describe('stripFormatCharacters (Story 34.1)', () => {
  it('removes a right-to-left override that would make a title read backwards', () => {
    expect(stripFormatCharacters('Approve ‮txt.exe‬ now')).toBe('Approve txt.exe now')
  })

  it('removes directional isolates and marks', () => {
    expect(stripFormatCharacters('⁦from main⁩ ‎ok‏ ؜fine')).toBe('from main ok fine')
  })

  it('removes zero-width spaces and byte-order marks inside words', () => {
    expect(stripFormatCharacters('pass​word ﻿reset⁠ ⁤done')).toBe('password reset done')
  })

  it('keeps the joiners emoji and Persian need, and every letter and emoji', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const flag = '\u{1F1FA}\u{1F1E6}'
    const persian = 'می‌خواهم'
    for (const text of [family, flag, persian, 'مرحبا بالعالم', 'שלום עולם', 'Ωμέγα', '漢字']) {
      expect(stripFormatCharacters(text)).toBe(text)
    }
  })

  it('removes exactly the named set, which leaves both joiners out', () => {
    const named = STRIPPED_FORMAT_CHARACTERS.flatMap(([from, to]) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index))
    expect(named.map((code) => code.toString(16))).toEqual([
      '61c', '200b', '200e', '200f', '202a', '202b', '202c', '202d', '202e',
      '2060', '2061', '2062', '2063', '2064', '2066', '2067', '2068', '2069', 'feff'
    ])
    for (const code of named) expect(stripFormatCharacters(`a${String.fromCodePoint(code)}b`)).toBe('ab')
    expect(stripFormatCharacters('a‌b‍b')).toBe('a‌b‍b')
  })

  it('leaves the file-reference rejection as it was', () => {
    expect(hasControlOrFormatCharacter('/tmp/‮txt.sh')).toBe(true)
    expect(hasControlOrFormatCharacter('/tmp/a‍b')).toBe(true)
  })
})
