import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { queueWindowsSourceUpdate, readWindowsSourceUpdate, runWindowsSourceUpdate } from '../lib/windows-source-update.mjs'

// Native durable writes invoke PowerShell; measured transactions exceeded 5s.
const transactionTimeout = process.platform === 'win32' ? 30000 : 5000

const roots = [], commit = 'a'.repeat(40)
const descriptor = { commit, payloadSha256: 'b'.repeat(64), schemaVersion: 23 }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-source-queue-')); roots.push(root)
  const path = join(root, 'queue.json'), sourceState = { branch: 'main', head: commit, originHead: commit, status: '' }
  const options = { repo: join(root, 'source'), node: process.execPath, pnpm: join(root, 'pnpm.cjs'), sourceState }
  const callbacks = { readSourceState: vi.fn(async () => ({ ...sourceState })), waitForExit: vi.fn(async () => {}),
    buildSnapshot: vi.fn(async () => ({ ...descriptor })), validate: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ current: { ...descriptor } })), notify: vi.fn(async () => {}) }
  return { path, options, sourceState, callbacks }
}
it('deduplicates durable requests and resumes exactly their intended clean commit', async () => {
  const f = fixture(), queued = queueWindowsSourceUpdate(f.path, f.options), phases = []
  expect(queueWindowsSourceUpdate(f.path, f.options)).toEqual(queued)
  const result = await runWindowsSourceUpdate(f.path, { ...f.callbacks, checkpoint: async phase => { phases.push(phase) } })
  expect(result.phase).toBe('complete'); expect(result.selectedCommit).toBe(commit)
  expect(result.candidate).toEqual(descriptor)
  expect(phases).toEqual(['waiting', 'building', 'validating', 'activating', 'complete'])
  await runWindowsSourceUpdate(f.path, f.callbacks)
  expect(f.callbacks.activate).toHaveBeenCalledOnce(); expect(f.callbacks.notify).toHaveBeenCalledOnce()
}, transactionTimeout)
it.each(['branch', 'status', 'originHead', 'head'])('refuses %s drift before build or activation', async field => {
  const f = fixture(); queueWindowsSourceUpdate(f.path, f.options)
  f.sourceState[field] = field === 'status' ? ' M synthetic-file' : 'b'.repeat(40)
  await expect(runWindowsSourceUpdate(f.path, f.callbacks)).rejects.toThrow()
  expect(f.callbacks.buildSnapshot).not.toHaveBeenCalled(); expect(f.callbacks.activate).not.toHaveBeenCalled()
  expect(readWindowsSourceUpdate(f.path).phase).toBe('failed')
}, transactionTimeout)
it('refuses drift during a build without touching the selected installation', async () => {
  const f = fixture(); queueWindowsSourceUpdate(f.path, f.options)
  f.callbacks.buildSnapshot.mockImplementation(async () => { f.sourceState.status = ' M changed'; return { ...descriptor } })
  await expect(runWindowsSourceUpdate(f.path, f.callbacks)).rejects.toThrow('not clean')
  expect(f.callbacks.activate).not.toHaveBeenCalled()
}, transactionTimeout)
it('retains failed work durably and retries it without replacing another request', async () => {
  const f = fixture(); queueWindowsSourceUpdate(f.path, f.options)
  f.callbacks.validate.mockRejectedValueOnce(new Error('synthetic smoke failure'))
  await expect(runWindowsSourceUpdate(f.path, f.callbacks)).rejects.toThrow('smoke failure')
  const before = readFileSync(f.path)
  expect(() => queueWindowsSourceUpdate(f.path, { ...f.options, repo: join(f.options.repo, 'other') })).toThrow('explicit recovery')
  expect(readFileSync(f.path)).toEqual(before)
  await runWindowsSourceUpdate(f.path, f.callbacks)
  expect(readWindowsSourceUpdate(f.path).phase).toBe('complete'); expect(f.callbacks.activate).toHaveBeenCalledOnce()
}, transactionTimeout)
it('preserves completed selection if a completion notice cannot display', async () => {
  const f = fixture(); queueWindowsSourceUpdate(f.path, f.options)
  f.callbacks.notify.mockRejectedValueOnce(new Error('no notification UI'))
  await expect(runWindowsSourceUpdate(f.path, f.callbacks)).rejects.toThrow('notification UI')
  expect(readWindowsSourceUpdate(f.path).phase).toBe('complete')
  await runWindowsSourceUpdate(f.path, f.callbacks)
  expect(f.callbacks.activate).toHaveBeenCalledOnce()
}, transactionTimeout)
