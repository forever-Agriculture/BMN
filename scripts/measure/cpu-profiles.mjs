// MODULE: cpu-profiles.mjs - Story 91.1 AC4: 60-second profiles of BMN's window, main process, utility host and GPU process, each compared with /proc
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** One inspector or DevTools connection: commands answered by id, events to listeners. */
export async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let id = 0
  const pending = new Map()
  const listeners = []
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data))
    if (data.id !== undefined && pending.has(data.id)) {
      const { done, fail } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) fail(new Error(`${data.error.message} (${data.error.code})`))
      else done(data.result)
    } else for (const listen of listeners) listen(data)
  })
  return {
    send: (method, params = {}, sessionId) => new Promise((done, fail) => {
      id += 1
      pending.set(id, { done, fail })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    }),
    on: (listen) => listeners.push(listen),
    close: () => socket.close()
  }
}

/** The inspector targets a debugging port lists. */
export async function targets(port) {
  for (let tries = 0; ; tries += 1) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch (error) { if (tries > 30) throw error; await sleep(500) }
  }
}

/**
 * A V8 CPU profile's busy time and its heaviest call sites: self time per function (with its file and line), and the
 * total time under each, with idle and the garbage collector named apart.
 */
export function summarizeProfile(profile, { top = 25 } = {}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map()
  const deltas = profile.timeDeltas ?? []
  let total = 0
  profile.samples.forEach((sample, index) => {
    const delta = (deltas[index + 1] ?? deltas[index] ?? 0) / 1000
    total += delta
    self.set(sample, (self.get(sample) ?? 0) + delta)
  })
  const name = (node) => {
    const frame = node.callFrame
    const where = frame.url ? `${frame.url.replace(/^.*\/(out|src|node_modules)\//u, '$1/')}:${frame.lineNumber + 1}` : ''
    return `${frame.functionName || '(anonymous)'}${where ? ` ${where}` : ''}`
  }
  const bySelf = new Map()
  const byTotal = new Map()
  let idle = 0
  let gc = 0
  for (const [id, ms] of self) {
    const node = nodes.get(id)
    const label = name(node)
    if (node.callFrame.functionName === '(idle)') idle += ms
    if (node.callFrame.functionName === '(garbage collector)') gc += ms
    bySelf.set(label, (bySelf.get(label) ?? 0) + ms)
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const up = name(nodes.get(at))
      if (seen.has(up)) continue
      seen.add(up)
      byTotal.set(up, (byTotal.get(up) ?? 0) + ms)
    }
  }
  const rank = (map) => [...map].filter(([label]) => !label.startsWith('(idle)') && !label.startsWith('(root)')).sort((a, b) => b[1] - a[1]).slice(0, top).map(([label, ms]) => ({ label, ms: Math.round(ms) }))
  return { wallMs: Math.round(total), busyMs: Math.round(total - idle), idleMs: Math.round(idle), gcMs: Math.round(gc), self: rank(bySelf), total: rank(byTotal) }
}

/** Profile one inspector target for `seconds`, its worker threads too where it has them (the NodeWorker domain). */
export async function profileTarget(url, seconds, { workers = false } = {}) {
  const rpc = await connect(url)
  const attached = []
  if (workers) {
    rpc.on((message) => { if (message.method === 'NodeWorker.attachedToWorker') attached.push(message.params) })
    await rpc.send('NodeWorker.enable', { waitForDebuggerOnStart: false }).catch(() => undefined)
    await sleep(500)
  }
  // Commands to a worker go through the parent's session as NodeWorker messages, answered the same way.
  const workerCalls = attached.map((worker) => {
    let id = 0
    const pending = new Map()
    rpc.on((message) => {
      if (message.method !== 'NodeWorker.receivedMessageFromWorker' || message.params.sessionId !== worker.sessionId) return
      const data = JSON.parse(message.params.message)
      if (data.id !== undefined && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) }
    })
    const send = (method, params = {}) => new Promise((done) => {
      id += 1
      pending.set(id, done)
      rpc.send('NodeWorker.sendMessageToWorker', { sessionId: worker.sessionId, message: JSON.stringify({ id, method, params }) })
    })
    return { worker, send }
  })
  await rpc.send('Profiler.enable')
  await rpc.send('Profiler.setSamplingInterval', { interval: 1000 })
  for (const { send } of workerCalls) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 }) }
  await rpc.send('Profiler.start')
  for (const { send } of workerCalls) await send('Profiler.start')
  await sleep(seconds * 1000)
  const { profile } = await rpc.send('Profiler.stop')
  const threads = []
  for (const { worker, send } of workerCalls) {
    const answer = await send('Profiler.stop')
    if (answer.result?.profile) threads.push({ title: worker.workerInfo?.title ?? worker.workerInfo?.url ?? 'worker', profile: answer.result.profile })
  }
  rpc.close()
  return { profile, workers: threads }
}

/** contentTracing in the main process, through its inspector: the GPU process's slices over `seconds`. */
export async function traceGpu(mainUrl, seconds, path) {
  const rpc = await connect(mainUrl)
  const evaluate = async (expression) => {
    const answer = await rpc.send('Runtime.evaluate', { expression, awaitPromise: true, includeCommandLineAPI: true, returnByValue: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result.value
  }
  await evaluate(`require('electron').contentTracing.startRecording({ included_categories: ['toplevel', 'gpu', 'viz', 'cc', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.gpu_composite_time'] }).then(() => true)`)
  await sleep(seconds * 1000)
  const written = await evaluate(`require('electron').contentTracing.stopRecording(${JSON.stringify(path)})`)
  rpc.close()
  return written
}

/** A trace's busy thread time per process and thread, and its heaviest top-level slices, for the process named. */
export function summarizeTrace(path, pid) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const names = new Map()
  for (const event of events) if (event.ph === 'M' && event.name === 'thread_name' && event.pid === pid) names.set(event.tid, event.args?.name)
  const byThread = new Map()
  const bySlice = new Map()
  // Top-level slices only (depth 0 per thread), so nested slices are not counted twice.
  const open = new Map()
  for (const event of events.filter((one) => one.pid === pid && one.ph === 'X' && typeof one.tdur === 'number').sort((a, b) => a.ts - b.ts)) {
    const end = open.get(event.tid) ?? 0
    if (event.ts < end) continue
    open.set(event.tid, event.ts + event.dur)
    const thread = names.get(event.tid) ?? String(event.tid)
    byThread.set(thread, (byThread.get(thread) ?? 0) + event.tdur / 1000)
    bySlice.set(event.name, (bySlice.get(event.name) ?? 0) + event.tdur / 1000)
  }
  const rank = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([label, ms]) => ({ label, ms: Math.round(ms) }))
  return { busyMs: Math.round([...byThread.values()].reduce((sum, ms) => sum + ms, 0)), threads: rank(byThread), slices: rank(bySlice) }
}

/** BMN's own processes under its main one: the GPU process and the utility host, by their Electron type. */
export function bmnProcesses(mainPid, procRoot = '/proc') {
  const found = {}
  for (const name of readdirSync(procRoot).filter((entry) => /^\d+$/u.test(entry))) {
    try {
      const stat = readFileSync(join(procRoot, name, 'stat'), 'utf8').replace(/^.*\) /su, '').split(' ')
      if (Number(stat[1]) !== mainPid) continue
      const argv = readFileSync(join(procRoot, name, 'cmdline'), 'utf8').split(/[\0 ]/u)
      if (argv.includes('--type=gpu-process')) found.gpu = Number(name)
      if (argv.includes('--type=utility') && argv.includes('--utility-sub-type=node.mojom.NodeService')) found.utility = Number(name)
    } catch {
      // A process that ended while it was read.
    }
  }
  return found
}

/** How far a profile's busy share of a core is from the same process's /proc cores; over 25% marks its causes uncertain. */
export function agreement(profileCores, procCores) {
  if (!(procCores > 0)) return { apart: null, uncertain: true }
  const apart = Math.abs(profileCores - procCores) / procCores
  return { apart: Math.round(apart * 1000) / 1000, uncertain: apart > 0.25 }
}

async function waitForInspector(port, seconds) {
  for (let waited = 0; waited < seconds * 1000; waited += 500) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (list.length > 0) return list
    } catch {
      // Not listening yet.
    }
    await sleep(500)
  }
  return null
}

/**
 * The four 60-second profiles of Story 91.1 AC4, one after another, each beside a /proc measurement of the same minute
 * (`measure(minutes, file)` runs bmn-cpu.mjs): the window through DevTools (`port`), the main process through its
 * inspector (`inspectPort`), the utility host through the inspector SIGUSR1 opens in it (port 9229), with its worker
 * threads, and the GPU process through the main process's contentTracing.
 */
export async function profileAll({ port, inspectPort, mainPid, seconds = 60, dir, measure }) {
  const results = {}
  const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value))
  const side = async (name, kind, work) => {
    const [cpu, outcome] = await Promise.all([measure(seconds / 60, join(dir, `${name}.cpu.json`)), work().catch((error) => ({ error: String(error).slice(0, 400) }))])
    const procCores = cpu?.cores?.byKind?.[kind] ?? null
    results[name] = { procCores, valid: cpu?.valid ?? false, ...outcome, ...(outcome.cores === undefined ? {} : agreement(outcome.cores, procCores)) }
  }
  const page = (await targets(port)).find((target) => target.type === 'page')
  await side('renderer', 'renderer', async () => {
    const { profile } = await profileTarget(page.webSocketDebuggerUrl, seconds)
    save('renderer.cpuprofile', profile)
    const summary = summarizeProfile(profile)
    return { cores: summary.busyMs / (summary.wallMs || 1), summary, note: 'the window main thread only; its compositor and raster threads are not in a CPU profile' }
  })
  const main = (await waitForInspector(inspectPort, 10))?.[0]
  await side('main', 'main', async () => {
    if (!main) throw new Error('the main process inspector did not answer')
    const { profile } = await profileTarget(main.webSocketDebuggerUrl, seconds)
    save('main.cpuprofile', profile)
    const summary = summarizeProfile(profile)
    return { cores: summary.busyMs / (summary.wallMs || 1), summary }
  })
  const { utility, gpu } = bmnProcesses(mainPid)
  await side('utility', 'utility:node.mojom.NodeService', async () => {
    if (!utility) throw new Error('no utility host found')
    process.kill(utility, 'SIGUSR1')
    const listed = (await waitForInspector(9229, 10))?.[0]
    if (!listed) throw new Error('the utility host opened no inspector on SIGUSR1')
    const { profile, workers } = await profileTarget(listed.webSocketDebuggerUrl, seconds, { workers: true })
    save('utility.cpuprofile', profile)
    const summary = summarizeProfile(profile)
    const threads = workers.map(({ title, profile: one }) => { save(`utility-worker-${title.replace(/[^\w.-]+/gu, '_')}.cpuprofile`, one); return { title, summary: summarizeProfile(one) } })
    const busy = summary.busyMs + threads.reduce((sum, one) => sum + one.summary.busyMs, 0)
    return { cores: busy / (summary.wallMs || 1), summary, workers: threads, ...(threads.length === 0 ? { note: 'no worker thread was attached: worker time is unattributed' } : {}) }
  })
  await side('gpu', 'gpu-process', async () => {
    if (!main) throw new Error('the main process inspector did not answer, so contentTracing could not start')
    if (!gpu) throw new Error('no GPU process found')
    const path = await traceGpu(main.webSocketDebuggerUrl, seconds, join(dir, 'gpu-trace.json'))
    const summary = summarizeTrace(path, gpu)
    return { cores: summary.busyMs / (seconds * 1000), summary, note: 'top-level slices only: thread time outside a traced slice is not counted' }
  })
  return results
}
