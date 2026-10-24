// MODULE: agent-replay.test.mjs - Story 91.1 AC3: the calibration load's screens are the same for one seed and carry what an agent's screen does
import { describe, expect, it } from 'vitest'
import { random, sixel, statusFrame, styledLine } from '../measure/agent-replay.mjs'
import { sessionPlan } from '../measure/calibration-load.mjs'

// What a terminal shows once the escape sequences are taken out.
const SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'gu')
const visible = (text) => text.replace(SEQUENCE, '')

describe('calibration load (Story 91.1 AC3)', () => {
  it('writes the same lines for one seed, in plain, 256-colour, true-colour, bold, italic and underlined words', () => {
    const lines = (seed) => { const next = random(seed); return Array.from({ length: 50 }, () => styledLine(next, 100)) }
    expect(lines(7)).toEqual(lines(7))
    expect(lines(7)).not.toEqual(lines(8))
    const all = lines(7).join('\n')
    for (const style of ['\u001b[38;5;', '\u001b[38;2;', '\u001b[1m', '\u001b[3m', '\u001b[4m']) expect(all).toContain(style)
    for (const line of lines(7)) expect(visible(line).length).toBeLessThanOrEqual(100)
  })

  it('redraws the status inside one synchronized update and draws a Sixel image of whole bands', () => {
    const frame = statusFrame('codex', 3, 12, 0)
    expect(frame.startsWith('\u001b[?2026h')).toBe(true)
    expect(frame.endsWith('\u001b[?2026l')).toBe(true)
    expect(visible(frame)).toContain('Working (12s')
    expect(visible(statusFrame('claude', 0, 4, 90))).toContain('Thinking… (4s · ↓ 90 tokens')
    // The working word carries one true colour per character, and the highlight moves with the frame.
    expect(statusFrame('claude', 0, 4, 90).split('\u001b[38;2;')).toHaveLength('Thinking…'.length + 1)
    expect(statusFrame('claude', 1, 4, 90)).not.toBe(statusFrame('claude', 2, 4, 90))
    const image = sixel(48)
    expect(image.startsWith('\u001bPq')).toBe(true)
    expect(image.endsWith('\u001b\\')).toBe(true)
    expect(image.split('-')).toHaveLength(8)
  })

  it('reads the sessions as agents in order and refuses an unknown one', () => {
    expect(sessionPlan('claude=2,codex=1,shell=0')).toEqual(['claude', 'claude', 'codex'])
    expect(() => sessionPlan('cursor=1')).toThrow('cursor=1 is not agent=count')
  })
})
