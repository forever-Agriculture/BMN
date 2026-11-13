// MODULE: native-settle.test.mjs - Epic 125.1 AC5 (review F7): no key is typed on a screen that never settles or is no longer the bare prompt
import { describe, expect, it, vi } from 'vitest'
import { settledBeforeTyping } from '../test/native-settle.mjs'

const composer = text => !/Enter to confirm/u.test(text) && text.split('\n').some(line => line.startsWith('❯'))
/** A made-up clock and a screen that shows `frames[i]` at step i, then the last frame for ever. */
const world = frames => {
  let time = 0, step = 0
  const keys = vi.fn()
  return { keys, now: () => time, sleep: async ms => { time += ms; step += 1 }, screen: async () => frames[Math.min(step, frames.length - 1)] }
}
const typeAfter = async w => { await settledBeforeTyping({ ...w, composer }); w.keys('prompt') }

describe('the first prompt of a native driver', () => {
  it('is typed once the bare prompt stood still for five seconds', async () => {
    const w = world([['starting'], ['❯ '], ['❯ ', 'tip']])
    await typeAfter(w)
    expect(w.keys).toHaveBeenCalledTimes(1)
    expect(w.now()).toBeGreaterThanOrEqual(5000)
  })

  it('is not typed when a dialog comes up over a prompt that looked ready', async () => {
    const w = world([['❯ '], ['❯ '], ['Do you trust this folder?', '❯ 1. Yes', 'Enter to confirm']])
    await expect(typeAfter(w)).rejects.toThrow(/not the app's bare prompt/u)
    expect(w.keys).not.toHaveBeenCalled()
  })

  it('is not typed on a screen that keeps changing until the limit', async () => {
    let n = 0
    const w = world([['❯ ']])
    w.screen = async () => [`❯ ${n++}`]
    await expect(typeAfter(w)).rejects.toThrow(/never stood still/u)
    expect(w.keys).not.toHaveBeenCalled()
    expect(w.now()).toBeGreaterThanOrEqual(90000)
  })
})
