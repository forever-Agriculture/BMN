// MODULE: defaults-admission.mjs - One cross-process admission boundary for defaults, conflicting installs and Undo
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { agentsDirectory } from './agents-roster.mjs'

const scope = new AsyncLocalStorage()
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const identity = stat => `${stat.dev}:${stat.ino}`

/** Never authority by itself: detached callbacks inherit a token whose live lease has ended. */
export function assertDefaultsAdmission() {
  const node = scope.getStore()
  if (!node?.lease.live) throw conflict('defaults admission is no longer held; nothing more may be written')
  if (node.childActive) throw conflict('another nested defaults operation is still running; writes must be serial')
  const lease = node.lease
  let entry, parent
  try { entry = lstatSync(lease.path); parent = lstatSync(realpathSync(lease.directory)) } catch {
    throw conflict('defaults admission path changed; nothing more may be written')
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || identity(entry) !== lease.fileIdentity ||
    identity(fstatSync(lease.fd)) !== lease.fileIdentity || identity(parent) !== lease.parentIdentity ||
    realpathSync(lease.directory) !== lease.realDirectory) {
    throw conflict('defaults admission file or directory changed; nothing more may be written')
  }
}

/** An opaque identity for this live admission, never persisted or useful after release. */
export function defaultsAdmissionToken() {
  assertDefaultsAdmission()
  return scope.getStore().lease.token
}

function invoke(node, work, release) {
  try {
    const result = scope.run(node, () => work(assertDefaultsAdmission))
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release)
    release()
    return result
  } catch (error) { release(); throw error }
}

/**
 * The process doing the mutation owns admission, before its authoritative reread. A caller must
 * never hold it while waiting for a child CLI that also acquires it. Conflict is explicit and
 * retryable; an automatic read can try again later. The permanent lock file is never unlinked.
 * Nested adapters run serially, with the same live lease; concurrent sibling adapters refuse.
 */
export function withDefaultsAdmission(work, { directory = join(agentsDirectory(), 'state'), flockCommand } = {}) {
  const current = scope.getStore()
  if (current) {
    assertDefaultsAdmission()
    current.childActive = true
    return invoke({ lease: current.lease, childActive: false }, work, () => { current.childActive = false })
  }
  directory = resolve(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const realDirectory = realpathSync(directory), parentIdentity = identity(lstatSync(realDirectory))
  const path = join(directory, 'defaults-admission.lock')
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  let lease
  try {
    const file = fstatSync(fd)
    if (!file.isFile() || file.nlink !== 1) throw conflict('defaults admission is not a private regular lock file')
    const command = flockCommand ?? ['/usr/bin/flock', '/bin/flock'].find(existsSync)
    if (!command) throw conflict('flock is unavailable; nothing was admitted')
    const held = spawnSync(command, ['--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 10_000
    })
    if (held.status === 75) throw conflict('another defaults install or Undo is running; try again after it finishes')
    if (held.status !== 0) throw conflict('defaults admission could not be acquired; nothing was admitted')
    lease = { fd, path, directory, realDirectory, parentIdentity, fileIdentity: identity(file), live: true, token: Symbol('defaults admission') }
    const node = { lease, childActive: false }
    return invoke(node, guard => { guard(); return work(guard) }, () => {
      if (!lease.live) return
      lease.live = false
      closeSync(fd)
    })
  } catch (error) {
    if (!lease) closeSync(fd)
    throw error
  }
}
