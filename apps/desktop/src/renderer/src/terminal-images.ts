import { ImageAddon } from '@xterm/addon-image'
import { Terminal } from '@xterm/xterm'

const VIEW_LIMIT_MB = 16
const AGGREGATE_LIMIT_MB = 128
const SIXEL_SEQUENCE_LIMIT_BYTES = 4 * 1024 * 1024

/** A 60 × 75 px red frame in Codex's DCS/raster format. */
export const SIXEL_SMOKE_FRAME = `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\`

const liveAddons = new Set<ImageAddon>()

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
  liveAddons.add(addon)
  rebalance()
  return () => {
    liveAddons.delete(addon)
    rebalance()
  }
}

function rebalance(): void {
  const limit = imageLimitForViews(liveAddons.size)
  for (const addon of liveAddons) addon.storageLimit = limit
}

let rendererCheck: Promise<boolean> | undefined

/** Run once per renderer process. No process launch waits for this check. */
export function checkSixelRenderer(): Promise<boolean> {
  rendererCheck ??= new Promise<boolean>((resolve) => {
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-10000px;top:0;width:120px;height:120px'
    document.body.appendChild(host)
    let terminal: Terminal | undefined
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      terminal?.dispose()
      host.remove()
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), 2000)
    try {
      terminal = new Terminal({ cols: 12, rows: 8, allowProposedApi: false })
      const addon = createTerminalImageAddon()
      terminal.loadAddon(addon)
      terminal.open(host)
      terminal.write(SIXEL_SMOKE_FRAME, () => finish(addon.storageUsage > 0))
    } catch {
      finish(false)
    }
  })
  return rendererCheck
}
