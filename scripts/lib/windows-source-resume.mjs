// Resumed by the owned installed launcher. No broker, service or login task is
// provisioned, and a failed request does not prevent opening the retained app.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { loadWindowsInstallLease, withWindowsInstallLease } from './windows-install-lease.mjs'
import { quarantineWindowsSourceUpdate, readWindowsSourceUpdate, runWindowsSourceUpdate } from './windows-source-update.mjs'
import { buildFrozenWindowsSource, readWindowsSourceState, removeFrozenWindowsSource } from './windows-source-build.mjs'
import { readWindowsInstallation, releaseDescriptor, releaseDirectory } from './windows-release-transaction.mjs'
import { validateWindowsReleasePayload } from './windows-release-payload.mjs'
import { WindowsUpdateObserver } from './windows-update-progress.mjs'

export async function resumeWindowsSourceUpdate(root, { dataRoot, waitForExit, installPayload, notify,
  native, privateDirectories = ensurePrivateDirectories, readSourceState = readWindowsSourceState,
  buildSnapshot = buildFrozenWindowsSource, validate = validateWindowsReleasePayload, cleanup = removeFrozenWindowsSource,
  runtimeVersion = process.versions.electron, engineRoot = join(root, 'bootstrap'), readInstallation = readWindowsInstallation,
  observe = attemptId => new WindowsUpdateObserver(join(root, 'requests'), attemptId) } = {}) {
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
      return await runWindowsSourceUpdate(path, { readSourceState, waitForExit, observe,
        recoverActivated: async pending => {
          if (!pending.candidate) return null
          const expected = releaseDescriptor(pending.candidate), selected = readInstallation(root)
          if (!selected) throw new Error('Interrupted source update has no selected installation')
          if (JSON.stringify(releaseDescriptor(selected.current)) !== JSON.stringify(expected)) return null
          const journalPath = join(root, 'update.json'), info = lstatSync(journalPath)
          assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Interrupted update journal is not an ordinary file')
          const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
          assert.equal(journal.format, 1, 'Interrupted update journal is unsupported')
          assert.deepEqual(releaseDescriptor(journal.candidate), expected, 'Selected payload belongs to another update journal')
          // Recheck selection and this journal under the transaction lease. The
          // retained selected payload is validated, never rebuilt or cleaned up.
          return { ...expected, root: releaseDirectory(root, expected), metadataRepairOnly: true }
        },
        buildSnapshot: async (identity, recordWorkspace, observeStage) => {
          candidate = await buildSnapshot(identity, { onWorkspace: recordWorkspace, observe: observeStage })
          return candidate
        },
        validate: async value => {
          await validate(value.root, value)
          const manifest = JSON.parse(readFileSync(join(value.root, 'bmn-release.json'), 'utf8'))
          assert.match(manifest.electronVersion, /^\d+\.\d+\.\d+$/u, 'Packaged runtime version is unknown')
          assert.equal(manifest.electronVersion, runtimeVersion,
            'Queued candidate needs another Electron runtime; use its offline installer to update safely')
        },
        activate: async (value, verifySource, observeStage) => {
          await verifySource()
          return installPayload({ source: value.root, root, dataRoot, descriptor: value, observe: observeStage,
            // Checked inside the native transaction immediately before selection.
            beforeActivate: verifySource, requireAlreadySelected: value.metadataRepairOnly === true })
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
