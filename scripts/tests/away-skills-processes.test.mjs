// MODULE: away-skills-processes.test.mjs - 113.3 offline cleanup checks on a synthetic /proc and one real child
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { alive, processTree, stopTree } from '../test/away-skills-processes.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))
const fakeProc = rows => {
  const proc = mkdtempSync(join(tmpdir(), 'away-proc-'))
  for (const [pid, ppid, ticks, comm] of rows) {
    mkdirSync(join(proc, String(pid)))
    const fields = ['S', ppid, ...Array(17).fill(0), ticks]
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`)
  }
  return proc
}

describe('owned process tree', () => {
  it('finds parent, utility and shell descendants but not a sibling', () => {
    const proc = fakeProc([[10, 1, '100', 'electron'], [11, 10, '101', 'electron utility'], [12, 11, '102', 'bash'], [13, 12, '103', 'claude'], [20, 1, '200', 'other']])
    expect(processTree(10, proc).map(p => p.pid).sort()).toEqual([10, 11, 12, 13])
    expect(processTree(99, proc)).toEqual([])
  })
  it('a reused pid with other start ticks is not the owned process', () => {
    const proc = fakeProc([[10, 1, '555', 'electron']])
    expect(alive({ pid: 10, start_ticks: '100' }, proc)).toBe(false)
    expect(alive({ pid: 10, start_ticks: '555' }, proc)).toBe(true)
  })
  it('kills a survivor once and reports any process that still remains', async () => {
    const proc = fakeProc([[10, 1, '100', 'electron'], [11, 10, '101', 'stuck']])
    const killed = []
    const result = await stopTree([{ pid: 10, start_ticks: '100' }, { pid: 11, start_ticks: '101' }], {
      graceMs: 200, afterKillMs: 200, wait, proc, kill: id => { killed.push(id.pid); if (id.pid === 10) rmSync(join(proc, '10'), { recursive: true }) }
    })
    expect(killed).toEqual([10, 11])
    expect(result.remaining.map(id => id.pid)).toEqual([11])
  })
  it('stops a real child through its pidfd', async () => {
    const child = spawn('sleep', ['30'])
    await wait(100)
    const [identity] = processTree(child.pid)
    const result = await stopTree([identity], { graceMs: 100, afterKillMs: 2000, wait })
    expect(result.killed).toEqual([child.pid])
    expect(result.remaining).toEqual([])
  })
})
