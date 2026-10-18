// MODULE: quick-look-page.test.ts - the Markdown page as drawn, on made-up secrets: an image's words and source, a code block's label and a link's address are masked as text is, the address leaves only masked, no entity breaks the page, and a page dense with values is cut into pieces in one pass (Story 67.3, 67.4)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@bmn/protocol'
import { markdownPage, runPieces, type MarkdownRun, type RunPiece } from './quick-look-markdown'
import { MarkdownPageView, holdingLine, maskedSource } from './quick-look-page'
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

describe('the line he came for', () => {
  it('marks the block that holds it: a paragraph line, an item of a list, a line of a quote', () => {
    const text = ['# Head', '', 'Line one.', 'Line two.', 'Line three.', '', '- item a', '- item b', '', '> quoted', '> more', ''].join('\n')
    const page = markdownPage(text)
    expect([5, 8, 11, 1, 2].map((line) => holdingLine(page.blocks, line))).toEqual([3, 8, 10, 1, 1])
    const markup = renderToStaticMarkup(createElement(MarkdownPageView, {
      page, path: '/p/plan.md', ranges: [], revealed: null, secondsLeft: 10, matches: [], current: -1, line: 5, heading: null, topLine: null, focus: false, status: '',
      onStatus: () => undefined, onReveal: () => undefined, onTop: () => undefined, onOpenFile: () => undefined, onAddress: () => undefined, onFocus: () => undefined
    }))
    expect(markup).toContain(`<p data-line="3" class="ql-target"><span>Line one.`)
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

describe('a page dense with hidden values', () => {
  /** The cutting as it was: every range, token and match looked at for every run and every piece. */
  function piecesBefore(run: MarkdownRun, tokens: readonly { from: number; to: number; className: string }[], ranges: readonly [number, number][], revealed: number | null, matches: readonly { from: number; to: number }[]): RunPiece[] {
    const start = run.from
    const end = run.from + run.text.length
    const cuts = new Set<number>([start, end])
    const hidden: { from: number; to: number; index: number }[] = []
    ranges.forEach(([from, to], index) => {
      if (index === revealed || to <= start || from >= end) return
      hidden.push({ from: Math.max(from, start), to: Math.min(to, end), index })
    })
    for (const token of tokens) { cuts.add(Math.max(start, token.from)); cuts.add(Math.min(end, token.to)) }
    matches.forEach((match) => { if (match.to > start && match.from < end) { cuts.add(Math.max(start, match.from)); cuts.add(Math.min(end, match.to)) } })
    for (const each of hidden) { cuts.add(each.from); cuts.add(each.to) }
    const points = [...cuts].filter((at) => at >= start && at <= end).sort((a, b) => a - b)
    const pieces: RunPiece[] = []
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index]!
      const to = points[index + 1]!
      if (to <= from) continue
      const secret = hidden.find((each) => each.from <= from && to <= each.to)
      if (secret) {
        if (pieces[pieces.length - 1]?.secret !== secret.index) pieces.push({ text: '', from: secret.from, className: null, secret: secret.index, match: null })
        continue
      }
      const token = tokens.find((each) => each.from <= from && to <= each.to)
      const match = matches.findIndex((each) => each.from <= from && to <= each.to)
      pieces.push({ text: run.text.slice(from - start, to - start), from, className: token?.className ?? null, secret: null, match: match === -1 ? null : match })
    }
    return pieces
  }

  /** Lines of made-up values, words and matches, as runs of their own, with ordered tokens, ranges and matches over them. */
  function made(lines: number, seed: number): { text: string; runs: MarkdownRun[]; tokens: { from: number; to: number; className: string }[]; matches: { from: number; to: number }[] } {
    let state = seed
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state
    }
    const words = ['plain', 'token=', `sk-madeup${'q'.repeat(20)}`, 'needle', 'more words', 'password: madeupvalue1', ' ']
    let text = ''
    const runs: MarkdownRun[] = []
    for (let line = 0; line < lines; line += 1) {
      let body = ''
      for (let count = 1 + (next() % 8); count > 0; count -= 1) body += `${words[next() % words.length]} `
      runs.push({ kind: 'text', text: body, from: text.length })
      text += `${body}\n`
    }
    const tokens: { from: number; to: number; className: string }[] = []
    for (let at = 0; at + 6 < text.length; at += 11) tokens.push({ from: at, to: at + 5, className: 'tok' })
    const matches: { from: number; to: number }[] = []
    for (let at = text.indexOf('needle'); at !== -1; at = text.indexOf('needle', at + 1)) matches.push({ from: at, to: at + 6 })
    return { text, runs, tokens, matches }
  }

  it('cuts every run as before: the same pieces, hidden values once each, tokens and matches where they stand', () => {
    for (const seed of [1, 2, 3]) {
      const { text, runs, tokens, matches } = made(300, seed)
      const ranges = quickLookSecretRanges('/p/plan.md', '/p/plan.md', text)
      for (const revealed of [null, 0, 7]) {
        for (const run of runs) expect(runPieces(run, tokens, ranges, revealed, matches)).toEqual(piecesBefore(run, tokens, ranges, revealed, matches))
      }
      for (const run of runs.slice(0, 50)) expect(maskedSource(run.text, run.from, ranges)).toBe(piecesBefore(run, [], ranges, null, []).map((piece) => piece.secret === null ? piece.text : SECRET_MASK).join(''))
    }
  })

  it('takes tens of milliseconds for half a megabyte of lines dense with values, tokens and matches, not seconds', () => {
    const { text, runs, tokens, matches } = made(33_000, 9)
    expect(text.length).toBeGreaterThan(448 * 1024)
    const ranges = quickLookSecretRanges('/p/plan.md', '/p/plan.md', text)
    expect(ranges.length).toBeGreaterThan(5_000)
    const started = performance.now()
    for (const run of runs) {
      runPieces(run, tokens, ranges, null, matches)
      maskedSource(run.text, run.from, ranges)
    }
    // Every range, token and match looked at for every run and piece, as before: 154 s here (measured once).
    expect(performance.now() - started).toBeLessThan(400)
  })
})
