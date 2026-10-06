import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ mode: 'complete', count: 0, removed: [], writes: new Map(), abort: undefined,
  query: vi.fn(), observerStarts: 0, guardError: undefined }))
vi.mock('../../apps/desktop/node_modules/node-pty', () => ({ queryApplicationLifetimeProcesses: f.query }))
vi.mock('node:fs', () => ({ mkdirSync() {}, mkdtempSync: () => '/synthetic/profile',
  readFileSync: path => f.writes.get(path), renameSync: (from, to) => f.writes.set(to, f.writes.get(from)),
  writeFileSync: (path, text) => { if (f.mode === 'write-failure' && JSON.parse(text).arms[0]?.profileRetained) throw new Error('secondary write failure'); f.writes.set(path, text) },
  rmSync: path => f.removed.push(path) }))
vi.mock('../../apps/desktop/src/utility/private-directory.ts', () => ({ ensurePrivateDirectories() {} }))
vi.mock('../lib/windows-installed-worker.mjs', () => ({ windowsInstallerSmokeEnvironment: () => ({}) }))
vi.mock('../lib/windows-exit-observer.mjs', () => ({ windowsExitObserver: async () => {
  f.observerStarts++
  return { finish: async () => ({ passed: f.mode !== 'descendant' && f.mode !== 'write-failure' }), abort: async () => f.abort() }
} }))
vi.mock('node:child_process', () => ({ spawn: (_binary, args) => {
  const child = new EventEmitter(); child.pid = 100 + ++f.count; child.exitCode = null; child.signalCode = null
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  const close = code => { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null) }
  child.kill = () => { queueMicrotask(() => close(99)); return true }
  const arm = args.find(value => value.startsWith('--scrolled-diagnostic=')).split('=')[1]
  if (f.mode.startsWith('job-')) {
    child.pid = process.pid
    setImmediate(async () => {
      const output = vi.spyOn(console, 'log').mockImplementation(text => {
        if (f.mode === 'job-sink-failure') throw new Error('synthetic metadata sink failure')
        child.stdout.write(text + '\n')
        if (f.mode === 'job-duplicate') child.stdout.write(text + '\n')
      })
      try { await armDiagnosticCustody(arm) }
      catch (error) {
        f.guardError = error.message
        child.stderr.write(error.message)
        child.stdout.write(JSON.stringify(diagnosticObservationRecord({ arm,
          anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 }, initialScrolledWithinBudget: false, lateMembers: null })) + '\n')
        close(1)
      } finally { output.mockRestore() }
    })
    return child
  }
  let completed = false
  const emitReceipt = () => {
    if (completed) return
    completed = true
    const passive = { failure: 'original SCROLLED failure', failureAtMs: 11000, scrollTypedAtMs: 0,
      controllerPokes: [], samples: [{ outputBytes: 42 }], observationErrors: [] }
    if (f.mode === 'null') child.stdout.write('null\n42\n')
    child.stdout.write(JSON.stringify(diagnosticObservationRecord({ arm, anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 },
      initialScrolledWithinBudget: false, lateMembers: f.mode === 'late' ? 1 : 0, passiveObservation: passive })) + '\n')
    if (f.mode !== 'missing') child.stdout.write(JSON.stringify({ selfTest: 'scrolled-diagnostic', diagnosticOnly: true,
      arm, graceful: true, initialScrolledWithinBudget: false, passiveObservation: passive, lateMembers: 0,
      animationPassed: true, sixelAnimation: { storageMB: 1, imageLinesAfterScroll: 4, noViewRebuild: true,
        quietPaneUnchanged: true, quietSelectionKept: true }, finalState: { outputBytes: 42 }, anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 } }) + '\n')
    close(0)
  }
  child.stdin.on('data', () => queueMicrotask(emitReceipt))
  setImmediate(emitReceipt)
  queueMicrotask(() => {
    if (f.mode === 'null') child.stdout.write('null\ntrue\n')
    if (f.mode === 'input-observation') for (let index = 0; index < 24; index++) {
      child.stdout.write(JSON.stringify({ selfTest: 'scrolled-diagnostic-input', diagnosticOnly: true, arm,
        event: 'before-resume', atMs: index + 1, descriptor: 0, readable: true, flowing: null,
        inputContent: 'synthetic content must not enter the receipt' }) + '\n')
    }
    const ready = { selfTest: 'scrolled-diagnostic-custody', diagnosticOnly: true,
      arm: f.mode === 'wrong-arm' ? 'other' : arm, mainPid: f.mode === 'forged-main' ? child.pid + 1 : child.pid,
      snapshot: { listed: 1, identified: 1, entries: [{ pid: child.pid,
        creationTimeMs: 100, creationFileTime: '116444736001000000' }] } }
    child.stdout.write(JSON.stringify(ready) + '\n')
    if (f.mode === 'duplicate') child.stdout.write(JSON.stringify(ready) + '\n')
  })
  return child
} }))
import { diagnosticObservationRecord } from '../../apps/desktop/src/main/self-test/diagnostic-publication.ts'
import { armDiagnosticCustody } from '../../apps/desktop/src/main/self-test/diagnostic-custody.ts'
import { recordScrolledPrefixes } from '../test/windows-scrolled-prefix.mjs'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  vi.useRealTimers(); Object.defineProperty(process, 'platform', originalPlatform)
  f.query.mockReset(); f.observerStarts = 0; f.guardError = undefined
  f.count = 0; f.mode = 'complete'; f.removed = []; f.writes.clear()
})
describe('diagnostic driver custody controls', () => {
  it.each(['first incomplete', 'second incomplete', 'changed identity', 'sink failure', 'duplicate'])('preserves refusal after %s without authorizing custody', async kind => {
    vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' })
    f.mode = kind === 'sink failure' ? 'job-sink-failure' : kind === 'duplicate' ? 'job-duplicate' : 'job-refusal'; f.abort = vi.fn()
    const self = { pid: process.pid, creationTimeMs: 100, creationFileTime: '116444736001000000' }
    const complete = { listed: 1, identified: 1, entries: [self] }
    const incomplete = { listed: 2, identified: 1, entries: [self] }
    const changed = { listed: 2, identified: 2, entries: [self,
      { pid: process.pid + 1, creationTimeMs: 200, creationFileTime: '116444736002000000' }] }
    const samples = ['first incomplete', 'sink failure', 'duplicate'].includes(kind) ? [incomplete, complete] :
      kind === 'second incomplete' ? [complete, incomplete] : [complete, changed]
    f.query.mockReturnValueOnce(samples[0]).mockReturnValueOnce(samples[1])
    const rejected = expect(recordScrolledPrefixes('/synthetic/BMN.exe')).rejects.toMatchObject({ code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
    await vi.advanceTimersByTimeAsync(100); await rejected
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(f.guardError).toBe('Diagnostic application job did not reach a complete quiescent snapshot')
    expect(f.count).toBe(1); expect(f.removed).toEqual([])
    expect(f.observerStarts).toBe(0); expect(f.abort).not.toHaveBeenCalled()
    const record = JSON.parse(f.writes.get('test-results/windows-scrolled-prefix.json'))
    expect(record.partial).toBe(true); expect(record.arms).toHaveLength(1)
    const row = record.arms[0]
    expect(row.custody).toBe('unconfirmed'); expect(row.profileRetained).toBeDefined()
    expect(row.profileRemoved).toBeUndefined(); expect(row.custodyReceipt).toBeUndefined()
    expect(row.parentInputEvents.map(event => event.event)).toEqual(['spawned'])
    if (kind === 'sink failure') {
      expect(row.jobSnapshots).toBeUndefined(); expect(row.jobSnapshotEvidence).toBe('unavailable')
      return
    }
    expect(row.jobSnapshots).toEqual(samples.map((snapshot, index) => ({
      arm: 'control', mainPid: process.pid, index, startedAtMs: expect.any(Number), returnedAtMs: expect.any(Number), snapshot
    })))
    expect(row.jobSnapshotEvidence).toBe(kind === 'duplicate' ? 'duplicate' : 'recorded')
  })
  it('can finish all six arms without preserving a stale partial flag', async () => {
    f.abort = vi.fn()
    const record = await recordScrolledPrefixes('/synthetic/BMN.exe')
    expect(record.partial).toBe(false); expect(record.arms).toHaveLength(6)
    expect(record.arms.every(row => row.exitObserved && row.closeObserved && row.profileRemoved)).toBe(true)
  })
  it('ignores null and primitive JSON noise before and after a valid custody receipt', async () => {
    f.mode = 'null'; f.abort = vi.fn()
    expect((await recordScrolledPrefixes('/synthetic/BMN.exe')).partial).toBe(false)
  })
  it('bounds input metadata, strips content and records the parent acknowledgement call', async () => {
    f.mode = 'input-observation'; f.abort = vi.fn()
    const record = await recordScrolledPrefixes('/synthetic/BMN.exe')
    expect(record.partial).toBe(false)
    for (const row of record.arms) {
      expect(row.appInputEvents).toHaveLength(16)
      expect(row.parentInputEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'spawned', writable: true }),
        expect.objectContaining({ event: 'ack-end-called', writable: true })
      ]))
      expect(JSON.stringify(row.appInputEvents)).not.toContain('synthetic content')
    }
  })
  it.each(['descendant', 'write-failure', 'missing', 'late', 'duplicate', 'forged-main', 'wrong-arm'])('retains the profile and forbids a next arm when %s makes custody unconfirmed', async mode => {
    f.mode = mode; f.abort = vi.fn()
    await expect(recordScrolledPrefixes('/synthetic/BMN.exe')).rejects.toMatchObject({ code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
    expect(f.count).toBe(1); expect(f.removed).toEqual([])
    expect(f.abort).toHaveBeenCalledTimes(['forged-main', 'wrong-arm'].includes(mode) ? 0 : 1)
  })
})
