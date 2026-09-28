// MODULE: program-copy.test.ts - clipboard writes programs ask for, under the owner's setting (Story 42.1)
import type { ProgramCopyMessage, ProgramCopyNotice, ProgramCopyTarget } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { createProgramCopy } from './program-copy'

const copy = (text: string, targets: ProgramCopyTarget[] = ['clipboard']): ProgramCopyMessage =>
  ({ kind: 'program-copy', sessionId: 'session-a', targets, text })

function fake(options: { allowed?: boolean; selection?: boolean } = {}) {
  const state = { allowed: options.allowed ?? true, writes: [] as Array<[ProgramCopyTarget, string]>, notices: [] as ProgramCopyNotice[] }
  const run = createProgramCopy({
    allowed: async () => state.allowed,
    write: async (target, text) => {
      if (target === 'primary' && !options.selection) return false
      state.writes.push([target, text])
      return true
    },
    announce: (notice) => state.notices.push(notice)
  })
  return { state, run }
}

describe('program copies in main (Story 42.1)', () => {
  it('writes plain text and says how many characters, counting each emoji once', async () => {
    const { state, run } = fake()
    await run(copy('héllo 👍'))
    expect(state.writes).toEqual([['clipboard', 'héllo 👍']])
    expect(state.notices).toEqual([{ sessionId: 'session-a', characters: 7 }])
  })

  it('writes nothing and says nothing while the owner has turned it off', async () => {
    const { state, run } = fake({ allowed: false })
    await run(copy('secret'))
    expect(state).toMatchObject({ writes: [], notices: [] })
  })

  it('writes the primary selection where there is one, and ignores it elsewhere', async () => {
    const linux = fake({ selection: true })
    await linux.run(copy('both', ['clipboard', 'primary']))
    expect(linux.state.writes).toEqual([['clipboard', 'both'], ['primary', 'both']])
    const other = fake({ selection: false })
    await other.run(copy('primary only', ['primary']))
    expect(other.state).toMatchObject({ writes: [], notices: [] })
  })

  it('carries out copies in the order programs asked, even when an earlier one waits longer', async () => {
    const writes: string[] = []
    let release: () => void = () => undefined
    const first = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const run = createProgramCopy({
      allowed: async () => {
        calls += 1
        if (calls === 1) await first
        return true
      },
      write: async (_target, text) => { writes.push(text); return true },
      announce: () => undefined
    })
    const one = run(copy('first'))
    const two = run(copy('second'))
    release()
    await Promise.all([one, two])
    expect(writes).toEqual(['first', 'second'])
  })

  it('keeps going after a copy that failed', async () => {
    const writes: string[] = []
    const run = createProgramCopy({
      allowed: async () => true,
      write: async (_target, text) => {
        if (text === 'refused') throw new Error('clipboard unavailable')
        writes.push(text)
        return true
      },
      announce: () => undefined
    })
    await run(copy('refused'))
    await run(copy('after'))
    expect(writes).toEqual(['after'])
  })
})
