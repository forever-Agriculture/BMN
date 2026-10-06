import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { queueWindowsSourceUpdate, readWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { resumeWindowsSourceUpdate } from '../lib/windows-source-resume.mjs'
import { activateWindowsRelease, readWindowsInstallation, releaseDirectory } from '../lib/windows-release-transaction.mjs'
import { sealWindowsReleasePayload, validateWindowsReleasePayload } from '../lib/windows-release-payload.mjs'

const roots = [], commit = 'a'.repeat(40), runtimeVersion = '44.3.0'
const timeout = process.platform === 'win32' ? 90000 : 10000
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sourceState = { branch: 'main', head: commit, originHead: commit, status: '' }
async function payload(root, name, identity) {
  const path = join(root, name); mkdirSync(join(path, 'resources'), { recursive: true })
  writeFileSync(join(path, 'BMN.exe'), 'synthetic runtime')
  writeFileSync(join(path, 'BMN-worker.exe'), 'synthetic runtime')
  writeFileSync(join(path, 'resources/app.asar'), name)
  return { root: path, ...await sealWindowsReleasePayload(path, { commit: identity, schemaVersion: 23, electronVersion: runtimeVersion }) }
}
const transaction = (root, candidate, overrides = {}) => activateWindowsRelease({
  root, candidate, withLease: operation => operation(), waitForExit: async () => {},
  stage: async target => cpSync(candidate.root, target, { recursive: true }),
  validate: validateWindowsReleasePayload, smoke: async () => {}, inspectData: async () => ({ schemaVersion: 23 }),
  refreshMetadata: async () => {}, ...overrides
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-selected-source-recovery-')); roots.push(root)
  const installation = join(root, 'installation'), previous = await payload(root, 'previous', 'd'.repeat(40))
  await transaction(installation, previous)
  mkdirSync(join(installation, 'requests'))
  const path = join(installation, 'requests/source-update.json')
  const identity = { repo: join(root, 'source'), node: process.execPath, pnpm: join(root, 'pnpm.cjs'), sourceState }
  queueWindowsSourceUpdate(path, identity)
  const close = vi.fn(), inspectData = vi.fn(async () => ({ schemaVersion: 23 })), metadata = vi.fn(async () => {})
  const capabilities = { dataRoot: join(root, 'data'), runtimeVersion,
    native: { acquireInstallLease: () => ({ close }) }, privateDirectories: () => {},
    readSourceState: async () => ({ ...sourceState }), waitForExit: vi.fn(async () => {}),
    buildSnapshot: vi.fn(async () => payload(root, 'second-artifact', commit)), validate: validateWindowsReleasePayload,
    installPayload: vi.fn(async options => transaction(installation, { ...options.descriptor, root: options.source },
      { requireAlreadySelected: options.requireAlreadySelected, beforeActivate: options.beforeActivate,
        inspectData, refreshMetadata: metadata })), notify: vi.fn(async () => {}), cleanup: vi.fn() }
  return { root, installation, path, identity, capabilities, close, inspectData, metadata }
}
async function interrupted(f) {
  const candidate = await payload(f.root, 'interrupted', commit)
  await transaction(f.installation, candidate)
  writeFileSync(f.path, JSON.stringify({ ...readWindowsSourceUpdate(f.path), phase: 'activating',
    candidate: { commit: candidate.commit, payloadSha256: candidate.payloadSha256, schemaVersion: candidate.schemaVersion } }))
  return readWindowsInstallation(f.installation)
}

it('resumes an abrupt post-selection crash without rebuilding or repeating data inspection', async () => {
  const f = await fixture()
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../test/fixtures/windows-source-recovery-crash.mjs', import.meta.url)), f.root, commit],
    { encoding: 'utf8', timeout: timeout - 1000 })
  expect(child.error).toBeUndefined(); expect(child.status).not.toBe(0)
  expect(existsSync(join(f.root, 'selection-before-crash'))).toBe(true)
  expect(existsSync(join(f.root, 'first-inspection'))).toBe(true)
  const selected = readWindowsInstallation(f.installation), request = readWindowsSourceUpdate(f.path)
  expect(request.phase).toBe('activating'); expect(request.candidate).toEqual(selected.current)
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('complete')
  expect(readWindowsInstallation(f.installation)).toEqual(selected)
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.inspectData).not.toHaveBeenCalled()
  expect(f.capabilities.cleanup).not.toHaveBeenCalled(); expect(f.metadata).toHaveBeenCalledOnce()
  expect(f.capabilities.installPayload.mock.calls[0][0].requireAlreadySelected).toBe(true)
  expect(f.close).toHaveBeenCalledOnce()
}, timeout)

it.each(['other-payload', 'other-journal', 'legacy', 'source-drift', 'corrupt-payload', 'runtime-mismatch', 'metadata-failure'])('preserves selection and refuses uncertain recovery: %s', async mode => {
  const f = await fixture(), selected = await interrupted(f), journalPath = join(f.installation, 'update.json')
  if (mode === 'other-payload') {
    const value = readWindowsSourceUpdate(f.path); value.candidate.payloadSha256 = 'f'.repeat(64)
    writeFileSync(f.path, JSON.stringify(value))
  }
  if (mode === 'other-journal') {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')); journal.candidate.payloadSha256 = 'f'.repeat(64)
    writeFileSync(journalPath, JSON.stringify(journal))
  }
  if (mode === 'legacy') {
    const value = readWindowsSourceUpdate(f.path); delete value.candidate; writeFileSync(f.path, JSON.stringify(value))
  }
  if (mode === 'source-drift') f.capabilities.readSourceState = async () => ({ ...sourceState, status: ' M synthetic' })
  if (mode === 'corrupt-payload') writeFileSync(join(releaseDirectory(f.installation, selected.current), 'BMN.exe'), 'corrupt')
  if (mode === 'runtime-mismatch') f.capabilities.runtimeVersion = '45.0.0'
  if (mode === 'metadata-failure') f.metadata.mockRejectedValue(new Error('Synthetic metadata failure'))
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('failed')
  expect(readWindowsInstallation(f.installation)).toEqual(selected)
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.inspectData).not.toHaveBeenCalled()
  expect(f.capabilities.cleanup).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
}, timeout)

it('retains legacy activation uncertainty when an explicit retry requeues the failed request', async () => {
  const f = await fixture(), selected = await interrupted(f), pending = readWindowsSourceUpdate(f.path)
  delete pending.candidate; writeFileSync(f.path, JSON.stringify(pending))
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('failed')
  expect(queueWindowsSourceUpdate(f.path, f.identity).phase).toBe('queued')
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('failed')
  expect(readWindowsInstallation(f.installation)).toEqual(selected)
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.inspectData).not.toHaveBeenCalled()
}, timeout)

it.each(['validating', 'failed-requeue'])('never rebuilds descriptor-bearing uncertain recovery after %s', async mode => {
  const f = await fixture(), selected = await interrupted(f), pending = readWindowsSourceUpdate(f.path)
  pending.phase = mode === 'validating' ? 'validating' : 'failed'
  pending.candidate.payloadSha256 = 'f'.repeat(64)
  writeFileSync(f.path, JSON.stringify(pending))
  if (mode === 'failed-requeue') expect(queueWindowsSourceUpdate(f.path, f.identity).phase).toBe('queued')
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('failed')
  expect(readWindowsSourceUpdate(f.path).candidate).toEqual(pending.candidate)
  expect(readWindowsInstallation(f.installation)).toEqual(selected)
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.inspectData).not.toHaveBeenCalled()
  expect(f.capabilities.cleanup).not.toHaveBeenCalled()
}, timeout)

it.each(['validation', 'metadata', 'completion'])('retains exact recovery identity through another abrupt %s crash', async mode => {
  const f = await fixture(), selected = await interrupted(f)
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../test/fixtures/windows-source-recovery-crash.mjs', import.meta.url)), f.root, commit, mode],
    { encoding: 'utf8', timeout: timeout - 1000 })
  expect(child.error).toBeUndefined(); expect(child.status).not.toBe(0)
  expect(readFileSync(join(f.root, 'recovery-crash-point'), 'utf8')).toBe(mode)
  const durable = readWindowsSourceUpdate(f.path)
  expect(durable.candidate).toEqual(selected.current)
  expect(durable.phase).toBe(mode === 'validation' ? 'validating' : mode === 'completion' ? 'complete' : 'activating')
  expect((await resumeWindowsSourceUpdate(f.installation, f.capabilities)).phase).toBe('complete')
  expect(readWindowsInstallation(f.installation)).toEqual(selected)
  expect(f.capabilities.buildSnapshot).not.toHaveBeenCalled(); expect(f.inspectData).not.toHaveBeenCalled()
  expect(f.capabilities.cleanup).not.toHaveBeenCalled()
  expect(f.metadata).toHaveBeenCalledTimes(mode === 'completion' ? 0 : 1)
}, timeout)
