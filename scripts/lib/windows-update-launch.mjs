// MODULE: windows-update-launch.mjs - the Windows desktop start contract around a queued source update
// Mirrors scripts/lib/desktop-launcher.mjs: focus a running app while a queued
// update waits for it to exit; otherwise hold the start in a progress window
// until the work completes. Dismissing that window never starts a half-replaced
// build, and only this start's own wait reports a failure.
import assert from 'node:assert/strict'

export const windowsUpdateTexts = Object.freeze({
  progress: 'Getting the update ready…',
  updating: 'BMN opens when the update finishes.',
  previous: 'The update failed its checks. Your previous build is unchanged.',
  new: 'The new build passed its checks, but the update did not finish. Open BMN starts the new build.',
  none: 'The update stopped while replacing the build, so there is no build to open. Nothing was started.',
  unverified: 'The update failed and the selected build could not be verified, so nothing was started.',
  missing: 'No BMN build is selected, so nothing was started. Rerun the BMN installer to repair it.',
  unreadable: 'The selected BMN build could not be verified, so nothing was started. Rerun the BMN installer to repair it.'
})

export function windowsQueuedStartMode(request, guiPids) {
  if (!request || !['queued', 'waiting'].includes(request.phase)) return 'resume'
  assert.ok(Array.isArray(guiPids) && guiPids.every(Number.isSafeInteger), 'GUI observation is incomplete')
  return guiPids.length ? 'forward' : 'resume'
}

const sameRelease = (a, b) => !!a && !!b && a.commit === b.commit && a.payloadSha256 === b.payloadSha256 && a.schemaVersion === b.schemaVersion

/** Which build a failed update left selected, from authoritative selection only.
 * An unknown state never becomes "previous unchanged". */
export function classifyWindowsFailedUpdate({ before, after, candidate }) {
  if (after === undefined) return 'unverified'
  if (after === null) return 'none'
  if (sameRelease(after.current, candidate)) return 'new'
  if (sameRelease(after.current, before?.current)) return 'previous'
  return 'unverified'
}

/**
 * All capabilities are injected: readRequest/readSelection read durable state
 * (selection returns null when none and undefined when unverifiable), resume runs
 * or waits for the queued work, launch opens the selected build under its lease.
 */
export async function runWindowsDesktopStart({ readRequest, readSelection, observeSelectedApps, launch, resume, ui, readLog }) {
  for (const fn of [readRequest, readSelection, observeSelectedApps, launch, resume, readLog]) assert.equal(typeof fn, 'function', 'Desktop start capability missing')
  const selection = () => { try { return readSelection() } catch { return undefined } }
  const durable = () => { try { return readRequest() } catch { return undefined } }
  const tell = async (title, text, buttons) => {
    const choice = await ui.ask({ title, text, buttons })
    if (choice === 'unavailable') await ui.notify(title, text)
    return choice
  }
  const noBuild = async (text, request) => {
    if (await tell('BMN update failed', text, 'log-close') === 'show-log') await ui.showLog(readLog(request))
    return 1
  }
  const request = readRequest()
  if (!request || ['complete', 'failed'].includes(request.phase)) {
    // This start did not wait for an update, so an older failure is not reported.
    const current = selection()
    if (!current) {
      await tell('BMN cannot start', current === null ? windowsUpdateTexts.missing : windowsUpdateTexts.unreadable, 'close')
      return 1
    }
    return launch()
  }
  if (windowsQueuedStartMode(request, observeSelectedApps()) === 'forward') return launch()
  const before = selection()
  let progress
  try { progress = await ui.startProgress(request) }
  catch { progress = { ready: false, finish: async () => ({ suppressed: false }) } }
  if (!progress.ready) await ui.notify('BMN is updating', windowsUpdateTexts.updating)
  try { await resume() } catch { /* The durable request and selection below decide what happened. */ }
  const decision = await progress.finish()
  // Dismissed, or the window ended unexpectedly: report nothing and start nothing.
  if (decision.suppressed) return 0
  const finished = durable(), after = selection()
  if (finished?.phase === 'complete' && after) return launch()
  const kind = classifyWindowsFailedUpdate({ before, after, candidate: finished?.candidate })
  if (kind === 'none' || kind === 'unverified') return noBuild(windowsUpdateTexts[kind], finished ?? request)
  const choice = await tell('BMN update failed', windowsUpdateTexts[kind], 'open-log')
  if (choice === 'show-log') { await ui.showLog(readLog(finished ?? request)); return 0 }
  if (choice === 'closed') return 0
  // Open BMN, or no window could ask: the launch revalidates the selection under its lease.
  return launch()
}
