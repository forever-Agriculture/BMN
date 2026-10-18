// MODULE: quick-look-env.test.ts - the .env rows and the draft written back byte for byte, on made-up values (Story 68.1)
import { describe, expect, it } from 'vitest'
import { ENV_UNSAFE_VALUE, envFileText, envNameProblem, readEnvFile, readersOf, writtenValue, type EnvModel } from './quick-look-env'

const rows = (text: string): Extract<EnvModel, { status: 'rows' }> => {
  const model = readEnvFile(text)
  if (model.status !== 'rows') throw new Error(model.reason)
  return model
}

describe('reading a .env file', () => {
  it('reads comments, blank lines, export, bare, single- and double-quoted values and trailing comments', () => {
    const text = '# made-up\n\nexport API_KEY=madeup-1\nNAME=\'two words\' # note\nOTHER="x y"\nEMPTY=\n  SPACED = value  # c\n'
    const model = rows(text)
    expect(model.keys).toBe(5)
    expect(model.rows.map((row) => row.kind)).toEqual(['comment', 'blank', 'key', 'key', 'key', 'key', 'key'])
    const keys = model.rows.flatMap((row) => row.kind === 'key' ? [[row.name, row.value, row.quote, text.slice(row.valueFrom, row.valueTo)]] : [])
    expect(keys).toEqual([
      ['API_KEY', 'madeup-1', 'none', 'madeup-1'],
      ['NAME', 'two words', 'single', "'two words'"],
      ['OTHER', 'x y', 'double', '"x y"'],
      ['EMPTY', '', 'none', ''],
      ['SPACED', 'value', 'none', 'value']
    ])
  })

  it('keeps a double-quoted value with an escaped quote as one value', () => {
    const model = rows('A="say \\"hi\\""\n')
    expect(model.rows[0]).toMatchObject({ kind: 'key', value: 'say \\"hi\\"', quote: 'double' })
  })

  it('makes a file read-only, with the reason, for a multi-line value, a name given twice or a line that is neither', () => {
    expect(readEnvFile('A="one\ntwo"\n')).toEqual({ status: 'read-only', reason: 'Read-only · this file has a multi-line value' })
    expect(readEnvFile('A=1\nA=2\n')).toEqual({ status: 'read-only', reason: 'Read-only · this file names a key twice' })
    expect(readEnvFile('A=1\njust words\n')).toEqual({ status: 'read-only', reason: 'Read-only · line 2 is not NAME=value' })
    expect(readEnvFile("A='x' trailing\n")).toEqual({ status: 'read-only', reason: 'Read-only · line 1 is not NAME=value' })
  })

  it('tells the line ending and whether the last line ends', () => {
    expect(rows('A=1\r\nB=2\r\n')).toMatchObject({ lineEnding: '\r\n', finalNewline: true })
    expect(rows('A=1\nB=2')).toMatchObject({ lineEnding: '\n', finalNewline: false })
  })
})

describe('writing a value (AC4)', () => {
  it('keeps the old quoting when the value fits it', () => {
    expect(writtenValue('madeup.2', 'none')).toEqual({ status: 'written', text: 'madeup.2' })
    expect(writtenValue('two words', 'single')).toEqual({ status: 'written', text: "'two words'" })
    expect(writtenValue('two words', 'double')).toEqual({ status: 'written', text: '"two words"' })
  })

  it('falls back to bare, then single quotes, and refuses anything else', () => {
    expect(writtenValue('a/b:c=d+e@f%g', 'double')).toEqual({ status: 'written', text: '"a/b:c=d+e@f%g"' })
    expect(writtenValue('has $dollar', 'double')).toEqual({ status: 'written', text: "'has $dollar'" })
    expect(writtenValue('it\'s "both"', 'none')).toEqual({ status: 'refused', message: ENV_UNSAFE_VALUE })
    expect(writtenValue('two words', 'none')).toEqual({ status: 'written', text: "'two words'" })
    expect(writtenValue("it's", 'single')).toEqual({ status: 'refused', message: ENV_UNSAFE_VALUE })
    expect(writtenValue('#hash', 'none')).toEqual({ status: 'written', text: "'#hash'" })
    expect(writtenValue('line\nbreak', 'single')).toEqual({ status: 'refused', message: ENV_UNSAFE_VALUE })
  })
})

describe('the saved text (AC7)', () => {
  it('differs only in the changed values: comments, order, blank lines, CRLF and the missing final newline stay', () => {
    const text = '# keys\r\n\r\nexport A=old-1\r\nB="old two" # keep\r\nC=3'
    const model = rows(text)
    const saved = envFileText(text, model, { changed: new Map([[3, 'madeup-new'], [4, 'new two']]), added: [] })
    expect(saved).toEqual({ status: 'ready', text: '# keys\r\n\r\nexport A=madeup-new\r\nB="new two" # keep\r\nC=3' })
  })

  it('adds a key at the end in the file\'s line ending, keeping a final newline or its absence', () => {
    const add = { changed: new Map<number, string>(), added: [{ name: 'NEW_KEY', value: 'madeup' }] }
    expect(envFileText('A=1\n', rows('A=1\n'), add)).toEqual({ status: 'ready', text: 'A=1\nNEW_KEY=madeup\n' })
    expect(envFileText('A=1', rows('A=1'), add)).toEqual({ status: 'ready', text: 'A=1\nNEW_KEY=madeup' })
    expect(envFileText('A=1\r\n', rows('A=1\r\n'), add)).toEqual({ status: 'ready', text: 'A=1\r\nNEW_KEY=madeup\r\n' })
    expect(envFileText('', rows(''), add)).toEqual({ status: 'ready', text: 'NEW_KEY=madeup\n' })
  })

  it('refuses the whole save when one value cannot be written, naming its line', () => {
    const text = 'A=1\nB=2\n'
    expect(envFileText(text, rows(text), { changed: new Map([[2, 'it\'s "x"']]), added: [] })).toEqual({ status: 'refused', message: ENV_UNSAFE_VALUE, line: 2 })
  })
})

describe('names and readers', () => {
  it('takes a new name of letters, digits and underscore, not starting with a digit, not one the file has', () => {
    expect(envNameProblem('NEW_1', ['A'])).toBeNull()
    expect(envNameProblem('1NEW', [])).not.toBeNull()
    expect(envNameProblem('NEW-KEY', [])).not.toBeNull()
    expect(envNameProblem('A', ['A'])).toBe('This file already has that name')
  })

  it('says who may read a file in words', () => {
    expect(readersOf(0o600)).toBe('owner only')
    expect(readersOf(0o640)).toBe('owner and group')
    expect(readersOf(0o644)).toBe('everyone on this computer')
  })
})
