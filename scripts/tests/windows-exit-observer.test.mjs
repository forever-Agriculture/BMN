import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ child: undefined }))
vi.mock('node:child_process', () => ({ spawn: () => fixture.child }))
import { windowsExitObserver } from '../lib/windows-exit-observer.mjs'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const systemRoot = process.env.SystemRoot
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.useRealTimers(); if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot })
function begin() {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
  const child = fixture.child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  child.exitCode = null; child.kill = vi.fn()
  return child
}
describe('retained observer diagnostic deadline', () => {
  it('waits for close and accepts only the retained exit receipt', async () => {
    const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
    child.stdout.write('READY\n'); const observer = await waiting
    const done = observer.finish()
    child.stdout.write('{"passed":true,"retainedHandles":1}\n')
    child.emit('exit', 0)
    child.emit('close', 0)
    expect(await done).toEqual({ passed: true, retainedHandles: 1 })
  })
  it('fails closed when a helper never closes after the lifecycle action', async () => {
    vi.useFakeTimers()
    const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
    child.stdout.write('READY\n'); const observer = await waiting
    const rejected = expect(observer.finish()).rejects.toMatchObject({ code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
    await vi.advanceTimersByTimeAsync(25000); await rejected
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
  it('bounds an abort whose helper does not acknowledge termination', async () => {
    vi.useFakeTimers()
    const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
    child.stdout.write('READY\n'); const observer = await waiting
    const rejected = expect(observer.abort()).rejects.toMatchObject({ code: 'DIAGNOSTIC_CUSTODY_UNCONFIRMED' })
    await vi.advanceTimersByTimeAsync(10000); await rejected
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})

it('refuses a receipt that did not witness every retained identity', async () => {
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
  child.stdout.write('READY\n'); const observer = await waiting
  const rejected = expect(observer.finish()).rejects.toThrow('incomplete')
  child.stdout.write('{"passed":true,"retainedHandles":0}\n'); child.emit('close', 0)
  await rejected
})

it('keeps bounded stage, HRESULT and close evidence when the observer ends before READY', async () => {
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [],
    { overallWaitMs: 15000, diagnostic: true })
  const rejected = expect(waiting).rejects.toMatchObject({ observerDiagnostic: {
    class: 'closed-before-ready', stage: 'identity', hresult: '0x80070005', entryIndex: 0,
    helperExitCode: 1, timestamps: { spawnedAtMs: expect.any(Number), firstStdoutAtMs: expect.any(Number), closedAtMs: expect.any(Number) }
  } })
  child.stdout.write('STAGE identity 12 0 0x80070005\n')
  child.stderr.write('x'.repeat(3000)); child.emit('close', 1)
  await rejected
  try { await waiting } catch (error) { expect(error.observerDiagnostic.stderrTail).toHaveLength(2048) }
})

it('distinguishes the unchanged readiness timeout from a later observer close', async () => {
  vi.useFakeTimers()
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [],
    { overallWaitMs: 15000, diagnostic: true })
  const rejected = expect(waiting).rejects.toMatchObject({ observerDiagnostic: { class: 'ready-timeout' } })
  child.stdout.write('STAGE add-type 25 -1 none\n')
  await vi.advanceTimersByTimeAsync(20000)
  child.emit('close', 1)
  await rejected
})

it('retains only bounded stage observations without accepting them as READY or exit proof', async () => {
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [],
    { overallWaitMs: 15000, diagnostic: true })
  for (let index = 0; index < 100; index++) child.stdout.write(`STAGE open ${index} ${index} none\n`)
  child.stdout.write('READY\n')
  const observer = await waiting
  expect(observer.diagnostic.stages).toHaveLength(32)
  expect(observer.diagnostic.stagesDropped).toBe(68)
  expect(observer.diagnostic.timestamps.readyAtMs).toEqual(expect.any(Number))
  const rejected = expect(observer.finish()).rejects.toThrow('incomplete')
  child.stdout.write('{"passed":true,"retainedHandles":0}\n'); child.emit('close', 0)
  await rejected
})
