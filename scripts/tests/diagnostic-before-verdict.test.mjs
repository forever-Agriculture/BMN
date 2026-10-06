import { describe, expect, it } from 'vitest'
import { diagnosticBeforeVerdict } from '../lib/diagnostic-before-verdict.mjs'
describe('secondary focus evidence keeps the initial verdict', () => {
  it('still evaluates a passing first assertion after an artifact-write failure', () => {
    const reports = []
    expect(diagnosticBeforeVerdict(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }) },
      () => 'initial-pass', error => reports.push(error))).toBe('initial-pass')
    expect(reports).toEqual([{ secondary: true, code: 'EACCES' }])
  })
  it('throws the original first assertion after an artifact-write failure', () => {
    const original = new Error('initial focus was false')
    expect(() => diagnosticBeforeVerdict(() => { throw new Error('artifact failed') }, () => { throw original })).toThrow(original)
  })
})

it('still evaluates the original verdict when the secondary reporter also fails', () => {
  expect(diagnosticBeforeVerdict(() => { throw new Error('artifact failed') }, () => 'original',
    () => { throw new Error('report failed') })).toBe('original')
})
