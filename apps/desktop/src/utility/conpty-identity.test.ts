import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ child: undefined as unknown as EventEmitter & {
  pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn>
} }))
vi.mock('node:child_process', () => ({ spawn: () => fixture.child }))
import { conptyIdentity } from './conpty-identity'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.useRealTimers() })
function child() {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fixture.child = Object.assign(new EventEmitter(), { pid: 17, stdout: new PassThrough(),
    stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
  return fixture.child
}
describe('identity query termination evidence', () => {
  it('does not resolve on timeout before close confirms the owned helper terminated', async () => {
    vi.useFakeTimers(); const helper = child()
    let resolved = false
    const result = conptyIdentity(10, 11).then(value => { resolved = true; return value })
    await vi.advanceTimersByTimeAsync(8000)
    expect(helper.kill).toHaveBeenCalledOnce(); expect(resolved).toBe(false)
    helper.emit('close', 1)
    expect(await result).toMatchObject({ unavailable: 'identity query exceeded 8 seconds', terminationConfirmed: true })
  })
  it('marks a hung helper or descendant holding its pipes unconfirmed after the bounded close wait', async () => {
    vi.useFakeTimers(); child()
    const result = conptyIdentity(10, 11)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toMatchObject({ unavailable: 'identity query exceeded 8 seconds', terminationUnconfirmed: true })
  })
})
