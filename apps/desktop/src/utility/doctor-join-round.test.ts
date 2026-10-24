// MODULE: doctor-join-round.test.ts - Acquisition cohorts, normal completion and real-lock countercases without sleeps
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

type Adapters = typeof import('../../bin/doctor-adapters.mjs')
type Run = Awaited<ReturnType<Adapters['boundedProcess']>>
type Boundary = (...args: Parameters<Adapters['boundedProcess']>) => void | Run | Promise<void | Run>
const moduleRoot = fileURLToPath(new URL(process.env.BMN_TEST_DOCTOR_BASELINE ?? '../../bin/', import.meta.url))
const homes: string[] = [], lockers: Array<{ release(): void; closed: Promise<void> }> = []
afterEach(async () => {
  for (const locker of lockers) locker.release()
  await Promise.all(lockers.splice(0).map(locker => locker.closed))
  vi.restoreAllMocks(); vi.doUnmock(`${moduleRoot}/doctor-adapters.mjs`); vi.resetModules()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function fixture() {
  vi.resetModules()
  const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-cohort-')); homes.push(home)
  const config = join(home, '.codex/config.toml'); mkdirSync(join(config, '..'), { recursive: true })
  writeFileSync(config, '[plugins.synthetic]\nenabled=false\n')
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }
  const control: { worker: Boundary | null; joined: Boundary | null; view: (() => void | Promise<void>) | null; fresh: boolean } =
    { worker: null, joined: null, view: null, fresh: false }
  const count = { worker: 0, joined: 0, revalidation: 0 }
  const workerCalls: Array<Parameters<Adapters['boundedProcess']>> = []
  vi.doMock(`${moduleRoot}/doctor-adapters.mjs`, async () => {
    const actual = await vi.importActual<Adapters>(`${moduleRoot}/doctor-adapters.mjs`)
    return { ...actual,
      boundedProcess: async (...args: Parameters<Adapters['boundedProcess']>) => {
        if (args[0] === '/usr/bin/flock' && args[1].includes('--eval')) {
          count.worker += 1; workerCalls.push(args)
          const boundary = control.worker; control.worker = null
          const override = await boundary?.(...args); if (override) return override
        } else if (args[0] === '/usr/bin/flock' && args[1][0] === '-s' && args[1][1] === '-w') {
          count.joined += 1
          const boundary = control.joined; control.joined = null
          const override = await boundary?.(...args); if (override) return override
        } else if (count.worker && args[0] === '/usr/bin/flock' && args[1].at(-1) === '/usr/bin/true' && control.view) {
          const boundary = control.view; control.view = null; await boundary()
        }
        return await actual.boundedProcess(...args)
      },
      revalidateLeftoversDoctor: async (...args: Parameters<Adapters['revalidateLeftoversDoctor']>) => {
        count.revalidation += 1
        return control.fresh ? await actual.revalidateLeftoversDoctor(...args) : null
      }
    }
  })
  const doctor = await import(`${moduleRoot}/doctor.mjs`) as typeof import('../../bin/doctor.mjs')
  const state = await import(`${moduleRoot}/doctor-state.mjs`) as typeof import('../../bin/doctor-state.mjs')
  const adapters = await import(`${moduleRoot}/doctor-adapters.mjs`) as Adapters
  const seed = async (observedId: string | null = null): Promise<void> => await doctor.doctorWorker({ environment, observedId,
    versions: () => adapters.doctorVersions(environment), qualify: async () => 'unsupported', bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  await seed()
  const paths = doctor.doctorPaths(environment)
  writeFileSync(paths.lock, '', { mode: 0o600 })
  expect(doctor.loadDoctorState(environment).continuity?.rows).toHaveLength(1)
  const privateRows = (): string => JSON.stringify(doctor.loadDoctorState(environment).continuity)
  const activate = (): string => {
    const saved = doctor.loadDoctorState(environment)
    saved.attempt!.finishedAt = null; saved.attempt!.completedNormally = false
    doctor.saveDoctorState(saved, environment); return saved.attempt!.id
  }
  const finish = (): void => {
    const saved = doctor.loadDoctorState(environment)
    saved.attempt!.completed = [...saved.attempt!.checks]; saved.attempt!.finishedAt = Date.now(); saved.attempt!.completedNormally = true
    doctor.saveDoctorState(saved, environment)
  }
  const reacquire = async (): Promise<string> => {
    const saved = doctor.loadDoctorState(environment); saved.cycleStartedAt = Date.now() - state.DAY - 1
    doctor.saveDoctorState(saved, environment); await seed(saved.attempt!.id)
    return doctor.loadDoctorState(environment).attempt!.id
  }
  const actual = await vi.importActual<Adapters>(`${moduleRoot}/doctor-adapters.mjs`)
  return { doctor, state, environment, config, paths, control, count, workerCalls, actual, activate, finish, reacquire, privateRows }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const leftover = (view: Awaited<ReturnType<Fixture['doctor']['runDoctor']>>) => view.rows.find(row => row.check === 'leftovers')!.leftovers[0]
const noPublicPrivateData = (view: unknown, fixture: Fixture): void => {
  const saved = fixture.doctor.loadDoctorState(fixture.environment), text = JSON.stringify(view)
  for (const secret of [fixture.environment.HOME, 'synthetic', 'profileKey', 'itemTag', 'contextTag', 'completedNormally', saved.profileKey!]) expect(text).not.toContain(secret)
}

async function hold(f: Fixture) {
  const child = spawn('/usr/bin/flock', ['-x', f.paths.lock, process.execPath, '-e',
    'setTimeout(()=>process.exit(0),2000);process.stdin.on("end",()=>process.exit(0));process.stdin.resume();process.stdout.write("locked\\n")'],
  { env: { ...f.environment, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
  child.stdin.on('error', () => {})
  const closed = new Promise<void>((resolve, reject) => { child.once('close', code => code === 0 ? resolve() : reject(new Error('fixture locker failed'))); child.once('error', reject) })
  const locker = { release: () => { child.stdin.end() }, closed, active: () => child.exitCode === null }; lockers.push(locker)
  await new Promise<void>((resolve, reject) => {
    let received = ''
    child.stdout.on('data', chunk => { received += String(chunk); if (received.includes('locked\n')) resolve() })
    child.once('error', reject); child.once('close', () => reject(new Error('fixture locker closed before ready')))
  })
  return locker
}

it('cohort round: an active acquisition joined through actual flock returns current coordinates with zero extra workers', async () => {
  const f = await fixture(); f.activate(); const original = f.privateRows(), locker = await hold(f)
  f.control.joined = () => { f.finish(); locker.release() }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.joined).toBe(1); expect(f.count.worker).toBe(1); expect(f.count.revalidation).toBe(0)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.privateRows()).toBe(original)
  noPublicPrivateData(view, f)
})

it('cohort round: an acquisition completing between observation and lock attempt needs no rescan', async () => {
  const f = await fixture(); f.activate(); const original = f.privateRows()
  f.control.worker = () => { f.finish() }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.joined).toBe(0); expect(f.count.revalidation).toBe(0)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.privateRows()).toBe(original)
})

it('cohort round: historical acquisition behind an actual reader lock must reconstruct and refuse a changed item', async () => {
  const f = await fixture(), original = f.privateRows(), locker = await hold(f)
  f.control.fresh = true
  f.control.joined = () => { writeFileSync(f.config, '[plugins.synthetic]\nenabled=true\n'); locker.release() }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.joined).toBe(1); expect(f.count.revalidation).toBe(1)
  expect(leftover(view)?.currentLocator).toBeUndefined(); expect(leftover(view)?.locator?.status).toBe('stale')
  expect(f.privateRows()).toBe(original); noPublicPrivateData(view, f)
  expect(f.count.worker).toBe(2)
})

it('cohort round: crash recovery after all checks were saved cannot mint normal completion', async () => {
  const f = await fixture(); f.activate(); f.control.fresh = true
  const original = f.privateRows(), view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.revalidation).toBe(1)
  expect(f.doctor.loadDoctorState(f.environment).attempt?.completedNormally).toBe(false)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.privateRows()).toBe(original)
  const plain = await f.doctor.readDoctorView({ environment: f.environment, acquiredAttemptId: f.doctor.loadDoctorState(f.environment).attempt!.id, freshLocations: false })
  expect(leftover(plain)?.currentLocator).toBeUndefined()
})

it('cohort round: a normally completed retry without Leftovers cannot certify the previous acquisition', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment), original = f.privateRows()
  f.state.beginDoctorAttempt(saved, { kind: 'retry', checks: ['codex'] }, { versions: saved.versions!, startupId: null, now: Date.now(), runId: '11111111-1111-4111-8111-111111111111' })
  f.doctor.saveDoctorState(saved, f.environment); f.control.worker = () => { f.finish() }; f.control.fresh = true
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.revalidation).toBe(1); expect(leftover(view)?.currentLocator?.status).toBe('located')
  expect(f.privateRows()).toBe(original)
})

it('cohort round: a new acquisition ID uses only its own proof and a subsequent publication invalidates eligibility', async () => {
  const f = await fixture(); const first = f.doctor.loadDoctorState(f.environment).attempt!.id
  let second = '', third = '', expected = ''
  f.control.worker = async () => { second = await f.reacquire() }
  f.control.view = async () => { third = await f.reacquire(); expected = f.privateRows() }
  f.control.fresh = true
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(second).not.toBe(first); expect(third).not.toBe(second); expect(f.count.revalidation).toBe(1)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.privateRows()).toBe(expected)
  noPublicPrivateData(view, f)
})

it('cohort round: a changed ID with its own completed acquisition returns directly', async () => {
  const f = await fixture(); let expected = ''
  f.control.worker = async () => { await f.reacquire(); expected = f.privateRows() }
  const view = await f.doctor.runDoctor({ environment: f.environment, startupId: '22222222-2222-4222-8222-222222222222' })
  expect(f.count.revalidation).toBe(0); expect(leftover(view)?.currentLocator?.status).toBe('located')
  expect(f.privateRows()).toBe(expected)
})

it.each(['worker-failure', 'worker-timeout', 'join-failure', 'join-timeout'])('cohort round: %s does not certify historical coordinates', async failure => {
  const f = await fixture(), original = f.privateRows()
  const broken: Run = { code: failure.endsWith('failure') ? 1 : null, failure: failure.endsWith('timeout') ? 'timeout' : null, stdout: '' }
  f.control.worker = () => failure.startsWith('worker') ? broken : { code: 75, failure: null, stdout: '' }
  if (failure.startsWith('join')) f.control.joined = () => broken
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(view.error).toBe('run-unavailable'); expect(f.count.revalidation).toBe(0)
  expect(leftover(view)?.currentLocator).toBeUndefined(); expect(f.privateRows()).toBe(original)
})

it('cohort round: legacy completion stays readable but never grants the shortcut', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment), original = f.privateRows()
  delete saved.attempt!.completedNormally; f.doctor.saveDoctorState(saved, f.environment)
  const plain = await f.doctor.readDoctorView({ environment: f.environment, freshLocations: false, acquiredAttemptId: saved.attempt!.id })
  expect(leftover(plain)?.currentLocator).toBeUndefined()
  f.control.fresh = true
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.revalidation).toBe(1); expect(leftover(view)?.currentLocator?.status).toBe('located')
  expect(f.privateRows()).toBe(original)
})

it('cohort round: normal completion without original authenticated receipts cannot certify coordinates', async () => {
  const f = await fixture(); f.activate()
  f.control.worker = () => {
    f.finish()
    const saved = f.doctor.loadDoctorState(f.environment); saved.continuity = null; f.doctor.saveDoctorState(saved, f.environment)
  }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.doctor.loadDoctorState(f.environment).attempt?.completedNormally).toBe(true)
  expect(f.count.revalidation).toBe(0); expect(leftover(view)?.currentLocator).toBeUndefined()
})

it.each(['receipt', 'profile'])('cohort round: invalid %s binding refuses despite a normal completion marker', async mutation => {
  const f = await fixture(), saved = JSON.parse(readFileSync(f.paths.state, 'utf8'))
  if (mutation === 'receipt') saved.continuity.rows[0].contextTag = 'f'.repeat(64)
  else saved.profileIdentity = 'f'.repeat(64)
  writeFileSync(f.paths.state, JSON.stringify(saved))
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(view.error).toBe('run-unavailable'); expect(f.count.revalidation).toBe(0)
  expect(view.rows.every(row => row.leftovers.every(item => item.currentLocator === undefined))).toBe(true)
})

it('cohort round: completion marker is private, typed and consistent with the final lifecycle', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment)
  expect(saved.attempt?.completedNormally).toBe(true)
  const invalid = (change: Record<string, unknown>) => f.state.validateDoctorState({ ...saved, attempt: { ...saved.attempt!, ...change } })
  expect(invalid({ completedNormally: 'yes' })).toBeNull()
  expect(invalid({ completedNormally: true, finishedAt: null })).toBeNull()
  expect(invalid({ completedNormally: true, completed: [] })).toBeNull()
  noPublicPrivateData(await f.doctor.readDoctorView({ environment: f.environment, freshLocations: false }), f)
})

it('cohort round: scope failure cannot publish normal completion', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment)
  saved.cycleStartedAt = Date.now() - f.state.DAY - 1; f.doctor.saveDoctorState(saved, f.environment)
  const selected = join(f.environment.HOME, '.codex'), environment = { ...f.environment, CODEX_HOME: selected }
  await f.doctor.doctorWorker({ environment, observedId: saved.attempt!.id,
    versions: async () => (await import(`${moduleRoot}/doctor-adapters.mjs`) as Adapters).doctorVersions(environment),
    bmnCheck: async () => { renameSync(selected, selected + '-moved'); return { state: 'passed', problems: [] } }
  })
  const failed = f.doctor.loadDoctorState(environment)
  expect(failed.attempt?.completedNormally).toBe(false); expect(failed.continuity).toBeNull()
  expect(failed.results.leftovers?.state).toBe('failed')
})


async function blockedWaiter(f: Fixture): Promise<void> {
  const inode = String(statSync(f.paths.lock, { bigint: true }).ino), deadline = Date.now() + 1500
  do {
    const blocked = readFileSync('/proc/locks', 'utf8').split('\n').some(line => line.includes('->') &&
      line.includes('FLOCK') && line.includes('WRITE') && line.split(/\s+/).some(field => field.endsWith(`:${inode}`)))
    if (blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  throw new Error('owned synthetic lock waiter not visible')
}

it('final review control: actual fractional flock timeout and blocked waiter are observable', async () => {
  const f = await fixture(), locker = await hold(f)
  const waiting = f.actual.boundedProcess('/usr/bin/flock', ['-w', '0.5', '-E', '75', f.paths.lock, '/usr/bin/true'],
    { environment: f.environment, timeoutMs: 1500, outputBytes: 1024 })
  await blockedWaiter(f)
  expect(locker.active()).toBe(true)
  expect(await waiting).toMatchObject({ code: 75, failure: null })
  expect(locker.active()).toBe(true); locker.release()
})

it('final review A: a not-due startup does not reconstruct discarded locations', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment)
  const startupId = '33333333-3333-4333-8333-333333333333'
  saved.cycleStartupId = startupId; f.doctor.saveDoctorState(saved, f.environment)
  const before = JSON.stringify(f.doctor.loadDoctorState(f.environment)), original = f.privateRows()
  await f.doctor.runDoctor({ environment: f.environment, startupId })
  expect(f.count.worker).toBe(1); expect(f.count.joined).toBe(0)
  expect(f.count.revalidation).toBe(0)
  expect(JSON.stringify(f.doctor.loadDoctorState(f.environment))).toBe(before); expect(f.privateRows()).toBe(original)
})

it('final review control: ordinary CLI still reconstructs unchanged historical locations', async () => {
  const f = await fixture(), original = f.privateRows(); f.control.fresh = true
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.worker).toBe(1); expect(f.count.revalidation).toBe(1)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.privateRows()).toBe(original)
  noPublicPrivateData(view, f)
})

it('final review B: a due cycle behind a reader is acquired with the remaining deadline', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment), id = saved.attempt!.id
  saved.cycleStartedAt = Date.now() - f.state.DAY - 1; f.doctor.saveDoctorState(saved, f.environment)
  const locker = await hold(f); f.control.joined = () => { locker.release() }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.worker).toBe(2)
  const completed = f.doctor.loadDoctorState(f.environment).attempt!
  expect(completed.id).not.toBe(id); expect(completed.completedNormally).toBe(true)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.count.revalidation).toBe(0)
  const retry = f.workerCalls[1]!, wait = Number(retry[1][retry[1].indexOf('-w') + 1]) * 1000
  expect(retry[1]).not.toContain('-n'); expect(retry[1]).toContain('-w')
  expect(retry[2]!.timeoutMs).toBeLessThan(720000); expect(wait).toBeLessThanOrEqual(retry[2]!.timeoutMs!)
  noPublicPrivateData(view, f)
})

it('final review R: an unchanged interrupted attempt behind a reader is durably recovered', async () => {
  const f = await fixture(), id = f.activate(), original = f.privateRows(), locker = await hold(f)
  f.control.fresh = true; f.control.joined = () => { locker.release() }
  await f.doctor.runDoctor({ environment: f.environment })
  const saved = f.doctor.loadDoctorState(f.environment)
  expect(saved.attempt?.finishedAt).not.toBeNull(); expect(saved.attempt?.completedNormally).toBe(false)
  expect(saved.attempt?.id).toBe(id); expect(f.count.worker).toBe(2); expect(f.privateRows()).toBe(original)
})

it('final review E: a second reader cannot defeat the blocking worker retry', async () => {
  const f = await fixture(), saved = f.doctor.loadDoctorState(f.environment), id = saved.attempt!.id
  saved.cycleStartedAt = Date.now() - f.state.DAY - 1; f.doctor.saveDoctorState(saved, f.environment)
  const first = await hold(f)
  f.control.joined = async () => {
    first.release(); await first.closed
    const second = await hold(f)
    f.control.worker = async (...args) => {
      const running = f.actual.boundedProcess(...args)
      try { await blockedWaiter(f); expect(second.active()).toBe(true) }
      finally { second.release() }
      return await running
    }
    return { code: 0, failure: null, stdout: '' }
  }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(f.count.worker).toBe(2)
  expect(f.doctor.loadDoctorState(f.environment).attempt?.id).not.toBe(id)
  expect(leftover(view)?.currentLocator?.status).toBe('located'); expect(f.count.revalidation).toBe(0)
})

it('final review deadline: an exhausted shared budget cannot start a retry', async () => {
  const f = await fixture(), locker = await hold(f), original = f.privateRows()
  f.control.joined = () => {
    locker.release(); const advanced = Date.now() + 720001; vi.spyOn(Date, 'now').mockReturnValue(advanced)
  }
  const view = await f.doctor.runDoctor({ environment: f.environment })
  expect(view.error).toBe('run-unavailable'); expect(f.count.worker).toBe(1); expect(f.privateRows()).toBe(original)
})
