// MODULE: terminal-image-resize.ts - Preserve a coherent Sixel scene while the terminal grid resizes
import type { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'
import { reserveTerminalImageBytes } from './terminal-images'

interface Size { width: number; height: number }
interface Dimensions {
  device: { char: Size & { left: number; top: number }; cell: Size; canvas: Size }
  css: { cell: Size; canvas: Size }
}
interface ImageLine {
  getBg(column: number): number
  _extendedAttrs: Record<number, { imageId: number; tileId: number } | undefined>
}
interface ImageSpec { orig?: HTMLCanvasElement | ImageBitmap; actual?: HTMLCanvasElement | ImageBitmap }
interface ImageRenderer {
  canvas?: HTMLCanvasElement
  _ctx?: CanvasRenderingContext2D
  cellSize: Size
  dimensions: Dimensions
  rescaleCanvas(): void
  clearLines(start: number, end: number): void
  draw(image: ImageSpec, tile: number, column: number, row: number, count: number): void
  insertLayerToDom(): void
  removeLayerFromDom(): void
}
interface ImageStorage {
  _renderer: ImageRenderer
  _images: Map<number, ImageSpec>
  addImage(image: HTMLCanvasElement | ImageBitmap, reservation?: () => void): void
  _writeToCell(line: ImageLine, column: number, id: number, tile: number): void
  render(range: { start: number; end: number }): void
}
interface DomRenderer {
  dimensions: Dimensions
  _coreBrowserService: { dpr: number }
  _charSizeService: Size
  _optionsService: { rawOptions: { letterSpacing: number; lineHeight: number } }
  _updateDimensions(): void
  handleResize(cols: number, rows: number): void
  renderRows(start: number, end: number): void
  clear(): void
  handleSelectionChanged(...args: unknown[]): void
}
interface ImageCore {
  buffer: { ydisp: number; lines: { get(row: number): ImageLine | undefined } }
  _renderService: { _renderer: { value: DomRenderer } }
  _mouseService: Record<'getCoords' | 'getMouseReportCoords', (event: { clientX: number; clientY: number }, ...args: unknown[]) => unknown>
}
interface Overflow {
  column: number
  imageId: number
  nextTile: number
  count: number
  epoch: number
}

/** Use the same current-grid coordinates as xterm's mouse reporting, including image scaling. */
export function terminalPointerCell(terminal: Terminal, event: MouseEvent): { col: number; row: number } | null {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  const bounds = screen?.getBoundingClientRect()
  if (!screen || !bounds || bounds.width <= 0 || bounds.height <= 0) return null
  const core = (terminal as unknown as { _core: ImageCore })._core
  const cell = core._mouseService.getMouseReportCoords(event, screen) as { col: number; row: number } | undefined
  return cell ? { col: cell.col, row: terminal.buffer.active.viewportY + cell.row } : null
}

interface ResizeContext {
  storage: ImageStorage
  renderer: ImageRenderer
  core: ImageCore
  dom: DomRenderer
  screen: HTMLElement
}

/** Keep ordinary text sessions on xterm's original rendering path. */
export function preserveTerminalImages(terminal: Terminal, addon: ImageAddon): {
  fit(cols: number, rows: number, apply: () => void): void
  dispose(): void
} {
  const storage = (addon as unknown as { _storage: ImageStorage })._storage
  const renderer = storage._renderer
  const core = (terminal as unknown as { _core: ImageCore })._core
  const dom = core._renderService._renderer.value
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) throw new Error('Image resize requires an open terminal screen')
  const context = { storage, renderer, core, dom, screen }
  if (storage._images.size || renderer.canvas) return installTerminalImageResize(terminal, addon, context)

  const originalAdd = storage.addImage
  let bridge: ReturnType<typeof installTerminalImageResize> | undefined
  let disposed = false
  storage.addImage = function (image, reservation): void {
    storage.addImage = originalAdd
    bridge = installTerminalImageResize(terminal, addon, context)
    storage.addImage.call(this, image, reservation)
  }
  return {
    fit(cols, rows, apply): void {
      if (bridge) bridge.fit(cols, rows, apply)
      else apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (bridge) bridge.dispose()
      else storage.addImage = originalAdd
    }
  }
}

/** Version-pinned bridge for xterm 6.0.0 and addon-image 0.9.0. No second bitmap or terminal. */
function installTerminalImageResize(terminal: Terminal, addon: ImageAddon, context: ResizeContext): {
  fit(cols: number, rows: number, apply: () => void): void
  dispose(): void
} {
  const { storage, renderer, core, dom, screen } = context
  let overflow = new WeakMap<ImageLine, Overflow>()
  let epoch = 0
  let deadline = 0
  let extent = terminal.cols
  let holding = false
  let expired = false
  let heldWidth = 0
  let heldHeight = 0
  let addingColumns: number | undefined
  let chargedBytes = 0
  let baselineCanvas: Size | undefined = renderer.canvas && { width: renderer.canvas.width, height: renderer.canvas.height }
  let allocationFailed = false
  let selection: unknown[] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // During an open synchronized update the screen still shows the last render, but an
  // erase parsed inside the update has already disposed the stored images' markers.
  let renderedImages = storage._images.size > 0
  const showingImages = (): boolean =>
    storage._images.size > 0 || (terminal.modes.synchronizedOutputMode && renderedImages)

  const original = {
    addImage: storage.addImage,
    writeToCell: storage._writeToCell,
    render: storage.render,
    rescaleCanvas: renderer.rescaleCanvas,
    clearLines: renderer.clearLines,
    insertLayer: renderer.insertLayerToDom,
    removeLayer: renderer.removeLayerFromDom,
    updateDimensions: dom._updateDimensions,
    handleResize: dom.handleResize,
    renderRows: dom.renderRows,
    clear: dom.clear,
    selection: dom.handleSelectionChanged,
    getCoords: core._mouseService.getCoords,
    getMouseReportCoords: core._mouseService.getMouseReportCoords
  }

  const reserve = (bytes: number): void => {
    if (!reserveTerminalImageBytes(addon, bytes)) throw new Error('Image resize exceeds the image memory budget')
    chargedBytes = bytes
  }
  const delta = (width: number, height: number, baseline = dom.dimensions.css.canvas): number =>
    Math.max(0, width * height - baseline.width * baseline.height) * 4

  const baselineStages = (target = dom.dimensions.css.canvas): [Size, Size, Size] => {
    const old = baselineCanvas ?? { width: 0, height: 0 }
    return [old, { width: target.width, height: old.height }, { ...target }]
  }
  const chargeHeld = (stages: Size[]): void => {
    const canvas = renderer.canvas
    if (canvas) reserve(Math.max(chargedBytes, ...stages.map(stage => delta(canvas.width, canvas.height, stage))))
  }

  const resizeCanvas = (width: number, height: number): void => {
    const canvas = renderer.canvas
    if (!canvas) return
    if (allocationFailed) throw new Error('Image output allocation failed; retire the layer before retrying')
    const [old, intermediateBaseline, targetBaseline] = baselineStages()
    const target = delta(width, height, targetBaseline)
    if (canvas.width === width && canvas.height === height) {
      reserve(target)
      baselineCanvas = targetBaseline
      return
    }
    // Each setter replaces a surface, even when assigning its current value. Match
    // the control's width/old-height stage and admit both consecutive overlaps.
    const current = Math.max(chargedBytes, delta(canvas.width, canvas.height, old))
    const intermediate = Math.max(delta(width, canvas.height, intermediateBaseline), delta(width, canvas.height, targetBaseline))
    const peak = Math.max(current + intermediate, intermediate + target)
    reserve(peak)
    try {
      canvas.width = width
      canvas.height = height
    } catch (error) {
      allocationFailed = true
      throw error
    }
    baselineCanvas = targetBaseline
    reserve(target)
  }

  const liveRows = (): Array<Overflow & { row: number }> => {
    if (performance.now() >= deadline) return []
    const rows: Array<Overflow & { row: number }> = []
    for (let row = 0; row < terminal.rows; row++) {
      const line = core.buffer.lines.get(row + core.buffer.ydisp)
      const entry = line && overflow.get(line)
      if (!line || !entry || entry.epoch !== epoch || entry.column >= terminal.cols) continue
      const attr = line._extendedAttrs[entry.column]
      if ((line.getBg(entry.column) & 268435456) && attr?.imageId === entry.imageId &&
        attr.tileId === entry.nextTile - 1 && storage._images.has(entry.imageId)) rows.push({ row, ...entry })
    }
    return rows
  }
  const scale = (): number => holding
    ? Math.min(1, dom.dimensions.css.canvas.width / heldWidth, dom.dimensions.css.canvas.height / heldHeight)
    : Math.min(1, terminal.cols / extent)
  const transform = (): void => {
    screen.style.width = `${holding ? heldWidth : extent * renderer.cellSize.width}px`
    screen.style.height = `${holding ? heldHeight : dom.dimensions.css.canvas.height}px`
    const value = scale()
    screen.style.transformOrigin = value === 1 ? '' : 'top left'
    screen.style.transform = value === 1 ? '' : `scale(${value})`
  }

  storage.addImage = function (image, reservation): void {
    addingColumns = Math.ceil(image.width / renderer.cellSize.width)
    try { original.addImage.call(this, image, reservation) } finally { addingColumns = undefined }
  }
  storage._writeToCell = function (line, column, imageId, tile): void {
    original.writeToCell.call(this, line, column, imageId, tile)
    if (addingColumns !== undefined && column === terminal.cols - 1) {
      const count = addingColumns - tile % addingColumns - 1
      if (count > 0) overflow.set(line, { column, imageId, nextTile: tile + 1, count, epoch })
      else overflow.delete(line)
    }
  }
  renderer.rescaleCanvas = (): void => {
    if (holding) {
      const stages = baselineStages()
      chargeHeld(stages)
      // The unmodified addon would rescale on this call, including calls suppressed
      // by the scene hold. Its old height can differ from our retained canvas height.
      if (renderer.canvas) baselineCanvas = stages[2]
    } else resizeCanvas(Math.ceil(extent * renderer.cellSize.width), dom.dimensions.css.canvas.height)
  }
  renderer.insertLayerToDom = function (): void {
    const existed = Boolean(this.canvas)
    original.insertLayer.call(this)
    if (!existed && this.canvas) baselineCanvas = { width: this.canvas.width, height: this.canvas.height }
  }
  renderer.removeLayerFromDom = function (): void {
    original.removeLayer.call(this)
    renderedImages = false
    baselineCanvas = undefined
    allocationFailed = false
    reserve(0)
  }
  renderer.clearLines = (start, end): void => {
    if (!holding) renderer._ctx?.clearRect(0, start * renderer.cellSize.height, renderer.canvas?.width ?? 0,
      (end + 1 - start) * renderer.cellSize.height)
  }
  storage.render = function (range): void {
    if (holding) { renderer.rescaleCanvas(); return }
    renderedImages = storage._images.size > 0
    if (storage._images.size === 0 && chargedBytes === 0 && extent === terminal.cols) {
      original.render.call(this, range)
      return
    }
    const rows = liveRows()
    const next = Math.max(terminal.cols, ...rows.map(row => row.column + 1 + row.count))
    if (extent !== next) range = { start: 0, end: terminal.rows - 1 }
    extent = next
    original.render.call(this, range)
    for (const row of rows) {
      const image = storage._images.get(row.imageId)
      if (image && row.row >= range.start && row.row <= range.end) {
        renderer.draw(image, row.nextTile, row.column + 1, row.row, row.count)
      }
    }
    transform()
  }

  dom._updateDimensions = function (): void {
    if (!holding) return original.updateDimensions.call(this)
    // DomRenderer's numeric half stays live for image decoding and the new parser grid.
    const dpr = this._coreBrowserService.dpr
    const d = this.dimensions
    d.device.char.width = this._charSizeService.width * dpr
    d.device.char.height = Math.ceil(this._charSizeService.height * dpr)
    d.device.cell.width = d.device.char.width + Math.round(this._optionsService.rawOptions.letterSpacing)
    d.device.cell.height = Math.floor(d.device.char.height * this._optionsService.rawOptions.lineHeight)
    d.device.char.left = d.device.char.top = 0
    d.device.canvas.width = d.device.cell.width * terminal.cols
    d.device.canvas.height = d.device.cell.height * terminal.rows
    d.css.canvas.width = Math.round(d.device.canvas.width / dpr)
    d.css.canvas.height = Math.round(d.device.canvas.height / dpr)
    d.css.cell.width = d.css.canvas.width / terminal.cols
    d.css.cell.height = d.css.canvas.height / terminal.rows
  }
  dom.handleResize = function (cols, rows): void {
    if (holding) this._updateDimensions()
    else original.handleResize.call(this, cols, rows)
  }
  dom.renderRows = function (start, end): void {
    if (!holding) original.renderRows.call(this, start, end)
  }
  dom.clear = function (): void { if (!holding) original.clear.call(this) }
  dom.handleSelectionChanged = function (...args): void {
    if (holding) selection = args
    else original.selection.apply(this, args)
  }
  for (const name of ['getCoords', 'getMouseReportCoords'] as const) {
    core._mouseService[name] = function (event, ...args): unknown {
      if (holding) return original[name].call(this, event, ...args)
      const ratio = scale()
      if (ratio === 1) return original[name].call(this, event, ...args)
      const rect = screen.getBoundingClientRect()
      return original[name].call(this, {
        clientX: rect.left + (event.clientX - rect.left) / ratio,
        clientY: rect.top + (event.clientY - rect.top) / ratio
      }, ...args)
    }
  }

  const release = (): void => {
    if (!holding || terminal.modes.synchronizedOutputMode) return
    holding = false
    expired = false
    original.handleResize.call(dom, terminal.cols, terminal.rows)
    if (selection) original.selection.apply(dom, selection)
    selection = undefined
    original.renderRows.call(dom, 0, terminal.rows - 1)
    terminal.refresh(0, terminal.rows - 1)
  }
  const paint = (): void => storage.render({ start: 0, end: terminal.rows - 1 })
  const parsed = terminal.onWriteParsed(() => {
    if (!terminal.modes.synchronizedOutputMode) { release(); paint() }
  })
  // The parser may stop mid-update. xterm's watchdog commits that buffer without
  // another write, so its first render must release the held text and image together.
  const rendered = terminal.onRender(() => {
    if (expired && !terminal.modes.synchronizedOutputMode) { release(); paint() }
  })

  return {
    fit(cols, rows, apply): void {
      const showing = showingImages()
      if (!holding && !showing && chargedBytes === 0) { apply(); return }
      if (cols === terminal.cols && rows === terminal.rows) { apply(); return }
      const nextHolding = holding || showing
      if (nextHolding && renderer.canvas) {
        const baseline = {
          width: Math.round(dom.dimensions.device.cell.width * cols / dom._coreBrowserService.dpr),
          height: Math.round(dom.dimensions.device.cell.height * rows / dom._coreBrowserService.dpr)
        }
        // Denial must leave the prior scene, provenance and release timer intact.
        chargeHeld(baselineStages(baseline))
      }
      const nextDeadline = holding ? deadline : performance.now() + 1000
      const nextTimer = setTimeout(() => {
        if (holding && terminal.modes.synchronizedOutputMode) { expired = true; return }
        release()
        paint()
      }, Math.max(0, nextDeadline - performance.now()))
      clearTimeout(timer)
      timer = nextTimer
      epoch++
      overflow = new WeakMap()
      if (!holding) {
        deadline = nextDeadline
        heldWidth = extent * renderer.cellSize.width
        heldHeight = terminal.rows * renderer.cellSize.height
        holding = nextHolding
      }
      // A fit may throw after touching xterm; its bounded release is already armed.
      apply()
      if (holding) transform()
      else paint()
    },
    dispose(): void {
      clearTimeout(timer)
      parsed.dispose()
      rendered.dispose()
      // This hook belongs to the view lifecycle. Retire its output before returning its quota.
      renderer.removeLayerFromDom()
      reserve(0)
      storage.addImage = original.addImage
      storage._writeToCell = original.writeToCell
      storage.render = original.render
      renderer.rescaleCanvas = original.rescaleCanvas
      renderer.clearLines = original.clearLines
      renderer.insertLayerToDom = original.insertLayer
      renderer.removeLayerFromDom = original.removeLayer
      dom._updateDimensions = original.updateDimensions
      dom.handleResize = original.handleResize
      dom.renderRows = original.renderRows
      dom.clear = original.clear
      dom.handleSelectionChanged = original.selection
      core._mouseService.getCoords = original.getCoords
      core._mouseService.getMouseReportCoords = original.getMouseReportCoords
    }
  }
}
