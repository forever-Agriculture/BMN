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

/**
 * Page code: for `seconds`, how many terminal rows xterm rebuilds in each animation frame, how many of those rebuilds
 * leave the row's markup as it was, and which other elements change their attributes, counted by tag, class and name.
 */
export const ROW_RENDERS = `async (seconds) => {
  const counts = { frames: 0, rebuilt: 0, unchanged: 0, rowsPerFrame: {}, attributes: {}, other: {} }
  const markup = new WeakMap()
  for (const row of document.querySelectorAll('.xterm-rows > div')) markup.set(row, row.innerHTML)
  let rows = new Set()
  const name = (node) => node.nodeType === 1 ? node.tagName.toLowerCase() + [...node.classList].slice(0, 2).map((one) => '.' + one).join('') : node.nodeName
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList' && record.target.parentElement?.classList.contains('xterm-rows')) rows.add(record.target)
      else {
        const key = record.type === 'attributes' ? name(record.target) + '@' + record.attributeName : record.type + ':' + name(record.target)
        const table = record.type === 'attributes' ? counts.attributes : counts.other
        table[key] = (table[key] ?? 0) + 1
      }
    }
  })
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const end = performance.now() + seconds * 1000
  await new Promise((done) => {
    const frame = () => {
      counts.frames += 1
      for (const row of rows) { counts.rebuilt += 1; if (markup.get(row) === row.innerHTML) counts.unchanged += 1; markup.set(row, row.innerHTML) }
      counts.rowsPerFrame[rows.size] = (counts.rowsPerFrame[rows.size] ?? 0) + 1
      rows = new Set()
      if (performance.now() < end) requestAnimationFrame(frame); else done()
    }
    requestAnimationFrame(frame)
  })
  observer.disconnect()
  const top = (table) => Object.fromEntries(Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, 25))
  return { ...counts, attributes: top(counts.attributes), other: top(counts.other) }
}`

const GPU_CATEGORIES = ['toplevel', 'gpu', 'viz', 'cc', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.gpu_composite_time']
/** What DevTools' Performance panel records: the window's style, layout, paint and script work per frame. */
export const TIMELINE_CATEGORIES = ['toplevel', 'blink', 'cc', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute']

/** contentTracing in the main process, through its inspector: every process's slices in `categories` over `seconds`. */
export async function traceProcesses(mainUrl, seconds, path, categories = GPU_CATEGORIES) {
  const rpc = await connect(mainUrl)
  const evaluate = async (expression) => {
    const answer = await rpc.send('Runtime.evaluate', { expression, awaitPromise: true, includeCommandLineAPI: true, returnByValue: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result.value
  }
  await evaluate(`require('electron').contentTracing.startRecording({ included_categories: ${JSON.stringify(categories)} }).then(() => true)`)
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

/**
 * One thread's slices at every depth, by name: each name's inclusive thread time and count, so a frame's style, layout
 * and paint show inside the task that ran them. A name nested in itself is counted once, at its outermost slice.
 */
export function summarizeThreadSlices(path, pid, threadName) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const tids = new Set(events.filter((event) => event.ph === 'M' && event.name === 'thread_name' && event.pid === pid && event.args?.name === threadName).map((event) => event.tid))
  const byName = new Map()
  const openUntil = new Map()
  for (const event of events.filter((one) => one.pid === pid && tids.has(one.tid) && one.ph === 'X' && typeof one.tdur === 'number').sort((a, b) => a.ts - b.ts)) {
    if (event.ts < (openUntil.get(event.name) ?? 0)) continue
    openUntil.set(event.name, event.ts + event.dur)
    const entry = byName.get(event.name) ?? { ms: 0, count: 0 }
    entry.ms += event.tdur / 1000
    entry.count += 1
    byName.set(event.name, entry)
  }
  return [...byName].sort((a, b) => b[1].ms - a[1].ms).slice(0, 30).map(([label, { ms, count }]) => ({ label, ms: Math.round(ms), count }))
}

/** BMN's own processes under its main one: the GPU process, the window and the utility host, by their Electron type. */
export function bmnProcesses(mainPid, procRoot = '/proc') {
  const parents = new Map()
  const argvs = new Map()
  for (const name of readdirSync(procRoot).filter((entry) => /^\d+$/u.test(entry))) {
    try {
      parents.set(Number(name), Number(readFileSync(join(procRoot, name, 'stat'), 'utf8').replace(/^.*\) /su, '').split(' ')[1]))
      argvs.set(Number(name), readFileSync(join(procRoot, name, 'cmdline'), 'utf8').split(/[\0 ]/u))
    } catch {
      // A process that ended while it was read.
    }
  }
  // Any descendant counts: Chromium starts the GPU process through its zygote, not from the main process itself.
  const under = (pid) => {
    for (let at = parents.get(pid), seen = 0; at !== undefined && seen < 64; at = parents.get(at), seen += 1) if (at === mainPid) return true
    return false
  }
  const found = {}
  for (const [pid, argv] of argvs) {
    if (!under(pid)) continue
    if (argv.includes('--type=gpu-process')) found.gpu = pid
    if (argv.includes('--type=renderer')) found.renderer = pid
    if (argv.includes('--type=utility') && argv.includes('--utility-sub-type=node.mojom.NodeService')) found.utility = pid
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
/** Whether a process catches `signal`, from its `/proc/PID/status` text (SigCgt, a hex mask with bit N-1 for signal N). */
export function signalCaught(status, signal) {
  const mask = /^SigCgt:\s*([0-9a-f]+)$/mu.exec(status)?.[1]
  return mask !== undefined && ((BigInt(`0x${mask}`) >> BigInt(signal - 1)) & 1n) === 1n
}

export async function profileAll({ port, inspectPort, mainPid, seconds = 60, dir, measure, only = null }) {
  const results = {}
  const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value))
  const side = async (name, kind, work) => {
    if (only && !only.includes(name)) return
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
    // SIGUSR1 opens Node's inspector only where Node catches it; uncaught, it would end the utility host.
    if (!signalCaught(readFileSync(`/proc/${utility}/status`, 'utf8'), 10)) throw new Error('the utility host does not catch SIGUSR1')
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
    const path = await traceProcesses(main.webSocketDebuggerUrl, seconds, join(dir, 'gpu-trace.json'))
    const summary = summarizeTrace(path, gpu)
    return { cores: summary.busyMs / (seconds * 1000), summary, note: 'top-level slices only: thread time outside a traced slice is not counted' }
  })
  // Story 91.2: where the window's own drawing time goes, frame by frame, beside the same minute's /proc.
  await side('window-trace', 'renderer', async () => {
    if (!main) throw new Error('the main process inspector did not answer, so contentTracing could not start')
    const { renderer } = bmnProcesses(mainPid)
    if (!renderer) throw new Error('no window process found')
    const path = await traceProcesses(main.webSocketDebuggerUrl, seconds, join(dir, 'window-trace.json'), TIMELINE_CATEGORIES)
    const summary = summarizeTrace(path, renderer)
    return { cores: summary.busyMs / (seconds * 1000), summary, mainThread: summarizeThreadSlices(path, renderer, 'CrRendererMain'),
      note: 'top-level slices only in cores; mainThread lists every depth by name' }
  })
  // Story 91.2: which terminal rows the window rebuilds per frame, and whether the rebuilds change them.
  await side('rows', 'renderer', async () => {
    const rpc = await connect(page.webSocketDebuggerUrl)
    const answer = await rpc.send('Runtime.evaluate', { expression: `(${ROW_RENDERS})(${seconds})`, awaitPromise: true, returnByValue: true })
    rpc.close()
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return { rows: answer.result.value, note: 'a MutationObserver in the window: its own work adds to the minute' }
  })
  return results
}
