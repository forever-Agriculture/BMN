// MODULE: doctor-leftovers.test.ts - Show-only projection preserves predicates while withholding all source names and contents
import { describe, expect, it } from 'vitest'
import { leftoverLocation, projectLeftovers, validateLeftovers } from '../../bin/doctor-leftover-results.mjs'
import { CHECKS } from '../../bin/doctor-results.mjs'
import { doctorView, emptyDoctorState, validateDoctorState } from '../../bin/doctor-state.mjs'

const SECRET = 'sk-SYNTHETIC-NAME-123456abcdef'
const stat = { device: '1', inode: '2', size: '3', modified: '4', changed: '5', mode: '33188', type: 'file' }
const source = { locator: { status: 'located', acquisition: 1, witnesses: [], root: 'home', parent: stat, object: stat, entry: 1 } }
const empty = (): Record<string, unknown> => ({ errors: [], memory_claude: { rows: [] }, memory_codex: { rows: 0 },
  skills: { items: [] }, plugins_claude: { rows: [] }, plugins_codex: { rows: [] }, plugins_opencode: { rows: [] }, mcp: { rows: [] } })

describe('show-only leftover inventory', () => {
  it('retains candidate kinds and reasons without their paths, keys, content or credential fragments', () => {
    const report = { ...empty(), memory_claude: { rows: [{ ...source, project: 'missing', folder: SECRET }] },
      skills: { items: [{ ...source, state: 'broken-link', name: SECRET }, { ...source, verdict: 'candidate: same body seen elsewhere by every app that sees it', name: SECRET }] },
      plugins_claude: { rows: [{ ...source, class: 'disabled', id: SECRET }, { ...source, class: 'app-managed', id: SECRET }] },
      mcp: { rows: [{ ...source, app: 'codex', id: SECRET, verdict: 'candidate: program missing' }, { ...source, app: 'claude', id: SECRET, verdict: 'show-only: secret inline' }] } }
    const projected = projectLeftovers(report)
    expect(projected.state).toBe('passed')
    expect(projected.problems).toEqual([])
    expect(projected.leftovers?.map((row) => row.reason)).toEqual(['missing-project', 'broken-link', 'duplicate', 'disabled', 'app-managed', 'missing-program', 'secret-inline'])
    expect(JSON.stringify(projected)).not.toMatch(/SYNTHETIC|123456|folder|credential/)
    expect(validateLeftovers(projected.leftovers)).toEqual(projected.leftovers)
  })

  it('excludes protected worktrees, shipped/BMN skills and tools', () => {
    const projected = projectLeftovers({ ...empty(), memory_claude: { rows: [{ project: 'missing', worktree: true }] },
      skills: { items: [{ state: 'broken-link', protected: true }, { verdict: 'protected' }, { verdict: 'keep: unique' }] },
      mcp: { rows: [{ app: 'codex', verdict: 'protected: BMN tool' }] } })
    expect(projected.leftovers).toEqual([])
  })

  it('marks unreadable inventory partial while keeping available results and never forwards errors', () => {
    const projected = projectLeftovers({ ...empty(), errors: [SECRET], skills: { error: SECRET }, mcp: { rows: [{ app: 'codex', verdict: 'show-only: unreadable' }] } })
    expect(projected.state).toBe('partial')
    expect(projected.leftovers).toHaveLength(1)
    expect(JSON.stringify(projected)).not.toContain(SECRET)
    expect(validateLeftovers([{ kind: 'skills', app: null, reason: SECRET, item: 1 }])).toBeNull()
  })

  // Owner card 2026-10-22 "Show items, no locations": a location that cannot be found again is not a gap in the check.
  it('lists items whose location cannot be found as a passed check, each without a location', () => {
    const projected = projectLeftovers({ ...empty(), plugins_claude: { rows: [{ class: 'disabled' }, { class: 'app-managed' }] } })
    expect(projected).toMatchObject({ state: 'passed', problems: [] })
    expect(projected.leftovers?.map((row) => leftoverLocation(row))).toEqual(['Identity withheld · location unavailable', 'Identity withheld · location unavailable'])
  })

  it('keeps an unreadable item partial even when every section was read', () => {
    const projected = projectLeftovers({ ...empty(), mcp: { rows: [{ ...source, app: 'codex', verdict: 'show-only: unreadable' }] } })
    expect(projected.state).toBe('partial')
    expect(projected.leftovers?.[0]?.locator?.status).toBe('located')
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
