// MODULE: qa-bench-reboot.test.mjs - real lifecycle paths with synthetic boot and cgroup observations
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const kernel = vi.hoisted(() => ({ current: null, boot: '00000000-0000-0000-0000-000000000001', btime: '100000', uptime: '20.00 0.00\n', denied: false, present: new Set(), observations: 0, onBoot: null }))
vi.mock('node:fs', async original => {
  const fs = await original()
  return { ...fs,
    readFileSync: (path, ...args) => {
      if (String(path).endsWith('/qa-bench/current.json')) return JSON.stringify(kernel.current)
      if (path === '/proc/sys/kernel/random/boot_id') { kernel.observations++; kernel.onBoot?.(); return kernel.boot + '\n' }
      if (path === '/proc/stat') return `btime ${kernel.btime}\n`
      if (path === '/proc/uptime') return kernel.uptime
      return fs.readFileSync(path, ...args)
    },
    realpathSync: (path, ...args) => String(path).startsWith('/sys/fs/cgroup/') ? path : fs.realpathSync(path, ...args),
    statfsSync: path => String(path).startsWith('/sys/fs/cgroup/') ? { type: 0x63677270 } : fs.statfsSync(path),
    accessSync: (path, ...args) => {
      if (String(path).startsWith('/sys/fs/cgroup/')) { if (kernel.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return }
      return fs.accessSync(path, ...args)
    },
    existsSync: path => String(path).startsWith('/sys/fs/cgroup/') ? kernel.present.has(path) : fs.existsSync(path),
    lstatSync: (path, ...args) => {
      if (String(path).startsWith('/sys/fs/cgroup/')) {
        if (kernel.present.has(path)) return { isSymbolicLink: () => true }
        throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      }
      return fs.lstatSync(path, ...args)
    }
  }
})
vi.mock('../qa/bench-lib.mjs', async original => {
  const lib = await original()
  return { ...lib, atomicJson: (path, value) => {
    if (String(path).endsWith('/qa-bench/current.json')) { kernel.current = value; return }
    return lib.atomicJson(path, value)
  } }
})
import * as lifecycle from '../qa/bench-state.mjs'
import { processIdentity } from '../qa/bench-lib.mjs'
import { recoverOwnedBench } from '../qa/bench-recover.mjs'

const roots = [], bootAt = 100000000
const identity = path => { const s = statSync(path); return { device: s.dev, inode: s.ino } }
const save = (run, name, value) => writeFileSync(join(run, name), JSON.stringify(value))
function fixture({ predecessor } = {}) {
  const runId = `${Date.now()}-${randomBytes(8).toString('hex')}`, run = lifecycle.runPath(runId)
  roots.push(run); mkdirSync(join(run, 'recovery-root'), { recursive: true })
  const tempParent = mkdtempSync(join(tmpdir(), 'bmn-reboot-')); roots.push(tempParent)
  const parent = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice`
  const group = key => ({ parent, path: join(parent, `bmn-qa-${runId}${key ? `-${key}` : ''}.scope`), ...(key ? { launchKey: key } : {}), device: 30, inode: key ? 101 : 100, parentIdentity: { device: 30, inode: 1 } })
  const config = { version: 2, runId, run, currentFile: lifecycle.currentFile, recoveryRoot: join(run, 'recovery-root'), root: join(tempParent, 'owned'),
    tempParent, tempParentIdentity: identity(tempParent), rootIdentity: { device: 50, inode: 40 }, group: group(), ...(predecessor ? { previousRunId: predecessor } : {}) }
  const traces = predecessor ? [] : ['workload', 'recovery'].map((role, i) => {
    const key = String(i + 1).repeat(16), file = role === 'workload' ? 'isolation.strace' : `recovery-${key}.strace`
    const entry = { role, key, group: group(key), file, actorFile: role === 'workload' ? 'launcher.json' : `watchdog-${key}.json`,
      recorderFile: `recorder-${key}.json`, certificateFile: `certificate-${key}.json`, lease: { path: join(run, `launch-${key}.lease`) } }
    writeFileSync(entry.lease.path, 'synthetic lease'); Object.assign(entry.lease, identity(entry.lease.path))
    save(run, `launch-${key}.json`, entry)
    const recorder = { pid: 21 + i, start_ticks: '100' }, tracer = { pid: 31 + i, start_ticks: '101' }, pid = 11 + i, text = `${pid} +++ exited with 0 +++\n`
    save(run, entry.recorderFile, { runId, launchKey: key, role, recorderIdentity: recorder, tracerIdentity: tracer })
    save(run, entry.actorFile, { pid, runId, key, tracer })
    writeFileSync(join(run, file), text)
    save(run, entry.certificateFile, { version: 1, runId, launchKey: key, role, recorderIdentity: recorder, tracerIdentity: tracer,
      launchGroupIdentity: entry.group, traceErrors: [], traceFileIdentity: identity(join(run, file)), traceBytes: Buffer.byteLength(text),
      traceSha256: createHash('sha256').update(text).digest('hex'), exitCode: 0, signal: null, rawWaitStatus: 0 })
    if (role === 'workload') save(run, `group-removal-${key}.json`, { runId, group: entry.group })
    return entry
  })
  const state = { ...config, status: 'stopped', stoppedAt: new Date(bootAt - 20000).toISOString(), tracers: traces, recoveryTracePending: traces[1]?.key }
  save(run, 'config.json', config); save(run, 'receipt.json', state)
  save(run, 'completion-proof.json', { stopped: true, rootsDeleted: true, groupRemoved: true, traces: traces.map(trace => ({ key: trace.key, complete: true })) })
  save(run, 'root-deletion-intent.json', { runId, root: config.root, identity: config.rootIdentity })
  save(run, 'group-removal-workload.json', { runId, group: config.group })
  return { config, state, run, traces }
}
function changed(run, name, update) { const value = JSON.parse(readFileSync(join(run, name))); update(value); save(run, name, value) }
function snapshot(run) { return Object.fromEntries(readdirSync(run).filter(name => name.endsWith('.json')).map(name => [name, readFileSync(join(run, name), 'utf8')])) }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(bootAt + 20000)
  Object.assign(kernel, { current: null, boot: '00000000-0000-0000-0000-000000000001', btime: '100000', uptime: '20.00 0.00\n', denied: false, present: new Set(), observations: 0, onBoot: null })
})
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('stopped-before-boot recovery classification', () => {
  it('discharges the exact missing-recovery-receipt failure through outstanding(readCurrent()) without rewriting history', () => {
    const f = fixture(); kernel.current = f.state; const before = snapshot(f.run)
    expect(lifecycle.outstanding(lifecycle.readCurrent())).toEqual([])
    expect(snapshot(f.run)).toEqual(before)
    expect(lifecycle.traceCompleted(f.state.runId, f.traces[1])).toBe(true)
  })
  it.each([
    ['same boot', f => changed(f.run, 'receipt.json', r => { r.stoppedAt = new Date(bootAt + 1000).toISOString() })],
    ['equal boot', f => changed(f.run, 'receipt.json', r => { r.stoppedAt = new Date(bootAt).toISOString() })],
    ['overlapping whole second', f => changed(f.run, 'receipt.json', r => { r.stoppedAt = new Date(bootAt - 1500).toISOString() })],
    ['malformed stop', f => changed(f.run, 'receipt.json', r => { r.stoppedAt = 'yesterday' })],
    ['not stopped', f => changed(f.run, 'receipt.json', r => { r.status = 'stopping' })],
    ['untraced cleanup', f => changed(f.run, 'receipt.json', r => { r.cleanupUntraced = true })],
    ['changed generation', f => changed(f.run, 'receipt.json', r => { r.runId += 'x' })],
    ['changed creation', f => changed(f.run, 'receipt.json', r => { r.rootIdentity.inode++ })],
    ['missing launch key', f => changed(f.run, 'receipt.json', r => { r.tracers = [r.tracers[1]] })],
    ['incomplete proof', f => changed(f.run, 'completion-proof.json', r => { r.traces[1].complete = false })],
    ['bad certificate', f => changed(f.run, f.traces[1].certificateFile, r => { r.traceSha256 = 'wrong' })],
    ['incomplete ancestry', f => writeFileSync(join(f.run, f.traces[1].file), '12 fork() = 13\n12 +++ exited with 0 +++\n')],
    ['mismatched deletion', f => changed(f.run, 'root-deletion-intent.json', r => { r.identity.inode++ })],
    ['mismatched removal', f => changed(f.run, `group-removal-${f.traces[0].key}.json`, r => { r.group.inode++ })],
    ['missing lease', f => rmSync(f.traces[1].lease.path)],
    ['substituted lease', f => { const fd = openSync(f.traces[1].lease.path, 'r'); rmSync(f.traces[1].lease.path); writeFileSync(f.traces[1].lease.path, 'replaced'); expect(fstatSync(fd).ino).not.toBe(statSync(f.traces[1].lease.path).ino); closeSync(fd) }],
    ['permission failure', () => { kernel.denied = true }],
    ['present or dangling group', f => { kernel.present.add(f.traces[1].group.path) }],
    ['reappearing group', f => { kernel.onBoot = () => { if (kernel.observations === 2) kernel.present.add(f.traces[1].group.path) } }],
    ['changed boot', () => { kernel.onBoot = () => { if (kernel.observations === 2) kernel.boot = '00000000-0000-0000-0000-000000000002' } }],
    ['malformed btime', () => { kernel.btime = '1e5' }],
    ['clock discontinuity', () => { kernel.uptime = '100.00 0.00\n' }],
    ['symlinked receipt', f => { const bytes = readFileSync(join(f.run, 'receipt.json')); writeFileSync(join(f.run, 'other.json'), bytes); rmSync(join(f.run, 'receipt.json')); symlinkSync('other.json', join(f.run, 'receipt.json')) }]
  ])('blocks %s', (_name, change) => {
    const f = fixture(); kernel.current = f.state; change(f)
    expect(() => lifecycle.outstanding(lifecycle.readCurrent())).toThrow()
  })
  it('does not discharge a held launch lease', () => {
    const f = fixture(); kernel.current = f.state
    const fd = openSync(f.traces[1].lease.path, 'r+')
    try {
      expect(spawnSync('/usr/bin/flock', ['-x', '-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }).status).toBe(0)
      expect(lifecycle.outstanding(lifecycle.readCurrent())).toEqual([{ launch: f.traces[1].key }])
    } finally { closeSync(fd) }
  })
  it('keeps generic groupState and removeGroup strict for the retired branch', () => {
    const f = fixture(), branch = { ...f.config, group: f.traces[1].group }
    expect(() => lifecycle.groupState(branch)).toThrow('without a removal receipt')
    expect(() => lifecycle.removeGroup(branch)).toThrow('before removal')
  })
  it('completes real successor recovery without fabricating the old recovery removal receipt', async () => {
    const old = fixture(), next = fixture({ predecessor: old.state.runId }), before = snapshot(old.run), key = 'f'.repeat(16)
    kernel.current = { ...next.state, status: 'stopping', stopRequestedAt: new Date(Date.now()).toISOString(), cleanupDeadlineAt: Date.now() + 30000, stopClaim: { token: 'synthetic' }, watchdog: { key } }
    const self = processIdentity(process.pid)
    await recoverOwnedBench({ config: next.config, runId: next.state.runId, key, self, token: 'synthetic', ownTracer: self, claimed: () => kernel.current })
    expect(kernel.current.status).toBe('stopped'); expect(snapshot(old.run)).toEqual(before)
  })
  it('rejects a changed successor previousRunId', () => {
    const old = fixture(), next = fixture({ predecessor: old.state.runId })
    expect(() => lifecycle.removePreviousGroups({ ...next.config, previousRunId: next.state.runId })).toThrow('substituted')
  })
})
