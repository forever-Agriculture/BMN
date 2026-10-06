// The pinned Windows addon supplies shared startup/exclusive updater handles.
// No stale lock-file deletion, PID termination, polling through powershell, or
// release when a competing process merely claims that it has stopped.
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

export function loadWindowsInstallLease(anchor) {
  const require = createRequire(anchor)
  const native = require('node-pty/lib/utils').loadNativeModule('conpty').module
  if (native.bmnInstallLeaseVersion !== 1 || typeof native.acquireInstallLease !== 'function') {
    throw new Error('BMN installation lease capability is unavailable')
  }
  return native
}

export async function withWindowsInstallLease(root, operation, { native, signal, onWait = () => {}, wait = delay, fileName = 'run.lock', exclusive = true } = {}) {
  if (!native || typeof native.acquireInstallLease !== 'function') throw new Error('Native installation lease required')
  if (!['run.lock', 'update.lock'].includes(fileName)) throw new Error('Unsupported lease role')
  let lease
  while (!lease) {
    signal?.throwIfAborted()
    try { lease = native.acquireInstallLease(join(root, fileName), exclusive) }
    catch (error) {
      if (error.windowsError !== 32) throw error
      onWait()
      await wait(250, undefined, { signal })
    }
  }
  if (typeof lease.close !== 'function') throw new Error('Malformed installation lease')
  try { signal?.throwIfAborted(); return await operation() }
  finally { lease.close() }
}

/** Fixed lock order matches installed app startup: installation, then shared data. */
export function withWindowsReleaseLeases(root, dataRoot, operation, options) {
  return withWindowsInstallLease(root, () =>
    withWindowsInstallLease(dataRoot, operation, { ...options, fileName: 'update.lock' }), options)
}
