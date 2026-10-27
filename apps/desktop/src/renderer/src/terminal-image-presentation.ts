// MODULE: terminal-image-presentation.ts - Qualify completed image-path updates by their presentation state
import type { Terminal } from '@xterm/xterm'
import { TerminalPresentationDigest } from './terminal-presentation-digest'

/** Includes fixed hash scratch, the two digest strings and bounded adapter bookkeeping. */
export const IMAGE_PRESENTATION_BYTES = 4096

interface ImageDimensions { width: number; height: number }
interface PresentationImages {
  _images: Map<number, { orig?: ImageDimensions; actual?: ImageDimensions }>
}
interface PresentationLine {
  _data: Uint32Array
  _combined: Record<number, string | undefined>
  _extendedAttrs: Record<number, { ext: number; urlId: number; imageId?: number; tileId?: number } | undefined>
}
interface InputHandler {
  parse(data: string | Uint8Array, continuation?: boolean): void | Promise<boolean>
  _parseStack: { paused: boolean }
}
interface PresentationCore {
  buffer: { ydisp: number; lines: { get(row: number): PresentationLine | undefined } }
  _inputHandler: InputHandler
  coreService: {
    isCursorHidden: boolean
    isCursorInitialized: boolean
    decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean }
  }
  _coreBrowserService: { isFocused: boolean }
  _selectionService: { columnSelectMode: boolean }
  _themeService: { colors: { ansi: { rgba: number }[]; [key: string]: unknown } }
}

const COLOR_KEYS = [
  'foreground', 'background', 'cursor', 'cursorAccent', 'selectionForeground',
  'selectionBackgroundTransparent', 'selectionBackgroundOpaque',
  'selectionInactiveBackgroundTransparent', 'selectionInactiveBackgroundOpaque'
] as const

/** Version-pinned xterm 6.0.0 state. A refresh request alone is never mutation evidence. */
export function trackImagePresentation(terminal: Terminal, storage: PresentationImages): {
  changed(): boolean
  rebaseline(): void
  committed(): void
  inParse(): boolean
  dispose(): void
} {
  const core = (terminal as unknown as { _core: PresentationCore })._core
  const hash = new TerminalPresentationDigest()
  const signature = (): string => {
    hash.reset()
    hash.word(1) // Signature schema: length-prefixed strings and fixed-width integer fields.
    hash.word(terminal.cols)
    hash.word(terminal.rows)
    const buffer = terminal.buffer.active
    hash.text(buffer.type)
    hash.word(buffer.viewportY)
    for (let row = 0; row < terminal.rows; row++) {
      const line = core.buffer.lines.get(core.buffer.ydisp + row)
      if (!line || line._data.length < terminal.cols * 3) throw new Error('Unsupported terminal presentation line')
      for (let col = 0; col < terminal.cols; col++) {
        const offset = col * 3
        const content = line._data[offset]!
        const foreground = line._data[offset + 1]!
        const background = line._data[offset + 2]!
        hash.word(content)
        hash.word(foreground)
        hash.word(background)
        // A stale combined-string/extended-attribute cache is not displayed state.
        if (content & 0x200000) hash.text(line._combined[col] ?? '')
        if (background & 0x10000000) {
          const extra = line._extendedAttrs[col]
          hash.word(extra?.ext ?? 0)
          hash.word(extra?.urlId ?? 0)
          const imageId = extra?.imageId ?? -1
          hash.word(imageId)
          hash.word(extra?.tileId ?? -1)
          const image = storage._images.get(imageId)
          hash.word(image ? 1 : 0)
          if (image) {
            hash.word(image.orig?.width ?? 0)
            hash.word(image.orig?.height ?? 0)
            // The font-scaled `actual` bitmap is a renderer cache, not new VT work.
          }
        }
      }
    }
    const focused = core._coreBrowserService.isFocused
    const cursorHidden = core.coreService.isCursorHidden || !core.coreService.isCursorInitialized ||
      (!focused && terminal.options.cursorInactiveStyle === 'none')
    hash.word(cursorHidden ? 1 : 0)
    if (!cursorHidden) {
      hash.word(buffer.cursorX)
      hash.word(buffer.cursorY)
      hash.word(focused ? 1 : 0)
      hash.text(focused
        ? core.coreService.decPrivateModes.cursorStyle ?? terminal.options.cursorStyle ?? 'block'
        : terminal.options.cursorInactiveStyle ?? 'outline')
      hash.word(focused && (core.coreService.decPrivateModes.cursorBlink ?? terminal.options.cursorBlink) ? 1 : 0)
    }
    const selection = terminal.getSelectionPosition()
    hash.word(selection ? 1 : 0)
    if (selection) {
      hash.word(selection.start.x); hash.word(selection.start.y)
      hash.word(selection.end.x); hash.word(selection.end.y)
      hash.word(core._selectionService.columnSelectMode ? 1 : 0)
      hash.word(focused ? 1 : 0)
    }
    const colors = core._themeService.colors
    for (const key of COLOR_KEYS) {
      const color = colors[key] as { rgba: number } | undefined
      hash.word(color ? 1 : 0)
      if (color) hash.word(color.rgba)
    }
    hash.word(colors.ansi.length)
    for (const color of colors.ansi) hash.word(color.rgba)
    hash.text(terminal.options.fontFamily ?? '')
    hash.text(String(terminal.options.fontSize))
    hash.text(String(terminal.options.fontWeight))
    hash.text(String(terminal.options.fontWeightBold))
    hash.text(String(terminal.options.letterSpacing))
    hash.text(String(terminal.options.lineHeight))
    hash.text(String(terminal.options.minimumContrastRatio))
    hash.word(terminal.options.drawBoldTextInBrightColors ? 1 : 0)
    return hash.finish()
  }

  let baseline: string
  try { baseline = signature() } catch (error) { hash.dispose(); throw error }
  let pending = false
  let depth = 0
  const input = core._inputHandler
  const originalParse = input.parse
  function parse(this: InputHandler, data: string | Uint8Array, continuation?: boolean): void | Promise<boolean> {
    depth++
    try { return originalParse.call(this, data, continuation) } finally { depth-- }
  }
  input.parse = parse
  return {
    changed(): boolean {
      const current = signature()
      pending ||= current !== baseline
      baseline = current
      return pending
    },
    rebaseline(): void {
      // Grid resize/clamping is not an application redraw. Keep changes already pending.
      baseline = signature()
    },
    committed(): void {
      baseline = signature()
      pending = false
    },
    inParse(): boolean { return depth > 0 || input._parseStack.paused },
    dispose(): void {
      if (input.parse === parse) input.parse = originalParse
      hash.dispose()
    }
  }
}
