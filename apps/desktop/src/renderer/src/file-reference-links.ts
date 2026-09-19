// MODULE: file-reference-links.ts - Ctrl+click file links in terminal output, found only in the line xterm asks about
import { findFileReferences } from '@bmn/protocol'
import type { IBufferRange, ILink, ILinkProvider } from '@xterm/xterm'

interface LinkBufferCell {
  getChars(): string
  getWidth(): number
}

interface LinkBufferLine {
  readonly isWrapped: boolean
  readonly length: number
  getCell(x: number, cell?: LinkBufferCell): LinkBufferCell | undefined
}

export interface LinkBuffer {
  readonly length: number
  getLine(y: number): LinkBufferLine | undefined
  getNullCell(): LinkBufferCell
}

/** Rows joined above and below the requested one; a longer wrapped line is not read further. */
const MAX_WRAPPED_ROWS = 16

export interface FileReferenceLink {
  text: string
  range: IBufferRange
}

/**
 * The file references in the logical line holding buffer row `row` (1-based, as xterm asks), with cell ranges.
 * Only rows the terminal itself wrapped are joined, so text from separate output lines is never combined.
 */
export function fileReferenceLinks(buffer: LinkBuffer, row: number): FileReferenceLink[] {
  let first = row - 1
  while (first > 0 && row - 1 - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1
  let last = row - 1
  while (last + 1 < buffer.length && last + 1 - (row - 1) < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) {
    last += 1
  }
  // A group cut short at either bound may split a path; nothing in it is trusted.
  if ((first > 0 && buffer.getLine(first)?.isWrapped) || buffer.getLine(last + 1)?.isWrapped) return []
  let text = ''
  /** For each UTF-16 unit of `text`: the 0-based cell it starts in and how many cells it covers. */
  const cells: Array<{ x: number; y: number; width: number }> = []
  const cell = buffer.getNullCell()
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y)
    if (!line) return []
    for (let x = 0; x < line.length; x += 1) {
      const current = line.getCell(x, cell)
      if (!current) break
      const width = current.getWidth()
      if (width === 0) continue
      const chars = current.getChars() || ' '
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ x, y, width })
      text += chars
    }
  }
  return findFileReferences(text).flatMap((match) => {
    const start = cells[match.start]
    const end = cells[match.end - 1]
    if (!start || !end) return []
    const range = { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + end.width, y: end.y + 1 } }
    // xterm asks per row; a link belongs to every row it covers.
    return range.start.y <= row && range.end.y >= row ? [{ text: match.text, range }] : []
  })
}

export interface FileReferenceLinkHost {
  buffer(): LinkBuffer
  /** False while the program reads the mouse (vim, htop): clicks belong to it and links stay off. */
  enabled(): boolean
  hasSelection(): boolean
  open(reference: string): void
}

export interface FileReferenceLinkProvider extends ILinkProvider {
  /** Ctrl went down or up: show or hide the hovered link's underline and pointer. */
  modifierChanged(held: boolean): void
}

/** Only Ctrl with the primary button, and no other modifier, opens a link; every other click stays the terminal's. */
export function isLinkActivation(event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): boolean {
  return event.button === 0 && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

function sameRange(left: IBufferRange, right: IBufferRange): boolean {
  return left.start.x === right.start.x && left.start.y === right.start.y &&
    left.end.x === right.end.x && left.end.y === right.end.y
}

/**
 * Links are underlined only while Ctrl is held. They never read the filesystem: opening one sends its text to the
 * same checked flow as a typed reference, so a stale link is validated again at that moment.
 */
export function createFileReferenceLinkProvider(host: FileReferenceLinkHost): FileReferenceLinkProvider {
  let held = false
  let hovered: ILink | undefined
  return {
    modifierChanged: (next) => {
      if (next === held) return
      held = next
      if (hovered?.decorations) {
        hovered.decorations.underline = held
        hovered.decorations.pointerCursor = held
      }
    },
    provideLinks: (row, callback) => {
      if (!host.enabled()) {
        callback(undefined)
        return
      }
      const links = fileReferenceLinks(host.buffer(), row).map((found): ILink => {
        const link: ILink = {
          range: found.range,
          text: found.text,
          decorations: { underline: held, pointerCursor: held },
          hover: () => {
            hovered = link
          },
          leave: () => {
            if (hovered === link) hovered = undefined
          },
          activate: (event, text) => {
            // A drag that ends on the link made a selection; that stays a copy, not an open.
            if (!isLinkActivation(event) || !host.enabled() || host.hasSelection()) return
            // Output can rewrite these cells before xterm renders and drops the link; open only what is still printed.
            const current = fileReferenceLinks(host.buffer(), found.range.start.y)
            if (!current.some((item) => item.text === text && sameRange(item.range, found.range))) return
            host.open(text)
          }
        }
        return link
      })
      callback(links.length > 0 ? links : undefined)
    }
  }
}
