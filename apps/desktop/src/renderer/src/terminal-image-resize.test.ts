// MODULE: terminal-image-resize.test.ts - Held scene lifecycle and preallocation resize reservations
import { afterEach, describe, expect, it, vi } from 'vitest'
import testSource from './terminal-image-resize.test.ts?raw'
import type { Terminal } from '@xterm/xterm'
import type { ImageAddon } from '@xterm/addon-image'
import { preserveTerminalImages } from './terminal-image-resize'

const budget = vi.hoisted(() => ({ charge: 0, limit: 16_000_000, trace: [] as number[] }))
vi.mock('./terminal-images', () => ({
  reserveTerminalImageBytes: (_addon: unknown, bytes: number) => {
    budget.trace.push(bytes)
    if (bytes > budget.limit) return false
    budget.charge = bytes
    return true
  }
}))

afterEach(() => { vi.useRealTimers(); budget.charge = 0; budget.trace = []; budget.limit = 16_000_000 })

function fixture(images = true, output = true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const screen = { style: { width: '', height: '', transform: '', transformOrigin: '' }, getBoundingClientRect: () => ({ left: 50, top: 70 }) }
  let width = 1000, height = 1000
  const setters: Array<{ size: number[]; charge: number }> = []
  let failedSetter: 'width' | 'height' | undefined
  const canvas = {
    get width() { return width },
    set width(value: number) { setters.push({ size: [value, height], charge: budget.charge }); if (failedSetter === 'width') throw Error('allocation failed'); width = value },
    get height() { return height },
    set height(value: number) { setters.push({ size: [width, value], charge: budget.charge }); if (failedSetter === 'height') throw Error('allocation failed'); height = value }
  }
  const dimensions = { device: { char: { width: 10, height: 20, left: 0, top: 0 }, cell: { width: 10, height: 20 }, canvas: { width, height } }, css: { cell: { width: 10, height: 20 }, canvas: { width, height } } }
  let parsed = (): void => undefined
  let rendered = (): void => undefined
  const line = {
    _extendedAttrs: {} as Record<number, { imageId: number; tileId: number }>,
    getBg(column: number): number { return line._extendedAttrs[column] ? 268435456 : 0 }
  }
  const dom = {
    dimensions, _coreBrowserService: { dpr: 1 }, _charSizeService: { width: 10, height: 20 },
    _optionsService: { rawOptions: { letterSpacing: 0, lineHeight: 1 } },
    _updateDimensions() {
      dimensions.css.canvas = { width: terminal.cols * 10, height: terminal.rows * 20 }
      screen.style.width = dimensions.css.canvas.width + 'px'
      screen.style.height = dimensions.css.canvas.height + 'px'
    },
    handleResize: vi.fn<(cols: number, rows: number) => void>(() => dom._updateDimensions()), renderRows: vi.fn(), clear: vi.fn(), handleSelectionChanged: vi.fn<(...args: unknown[]) => void>(() => undefined)
  }
  const renderer = {
    canvas: output ? canvas : undefined, cellSize: dimensions.css.cell, dimensions,
    _ctx: { clearRect: vi.fn() },
    rescaleCanvas() { canvas.width = terminal.cols * 10; canvas.height = terminal.rows * 20 },
    clearLines: vi.fn(), draw: vi.fn(), insertLayerToDom: vi.fn(), removeLayerFromDom: vi.fn(() => { width = height = 0 })
  }
  const storage = {
    _renderer: renderer, _images: new Map(images ? [[1, {}]] : []),
    // Pinned ImageStorage.addImage writes consecutive tiles through the last visible cell.
    addImage: vi.fn<(image: HTMLCanvasElement, reservation?: () => void) => void>((image) => {
      storage._images.set(1, {})
      for (let column = 0; column < Math.min(terminal.cols, Math.ceil(image.width / renderer.cellSize.width)); column++) {
        storage._writeToCell(line, column, 1, column)
      }
    }),
    _writeToCell: vi.fn((target: typeof line, column: number, imageId: number, tileId: number): void => {
      target._extendedAttrs[column] = { imageId, tileId }
    }),
    render: vi.fn<(range?: { start: number; end: number }) => void>(() => { if (storage._images.size) renderer.canvas = canvas; renderer.rescaleCanvas() })
  }
  const mouse = { getCoords: vi.fn((event: { clientX: number; clientY: number }) => event), getMouseReportCoords: vi.fn((event: { clientX: number; clientY: number }) => event) }
  const terminal = {
    cols: 100, rows: 50, modes: { synchronizedOutputMode: false },
    element: { querySelector: () => screen },
    _core: { buffer: { ydisp: 0, lines: { get: (row: number) => row === 0 ? line : undefined } }, _renderService: { _renderer: { value: dom } }, _mouseService: mouse },
    onWriteParsed: vi.fn((callback: () => void) => { parsed = callback; return { dispose: vi.fn() } }),
    onRender: vi.fn((callback: () => void) => { rendered = callback; return { dispose: vi.fn() } }), refresh: vi.fn()
  }
  const spies = Object.freeze({ addImage: storage.addImage, render: storage.render, writeToCell: storage._writeToCell, updateDimensions: dom._updateDimensions, getCoords: mouse.getCoords, getMouseReportCoords: mouse.getMouseReportCoords, handleResize: dom.handleResize, renderRows: dom.renderRows, clear: dom.clear, handleSelectionChanged: dom.handleSelectionChanged, removeLayer: renderer.removeLayerFromDom })
  const hooks = preserveTerminalImages(terminal as unknown as Terminal, { _storage: storage } as unknown as ImageAddon)
  const fit = (cols: number, rows: number) => hooks.fit(cols, rows, () => {
    dom.clear(); terminal.cols = cols; terminal.rows = rows; dom.handleResize(cols, rows)
  })
  return { hooks, fit, terminal, storage, renderer, dom, spies, screen, mouse, setters, parsed: () => parsed(), rendered: () => rendered(), failAllocation: (setter: 'width' | 'height' = 'width') => { failedSetter = setter } }
}

describe('image scene resize boundary', () => {
  it('leaves every ordinary rendering and mouse method untouched until the first image', () => {
    const f = fixture(false, false)
    expect(f.spies.renderRows).toBe(f.dom.renderRows)
    expect(f.spies.clear).toBe(f.dom.clear)
    expect(f.spies.handleResize).toBe(f.dom.handleResize)
    expect(f.dom._updateDimensions).toBe(f.spies.updateDimensions)
    expect(f.spies.handleSelectionChanged).toBe(f.dom.handleSelectionChanged)
    expect(f.storage.render).toBe(f.spies.render)
    expect(f.storage._writeToCell).toBe(f.spies.writeToCell)
    expect(f.mouse.getCoords).toBe(f.spies.getCoords)
    expect(f.mouse.getMouseReportCoords).toBe(f.spies.getMouseReportCoords)
    expect(f.terminal.onWriteParsed).not.toHaveBeenCalled()
    expect(f.terminal.onRender).not.toHaveBeenCalled()
    f.fit(50, 40)
    expect(f.screen.style).toMatchObject({ width: '500px', height: '800px', transform: '' })
    expect(vi.getTimerCount()).toBe(0)
    expect(budget.trace).toEqual([])
    f.hooks.dispose()
    expect(f.storage.addImage).toBe(f.spies.addImage)
    expect(f.spies.removeLayer).not.toHaveBeenCalled()
  })

  it('activates before the first image tiles and passes the original reservation through', () => {
    const f = fixture(false, false)
    f.fit(50, 40)
    const image = { width: 400 } as HTMLCanvasElement
    const reservation = vi.fn()
    f.storage.addImage(image, reservation)
    expect(f.spies.addImage).toHaveBeenCalledExactlyOnceWith(image, reservation)
    expect(f.terminal.onWriteParsed).toHaveBeenCalledOnce()
    expect(f.terminal.onRender).toHaveBeenCalledOnce()
    f.storage.render({ start: 0, end: 39 })
    expect(f.screen.style.width).toBe('500px')
    expect(f.screen.style.transform).toBe('')
    expect(f.storage._writeToCell).not.toBe(f.spies.writeToCell)
    f.fit(40, 30)
    f.storage.addImage({ width: 800 } as HTMLCanvasElement)
    f.parsed()
    expect(f.renderer.draw).toHaveBeenCalledWith({}, 40, 40, 0, 40)
    expect(f.spies.renderRows).toHaveBeenCalledWith(0, 29)
    f.hooks.dispose()
    expect(f.storage.addImage).toBe(f.spies.addImage)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts eagerly when a prior image or an existing output layer needs retirement', () => {
    for (const [images, output] of [[true, false], [false, true]]) {
      const f = fixture(images, output)
      expect(f.spies.renderRows).not.toBe(f.dom.renderRows)
      expect(f.terminal.onWriteParsed).toHaveBeenCalledOnce()
      f.hooks.dispose()
      expect(f.spies.removeLayer).toHaveBeenCalledOnce()
    }
  })

  it('asserts wrapped-method calls only through the frozen original spies', () => {
    expect(testSource).not.toMatch(/expect\(f\.dom\.(?:handleResize|renderRows|clear|handleSelectionChanged)/)
  })
  it('keeps the original scene across repeated resize and releases text/image and styles together', () => {
    const f = fixture()
    f.fit(80, 25)
    expect(f.screen.style).toMatchObject({ width: '1000px', height: '1000px', transform: 'scale(0.5)' })
    vi.advanceTimersByTime(400)
    f.fit(50, 40)
    expect(f.screen.style).toMatchObject({ width: '1000px', height: '1000px', transform: 'scale(0.5)' })
    expect(f.spies.handleResize).not.toHaveBeenCalled()
    f.dom.handleSelectionChanged([1, 2], [3, 4], false)
    f.parsed()
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.spies.renderRows).toHaveBeenCalledWith(0, 39)
    expect(f.spies.handleSelectionChanged).toHaveBeenCalledWith([1, 2], [3, 4], false)
    expect(f.screen.style).toMatchObject({ width: '500px', height: '800px', transform: '', transformOrigin: '' })
    expect(budget.charge).toBe(0)
    f.hooks.dispose()
  })

  it('does not renew the fixed one-second cap on repeated resize', () => {
    const f = fixture()
    f.fit(80, 25); vi.advanceTimersByTime(900); f.fit(50, 40)
    vi.advanceTimersByTime(99)
    expect(f.spies.handleResize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.screen.style.transform).toBe('')
    f.hooks.dispose()
  })

  it('preserves native current-grid events while the previous scene is held', () => {
    const f = fixture()
    const event = { clientX: 75, clientY: 100, shiftKey: true, button: 0 }
    f.fit(80, 25)
    expect(f.mouse.getCoords(event)).toBe(event)
    expect(f.mouse.getMouseReportCoords(event)).toBe(event)
    f.parsed()
    expect(f.mouse.getCoords(event)).toBe(event)
    f.hooks.dispose()
  })

  it('leaves redraw and selection live when the first hold admission is denied', () => {
    const f = fixture()
    budget.limit = 0
    expect(() => f.fit(80, 25)).toThrow('Image resize exceeds')
    expect([f.terminal.cols, f.terminal.rows]).toEqual([100, 50])
    expect(budget.charge).toBe(0)
    f.dom.clear()
    f.dom.renderRows(0, 49)
    f.dom.handleSelectionChanged([1, 2], [3, 4], false)
    expect(f.spies.clear).toHaveBeenCalledOnce()
    expect(f.spies.renderRows).toHaveBeenCalledWith(0, 49)
    expect(f.spies.handleSelectionChanged).toHaveBeenCalledWith([1, 2], [3, 4], false)
    vi.advanceTimersByTime(3000)
    expect(vi.getTimerCount()).toBe(0)
    budget.limit = 16_000_000
    f.fit(80, 25)
    vi.advanceTimersByTime(1000)
    expect(f.screen.style.transform).toBe('')
    f.hooks.dispose()
    expect(budget.charge).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves an existing hold, its image provenance and deadline after denied repeated admission', () => {
    const f = fixture()
    f.fit(80, 25)
    f.storage.addImage({ width: 1000 } as HTMLCanvasElement)
    vi.advanceTimersByTime(300)
    const before = budget.charge
    budget.limit = before + 100_000
    expect(() => f.fit(10, 5)).toThrow('Image resize exceeds')
    expect([f.terminal.cols, f.terminal.rows]).toEqual([80, 25])
    expect(budget.charge).toBe(before)
    budget.limit = 16_000_000
    f.parsed()
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.screen.style.width).toBe('1000px')
    expect(f.screen.style.transform).toBe('scale(0.8)')
    vi.advanceTimersByTime(700)
    expect(f.screen.style.width).toBe('800px')
    expect(f.screen.style.transform).toBe('')
    f.hooks.dispose()
  })

  it('arms bounded release before a fit operation can throw without later output', () => {
    const f = fixture()
    expect(() => f.hooks.fit(80, 25, () => { throw Error('fit failed') })).toThrow('fit failed')
    vi.advanceTimersByTime(1000)
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.spies.renderRows).toHaveBeenCalledWith(0, 49)
    expect(f.screen.style.transform).toBe('')
    f.fit(80, 25)
    f.hooks.dispose()
    vi.advanceTimersByTime(3000)
    expect(vi.getTimerCount()).toBe(0)
    expect(budget.charge).toBe(0)
  })

  it.each(['parsed', 'rendered'] as const)('waits for a coherent %s commit if the update outlasts the resize cap', (commit) => {
    const f = fixture()
    f.fit(80, 25)
    vi.advanceTimersByTime(800)
    f.terminal.modes.synchronizedOutputMode = true
    f.parsed()
    vi.advanceTimersByTime(250)
    expect(f.screen.style).toMatchObject({ width: '1000px', height: '1000px', transform: 'scale(0.5)' })
    expect(f.spies.handleResize).not.toHaveBeenCalled()
    expect(f.spies.renderRows).not.toHaveBeenCalled()
    f.terminal.modes.synchronizedOutputMode = false
    f[commit]()
    expect(f.screen.style).toMatchObject({ width: '800px', height: '500px', transform: '' })
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.spies.renderRows).toHaveBeenCalledWith(0, 24)
    f.rendered()
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    f.hooks.dispose()
  })

  it('reserves held payload and intermediate width/old-height overlap before setters', () => {
    const f = fixture()
    f.fit(50, 40)
    expect(budget.charge).toBe(2_400_000)
    f.parsed()
    // Simulate a font/geometry change opposing width and height without another retained bitmap.
    f.renderer.cellSize.width = 40
    f.dom.dimensions.css.canvas = { width: 500, height: 800 }
    f.renderer.rescaleCanvas()
    const last = f.setters.at(-2)!
    expect(last.size).toEqual([2000, 800])
    expect(last.charge).toBeGreaterThanOrEqual((2000 * 800 - 500 * 800) * 4)
    f.hooks.dispose()
    expect(budget.charge).toBe(0)
    expect(f.spies.removeLayer).toHaveBeenCalledOnce()
  })

  it('keeps its reservation when an allocation setter throws, and retires it at teardown', () => {
    const f = fixture()
    f.fit(50, 40); f.failAllocation()
    expect(() => f.parsed()).toThrow('allocation failed')
    expect(budget.charge).toBe(2_800_000)
    f.hooks.dispose()
    expect(budget.charge).toBe(0)
  })

  it('reserves both old and new extra payload at the height setter after width growth', () => {
    const f = fixture()
    f.fit(100, 40)
    f.parsed()
    expect(budget.charge).toBe(0)
    // A late old-grid image extends 40 columns beyond the current 100-column grid.
    f.storage.addImage({ width: 1400 } as HTMLCanvasElement)
    f.storage.render()
    expect(f.screen.style.width).toBe('1400px')
    expect(f.setters.at(-1)!.size).toEqual([1400, 800])
    expect(f.mouse.getCoords({ clientX: 75, clientY: 100 })).toEqual({ clientX: 85, clientY: 112 })
    // Resetting height also replaces the width-expanded surface. Both positive deltas coexist.
    expect(f.setters.at(-1)!.charge).toBeGreaterThanOrEqual(2 * (1400 - 1000) * 800 * 4)
    f.hooks.dispose()
  })

  it.each([
    { name: 'height growth', initial: [70, 20] as const, repeated: false, peak: 1_560_000 },
    { name: 'opposing dimensions', initial: [100, 20] as const, repeated: false, peak: 1_560_000 },
    { name: 'repeated held resize', initial: [100, 40] as const, repeated: true, peak: 4_160_000 }
  ])('accounts for matching baseline stages during $name', ({ initial, repeated, peak }) => {
    const f = fixture()
    f.fit(initial[0], initial[1]); f.parsed()
    if (repeated) { f.fit(70, 20); f.storage.render() }
    f.fit(70, 45)
    f.storage.addImage({ width: 1000 } as HTMLCanvasElement)
    const before = f.setters.length
    f.parsed()
    expect(f.setters.slice(before).map(entry => entry.charge)).toEqual([peak, peak])
    expect(budget.charge).toBe(1_080_000)
    f.hooks.dispose()
  })

  it('rejects the complete overlap before either output setter', () => {
    const f = fixture()
    f.fit(70, 20); f.parsed(); f.fit(70, 45)
    f.storage.addImage({ width: 1000 } as HTMLCanvasElement)
    const before = f.setters.length
    budget.limit = 1_200_000
    expect(() => f.parsed()).toThrow('Image resize exceeds')
    expect(f.setters).toHaveLength(before)
    f.hooks.dispose()
  })

  it.each(['width', 'height'] as const)('retains the staged peak after a %s exception through later calls', setter => {
    const f = fixture()
    f.fit(70, 20); f.parsed(); f.fit(70, 45)
    f.storage.addImage({ width: 1000 } as HTMLCanvasElement)
    f.failAllocation(setter)
    expect(() => f.parsed()).toThrow('allocation failed')
    expect(budget.charge).toBe(1_560_000)
    const before = f.setters.length
    expect(() => f.renderer.rescaleCanvas()).toThrow()
    expect(f.setters).toHaveLength(before)
    expect(budget.charge).toBe(1_560_000)
    f.hooks.dispose()
    expect(budget.charge).toBe(0)
  })

  it('holds the committed image scene when an open update has already erased every stored image', () => {
    const f = fixture()
    f.storage.render({ start: 0, end: 49 })
    f.terminal.modes.synchronizedOutputMode = true
    // xterm disposes the image's line marker as soon as the update's erase is parsed.
    f.storage._images.clear()
    f.fit(80, 25)
    expect(f.spies.clear).not.toHaveBeenCalled()
    expect(f.spies.handleResize).not.toHaveBeenCalled()
    expect(f.screen.style).toMatchObject({ width: '1000px', height: '1000px', transform: 'scale(0.5)' })
    f.terminal.modes.synchronizedOutputMode = false
    f.storage._images.set(1, {})
    f.parsed()
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.screen.style).toMatchObject({ width: '800px', height: '500px', transform: '' })
    f.hooks.dispose()
  })

  it('keeps an open update after a committed frame without images on the original resize path', () => {
    const f = fixture()
    f.storage._images.clear()
    f.storage.render({ start: 0, end: 49 })
    f.terminal.modes.synchronizedOutputMode = true
    f.fit(80, 25)
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(f.screen.style.transform).toBe('')
    f.hooks.dispose()
  })

  it('leaves ordinary no-image resize on the original path without reservations or transforms', () => {
    const f = fixture(false)
    f.fit(80, 25)
    expect(f.spies.clear).toHaveBeenCalledOnce()
    expect(f.spies.handleResize).toHaveBeenCalledOnce()
    expect(budget.trace).toEqual([])
    expect(f.screen.style.transform).toBe('')
    f.hooks.dispose()
  })
})
