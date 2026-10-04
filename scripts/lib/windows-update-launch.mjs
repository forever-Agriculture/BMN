// Mirror the existing desktop start contract: focus a running app while a queued
// update is waiting for exit; otherwise hold the start until its work completes.
import assert from 'node:assert/strict'

export function windowsQueuedStartMode(request, guiPids) {
  if (!request || !['queued', 'waiting'].includes(request.phase)) return 'resume'
  assert.ok(Array.isArray(guiPids) && guiPids.every(Number.isSafeInteger), 'GUI observation is incomplete')
  return guiPids.length ? 'forward' : 'resume'
}
