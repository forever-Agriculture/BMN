// MODULE: quick-look-markdown.test.ts - the Markdown page model on a made-up document: every element, raw HTML as text, links that open nothing, images never loaded, and secrets masked in text and code (Story 67.4)
import { describe, expect, it } from 'vitest'
import { findMatches } from './quick-look-find'
import {
  codeLanguage,
  inlineText,
  markdownPage,
  markdownTarget,
  matchesOnPage,
  pageRuns,
  resolveLinkPath,
  runPieces,
  type MarkdownBlock,
  type MarkdownInline
} from './quick-look-markdown'
import { quickLookSecretRanges } from './quick-look-secrets'

const KEY = 'sk-madeupMADEUPmadeup0123456789abcdef'

const DOCUMENT = [
  '---',
  'title: Made-up plan',
  '---',
  '# Made-up plan *now*',
  '',
  'A paragraph with *emphasis*, **strong**, ~~struck~~, `inline code` and a [relative link](src/parser.ts:42:7).',
  '',
  '> A quote that goes on',
  '> over two lines.',
  '',
  '- one',
  '- [x] done task',
  '- [ ] open task',
  '',
  '3. three',
  '4. four',
  '',
  '| Left | Right |',
  '|:-----|------:|',
  '| `a`  | b     |',
  '',
  '---',
  '',
  '```ts',
  'const answer: number = 42',
  '```',
  '',
  '<script>alert(1)</script>',
  '',
  'Raw <b>bold</b> stays text. See [the site](https://example.invalid/page) and [up](#made-up-plan-now).',
  '',
  '![A made-up diagram](images/diagram.png) and ![remote](https://example.invalid/x.png)',
  '',
  `Key: ${KEY}`,
  '',
  '```sh',
  `export TOKEN=${KEY}`,
  '```',
  ''
].join('\n')

const kinds = (blocks: readonly MarkdownBlock[]): string[] => blocks.map((block) => block.kind)

describe('the Markdown page', () => {
  const page = markdownPage(DOCUMENT)

  it('reads every kind of block, a front-matter block as code first', () => {
    expect(kinds(page.blocks)).toEqual(['code', 'heading', 'paragraph', 'quote', 'list', 'list', 'table', 'rule', 'code', 'html', 'paragraph', 'paragraph', 'paragraph', 'code'])
    expect(page.blocks[0]).toMatchObject({ kind: 'code', label: 'front matter', language: 'yaml', run: { text: 'title: Made-up plan' } })
  })

  it('keeps a heading\'s level, anchor and line, counting the front matter\'s lines', () => {
    expect(page.blocks[1]).toMatchObject({ kind: 'heading', level: 1, slug: 'made-up-plan-now', line: 4 })
    expect(page.headings).toEqual([{ slug: 'made-up-plan-now', line: 4, text: 'Made-up plan now' }])
  })

  it('reads emphasis, strong, strike-through, inline code and a link inside a paragraph', () => {
    const paragraph = page.blocks[2] as Extract<MarkdownBlock, { kind: 'paragraph' }>
    expect(paragraph.children.map((inline) => inline.kind)).toEqual(['text', 'em', 'text', 'strong', 'text', 'strike', 'text', 'code', 'text', 'link', 'text'])
    expect(inlineText(paragraph.children)).toBe('A paragraph with emphasis, strong, struck, inline code and a relative link.')
    expect(paragraph.children[9]).toMatchObject({ kind: 'link', target: { kind: 'file', path: 'src/parser.ts', line: 42, column: 7, heading: null } })
  })

  it('reads a quote over two lines without its marks', () => {
    const quote = page.blocks[3] as Extract<MarkdownBlock, { kind: 'quote' }>
    expect(inlineText((quote.blocks[0] as Extract<MarkdownBlock, { kind: 'paragraph' }>).children)).toBe('A quote that goes on\nover two lines.')
  })

  it('reads unordered, task and ordered lists with their start', () => {
    expect(page.blocks[4]).toMatchObject({ kind: 'list', ordered: false, items: [{ task: null }, { task: true }, { task: false }] })
    expect(page.blocks[5]).toMatchObject({ kind: 'list', ordered: true, start: 3 })
  })

  it('reads a table with its alignment, header and rows', () => {
    const table = page.blocks[6] as Extract<MarkdownBlock, { kind: 'table' }>
    expect(table.align).toEqual(['left', 'right'])
    expect(table.header.map(inlineText)).toEqual(['Left', 'Right'])
    expect(table.rows.map((row) => row.map(inlineText))).toEqual([['a', 'b']])
  })

  it('names a code block\'s language by its label', () => {
    expect(page.blocks[8]).toMatchObject({ kind: 'code', label: 'ts', language: 'typescript', run: { text: 'const answer: number = 42' } })
    expect(codeLanguage('bash')).toBe('shell')
    expect(codeLanguage('yml title="x"')).toBe('yaml')
    expect(codeLanguage('brainfuck')).toBeNull()
  })

  it('shows raw HTML and a script tag as their text', () => {
    expect(page.blocks[9]).toMatchObject({ kind: 'html', run: { kind: 'html', text: '<script>alert(1)</script>' } })
    const raw = page.blocks[10] as Extract<MarkdownBlock, { kind: 'paragraph' }>
    expect(raw.children.filter((inline) => inline.kind === 'html').map((inline) => (inline as { text: string }).text)).toEqual(['<b>', '</b>'])
  })

  it('reads an outside link as an address and a heading link as an anchor', () => {
    const raw = page.blocks[10] as Extract<MarkdownBlock, { kind: 'paragraph' }>
    const links = raw.children.filter((inline): inline is Extract<MarkdownInline, { kind: 'link' }> => inline.kind === 'link')
    expect(links.map((link) => link.target)).toEqual([{ kind: 'outside', address: 'https://example.invalid/page' }, { kind: 'heading', slug: 'made-up-plan-now' }])
  })

  it('reads an image as words and a path, local or remote, never as a picture', () => {
    const images = (page.blocks[11] as Extract<MarkdownBlock, { kind: 'paragraph' }>).children.filter((inline) => inline.kind === 'image')
    expect(images).toEqual([
      { kind: 'image', alt: 'A made-up diagram', source: 'images/diagram.png', target: { kind: 'file', path: 'images/diagram.png', line: null, column: null, heading: null } },
      { kind: 'image', alt: 'remote', source: 'https://example.invalid/x.png', target: { kind: 'outside', address: 'https://example.invalid/x.png' } }
    ])
  })

  it('keeps each run at its place in the file', () => {
    for (const run of pageRuns(page)) expect(DOCUMENT.slice(run.from, run.from + run.text.length)).toBe(run.text)
  })
})

describe('links', () => {
  it('reads a line from a path or a GitHub fragment, a heading from any other fragment', () => {
    expect(markdownTarget('docs/a.md#L12')).toEqual({ kind: 'file', path: 'docs/a.md', line: 12, column: null, heading: null })
    expect(markdownTarget('docs/a.md#Setup%20steps')).toEqual({ kind: 'file', path: 'docs/a.md', line: null, column: null, heading: 'setup steps' })
    expect(markdownTarget('mailto:me@example.invalid')).toEqual({ kind: 'outside', address: 'mailto:me@example.invalid' })
    expect(markdownTarget('//cdn.example.invalid/x')).toMatchObject({ kind: 'outside' })
    expect(markdownTarget('')).toEqual({ kind: 'none' })
  })

  it('resolves a relative path from the file\'s folder, never past the root', () => {
    expect(resolveLinkPath('/p/docs', '../src/a.ts')).toBe('/p/src/a.ts')
    expect(resolveLinkPath('/p/docs', './b.md')).toBe('/p/docs/b.md')
    expect(resolveLinkPath('/p', '../../../etc/x')).toBe('/etc/x')
    expect(resolveLinkPath('/p/docs', '/abs/c.md')).toBe('/abs/c.md')
  })
})

describe('masks and find on the page', () => {
  const page = markdownPage(DOCUMENT)
  const ranges = quickLookSecretRanges('/p/plan.md', '/p/plan.md', DOCUMENT)
  const runs = pageRuns(page)

  it('hides a secret-shaped value in text and in a code block as one plate each', () => {
    expect(ranges.map(([start, end]) => DOCUMENT.slice(start, end))).toEqual([KEY, KEY])
    const pieces = runs.flatMap((run) => runPieces(run, [], ranges, null, []))
    expect(pieces.filter((piece) => piece.secret !== null).map((piece) => piece.secret)).toEqual([0, 1])
    expect(pieces.some((piece) => piece.text.includes(KEY))).toBe(false)
    const shown = runs.flatMap((run) => runPieces(run, [], ranges, 1, []))
    expect(shown.filter((piece) => piece.text.includes(KEY))).toHaveLength(1)
  })

  it('cuts a run where colour and matches begin and end, keeping one plate for a value over several tokens', () => {
    const run = { kind: 'code' as const, text: 'let key = SECRETVALUE', from: 100 }
    const pieces = runPieces(run, [{ from: 100, to: 103, className: 'k' }, { from: 110, to: 116, className: 'a' }, { from: 116, to: 121, className: 'b' }], [[110, 121]], null, [{ from: 104, to: 107 }])
    expect(pieces.map((piece) => [piece.text, piece.className, piece.secret, piece.match])).toEqual([
      ['let', 'k', null, null], [' ', null, null, null], ['key', null, null, 0], [' = ', null, null, null], ['', null, 0, null]
    ])
  })

  it('finds only what the page shows: not inside marks, not across them', () => {
    const text = 'Plain **strong** words'
    const shown = pageRuns(markdownPage(text))
    expect(matchesOnPage(findMatches(text, 'strong', false), shown)).toEqual([{ from: 8, to: 14 }])
    expect(matchesOnPage(findMatches(text, '**', false), shown)).toEqual([])
    expect(matchesOnPage(findMatches(text, 'strong** words', false), shown)).toEqual([])
  })
})
