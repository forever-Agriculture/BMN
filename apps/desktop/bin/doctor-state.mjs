// MODULE: doctor-state.mjs - Durable doctor cadence, one startup retry and independently computed result freshness
import { CHECKS, PROBLEMS, projectedResult } from './doctor-results.mjs'
import { LEFTOVER_REASONS, leftoverLocation } from './doctor-leftover-results.mjs'
import { LOCATION_HELP } from './doctor-locations.mjs'

export const DAY = 24 * 60 * 60 * 1000
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = (value) => Number.isSafeInteger(value) && value >= 0
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const APPS = ['claude', 'codex', 'opencode']
const version = (value) => value === null || typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)

export function emptyDoctorState() {
  return { schemaVersion: 1, profileKey: null, profileIdentity: null, availabilityFailure: null, cycleStartedAt: null, versions: null, cycleStartupId: null,
    appVersions: { claude: null, codex: null, opencode: null }, retryUsed: false, attempt: null, qualifications: {}, results: {} }
}

/** Only schema values survive disk reads. Arbitrary strings in a tampered state never reach JSON or Health. */
export function validateDoctorState(value) {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.results) || !object(value.qualifications) ||
    !object(value.appVersions) || APPS.some((app) => !version(value.appVersions[app])) ||
    (value.cycleStartedAt !== null && !time(value.cycleStartedAt)) ||
    (value.versions !== null && !digest(value.versions)) || typeof value.retryUsed !== 'boolean' ||
    (value.cycleStartupId !== null && !id(value.cycleStartupId))) return null
  if (['profileKey', 'profileIdentity'].some((key) => value[key] !== undefined && value[key] !== null && !digest(value[key]))) return null
  const state = emptyDoctorState()
  state.profileKey = value.profileKey ?? null
  state.profileIdentity = value.profileIdentity ?? null
  if (value.availabilityFailure != null) {
    const failure = value.availabilityFailure
    if (!object(failure) || !time(failure.recordedAt) || (failure.startupId !== null && !id(failure.startupId))) return null
    state.availabilityFailure = { recordedAt: failure.recordedAt, startupId: failure.startupId }
  }
  Object.assign(state, { cycleStartedAt: value.cycleStartedAt, versions: value.versions,
    cycleStartupId: value.cycleStartupId, retryUsed: value.retryUsed })
  state.appVersions = Object.fromEntries(APPS.map((app) => [app, value.appVersions[app]]))
  if (value.attempt !== null) {
    const a = value.attempt
    if (!object(a) || !id(a.id) || !time(a.startedAt) || (a.finishedAt !== null && !time(a.finishedAt)) ||
      !['cycle', 'retry', 'availability'].includes(a.kind) || (a.startupId !== null && !id(a.startupId)) ||
      !Array.isArray(a.checks) || a.checks.length === 0 || new Set(a.checks).size !== a.checks.length ||
      a.checks.some((check) => !CHECKS.includes(check)) || !Array.isArray(a.completed) ||
      new Set(a.completed).size !== a.completed.length || a.completed.some((check) => !a.checks.includes(check))) return null
    state.attempt = { id: a.id, startedAt: a.startedAt, finishedAt: a.finishedAt, kind: a.kind,
      startupId: a.startupId, checks: [...a.checks], completed: [...a.completed] }
  }
  for (const check of CHECKS) {
    if (!Object.hasOwn(value.results, check)) continue
    const row = value.results[check]
    const projected = projectedResult(row)
    if (projected === null || !time(row.checkedAt) || !digest(row.version)) return null
    if (projected.leftovers?.some((item) => item.locator?.status === 'unresolved')) {
      projected.state = 'partial'
      if (!projected.problems.some((problem) => problem.code === 'additional-details')) projected.problems.push({ code: 'additional-details', item: 1 })
    }
    state.results[check] = { ...projected, checkedAt: row.checkedAt, version: row.version }
  }
  for (const app of ['claude', 'codex']) {
    if (!Object.hasOwn(value.qualifications, app)) continue
    const q = value.qualifications[app]
    if (!object(q) || !digest(q.identity) || !time(q.checkedAt) ||
      !['qualified', 'unsupported', 'failed', 'timeout'].includes(q.state)) return null
    state.qualifications[app] = { identity: q.identity, checkedAt: q.checkedAt, state: q.state }
  }
  return state
}

/** Called only after obtaining the released run lock: a journal is not evidence of a live worker. */
export function recoverDoctorAttempt(state, now) {
  if (!state.attempt || state.attempt.finishedAt !== null) return false
  for (const check of state.attempt.checks.filter((check) => !state.attempt.completed.includes(check))) state.results[check] = {
    state: 'interrupted', problems: [], checkedAt: now,
    version: state.results[check]?.version ?? state.versions
  }
  state.attempt.finishedAt = now
  return true
}

export function doctorPlan(state, versions, startupId, now) {
  if (state.cycleStartedAt === null || state.versions !== versions || now - state.cycleStartedAt > DAY) {
    return { kind: 'cycle', checks: [...CHECKS] }
  }
  if (startupId !== null && startupId !== state.cycleStartupId && startupId !== state.availabilityFailure?.startupId && !state.retryUsed) {
    const checks = CHECKS.filter((check) => !state.results[check] ||
      !['passed', 'unsupported'].includes(state.results[check].state))
    if (checks.length > 0) return { kind: 'retry', checks }
  }
  return null
}

/** Must be persisted before any child starts; a crash cannot refund the retry or reset the cadence. */
export function beginDoctorAttempt(state, plan, { versions, startupId, now, runId }) {
  if (plan.kind === 'cycle') {
    state.cycleStartedAt = now
    state.versions = versions
    state.cycleStartupId = startupId
    state.retryUsed = false
  } else if (plan.kind === 'retry') state.retryUsed = true
  state.attempt = { id: runId, startedAt: now, finishedAt: null, kind: plan.kind, startupId, checks: plan.checks, completed: [] }
  return state
}

export function doctorView(state, { now = Date.now(), running = false, versions = null, appVersions = null, profileMatches = true, error = null } = {}) {
  const changed = appVersions !== null && APPS.some((app) => Object.hasOwn(appVersions, app) && appVersions[app] !== state.appVersions[app])
  const rows = CHECKS.map((check) => {
    const row = state.results[check]
    if (!row) return { check, state: 'unqualified', problems: [], leftovers: [], checkedAt: null, stale: false }
    return { check, state: row.state, problems: row.problems.map((problem) => ({ ...problem,
      reason: PROBLEMS[problem.code][0], fix: PROBLEMS[problem.code][1] })),
      leftovers: (row.leftovers ?? []).map((item) => ({ ...item, reasonText: LEFTOVER_REASONS[item.reason], location: leftoverLocation(item) })), checkedAt: row.checkedAt,
      stale: !profileMatches || changed ||
        now - row.checkedAt > DAY || row.version !== state.versions || (versions !== null && state.versions !== versions) }
  })
  const incomplete = rows.some((row) => row.stale || !['passed', 'problems'].includes(row.state))
  const problemCount = rows.reduce((count, row) => count + row.problems.length, 0)
  const exitCode = error !== null || incomplete || running ? 3 : problemCount > 0 ? 1 : 0
  return { schemaVersion: 1, locationHelp: LOCATION_HELP, running, cycleStartedAt: state.cycleStartedAt,
    attemptStartedAt: state.attempt?.startedAt ?? null, retryUsed: state.retryUsed,
    retryAtNextStart: !state.retryUsed && rows.some((row) => ['problems', 'partial', 'failed', 'timeout', 'unqualified', 'interrupted'].includes(row.state)),
    error, rows, problemCount, allWell: exitCode === 0, exitCode }
}
