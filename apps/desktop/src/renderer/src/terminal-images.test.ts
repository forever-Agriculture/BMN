import { describe, expect, it } from 'vitest'
import type { ImageAddon } from '@xterm/addon-image'
import { imageLimitForViews, registerTerminalImages } from './terminal-images'

describe('Sixel image storage budgeting', () => {
  it('shares 128 MiB across more than eight views and never gives one over 16 MiB', () => {
    expect(imageLimitForViews(1)).toBe(16)
    expect(imageLimitForViews(8)).toBe(16)
    expect(imageLimitForViews(9)).toBeCloseTo(128 / 9)
    expect(imageLimitForViews(16)).toBe(8)
  })

  it('rebalances all live addon limits when the ninth and tenth panes attach and detach', () => {
    const addons = Array.from({ length: 10 }, () => ({ storageLimit: 16 }))
    const release = addons.map((addon) => registerTerminalImages(addon as ImageAddon))
    expect(addons.every((addon) => addon.storageLimit === 12.8)).toBe(true)
    release[9]!()
    expect(addons.slice(0, 9).every((addon) => addon.storageLimit === 128 / 9)).toBe(true)
    release[8]!()
    expect(addons.slice(0, 8).every((addon) => addon.storageLimit === 16)).toBe(true)
    for (const dispose of release.slice(0, 8)) dispose()
  })
})
