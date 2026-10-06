import { describe, expect, it } from 'vitest'
import { scrolledDiagnosticArm } from './scrolled-diagnostic'

describe('scrolled diagnostic selection', () => {
  it('cannot activate in an ordinary application run', () => {
    expect(scrolledDiagnosticArm(['--scrolled-diagnostic=split'])).toBeNull()
    expect(scrolledDiagnosticArm(['--self-test'])).toBeNull()
  })
  it('selects only one named arm in an explicit self-test', () => {
    expect(scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=control'])).toBe('control')
    expect(scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=split'])).toBe('split')
    expect(scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=static'])).toBe('static')
    expect(() => scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=other'])).toThrow('Unknown')
    expect(() => scrolledDiagnosticArm(['--self-test', '--scrolled-diagnostic=control', '--scrolled-diagnostic=split'])).toThrow('exactly one')
  })
})
