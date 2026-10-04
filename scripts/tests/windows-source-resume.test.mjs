import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { queueWindowsSourceUpdate, readWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { resumeWindowsSourceUpdate } from '../lib/windows-source-resume.mjs'

const roots = [], commit = 'a'.repeat(40)
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-source-resume-')); roots.push(root)
  const path = join(root, 'requests/source-update.json'), candidateRoot = join(root, 'candidate')
  mkdirSync(join(root, 'requests')); mkdirSync(candidateRoot)
  writeFileSync(join(candidateRoot, 'bmn-release.json'), JSON.stringify({ electronVersion: '44.3.0' }))
  const sourceState = { branch: 'main', head: commit, originHead: commit, status: '' }
  const identity = { repo: join(root, 'source'), node: process.execPath, pnpm: join(root, 'pnpm.cjs'), sourceState }
  queueWindowsSourceUpdate(path, identity)
  const close = vi.fn(), candidate = { root: candidateRoot, commit, payloadSha256: 'b'.repeat(64), schemaVersion: 23 }
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ format: 1, current: candidate, previous: null, snapshot: null }))
  const capabilities = { dataRoot: join(root, 'data'), runtimeVersion: '44.3.0',
    native: { acquireInstallLease: vi.fn(() => ({ close })) }, privateDirectories: vi.fn(),
    readSourceState: vi.fn(async () => ({ ...sourceState })), waitForExit: vi.fn(async () => {}),
    buildSnapshot: vi.fn(async (_identity, options) => { await options.onWorkspace({ scratch: 'synthetic-recorded-workspace' }); return candidate }),
    validate: vi.fn(async () => {}), installPayload: vi.fn(async options => { await options.beforeActivate(); return { current: { commit } } }),
    notify: vi.fn(async () => {}), cleanup: vi.fn() }
  return { root, path, identity, capabilities, close, candidate, sourceState }
}
it('resumes through a separate request lease and verifies source again inside activation', async () => {
  const f = fixture(), result = await resumeWindowsSourceUpdate(f.root, f.capabilities)
  expect(result.phase).toBe('complete'); expect(result.scratch).toBe('synthetic-recorded-workspace')
  expect(f.capabilities.installPayload).toHaveBeenCalledOnce(); expect(f.capabilities.notify).toHaveBeenCalledOnce()
  expect(f.capabilities.cleanup).toHaveBeenCalledWith(f.candidate); expect(f.close).toHaveBeenCalledOnce()
  expect(f.capabilities.native.acquireInstallLease).toHaveBeenCalledWith(join(f.root, 'requests/run.lock'), true)
  expect(f.capabilities.readSourceState.mock.calls.length).toBeGreaterThanOrEqual(6)
  const bytes = readFileSync(f.path)
  await resumeWindowsSourceUpdate(f.root, f.capabilities)
  expect(readFileSync(f.path)).toEqual(bytes); expect(f.capabilities.installPayload).toHaveBeenCalledOnce()
})
it('rejects a runtime mismatch before data activation and leaves failed work for explicit retry', async () => {
  const f = fixture(); f.capabilities.runtimeVersion = '45.0.0'
  const result = await resumeWindowsSourceUpdate(f.root, f.capabilities)
  expect(result.phase).toBe('failed'); expect(f.capabilities.installPayload).not.toHaveBeenCalled()
  await resumeWindowsSourceUpdate(f.root, f.capabilities)
  expect(f.capabilities.buildSnapshot).toHaveBeenCalledOnce()
  expect(queueWindowsSourceUpdate(f.path, f.identity).phase).toBe('queued')
})
it('does not block opening the selected app because a failure notice is unavailable', async () => {
  const f = fixture(); f.capabilities.installPayload.mockRejectedValue(new Error('synthetic metadata failure'))
  f.capabilities.notify.mockRejectedValue(new Error('synthetic unavailable desktop'))
  expect((await resumeWindowsSourceUpdate(f.root, f.capabilities)).phase).toBe('failed')
  expect(readWindowsSourceUpdate(f.path).phase).toBe('failed'); expect(f.close).toHaveBeenCalledOnce()
})
it('does not call a completed installation failed when its completion notice is unavailable', async () => {
  const f = fixture(); f.capabilities.notify.mockRejectedValue(new Error('synthetic unavailable desktop'))
  const result = await resumeWindowsSourceUpdate(f.root, f.capabilities)
  expect(result.phase).toBe('complete'); expect(result.notice).toBe('unavailable')
  expect(f.capabilities.notify).toHaveBeenCalledOnce(); expect(f.capabilities.installPayload).toHaveBeenCalledOnce()
})
it('does not load native code or provision anything when no update is queued', async () => {
  const f = fixture(); rmSync(f.path)
  expect(await resumeWindowsSourceUpdate(f.root, f.capabilities)).toBeNull()
  expect(f.capabilities.native.acquireInstallLease).not.toHaveBeenCalled()
  expect(f.capabilities.privateDirectories).not.toHaveBeenCalled()
})

it('returns null when uninstall removes the request before this worker acquires its lease', async () => {
  const f = fixture()
  f.capabilities.native.acquireInstallLease.mockImplementation(() => { rmSync(f.path); return { close: f.close } })
  expect(await resumeWindowsSourceUpdate(f.root, f.capabilities)).toBeNull()
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.capabilities.installPayload).not.toHaveBeenCalled()
})
it('quarantines a queued request without reactivating an uninstalled root', async () => {
  const f = fixture(); rmSync(join(f.root, 'installation.json'))
  expect(await resumeWindowsSourceUpdate(f.root, f.capabilities)).toBeNull()
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.capabilities.installPayload).not.toHaveBeenCalled()
})
