import { describe, expect, it } from 'vitest'
import { scrolledExperimentPartial } from '../lib/scrolled-diagnostic-result.mjs'
const record = () => ({ partial: false, arms: Array.from({ length: 6 }, (_, index) => ({ index,
  arm: ['control', 'split', 'static'][index % 3], receiptCount: 1, custody: 'confirmed', profileRemoved: true,
  outcome: { code: 0, signal: null }, receipt: { selfTest: 'scrolled-diagnostic', diagnosticOnly: true,
    arm: ['control', 'split', 'static'][index % 3], graceful: true } })) })
describe('an actual SCROLLED observation is required', () => {
  it.each(['missing-verdict', 'malformed-verdict', 'false-without-original-failure'])('marks %s partial', defect => {
    const result = record()
    for (const row of result.arms) {
      if (defect === 'malformed-verdict') row.receipt.initialScrolledWithinBudget = 'yes'
      if (defect === 'false-without-original-failure') row.receipt.initialScrolledWithinBudget = false
    }
    expect(scrolledExperimentPartial(result)).toBe(true)
  })
})
