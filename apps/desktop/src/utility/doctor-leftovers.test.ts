// MODULE: doctor-leftovers.test.ts - Show-only projection preserves predicates while withholding all source names and contents
import { describe, expect, it } from 'vitest'
import { validateLeftovers } from '../../bin/doctor-leftover-results.mjs'
import { CHECKS } from '../../bin/doctor-results.mjs'
import { doctorView, emptyDoctorState, validateDoctorState } from '../../bin/doctor-state.mjs'

describe('show-only leftover inventory', () => {
  it('validates only fixed reason facts and discards arbitrary identity fields', () => {
    const value = [{ kind: 'mcp', app: 'codex', reason: 'missing-program', item: 1, name: 'sk-SYNTHETIC-NAME', path: '/ordinary' }]
    expect(validateLeftovers(value)).toEqual([{ kind: 'mcp', app: 'codex', reason: 'missing-program', item: 1, identity: 'withheld', locator: { status: 'unresolved' } }])
    expect(validateLeftovers([{ ...value[0], reason: 'sk-SYNTHETIC-NAME' }])).toBeNull()
  })

  it('keeps a saved passed check passed when its items have no location', () => {
    const state = emptyDoctorState()
    state.versions = 'a'.repeat(64)
    for (const check of CHECKS) state.results[check] = { state: 'passed', problems: [], checkedAt: 1000, version: state.versions }
    state.results.leftovers!.leftovers = [{ kind: 'plugins', app: 'claude', reason: 'disabled', item: 1, identity: 'withheld', locator: { status: 'unresolved' } }]
    const read = validateDoctorState(JSON.parse(JSON.stringify(state)))
    expect(read?.results.leftovers).toMatchObject({ state: 'passed', problems: [] })
    expect(doctorView(read!, { now: 1100 }).allWell).toBe(true)
  })

  it('does not turn leftovers into problems or suppress an otherwise fresh All well', () => {
    const state = emptyDoctorState()
    state.versions = 'a'.repeat(64)
    for (const check of CHECKS) state.results[check] = { state: 'passed', problems: [], checkedAt: 1000, version: state.versions }
    state.results.leftovers!.leftovers = [{ kind: 'plugins', app: 'claude', reason: 'disabled', item: 1 }]
    const view = doctorView(state, { now: 1100 })
    expect(view.allWell).toBe(true)
    expect(view.problemCount).toBe(0)
    expect(view.rows.find((row) => row.check === 'leftovers')?.leftovers[0]?.reasonText).toContain('deliberately retained')
  })
})
