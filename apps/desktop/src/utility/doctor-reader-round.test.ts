// MODULE: doctor-reader-round.test.ts - Saved projection, one actual shared worker and publication invalidation
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const moduleRoot = fileURLToPath(new URL(process.env.BMN_TEST_DOCTOR_BASELINE ?? '../../bin/', import.meta.url))
const homes: string[] = []
afterEach(() => { vi.doUnmock(`${moduleRoot}/doctor-adapters.mjs`); vi.resetModules(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const versions = async () => ({ identity: 'a'.repeat(64), apps: Object.fromEntries(['claude', 'codex', 'opencode'].map(app => [app,
  { executable: null, version: null, identity: 'b'.repeat(64) }])) })
function deferred() { let resolve = (): void => {}; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function lockPeer(path: string, mode: '-s' | '-x', home: string) {
  const program = 'process.stdout.write("r\\n"); process.stdin.once("data", () => process.exit(0)); setTimeout(() => process.exit(1), 2000)'
  const peer = spawn('/usr/bin/flock', [mode, '-n', '-E', '75', path, process.execPath, '--eval', program],
    { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let ended = false
  peer.stdin.on('error', () => {})
  const closed = new Promise<number | null>(resolve => peer.once('close', code => { ended = true; resolve(code) }))
  const release = async (): Promise<void> => {
    if (!peer.stdin.destroyed) peer.stdin.end('\n')
    expect(await closed, 'the bounded fixture peer must exit normally').toBe(0)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let text = ''
      peer.stdout.on('data', chunk => { text += String(chunk); if (text.includes('r\n')) resolve() })
      peer.once('error', reject)
      peer.once('close', () => reject(new Error('fixture peer closed before readiness')))
    })
    return { alive: () => !ended, release }
  } catch (error) { await release(); throw error }
}

async function fixture(gate: Promise<void>, probeDone?: () => void, started?: () => void) {
  vi.resetModules()
  const home = mkdtempSync(join(tmpdir(), 'bmn-reader-round-')); homes.push(home)
  const memory = join(home, '.claude/projects/-tmp-synthetic/memory')
  mkdirSync(memory, { recursive: true }); writeFileSync(join(memory, 'MEMORY.md'), 'private synthetic memory')
  const count = { calls: 0, actual: 0, probes: 0, gateActive: false, finalProbe: null as null | (() => void),
    returned: false, resultPresent: false, peerMode: null as null | '-s' | '-x', peerStarted: false, peerHeldThroughProbe: false,
    codes: [] as { code: number | null; afterInspection: boolean }[] }
  vi.doMock(`${moduleRoot}/doctor-adapters.mjs`, async () => {
    const actual = await vi.importActual<typeof import('../../bin/doctor-adapters.mjs')>(`${moduleRoot}/doctor-adapters.mjs`)
    return { ...actual,
      boundedProcess: async (...args: Parameters<typeof actual.boundedProcess>) => {
        const isProbe = args[0] === '/usr/bin/flock' && args[1].at(-1) === '/usr/bin/true'
        const peer = isProbe && count.returned && count.peerMode !== null && !count.peerStarted
          ? await lockPeer(String(args[1].at(-2)), count.peerMode, home) : null
        if (peer) count.peerStarted = true
        try {
          const result = await actual.boundedProcess(...args)
          if (isProbe) {
            if (peer) count.peerHeldThroughProbe = peer.alive()
            count.codes.push({ code: result.code, afterInspection: count.returned })
            if (++count.probes === 3) probeDone?.()
            if (count.actual > 0) count.finalProbe?.()
          }
          return result
        } finally { if (peer) await peer.release() }
      },
      revalidateLeftoversDoctor: async (...args: Parameters<typeof actual.revalidateLeftoversDoctor>) => {
        count.calls += 1
        started?.()
        if (count.gateActive) await gate
        // A broken baseline may call this three times. Only one actual fixture child
        // is permitted in this batch; the count itself proves missing coalescence.
        if (++count.actual > 1) return null
        const result = await actual.revalidateLeftoversDoctor(...args)
        count.returned = true; count.resultPresent = result !== null
        return result
      }
    }
  })
  const doctor = await import(`${moduleRoot}/doctor.mjs`)
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }
  await doctor.doctorWorker({ environment, versions, qualify: async () => 'unsupported', bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  // doctorWorker's direct test seam does not run ensureLock like the CLI does.
  writeFileSync(doctor.doctorPaths(environment).lock, '', { mode: 0o600 })
  return { doctor, environment, count }
}

it('recovery round: saved snapshots start no inspection; compatible concurrent readers share one actual sandbox worker', async () => {
  const probes = deferred()
  const f = await fixture(probes.promise, probes.resolve)
  const original = readFileSync(f.doctor.doctorPaths(f.environment).state, 'utf8')
  const saved = await f.doctor.readDoctorView({ environment: f.environment, freshLocations: false })
  expect(f.count.calls).toBe(0)
  expect(saved.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0].currentLocator).toBeUndefined()
  f.count.probes = 0
  f.count.gateActive = true
  const views = await Promise.all(Array.from({ length: 3 }, () => f.doctor.readDoctorView({ environment: f.environment })))
  expect(f.count.calls).toBe(1)
  for (const view of views) expect(view.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0].currentLocator?.status,
    JSON.stringify({ probes: f.count.codes, resultPresent: f.count.resultPresent })).toBe('located')
  expect(readFileSync(f.doctor.doctorPaths(f.environment).state, 'utf8')).toBe(original)
  f.count.actual = 0
  const later = await f.doctor.readDoctorView({ environment: { ...f.environment, PATH: '/bin:/usr/bin' } })
  expect(f.count.calls).toBe(2)
  expect(later.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0].currentLocator?.status).toBe('located')
  expect(JSON.stringify(views)).not.toMatch(/private synthetic memory|itemTag|contextTag|profileKey/)
})

it('recovery round: refuses a fresh result if its saved acquisition changes before publication', async () => {
  const gate = deferred(), started = deferred()
  const f = await fixture(gate.promise, undefined, started.resolve)
  f.count.gateActive = true
  const reading = f.doctor.readDoctorView({ environment: f.environment })
  await started.promise
  const saved = f.doctor.loadDoctorState(f.environment); saved.continuity = null; f.doctor.saveDoctorState(saved, f.environment)
  gate.resolve()
  const view = await reading
  expect(f.count.calls).toBe(1)
  expect(view.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0].currentLocator).toBeUndefined()
})

it('post-review recovery: refuses a fresh location when the final lock probe invalidates saved continuity', async () => {
  const f = await fixture(Promise.resolve())
  let mutated = false
  f.count.finalProbe = () => {
    f.count.finalProbe = null
    const saved = f.doctor.loadDoctorState(f.environment)
    saved.continuity = null
    f.doctor.saveDoctorState(saved, f.environment)
    mutated = true
  }
  const view = await f.doctor.readDoctorView({ environment: f.environment })
  expect(mutated, 'the final publication probe must mutate the saved acquisition').toBe(true)
  expect(f.count.calls).toBe(1)
  expect(view.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0].currentLocator).toBeUndefined()
})

it.each([
  { name: 'shared peer permits a fresh location', mode: '-s' as const, located: true },
  { name: 'exclusive peer refuses a fresh location', mode: '-x' as const, located: false }
])('shared probe round: $name', async ({ mode, located }) => {
  const f = await fixture(Promise.resolve())
  f.count.peerMode = mode
  const view = await f.doctor.readDoctorView({ environment: f.environment })
  expect(f.count.calls).toBe(1)
  expect(f.count.resultPresent).toBe(true)
  expect(f.count.peerStarted).toBe(true)
  expect(f.count.peerHeldThroughProbe, 'the ready OS peer must still hold the lock during the probe').toBe(true)
  const row = view.rows.find((row: { check: string }) => row.check === 'leftovers').leftovers[0]
  if (located) expect(row.currentLocator?.status, JSON.stringify(f.count.codes)).toBe('located')
  else expect(row.currentLocator).toBeUndefined()
  expect(view.running).toBe(!located)
})
