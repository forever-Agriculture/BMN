// MODULE: bench-recovery.mjs - private traced watchdog outside the workload cgroup, with exclusive crash recovery
import { randomBytes } from 'node:crypto'
import { createReadStream, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson, isLiveProcess, processIdentity } from './bench-lib.mjs'
import { allTraces, claimRecovery, configFor, ownState, readCurrent, requestStop, sleep, traceIdentity, traceOutstanding, transition } from './bench-state.mjs'
import { recoverOwnedBench } from './bench-recover.mjs'

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
      if (claim?.stopClaim?.token === token) { await recoverOwnedBench({ config, runId, key, self, token, ownTracer, claimed }); return 0 }
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
