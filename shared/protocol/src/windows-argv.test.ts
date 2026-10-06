import { describe, expect, it } from 'vitest'
import { quoteWindowsArgv, splitWindowsArgv } from './windows-argv'

describe('Windows argument serialization', () => {
  it.each([
    ['C:\\folder\\file', 'C:\\with space\\', ''],
    ['"quoted spaces"', 'a"b', 'a\\"b', 'a\\\\"b'],
    ['雪', '%PATH%', '^&', '!literal!', "it's", '(a);b|c'],
    ['a\tb', 'a\nb', '\\', '\\\\', '"']
  ])('round-trips literal values %j', (...argv) => {
    expect(splitWindowsArgv(quoteWindowsArgv(argv))).toEqual(argv)
  })

  it('reads Windows path separators and groups double-quoted spaces', () => {
    expect(splitWindowsArgv('C:\\work\\file "two words" ""')).toEqual(['C:\\work\\file', 'two words', ''])
    expect(splitWindowsArgv('"a""b"')).toEqual(['a"b'])
    expect(splitWindowsArgv("'a b'")).toEqual(["'a", "b'"])
  })

  it('refuses embedded NUL instead of launching a truncated command', () => {
    expect(() => quoteWindowsArgv(['a\0b'])).toThrow('NUL')
    expect(() => splitWindowsArgv('a\0b')).toThrow('NUL')
  })
})
