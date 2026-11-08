// MODULE: bench-recover.mjs - bounded owned-branch drain and cleanup under one durable deadline
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson, isLiveProcess } from './bench-lib.mjs'
import { allTraces, cleanupDeadline, configFor, deleteRoot, groupState, killGroup, readJson, removeGroup, runPath, sleep, traceCompleted, traceOutstanding, transition, validateStateRoot } from './bench-state.mjs'

export async function recoverOwnedBench({ config, runId, key, self, token, ownTracer, claimed }) {
  let state = claimed()
  validateStateRoot(state, config)
  const deadline = cleanupDeadline(state)
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
  const flush = deadline
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

