// MODULE: terminal-images.ts - Sixel activation and per-view/aggregate image allocation budgets
import { ImageAddon } from '@xterm/addon-image'
import { Terminal } from '@xterm/xterm'

const VIEW_LIMIT_MB = 16
const AGGREGATE_LIMIT_MB = 128
const SIXEL_SEQUENCE_LIMIT_BYTES = 4 * 1024 * 1024

/** A 60 × 75 px red frame in Codex's DCS/raster format. */
export const SIXEL_SMOKE_FRAME = `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\`

interface ImageAllocation {
  addon: ImageAddon
  extraBytes: number
  owner: symbol
}

let liveAddons = new Map<ImageAddon, ImageAllocation>()

export function imageLimitForViews(count: number): number {
  return Math.min(VIEW_LIMIT_MB, AGGREGATE_LIMIT_MB / Math.max(1, count))
}

export function createTerminalImageAddon(): ImageAddon {
  return new ImageAddon({
    storageLimit: VIEW_LIMIT_MB,
    sixelSizeLimit: SIXEL_SEQUENCE_LIMIT_BYTES,
    pixelLimit: SIXEL_SEQUENCE_LIMIT_BYTES / 4,
    iipSupport: false,
    enableSizeReports: true,
    showPlaceholder: false
  })
}

/** The addon only exposes a per-instance limit, so rebalance on every view attach/detach. */
export function registerTerminalImages(addon: ImageAddon): () => void {
  if (liveAddons.has(addon)) throw new Error('Image addon already registered')
  const owner = Symbol('image view')
  const next = new Map(liveAddons)
  next.set(addon, { addon, extraBytes: 0, owner })
  rebalance(next)
  liveAddons = next
  return () => {
    const allocation = liveAddons.get(addon)
    if (!allocation || allocation.owner !== owner) return
    if (allocation.extraBytes !== 0 || (addon.storageUsage ?? 0) > 0) {
      throw new Error('Image resources must be released before unregistering')
    }
    const next = new Map(liveAddons)
    next.delete(addon)
    rebalance(next)
    liveAddons = next
  }
}

/** Charge extra resize surfaces and pending overlap before either canvas dimension changes. */
export function reserveTerminalImageBytes(addon: ImageAddon, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !liveAddons.has(addon)) return false
  const next = new Map(liveAddons)
  next.set(addon, { ...liveAddons.get(addon)!, extraBytes: bytes })
  try {
    rebalance(next)
    liveAddons = next
    return true
  } catch {
    return false
  }
}

/** Logical application payloads only; Chromium's private GPU allocations are not exposed here. */
export function terminalImageMemory(): { views: number; storedAndPendingBytes: number; extraBytes: number } {
  return {
    views: liveAddons.size,
    storedAndPendingBytes: [...liveAddons.keys()].reduce((sum, addon) => sum + Math.max(0, addon.storageUsage ?? 0) * 1e6, 0),
    extraBytes: [...liveAddons.values()].reduce((sum, allocation) => sum + allocation.extraBytes, 0)
  }
}

function rebalance(next: Map<ImageAddon, ImageAllocation>): void {
  const share = imageLimitForViews(next.size) * 1e6
  const limits = [...next.values()].map(({ addon, extraBytes }) => ({ addon, limit: (share - extraBytes) / 1e6 }))
  // The pinned addon requires 0.5 MB, and may not evict an in-flight allocation.
  for (const { addon, limit } of limits) {
    const pending = (addon as ImageAddon & { _storage?: { reservedPixels?: number } })._storage?.reservedPixels ?? 0
    if (limit < 0.5 || pending * 4 > limit * 1e6) throw new Error('Image memory admission refused')
  }
  const previous = limits.map(({ addon }) => ({ addon, limit: addon.storageLimit }))
  try {
    for (const { addon, limit } of limits) {
      addon.storageLimit = limit
      if (Math.max(0, addon.storageUsage ?? 0) * 1e6 > limit * 1e6 + 4) {
        throw new Error('Image storage exceeded its allocation')
      }
    }
  } catch (error) {
    for (const { addon, limit } of previous) addon.storageLimit = limit
    throw error
  }
}

let rendererCheck: Promise<boolean> | undefined

/** Run once per renderer process. No process launch waits for this check. */
export function checkSixelRenderer(): Promise<boolean> {
  rendererCheck ??= new Promise<boolean>((resolve) => {
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-10000px;top:0;width:120px;height:120px'
    document.body.appendChild(host)
    let terminal: Terminal | undefined
    let unregister = (): void => undefined
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      terminal?.dispose()
      unregister()
      host.remove()
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), 2000)
    try {
      terminal = new Terminal({ cols: 12, rows: 8, allowProposedApi: false })
      const addon = createTerminalImageAddon()
      terminal.loadAddon(addon)
      unregister = registerTerminalImages(addon)
      terminal.open(host)
      terminal.write(SIXEL_SMOKE_FRAME, () => finish(addon.storageUsage > 0))
    } catch {
      finish(false)
    }
  })
  return rendererCheck
}
