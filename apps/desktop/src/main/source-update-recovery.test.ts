// MODULE: source-update-recovery.test.ts - delayed restart attachments and main's final adoption fence
import { describe, expect, it, vi } from 'vitest'
import type { SessionResumeResult, UpdateRestartRecord } from '@bmn/protocol'
import { createSourceRestartAdopter } from './source-update-recovery'
import { adoptsStartedAttachment } from './host-loss'

function fixture() {
  let ready = true
  const records = new Set(['one', 'two']), runtimes = new Map<string, SessionResumeResult>()
  const starts = ['one', 'two'].map(sessionId => ({ sessionId, incarnationId: `new-${sessionId}`, attachmentId: `cached-${sessionId}`, streamSeq: 0,
    captureStartedAt: '2026-11-11T12:00:00Z', modes: [], launch: { cwd: '/synthetic', executable: '/synthetic/codex' } }) as SessionResumeResult)
  const run = { id: 'restart-a', phase: 'complete', members: starts.map(s => ({ sessionId: s.sessionId, incarnationId: `old-${s.sessionId}`, resumedIncarnation: s.incarnationId })) } as UpdateRestartRecord
  const attach = vi.fn(async (start: SessionResumeResult) => ({ ...start, attachmentId: `fresh-${start.sessionId}` }))
  const changed = vi.fn()
  const adopt = createSourceRestartAdopter({
    recordsReady: () => ready, hasRecord: id => records.has(id), incarnation: id => runtimes.get(id)?.incarnationId,
    attach, adopt: start => {
      if (adoptsStartedAttachment(runtimes.get(start.sessionId), start)) { runtimes.set(start.sessionId, start); changed(start.sessionId) }
      return runtimes.get(start.sessionId)!
    }
  })
  return { run, starts, attach, changed, runtimes, records, adopt, scope: {}, setReady: (value: boolean) => { ready = value } }
}
describe('main restart adoption', () => {
  it('defers terminal receipts until startup records are loaded', async () => {
    const f = fixture(); f.setReady(false)
    expect(await f.adopt(f.run, f.starts, f.scope, () => true)).toMatchObject({ accepted: true, pending: true, recovered: [] })
    expect(f.attach).not.toHaveBeenCalled()
    f.setReady(true)
    expect(await f.adopt(f.run, f.starts, f.scope, () => true)).toMatchObject({ accepted: true, pending: false })
    expect(f.changed).toHaveBeenCalledTimes(2)
  })
  it('keeps missing startup members pending while adopting the available ones', async () => {
    const f = fixture(); f.records.delete('two')
    expect((await f.adopt(f.run, f.starts, f.scope, () => true)).pending).toBe(true)
    expect(f.changed).toHaveBeenCalledTimes(1)
    f.records.add('two')
    expect((await f.adopt(f.run, f.starts, f.scope, () => true)).pending).toBe(false)
    expect(f.changed).toHaveBeenCalledTimes(2)
  })
  it('awaits first and later attachments before the polling caller can retire', async () => {
    const f = fixture(); const releases: Array<() => void> = []
    f.attach.mockImplementation(start => new Promise(resolve => { releases.push(() => resolve({ ...start, attachmentId: `fresh-${start.sessionId}` })) }))
    let settled = false
    const result = f.adopt(f.run, f.starts, f.scope, () => true).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    expect(settled).toBe(false); expect(f.changed).not.toHaveBeenCalled()
    releases[0]!(); await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(settled).toBe(false); expect(f.changed).toHaveBeenCalledTimes(1)
    releases[1]!()
    expect(await result).toMatchObject({ accepted: true, pending: false })
    expect(f.changed).toHaveBeenCalledTimes(2)
    await f.adopt(f.run, f.starts, f.scope, () => true)
    expect(f.attach).toHaveBeenCalledTimes(2); expect(f.changed).toHaveBeenCalledTimes(2)
  })
  it('joins concurrent attachment recovery and preserves a newer renderer lease', async () => {
    const f = fixture(); let release!: () => void
    f.attach.mockImplementation(start => new Promise(resolve => { release = () => resolve({ ...start, attachmentId: 'older-recovery' }) }))
    const one = f.adopt(f.run, [f.starts[0]!], f.scope, () => true), two = f.adopt(f.run, [f.starts[0]!], f.scope, () => true)
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce())
    f.runtimes.set('one', { ...f.starts[0]!, attachmentId: 'newer-renderer' }); release()
    expect((await one).recovered[0]!.attachmentId).toBe('newer-renderer')
    expect((await two).recovered[0]!.attachmentId).toBe('newer-renderer')
    expect(f.changed).not.toHaveBeenCalled()
  })
  it('rejects a response that becomes stale while its attachment is pending', async () => {
    const f = fixture(); let allowed = true, release!: () => void
    f.attach.mockImplementation(start => new Promise(resolve => { release = () => resolve(start) }))
    const result = f.adopt(f.run, [f.starts[0]!], f.scope, () => allowed)
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce()); allowed = false; release()
    expect((await result).accepted).toBe(false); expect(f.changed).not.toHaveBeenCalled()
  })
  it('retains a completed single lease when the polling caller goes stale', async () => {
    const f = fixture(); let allowed = true, leased = false, release!: () => void
    f.attach.mockImplementation(start => {
      if (leased) return Promise.reject(new Error('This process already has an interactive terminal'))
      leased = true
      return new Promise(resolve => { release = () => resolve({ ...start, attachmentId: 'retained-lease' }) })
    })
    const stale = f.adopt(f.run, [f.starts[0]!], f.scope, () => allowed)
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce()); allowed = false; release()
    expect((await stale).accepted).toBe(false)
    expect((await f.adopt(f.run, [f.starts[0]!], f.scope, () => true)).recovered[0]!.attachmentId).toBe('retained-lease')
    expect(f.attach).toHaveBeenCalledOnce()
  })
  it('accounts for a conclusively superseded incarnation without restoring it', async () => {
    const f = fixture(); f.runtimes.set('one', { ...f.starts[0]!, incarnationId: 'later-user-run' })
    expect(await f.adopt(f.run, [f.starts[0]!], f.scope, () => true)).toMatchObject({ accepted: true, pending: false, recovered: [] })
    expect(f.attach).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled()
  })
  it('retries attaching the existing process after transport rejection, without replaying resume', async () => {
    const f = fixture(); f.attach.mockRejectedValueOnce(new Error('Synthetic attachment transport failure'))
    await expect(f.adopt(f.run, [f.starts[0]!], f.scope, () => true)).rejects.toThrow('Synthetic attachment transport failure')
    expect((await f.adopt(f.run, [f.starts[0]!], f.scope, () => true)).pending).toBe(false)
    expect(f.attach).toHaveBeenCalledTimes(2); expect(f.changed).toHaveBeenCalledOnce()
  })
})
