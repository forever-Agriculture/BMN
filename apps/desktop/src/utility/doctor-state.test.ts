// MODULE: doctor-state.test.ts - Exact cadence, crash recovery and startup-only retry contracts
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHECKS, parseCodexDoctor } from '../../bin/doctor-results.mjs'
import { DAY, beginDoctorAttempt, doctorPlan, doctorView, emptyDoctorState, recoverDoctorAttempt, validateDoctorState } from '../../bin/doctor-state.mjs'

const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)
const START = 10000
const startup = randomUUID()
function completed(): ReturnType<typeof emptyDoctorState> {
  const state = emptyDoctorState()
  beginDoctorAttempt(state, doctorPlan(state, V1, startup, START)!, { versions: V1, startupId: startup, now: START, runId: randomUUID() })
  for (const check of CHECKS) state.results[check] = { state: 'passed', problems: [], checkedAt: START + 10, version: V1 }
  state.attempt!.finishedAt = START + 10
  return state
}

describe('shared doctor schedule', () => {
  it('runs once when never started, strictly after 24 hours and after a version change', () => {
    expect(doctorPlan(emptyDoctorState(), V1, startup, START)?.checks).toEqual(CHECKS)
    const state = completed()
    expect(doctorPlan(state, V1, randomUUID(), START + DAY)).toBeNull()
    expect(doctorPlan(state, V1, null, START + DAY + 1)?.kind).toBe('cycle')
    expect(doctorPlan(state, V2, null, START + 20)?.kind).toBe('cycle')
  })

  it('consumes one failed-check retry only at a distinct startup without moving the cycle clock', () => {
    const state = completed()
    state.results.codex!.state = 'timeout'
    expect(doctorPlan(state, V1, null, START + 20)).toBeNull()
    expect(doctorPlan(state, V1, startup, START + 20)).toBeNull()
    const next = randomUUID()
    const plan = doctorPlan(state, V1, next, START + 20)!
    expect(plan).toEqual({ kind: 'retry', checks: ['codex'] })
    beginDoctorAttempt(state, plan, { versions: V1, startupId: next, now: START + 20, runId: randomUUID() })
    expect(state.cycleStartedAt).toBe(START)
    const recovered = validateDoctorState(JSON.parse(JSON.stringify(state)))!
    expect(recoverDoctorAttempt(recovered, START + 30)).toBe(true)
    expect(recovered.results.codex!.state).toBe('interrupted')
    expect(doctorPlan(recovered, V1, randomUUID(), START + 40)).toBeNull()
    expect(doctorPlan(recovered, V2, randomUUID(), START + 40)?.kind).toBe('cycle')
  })

  it('keeps each result age separate from the cycle start and suppresses old success during work', () => {
    const state = completed()
    state.results.hooks!.checkedAt = START - 100
    const view = doctorView(state, { now: START + DAY })
    expect(view.rows.find((row) => row.check === 'hooks')?.stale).toBe(true)
    expect(view.rows.find((row) => row.check === 'codex')?.stale).toBe(false)
    expect(view.allWell).toBe(false)
    expect(doctorView(completed(), { now: START + 20, running: true }).allWell).toBe(false)
    expect(doctorView(completed(), { now: START + 20 }).allWell).toBe(true)
  })

  it('does not promise a startup retry for a view-only publication omission', () => {
    const state = completed()
    state.results.leftovers!.leftovers = Array.from({ length: 1400 }, (_, i) => ({ kind: 'plugins', app: 'codex', reason: 'disabled', item: i + 1,
      locator: { status: 'located', acquisition: 4, root: 'codex-profile', parent: { device: '1', inode: '1' }, object: { device: '1', inode: '1' },
        entry: 1, line: 1, column: 1, route: Array.from({ length: 4 }, () => ({ device: '1', inode: '1', entry: 1 })) } }))
    const before = JSON.stringify(state), view = doctorView(state, { now: START + 20 })
    expect(view.rows.find(row => row.check === 'leftovers')?.state).toBe('partial')
    expect(view.retryAtNextStart).toBe(false)
    expect(doctorPlan(state, V1, randomUUID(), START + 20)).toBeNull()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('retries problem checks once, leaves permanently unsupported versions alone and preserves other findings', () => {
    const state = completed()
    state.results.claude = { state: 'problems', problems: [{ code: 'installation-check', item: 1 }], version: V1, checkedAt: START }
    state.results.codex!.state = 'unsupported'
    expect(doctorPlan(state, V1, randomUUID(), START + 20)).toEqual({ kind: 'retry', checks: ['claude'] })
    const view = doctorView(state, { now: START + 20 })
    expect(view.exitCode).toBe(3)
    expect(view.problemCount).toBe(1)
  })

  it.each([
    { label: 'unattended warning', status: 'warning', details: { TERM: 'dumb', NO_COLOR: '1' }, mixed: false },
    { label: 'terminal failure', status: 'fail', details: { TERM: 'xterm', diagnostic: 'sk-SYNTHETIC-private' }, mixed: false },
    { label: 'mixed findings', status: 'warning', details: { TERM: 'dumb' }, mixed: true }
  ])('keeps $label actionable with unattended context through saved-state publication', ({ status, details, mixed }) => {
    const checks = { 'terminal.env': { id: 'terminal.env', status, details, remediation: 'sk-SYNTHETIC-private' },
      ...(mixed ? { 'state.paths': { id: 'state.paths', status: 'fail' }, unknown: { status: 'warning' } } : {}) }
    const parsed = parseCodexDoctor(JSON.stringify({ schemaVersion: 1, overallStatus: mixed || status === 'fail' ? 'fail' : 'warning', checks }), 0)
    const state = completed()
    state.results.codex = { ...parsed, version: V1, checkedAt: START }
    const restored = validateDoctorState(JSON.parse(JSON.stringify(state)))!
    const view = doctorView(restored, { now: START + 20 })
    const published = view.rows.find(row => row.check === 'codex')!
    expect(published.state).toBe(parsed.state)
    expect(published.problems.map(({ code, item }) => ({ code, item }))).toEqual(parsed.problems)
    expect(published.problems.find(row => row.code === 'terminal-check')).toMatchObject({
      reason: 'Terminal environment needs attention',
      fix: 'Warning from BMN’s unattended check. Your interactive terminal was not assessed.'
    })
    expect(published.problems.some(row => row.code === 'additional-details')).toBe(true)
    expect(published.problems.some(row => row.code === 'state-check')).toBe(mixed)
    expect(view.problemCount).toBe(parsed.problems.length)
    expect(view.allWell).toBe(false)
    expect(view.exitCode).toBe(3)
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC')
  })

  it('rejects malformed state and projects away untrusted saved text', () => {
    const state = completed()
    expect(validateDoctorState({ ...state, cycleStartedAt: -1 })).toBeNull()
    expect(validateDoctorState({ ...state, versions: 'secret' })).toBeNull()
    const value = JSON.parse(JSON.stringify(state))
    value.results.hooks.secret = 'sk-SYNTHETIC'
    value.qualifications.unknown = { secret: 'sk-SYNTHETIC' }
    expect(JSON.stringify(validateDoctorState(value))).not.toContain('SYNTHETIC')
  })
})
