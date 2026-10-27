#!/usr/bin/env node
// MODULE: bench.mjs - isolated QA lifecycle, shell actions and recovery through generation-bound kernel containment
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicJson, benchArguments, disposableEnvironment, isLiveProcess, processIdentity } from './bench-lib.mjs'
import { allTraces, configFor, createGroup, createLaunch, currentFile, launchLeaseHeld, outstanding, ownState, publish, readCurrent, readJson, repo, requestStop, runPath, sleep, traceCompleted, transition, withLifecycleLock } from './bench-state.mjs'

const gates = new Set()
const fileIdentity = path => { const stat = statSync(path); return { device: stat.dev, inode: stat.ino } }
function directories(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const name of ['home', 'bin', 'config', 'data', 'state', 'cache', 'runtime', 'tmp', 'synthetic-project']) mkdirSync(join(root, name), { mode: 0o700 })
  symlinkSync(process.execPath, join(root, 'bin/node'))
}
function pnpmProgram() {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'pnpm')
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  return null
}
function marker(root, runId) {
  const fd = openSync(join(root, '.bmn-qa-run'), 'w', 0o600)
  try { writeSync(fd, runId); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(root, 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function reserve(options, binary) {
  return withLifecycleLock(() => {
    const prior = readCurrent()
    if (prior && (prior.status !== 'stopped' || outstanding(prior).length)) throw new Error('A bench or its recovery is active; use --stop before starting another')
    const runId = `${Date.now()}-${randomBytes(8).toString('hex')}`, run = runPath(runId)
    mkdirSync(run, { mode: 0o700 })
    const tempParent = realpathSync(tmpdir()), root = mkdtempSync(join(tempParent, 'bmn-qa-'))
    let group
    try {
      directories(root)
      marker(root, runId)
      const recoveryRoot = join(run, 'recovery-root')
      directories(recoveryRoot)
      const build = !options['no-build'] && !options.binary
      if (build) {
        const pnpm = pnpmProgram()
        if (!pnpm) throw new Error('pnpm is required to build the QA checkout')
        symlinkSync(pnpm, join(root, 'bin/pnpm'))
      }
      group = createGroup(runId)
      const busConfig = join(root, 'session-bus.conf')
      const runtime = join(root, 'runtime').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      writeFileSync(busConfig, `<busconfig><type>session</type><listen>unix:tmpdir=${runtime}</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`, { mode: 0o600 })
      writeFileSync(join(root, 'synthetic-project/README.md'), '# QA project\nSynthetic data only.\n')
      const config = { version: 2, previousRunId: prior?.runId, runId, root, run, currentFile, recoveryRoot, tempParent, tempParentIdentity: fileIdentity(tempParent), rootIdentity: fileIdentity(root),
        group, busConfig, node: process.execPath, binary, build, packaged: Boolean(options.binary), port: options.port, token: randomBytes(32).toString('hex') }
      atomicJson(join(run, 'config.json'), config)
      publish({ ...config, status: 'starting', starter: processIdentity(process.pid), tracers: [] })
      return config
    } catch (error) {
      // Nothing has been spawned; only these just-created empty resources can exist.
      if (group && statSync(group.path).ino === group.inode) rmdirSync(group.path)
      rmSync(root, { recursive: true, force: true })
      atomicJson(join(run, 'creation-error.json'), { error: error.message })
      throw error
    }
  })
}
function trace(config, role, key) {
  const { entry, fd } = createLaunch(config, role, key)
  const state = readCurrent()
  publish({ ...state, tracers: [...state.tracers, entry], ...(role === 'recovery' ? { recoveryPending: { key } } : {}) })
  const log = openSync(join(config.run, role === 'workload' ? 'bench.log' : `recovery-${key}.log`), 'a', 0o600)
  let child
  try {
    child = spawn('/usr/bin/python3', ['-I', '-S', join(repo, 'scripts/qa/bench-recorder.py'), config.runId, key], {
      cwd: config.recoveryRoot, env: disposableEnvironment(config.recoveryRoot), detached: true,
      stdio: ['ignore', log, log, 'pipe', fd]
    })
  } finally { closeSync(log); closeSync(fd) }
  const gate = child.stdio[3]
  gates.add(gate)
  gate.on('error', () => {})
  child.on('error', error => { atomicJson(join(config.run, `trace-${key}-error.json`), { error: error.message }); gate.destroy() })
  child.unref(); gate.unref()
  const recorderIdentity = processIdentity(child.pid)
  if (!recorderIdentity) { gate.destroy(); throw new Error('QA recorder could not be recorded') }
  const current = readCurrent()
  publish({ ...current, tracers: current.tracers.map(item => item.key === key ? { ...entry, recorderIdentity } : item) })
  return { child, gate, entry: { ...entry, recorderIdentity } }
}
function release(gate) { gate.end('go\n'); gates.delete(gate) }
function startRecoveryLocked(config) {
  const key = randomBytes(8).toString('hex')
  const launched = trace(config, 'recovery', key)
  release(launched.gate)
  return readCurrent()
}
function pendingAlive(state) {
  const pending = state.tracers.find(item => item.key === state.recoveryPending?.key)
  return pending ? launchLeaseHeld(state.runId, pending) : false
}
function ensureRecovery(runId) {
  return withLifecycleLock(() => {
    const state = readCurrent()
    if (state?.runId !== runId || !['starting', 'stopping'].includes(state.status)) return
    if (state.watchdog && isLiveProcess(state.watchdog.identity)) return
    if (pendingAlive(state)) return
    startRecoveryLocked(configFor(runId))
  })
}
async function stop(runId, error, retry = false) {
  const config = configFor(runId)
  const state = ownState(runId)
  if (state && state.status !== 'stopped') requestStop(runId, error, retry)
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const current = ownState(runId) ?? readJson(join(config.run, 'receipt.json'))
    if (current.status === 'stopped' && !outstanding(current).length && !existsSync(config.root) && !existsSync(config.group.path)) {
      const traces = allTraces(current).map(entry => ({ key: entry.key, complete: traceCompleted(runId, entry) }))
      atomicJson(join(config.run, 'completion-proof.json'), { stopped: true, rootsDeleted: true, groupRemoved: true, traces })
      return { stopped: true, cleanupComplete: true, evidence: config.run, traceComplete: traces.every(item => item.complete) }
    }
    if (current.cleanupError && !isLiveProcess(current.watchdog?.identity)) throw new Error(current.cleanupError)
    if (current.runId !== runId) throw new Error('QA generation changed; another run was not stopped')
    ensureRecovery(runId)
    await sleep(100)
  }
  throw new Error('QA stop timed out; retryable stopping state and evidence preserved')
}
async function start(options) {
  const binary = options.binary ? resolve(options.binary) : options.electron ? resolve(options.electron) : createRequire(join(repo, 'apps/desktop/package.json'))('electron')
  if (!existsSync(binary)) throw new Error(`Executable does not exist: ${binary}`)
  const config = reserve(options, binary)
  let workloadGate
  try {
    withLifecycleLock(() => {
      const state = readCurrent()
      if (state?.runId !== config.runId || state.status !== 'starting') throw new Error('QA startup was cancelled')
      const key = config.runId.slice(-16)
      const workload = trace(config, 'workload', key)
      workloadGate = workload.gate
      startRecoveryLocked(config)
    })
    const readyDeadline = Date.now() + 9000
    let admitted = false
    while (Date.now() < readyDeadline) {
      const ready = transition(config.runId, ['starting'], state => {
        if (!state.watchdog?.ready || !isLiveProcess(state.watchdog.identity) || !isLiveProcess(state.watchdog.tracer)) return null
        release(workloadGate)
        admitted = true
        return { ...state, admissionRequestedAt: new Date().toISOString() }
      })
      if (admitted) break
      if (!ready) throw new Error('QA startup was cancelled or superseded')
      await sleep(50)
    }
    if (!admitted) throw new Error('QA recovery monitor did not become ready')
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const state = ownState(config.runId)
      if (!state) throw new Error('QA starter was superseded; the newer run is untouched')
      if (state.status === 'running' && isLiveProcess(state.watchdog?.identity) && isLiveProcess(state.watchdog?.tracer)) {
        console.log(JSON.stringify({ status: state.status, cdp: state.cdp, root: config.root, evidence: config.run, processes: state.processes,
          drive: 'pnpm run qa:bench -- do snapshot', stop: 'pnpm run qa:bench -- --stop' }, null, 2))
        return
      }
      if (state.status === 'stopping' || state.status === 'stopped') throw new Error(state.error ?? `QA startup ended; see ${join(config.run, 'bench.log')}`)
      await sleep(100)
    }
    throw new Error(`QA startup timed out; see ${join(config.run, 'bench.log')}`)
  } catch (error) {
    for (const gate of gates) gate.destroy()
    if (ownState(config.runId)) await stop(config.runId, error)
    throw error
  }
}
async function request(current, args) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(current.control)) throw new Error('Invalid QA control endpoint')
  const response = await fetch(`${current.control}/action`, { method: 'POST', headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30000) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? `Bench returned ${response.status}`)
  return value
}
async function main() {
  const options = benchArguments(process.argv.slice(2)), current = withLifecycleLock(readCurrent)
  if (options.stop || options.action?.[0] === 'stop') {
    if (!current?.runId) throw new Error('No bench in this checkout')
    console.log(JSON.stringify(await stop(current.runId, undefined, true), null, 2))
  } else if (options.action) {
    if (current?.status !== 'running') throw new Error('No running bench; run pnpm run qa:bench first')
    console.log(JSON.stringify(await request(current, options.action), null, 2))
  } else await start(options)
}
main().catch(error => { for (const gate of gates) gate.destroy(); console.error(`QA bench: ${error.message}`); process.exitCode = 1 })
