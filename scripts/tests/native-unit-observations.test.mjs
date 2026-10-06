import { expect, it } from 'vitest'
import { nativeUnitObservations, nativeObservationPattern, evaluateNativeObservation } from '../test/native-unit-observations.mjs'

const row = nativeUnitObservations[0], root = '/repo'
const report = (tests, file = row.file) => ({ testResults: [{ name: `${root}/${file}`, assertionResults: tests }] })
const passed = { fullName: row.fullName, status: 'passed', duration: 100 }
it('matches the exact Vitest runner hierarchy separately from the report name', () => {
  const pattern = new RegExp(nativeObservationPattern(row))
  expect(pattern.test(row.runnerName)).toBe(true)
  expect(pattern.test(row.fullName)).toBe(false)
  expect(pattern.test(row.runnerName + ' sibling')).toBe(false)
})
it('rejects skipped-only, duplicate, wrong-name and wrong-file observations', () => {
  for (const value of [report([{ ...passed, status: 'skipped' }]), report([passed, passed]),
    report([{ ...passed, fullName: 'another test' }]), report([passed], 'other.test.mjs')]) {
    expect(evaluateNativeObservation(value, row, root).accepted).toBe(false)
  }
  expect(evaluateNativeObservation(report([passed]), row, root)).toMatchObject({ executedExpected: true, executedCount: 1, accepted: true })
})
it('rejects an actual failure or a diagnostic exceeding or lacking its original timing evidence', () => {
  for (const test of [{ ...passed, status: 'failed' }, { ...passed, duration: row.originalBudgetMs + 1 }, { ...passed, duration: undefined }]) {
    expect(evaluateNativeObservation(report([test]), row, root)).toMatchObject({ executedExpected: true, accepted: false })
  }
})
