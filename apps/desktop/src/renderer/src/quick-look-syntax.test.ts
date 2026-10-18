// MODULE: quick-look-syntax.test.ts - the syntax line on valid and invalid made-up samples of each format (Story 68.2 AC5)
import { describe, expect, it } from 'vitest'
import { checkSyntax, configFormatOf, syntaxWords } from './quick-look-syntax'

describe('the syntax line', () => {
  it('names the format by the file name', () => {
    expect(['a.json', 'b.JSONC', 'c.yml', 'd.yaml', 'e.toml', 'f.txt'].map(configFormatOf)).toEqual(['json', 'jsonc', 'yaml', 'yaml', 'toml', null])
  })

  it('reads valid samples of each format as valid', () => {
    expect(checkSyntax('json', '{"a": [1, 2, {"b": null}], "c": "x\\u0041"}\n')).toEqual({ status: 'valid' })
    expect(checkSyntax('jsonc', '{\n  // made-up\n  "a": 1, /* note */ "b": "// not a comment"\n}\n')).toEqual({ status: 'valid' })
    expect(checkSyntax('yaml', 'model: made-up/model\nlist:\n  - one\n  - two\n')).toEqual({ status: 'valid' })
    expect(checkSyntax('toml', 'title = "made-up"\n[server]\nport = 8080\n')).toEqual({ status: 'valid' })
  })

  it('names the line and the fault in words, never quoting the text', () => {
    const jsonc = ['{', '  "a": 1,', '  "b": 2,', '}', ''].join('\n')
    const verdict = checkSyntax('jsonc', jsonc)
    expect(verdict).toEqual({ status: 'invalid', line: 3, message: 'unexpected comma' })
    expect(syntaxWords('jsonc', verdict)).toBe('Invalid JSONC · line 3: unexpected comma')
    expect(checkSyntax('json', '{\n  // no comments in JSON\n  "a": 1\n}')).toMatchObject({ status: 'invalid', line: 2 })
    expect(checkSyntax('json', '{"a": "madeupsecret')).toMatchObject({ status: 'invalid', message: 'unclosed string' })
    expect(checkSyntax('yaml', 'a: [1, 2\nb: madeupsecret\n')).toMatchObject({ status: 'invalid' })
    const toml = checkSyntax('toml', 'a = "ok"\nb = = "madeupsecret"\n')
    expect(toml).toMatchObject({ status: 'invalid', line: 2 })
    expect(JSON.stringify(toml)).not.toContain('madeupsecret')
    // A date the parser cannot read relays its own message, which may quote the value: only a fixed kind is shown.
    const date = checkSyntax('toml', 'a = 1\nwhen = 1979-05-27T07:32:00madeupsecret\n')
    expect(date).toMatchObject({ status: 'invalid', line: 2 })
    expect(JSON.stringify(date)).not.toContain('madeupsecret')
    expect(checkSyntax('toml', 'a = "unfinished\n')).toMatchObject({ status: 'invalid', line: 1, message: 'control characters are not allowed in strings' })
    expect(syntaxWords('json', { status: 'valid' })).toBe('Syntax valid')
    expect(checkSyntax('json', `${String.fromCharCode(0xfeff)}{"a": 1}`)).toEqual({ status: 'valid' })
  })
})
