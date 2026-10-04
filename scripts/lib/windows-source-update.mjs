// Durable explicit source-update requests. No login task, systemd, network update
// checker or detached breakaway: the installed launcher resumes queued work.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

const phases = new Set(['queued', 'waiting', 'building', 'validating', 'activating', 'complete', 'failed'])
export function windowsSourceReadiness({ branch, head, originHead, status }, intendedCommit) {
  if (branch !== 'main') return 'Source must be on main'
  if (status.trim()) return 'Source working tree is not clean'
  if (head !== originHead) return 'Source main does not match origin/main'
  if (intendedCommit !== undefined && head !== intendedCommit) return 'Source differs from the queued commit'
  return null
}
function requestIdentity(request) {
  assert.ok(request && request.format === 1 && phases.has(request.phase), 'Unsupported source update request')
  assert.match(request.commit, /^[a-f0-9]{40}$/)
  for (const name of ['repo', 'node', 'pnpm']) assert.ok(isAbsolute(request[name]), 'Source update needs absolute tool locations')
  return { commit: request.commit, repo: request.repo, node: request.node, pnpm: request.pnpm }
}
export function readWindowsSourceUpdate(path) {
  if (!existsSync(path)) return null
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Source update refuses linked or special state')
  const request = JSON.parse(readFileSync(path, 'utf8'))
  requestIdentity(request)
  return request
}
/** Caller holds the same requests lease as queue/resume. Keep recovery paths. */
export function quarantineWindowsSourceUpdate(path) {
  if (!readWindowsSourceUpdate(path)) return null
  const archived = join(dirname(path), `uninstalled-request-${randomUUID()}.json`)
  renameSync(path, archived)
  assert.equal(readWindowsSourceUpdate(path), null, 'Uninstalled request remained active')
  return archived
}

function writeRequest(path, expected, value) {
  writeConfigSafely(path, expected, JSON.stringify(value) + '\n')
  assert.deepEqual(readWindowsSourceUpdate(path), value, 'Queued update did not read back')
}

/** Caller provisions a private directory and serializes writers with run.lock. */
export function queueWindowsSourceUpdate(path, { repo, node, pnpm, sourceState }) {
  const readiness = windowsSourceReadiness(sourceState)
  assert.equal(readiness, null, readiness ?? undefined)
  const request = { format: 1, phase: 'queued', commit: sourceState.head, repo, node, pnpm }
  requestIdentity(request)
  const existing = readWindowsSourceUpdate(path)
  if (existing && existing.phase !== 'complete') {
    assert.deepEqual(requestIdentity(existing), requestIdentity(request), 'Another queued source update needs explicit recovery')
    if (existing.phase === 'failed') {
      const retry = { ...existing, phase: 'queued' }
      writeRequest(path, readFileSync(path, 'utf8'), retry)
      return retry
    }
    return existing
  }
  writeRequest(path, existsSync(path) ? readFileSync(path, 'utf8') : null, request)
  return request
}

/** All use-site capabilities are mandatory; this module never packages in-place. */
export async function runWindowsSourceUpdate(path, { readSourceState, waitForExit, buildSnapshot, validate, activate, notify, checkpoint = async () => {} }) {
  for (const fn of [readSourceState, waitForExit, buildSnapshot, validate, activate, notify]) assert.equal(typeof fn, 'function', 'Source updater capability missing')
  let request = readWindowsSourceUpdate(path)
  assert.ok(request, 'No queued source update')
  if (request.phase === 'complete') return request
  const identity = requestIdentity(request)
  const verifySource = async () => {
    const readiness = windowsSourceReadiness(await readSourceState(identity.repo), identity.commit)
    assert.equal(readiness, null, readiness ?? undefined)
  }
  const record = async (phase, extra = {}) => {
    const expected = readFileSync(path, 'utf8')
    const current = readWindowsSourceUpdate(path)
    assert.deepEqual(current, request, 'Source request changed during execution')
    request = { ...request, ...extra, phase }
    writeRequest(path, expected, request)
    await checkpoint(phase)
  }
  try {
    await verifySource()
    await record('waiting'); await waitForExit(); await verifySource()
    await record('building')
    const candidate = await buildSnapshot(identity, extra => record('building', extra))
    assert.equal(candidate?.commit, identity.commit, 'Frozen build has another source identity')
    await verifySource()
    await record('validating'); await validate(candidate); await verifySource()
    await record('activating')
    const installed = await activate(candidate, verifySource)
    assert.equal(installed?.current?.commit, identity.commit, 'Installation selected another commit')
    await verifySource()
    // Durable completion is the notice. Its UI consumption may repeat after a
    // crash; it never repeats activation or silently loses queued work.
    await record('complete', { selectedCommit: identity.commit, completedAt: new Date().toISOString() })
    await notify(request)
    return request
  } catch (error) {
    // Do not overwrite a newer request or downgrade a truthful completed state
    // because displaying its notification failed.
    if (request.phase !== 'complete' && JSON.stringify(readWindowsSourceUpdate(path)) === JSON.stringify(request)) {
      await record('failed')
    }
    throw error
  }
}
