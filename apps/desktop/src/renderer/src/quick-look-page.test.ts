// MODULE: quick-look-page.test.ts - the Markdown page as drawn, on made-up secrets: an image's words and source, a code block's label and a link's address are masked as text is, the address leaves only masked, and no entity breaks the page (Story 67.3, 67.4)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@bmn/protocol'
import { markdownPage } from './quick-look-markdown'
import { MarkdownPageView, maskedSource } from './quick-look-page'
import { quickLookSecretRanges } from './quick-look-secrets'

const KEY = 'sk-madeupPAGEmadeup0123456789abcdef'
const DOCUMENT = [
  '# Made-up page',
  '',
  `![alt ${KEY}](images/${KEY}.png) and ![remote](https://example.invalid/x.png?token=${KEY})`,
  '',
  `[a link](https://example.invalid/?key=${KEY}) and [defined][ref]`,
  '',
  `\`\`\`sh ${KEY}`,
  'echo made-up',
  '```',
  '',
  `[ref]: https://example.invalid/r/${KEY}`,
  ''
].join('\n')

function draw(text: string, revealed: number | null = null): string {
  const page = markdownPage(text)
  return renderToStaticMarkup(createElement(MarkdownPageView, {
    page, path: '/p/plan.md', ranges: quickLookSecretRanges('/p/plan.md', '/p/plan.md', text), revealed, secondsLeft: 10,
    matches: [], current: -1, line: null, heading: null, topLine: null, focus: false, status: '',
    onStatus: () => undefined, onReveal: () => undefined, onTop: () => undefined, onOpenFile: () => undefined, onAddress: () => undefined, onFocus: () => undefined
  }))
}

describe('the page hides every value the rule finds', () => {
  it('in an image\'s words and source and a code block\'s label: the drawn page holds no value', () => {
    const ranges = quickLookSecretRanges('/p/plan.md', '/p/plan.md', DOCUMENT)
    expect(ranges.length).toBeGreaterThanOrEqual(5)
    const markup = draw(DOCUMENT)
    expect(markup).not.toContain(KEY)
    expect(markup).toContain('hidden value')
    expect(markup).toContain(SECRET_MASK)
  })

  it('lets an address leave only masked, unless the value in it is the one revealed', () => {
    const text = `see https://example.invalid/?key=${KEY} here`
    const ranges = quickLookSecretRanges('/p/plan.md', '/p/plan.md', text)
    const from = text.indexOf('https')
    const address = text.slice(from, text.indexOf(' here'))
    expect(maskedSource(address, from, ranges)).toBe(`https://example.invalid/?key=${SECRET_MASK}`)
    expect(maskedSource(address, from, ranges, 0)).toBe(address)
    expect(maskedSource(address, -1, ranges)).toBe(address)
  })
})

describe('entities', () => {
  it('draws a numeric entity past U+10FFFF, a surrogate or zero as U+FFFD and never throws', () => {
    const text = 'a &#1114112; b &#x110000; c &#xD800; d &#0; e &#x41;'
    expect(() => markdownPage(text)).not.toThrow()
    const markup = draw(text)
    expect(markup.match(/\uFFFD/gu)).toHaveLength(4)
    expect(markup).toContain('<span>A</span>')
  })
})
