// MODULE: bmn-cpu.test.mjs - Story 91.1 AC1: the CPU script picks BMN's own processes from recorded /proc trees and does the arithmetic
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentOf, classify, electronType, findMain, readProc, sessionAgents, summarize } from '../measure/bmn-cpu.mjs'

const BMN = '/opt/synthetic/linux-unpacked/bmn'
const BIN = '/opt/synthetic/linux-unpacked/resources/bin'
let roots = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

/** A recorded /proc: each process with its parent, ticks (user, system), start ticks, argv and binary. */
function proc(uptime, processes) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-cpu-proc-'))
  roots.push(root)
  writeFileSync(join(root, 'uptime'), `${uptime} 1000.00\n`)
  for (const one of processes) {
    const folder = join(root, String(one.pid))
    mkdirSync(folder)
    // Field 2 is the command name, which may hold spaces and parentheses.
    const fields = ['S', one.ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, one.user ?? 0, one.system ?? 0, 0, 0, 20, 0, 1, 0, one.start]
    writeFileSync(join(folder, 'stat'), `${one.pid} (a (b) c) ${fields.join(' ')} 0 0\n`)
    // Chromium rewrites its children's arguments as one line joined by spaces; others keep NUL separators.
    writeFileSync(join(folder, 'cmdline'), one.joined ? `${one.argv.join(' ')}\0` : `${one.argv.join('\0')}\0`)
    if (one.exe) symlinkSync(one.exe, join(folder, 'exe'))
  }
  return root
}

/** BMN's tree as it runs: main, zygote, renderer, GPU, the pty host, one session shell with an agent and BMN's CLI. */
const tree = (over = {}) => [
  { pid: 100, ppid: 1, start: '5000', exe: BMN, argv: [BMN], user: 100, system: 20, ...over[100] },
  { pid: 101, ppid: 100, start: '5010', exe: BMN, argv: [BMN, '--type=zygote'], joined: true, user: 1, system: 1, ...over[101] },
  { pid: 102, ppid: 101, start: '5020', exe: BMN, argv: [BMN, '--type=renderer', '--lang=en-US'], joined: true, user: 300, system: 50, ...over[102] },
  { pid: 103, ppid: 100, start: '5011', exe: BMN, argv: [BMN, '--type=gpu-process'], joined: true, user: 80, system: 20, ...over[103] },
  { pid: 104, ppid: 100, start: '5012', exe: BMN, argv: [BMN, '--type=utility', '--utility-sub-type=node.mojom.NodeService'], joined: true, user: 60, system: 10, ...over[104] },
  { pid: 200, ppid: 104, start: '6000', exe: '/bin/bash', argv: ['/bin/bash', '--rcfile', `${BIN}/bmn-bash`], user: 5, ...over[200] },
  { pid: 201, ppid: 200, start: '6100', exe: '/opt/claude/versions/2.1.310', argv: ['claude'], user: 900, system: 100, ...over[201] },
  { pid: 202, ppid: 201, start: '6200', exe: '/usr/bin/node', argv: ['node', `${BIN}/bmn.mjs`, 'hook'], user: 7, system: 3, ...over[202] },
  { pid: 203, ppid: 201, start: '6300', exe: '/usr/bin/cargo', argv: ['cargo', 'build'], user: 5000, ...over[203] },
  // The CLI runs the same binary as Node, started by an agent: it is never BMN's main process.
  { pid: 204, ppid: 201, start: '6400', exe: BMN, argv: [BMN, `${BIN}/bmn.mjs`, 'snapshot'], user: 2, ...over[204] },
  // A program the utility host starts for itself, not a session's shell.
  { pid: 205, ppid: 104, start: '6500', exe: '/usr/bin/git', argv: ['git', 'status'], user: 4, ...over[205] },
  // Another program of the owner's, outside BMN.
  { pid: 300, ppid: 1, start: '100', exe: '/usr/bin/firefox', argv: ['firefox'], user: 9999, ...over[300] }
]

function sample(uptime, processes, sessionStarts = new Set(['6000'])) {
  const { processes: read, uptime: at } = readProc(proc(uptime, processes))
  const main = findMain(read, { exe: BMN })
  return { uptime: at, processes: classify(read, main, { binDirs: [BIN], sessionStarts }) }
}

describe('BMN CPU script (Story 91.1 AC1)', () => {
  it('takes the main process and its Electron children by type, and leaves the terminal, its CLI line and the helpers apart', () => {
    const one = sample(100, tree())
    const by = Object.fromEntries(one.processes.map((entry) => [entry.pid, [entry.kind, entry.line]]))
    expect(by).toEqual({
      100: ['main', 'target'], 101: ['zygote', 'target'], 102: ['renderer', 'target'], 103: ['gpu-process', 'target'],
      104: ['utility:node.mojom.NodeService', 'target'], 200: ['terminal', 'terminal'], 201: ['terminal', 'terminal'],
      202: ['bmn-cli', 'bmn-cli'], 203: ['terminal', 'terminal'], 204: ['bmn-cli', 'bmn-cli'], 205: ['helper', 'helpers']
    })
    expect(one.processes.some((entry) => entry.pid === 300)).toBe(false)
    expect(sessionAgents(one.processes)).toEqual({ terminals: 1, agents: { claude: 1 } })
    // Without BMN's record of its sessions' shells, every program a utility starts is taken for a terminal.
    expect(sample(100, tree(), null).processes.find((entry) => entry.pid === 205)?.line).toBe('terminal')
  })

  it('names Electron types from either argument form and finds agents behind their wrappers', () => {
    expect(electronType(['bmn', '--type=utility', '--utility-sub-type=network.mojom.NetworkService'])).toBe('utility:network.mojom.NetworkService')
    expect(electronType(['bmn'])).toBeNull()
    expect(agentOf({ exe: '/usr/bin/node', argv: ['node', '/home/x/.nvm/bin/codex', '--no-daemon'] })).toBe('codex')
    expect(agentOf({ exe: '/home/x/.opencode/bin/opencode', argv: ['opencode'] })).toBe('opencode')
    expect(agentOf({ exe: '/usr/bin/git', argv: ['git'] })).toBeNull()
  })

  it('counts each process\'s change in user plus system time over the elapsed seconds, per type and in total', () => {
    const first = sample(100, tree())
    const second = sample(105, tree({ 100: { user: 105 }, 102: { user: 320 }, 103: { system: 25 }, 201: { user: 1900 }, 202: { user: 9 }, 205: { user: 6 } }))
    const result = summarize([first, second], { ticksPerSecond: 100 })
    // 5 s: main 5 ticks, renderer 20, GPU 5 = 30 ticks = 0.06 cores; the agent's 1000 ticks are not BMN's.
    expect(result).toMatchObject({ valid: true, seconds: 5, samples: 2 })
    expect(result.cores).toEqual({
      total: 0.06, byKind: { 'gpu-process': 0.01, main: 0.01, renderer: 0.04 }, outsideTarget: { 'bmn-cli': 0.004, helpers: 0.004 }
    })
  })

  it('reads a reused PID as a new process, counts one born in the window from its start and one that ended for the samples it lived', () => {
    const first = sample(100, tree())
    // The renderer ended; a new renderer reuses PID 102, born after the first sample (start 10050 ticks = 100.5 s).
    const reused = tree({ 102: { start: '10050', user: 40, system: 0 } })
    const second = sample(105, reused)
    const gone = tree({ 102: { start: '10050', user: 60, system: 0 } }).filter((entry) => entry.pid !== 103)
    const third = sample(110, gone)
    const result = summarize([first, second, third], { ticksPerSecond: 100 })
    // Renderer: the new one's 40 ticks from its birth, then 20 (60 over 10 s); the old one's ticks before it ended are not counted again. GPU: gone in the last sample.
    expect(result.cores.byKind).toEqual({ renderer: 0.06 })
    expect(result.valid).toBe(true)
  })

  it('is invalid across a gap over 10 seconds or a restart of BMN', () => {
    const first = sample(100, tree())
    expect(summarize([first, sample(111, tree())]).reasons).toEqual(['a gap of 11.0 s at sample 1'])
    const restarted = sample(105, tree({ 100: { start: '9000' } }))
    expect(summarize([first, restarted])).toMatchObject({ valid: false, reasons: ['BMN restarted or stopped at sample 1'] })
    expect(summarize([first]).valid).toBe(false)
  })

  it('finds no main where the binary does not run, and asks for a PID where two do', () => {
    const { processes } = readProc(proc(100, tree()))
    expect(() => findMain(processes, { exe: '/elsewhere/bmn' })).toThrow('no BMN runs /elsewhere/bmn')
    const two = readProc(proc(100, [...tree(), { pid: 400, ppid: 1, start: '7000', exe: BMN, argv: [BMN] }, { pid: 401, ppid: 400, start: '7001', exe: BMN, argv: [BMN, '--type=zygote'], joined: true }])).processes
    expect(() => findMain(two, { exe: BMN })).toThrow('name one with --main-pid')
    expect(findMain(two, { exe: BMN, mainPid: 400 }).pid).toBe(400)
  })
})
