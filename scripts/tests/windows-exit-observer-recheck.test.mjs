import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ child: undefined }))
vi.mock('node:child_process', () => ({ spawn: () => fixture.child }))
import { windowsExitObserver } from '../lib/windows-exit-observer.mjs'
const platform = Object.getOwnPropertyDescriptor(process, 'platform'), root = process.env.SystemRoot
afterEach(() => {
  Object.defineProperty(process, 'platform', platform); vi.clearAllTimers(); vi.useRealTimers()
  if (root === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = root
})
function begin() {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); process.env.SystemRoot = 'C:\\Windows'
  const child = fixture.child = Object.assign(new EventEmitter(), { exitCode: null, stdout: new PassThrough(),
    stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
  return child
}
describe('observer terminal settlement', () => {
  it.each(['missing', 'malformed'])('settles readiness when a helper closes with a %s receipt before READY', async mode => {
    const child = begin(); let settled = false
    void windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
      .then(() => { settled = true }, () => { settled = true })
    if (mode === 'malformed') child.stdout.write('{invalid}\n')
    child.exitCode = 0; child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(settled).toBe(true)
  })
  it('bounds abort even when the helper exited but a descendant keeps pipes open', async () => {
    const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
    child.stdout.write('READY\n'); const observer = await waiting
    child.exitCode = 0; child.emit('exit', 0)
    let settled = false
    void observer.abort().then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(10000)
    expect(settled).toBe(true)
  })
})

it('rejects malformed final evidence after READY instead of claiming retained exits', async () => {
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
  child.stdout.write('READY\n'); const observer = await waiting
  const rejected = expect(observer.finish()).rejects.toThrow()
  child.stdout.write('{invalid}\n'); child.exitCode = 0; child.emit('close', 0)
  await rejected
})
it('waits for a late close after exit and then consumes its complete receipt', async () => {
  const child = begin(), waiting = windowsExitObserver([{ pid: 10, creationTime: 100 }], -1, [], { overallWaitMs: 15000 })
  child.stdout.write('READY\n'); const observer = await waiting
  let settled = false
  const finished = observer.finish().then(value => { settled = true; return value })
  child.exitCode = 0; child.emit('exit', 0)
  await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false)
  child.stdout.write('{"passed":true,"retainedHandles":1}\n'); child.emit('close', 0)
  expect(await finished).toMatchObject({ passed: true, retainedHandles: 1 }); expect(vi.getTimerCount()).toBe(0)
})
