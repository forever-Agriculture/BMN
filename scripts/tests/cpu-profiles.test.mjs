// MODULE: cpu-profiles.test.mjs - Story 91.1 AC4: profiles are read into busy time and call sites, and compared with /proc by the 25% rule
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agreement, summarizeProfile, summarizeTrace } from '../measure/cpu-profiles.mjs'

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
})
