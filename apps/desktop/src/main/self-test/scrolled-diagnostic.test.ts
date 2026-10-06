import { describe, expect, it } from 'vitest'
import { scrolledDiagnosticArm } from './scrolled-diagnostic'

describe('scrolled diagnostic selection', () => {
  it('cannot activate in an ordinary application run', () => {
    expect(scrolledDiagnosticArm(['--scrolled-diagnostic=without-fixture'])).toBeNull()
    expect(scrolledDiagnosticArm(['--self-test'])).toBeNull()
  })
  it('selects only one named arm in an explicit self-test', () => {
    expect(scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=with-fixture'])).toBe('with-fixture')
    expect(scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=without-fixture'])).toBe('without-fixture')
    expect(() => scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=other'])).toThrow('Unknown')
    expect(() => scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=with-fixture', '--scrolled-diagnostic=without-fixture'])).toThrow('exactly one')
  })
})
