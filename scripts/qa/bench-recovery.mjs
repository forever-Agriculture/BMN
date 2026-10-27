// MODULE: bench-recovery.mjs - private traced watchdog outside the workload cgroup, with exclusive crash recovery
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson, isLiveProcess, processIdentity } from './bench-lib.mjs'
import { allTraces, claimRecovery, configFor, deleteRoot, groupState, killGroup, ownState, readCurrent, readJson, removeGroup, runPath, requestStop, sleep, traceCompleted, traceIdentity, traceOutstanding, transition, validateStateRoot } from './bench-state.mjs'

const runId = process.argv[2], key = process.argv[3]
if (!/^[a-f0-9]{16}$/u.test(key)) throw new Error('Invalid recovery identity')
const config = configFor(runId)
const self = processIdentity(process.pid)
const token = randomBytes(16).toString('hex')
let ownTracer
let parentTrace = processIdentity(process.ppid)
try { if (readlinkSync(`/proc/${process.ppid}/exe`) !== '/usr/bin/strace' || !isLiveProcess(parentTrace)) parentTrace = null } catch { parentTrace = null }
const birthState = readCurrent()
const gateDeadlineAt = birthState?.runId === runId ? birthState.tracers.find(trace => trace.key === key)?.gateDeadlineAt ?? Date.now() : Date.now()
atomicJson(join(config.run, `watchdog-${key}.json`), { ...self, tracer: parentTrace, runId, key, gateDeadlineAt })

async function gate() {
  return new Promise(resolveGate => {
    const input = createReadStream(null, { fd: 3, autoClose: true })
    let text = '', finished = false
    const finish = accepted => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      input.destroy()
      resolveGate(accepted)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, gateDeadlineAt - Date.now()))
    input.on('data', chunk => { text += chunk; if (text.includes('\n') || text.length > 64) finish(text === 'go\n') })
    input.on('end', () => finish(false))
    input.on('error', () => finish(false))
  })
}

function claimed() {
  if (!isLiveProcess(ownTracer)) throw new Error('Recovery trace exited')
  const state = ownState(runId)
  if (state?.status !== 'stopping' || state.stopClaim?.token !== token || state.watchdog?.key !== key) throw new Error('Recovery claim was superseded')
  return state
}

async function recover() {
  let state = claimed()
  validateStateRoot(state, config)
  const deadline = Date.now() + 30000
  const controller = state.pid ? { pid: state.pid, start_ticks: state.start_ticks } : null
  // Graceful app exit is an authenticated control action. Kernel containment owns escalation.
  if (state.control && /^http:\/\/127\.0\.0\.1:\d+$/u.test(state.control) && isLiveProcess(controller)) {
    await fetch(`${state.control}/action`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['stop']), signal: AbortSignal.timeout(1500)
    }).then(response => response.body?.cancel()).catch(() => {})
  }
  const grace = Math.min(Date.now() + 1500, deadline)
  while (groupState(config).populated && Date.now() < grace) {
    claimed()
    await sleep(50)
  }
  state = claimed()
  validateStateRoot(state, config)
  if (groupState(config).populated) killGroup(config)
  // Give surviving recorder parents a bounded chance to reap and seal their traces.
  const flush = Math.min(Date.now() + 1500, deadline)
  while (Date.now() < flush) {
    state = claimed()
    if (allTraces(state).filter(trace => trace.key !== key).every(trace => !traceOutstanding(runId, trace))) break
    await sleep(50)
  }
  state = claimed()
  for (const trace of allTraces(state).filter(trace => trace.key !== key)) {
    const branch = { ...config, group: trace.group }
    if (groupState(branch).populated) killGroup(branch)
  }
  while (Date.now() < deadline) {
    state = claimed()
    if (!groupState(config).populated && allTraces(state).filter(trace => trace.key !== key).every(trace => !traceOutstanding(runId, trace))) break
    await sleep(50)
  }
  state = claimed()
  const others = allTraces(state).filter(trace => trace.key !== key)
  if (groupState(config).populated || others.some(trace => traceOutstanding(runId, trace))) {
    throw new Error('QA cleanup deadline exceeded; stopping state and roots preserved for retry')
  }
  const traceEvidence = others.map(trace => ({ key: trace.key, complete: traceCompleted(runId, trace) }))
  for (const trace of others) removeGroup({ ...config, group: trace.group })
  if (config.previousRunId) {
    const previous = configFor(config.previousRunId), receipt = readJson(join(runPath(previous.runId), 'receipt.json'))
    if (receipt.status !== 'stopped' || existsSync(previous.root)) throw new Error('Previous QA run is not complete')
    for (const trace of allTraces(receipt)) {
      if (traceOutstanding(previous.runId, trace)) throw new Error('Previous QA launch is still active')
      removeGroup({ ...previous, group: trace.group })
    }
  }
  atomicJson(join(config.run, `recovery-${key}-proof.json`), { empty: true, traceEvidence, claimant: self })
  const stopped = transition(runId, ['stopping'], current => {
    if (current.stopClaim?.token !== token || current.watchdog?.key !== key || !isLiveProcess(ownTracer)) return null
    validateStateRoot(current, config)
    deleteRoot(config)
    removeGroup(config)
    return { ...current, status: 'stopped', stoppedAt: new Date().toISOString(), cleanupError: undefined,
      traceEvidence, recoveryTracePending: key, tracers: allTraces(current) }
  })
  if (stopped?.stopClaim?.token !== token || stopped.status !== 'stopped') throw new Error('Stopped publication was superseded')
  // No further child launches or workload-root access: this process and its tracer now exit.
}

async function main() {
  if (!await gate()) return 1
  const ready = transition(runId, ['starting', 'stopping'], state => {
    const traces = allTraces(state)
    const trace = traces.find(item => item.key === key && item.role === 'recovery')
    if (!trace || state.recoveryPending?.key !== key || !isLiveProcess(traceIdentity(runId, trace))) return null
    if (state.watchdog && state.watchdog.key !== key && isLiveProcess(state.watchdog.identity)) return null
    return { ...state, tracers: traces, watchdog: { key, identity: self, tracer: traceIdentity(runId, trace), ready: true }, recoveryPending: undefined }
  })
  if (ready?.watchdog?.key !== key) return 1
  ownTracer = ready.watchdog.tracer
  while (true) {
    // A killed tracer must not leave an untraced, long-lived recovery actor.
    if (!isLiveProcess(ownTracer)) return 1
    let state = ownState(runId)
    if (!state || state.status === 'stopped') return 0
    const workload = allTraces(state).find(item => item.role === 'workload')
    const controller = state.pid ? { pid: state.pid, start_ticks: state.start_ticks } : null
    if (state.status === 'starting' && (!isLiveProcess(state.starter) || (workload && !traceOutstanding(runId, workload)) || (controller && !isLiveProcess(controller)))) {
      requestStop(runId, new Error('Starter or workload launcher exited during startup'))
    } else if (state.status === 'running' && (!isLiveProcess(controller) || !workload || !traceOutstanding(runId, workload))) {
      requestStop(runId, new Error('Bench controller or workload trace exited'))
    }
    state = ownState(runId)
    if (state?.status === 'stopping') {
      const claim = claimRecovery(runId, self, token)
      if (claim?.stopClaim?.token === token) { await recover(); return 0 }
    }
    await sleep(100)
  }
}

main().then(code => { process.exit(code) }).catch(error => {
  atomicJson(join(config.run, `watchdog-${key}-error.json`), { error: error.message, identity: self })
  transition(runId, ['stopping'], state => state.stopClaim?.token === token ? { ...state, cleanupError: error.message } : null)
  console.error(`QA recovery: ${error.message}`)
  process.exit(1)
})
