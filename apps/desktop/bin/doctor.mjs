// MODULE: doctor.mjs - One cross-process doctor run, durable publication and the local doctor command
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { acquireLeftoversDoctor, boundedProcess, doctorEnvironment, doctorVersions, qualifyDoctor, revalidateLeftoversDoctor, runAppDoctor, runBmnDoctor } from './doctor-adapters.mjs'
import { CHECKS, projectedResult } from './doctor-results.mjs'
import { beginDoctorAttempt, doctorPlan, doctorView, emptyDoctorState, recoverDoctorAttempt, validateDoctorState } from './doctor-state.mjs'
import { profileFingerprint, selectedProfile } from './doctor-profile.mjs'
import { observeRoute, routeUnchanged } from './doctor-locations.mjs'
import { deriveContinuityKeys, sealContinuity, validRowReceipts } from './doctor-continuity.mjs'

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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || stat.uid !== process.getuid() ||
      stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('unsafe doctor state')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error('unsafe doctor state', { cause: error })
  }
}

const revision = (stat) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')

/** An existing private ancestor protects its descendants; shared sticky /tmp may precede it. */
function stateDirectory(path, create = false) {
  const route = observeRoute(path)
  let privateAncestor = false
  for (const node of route.nodes) {
    const stat = lstatSync(node.path)
    if (![0, process.getuid()].includes(stat.uid)) throw new Error('unsafe doctor directory')
    if (!stat.isDirectory()) {
      if (!stat.isSymbolicLink()) throw new Error('unsafe doctor directory')
      continue
    }
    if (!privateAncestor && (stat.mode & 0o022) && !(stat.uid === 0 && stat.mode & 0o1000)) throw new Error('unsafe doctor directory')
    if (stat.uid === process.getuid() && !(stat.mode & 0o077)) privateAncestor = true
  }
  if (!routeUnchanged(route)) throw new Error('doctor directory changed')
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (stat.uid !== process.getuid() || !stat.isDirectory() || !create && (stat.mode & 0o777) !== 0o700) throw new Error('unsafe doctor directory')
    if (create) fchmodSync(descriptor, 0o700)
    const acquired = observeRoute(path)
    const current = lstatSync(path)
    if (stat.dev !== current.dev || stat.ino !== current.ino) throw new Error('doctor directory changed')
    return { descriptor, route: acquired }
  } catch (error) { closeSync(descriptor); throw error }
}

export function loadDoctorState(environment = process.env) {
  const paths = doctorPaths(environment)
  if (!safeFile(paths.state)) return emptyDoctorState()
  const directory = stateDirectory(paths.directory)
  let descriptor
  try {
    descriptor = openSync(`/proc/self/fd/${directory.descriptor}/doctor.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n || before.size > 1024n * 1024n) throw new Error('unsafe doctor state')
    const text = readFileSync(descriptor, 'utf8')
    if (revision(before) !== revision(fstatSync(descriptor, { bigint: true })) ||
      revision(before) !== revision(lstatSync(paths.state, { bigint: true })) || !routeUnchanged(directory.route)) throw new Error('doctor state changed')
    const state = validateDoctorState(JSON.parse(text))
    if (state === null) throw new Error('invalid doctor state')
    return state
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(directory.descriptor) }
}

export function saveDoctorState(state, environment = process.env) {
  const paths = doctorPaths(environment)
  const clean = validateDoctorState(state)
  if (clean === null) throw new Error('invalid doctor state')
  const text = `${JSON.stringify(clean)}\n`
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('doctor state bound exceeded')
  safeFile(paths.state)
  const before = (() => { try { return revision(lstatSync(paths.state, { bigint: true })) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })()
  const directory = stateDirectory(paths.directory, true)
  const temporary = `/proc/self/fd/${directory.descriptor}/.doctor-${randomUUID()}.tmp`
  let descriptor, failure = null
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, text)
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    const current = (() => { try { return revision(lstatSync(paths.state, { bigint: true })) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })()
    if (current !== before || !routeUnchanged(directory.route)) throw new Error('doctor state changed')
    renameSync(temporary, `/proc/self/fd/${directory.descriptor}/doctor.json`)
    fsyncSync(directory.descriptor)
  } catch (error) { failure = error }
  finally {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch (error) { failure ??= error } }
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') failure ??= error }
    try { closeSync(directory.descriptor) } catch (error) { failure ??= error }
  }
  if (failure) throw failure
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
  const probe = await boundedProcess('/usr/bin/flock', ['-s', '-n', '-E', '75', paths.lock, '/usr/bin/true'],
    { environment, timeoutMs: 2000, outputBytes: 1024 })
  if (probe.code === 75) return true
  if (probe.code === 0 && probe.failure === null) return false
  throw new Error('doctor lock unavailable')
}

const pendingInspections = new Map()
let inspectionQueue = Promise.resolve()
function sharedInspection(key, inspect) {
  if (pendingInspections.has(key)) return pendingInspections.get(key)
  const pending = inspectionQueue.then(inspect)
  inspectionQueue = pending.then(() => {}, () => {})
  pendingInspections.set(key, pending)
  const remove = () => { if (pendingInspections.get(key) === pending) pendingInspections.delete(key) }
  pending.then(remove, remove)
  return pending
}
const acquisitionBinding = (state) => JSON.stringify([state.profileIdentity, state.versions, state.appVersions,
  state.availabilityFailure, state.attempt, state.results.leftovers, state.continuity])

export async function readDoctorView({ environment = process.env, now = Date.now(), appVersions = null, workerPath,
  freshLocations = true, acquiredAttemptId = null } = {}) {
  try {
    let running = await lockBusy(environment)
    let state = loadDoctorState(environment)
    const binding = acquisitionBinding(state)
    const requestKey = createHash('sha256').update(JSON.stringify([binding, doctorEnvironment(environment),
      Boolean(environment.OPENCODE_CONFIG_CONTENT), appVersions, workerPath ?? null])).digest('hex')
    if (freshLocations && pendingInspections.has(requestKey)) running = false
    if (!running) recoverDoctorAttempt(state, now)
    let profile = selectedProfile(environment)
    let available = !profile.invalid && !profile.unavailable
    let profileMatches = available && (state.cycleStartedAt === null || state.profileKey !== null &&
      state.profileIdentity === profileFingerprint(profile, state.profileKey))
    let original = state.results.leftovers
    let resolution = null
    const versionsMatch = appVersions === null || Object.entries(appVersions).every(([app, version]) => version === state.appVersions[app])
    const justAcquired = state.continuity !== null && acquiredAttemptId !== null && acquiredAttemptId === state.attempt?.id &&
      state.attempt.completedNormally === true && state.attempt.finishedAt !== null &&
      state.attempt.completed.includes('leftovers') && original?.acquisitionId === acquiredAttemptId
    if (freshLocations && !justAcquired && !running && profileMatches && versionsMatch && state.continuity?.rows.length && original?.acquisitionId) {
      const keys = deriveContinuityKeys(state.profileKey, { profileBinding: state.profileIdentity, attemptId: original.acquisitionId })
      resolution = await sharedInspection(requestKey, async () => {
        if (acquisitionBinding(loadDoctorState(environment)) !== binding) return null
        const paths = ensureLock(environment)
        return await revalidateLeftoversDoctor(profile.home, environment, { ...state.appVersions, ...appVersions },
          { item: keys.item, context: keys.context }, state.continuity.rows, { workerPath, inspectionLock: paths.lock })
      })
      running = await lockBusy(environment)
      const latest = loadDoctorState(environment)
      const bindingMatches = acquisitionBinding(latest) === binding
      profile = selectedProfile(environment)
      available = !profile.invalid && !profile.unavailable
      profileMatches = available && latest.profileKey !== null && latest.profileIdentity === profileFingerprint(profile, latest.profileKey)
      if (!running) recoverDoctorAttempt(latest, now)
      state = latest; original = state.results.leftovers
      if (!bindingMatches || running || !profileMatches) resolution = null
    }
    const matches = new Map((resolution?.matches ?? []).map((match) => [match.item, match.current]))
    const acquiredItems = new Set(justAcquired ? state.continuity.rows.map((row) => row.item) : [])
    for (const row of original?.leftovers ?? []) {
      if (row.locator?.status !== 'located') continue
      if (justAcquired && acquiredItems.has(row.item) && !running && profileMatches && versionsMatch) { row.currentLocator = row.locator; continue }
      const current = matches.get(row.item)
      const fresh = current ? resolution?.result.leftovers?.[current - 1] : null
      if (fresh?.kind === row.kind && fresh.app === row.app && fresh.reason === row.reason && fresh.locator?.status === 'located') {
        row.currentLocator = fresh.locator
      } else row.locator = { ...row.locator, status: 'stale' }
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
  bmnCheck = runBmnDoctor, leftoversCheck = acquireLeftoversDoctor, save = saveDoctorState } = {}) {
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
    state.continuity = null
    if (state.availabilityFailure === null || plan.kind === 'cycle') state.availabilityFailure = { recordedAt: now(), startupId }
    for (const check of CHECKS) state.results[check] = { state: 'failed', problems: [], checkedAt: now(), version: resultIdentity }
    state.attempt.completed = [...plan.checks]
    state.attempt.completedNormally = false
    state.attempt.finishedAt = now()
    save(state, environment)
  }
  if (!scopeAvailable()) { failScope(); return }
  for (const check of plan.checks) {
    if (!scopeAvailable()) { failScope(); return }
    let result, privateRows = null
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
      } else if (check === 'leftovers') {
        const keys = deriveContinuityKeys(state.profileKey, { profileBinding: state.profileIdentity, attemptId: state.attempt.id })
        const acquired = await leftoversCheck(environment.HOME || homedir(), environment,
          Object.fromEntries(Object.entries(current.apps).map(([app, entry]) => [app, entry.version])), { item: keys.item, context: keys.context })
        if (acquired?.result && validRowReceipts(acquired.rows, acquired.result.leftovers?.length ?? 0)) {
          result = acquired.result; privateRows = acquired.rows
        } else result = acquired
      }
      else result = await bmnCheck(check, environment.HOME || homedir(), environment)
      const projected = projectedResult(result)
      if (projected === null) privateRows = null
      result = projected ?? { state: 'failed', problems: [] }
    } catch { privateRows = null; result = { state: 'failed', problems: [] } }
    if (!scopeAvailable()) { failScope(); return }
    state.results[check] = { ...result, checkedAt: now(), version: resultIdentity }
    if (check === 'leftovers') {
      state.continuity = null
      if (privateRows !== null) {
        const binding = { profileBinding: state.profileIdentity, attemptId: state.attempt.id }
        const keys = deriveContinuityKeys(state.profileKey, binding)
        state.results.leftovers.acquisitionId = state.attempt.id
        const seal = (rows) => { state.continuity = sealContinuity(rows, state.results.leftovers, binding, keys.envelope) }
        seal(privateRows)
        if (Buffer.byteLength(JSON.stringify(state)) + 1 > 1024 * 1024) {
          const old = state.results.leftovers
          const problems = old.problems.filter((p) => p.code !== 'leftover-step').map((p, i) => ({ ...p, item: i + 1 }))
          problems.push({ code: 'leftover-step', item: problems.length + 1, count: Math.min(10000, (old.problems.find((p) => p.code === 'leftover-step')?.count ?? 0) + 1) })
          state.results.leftovers = { ...old, state: 'partial', problems,
            leftovers: (old.leftovers ?? []).map((row) => ({ ...row, locator: { status: 'unresolved' } })) }
          seal([])
          if (Buffer.byteLength(JSON.stringify(state)) + 1 > 1024 * 1024) { state.results.leftovers.leftovers = []; seal([]) }
        }
      }
    }
    state.attempt.completed.push(check)
    save(state, environment)
  }
  if (!scopeAvailable()) { failScope(); return }
  state.availabilityFailure = null
  state.attempt.completedNormally = true
  state.attempt.finishedAt = now()
  save(state, environment)
}

export async function runDoctor({ environment = process.env, startupId = null } = {}) {
  const deadline = Date.now() + WAIT_MS
  const remaining = () => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error('doctor deadline exceeded')
    return left
  }
  try {
    const paths = ensureLock(environment)
    const observedAttempt = loadDoctorState(environment).attempt
    const observedId = observedAttempt?.id ?? null
    // No shell interpolation: startup and observed IDs are inert argv values.
    const program = 'import(process.argv[1]).then(m => m.doctorWorker({startupId: JSON.parse(process.argv[2]), observedId: JSON.parse(process.argv[3])})).catch(() => {process.exitCode = 3})'
    const args = [paths.lock, process.execPath, '--input-type=module', '--eval', program, import.meta.url,
      JSON.stringify(startupId), JSON.stringify(observedId)]
    const workerEnvironment = { ...environment, ELECTRON_RUN_AS_NODE: '1' }
    const worker = await boundedProcess('/usr/bin/flock', ['-n', '-E', '75', ...args],
      { environment: workerEnvironment, timeoutMs: remaining(), outputBytes: 1024 })
    if (worker.code === 75 && worker.failure === null) {
      const joinBudget = remaining()
      const joined = await boundedProcess('/usr/bin/flock', ['-s', '-w', String(joinBudget / 1000), paths.lock, '/usr/bin/true'],
        { environment, timeoutMs: joinBudget + 1000, outputBytes: 1024 })
      if (joined.failure !== null || joined.code !== 0) throw new Error('doctor join failed')
      // A reader releases this lock without publishing an attempt. A real writer changes the
      // complete snapshot even when it finishes the same ID; consume that publication directly.
      if (JSON.stringify(loadDoctorState(environment).attempt) === JSON.stringify(observedAttempt)) {
        const retryBudget = remaining()
        const retry = await boundedProcess('/usr/bin/flock', ['-w', String(retryBudget / 1000), '-E', '75', ...args],
          { environment: workerEnvironment, timeoutMs: retryBudget, outputBytes: 1024 })
        if (retry.failure !== null || retry.code !== 0) throw new Error('doctor worker retry failed')
      }
    } else if (worker.code !== 0 || worker.failure !== null) throw new Error('doctor worker failed')
    const completed = loadDoctorState(environment).attempt
    const freshlyCompleted = completed?.completedNormally === true && completed.finishedAt !== null &&
      (completed.id !== observedId || observedAttempt?.finishedAt === null)
    return await readDoctorView({ environment, freshLocations: startupId === null, acquiredAttemptId: freshlyCompleted ? completed.id : null })
  } catch {
    const view = await readDoctorView({ environment, freshLocations: false })
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
      for (const problem of row.problems) lines.push(`  ${problem.reason}. ${problem.fix}`)
      for (const item of row.leftovers) lines.push(`  Show-only: ${item.location}. ${item.reasonText}`)
    }
    if (view.rows.some((row) => row.leftovers.length > 0)) lines.push(view.locationHelp)
    if (view.error) lines.push('The doctor could not complete. Inspect the app doctor yourself.')
    out(lines.join('\n'))
  }
  return view.exitCode
}
