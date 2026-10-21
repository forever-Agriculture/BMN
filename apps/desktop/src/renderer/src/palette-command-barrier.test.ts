// MODULE: palette-command-barrier.test.ts - Command and session scope, one-shot release, ordinary ordering.
import { describe, expect, it } from 'vitest'
import { PaletteCommandBarrier, runDeferredPaletteCommand } from './palette-command-barrier'

describe('self-test command-entry barrier', () => {
  it('holds the original command until baseline sampling, then releases exactly once', () => {
    const barrier = new PaletteCommandBarrier(), order: string[] = []
    barrier.arm('reset-modes', 'synthetic-session')
    runDeferredPaletteCommand('reset-modes', 'synthetic-session', () => order.push('command'), barrier)
    expect(barrier.state()?.phase).toBe('held'); expect(order).toEqual([])
    order.push('actual raw baseline')
    barrier.release('reset-modes', 'synthetic-session')
    expect(order).toEqual(['actual raw baseline', 'command'])
    expect(() => barrier.release('reset-modes', 'synthetic-session')).toThrow()
    expect(() => barrier.arm('reset-modes', 'synthetic-session')).toThrow()
  })
  it('refuses a missing, duplicate or wrong-session barrier', () => {
    const barrier = new PaletteCommandBarrier()
    expect(() => barrier.release('reset-modes', 'synthetic-session')).toThrow()
    barrier.arm('reset-modes', 'synthetic-session')
    expect(() => runDeferredPaletteCommand('reset-modes', 'other', () => { throw new Error('must never run') }, barrier)).toThrow('different session')
    expect(() => barrier.release('reset-modes', 'synthetic-session')).toThrow()
    const duplicate = new PaletteCommandBarrier(); duplicate.arm('reset-modes', 'synthetic-session')
    runDeferredPaletteCommand('reset-modes', 'synthetic-session', () => undefined, duplicate)
    expect(() => runDeferredPaletteCommand('reset-modes', 'synthetic-session', () => undefined, duplicate)).toThrow('duplicate')
    expect(() => duplicate.release('reset-modes', 'synthetic-session')).toThrow()
  })
  it('keeps ordinary deferred invocation synchronous and unarmed commands unchanged', () => {
    const order = ['closed']
    for (const barrier of [undefined, new PaletteCommandBarrier()]) {
      order.push('deferred entry')
      runDeferredPaletteCommand('ordinary', null, () => order.push('command'), barrier)
      order.push('callback return')
    }
    expect(order).toEqual(['closed', 'deferred entry', 'command', 'callback return', 'deferred entry', 'command', 'callback return'])
  })
})
