// MODULE: program-copy-toast.test.ts - the toast after a program copies to the clipboard (Story 42.1)
import { describe, expect, it } from 'vitest'
import { PROGRAM_COPY_BURST_MS, createProgramCopyBurst, programCopyMessage } from './program-copy-toast'

describe('program copy toast (Story 42.1)', () => {
  it('names the session and counts the characters', () => {
    expect(programCopyMessage('Web app — dev server', 5)).toBe('Copied from Web app — dev server (5 characters)')
    expect(programCopyMessage('nvim', 1)).toBe('Copied from nvim (1 character)')
  })

  it('shows one toast for copies less than a second apart, and a new one after a pause', () => {
    const burst = createProgramCopyBurst()
    expect(burst(10_000)).toBe('new')
    expect(burst(10_400)).toBe('same')
    // The burst runs from each copy, so a steady run of copies keeps one toast.
    expect(burst(10_400 + PROGRAM_COPY_BURST_MS - 1)).toBe('same')
    expect(burst(10_400 + 2 * PROGRAM_COPY_BURST_MS)).toBe('new')
  })
})
