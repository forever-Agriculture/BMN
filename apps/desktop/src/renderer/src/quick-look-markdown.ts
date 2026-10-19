// MODULE: quick-look-markdown.ts - a Markdown file as a page model, read from the parser's tree and never from an HTML string; each run of text keeps its place in the file, so masks, find and lines are the source's (Story 67.4)
import { GFM, parser as markdownParser } from '@lezer/markdown'
import { parseFileReference, type QuickLookLanguage, type SecretRange } from '@bmn/protocol'
import type { FindMatch } from './quick-look-find'

/** A Markdown file larger than this opens as source, with one line saying why. */
export const MARKDOWN_PAGE_MAX_BYTES = 512 * 1024

const parser = markdownParser.configure(GFM)
type SyntaxNode = ReturnType<typeof parser.parse>['topNode']

/** Where a link or an image leads. Nothing here opens a browser: an outside address is only shown and copied. */
export type MarkdownTarget =
  | { kind: 'outside'; address: string }
  | { kind: 'heading'; slug: string }
  | { kind: 'file'; path: string; line: number | null; column: number | null; heading: string | null }
  | { kind: 'none' }

/** A run of the file's own text; `from` is where it starts in the file, or -1 for text the page made (an entity). */
export interface MarkdownRun {
  kind: 'text' | 'code' | 'html'
  text: string
  from: number
}

export type MarkdownInline =
  | MarkdownRun
  | { kind: 'em' | 'strong' | 'strike'; children: MarkdownInline[] }
  // An address, an image's words and its source keep where they start in the file (-1 when none), so masks reach them.
  | { kind: 'link'; target: MarkdownTarget; address: string; addressFrom: number; children: MarkdownInline[] }
  | { kind: 'image'; alt: string; altFrom: number; source: string; sourceFrom: number; target: MarkdownTarget }
  | { kind: 'break' }

interface MarkdownListItem {
  /** A task's box: checked or not; null for an item that is no task. */
  task: boolean | null
  blocks: MarkdownBlock[]
}

type MarkdownAlign = 'left' | 'center' | 'right' | null

export type MarkdownBlock =
  | { kind: 'heading'; line: number; level: 1 | 2 | 3 | 4 | 5 | 6; slug: string; children: MarkdownInline[] }
  | { kind: 'paragraph'; line: number; children: MarkdownInline[] }
  | { kind: 'code'; line: number; label: string; labelFrom: number; language: QuickLookLanguage | null; run: MarkdownRun }
  | { kind: 'quote'; line: number; blocks: MarkdownBlock[] }
  | { kind: 'list'; line: number; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'table'; line: number; align: MarkdownAlign[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { kind: 'rule'; line: number }
  | { kind: 'html'; line: number; run: MarkdownRun }

export interface MarkdownPage {
  blocks: MarkdownBlock[]
  /** Every heading's slug and line, for a link to a heading and for a heading named by a link from another file. */
  headings: { slug: string; line: number; text: string }[]
}

const CODE_LABELS: Record<string, QuickLookLanguage> = {
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', javascript: 'javascript',
  mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', json: 'json', jsonc: 'jsonc', json5: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', markdown: 'markdown', css: 'css', html: 'html', xml: 'html', svg: 'html', py: 'python', python: 'python', rs: 'rust',
  rust: 'rust', go: 'go', golang: 'go', sql: 'sql', sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell',
  dockerfile: 'dockerfile', docker: 'dockerfile', diff: 'diff', patch: 'diff'
}

/** The language a code block's label names, by its first word; null draws it plain. */
export function codeLanguage(label: string): QuickLookLanguage | null {
  return CODE_LABELS[label.trim().split(/[\s{]/u)[0]?.toLowerCase() ?? ''] ?? null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' }

function entityText(source: string): string {
  const body = source.slice(1, -1)
  const hex = body.startsWith('#x') || body.startsWith('#X')
  if (hex || body.startsWith('#')) {
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    // Only a Unicode scalar value is a character; zero, a surrogate or anything past U+10FFFF reads as U+FFFD.
    return String.fromCodePoint(Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? code : 0xfffd)
  }
  return ENTITIES[body] ?? source
}

/** GitHub's heading anchor: small letters, spaces to dashes, punctuation dropped; repeats get -1, -2. */
function headingSlug(text: string, taken: Map<string, number>): string {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-')
  const count = taken.get(base) ?? 0
  taken.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

/** The page's plain text of some inlines, for a heading's anchor and an image's words. */
export function inlineText(inlines: readonly MarkdownInline[]): string {
  return inlines.map((inline) => {
    switch (inline.kind) {
      case 'text': case 'code': case 'html': return inline.text
      case 'em': case 'strong': case 'strike': case 'link': return inlineText(inline.children)
      case 'image': return inline.alt
      case 'break': return ' '
    }
  }).join('')
}

/** Where a link's address leads, read without opening anything. */
export function markdownTarget(address: string): MarkdownTarget {
  const href = address.trim()
  if (!href) return { kind: 'none' }
  if (href.startsWith('#')) return { kind: 'heading', slug: safeDecode(href.slice(1)).toLowerCase() }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//')) return { kind: 'outside', address: href }
  const hash = href.indexOf('#')
  const pathPart = safeDecode(hash === -1 ? href : href.slice(0, hash))
  const fragment = hash === -1 ? '' : safeDecode(href.slice(hash + 1))
  const lines = /^L(\d+)(?:C(\d+))?(?:-L?\d+)?$/u.exec(fragment)
  const parsed = parseFileReference(pathPart)
  const reference = parsed.ok ? parsed.reference : { path: pathPart, line: null, column: null }
  return {
    kind: 'file',
    path: reference.path,
    line: lines ? Number(lines[1]) : reference.line,
    column: lines?.[2] ? Number(lines[2]) : reference.column,
    heading: fragment && !lines ? fragment.toLowerCase() : null
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** A path a link names, from the folder of the file it is written in; `..` steps out, never past the root. */
export function resolveLinkPath(fileDirectory: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${fileDirectory}/${path}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'HeaderMark', 'ListMark', 'TaskMarker', 'TableDelimiter'])

class Reader {
  private readonly lineStarts: number[] = [0]
  readonly references = new Map<string, { address: string; from: number }>()
  readonly headings: MarkdownPage['headings'] = []
  private readonly slugs = new Map<string, number>()

  /** Lines before this reader's text, when it begins after a front-matter block. */
  baseLines = 0

  constructor(readonly source: string) {
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) this.lineStarts.push(index + 1)
  }

  /** The 1-based line of a place in the file. */
  line(at: number): number {
    let low = 0
    let high = this.lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.lineStarts[middle]! <= at) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  slice(from: number, to: number): string {
    return this.source.slice(from, to)
  }

  run(kind: MarkdownRun['kind'], from: number, to: number): MarkdownRun {
    return { kind, text: this.slice(from, to), from }
  }

  /** The inlines between `from` and `to` of a node: its text, with its marks left out. */
  inlines(node: SyntaxNode, from = node.from, to = node.to): MarkdownInline[] {
    const out: MarkdownInline[] = []
    let at = from
    const text = (end: number): void => {
      if (end > at) out.push(this.run('text', at, end))
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue
      text(child.from)
      at = child.to
      switch (child.name) {
        case 'QuoteMark':
          // A quote's mark at the start of a continued line, and the one space after it.
          if (this.source[at] === ' ') at += 1
          break
        case 'Emphasis': out.push({ kind: 'em', children: this.inlines(child) }); break
        case 'StrongEmphasis': out.push({ kind: 'strong', children: this.inlines(child) }); break
        case 'Strikethrough': out.push({ kind: 'strike', children: this.inlines(child) }); break
        case 'InlineCode': out.push(this.inlineCode(child)); break
        case 'Link': out.push(this.link(child)); break
        case 'Image': out.push(this.image(child)); break
        case 'Autolink': {
          const url = child.getChild('URL')
          const address = url ? this.slice(url.from, url.to) : ''
          out.push({ kind: 'link', target: markdownTarget(address), address, addressFrom: url ? url.from : -1, children: url ? [this.run('text', url.from, url.to)] : [] })
          break
        }
        case 'URL': {
          const address = this.slice(child.from, child.to)
          out.push({ kind: 'link', target: markdownTarget(address), address, addressFrom: child.from, children: [this.run('text', child.from, child.to)] })
          break
        }
        case 'Escape': out.push(this.run('text', child.from + 1, child.to)); break
        case 'Entity': out.push({ kind: 'text', text: entityText(this.slice(child.from, child.to)), from: -1 }); break
        case 'HardBreak': out.push({ kind: 'break' }); break
        case 'HTMLTag': case 'Comment': case 'ProcessingInstruction': out.push(this.run('html', child.from, child.to)); break
        default:
          if (!MARKS.has(child.name)) out.push(this.run('text', child.from, child.to))
      }
    }
    text(to)
    return out
  }

  inlineCode(node: SyntaxNode): MarkdownRun {
    const marks = node.getChildren('CodeMark')
    let from = marks[0]?.to ?? node.from
    let to = marks[1]?.from ?? node.to
    // One space inside each backtick is padding, when both are there and the code is not only spaces.
    if (to - from >= 2 && this.source[from] === ' ' && this.source[to - 1] === ' ' && this.slice(from, to).trim()) {
      from += 1
      to -= 1
    }
    return this.run('code', from, to)
  }

  /** A link's words are between its first two marks; its address is a URL, or a label defined elsewhere. */
  link(node: SyntaxNode): MarkdownInline {
    const marks = node.getChildren('LinkMark')
    const open = marks[0]?.to ?? node.from
    const close = marks[1]?.from ?? node.to
    const url = node.getChild('URL')
    const label = node.getChild('LinkLabel')
    const defined = url ? { address: this.slice(url.from, url.to), from: url.from }
      : this.references.get(normalLabel(label ? this.slice(label.from + 1, label.to - 1) : this.slice(open, close))) ?? { address: '', from: -1 }
    return { kind: 'link', target: markdownTarget(defined.address), address: defined.address, addressFrom: defined.from, children: this.inlines(node, open, close) }
  }

  image(node: SyntaxNode): MarkdownInline {
    const marks = node.getChildren('LinkMark')
    const url = node.getChild('URL')
    const source = url ? this.slice(url.from, url.to) : ''
    const altFrom = marks[0]?.to ?? node.from
    return { kind: 'image', alt: this.slice(altFrom, marks[1]?.from ?? node.to), altFrom, source, sourceFrom: url ? url.from : -1, target: markdownTarget(source) }
  }

  blocks(parent: SyntaxNode): MarkdownBlock[] {
    const out: MarkdownBlock[] = []
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      const block = this.block(node)
      if (block) out.push(block)
    }
    return out
  }

  block(node: SyntaxNode): MarkdownBlock | null {
    const line = this.line(node.from) + this.baseLines
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/u.exec(node.name)
    if (heading) {
      const children = trimInlines(this.inlines(node))
      const text = inlineText(children)
      const slug = headingSlug(text, this.slugs)
      this.headings.push({ slug, line, text })
      return { kind: 'heading', line, level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6, slug, children }
    }
    switch (node.name) {
      case 'Paragraph': return { kind: 'paragraph', line, children: trimInlines(this.inlines(node)) }
      case 'FencedCode': {
        const info = node.getChild('CodeInfo')
        const label = info ? this.slice(info.from, info.to) : ''
        const code = node.getChild('CodeText')
        return { kind: 'code', line, label, labelFrom: info ? info.from : -1, language: codeLanguage(label), run: code ? this.run('code', code.from, code.to) : { kind: 'code', text: '', from: node.to } }
      }
      case 'CodeBlock': return { kind: 'code', line, label: '', labelFrom: -1, language: null, run: this.run('code', node.from, node.to) }
      case 'Blockquote': return { kind: 'quote', line, blocks: this.blocks(node) }
      case 'BulletList':
      case 'OrderedList': {
        const items = node.getChildren('ListItem').map((item) => this.listItem(item))
        const mark = node.firstChild?.getChild('ListMark')
        const start = node.name === 'OrderedList' && mark ? Number.parseInt(this.slice(mark.from, mark.to), 10) || 1 : 1
        return { kind: 'list', line, ordered: node.name === 'OrderedList', start, items }
      }
      case 'Table': return this.table(node, line)
      case 'HorizontalRule': return { kind: 'rule', line }
      case 'HTMLBlock': case 'CommentBlock': case 'ProcessingInstructionBlock': return { kind: 'html', line, run: this.run('html', node.from, node.to) }
      case 'LinkReference': case 'QuoteMark': return null
      default: return { kind: 'paragraph', line, children: [this.run('text', node.from, node.to)] }
    }
  }

  listItem(item: SyntaxNode): MarkdownListItem {
    let task: boolean | null = null
    const blocks: MarkdownBlock[] = []
    for (let node = item.firstChild; node; node = node.nextSibling) {
      if (node.name === 'ListMark') continue
      if (node.name === 'Task') {
        const marker = node.getChild('TaskMarker')
        task = marker ? /\[[xX]\]/u.test(this.slice(marker.from, marker.to)) : false
        blocks.push({ kind: 'paragraph', line: this.line(node.from) + this.baseLines, children: trimInlines(this.inlines(node, marker?.to ?? node.from, node.to)) })
        continue
      }
      const block = this.block(node)
      if (block) blocks.push(block)
    }
    return { task, blocks }
  }

  table(node: SyntaxNode, line: number): MarkdownBlock {
    const cells = (row: SyntaxNode): MarkdownInline[][] => row.getChildren('TableCell').map((cell) => trimInlines(this.inlines(cell)))
    const header = node.getChild('TableHeader')
    const delimiter = node.getChildren('TableDelimiter').find((each) => each.parent?.name === 'Table')
    const align: MarkdownAlign[] = delimiter
      ? this.slice(delimiter.from, delimiter.to).replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map((cell) => {
        const text = cell.trim()
        return text.startsWith(':') && text.endsWith(':') ? 'center' : text.endsWith(':') ? 'right' : text.startsWith(':') ? 'left' : null
      })
      : []
    return { kind: 'table', line, align, header: header ? cells(header) : [], rows: node.getChildren('TableRow').map(cells) }
  }
}

/** A link label as references are matched: case and runs of spaces do not count. */
const normalLabel = (label: string): string => label.trim().replace(/\s+/gu, ' ').toLowerCase()

/** Leading and trailing spaces of a block's text dropped, so a heading's anchor and a cell's words are clean. */
function trimInlines(inlines: MarkdownInline[]): MarkdownInline[] {
  const out = [...inlines]
  const first = out[0]
  if (first?.kind === 'text') {
    const trimmed = first.text.replace(/^\s+/u, '')
    out[0] = { ...first, text: trimmed, from: first.from < 0 ? -1 : first.from + first.text.length - trimmed.length }
  }
  const last = out[out.length - 1]
  if (last?.kind === 'text') out[out.length - 1] = { ...last, text: last.text.replace(/\s+$/u, '') }
  return out.filter((inline) => inline.kind !== 'text' || inline.text.length > 0)
}

/**
 * The page of a Markdown text (line endings already one `\n` each). A front-matter block at the top shows as
 * code; raw HTML shows as its text; link definitions are used and not shown.
 */
export function markdownPage(text: string): MarkdownPage {
  const reader = new Reader(text)
  const blocks: MarkdownBlock[] = []
  let start = 0
  const front = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/u.exec(text)
  if (front) {
    const body = front[0].replace(/\n$/u, '')
    const from = 4
    const to = body.lastIndexOf('\n')
    blocks.push({ kind: 'code', line: 1, label: 'front matter', labelFrom: -1, language: 'yaml', run: { kind: 'code', text: text.slice(from, Math.max(from, to)), from } })
    start = front[0].length
  }
  const tree = parser.parse(text.slice(start))
  // Offsets in the tree are from `start`: a reader over the rest, shifted back into the whole file.
  const rest = new Reader(text.slice(start))
  rest.baseLines = start === 0 ? 0 : reader.line(start) - 1
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'LinkReference') continue
    const label = node.getChild('LinkLabel')
    const url = node.getChild('URL')
    if (label && url) rest.references.set(normalLabel(rest.slice(label.from + 1, label.to - 1)), { address: rest.slice(url.from, url.to), from: url.from })
  }
  blocks.push(...shiftBlocks(rest.blocks(tree.topNode), start))
  return { blocks, headings: rest.headings }
}

const shiftAt = (from: number, by: number): number => (from < 0 ? from : from + by)

function shiftRun<Run extends MarkdownRun>(run: Run, by: number): Run {
  return by === 0 || run.from < 0 ? run : { ...run, from: run.from + by }
}

function shiftInlines(inlines: MarkdownInline[], by: number): MarkdownInline[] {
  if (by === 0) return inlines
  return inlines.map((inline) => {
    switch (inline.kind) {
      case 'text': case 'code': case 'html': return shiftRun(inline, by)
      case 'em': case 'strong': case 'strike': return { ...inline, children: shiftInlines(inline.children, by) }
      case 'link': return { ...inline, addressFrom: shiftAt(inline.addressFrom, by), children: shiftInlines(inline.children, by) }
      case 'image': return { ...inline, altFrom: shiftAt(inline.altFrom, by), sourceFrom: shiftAt(inline.sourceFrom, by) }
      default: return inline
    }
  })
}

function shiftBlocks(blocks: MarkdownBlock[], by: number): MarkdownBlock[] {
  if (by === 0) return blocks
  return blocks.map((block): MarkdownBlock => {
    switch (block.kind) {
      case 'heading': case 'paragraph': return { ...block, children: shiftInlines(block.children, by) }
      case 'code': return { ...block, labelFrom: shiftAt(block.labelFrom, by), run: shiftRun(block.run, by) }
      case 'html': return { ...block, run: shiftRun(block.run, by) }
      case 'quote': return { ...block, blocks: shiftBlocks(block.blocks, by) }
      case 'list': return { ...block, items: block.items.map((item) => ({ ...item, blocks: shiftBlocks(item.blocks, by) })) }
      case 'table': return { ...block, header: block.header.map((cell) => shiftInlines(cell, by)), rows: block.rows.map((row) => row.map((cell) => shiftInlines(cell, by))) }
      case 'rule': return block
    }
  })
}

/** Every run of the file's own text the page shows, in order: what find looks in. */
export function pageRuns(page: MarkdownPage): MarkdownRun[] {
  const runs: MarkdownRun[] = []
  const inline = (items: readonly MarkdownInline[]): void => {
    for (const item of items) {
      if (item.kind === 'text' || item.kind === 'code' || item.kind === 'html') { if (item.from >= 0) runs.push(item) }
      else if (item.kind === 'em' || item.kind === 'strong' || item.kind === 'strike' || item.kind === 'link') inline(item.children)
    }
  }
  const block = (items: readonly MarkdownBlock[]): void => {
    for (const each of items) {
      switch (each.kind) {
        case 'heading': case 'paragraph': inline(each.children); break
        case 'code': case 'html': runs.push(each.run); break
        case 'quote': block(each.blocks); break
        case 'list': for (const item of each.items) block(item.blocks); break
        case 'table': for (const cell of [...each.header, ...each.rows.flat()]) inline(cell); break
        case 'rule': break
      }
    }
  }
  block(page.blocks)
  return runs
}

/** Find's matches that lie whole inside one shown run: a match across marks or inside a mark is not on the page. */
export function matchesOnPage(matches: readonly FindMatch[], runs: readonly MarkdownRun[]): FindMatch[] {
  const sorted = [...runs].sort((a, b) => a.from - b.from)
  return matches.filter((match) => {
    // The last run that starts at or before the match: the only one that can hold it whole.
    let low = 0
    let high = sorted.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (sorted[middle]!.from <= match.from) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    const run = sorted[found]
    return !!run && match.to <= run.from + run.text.length
  })
}

/** One piece of a run as the page draws it: plain, a coloured token, a find match, or one hidden value's plate. */
export interface RunPiece {
  text: string
  from: number
  className: string | null
  /** The hidden range this piece stands for; its text is never drawn. */
  secret: number | null
  match: number | null
}

/**
 * A run cut where colour, find's matches and hidden values begin and end. A hidden value is one piece however many
 * tokens it covers, so its plate is drawn once; a shown value is drawn as text.
 */
export function runPieces(
  run: MarkdownRun,
  tokens: readonly { from: number; to: number; className: string }[],
  ranges: readonly SecretRange[],
  revealed: number | null,
  matches: readonly FindMatch[]
): RunPiece[] {
  if (run.from < 0) return [{ text: run.text, from: -1, className: null, secret: null, match: null }]
  const start = run.from
  const end = run.from + run.text.length
  const cuts = new Set<number>([start, end])
  // Ranges, tokens and matches are each in order and apart, so the part of each that meets this run is found by
  // halving and walked once: a page of many runs and many hidden values costs each of them once per run it meets.
  const hidden: { from: number; to: number; index: number }[] = []
  for (let index = firstEndingAfter(ranges, start, (range) => range[1]); index < ranges.length && ranges[index]![0] < end; index += 1) {
    const [from, to] = ranges[index]!
    if (index !== revealed && to > from) hidden.push({ from: Math.max(from, start), to: Math.min(to, end), index })
  }
  const shownTokens: { from: number; to: number; className: string }[] = []
  for (let index = firstEndingAfter(tokens, start, (token) => token.to); index < tokens.length && tokens[index]!.from < end; index += 1) shownTokens.push(tokens[index]!)
  const shownMatches: { from: number; to: number; index: number }[] = []
  for (let index = firstEndingAfter(matches, start, (match) => match.to); index < matches.length && matches[index]!.from < end; index += 1) {
    shownMatches.push({ from: matches[index]!.from, to: matches[index]!.to, index })
  }
  for (const token of shownTokens) { cuts.add(Math.max(start, token.from)); cuts.add(Math.min(end, token.to)) }
  for (const match of shownMatches) { cuts.add(Math.max(start, match.from)); cuts.add(Math.min(end, match.to)) }
  for (const each of hidden) { cuts.add(each.from); cuts.add(each.to) }
  const points = [...cuts].filter((at) => at >= start && at <= end).sort((a, b) => a - b)
  const pieces: RunPiece[] = []
  // One cursor per list, moving forward with the pieces.
  let secretAt = 0
  let tokenAt = 0
  let matchAt = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!
    const to = points[index + 1]!
    if (to <= from) continue
    while (secretAt < hidden.length && hidden[secretAt]!.to <= from) secretAt += 1
    const secret = hidden[secretAt]
    if (secret && secret.from <= from && to <= secret.to) {
      if (pieces[pieces.length - 1]?.secret !== secret.index) pieces.push({ text: '', from: secret.from, className: null, secret: secret.index, match: null })
      continue
    }
    while (tokenAt < shownTokens.length && shownTokens[tokenAt]!.to <= from) tokenAt += 1
    while (matchAt < shownMatches.length && shownMatches[matchAt]!.to <= from) matchAt += 1
    const token = shownTokens[tokenAt]
    const match = shownMatches[matchAt]
    pieces.push({
      text: run.text.slice(from - start, to - start), from,
      className: token && token.from <= from && to <= token.to ? token.className : null,
      secret: null,
      match: match && match.from <= from && to <= match.to ? match.index : null
    })
  }
  return pieces
}

/** The first item of an ordered list of stretches that apart ends after `at`, found by halving. */
export function firstEndingAfter<T>(items: readonly T[], at: number, endOf: (item: T) => number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (endOf(items[middle]!) <= at) low = middle + 1
    else high = middle
  }
  return low
}
