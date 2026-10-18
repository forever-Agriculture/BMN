// MODULE: quick-look-page.tsx - a Markdown file drawn as a page in Quick look: elements built from the page model, links that open only Quick look, images never loaded, masks and find as in source (Story 67.4)
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { SECRET_MASK, type SecretRange } from '@bmn/protocol'
import { codeTokens } from './quick-look-code'
import type { FindMatch } from './quick-look-find'
import {
  resolveLinkPath,
  runPieces,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownPage,
  type MarkdownRun,
  type MarkdownTarget
} from './quick-look-markdown'

export interface MarkdownPageHandle {
  /** Scrolls to the block that holds a line and marks it. */
  goToLine(line: number): void
  /** The first hidden value in view, for Ctrl+R; null when none is. */
  hiddenInView(): number | null
  focus(): void
}

export interface MarkdownPageProps {
  page: MarkdownPage
  path: string
  ranges: readonly SecretRange[]
  revealed: number | null
  secondsLeft: number
  matches: readonly FindMatch[]
  current: number
  /** The line he came for, marked; or the heading a link named. */
  line: number | null
  heading: string | null
  /** The line kept at the top after a reload or from the remembered place. */
  topLine: number | null
  focus: boolean
  status: string
  onStatus(text: string): void
  onReveal(index: number): void
  onTop(line: number): void
  onOpenFile(path: string, line: number | null, column: number | null, heading: string | null): void
  onAddress(address: string): void
  onFocus(): void
}

interface Draw {
  ranges: readonly SecretRange[]
  revealed: number | null
  matches: readonly FindMatch[]
  current: number
  onReveal(index: number): void
  /** Opens or copies a target; `address` is its address with each hidden value masked unless revealed. */
  onTarget(target: MarkdownTarget, address: string): void
  onStatus(text: string): void
}

/**
 * Text of the file at `from` as it may leave the page: each hidden value it touches becomes "[secret hidden]",
 * except the one revealed when `revealed` is given. Text the page made itself (from -1) holds no file bytes.
 */
export function maskedSource(text: string, from: number, ranges: readonly SecretRange[], revealed: number | null = null): string {
  if (from < 0) return text
  let out = text
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const [start, end] = ranges[index]!
    if (index === revealed || end <= from || start >= from + text.length) continue
    out = `${out.slice(0, Math.max(0, start - from))}${SECRET_MASK}${out.slice(Math.min(text.length, end - from))}`
  }
  return out
}

const DOTS = '\u2022'.repeat(12)

function Eye(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** A run of the file's text, cut into colour, find's matches and hidden values. */
function Run(props: { run: MarkdownRun; draw: Draw; tokens?: readonly { from: number; to: number; className: string }[] }): React.JSX.Element {
  const { run, draw } = props
  const pieces = runPieces(run, props.tokens ?? [], draw.ranges, draw.revealed, draw.matches)
  return (
    <>
      {pieces.map((piece) => {
        if (piece.secret !== null) {
          const [start, end] = draw.ranges[piece.secret]!
          const length = end - start
          return (
            <span key={`s${piece.from}`} className="ql-secret-wrap">
              <span className="ql-secret" role="img" data-secret={piece.secret} aria-label={`hidden value, ${length} ${length === 1 ? 'character' : 'characters'}`}>{DOTS}</span>
              <button type="button" className="ql-eye" aria-label="Show this value for 10 seconds" aria-pressed="false" onMouseDown={(event) => event.preventDefault()}
                onClick={() => draw.onReveal(piece.secret!)}><Eye /></button>
            </span>
          )
        }
        const shown = draw.revealed !== null && draw.ranges[draw.revealed] && piece.from >= draw.ranges[draw.revealed]![0] && piece.from < draw.ranges[draw.revealed]![1]
        const className = [piece.className, shown ? 'ql-secret-shown' : null].filter(Boolean).join(' ') || undefined
        if (piece.match !== null) {
          return <mark key={`m${piece.from}`} data-match={piece.match} className={`ql-match${piece.match === draw.current ? ' ql-match-current' : ''}${className ? ` ${className}` : ''}`}>{piece.text}</mark>
        }
        return className ? <span key={`t${piece.from}`} className={className}>{piece.text}</span> : <span key={`t${piece.from}`}>{piece.text}</span>
      })}
    </>
  )
}

/** What the status line says of a target; an address holding a hidden value is shown masked, never derived. */
function targetLabel(target: MarkdownTarget, fallback: string, address: { text: string; from: number }, ranges: readonly SecretRange[]): string {
  const masked = maskedSource(address.text, address.from, ranges)
  if (masked !== address.text) return target.kind === 'outside' ? `${masked} · Enter copies the address` : masked
  switch (target.kind) {
    case 'outside': return `${target.address} · Enter copies the address`
    case 'heading': return `#${target.slug}`
    case 'file': return `${target.path}${target.line ? `:${target.line}` : ''}${target.heading ? `#${target.heading}` : ''}`
    case 'none': return fallback
  }
}

function Inlines(props: { inlines: readonly MarkdownInline[]; draw: Draw }): React.JSX.Element {
  const { draw } = props
  return (
    <>
      {props.inlines.map((inline, index) => {
        switch (inline.kind) {
          case 'text': return <Run key={index} run={inline} draw={draw} />
          case 'html': return <span key={index} className="ql-md-raw"><Run run={inline} draw={draw} /></span>
          case 'code': return <code key={index} className="ql-md-code"><Run run={inline} draw={draw} /></code>
          case 'em': return <em key={index}><Inlines inlines={inline.children} draw={draw} /></em>
          case 'strong': return <strong key={index}><Inlines inlines={inline.children} draw={draw} /></strong>
          case 'strike': return <s key={index}><Inlines inlines={inline.children} draw={draw} /></s>
          case 'break': return <br key={index} />
          case 'link': {
            const label = targetLabel(inline.target, '', { text: inline.address, from: inline.addressFrom }, draw.ranges)
            const activate = (): void => draw.onTarget(inline.target, maskedSource(inline.address, inline.addressFrom, draw.ranges, draw.revealed))
            // No href: nothing on the page can make the window go anywhere; Quick look handles every activation.
            return (
              <a key={index} className="ql-md-a" role="link" tabIndex={0} data-target={inline.target.kind}
                onClick={activate}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); activate() } }}
                onFocus={() => draw.onStatus(label)} onMouseEnter={() => draw.onStatus(label)}>
                <Inlines inlines={inline.children} draw={draw} />
              </a>
            )
          }
          case 'image': {
            const source = { text: inline.source, from: inline.sourceFrom }
            const label = targetLabel(inline.target, maskedSource(inline.source, inline.sourceFrom, draw.ranges), source, draw.ranges)
            const activate = (): void => draw.onTarget(inline.target, maskedSource(inline.source, inline.sourceFrom, draw.ranges, draw.revealed))
            // An image is one line of words: never loaded, local or remote; its words and source are masked as text is.
            return (
              <a key={index} className="ql-md-img" role="link" tabIndex={0} data-target={inline.target.kind}
                onClick={activate}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); activate() } }}
                onFocus={() => draw.onStatus(label)} onMouseEnter={() => draw.onStatus(label)}>
                <span className="ql-eyebrow">Image</span>
                {inline.alt ? <span className="ql-md-alt"><Run run={{ kind: 'text', text: inline.alt, from: inline.altFrom }} draw={draw} /></span> : null}
                <span className="ql-md-src"><Run run={{ kind: 'text', text: inline.source, from: inline.sourceFrom }} draw={draw} /></span>
              </a>
            )
          }
        }
      })}
    </>
  )
}

function Box(props: { checked: boolean }): React.JSX.Element {
  return (
    <span className={`ql-md-box${props.checked ? ' on' : ''}`} role="img" aria-label={props.checked ? 'done' : 'not done'}>
      {props.checked ? <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
    </span>
  )
}

function Blocks(props: { blocks: readonly MarkdownBlock[]; draw: Draw; target: number | null }): React.JSX.Element {
  const { draw } = props
  return (
    <>
      {props.blocks.map((block, index) => {
        const marked = props.target === block.line ? ' ql-target' : ''
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h1'
            return <Tag key={index} data-line={block.line} data-slug={block.slug} className={marked.trim() || undefined}><Inlines inlines={block.children} draw={draw} /></Tag>
          }
          case 'paragraph': return <p key={index} data-line={block.line} className={marked.trim() || undefined}><Inlines inlines={block.children} draw={draw} /></p>
          case 'code': return <CodeBlock key={index} block={block} draw={draw} marked={marked} />
          case 'html': return <pre key={index} data-line={block.line} className={`ql-md-pre ql-md-raw${marked}`}><Run run={block.run} draw={draw} /></pre>
          case 'quote': return <blockquote key={index} data-line={block.line}><Blocks blocks={block.blocks} draw={draw} target={props.target} /></blockquote>
          case 'rule': return <hr key={index} data-line={block.line} />
          case 'list': {
            const items = block.items.map((item, at) => (
              <li key={at} className={item.task !== null ? 'ql-md-task' : undefined}>
                {item.task !== null ? <Box checked={item.task} /> : null}
                <Blocks blocks={item.blocks} draw={draw} target={props.target} />
              </li>
            ))
            return block.ordered
              ? <ol key={index} data-line={block.line} start={block.start}>{items}</ol>
              : <ul key={index} data-line={block.line}>{items}</ul>
          }
          case 'table':
            return (
              <div key={index} className="ql-md-table" data-line={block.line}>
                <table>
                  <thead><tr>{block.header.map((cell, at) => <th key={at} style={{ textAlign: block.align[at] ?? undefined }}><Inlines inlines={cell} draw={draw} /></th>)}</tr></thead>
                  <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] ?? undefined }}><Inlines inlines={cell} draw={draw} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            )
        }
      })}
    </>
  )
}

function CodeBlock(props: { block: Extract<MarkdownBlock, { kind: 'code' }>; draw: Draw; marked: string }): React.JSX.Element {
  const { block } = props
  const tokens = useMemo(() => codeTokens(block.run.text, block.language, block.run.from), [block.run.text, block.language, block.run.from])
  return (
    <pre data-line={block.line} className={`ql-md-pre${props.marked}`}>
      {block.label ? <span className="ql-md-label">{maskedSource(block.label, block.labelFrom, props.draw.ranges)}</span> : null}
      <code><Run run={block.run} draw={props.draw} tokens={tokens} /></code>
    </pre>
  )
}

/** The block element that holds a line: the last one that starts at or before it. */
function blockAt(container: HTMLElement, line: number): HTMLElement | null {
  let found: HTMLElement | null = null
  for (const element of container.querySelectorAll<HTMLElement>('[data-line]')) {
    if (Number(element.dataset.line) <= line) found = element
    else break
  }
  return found
}

function scrollTo(container: HTMLElement, element: HTMLElement, where: 'start' | 'center'): void {
  const box = container.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const offset = where === 'start' ? rect.top - box.top : rect.top - box.top - (box.height - rect.height) / 2
  container.scrollTop += offset
}

export const MarkdownPageView = forwardRef<MarkdownPageHandle, MarkdownPageProps>(function MarkdownPageView(props, ref) {
  const container = useRef<HTMLDivElement>(null)
  const onTop = useRef(props.onTop)
  onTop.current = props.onTop
  const directory = props.path.slice(0, props.path.lastIndexOf('/')) || '/'
  const targetLine = props.line ?? (props.heading ? props.page.headings.find((each) => each.slug === props.heading)?.line ?? null : null)

  useImperativeHandle(ref, () => ({
    goToLine(line) {
      const element = container.current && blockAt(container.current, line)
      if (element && container.current) scrollTo(container.current, element, 'start')
    },
    hiddenInView() {
      const element = container.current
      if (!element) return null
      const box = element.getBoundingClientRect()
      for (const plate of element.querySelectorAll<HTMLElement>('.ql-secret[data-secret]')) {
        const rect = plate.getBoundingClientRect()
        if (rect.bottom > box.top && rect.top < box.bottom) return Number(plate.dataset.secret)
      }
      return null
    },
    focus() {
      container.current?.focus()
    }
  }), [])

  // The first place: the kept top line, else the line or heading he came for, else the top.
  useEffect(() => {
    const element = container.current
    if (!element) return
    const top = props.topLine ? blockAt(element, props.topLine) : null
    const target = !top && targetLine ? blockAt(element, targetLine) : null
    if (top) scrollTo(element, top, 'start')
    else if (target) scrollTo(element, target, 'center')
  }, [props.page, props.topLine, targetLine])

  useEffect(() => {
    if (props.focus) container.current?.focus()
  }, [props.focus])

  // The line at the top is reported as the page scrolls, so a place is kept without measuring a closing sheet.
  useEffect(() => {
    const element = container.current
    if (!element) return
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!element.isConnected) return
        const top = element.getBoundingClientRect().top
        const first = [...element.querySelectorAll<HTMLElement>('[data-line]')].find((each) => each.getBoundingClientRect().bottom > top + 1)
        onTop.current(first ? Number(first.dataset.line) : 1)
      })
    }
    element.addEventListener('scroll', report, { passive: true })
    report()
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', report)
    }
  }, [props.page])

  // Find's current match in the middle of the page.
  useEffect(() => {
    const element = container.current
    const match = element?.querySelector<HTMLElement>(`[data-match="${props.current}"]`)
    if (element && match) scrollTo(element, match, 'center')
  }, [props.current, props.matches])

  const draw: Draw = {
    ranges: props.ranges,
    revealed: props.revealed,
    matches: props.matches,
    current: props.current,
    onReveal: props.onReveal,
    onStatus: props.onStatus,
    onTarget: (target, address) => {
      switch (target.kind) {
        case 'outside': props.onAddress(address); return
        case 'heading': {
          const heading = container.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(target.slug)}"]`)
          if (heading && container.current) scrollTo(container.current, heading, 'start')
          else props.onStatus(`No heading #${target.slug} in this file.`)
          return
        }
        case 'file': props.onOpenFile(resolveLinkPath(directory, target.path), target.line, target.column, target.heading); return
        case 'none':
      }
    }
  }

  /** A copied selection holds "[secret hidden]" for each hidden value, as in source. */
  const onCopy = (event: React.ClipboardEvent): void => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const fragment = selection.getRangeAt(0).cloneContents()
    for (const plate of fragment.querySelectorAll('.ql-secret')) plate.replaceWith(SECRET_MASK)
    for (const eye of fragment.querySelectorAll('.ql-eye, .ql-md-label')) eye.remove()
    const holder = document.createElement('div')
    holder.className = 'ql-copy-holder'
    holder.append(fragment)
    document.body.append(holder)
    const text = holder.innerText
    holder.remove()
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
  }

  const shownNote = props.revealed !== null ? `Shown · hides in ${props.secondsLeft} s` : ''
  return (
    <div className="ql-page-wrap">
      <div ref={container} className="ql-page" tabIndex={0} role="document" aria-label={`${props.path.slice(props.path.lastIndexOf('/') + 1)}, rendered`}
        onFocus={props.onFocus} onCopy={onCopy}>
        <article className="ql-md">
          <Blocks blocks={props.page.blocks} draw={draw} target={targetLine} />
        </article>
      </div>
      {shownNote || props.status ? <p className="ql-page-status" aria-live="polite">{shownNote || props.status}</p> : null}
    </div>
  )
})
