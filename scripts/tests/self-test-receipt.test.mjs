import { describe, expect, it } from 'vitest'
import { missingSelfTestPhases, packagedReceiptComplete, requiredSelfTestPhases } from '../lib/self-test-receipt.mjs'

function completeReceipt(platform) {
  return {
    ...Object.fromEntries(requiredSelfTestPhases.map(phase => [phase, {}])),
    electronVersion: '44.3.0', nativeModules: { nodePty: true, betterSqlite3: true },
    sixelPty: { beforeMB: 0, afterMB: 1, layer: true },
    sixelRender: { ownStorageMB: 1, ownLayer: true, otherStorageMB: 0, otherImageUnchanged: true },
    cspProbe: { evalRefused: true, wasmAllowed: true },
    graphicsTerminfo: { sixelResolved: true, standardResolved: platform === 'win32' ? null : true,
      initialTerm: 'xterm-sixel-256color', fallbackTerm: 'xterm-256color' },
    graceful: true
  }
}

describe('full self-test acceptance cannot be replaced by a focused diagnostic', () => {
  it.each(['linux', 'win32'])('keeps accepting a complete ordinary %s receipt', platform => {
    const receipt = completeReceipt(platform)
    expect(missingSelfTestPhases(receipt)).toEqual([])
    expect(packagedReceiptComplete(receipt, platform)).toBe(true)
  })

  it.each(['linux', 'win32'])('rejects a %s diagnostic even when every acceptance field is populated', platform => {
    const diagnostic = { ...completeReceipt(platform), diagnosticOnly: true }
    expect(missingSelfTestPhases(diagnostic)).toContain('diagnosticOnly')
    expect(packagedReceiptComplete(diagnostic, platform)).toBe(false)
  })
})
