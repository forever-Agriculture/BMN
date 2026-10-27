// MODULE: terminal-image-presentation.test.ts - Presentation changes, fit baselines and actual parser-boundary ownership
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { trackImagePresentation } from './terminal-image-presentation'

function fixture() {
  const line = {
    _data: new Uint32Array(24), _combined: {} as Record<number, string>,
    _extendedAttrs: {} as Record<number, { ext: number; urlId: number; imageId?: number; tileId?: number }>
  }
  let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  let work = (): void | Promise<boolean> => undefined
  const input = { parse: (): void | Promise<boolean> => work(), _parseStack: { paused: false } }
  const originalParse = input.parse
  const core = {
    buffer: { ydisp: 0, lines: { get: () => line } }, _inputHandler: input,
    coreService: { isCursorHidden: false, isCursorInitialized: true, decPrivateModes: {} as { cursorStyle?: string; cursorBlink?: boolean; mouseMode?: string } },
    _coreBrowserService: { isFocused: true }, _selectionService: { columnSelectMode: false },
    _themeService: { colors: { foreground: { rgba: 0xffffffff }, ansi: [{ rgba: 0x112233ff }], contrastCache: {} as Record<string, unknown> } }
  }
  const terminal = {
    cols: 2, rows: 2, _core: core,
    options: { cursorStyle: 'block', cursorInactiveStyle: 'outline', cursorBlink: false },
    buffer: { active: { type: 'alternate', viewportY: 0, cursorX: 0, cursorY: 0 } },
    getSelectionPosition: () => selection
  }
  const storage = { _images: new Map<number, { orig?: { width: number; height: number }; actual?: { width: number; height: number } }>() }
  const tracker = trackImagePresentation(terminal as unknown as Terminal, storage)
  return { terminal, core, line, storage, tracker, originalParse, input, select: (value: typeof selection) => { selection = value }, parse: (callback: typeof work) => { work = callback; return input.parse() } }
}

describe('image presentation completion', () => {
  it('ignores unchanged state, nonvisual private modes and renderer contrast-cache population', () => {
    const f = fixture()
    f.core.coreService.decPrivateModes.mouseMode = 'sgr'
    f.core._themeService.colors.contrastCache.newEntry = [1, 2, 3]
    f.parse(() => undefined)
    expect(f.tracker.changed()).toBe(false)
    f.tracker.dispose()
  })

  it.each([0, 1, 2])('detects displayed cell field %s without relying on refresh requests', field => {
    const f = fixture()
    f.line._data[field] = 42
    expect(f.tracker.changed()).toBe(true)
    f.tracker.committed()
    expect(f.tracker.changed()).toBe(false)
    f.tracker.dispose()
  })

  it('includes combined characters only when the cell actually displays them', () => {
    const f = fixture()
    f.line._combined[0] = 'stale'
    expect(f.tracker.changed()).toBe(false)
    f.line._data[0] = 0x200000
    f.tracker.committed()
    f.line._combined[0] = 'a\u0301'
    expect(f.tracker.changed()).toBe(true)
    f.tracker.dispose()
  })

  it('includes image tiles, stored presence and bitmap extent', () => {
    const f = fixture()
    f.line._data[2] = 0x10000000
    f.line._extendedAttrs[0] = { ext: 0, urlId: 0, imageId: 1, tileId: 0 }
    f.storage._images.set(1, { orig: { width: 60, height: 75 } })
    f.tracker.committed()
    f.line._extendedAttrs[0]!.tileId = 1
    expect(f.tracker.changed()).toBe(true)
    f.tracker.committed()
    f.storage._images.delete(1)
    expect(f.tracker.changed()).toBe(true)
    f.tracker.committed()
    f.storage._images.set(1, { orig: { width: 61, height: 75 } })
    expect(f.tracker.changed()).toBe(true)
    f.tracker.dispose()
  })

  it('excludes fit mutations but retains source work already pending across the fit', () => {
    const f = fixture()
    f.tracker.changed()
    f.terminal.cols = 3
    f.tracker.rebaseline()
    expect(f.tracker.changed()).toBe(false)
    f.line._data[0] = 65
    expect(f.tracker.changed()).toBe(true)
    f.terminal.cols = 4
    f.tracker.rebaseline()
    expect(f.tracker.changed()).toBe(true)
    f.tracker.committed()
    expect(f.tracker.changed()).toBe(false)
    f.tracker.dispose()
  })

  it('covers buffer, viewport, effective cursor, selection and palette changes', () => {
    const f = fixture()
    const mutations = [
      () => { f.terminal.buffer.active.type = 'normal' },
      () => { f.terminal.buffer.active.viewportY = 1 },
      () => { f.terminal.buffer.active.cursorX = 1 },
      () => { f.core.coreService.decPrivateModes.cursorStyle = 'bar' },
      () => { f.select({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }) },
      () => { f.core._coreBrowserService.isFocused = false },
      () => { f.core._themeService.colors.ansi[0]!.rgba = 0x223344ff }
    ]
    for (const mutate of mutations) {
      mutate()
      expect(f.tracker.changed()).toBe(true)
      f.tracker.committed()
    }
    f.core.coreService.isCursorHidden = true
    f.tracker.committed()
    f.terminal.buffer.active.cursorX = 0
    expect(f.tracker.changed()).toBe(false)
    f.tracker.dispose()
  })

  it('preserves the actual parser return and observes synchronous and paused parsing', async () => {
    const f = fixture()
    expect(f.tracker.inParse()).toBe(false)
    const promise = Promise.resolve(true)
    const returned = f.parse(() => {
      expect(f.tracker.inParse()).toBe(true)
      f.input._parseStack.paused = true
      return promise
    })
    expect(returned).toBe(promise)
    expect(f.tracker.inParse()).toBe(true)
    await returned
    f.input._parseStack.paused = false
    expect(f.tracker.inParse()).toBe(false)
    f.tracker.dispose()
    expect(f.input.parse).toBe(f.originalParse)
  })
})
