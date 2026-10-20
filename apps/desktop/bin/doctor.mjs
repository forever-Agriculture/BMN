// MODULE: doctor.mjs - One cross-process doctor run, durable publication and the local doctor command
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { boundedProcess, doctorVersions, qualifyDoctor, runAppDoctor, runBmnDoctor, runLeftoversDoctor } from './doctor-adapters.mjs'
import { CHECKS, PROBLEMS, projectedResult } from './doctor-results.mjs'
import { beginDoctorAttempt, doctorPlan, doctorView, emptyDoctorState, recoverDoctorAttempt, validateDoctorState } from './doctor-state.mjs'
import { writeAtomically } from './safe-config-write.mjs'
import { profileFingerprint, selectedProfile } from './doctor-profile.mjs'
import { locationRoots, resolveLocation } from './doctor-locations.mjs'

const WAIT_MS = 12 * 60 * 1000
const UUID = /^[a-f0-9-]{36}$/
const HELP = `Usage: bmn doctor [--json]

Reports BMN's read-only hooks, skills, tools and rules checks and the qualified Claude/Codex doctors.
Runs when never started, strictly after 24 hours or when an app version changes; joins a run in progress.
BMN retries failed or problem checks once at its next startup. Reading from the CLI does not consume that retry.
New doctor versions qualify on a disposable profile before a read-only real-profile run. Leftovers are show-only.
Works with BMN closed. No cleanup command.
Exit: 0 all applicable checks fresh and passed; 1 problems; 2 usage; 3 incomplete, unavailable or stale checks.`

export function doctorPaths(environment = process.env) {
  const home = environment.HOME ?? homedir()
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0') || home === '/') throw new Error('invalid doctor home')
  const directory = join(home, '.config/bmn/agents/state')
  return { directory, state: join(directory, 'doctor.json'), lock: join(directory, 'doctor.lock') }
}

function safeFile(path) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('unsafe doctor state')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error('unsafe doctor state', { cause: error })
  }
}

export function loadDoctorState(environment = process.env) {
  const paths = doctorPaths(environment)
  if (!safeFile(paths.state)) return emptyDoctorState()
  const state = validateDoctorState(JSON.parse(readFileSync(paths.state, 'utf8')))
  if (state === null) throw new Error('invalid doctor state')
  return state
}

export function saveDoctorState(state, environment = process.env) {
  const paths = doctorPaths(environment)
  const clean = validateDoctorState(state)
  if (clean === null) throw new Error('invalid doctor state')
  safeFile(paths.state)
  mkdirSync(paths.directory, { recursive: true })
  writeAtomically(paths.state, `${JSON.stringify(clean)}\n`, () => { safeFile(paths.state) })
  const readback = loadDoctorState(environment)
  if (JSON.stringify(readback) !== JSON.stringify(clean)) throw new Error('doctor state readback differs')
}

function ensureLock(environment) {
  const paths = doctorPaths(environment)
  mkdirSync(paths.directory, { recursive: true })
  if (!safeFile(paths.lock)) {
    try { closeSync(openSync(paths.lock, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  safeFile(paths.lock)
  return paths
}

async function lockBusy(environment) {
  const paths = doctorPaths(environment)
  if (!safeFile(paths.lock)) return false
  const probe = await boundedProcess('/usr/bin/flock', ['-n', '-E', '75', paths.lock, '/usr/bin/true'],
    { environment, timeoutMs: 2000, outputBytes: 1024 })
  if (probe.code === 75) return true
  if (probe.code === 0 && probe.failure === null) return false
  throw new Error('doctor lock unavailable')
}

export async function readDoctorView({ environment = process.env, now = Date.now(), appVersions = null } = {}) {
  try {
    const running = await lockBusy(environment)
    const state = loadDoctorState(environment)
    if (!running) recoverDoctorAttempt(state, now)
    const profile = selectedProfile(environment)
    const available = !profile.invalid && !profile.unavailable
    const profileMatches = available && (state.cycleStartedAt === null || state.profileKey !== null &&
      state.profileIdentity === profileFingerprint(profile, state.profileKey))
    // Coordinates remain from the observed source; a replacement can never acquire an old identity.
    const roots = locationRoots(profile)
    const locations = new Map()
    const budget = { remaining: 10000 }
    for (const row of state.results.leftovers?.leftovers ?? []) {
      if (row.locator?.status !== 'located') continue
      const key = JSON.stringify(row.locator)
      if (!locations.has(key)) locations.set(key, resolveLocation(row.locator, roots, budget) !== null)
      if (!locations.get(key)) row.locator = { ...row.locator, status: 'stale' }
    }
    return doctorView(state, { now, running, appVersions, profileMatches,
      error: !available ? 'profile-unavailable' : profileMatches ? null : 'profile-changed' })
  } catch {
    return doctorView(emptyDoctorState(), { now, error: 'state-unavailable' })
  }
}

/** Runs only as flock's child. Tests inject synthetic adapters through this function, never an environment switch. */
export async function doctorWorker({ environment = process.env, startupId = null, observedId = null,
  now = Date.now, versions = doctorVersions, qualify = qualifyDoctor, appCheck = runAppDoctor,
  bmnCheck = runBmnDoctor, leftoversCheck = runLeftoversDoctor, save = saveDoctorState } = {}) {
  const state = loadDoctorState(environment)
  // A run completed between the caller's read and its lock acquisition: consume it, never queue another.
  if ((state.attempt?.id ?? null) !== observedId) return
  if (recoverDoctorAttempt(state, now())) save(state, environment)
  const current = await versions(environment)
  mkdirSync(doctorPaths(environment).directory, { recursive: true })
  state.profileKey ??= randomBytes(32).toString('hex')
  const profile = selectedProfile(environment)
  const profileIdentity = profileFingerprint(profile, state.profileKey)
  const resultIdentity = createHash('sha256').update(`${current.identity}:${profileIdentity}`).digest('hex')
  // Availability is not a new identity: a permission toggle cannot reset cadence or refund a retry.
  const scopeAvailable = () => {
    const selected = selectedProfile(environment)
    return !selected.invalid && !selected.unavailable && profileFingerprint(selected, state.profileKey) === profileIdentity
  }
  let plan = doctorPlan(state, resultIdentity, startupId, now())
  if (!scopeAvailable() && state.availabilityFailure === null && plan?.kind !== 'cycle') {
    plan = { kind: 'availability', checks: [...CHECKS] }
  }
  if (plan === null) return
  state.profileIdentity = profileIdentity
  beginDoctorAttempt(state, plan, { versions: resultIdentity, startupId, now: now(), runId: randomUUID() })
  state.appVersions = Object.fromEntries(Object.entries(current.apps).map(([app, entry]) => [app, entry.version]))
  save(state, environment)
  const failScope = () => {
    if (state.availabilityFailure === null || plan.kind === 'cycle') state.availabilityFailure = { recordedAt: now(), startupId }
    for (const check of CHECKS) state.results[check] = { state: 'failed', problems: [], checkedAt: now(), version: resultIdentity }
    state.attempt.completed = [...plan.checks]
    state.attempt.finishedAt = now()
    save(state, environment)
  }
  if (!scopeAvailable()) { failScope(); return }
  for (const check of plan.checks) {
    if (!scopeAvailable()) { failScope(); return }
    let result
    try {
      if (check === 'claude' || check === 'codex') {
        const entry = current.apps[check]
        let qualification = state.qualifications[check]
        if (qualification?.identity !== entry.identity || ['failed', 'timeout'].includes(qualification.state)) {
          qualification = { identity: entry.identity, checkedAt: now(), state: await qualify(check, entry, environment) }
          state.qualifications[check] = qualification
          save(state, environment)
        }
        if (!scopeAvailable()) { failScope(); return }
        result = qualification.state === 'qualified'
          ? await appCheck(check, entry, environment.HOME || homedir(), environment)
          : { state: qualification.state === 'timeout' ? 'timeout' : qualification.state === 'failed' ? 'failed' : 'unsupported', problems: [] }
      } else if (check === 'leftovers') result = await leftoversCheck(environment.HOME || homedir(), environment,
        Object.fromEntries(Object.entries(current.apps).map(([app, entry]) => [app, entry.version])))
      else result = await bmnCheck(check, environment.HOME || homedir(), environment)
      result = projectedResult(result) ?? { state: 'failed', problems: [] }
    } catch { result = { state: 'failed', problems: [] } }
    if (!scopeAvailable()) { failScope(); return }
    state.results[check] = { ...result, checkedAt: now(), version: resultIdentity }
    state.attempt.completed.push(check)
    save(state, environment)
  }
  if (!scopeAvailable()) { failScope(); return }
  state.availabilityFailure = null
  state.attempt.finishedAt = now()
  save(state, environment)
}

export async function runDoctor({ environment = process.env, startupId = null } = {}) {
  try {
    const paths = ensureLock(environment)
    const observedId = loadDoctorState(environment).attempt?.id ?? null
    // No shell interpolation: startup and observed IDs are inert argv values.
    const program = 'import(process.argv[1]).then(m => m.doctorWorker({startupId: JSON.parse(process.argv[2]), observedId: JSON.parse(process.argv[3])})).catch(() => {process.exitCode = 3})'
    const worker = await boundedProcess('/usr/bin/flock', ['-n', '-E', '75', paths.lock,
      process.execPath, '--input-type=module', '--eval', program, import.meta.url,
      JSON.stringify(startupId), JSON.stringify(observedId)], { environment: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: WAIT_MS, outputBytes: 1024 })
    if (worker.code === 75 && worker.failure === null) {
      const joined = await boundedProcess('/usr/bin/flock', ['-s', '-w', String(WAIT_MS / 1000), paths.lock, '/usr/bin/true'],
        { environment, timeoutMs: WAIT_MS + 1000, outputBytes: 1024 })
      if (joined.failure !== null || joined.code !== 0) throw new Error('doctor join failed')
    } else if (worker.code !== 0 || worker.failure !== null) throw new Error('doctor worker failed')
    return await readDoctorView({ environment })
  } catch {
    const view = await readDoctorView({ environment })
    return { ...view, error: 'run-unavailable', allWell: false, exitCode: 3 }
  }
}

export async function runDoctorCommand(args, { environment = process.env, out = (text) => process.stdout.write(`${text}\n`) } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { out(HELP); return 0 }
  let startupId = null
  let json = false
  const seen = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (seen.has(arg)) { out(HELP); return 2 }
    seen.add(arg)
    if (arg === '--json') json = true
    else if (arg === '--startup' && UUID.test(args[index + 1] ?? '')) startupId = args[++index]
    else { out(HELP); return 2 }
  }
  const view = await runDoctor({ environment, startupId })
  if (json) out(JSON.stringify(view))
  else {
    const lines = [view.running ? 'Checking now' : view.allWell ? `All well · ${CHECKS.length} checks passed` : 'Doctor needs attention']
    for (const row of view.rows) {
      if (row.state === 'passed' && !row.stale && row.leftovers.length === 0) continue
      lines.push(`${row.check}: ${row.state}${row.stale ? ' · stale' : ''}`)
      for (const problem of row.problems) lines.push(`  ${PROBLEMS[problem.code][0]}. ${PROBLEMS[problem.code][1]}`)
      for (const item of row.leftovers) lines.push(`  Show-only: ${item.location}. ${item.reasonText}`)
    }
    if (view.rows.some((row) => row.leftovers.length > 0)) lines.push(view.locationHelp)
    if (view.error) lines.push('The doctor could not complete. Inspect the app doctor yourself.')
    out(lines.join('\n'))
  }
  return view.exitCode
}
