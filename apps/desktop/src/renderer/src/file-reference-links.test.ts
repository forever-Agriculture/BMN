// MODULE: file-reference-links.test.ts - terminal file links from real xterm buffers: ranges, wrapping, Ctrl-only activation
import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import {
  createFileReferenceLinkProvider,
  fileReferenceLinks,
  isLinkActivation,
  type LinkBuffer
} from './file-reference-links'

async function terminal(text: string, cols = 40): Promise<Terminal> {
  const created = new Terminal({ cols, rows: 10, allowProposedApi: true })
  await new Promise<void>((resolve) => created.write(text, resolve))
  return created
}

function buffer(created: Terminal): LinkBuffer {
  return created.buffer.active as unknown as LinkBuffer
}

function provided(provider: ReturnType<typeof createFileReferenceLinkProvider>, row: number): ILink[] | undefined {
  let links: ILink[] | undefined
  provider.provideLinks(row, (found) => {
    links = found
  })
  return links
}

const click = { button: 0, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false } as MouseEvent

describe('fileReferenceLinks', () => {
  it('maps a compiler reference to the exact cells of its row', async () => {
    const created = await terminal('ok\r\nerror in src/parser.ts:42:7: bad\r\n')
    expect(fileReferenceLinks(buffer(created), 1)).toEqual([])
    expect(fileReferenceLinks(buffer(created), 2)).toEqual([{
      text: 'src/parser.ts:42:7',
      range: { start: { x: 10, y: 2 }, end: { x: 27, y: 2 } }
    }])
  })

  it('joins only rows the terminal wrapped, and gives the link to each row it covers', async () => {
    const path = 'apps/desktop/src/renderer/src/main.tsx:12'
    const created = await terminal(`see ${path} ok\r\nnext/line.ts`, 20)
    const expected = { text: path, range: { start: { x: 5, y: 1 }, end: { x: 5, y: 3 } } }
    expect(fileReferenceLinks(buffer(created), 1)).toEqual([expected])
    expect(fileReferenceLinks(buffer(created), 2)).toEqual([expected])
    expect(fileReferenceLinks(buffer(created), 3)).toEqual([expected])
    // The next output line is separate: its text never joins the wrapped reference above.
    expect(fileReferenceLinks(buffer(created), 4)).toEqual([
      { text: 'next/line.ts', range: { start: { x: 1, y: 4 }, end: { x: 12, y: 4 } } }
    ])
  })

  it('keeps unrelated adjacent lines apart even when both hold path fragments', async () => {
    const created = await terminal('prefix src/a\r\nb.ts suffix\r\n')
    expect(fileReferenceLinks(buffer(created), 1)).toEqual([])
    expect(fileReferenceLinks(buffer(created), 2)).toEqual([
      { text: 'b.ts', range: { start: { x: 1, y: 2 }, end: { x: 4, y: 2 } } }
    ])
  })

  it('counts wide characters as two cells and keeps Unicode names whole', async () => {
    const created = await terminal('完成 docs/звіт.md:4 ✓\r\n')
    expect(fileReferenceLinks(buffer(created), 1)).toEqual([
      { text: 'docs/звіт.md:4', range: { start: { x: 6, y: 1 }, end: { x: 19, y: 1 } } }
    ])
    const wideName = await terminal('open 文档/说明.md now\r\n')
    expect(fileReferenceLinks(buffer(wideName), 1)).toEqual([
      { text: '文档/说明.md', range: { start: { x: 6, y: 1 }, end: { x: 17, y: 1 } } }
    ])
  })

  it('declines a wrapped line whose start scrolled out of the buffer', async () => {
    const created = new Terminal({ cols: 10, rows: 3, scrollback: 0, allowProposedApi: true })
    await new Promise<void>((resolve) => created.write('aaaa src/parser.ts:4 bb\r\nnext', resolve))
    // The first row left is `arser.ts:4`, the tail of a path whose start was trimmed away.
    expect(created.buffer.active.getLine(0)?.translateToString(true)).toBe('arser.ts:4')
    expect(created.buffer.active.getLine(0)?.isWrapped).toBe(true)
    expect(fileReferenceLinks(buffer(created), 1)).toEqual([])
  })

  it('declines a line wrapped past the bound instead of guessing its start', async () => {
    const created = await terminal(`${'x'.repeat(10 * 40)} src/tail.ts\r\n`, 20)
    const rows = buffer(created)
    const lastRow = Array.from({ length: rows.length }, (_, index) => index + 1)
      .filter((row) => rows.getLine(row - 1)?.isWrapped).at(-1)!
    expect(fileReferenceLinks(rows, lastRow)).toEqual([])
  })
})

describe('createFileReferenceLinkProvider', () => {
  it('offers links only while the program is not reading the mouse', async () => {
    const created = await terminal('see src/parser.ts:4\r\n')
    let mouseTracking = false
    const provider = createFileReferenceLinkProvider({
      buffer: () => buffer(created),
      enabled: () => !mouseTracking,
      hasSelection: () => false,
      open: () => undefined
    })
    expect(provided(provider, 1)?.map((link) => link.text)).toEqual(['src/parser.ts:4'])
    mouseTracking = true
    expect(provided(provider, 1)).toBeUndefined()
  })

  it('opens only on a plain Ctrl primary click without a selection, re-checking mouse mode at the click', async () => {
    const created = await terminal('see src/parser.ts:4\r\n')
    const opened: string[] = []
    let mouseTracking = false
    let selection = false
    const provider = createFileReferenceLinkProvider({
      buffer: () => buffer(created),
      enabled: () => !mouseTracking,
      hasSelection: () => selection,
      open: (reference) => opened.push(reference)
    })
    const [link] = provided(provider, 1)!
    link!.activate({ ...click, ctrlKey: false } as MouseEvent, link!.text)
    link!.activate({ ...click, button: 2 } as MouseEvent, link!.text)
    link!.activate({ ...click, shiftKey: true } as MouseEvent, link!.text)
    selection = true
    link!.activate(click, link!.text)
    selection = false
    mouseTracking = true
    link!.activate(click, link!.text)
    mouseTracking = false
    link!.activate(click, link!.text)
    expect(opened).toEqual(['src/parser.ts:4'])
  })

  it('ignores a link whose cells output rewrote after it was found', async () => {
    const created = await terminal('see src/parser.ts:4\r\n')
    const opened: string[] = []
    const provider = createFileReferenceLinkProvider({
      buffer: () => buffer(created),
      enabled: () => true,
      hasSelection: () => false,
      open: (reference) => opened.push(reference)
    })
    const [link] = provided(provider, 1)!
    const rewrite = (text: string): Promise<void> =>
      new Promise((resolve) => created.write(`\x1b[1;1H\x1b[2K${text}`, resolve))
    await rewrite('build finished')
    link!.activate(click, link!.text)
    await rewrite('now see src/parser.ts:4')
    link!.activate(click, link!.text)
    await rewrite('see src/parser.ts:4')
    link!.activate(click, link!.text)
    expect(opened).toEqual(['src/parser.ts:4'])
  })

  it('opens the hovered link from a Ctrl context-menu press, once per press, as macOS delivers Ctrl+click', async () => {
    const created = await terminal('see src/parser.ts:4\r\n')
    const opened: string[] = []
    const provider = createFileReferenceLinkProvider({
      buffer: () => buffer(created),
      enabled: () => true,
      hasSelection: () => false,
      open: (reference) => opened.push(reference)
    })
    const [link] = provided(provider, 1)!
    provider.pressStarted(click)
    expect(provider.openHovered()).toBe(false)
    link!.hover!(click, link!.text)
    provider.pressStarted({ ...click, ctrlKey: false } as MouseEvent)
    expect(provider.openHovered()).toBe(false)
    provider.pressStarted(click)
    expect(provider.openHovered()).toBe(true)
    // The release of that same press reaches xterm's activation too; the file opens once.
    link!.activate(click, link!.text)
    // An ordinary Ctrl+click, as Linux delivers it, opens through xterm alone.
    provider.pressStarted(click)
    link!.activate(click, link!.text)
    link!.leave!(click, link!.text)
    provider.pressStarted(click)
    expect(provider.openHovered()).toBe(false)
    expect(opened).toEqual(['src/parser.ts:4', 'src/parser.ts:4'])
  })

  it('underlines the hovered link only while Ctrl is held', async () => {
    const created = await terminal('see src/parser.ts:4\r\n')
    const provider = createFileReferenceLinkProvider({
      buffer: () => buffer(created),
      enabled: () => true,
      hasSelection: () => false,
      open: () => undefined
    })
    const [link] = provided(provider, 1)!
    expect(link!.decorations).toEqual({ underline: false, pointerCursor: false })
    link!.hover!({} as MouseEvent, link!.text)
    provider.modifierChanged(true)
    expect(link!.decorations).toEqual({ underline: true, pointerCursor: true })
    expect(provided(provider, 1)![0]!.decorations).toEqual({ underline: true, pointerCursor: true })
    link!.leave!({} as MouseEvent, link!.text)
    provider.modifierChanged(false)
    expect(link!.decorations).toEqual({ underline: true, pointerCursor: true })
  })

  it('treats only Ctrl with the primary button as activation', () => {
    expect(isLinkActivation(click)).toBe(true)
    expect(isLinkActivation({ ...click, metaKey: true })).toBe(false)
    expect(isLinkActivation({ ...click, altKey: true })).toBe(false)
    expect(isLinkActivation({ ...click, button: 1 })).toBe(false)
  })
})
