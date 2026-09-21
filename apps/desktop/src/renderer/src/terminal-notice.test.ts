// MODULE: terminal-notice.test.ts - the three terminal notification formats, and everything that is not one
import { describe, expect, it } from 'vitest'
import { parseTerminalNotice } from './terminal-notice'

describe('parseTerminalNotice', () => {
  it('reads an OSC 9 message as the whole notice', () => {
    expect(parseTerminalNotice(9, 'Build finished')).toEqual({ title: 'Build finished' })
  })

  it('keeps a multi-line OSC 9 message whole and takes its first line as the title', () => {
    expect(parseTerminalNotice(9, 'Build finished\n3 warnings\n0 errors')).toEqual({
      title: 'Build finished',
      body: 'Build finished\n3 warnings\n0 errors'
    })
  })

  it('reads OSC 777 notify as a title and a body, and ignores any other first field', () => {
    expect(parseTerminalNotice(777, 'notify;Deploy;staging is live')).toEqual({
      title: 'Deploy',
      body: 'staging is live'
    })
    expect(parseTerminalNotice(777, 'precmd;Deploy;staging is live')).toBeNull()
  })

  it('keeps every semicolon after the first two in an OSC 777 body', () => {
    expect(parseTerminalNotice(777, 'notify;Run;a;b;c')).toEqual({ title: 'Run', body: 'a;b;c' })
  })

  it('drops OSC 99 metadata and keeps only the payload', () => {
    expect(parseTerminalNotice(99, 'i=1:d=0:p=title;Tests passed')).toEqual({ title: 'Tests passed' })
    expect(parseTerminalNotice(99, ';Tests passed')).toEqual({ title: 'Tests passed' })
  })

  it('reads an OSC 99 payload with no metadata field at all', () => {
    expect(parseTerminalNotice(99, 'Tests passed')).toEqual({ title: 'Tests passed' })
  })

  it('strips control characters and folds a title onto one line', () => {
    expect(parseTerminalNotice(9, 'Build\u0007 finished\u001b')).toEqual({ title: 'Build finished' })
    expect(parseTerminalNotice(777, 'notify;Two\tlines\nhere;body')).toEqual({
      title: 'Two lines here',
      body: 'body'
    })
  })

  it('returns null for an empty payload and for one that is only control characters', () => {
    expect(parseTerminalNotice(9, '')).toBeNull()
    expect(parseTerminalNotice(9, '\u0000\u0007 ')).toBeNull()
    expect(parseTerminalNotice(777, 'notify;;')).toBeNull()
    expect(parseTerminalNotice(99, 'i=1;')).toBeNull()
  })

  it('caps an oversize title and body without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(400)}\n${'b'.repeat(9000)}`
    const parsed = parseTerminalNotice(9, long)

    expect(parsed?.title).toHaveLength(200)
    expect(parsed?.title.endsWith('…')).toBe(true)
    expect(parsed?.body).toHaveLength(8000)
    // The cut falls between the emoji's two halves, so the whole emoji goes rather than half of it.
    const emoji = parseTerminalNotice(9, `${'x'.repeat(198)}😀${'z'.repeat(10)}`)
    expect(emoji?.title).toBe(`${'x'.repeat(198)}…`)
  })

  it('takes a 777 body that is only whitespace as no body at all', () => {
    expect(parseTerminalNotice(777, 'notify;Title;   ')).toEqual({ title: 'Title' })
  })
})
