import { describe, expect, it } from 'vitest'
import { evaluateInventory } from '../test/unit-inventory-gate.mjs'
import { nativeUnitOriginalBudgets } from '../test/native-unit-observations.mjs'

const root = '/repo'
const report = (files, total = 10) => ({
  numTotalTests: total,
  numPassedTests: total - files.flatMap(file => file.assertionResults).filter(test => test.status === 'failed').length,
  numPendingTests: 0,
  testResults: files
})
const file = (name, tests, status) => ({
  name: `${root}/${name}`,
  status: status ?? (tests.some(([, state]) => state === 'failed') ? 'failed' : 'passed'),
  assertionResults: tests.map(([fullName, state]) => ({ fullName, status: state }))
})
const known = { minimumTests: 5, platforms: { win32: { 'a.test.ts > owned': '53.4' } } }
const evaluate = (files, options = {}) => evaluateInventory({
  report: report(files, options.total), known, platform: options.platform ?? 'win32', root, vitestExit: options.exit ?? 1
})

describe('unit inventory gate', () => {
  it.each(nativeUnitOriginalBudgets)('keeps a passing $fullName diagnostic over its original deadline unresolved on Windows', row => {
    const key = `${row.file} > ${row.fullName}`
    const measured = file(row.file, [[row.fullName, 'passed']])
    measured.assertionResults[0].duration = row.originalBudgetMs + 1
    const input = { report: report([measured]), known: { minimumTests: 5, platforms: { win32: { [key]: '53.11' } } }, root, vitestExit: 0 }
    const result = evaluateInventory({ ...input, platform: 'win32' })
    expect(result.nowPassing).toEqual([])
    expect(result.fullSuitePassing).toBe(false)
    expect(result.diagnosticLimits).toEqual([{ key, originalBudgetMs: row.originalBudgetMs, durationMs: row.originalBudgetMs + 1 }])
    expect(result.problems).toHaveLength(1)
    expect(evaluateInventory({ ...input, platform: 'linux' }).fullSuitePassing).toBe(true)
    measured.assertionResults[0].duration = row.originalBudgetMs
    expect(evaluateInventory({ ...input, platform: 'win32' }).fullSuitePassing).toBe(true)
    delete measured.assertionResults[0].duration
    expect(evaluateInventory({ ...input, platform: 'win32' }).fullSuitePassing).toBe(false)
  })

  it('passes the gate with only story-owned failures but never calls the suite passing', () => {
    const result = evaluate([file('a.test.ts', [['owned', 'failed'], ['fine', 'passed']])])
    expect(result.problems).toEqual([])
    expect(result.openByStory).toEqual({ '53.4': 1 })
    expect(result.fullSuitePassing).toBe(false)
  })

  it('fails on an unowned failure, including on a platform with no list', () => {
    expect(evaluate([file('a.test.ts', [['new', 'failed']])]).unexpected).toEqual(['a.test.ts > new'])
    expect(evaluate([file('a.test.ts', [['owned', 'failed']])], { platform: 'linux' }).problems).toHaveLength(1)
  })

  it('treats a suite that failed without test results as an unowned failure', () => {
    expect(evaluate([file('b.test.ts', [], 'failed')]).unexpected).toEqual(['b.test.ts > (suite)'])
  })

  it('fails when vitest errors without any failing test or the run is too small', () => {
    expect(evaluate([file('a.test.ts', [['owned', 'passed']])], { exit: 1 }).problems)
      .toEqual(['vitest exited 1 without a failing test'])
    expect(evaluate([file('a.test.ts', [['owned', 'passed']])], { exit: 0, total: 2 }).problems[0]).toMatch(/expected at least 5/)
  })

  it('reports listed failures that now pass so the list shrinks', () => {
    const result = evaluate([file('a.test.ts', [['owned', 'passed']])], { exit: 0 })
    expect(result.nowPassing).toEqual(['a.test.ts > owned'])
    expect(result.problems).toEqual([])
    expect(result.fullSuitePassing).toBe(true)
  })
})
