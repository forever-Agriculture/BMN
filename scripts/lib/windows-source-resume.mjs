// Resumed by the owned installed launcher. No broker, service or login task is
// provisioned, and a failed request does not prevent opening the retained app.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { loadWindowsInstallLease, withWindowsInstallLease } from './windows-install-lease.mjs'
import { quarantineWindowsSourceUpdate, readWindowsSourceUpdate, runWindowsSourceUpdate } from './windows-source-update.mjs'
import { buildFrozenWindowsSource, readWindowsSourceState, removeFrozenWindowsSource } from './windows-source-build.mjs'
import { readWindowsInstallation } from './windows-release-transaction.mjs'
import { validateWindowsReleasePayload } from './windows-release-payload.mjs'

export async function resumeWindowsSourceUpdate(root, { dataRoot, waitForExit, installPayload, notify,
  native, privateDirectories = ensurePrivateDirectories, readSourceState = readWindowsSourceState,
  buildSnapshot = buildFrozenWindowsSource, validate = validateWindowsReleasePayload, cleanup = removeFrozenWindowsSource,
  runtimeVersion = process.versions.electron, engineRoot = join(root, 'bootstrap'), readInstallation = readWindowsInstallation } = {}) {
  const requests = join(root, 'requests'), path = join(requests, 'source-update.json')
  if (!existsSync(path)) return null
  privateDirectories([requests])
  native ??= loadWindowsInstallLease(pathToFileURL(join(engineRoot, 'resources/app.asar/package.json')))
  return withWindowsInstallLease(requests, async () => {
    const request = readWindowsSourceUpdate(path)
    // Another worker may have waited behind uninstall on this exact lease.
    if (!request) return null
    if (!readInstallation(root)) {
      quarantineWindowsSourceUpdate(path)
      return null
    }
    // Retry is explicit: rerun update:desktop to requeue this immutable request.
    if (['complete', 'failed'].includes(request.phase)) return request
    let candidate
    try {
      return await runWindowsSourceUpdate(path, { readSourceState, waitForExit,
        buildSnapshot: async (identity, recordWorkspace) => {
          candidate = await buildSnapshot(identity, { onWorkspace: recordWorkspace })
          return candidate
        },
        validate: async value => {
          await validate(value.root, value)
          const manifest = JSON.parse(readFileSync(join(value.root, 'bmn-release.json'), 'utf8'))
          assert.match(manifest.electronVersion, /^\d+\.\d+\.\d+$/u, 'Packaged runtime version is unknown')
          assert.equal(manifest.electronVersion, runtimeVersion,
            'Queued candidate needs another Electron runtime; use its offline installer to update safely')
        },
        activate: async (value, verifySource) => {
          await verifySource()
          return installPayload({ source: value.root, root, dataRoot, descriptor: value,
            // Checked inside the native transaction immediately before selection.
            beforeActivate: verifySource })
        }, notify })
    } catch (error) {
      const durable = readWindowsSourceUpdate(path)
      if (durable.phase === 'complete') return { ...durable, notice: 'unavailable' }
      try { await notify({ phase: 'failed', commit: request.commit }) } catch { /* An unavailable notice cannot prevent using the retained selected app. */ }
      // Selection may have changed before metadata failed. The journal is the
      // authority; show incomplete status and allow the selected app to open.
      return { ...durable, error: error.message }
    } finally {
      if (candidate) {
        try { cleanup(candidate) } catch { /* Mapped native DLLs retain the recorded scratch worktree for later recovery. */ }
      }
    }
  }, { native })
}
