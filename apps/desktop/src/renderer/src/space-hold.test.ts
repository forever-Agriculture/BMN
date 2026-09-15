// MODULE: space-hold.test.ts - hold Space to dictate while a short press still types a space
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpaceHold, SPACE_HOLD_MS, type SpaceHoldHost, type SpaceHoldKey } from './space-hold'

const key = (partial: Partial<SpaceHoldKey> = {}): SpaceHoldKey => ({
  key: ' ',
  code: 'Space',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  ...partial
})
const letter = (character: string): SpaceHoldKey => key({ key: character, code: `Key${character.toUpperCase()}` })

let calls: string[]
let talkable: boolean

function hold() {
  const host: SpaceHoldHost = {
    typeSpace: (sessionId) => calls.push(`space:${sessionId}`),
    canTalk: (sessionId) => {
      calls.push(`can-talk:${sessionId}`)
      return talkable
    },
    startTalking: (sessionId) => calls.push(`start:${sessionId}`),
    stopTalking: () => calls.push('stop')
  }
  return createSpaceHold(host)
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  talkable = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hold Space to talk', () => {
  it('types one space for a quick tap and never opens the microphone', () => {
    const space = hold()
    expect(space.keyDown(key(), 's1')).toBe(true)
    vi.advanceTimersByTime(SPACE_HOLD_MS - 1)
    expect(calls).toEqual([])
    expect(space.keyUp(key())).toBe(true)
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(calls).toEqual(['space:s1'])
  })

  it('starts dictation after the hold threshold, swallows key repeat and stops on release', () => {
    const space = hold()
    expect(space.keyDown(key(), 's1')).toBe(true)
    vi.advanceTimersByTime(SPACE_HOLD_MS)
    expect(calls).toEqual(['can-talk:s1', 'start:s1'])
    expect(space.keyDown(key({ repeat: true }), 's1')).toBe(true)
    expect(space.keyDown(key({ repeat: true }), 's1')).toBe(true)
    expect(space.keyUp(key())).toBe(true)
    expect(calls).toEqual(['can-talk:s1', 'start:s1', 'stop'])
  })

  it('types the space before the next letter when typing overlaps the release', () => {
    const space = hold()
    space.keyDown(key(), 's1')
    calls.push('before-b')
    expect(space.keyDown(letter('b'), 's1')).toBe(false)
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual(['before-b', 'space:s1'])
  })

  it('types a held space and lets key repeat through when dictation cannot start', () => {
    talkable = false
    const space = hold()
    space.keyDown(key(), 's1')
    vi.advanceTimersByTime(SPACE_HOLD_MS)
    expect(calls).toEqual(['can-talk:s1', 'space:s1'])
    expect(space.keyDown(key({ repeat: true }), 's1')).toBe(false)
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual(['can-talk:s1', 'space:s1'])
  })

  it('leaves Space alone outside a terminal that allows hold to talk', () => {
    const space = hold()
    expect(space.keyDown(key(), null)).toBe(false)
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual([])
  })

  it('leaves modified Space, composition and other keys to the terminal', () => {
    const space = hold()
    expect(space.keyDown(key({ ctrlKey: true, shiftKey: true }), 's1')).toBe(false)
    expect(space.keyDown(key({ shiftKey: true }), 's1')).toBe(false)
    expect(space.keyDown(key({ altKey: true }), 's1')).toBe(false)
    expect(space.keyDown(key({ isComposing: true }), 's1')).toBe(false)
    expect(space.keyDown(key({ key: 'Process' }), 's1')).toBe(false)
    expect(space.keyDown(letter('a'), 's1')).toBe(false)
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual([])
  })

  it('does not start from a key repeat it never saw begin', () => {
    const space = hold()
    expect(space.keyDown(key({ repeat: true }), 's1')).toBe(false)
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(calls).toEqual([])
  })

  it('types a withheld space when the window loses focus, since no release will arrive', () => {
    const space = hold()
    space.keyDown(key(), 's1')
    space.blur()
    vi.advanceTimersByTime(SPACE_HOLD_MS * 4)
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual(['space:s1'])
  })

  it('stops dictation when the window loses focus while talking', () => {
    const space = hold()
    space.keyDown(key(), 's1')
    vi.advanceTimersByTime(SPACE_HOLD_MS)
    space.blur()
    expect(space.keyUp(key())).toBe(false)
    expect(calls).toEqual(['can-talk:s1', 'start:s1', 'stop'])
  })

  it('sends the space and the dictation to the terminal that had focus at the press', () => {
    const space = hold()
    space.keyDown(key(), 's1')
    space.keyUp(key())
    space.keyDown(key(), 's2')
    vi.advanceTimersByTime(SPACE_HOLD_MS)
    space.keyDown(key({ repeat: true }), 's1')
    space.keyUp(key())
    expect(calls).toEqual(['space:s1', 'can-talk:s2', 'start:s2', 'stop'])
  })
})
