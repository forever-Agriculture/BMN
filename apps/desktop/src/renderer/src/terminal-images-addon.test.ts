// MODULE: terminal-images-addon.test.ts - Real pinned addon admission and rescale allocation boundaries
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'
import { registerTerminalImages, reserveTerminalImageBytes, terminalImageMemory } from './terminal-images'

interface Spec {
  orig: HTMLCanvasElement
  actual: HTMLCanvasElement
  origCellSize: { width: number; height: number }
  actualCellSize: { width: number; height: number }
}
interface Storage {
  _images: Map<number, Spec>
  reservedPixels: number
  reservePixels(pixels: number, protect?: Spec): (() => void) | undefined
  getUsage(): number
  getLimit(): number
  addImage(image: HTMLCanvasElement): void
}
interface AddonInternals {
  _storage: Storage
  _renderer: { _rescaleImage(spec: Spec, width: number, height: number): boolean }
  _handlers: Map<string, { _dec: unknown; unhook(success: boolean): boolean }>
}

afterEach(() => vi.unstubAllGlobals())

function fixture(sixelSupport = false): {
  addon: ImageAddon
  internal: AddonInternals
  allocations: number[]
} {
  const allocations: number[] = []
  const document = {
    createElement: () => {
      allocations.push(storage.getUsage())
      expect(storage.getUsage()).toBeLessThanOrEqual(storage.getLimit())
      return {
        width: 300, height: 150,
        getContext: () => ({ drawImage: () => undefined }),
        remove: () => undefined
      }
    }
  }
  vi.stubGlobal('document', document)
  const listen = (): { dispose(): void } => ({ dispose: () => undefined })
  const terminal = {
    cols: 80, rows: 24, options: {},
    _core: {
      open: () => undefined,
      _coreBrowserService: { window: { document } },
      optionsService: { onOptionChange: listen },
      _inputHandler: { onRequestReset: listen, lineFeed: () => undefined, _parser: { registerDcsHandler: listen } }
    },
    parser: { registerCsiHandler: listen, registerEscHandler: listen },
    onRender: listen, onResize: listen,
    buffer: { onBufferChange: listen, active: { type: 'normal' } }
  } as unknown as Terminal
  const addon = new ImageAddon({ storageLimit: 0.5, sixelSupport, iipSupport: false })
  addon.activate(terminal)
  const internal = addon as unknown as AddonInternals
  const storage = internal._storage
  return { addon, internal, allocations }
}

function plane(width: number, height: number): HTMLCanvasElement {
  return { width, height } as HTMLCanvasElement
}

function image(width = 100, height = 100): Spec {
  const orig = plane(width, height)
  return { orig, actual: orig, origCellSize: { width: 1, height: 1 }, actualCellSize: { width: 1, height: 1 } }
}

describe('maintained image addon allocation bounds', () => {
  it('rejects an oversized incoming image and frees its payload without admitting it', () => {
    const { addon, internal } = fixture()
    const payload = plane(1000, 1000)
    internal._storage.addImage(payload)
    expect(payload.width).toBe(0)
    expect(internal._storage._images.size).toBe(0)
    expect(addon.storageUsage).toBe(0)
    addon.dispose()
  })

  it('charges pending pixels and refuses limits below a live reservation', () => {
    const { addon, internal } = fixture()
    addon.storageLimit = 1
    const release = internal._storage.reservePixels(200_000)!
    expect(addon.storageUsage).toBe(0.8)
    expect(() => { addon.storageLimit = 0.5 }).toThrow('pending')
    expect(addon.storageLimit).toBe(1)
    expect(internal._storage.reservePixels(100_000)).toBeUndefined()
    release()
    release()
    expect(addon.storageUsage).toBe(0)
    addon.dispose()
  })

  it('rebalances real stores across concurrent views and retires images before returning quotas', () => {
    const views = Array.from({ length: 10 }, () => fixture())
    const unregister = views.map(({ addon }) => registerTerminalImages(addon))
    try {
      expect(views.every(({ addon }) => addon.storageLimit === 12.8)).toBe(true)
      const first = views[0]!
      const stored = image(1000, 1000)
      first.internal._storage._images.set(1, stored)
      expect(reserveTerminalImageBytes(first.addon, 12_300_000)).toBe(true)
      expect(stored.orig.width).toBe(0)
      expect(first.addon.storageUsage).toBe(0)
      expect(first.addon.storageLimit).toBe(0.5)
      expect(views.reduce((sum, view) => sum + view.addon.storageLimit * 1e6, 0) + terminalImageMemory().extraBytes).toBe(128e6)
    } finally {
      for (const { addon } of views) { addon.dispose(); reserveTerminalImageBytes(addon, 0) }
      unregister.forEach(release => release())
    }
    expect(terminalImageMemory().views).toBe(0)
  })

  it('keeps a disposed store registered until its outstanding reservation is released', () => {
    const { addon, internal } = fixture()
    const unregister = registerTerminalImages(addon)
    const release = internal._storage.reservePixels(100_000)!
    addon.dispose()
    expect(() => unregister()).toThrow('resources must be released')
    expect(terminalImageMemory().storedAndPendingBytes).toBe(400_000)
    release()
    unregister()
    expect(terminalImageMemory().views).toBe(0)
  })

  it('admits font rescaling before allocation, charges overlap and retires replaced actual images', () => {
    const { addon, internal, allocations } = fixture()
    const spec = image()
    internal._storage._images.set(1, spec)
    expect(internal._renderer._rescaleImage(spec, 2, 2)).toBe(true)
    expect(allocations).toEqual([0.2])
    expect(addon.storageUsage).toBe(0.2)
    const old = spec.actual
    expect(internal._renderer._rescaleImage(spec, 3, 3)).toBe(false)
    expect(allocations).toHaveLength(1)
    expect(spec.actual).toBe(old)
    addon.storageLimit = 1
    expect(internal._renderer._rescaleImage(spec, 3, 3)).toBe(true)
    expect(old.width).toBe(0)
    expect(addon.storageUsage).toBe(0.4)
    expect(internal._renderer._rescaleImage(spec, 1, 1)).toBe(true)
    expect(spec.actual).toBe(spec.orig)
    expect(addon.storageUsage).toBe(0.04)
    addon.dispose()
    expect(spec.orig.width).toBe(0)
  })

  it('rejects a decoded Sixel before allocating its output canvas', () => {
    const { addon, internal, allocations } = fixture(true)
    const release = vi.fn()
    internal._handlers.get('sixel')!._dec = { width: 1000, height: 1000, release }
    expect(internal._handlers.get('sixel')!.unhook(true)).toBe(true)
    expect(allocations).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
    expect(addon.storageUsage).toBe(0)
    addon.dispose()
  })
})
