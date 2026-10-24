// MODULE: cpu-profiles.test.mjs - Story 91.1 AC4: profiles are read into busy time and call sites, and compared with /proc by the 25% rule
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { ROW_RENDERS, agreement, bmnProcesses, signalCaught, summarizeProfile, summarizeThreadSlices, summarizeTrace } from '../measure/cpu-profiles.mjs'

let roots = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

const frame = (functionName, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })

describe('CPU profiles (Story 91.1 AC4)', () => {
  it('reads a V8 profile into busy and idle time, self time per call site and time under each caller', () => {
    // root -> render (out/renderer/index.js:10) -> parse (node_modules/@xterm/xterm/lib/xterm.js:5); root -> (idle)
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2, 4] },
        { id: 2, callFrame: frame('render', 'file:///x/out/renderer/index.js', 9), children: [3] },
        { id: 3, callFrame: frame('parse', 'file:///x/node_modules/@xterm/xterm/lib/xterm.js', 4), children: [] },
        { id: 4, callFrame: frame('(idle)'), children: [] }
      ],
      // Each sample's time is the next sample's delta, in microseconds: parse 3 ms, render 1 ms, idle 6 ms.
      samples: [3, 3, 3, 2, 4, 4, 4, 4, 4, 4],
      timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
    }
    const summary = summarizeProfile(profile)
    expect(summary).toMatchObject({ wallMs: 10, busyMs: 4, idleMs: 6 })
    expect(summary.self[0]).toEqual({ label: 'parse node_modules/@xterm/xterm/lib/xterm.js:5', ms: 3 })
    expect(summary.total.find((entry) => entry.label.startsWith('render'))).toEqual({ label: 'render out/renderer/index.js:10', ms: 4 })
  })

  it('finds the GPU process and the window under the zygote and the utility host under main, and nothing outside BMN', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-proc-'))
    roots.push(root)
    const process = (pid, parent, argv) => {
      mkdirSync(join(root, String(pid)))
      writeFileSync(join(root, String(pid), 'stat'), `${pid} (bmn) S ${parent} 1 1 0`)
      writeFileSync(join(root, String(pid), 'cmdline'), argv.join('\0'))
    }
    process(10, 1, ['bmn'])
    process(11, 10, ['bmn', '--type=zygote'])
    process(12, 11, ['bmn', '--type=gpu-process'])
    process(13, 10, ['bmn', '--type=utility', '--utility-sub-type=node.mojom.NodeService'])
    process(14, 11, ['bmn', '--type=renderer'])
    process(20, 1, ['other', '--type=gpu-process'])
    process(21, 1, ['other', '--type=renderer'])
    expect(bmnProcesses(10, root)).toEqual({ gpu: 12, utility: 13, renderer: 14 })
  })

  it('reads from a process status whether it catches SIGUSR1 before the inspector is asked for', () => {
    expect(signalCaught('Name:\tbmn\nSigCgt:\t0000000100004202\n', 10)).toBe(true)
    expect(signalCaught('Name:\tbmn\nSigCgt:\t0000000100004002\n', 10)).toBe(false)
    expect(signalCaught('Name:\tbmn\n', 10)).toBe(false)
  })

  it('marks a profile more than 25% apart from /proc as uncertain', () => {
    expect(agreement(0.5, 0.6)).toEqual({ apart: 0.167, uncertain: false })
    expect(agreement(0.3, 0.6)).toEqual({ apart: 0.5, uncertain: true })
    expect(agreement(0.3, 0)).toEqual({ apart: null, uncertain: true })
  })

  it('counts a trace\'s top-level slices of one process by thread, not their nested slices again', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-trace-'))
    roots.push(root)
    const path = join(root, 'trace.json')
    writeFileSync(path, JSON.stringify({ traceEvents: [
      { ph: 'M', name: 'thread_name', pid: 7, tid: 1, args: { name: 'CrGpuMain' } },
      { ph: 'X', name: 'GpuChannel::ExecuteDeferredRequest', pid: 7, tid: 1, ts: 0, dur: 5000, tdur: 4000 },
      { ph: 'X', name: 'CommandBufferStub::OnAsyncFlush', pid: 7, tid: 1, ts: 1000, dur: 1000, tdur: 900 },
      { ph: 'X', name: 'GpuChannel::ExecuteDeferredRequest', pid: 7, tid: 1, ts: 10000, dur: 2000, tdur: 1000 },
      { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 8, tid: 1, ts: 0, dur: 9000, tdur: 9000 }
    ] }))
    expect(summarizeTrace(path, 7)).toEqual({
      busyMs: 5, threads: [{ label: 'CrGpuMain', ms: 5 }], slices: [{ label: 'GpuChannel::ExecuteDeferredRequest', ms: 5 }]
    })
  })

  it('sums one thread\'s slices by name at every depth, a name nested in itself once', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-trace-'))
    roots.push(root)
    const path = join(root, 'trace.json')
    writeFileSync(path, JSON.stringify({ traceEvents: [
      { ph: 'M', name: 'thread_name', pid: 7, tid: 1, args: { name: 'CrRendererMain' } },
      { ph: 'M', name: 'thread_name', pid: 7, tid: 2, args: { name: 'Compositor' } },
      { ph: 'X', name: 'RunTask', pid: 7, tid: 1, ts: 0, dur: 10000, tdur: 9000 },
      { ph: 'X', name: 'Layout', pid: 7, tid: 1, ts: 1000, dur: 3000, tdur: 3000 },
      { ph: 'X', name: 'Layout', pid: 7, tid: 1, ts: 2000, dur: 1000, tdur: 1000 },
      { ph: 'X', name: 'Paint', pid: 7, tid: 1, ts: 5000, dur: 2000, tdur: 2000 },
      { ph: 'X', name: 'Layout', pid: 7, tid: 1, ts: 20000, dur: 1000, tdur: 500 },
      { ph: 'X', name: 'Paint', pid: 7, tid: 2, ts: 0, dur: 4000, tdur: 4000 }
    ] }))
    expect(summarizeThreadSlices(path, 7, 'CrRendererMain')).toEqual([
      { label: 'RunTask', ms: 9, count: 1 }, { label: 'Layout', ms: 4, count: 2 }, { label: 'Paint', ms: 2, count: 1 }
    ])
  })

  it('counts the rows rebuilt in each frame, the rebuilds that left a row as it was, and other attribute changes', async () => {
    const rowsParent = { classList: { contains: (name) => name === 'xterm-rows' } }
    const row = (markup) => ({ nodeType: 1, tagName: 'DIV', classList: [], parentElement: rowsParent, innerHTML: markup })
    const [first, second, third] = [row('<span>a</span>'), row('<span>b</span>'), row('<span>c</span>')]
    const dot = { nodeType: 1, tagName: 'SPAN', classList: ['status-dot', 'running'], parentElement: null }
    let observe
    let now = 0
    const frames = [
      () => { first.innerHTML = '<span>a</span>'; second.innerHTML = '<span>B</span>'; observe([{ type: 'childList', target: first }, { type: 'childList', target: second }, { type: 'attributes', target: dot, attributeName: 'class' }]) },
      () => undefined,
      () => { third.innerHTML = '<span>c</span>'; observe([{ type: 'childList', target: third }]) }
    ]
    const context = {
      document: { querySelectorAll: () => [first, second, third], visibilityState: 'visible' },
      MutationObserver: class { constructor(callback) { observe = callback } observe() {} disconnect() {} },
      performance: { now: () => now },
      requestAnimationFrame: (callback) => { const change = frames.shift(); setTimeout(() => { change?.(); now += 400; callback() }, 0) },
      setTimeout, Object
    }
    const counts = await runInNewContext(`(${ROW_RENDERS})(1)`, context)
    expect({ frames: counts.frames, rebuilt: counts.rebuilt, unchanged: counts.unchanged }).toEqual({ frames: 3, rebuilt: 3, unchanged: 2 })
    expect({ ...counts.rowsPerFrame }).toEqual({ 0: 1, 1: 1, 2: 1 })
    expect({ ...counts.attributes }).toEqual({ 'span.status-dot.running@class': 1 })
    expect(counts.visibility).toBe('visible')
  })
})
