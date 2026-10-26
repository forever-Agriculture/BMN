// MODULE: terminal-images.test.ts - Image storage, resize reservations and aggregate admission
import { describe, expect, it } from 'vitest'
import type { ImageAddon } from '@xterm/addon-image'
import { imageLimitForViews, registerTerminalImages, reserveTerminalImageBytes, terminalImageMemory } from './terminal-images'

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

  it('reserves a resize surface before its allocation and restores storage on retirement', () => {
    const addon = { storageLimit: 16, storageUsage: 0 } as ImageAddon
    const release = registerTerminalImages(addon)
    expect(reserveTerminalImageBytes(addon, 3_600_000)).toBe(true)
    expect(addon.storageLimit).toBe(12.4)
    expect(terminalImageMemory()).toEqual({ views: 1, storedAndPendingBytes: 0, extraBytes: 3_600_000 })
    expect(() => release()).toThrow('resources must be released')
    expect(reserveTerminalImageBytes(addon, 0)).toBe(true)
    expect(addon.storageLimit).toBe(16)
    release()
    expect(terminalImageMemory().views).toBe(0)
  })

  it('refuses aggregate admission atomically when a held surface leaves no minimum storage', () => {
    const addons = Array.from({ length: 8 }, () => ({ storageLimit: 16, storageUsage: 0 }) as ImageAddon)
    const releases = addons.map(registerTerminalImages)
    expect(reserveTerminalImageBytes(addons[0]!, 15_500_000)).toBe(true)
    expect(() => registerTerminalImages({ storageLimit: 16, storageUsage: 0 } as ImageAddon)).toThrow('admission refused')
    expect(terminalImageMemory().views).toBe(8)
    expect(addons[0]!.storageLimit).toBe(0.5)
    expect(addons.slice(1).every(addon => addon.storageLimit === 16)).toBe(true)
    reserveTerminalImageBytes(addons[0]!, 0)
    releases.forEach(release => release())
  })

  it('counts extra surfaces inside the shared 128 MB and refuses oversized or pending conflicts', () => {
    const addons = Array.from({ length: 10 }, () => ({ storageLimit: 16, storageUsage: 0 }) as ImageAddon)
    const releases = addons.map(registerTerminalImages)
    for (const addon of addons) expect(reserveTerminalImageBytes(addon, 1_000_000)).toBe(true)
    expect(addons.reduce((sum, addon) => sum + addon.storageLimit * 1e6, 0) + terminalImageMemory().extraBytes).toBe(128e6)
    expect(reserveTerminalImageBytes(addons[0]!, 13_000_000)).toBe(false)
    expect(addons[0]!.storageLimit).toBe(11.8)
    for (const addon of addons) reserveTerminalImageBytes(addon, 0)
    releases.forEach(release => release())
    const pending = { storageLimit: 16, storageUsage: 4, _storage: { reservedPixels: 1_000_000 } } as unknown as ImageAddon
    const release = registerTerminalImages(pending)
    expect(reserveTerminalImageBytes(pending, 13_000_000)).toBe(false)
    expect(pending.storageLimit).toBe(16)
    Object.assign(pending, { storageUsage: 0, _storage: { reservedPixels: 0 } })
    release()
  })

  it('retains ownership across duplicate release callbacks and pending resource teardown', () => {
    const addon = { storageLimit: 16, storageUsage: 1 } as ImageAddon
    const oldRelease = registerTerminalImages(addon)
    expect(() => oldRelease()).toThrow('resources must be released')
    Object.assign(addon, { storageUsage: 0 })
    oldRelease()
    const release = registerTerminalImages(addon)
    oldRelease()
    expect(terminalImageMemory().views).toBe(1)
    release()
    expect(terminalImageMemory().views).toBe(0)
  })
})
